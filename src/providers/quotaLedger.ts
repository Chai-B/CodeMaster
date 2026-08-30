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
  /** Counters below `cost_usd` cover this window only and roll over with it. */
  window_start: string;
  tokens_used: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Thinking the vendor billed as output. Counted inside `output_tokens` too;
   *  kept apart so the price of reasoning is visible rather than buried. */
  reasoning_tokens: number;
  cost_usd: number;
  /** Never reset. What this account has cost since it was first used. */
  lifetime_tokens: number;
  lifetime_requests: number;
  lifetime_cost_usd: number;
  /** Summed over `lifetime_requests`, so the average is derivable. */
  latency_ms_total: number;
  first_used_at?: string;
  last_used_at?: string;
  /** Set only from a vendor-reported limit (Retry-After or a usage-limit reset). */
  rate_limited_until?: string;
  consecutive_failures: number;
  cooldown_until?: string;
  last_error?: string;
}

/** What one call actually cost this account. Passed whole rather than as a
 *  single total: the split is what makes a bill explainable. */
export interface UsageDelta {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

interface Row {
  key: string;
  provider_id: string;
  window_start: string;
  tokens_used: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  lifetime_tokens: number;
  lifetime_requests: number;
  lifetime_cost_usd: number;
  latency_ms_total: number;
  first_used_at: string | null;
  last_used_at: string | null;
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

/** How long this vendor's usage window runs. opencode and anything else not
 *  listed take the default, because their reset period is not published. */
export function windowMs(providerId: string): number {
  return WINDOW_MS[providerId] ?? DEFAULT_WINDOW_MS;
}

/** When the current window's counters go back to zero. */
export function resetsAt(s: QuotaState): string {
  return iso(Date.parse(s.window_start) + windowMs(s.provider_id));
}

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
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  lifetime_tokens INTEGER NOT NULL DEFAULT 0,
  lifetime_requests INTEGER NOT NULL DEFAULT 0,
  lifetime_cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms_total INTEGER NOT NULL DEFAULT 0,
  first_used_at TEXT,
  last_used_at TEXT,
  rate_limited_until TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);`;

// The table predates the per-account accounting, so a ledger already on disk is
// widened in place rather than dropped — its spend history is the one thing
// here that cannot be recomputed.
const ADDED_COLUMNS: Array<[string, string]> = [
  ['input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['cache_write_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['reasoning_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['cost_usd', 'REAL NOT NULL DEFAULT 0'],
  ['lifetime_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['lifetime_requests', 'INTEGER NOT NULL DEFAULT 0'],
  ['lifetime_cost_usd', 'REAL NOT NULL DEFAULT 0'],
  ['latency_ms_total', 'INTEGER NOT NULL DEFAULT 0'],
  ['first_used_at', 'TEXT'],
  ['last_used_at', 'TEXT'],
];

function migrate(d: DatabaseSync): void {
  const have = new Set(
    (d.prepare('PRAGMA table_info(account_quota)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of ADDED_COLUMNS) {
    if (!have.has(name)) d.exec(`ALTER TABLE account_quota ADD COLUMN ${name} ${type}`);
  }
}

let db: DatabaseSync | null = null;

function conn(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(path.join(DATA_DIR, 'quota.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
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
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
    reasoning_tokens: r.reasoning_tokens,
    cost_usd: r.cost_usd,
    lifetime_tokens: r.lifetime_tokens,
    lifetime_requests: r.lifetime_requests,
    lifetime_cost_usd: r.lifetime_cost_usd,
    latency_ms_total: r.latency_ms_total,
    first_used_at: r.first_used_at ?? undefined,
    last_used_at: r.last_used_at ?? undefined,
    rate_limited_until: r.rate_limited_until ?? undefined,
    consecutive_failures: r.consecutive_failures,
    cooldown_until: r.cooldown_until ?? undefined,
    last_error: r.last_error ?? undefined,
  };
}

function write(s: QuotaState): void {
  conn()
    .prepare(
      `INSERT INTO account_quota (key, provider_id, window_start, tokens_used, requests,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd,
         lifetime_tokens, lifetime_requests, lifetime_cost_usd, latency_ms_total, first_used_at, last_used_at,
         rate_limited_until, consecutive_failures, cooldown_until, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET provider_id=excluded.provider_id, window_start=excluded.window_start,
         tokens_used=excluded.tokens_used, requests=excluded.requests,
         input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
         cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
         reasoning_tokens=excluded.reasoning_tokens, cost_usd=excluded.cost_usd,
         lifetime_tokens=excluded.lifetime_tokens, lifetime_requests=excluded.lifetime_requests,
         lifetime_cost_usd=excluded.lifetime_cost_usd, latency_ms_total=excluded.latency_ms_total,
         first_used_at=excluded.first_used_at, last_used_at=excluded.last_used_at,
         rate_limited_until=excluded.rate_limited_until,
         consecutive_failures=excluded.consecutive_failures, cooldown_until=excluded.cooldown_until,
         last_error=excluded.last_error, updated_at=excluded.updated_at`,
    )
    .run(
      s.key, s.provider_id, s.window_start, s.tokens_used, s.requests,
      s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens,
      s.reasoning_tokens, s.cost_usd,
      s.lifetime_tokens, s.lifetime_requests, s.lifetime_cost_usd, s.latency_ms_total,
      s.first_used_at ?? null, s.last_used_at ?? null,
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
        tokens_used: 0, requests: 0,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
        reasoning_tokens: 0, cost_usd: 0,
        lifetime_tokens: 0, lifetime_requests: 0, lifetime_cost_usd: 0, latency_ms_total: 0,
        consecutive_failures: 0,
      };
      write(fresh);
      return fresh;
    }
    const state = rowToState(row);
    if (nowMs - Date.parse(state.window_start) > windowMs(providerId)) {
      state.window_start = iso(nowMs);
      state.tokens_used = 0;
      state.requests = 0;
      state.input_tokens = 0;
      state.output_tokens = 0;
      state.cache_read_tokens = 0;
      state.cache_write_tokens = 0;
      state.reasoning_tokens = 0;
      state.cost_usd = 0;
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

  recordUsage(key: string, providerId: string, d: UsageDelta): void {
    const s = QuotaLedger.get(key, providerId);
    const at = iso(Date.now());
    s.tokens_used += d.total_tokens;
    s.requests += 1;
    s.input_tokens += d.input_tokens;
    s.output_tokens += d.output_tokens;
    s.cache_read_tokens += d.cache_read_tokens ?? 0;
    s.cache_write_tokens += d.cache_write_tokens ?? 0;
    s.reasoning_tokens += d.reasoning_tokens ?? 0;
    s.cost_usd += d.cost_usd;
    s.lifetime_tokens += d.total_tokens;
    s.lifetime_requests += 1;
    s.lifetime_cost_usd += d.cost_usd;
    s.latency_ms_total += d.latency_ms;
    s.first_used_at ??= at;
    s.last_used_at = at;
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
