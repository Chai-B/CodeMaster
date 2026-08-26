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

test('an identical question hits the cache regardless of compile time', () => {
  const body = (t: string) =>
    `# CodeMaster Context\n\n## Task\nfix the eviction bug\n\n<!-- Profile: implementation\n     Compiled: ${t}\n     Tokens (est): 100 / 200 -->`;
  // The manifest timestamp is unique to the millisecond, so hashing it made
  // every lookup miss and this cache could never return anything at all.
  assert.equal(
    promptHash(body('2026-08-25T10:00:00.000Z'), 'm'),
    promptHash(body('2026-08-25T10:00:07.412Z'), 'm'),
  );
  assert.notEqual(
    promptHash(body('2026-08-25T10:00:00.000Z'), 'm'),
    promptHash(body('2026-08-25T10:00:00.000Z').replace('eviction', 'parsing'), 'm'),
  );
});

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

test('a plan that verifies its own work is trimmed before it costs anything', async () => {
  const { isSelfVerificationTask } = await import('../../src/workers/planner.js');
  // Measured: three of six planned tasks on the benchmark were these. They spent
  // half the budget re-checking what the deterministic verifier already runs.
  assert.equal(isSelfVerificationTask('Verify join correctness is preserved'), true);
  assert.equal(isSelfVerificationTask('Confirm memory scaling bound'), true);
  assert.equal(isSelfVerificationTask('Measure matches() call scaling'), true);
  // Real work that happens to mention testing is not verification-only.
  assert.equal(isSelfVerificationTask('Implement _evict()'), false);
  assert.equal(isSelfVerificationTask('Write a test suite for the join contract'), false);
  assert.equal(isSelfVerificationTask('Checkout the release branch'), false);
});

test('under budget pressure, re-derivable context sheds before purchased reasoning', async () => {
  const { enforceBudget } = await import('../../src/context/compiler.js');
  const { ContextComponent: C } = await import('../../src/types/index.js');

  const big = (component: (typeof C)[keyof typeof C], n: number) => ({
    component,
    heading: String(component),
    content: 'x'.repeat(n * 4),
    estimated_tokens: n,
  });
  const components = [
    big(C.OBJECTIVE, 100),
    big(C.REPOSITORY_MAP, 4000),
    big(C.RECENT_CHANGES, 4000),
    big(C.KNOWN_FAILURES, 500),
    big(C.PRIOR_REASONING, 500),
  ];

  const { dropped } = enforceBudget(components, 1200);
  const left = components.map((c) => c.component);

  // A known failure cost a full solver iteration to learn; the repository map is
  // regenerated from disk for nothing.
  assert.ok(left.includes(C.KNOWN_FAILURES), 'known failures must survive');
  assert.ok(left.includes(C.PRIOR_REASONING), 'prior reasoning must survive');
  assert.ok(dropped.includes(C.REPOSITORY_MAP), 'repository map should have been dropped');
});

test('file content is shed as whole files, never a truncated tail of every file', async () => {
  const { enforceBudget } = await import('../../src/context/compiler.js');
  const { ContextComponent: C } = await import('../../src/types/index.js');

  const files = ['a.ts', 'b.ts', 'c.ts'].map((f) => `### ${f}\n\`\`\`\n${'y'.repeat(4000)}\n\`\`\``).join('\n\n');
  const components = [
    { component: C.RELEVANT_FILES, heading: 'Files', content: files, estimated_tokens: 3000 },
    { component: C.KNOWN_FAILURES, heading: 'Failures', content: '- Tried: x\n  Failed because: y', estimated_tokens: 20 },
  ];

  enforceBudget(components, 2100);
  const kept = components.find((c) => c.component === C.RELEVANT_FILES)!;
  assert.ok(kept.content.includes('### a.ts'));
  assert.ok(kept.content.includes('### b.ts'));
  assert.ok(!kept.content.includes('### c.ts'));
  // and it is never dropped outright
  assert.ok(components.some((c) => c.component === C.RELEVANT_FILES));
});
