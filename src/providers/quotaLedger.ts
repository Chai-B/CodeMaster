// Persistent provider quota and health state (plan §Phase 2).
//
// The previous model invented every number — a 50M "daily token limit" and a
// 50 rpm cap identical for all four vendors, held in memory and rebuilt from
// zero on each process start, so nothing was ever actually known about a
// subscription window. This records only what the vendors and the run itself
// report: tokens actually spent, rate limits the vendor actually returned, and
// failures that actually happened. Nothing here is estimated.

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { DATA_DIR, ensureDirs } from '../config.js';

export interface QuotaState {
  key: string;
  provider_id: string;
  window_start: string;
  tokens_used: number;
  requests: number;
  /** Set only from a vendor-reported limit (Retry-After or a usage-limit reset). */
  rate_limited_until?: string;
  consecutive_failures: number;
  cooldown_until?: string;
  last_error?: string;
}

interface Row {
  key: string;
  provider_id: string;
  window_start: string;
  tokens_used: number;
  requests: number;
  rate_limited_until: string | null;
  consecutive_failures: number;
  cooldown_until: string | null;
  last_error: string | null;
}

// Subscription usage is measured in rolling windows, not calendar days: Claude
// Pro/Max resets every 5 hours. A window here only bounds the usage counters —
// exhaustion is never inferred from them, only from what a vendor reports.
const WINDOW_MS: Record<string, number> = {
  anthropic: 5 * 60 * 60 * 1000,
  openai: 60 * 60 * 1000,
  'openai-codex': 5 * 60 * 60 * 1000,
  google: 24 * 60 * 60 * 1000,
};
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

// Escalating cooldown after consecutive failures. One transient error should
// cost seconds, a genuinely broken provider should stop being retried.
const COOLDOWN_STEPS_MS = [30_000, 120_000, 600_000];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account_quota (
  key TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  rate_limited_until TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);`;

let db: DatabaseSync | null = null;

function conn(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(path.join(DATA_DIR, 'quota.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function rowToState(r: Row): QuotaState {
  return {
    key: r.key,
    provider_id: r.provider_id,
    window_start: r.window_start,
    tokens_used: r.tokens_used,
    requests: r.requests,
    rate_limited_until: r.rate_limited_until ?? undefined,
    consecutive_failures: r.consecutive_failures,
    cooldown_until: r.cooldown_until ?? undefined,
    last_error: r.last_error ?? undefined,
  };
}

function write(s: QuotaState): void {
  conn()
    .prepare(
      `INSERT INTO account_quota (key, provider_id, window_start, tokens_used, requests, rate_limited_until, consecutive_failures, cooldown_until, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET provider_id=excluded.provider_id, window_start=excluded.window_start,
         tokens_used=excluded.tokens_used, requests=excluded.requests, rate_limited_until=excluded.rate_limited_until,
         consecutive_failures=excluded.consecutive_failures, cooldown_until=excluded.cooldown_until,
         last_error=excluded.last_error, updated_at=excluded.updated_at`,
    )
    .run(
      s.key, s.provider_id, s.window_start, s.tokens_used, s.requests,
      s.rate_limited_until ?? null, s.consecutive_failures, s.cooldown_until ?? null,
      s.last_error ?? null, iso(Date.now()),
    );
}

export const QuotaLedger = {
  /** Current state, with an expired usage window rolled over. */
  get(key: string, providerId: string): QuotaState {
    const row = conn().prepare('SELECT * FROM account_quota WHERE key = ?').get(key) as unknown as Row | undefined;
    const nowMs = Date.now();
    if (!row) {
      const fresh: QuotaState = {
        key, provider_id: providerId, window_start: iso(nowMs),
        tokens_used: 0, requests: 0, consecutive_failures: 0,
      };
      write(fresh);
      return fresh;
    }
    const state = rowToState(row);
    const windowMs = WINDOW_MS[providerId] ?? DEFAULT_WINDOW_MS;
    if (nowMs - Date.parse(state.window_start) > windowMs) {
      state.window_start = iso(nowMs);
      state.tokens_used = 0;
      state.requests = 0;
      write(state);
    }
    return state;
  },

  /** False while a vendor-reported rate limit or a failure cooldown is in force. */
  available(key: string, providerId: string): boolean {
    const s = QuotaLedger.get(key, providerId);
    const nowMs = Date.now();
    if (s.rate_limited_until && Date.parse(s.rate_limited_until) > nowMs) return false;
    if (s.cooldown_until && Date.parse(s.cooldown_until) > nowMs) return false;
    return true;
  },

  /** Milliseconds until this account is usable again; 0 when it already is. */
  blockedForMs(key: string, providerId: string): number {
    const s = QuotaLedger.get(key, providerId);
    const until = Math.max(
      s.rate_limited_until ? Date.parse(s.rate_limited_until) : 0,
      s.cooldown_until ? Date.parse(s.cooldown_until) : 0,
    );
    return Math.max(0, until - Date.now());
  },

  recordUsage(key: string, providerId: string, tokens: number): void {
    const s = QuotaLedger.get(key, providerId);
    s.tokens_used += tokens;
    s.requests += 1;
    write(s);
  },

  /** A completed call clears the failure streak — this is the breaker closing. */
  recordSuccess(key: string, providerId: string): void {
    const s = QuotaLedger.get(key, providerId);
    if (s.consecutive_failures === 0 && !s.cooldown_until) return;
    s.consecutive_failures = 0;
    s.cooldown_until = undefined;
    s.last_error = undefined;
    write(s);
  },

  recordFailure(key: string, providerId: string, reason: string): number {
    const s = QuotaLedger.get(key, providerId);
    s.consecutive_failures += 1;
    s.last_error = reason.slice(0, 500);
    const step = COOLDOWN_STEPS_MS[Math.min(s.consecutive_failures - 1, COOLDOWN_STEPS_MS.length - 1)]!;
    s.cooldown_until = iso(Date.now() + step);
    write(s);
    return step;
  },

  /** Vendor-reported limit. `retryAfterMs` comes from a header or a reset time. */
  markRateLimited(key: string, providerId: string, retryAfterMs: number): void {
    const s = QuotaLedger.get(key, providerId);
    s.rate_limited_until = iso(Date.now() + retryAfterMs);
    write(s);
  },

  all(): QuotaState[] {
    return (conn().prepare('SELECT * FROM account_quota ORDER BY provider_id, key').all() as unknown as Row[]).map(rowToState);
  },
};

/**
 * Milliseconds to wait before retrying, taken from what the provider actually
 * said — a `retry-after` header, an epoch reset in a subscription usage-limit
 * message, or a plain `429`. Returns null when the error is not a rate limit,
 * so ordinary failures are not mistaken for exhausted quota.
 */
export function parseRetryAfterMs(err: unknown): number | null {
  const e = err as { status?: number; headers?: Record<string, string> } | undefined;
  const header = e?.headers?.['retry-after'] ?? e?.headers?.['Retry-After'];
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }

  const text = err instanceof Error ? err.message : String(err ?? '');
  // Claude CLI subscription exhaustion: "usage limit reached|<epoch seconds>".
  const limit = /usage limit reached\|(\d{9,})/i.exec(text);
  if (limit) return Math.max(0, Number(limit[1]) * 1000 - Date.now());
  if (/rate.?limit|too many requests|\b429\b/i.test(text) || e?.status === 429) return 60_000;
  if (/usage limit|quota exceeded|insufficient_quota/i.test(text)) return 60 * 60 * 1000;
  return null;
}
