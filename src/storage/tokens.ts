// Token ledger + audit log persistence (spec §20, §22.4).

import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { id, now } from '../util/id.js';
import { LOGS_DIR, ensureDirs, loadConfig } from '../config.js';
import type { TokenUsage, LlmRole } from '../types/index.js';

// Append-only audit log (spec §22.4) — provider/account/session/task + token
// counts and component list. Never the API key, never the context. Not read
// back by the system; exists for security/compliance only.
function appendAudit(r: TokenRecord): void {
  try {
    if (!loadConfig().security.audit_log) return;
  } catch {
    /* default on */
  }
  try {
    ensureDirs();
    const line = JSON.stringify({
      ts: now(),
      provider_id: r.provider_id,
      account_id: r.account_id,
      session_id: r.session_id,
      task_id: r.task_id ?? null,
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      components: r.components,
    });
    fs.appendFileSync(path.join(LOGS_DIR, 'audit.log'), line + '\n');
  } catch {
    /* audit logging must never break execution */
  }
}

export interface TokenRecord {
  session_id: string;
  task_id?: string;
  provider_id: string;
  account_id: string;
  model_id: string;
  /** What this call was for. Absent on rows written before roles existed. */
  role?: LlmRole;
  usage: TokenUsage;
  cost_usd: number;
  components: string[];
  wasted_tokens?: number;
}

export const Tokens = {
  record(r: TokenRecord): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO token_usage
      (id, session_id, task_id, provider_id, account_id, model_id, input_tokens,
       output_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
       invocation_at, context_components_json, wasted_tokens, cost_usd, role)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id('tok'), r.session_id, r.task_id ?? null, r.provider_id, r.account_id, r.model_id,
      r.usage.input_tokens, r.usage.output_tokens, r.usage.total_tokens,
      r.usage.cache_read_tokens ?? null, r.usage.cache_write_tokens ?? null, now(),
      JSON.stringify(r.components), r.wasted_tokens ?? null, r.cost_usd, r.role ?? null,
    );
    db.prepare(
      `INSERT INTO audit_log (id, ts, provider_id, account_id, session_id, task_id,
       input_tokens, output_tokens, context_components)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      id('aud'), now(), r.provider_id, r.account_id, r.session_id, r.task_id ?? null,
      r.usage.input_tokens, r.usage.output_tokens, r.components.join(','),
    );
    appendAudit(r);
  },

  /** Cost per call role, split by the model that actually served it. Failover
   *  can move a role off its routed model, and a run that credits an opus
   *  rescue to the haiku role concludes the opposite of the truth. */
  byRole(sessionId?: string): Array<{ role: string; model_id: string; calls: number; tokens: number; cost: number }> {
    const where = sessionId ? 'WHERE session_id=?' : '';
    return getDb()
      .prepare(
        `SELECT COALESCE(role,'unrouted') role, model_id, COUNT(*) calls,
         COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_usd),0) cost
         FROM token_usage ${where} GROUP BY role, model_id ORDER BY cost DESC`,
      )
      .all(...(sessionId ? [sessionId] : [])) as Array<{
      role: string;
      model_id: string;
      calls: number;
      tokens: number;
      cost: number;
    }>;
  },

  sessionTotal(sessionId: string): { input: number; output: number; total: number; cost: number } {
    const r = getDb()
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,
         COALESCE(SUM(total_tokens),0) t, COALESCE(SUM(cost_usd),0) c
         FROM token_usage WHERE session_id=?`,
      )
      .get(sessionId) as { i: number; o: number; t: number; c: number };
    return { input: r.i, output: r.o, total: r.t, cost: r.c };
  },

  /** Input tokens spent on files the model never referenced, over all input
   *  tokens — the token-discipline gate (spec §6). Real rows only; a session
   *  with no recorded invocations reports null rather than a flattering zero. */
  wasteRatio(sessionId?: string): { wasted: number; input: number; ratio: number } | null {
    const where = sessionId ? 'WHERE session_id=?' : '';
    const r = getDb()
      .prepare(
        `SELECT COALESCE(SUM(wasted_tokens),0) w, COALESCE(SUM(input_tokens),0) i,
         COUNT(wasted_tokens) n FROM token_usage ${where}`,
      )
      .get(...(sessionId ? [sessionId] : [])) as { w: number; i: number; n: number };
    if (!r.n || !r.i) return null;
    return { wasted: r.w, input: r.i, ratio: r.w / r.i };
  },

  /** How much of the input was served from the vendor's prefix cache. The
   *  vendor CLI's fixed system prompt dominates every call, so this — not the
   *  compiled context — is where most input tokens go and where reuse pays. */
  cacheReuse(sessionId?: string): { fresh: number; cached: number; input: number; ratio: number } | null {
    const where = sessionId ? 'WHERE session_id=?' : '';
    const r = getDb()
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(cache_read_tokens),0) c
         FROM token_usage ${where}`,
      )
      .get(...(sessionId ? [sessionId] : [])) as { i: number; c: number };
    if (!r.i) return null;
    return { fresh: r.i - r.c, cached: r.c, input: r.i, ratio: r.c / r.i };
  },

  byProvider(sessionId: string): Record<string, number> {
    const rows = getDb()
      .prepare(
        'SELECT provider_id, SUM(total_tokens) t FROM token_usage WHERE session_id=? GROUP BY provider_id',
      )
      .all(sessionId) as { provider_id: string; t: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.provider_id] = r.t;
    return out;
  },

  /** Tokens per model. Failover can move a session onto a different model
   *  mid-run, so a result that names one model without this is not reproducible. */
  byModel(sessionId: string): Record<string, number> {
    const rows = getDb()
      .prepare('SELECT model_id, SUM(total_tokens) t FROM token_usage WHERE session_id=? GROUP BY model_id')
      .all(sessionId) as { model_id: string; t: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.model_id] = r.t;
    return out;
  },

  grandTotal(): { total: number; cost: number; sessions: number } {
    const r = getDb()
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) t, COALESCE(SUM(cost_usd),0) c,
         COUNT(DISTINCT session_id) s FROM token_usage`,
      )
      .get() as { t: number; c: number; s: number };
    return { total: r.t, cost: r.c, sessions: r.s };
  },
};
