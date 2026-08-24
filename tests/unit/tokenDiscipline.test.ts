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
