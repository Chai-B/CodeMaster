// Token analytics (spec §20.3) — efficiency metrics over the token ledger.

import { getDb } from '../storage/db.js';
import { Tokens } from '../storage/tokens.js';
import { PromptCache } from '../storage/promptCache.js';
import { CACHE_READ_MULTIPLIER } from '../providers/manager.js';
import { loadConfig, allModels } from '../config.js';
import type { ModelSpec } from '../types/index.js';

export interface TaskTypeStats {
  type: string;
  invocations: number;
  total_tokens: number;
  avg_tokens: number;
}

export function tokensByTaskType(sessionId?: string): TaskTypeStats[] {
  const db = getDb();
  const where = sessionId ? 'WHERE t.session_id = ?' : '';
  const rows = db
    .prepare(
      `SELECT COALESCE(tk.type,'unknown') type, COUNT(*) n, SUM(u.total_tokens) tot
       FROM token_usage u
       LEFT JOIN tasks tk ON tk.id = u.task_id
       ${where ? where.replace('t.session_id', 'u.session_id') : ''}
       GROUP BY tk.type`,
    )
    .all(...(sessionId ? [sessionId] : [])) as Array<{ type: string; n: number; tot: number }>;
  return rows.map((r) => ({
    type: r.type ?? 'unknown',
    invocations: r.n,
    total_tokens: r.tot ?? 0,
    avg_tokens: r.n ? Math.round((r.tot ?? 0) / r.n) : 0,
  }));
}

export interface ProfileResult {
  task_id: string;
  invocations: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  components: string[];
}

export function profileTask(taskId: string): ProfileResult | null {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM token_usage WHERE task_id=?').all(taskId) as Array<Record<string, unknown>>;
  if (!rows.length) return null;
  let input = 0;
  let output = 0;
  let cost = 0;
  const components = new Set<string>();
  for (const r of rows) {
    input += (r.input_tokens as number) ?? 0;
    output += (r.output_tokens as number) ?? 0;
    cost += (r.cost_usd as number) ?? 0;
    try {
      for (const c of JSON.parse((r.context_components_json as string) ?? '[]') as string[]) components.add(c);
    } catch {
      /* ignore */
    }
  }
  return {
    task_id: taskId,
    invocations: rows.length,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    cost_usd: cost,
    components: [...components],
  };
}

export interface ProviderEfficiency {
  provider: string;
  total_tokens: number;
  invocations: number;
  avg_output: number;
}

export function providerEfficiency(): ProviderEfficiency[] {
  const rows = getDb()
    .prepare(
      `SELECT provider_id, COUNT(*) n, SUM(total_tokens) tot, AVG(output_tokens) avgo
       FROM token_usage GROUP BY provider_id`,
    )
    .all() as Array<{ provider_id: string; n: number; tot: number; avgo: number }>;
  return rows.map((r) => ({
    provider: r.provider_id,
    total_tokens: r.tot ?? 0,
    invocations: r.n,
    avg_output: Math.round(r.avgo ?? 0),
  }));
}

/** One way tokens or money were not spent, and where it happened. A bare total
 *  is not auditable — the point of the report is that every dollar in it can be
 *  traced back to a mechanism you can go and look at. */
export interface SavingRow {
  label: string;
  detail: string;
  /** Tokens never sent to any model. Zero for savings that are purely a
   *  discount on tokens that *were* sent. */
  tokens: number;
  usd: number;
}

export interface SavingsReport {
  rows: SavingRow[];
  tokensSaved: number;
  usdSaved: number;
  /** What was actually billed, from the ledger. Savings are meaningless without it. */
  usdSpent: number;
  tokensSpent: number;
  calls: number;
  waste: { tokens: number; ratio: number } | null;
  window: { peak: number; peakModel: string; peakSize: number; avgFill: number } | null;
  quality: { tasks: number; completed: number; verified: number; failed: number; retried: number } | null;
}

/**
 * What CodeMaster did not spend, and why.
 *
 * Every figure comes from a persisted row. Nothing here is a counterfactual
 * about what some other tool might have done: a reuse saving is priced from the
 * token count of the answer that was actually served from cache, and a cache
 * discount from the token count the vendor actually reported as a cache read.
 */
export function savingsReport(): SavingsReport {
  const cfg = loadConfig();
  const models = allModels(cfg);
  const priceOf = (m: string): ModelSpec | undefined => models.find((x) => x.id === m);

  const rows: SavingRow[] = [];

  // 1. Answers served from our own store. These never reached a provider, so
  //    the whole input price is avoided, not a fraction of it.
  let reuseTok = 0;
  let reuseUsd = 0;
  let reuseHits = 0;
  for (const r of PromptCache.savedByModel()) {
    const spec = priceOf(r.model_id);
    reuseTok += r.tokens;
    reuseHits += r.hits;
    if (spec) reuseUsd += (r.tokens / 1_000_000) * spec.cost_per_1m_input;
  }
  if (reuseHits > 0) {
    rows.push({
      label: 'Reused answers',
      detail: `${reuseHits} prompt${reuseHits === 1 ? '' : 's'} answered from the local store — no call was made`,
      tokens: reuseTok,
      usd: reuseUsd,
    });
  }

  // 2. The vendor's prefix cache. These tokens were sent and are billed, just at
  //    a tenth of the rate — so the saving is the nine tenths, and the token
  //    count is deliberately zero.
  const cacheRows = getDb()
    .prepare(
      `SELECT model_id, COALESCE(SUM(cache_read_tokens),0) c FROM token_usage
       WHERE cache_read_tokens > 0 GROUP BY model_id`,
    )
    .all() as Array<{ model_id: string; c: number }>;
  let cacheTok = 0;
  let cacheUsd = 0;
  for (const r of cacheRows) {
    const spec = priceOf(r.model_id);
    cacheTok += r.c;
    if (spec) {
      const mult = spec.cache_read_multiplier ?? CACHE_READ_MULTIPLIER;
      cacheUsd += (r.c / 1_000_000) * spec.cost_per_1m_input * (1 - mult);
    }
  }
  if (cacheTok > 0) {
    rows.push({
      label: 'Provider cache',
      detail: `${cacheTok.toLocaleString()} input tokens matched a cached prefix and billed at a fraction of the rate`,
      tokens: 0,
      usd: cacheUsd,
    });
  }

  const t = getDb()
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(cost_usd),0) usd FROM token_usage`,
    )
    .get() as { n: number; tok: number; usd: number };

  // 3. Context window occupancy. The window is a per-call ceiling, not a pool,
  //    so it is reported as the worst call rather than a sum: what matters is
  //    whether any single call came near the limit.
  const calls = getDb()
    .prepare('SELECT model_id, input_tokens i FROM token_usage WHERE input_tokens > 0')
    .all() as Array<{ model_id: string; i: number }>;
  let window: SavingsReport['window'] = null;
  if (calls.length) {
    let peak = calls[0]!;
    let fill = 0;
    for (const c of calls) {
      const size = priceOf(c.model_id)?.context_size ?? cfg.context.max_context_tokens;
      fill += c.i / size;
      if (c.i > peak.i) peak = c;
    }
    const peakSize = priceOf(peak.model_id)?.context_size ?? cfg.context.max_context_tokens;
    window = { peak: peak.i, peakModel: peak.model_id, peakSize, avgFill: fill / calls.length };
  }

  const waste = Tokens.wasteRatio();

  const q = getDb()
    .prepare(
      `SELECT COUNT(*) n,
              COALESCE(SUM(status='completed'),0) done,
              COALESCE(SUM(status='failed'),0) failed,
              COALESCE(SUM(evidence_json LIKE '%"verified":true%'),0) verified
       FROM tasks`,
    )
    .get() as { n: number; done: number; failed: number; verified: number };
  // A task with more solver calls than one needed a second attempt. That is the
  // honest first-pass signal available without inventing a new column.
  const retried = (
    getDb()
      .prepare(
        `SELECT COUNT(*) n FROM (
           SELECT task_id FROM token_usage WHERE task_id IS NOT NULL AND role='solve'
           GROUP BY task_id HAVING COUNT(*) > 1)`,
      )
      .get() as { n: number }
  ).n;

  return {
    rows,
    tokensSaved: rows.reduce((a, r) => a + r.tokens, 0),
    usdSaved: rows.reduce((a, r) => a + r.usd, 0),
    usdSpent: t.usd,
    tokensSpent: t.tok,
    calls: t.n,
    waste: waste ? { tokens: waste.wasted, ratio: waste.ratio } : null,
    window,
    quality: q.n ? { tasks: q.n, completed: q.done, verified: q.verified, failed: q.failed, retried } : null,
  };
}
