// Quota ledger: the persistent replacement for the invented per-provider
// constants. Every value it holds must come from something the vendor or the
// run actually reported.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-quota-'));
process.env.CODEMASTER_DATA_DIR = TMP;

const { QuotaLedger, parseRetryAfterMs } = await import('../../src/providers/quotaLedger.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('a fresh account is available and starts empty', () => {
  const s = QuotaLedger.get('anthropic::default', 'anthropic');
  assert.equal(s.tokens_used, 0);
  assert.equal(s.consecutive_failures, 0);
  assert.ok(QuotaLedger.available('anthropic::default', 'anthropic'));
});

test('usage accumulates and survives a new read', () => {
  QuotaLedger.recordUsage('openai::default', 'openai', 1200);
  QuotaLedger.recordUsage('openai::default', 'openai', 800);
  const s = QuotaLedger.get('openai::default', 'openai');
  assert.equal(s.tokens_used, 2000);
  assert.equal(s.requests, 2);
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
