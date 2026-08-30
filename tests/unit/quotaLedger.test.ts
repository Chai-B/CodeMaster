// Quota ledger: the persistent replacement for the invented per-provider
// constants. Every value it holds must come from something the vendor or the
// run actually reported.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-quota-'));
process.env.CODEMASTER_DATA_DIR = TMP;

const { QuotaLedger, parseRetryAfterMs } = await import('../../src/providers/quotaLedger.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Moves a window's start into the past. Done against the file rather than
 *  through a production method, so the ledger keeps no test-only API. */
function backdateWindow(key: string, ms: number): void {
  const d = new DatabaseSync(path.join(TMP, 'quota.db'));
  d.prepare('UPDATE account_quota SET window_start = ? WHERE key = ?').run(new Date(ms).toISOString(), key);
  d.close();
}

test('a fresh account is available and starts empty', () => {
  const s = QuotaLedger.get('anthropic::default', 'anthropic');
  assert.equal(s.tokens_used, 0);
  assert.equal(s.consecutive_failures, 0);
  assert.ok(QuotaLedger.available('anthropic::default', 'anthropic'));
});

test('usage accumulates and survives a new read', () => {
  QuotaLedger.recordUsage('openai::default', 'openai', {
    input_tokens: 1000, output_tokens: 200, total_tokens: 1200, cost_usd: 0.01, latency_ms: 900,
  });
  QuotaLedger.recordUsage('openai::default', 'openai', {
    input_tokens: 600, output_tokens: 200, reasoning_tokens: 150, cache_read_tokens: 500,
    total_tokens: 800, cost_usd: 0.02, latency_ms: 1100,
  });
  const s = QuotaLedger.get('openai::default', 'openai');
  assert.equal(s.tokens_used, 2000);
  assert.equal(s.requests, 2);
  assert.equal(s.input_tokens, 1600);
  assert.equal(s.output_tokens, 400);
  assert.equal(s.reasoning_tokens, 150);
  assert.equal(s.cache_read_tokens, 500);
  assert.equal(s.cost_usd, 0.03);
  assert.equal(s.latency_ms_total, 2000);
  assert.equal(s.lifetime_tokens, 2000);
  assert.ok(s.first_used_at && s.last_used_at, 'both ends of the account\'s life are stamped');
});

test('a window rollover clears the window counters and keeps the lifetime ones', () => {
  const key = 'anthropic::rolls';
  QuotaLedger.recordUsage(key, 'anthropic', {
    input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.5, latency_ms: 10,
  });
  const before = QuotaLedger.get(key, 'anthropic');
  // Anthropic's window is 5 hours; backdate the start past it.
  backdateWindow(key, Date.now() - 6 * 60 * 60 * 1000);
  const after = QuotaLedger.get(key, 'anthropic');
  assert.equal(after.tokens_used, 0, 'the window counters reset');
  assert.equal(after.cost_usd, 0);
  assert.equal(after.lifetime_tokens, before.lifetime_tokens, 'the lifetime total does not');
  assert.equal(after.lifetime_cost_usd, before.lifetime_cost_usd);
});

test('failures cool down with escalating steps and a success closes the breaker', () => {
  const key = 'google::default';
  const first = QuotaLedger.recordFailure(key, 'google', 'boom');
  assert.ok(!QuotaLedger.available(key, 'google'), 'a failed account is not retried immediately');
  const second = QuotaLedger.recordFailure(key, 'google', 'boom again');
  assert.ok(second > first, 'the second failure costs longer than the first');

  QuotaLedger.recordSuccess(key, 'google');
  assert.ok(QuotaLedger.available(key, 'google'));
  assert.equal(QuotaLedger.get(key, 'google').consecutive_failures, 0);
});

test('a vendor-reported rate limit blocks the account for the reported time', () => {
  const key = 'openai-codex::default';
  QuotaLedger.markRateLimited(key, 'openai-codex', 90_000);
  assert.ok(!QuotaLedger.available(key, 'openai-codex'));
  const ms = QuotaLedger.blockedForMs(key, 'openai-codex');
  assert.ok(ms > 80_000 && ms <= 90_000, `expected ~90s remaining, got ${ms}`);
});

test('retry-after is read from the vendor, not guessed', () => {
  assert.equal(parseRetryAfterMs({ headers: { 'retry-after': '30' } }), 30_000);

  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const limit = parseRetryAfterMs(new Error(`Claude AI usage limit reached|${resetAt}`));
  assert.ok(limit !== null && limit > 3_500_000 && limit <= 3_600_000, `got ${limit}`);

  assert.equal(parseRetryAfterMs(new Error('429 Too Many Requests')), 60_000);
  // An ordinary failure must not be mistaken for exhausted quota, or a working
  // provider gets parked for an hour over one bad response.
  assert.equal(parseRetryAfterMs(new Error('claude CLI failed (exit 1)')), null);
});
