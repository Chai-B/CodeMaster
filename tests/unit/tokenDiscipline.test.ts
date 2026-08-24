// Token discipline (spec §6): the budget must escalate rather than fill, and
// unreferenced context must be measured rather than assumed to be zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-td-'));

const { resolveBudget, budgetForTier } = await import('../../src/context/budget.js');
const { Tokens } = await import('../../src/storage/tokens.js');
const { PromptCache, promptHash } = await import('../../src/storage/promptCache.js');

test('the first attempt gets the smallest rung, not the whole window', () => {
  assert.equal(budgetForTier(200_000, 0), 24_000);
  assert.equal(budgetForTier(200_000, 1), 64_000);
  assert.equal(budgetForTier(200_000, 2), 160_000);
});

test('a small model window caps the rung', () => {
  assert.equal(budgetForTier(8_000, 2), 8_000);
});

test('allocations are shares of the granted budget, not of the model window', () => {
  const { allocations, budget } = resolveBudget('implement', 200_000, 0);
  assert.equal(budget, 24_000);
  const total = Object.values(allocations).reduce((a, b) => a + b, 0);
  assert.ok(total <= 24_000, `allocations totalled ${total}`);
});

test('waste ratio is null until a real invocation is recorded', () => {
  assert.equal(Tokens.wasteRatio('session-with-nothing'), null);
});

test('waste ratio reports the recorded unreferenced tokens', () => {
  Tokens.record({
    session_id: 'sess-waste', task_id: 't1', provider_id: 'anthropic', account_id: 'a1',
    model_id: 'claude-sonnet-4-6',
    usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
    cost_usd: 0, components: [], wasted_tokens: 250,
  });
  const w = Tokens.wasteRatio('sess-waste');
  assert.ok(w);
  assert.equal(w!.wasted, 250);
  assert.equal(w!.ratio, 0.25);
});


// ── W4: never ask the same reasoning twice ──────────────────

test('the prompt hash changes with the context and with the model', () => {
  const a = promptHash('body one', 'sonnet');
  assert.equal(a, promptHash('body one', 'sonnet'));
  assert.notEqual(a, promptHash('body two', 'sonnet'));
  assert.notEqual(a, promptHash('body one', 'opus'));
});

test('a cached answer is returned without a provider call and counted as saved', () => {
  const ir = { ir_version: '1.0', status: 'completed', summary: 'fix the parser', patches: [] } as never;
  const h = promptHash('some compiled context', 'sonnet');
  assert.equal(PromptCache.get(h), null);

  PromptCache.put(h, 'sonnet', ir, 4200);
  const hit = PromptCache.get(h);
  assert.equal(hit?.tokens, 4200);
  assert.equal(hit?.ir.summary, 'fix the parser');

  // One hit recorded → 4200 tokens that were not bought a second time.
  assert.deepEqual(PromptCache.saved(), { hits: 1, tokens: 4200 });
});
