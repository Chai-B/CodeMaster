// Token discipline (spec §6): the budget must escalate rather than fill, and
// unreferenced context must be measured rather than assumed to be zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ModelSpec, TokenUsage } from '../../src/types/index.js';

process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-td-'));

const { resolveBudget, budgetForTier } = await import('../../src/context/budget.js');
const { Tokens } = await import('../../src/storage/tokens.js');
const { PromptCache, promptHash } = await import('../../src/storage/promptCache.js');
// Imported after CODEMASTER_DATA_DIR is set, like everything else here: a
// static import of the provider manager binds the real user database at load.
const { costOfUsage } = await import('../../src/providers/manager.js');
const { looksLikeQuestion, sessionState } = await import('../../src/workers/asker.js');

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

  // One hit recorded → 4200 tokens that were not bought a second time. Misses are
  // counted too: a hit count with no denominator is not a hit rate.
  const before = PromptCache.saved();
  assert.equal(before.hits, 1);
  assert.equal(before.tokens, 4200);
  assert.equal(PromptCache.get(promptHash('never asked', 'sonnet')), null);
  assert.equal(PromptCache.saved().misses, before.misses + 1);
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

// Measured: 70.5k tokens to plan "create a tic tac toe game" and be told it was
// one task — which is also the planner's own fallback when a plan comes back
// empty. One short clause with no list and no second verb skips the call.
test('a single-clause objective is planned without a planning call', async () => {
  const { isSingleUnit } = await import('../../src/workers/planner.js');
  assert.equal(isSingleUnit('create a tic tac toe game'), true);
  assert.equal(isSingleUnit('fix the off-by-one in the paginator'), true);
  // A second clause, a list, or a joined verb is more than one unit of work.
  assert.equal(isSingleUnit('add a login page and wire up the session cookie'), false);
  assert.equal(isSingleUnit('rename the parser, then update its callers'), false);
  assert.equal(isSingleUnit('port the CLI\n- add flags\n- add tests'), false);
  // Long enough to be describing a project rather than a change.
  assert.equal(isSingleUnit('x'.repeat(200)), false);
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

// Cached input is not fresh input. Charging the whole billed input at the fresh
// rate priced a resumed conversation at up to 1.76x what the vendor took, and
// every savings figure is computed against that baseline.
test('a cache read costs a tenth of a fresh token, and a cache write a quarter more', () => {
  const spec: ModelSpec = { id: 'm', context_size: 200_000, cost_per_1m_input: 10, cost_per_1m_output: 50 };
  const usage: TokenUsage = {
    input_tokens: 100_000, output_tokens: 0,
    cache_read_tokens: 80_000, cache_write_tokens: 10_000, total_tokens: 100_000,
  };
  // 10k fresh at 10 + 80k at 1 + 10k at 12.5, per million.
  const expected = (10_000 * 10 + 80_000 * 1 + 10_000 * 12.5) / 1_000_000;
  assert.ok(Math.abs(costOfUsage(spec, usage) - expected) < 1e-12);
  // The old model charged the whole input fresh; the gap is the overcharge.
  assert.ok(costOfUsage(spec, usage) < (100_000 / 1_000_000) * 10);
});

test('a call with no cache is priced exactly as before', () => {
  const spec: ModelSpec = { id: 'm', context_size: 200_000, cost_per_1m_input: 10, cost_per_1m_output: 50 };
  const usage: TokenUsage = { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 };
  assert.ok(Math.abs(costOfUsage(spec, usage) - ((1000 / 1_000_000) * 10 + (200 / 1_000_000) * 50)) < 1e-12);
});

// A provider reporting cache counts outside its input total would otherwise
// drive the fresh figure negative and refund the call.
test('cache counts larger than the input total never produce a negative charge', () => {
  const spec: ModelSpec = { id: 'm', context_size: 200_000, cost_per_1m_input: 10, cost_per_1m_output: 50 };
  const usage: TokenUsage = {
    input_tokens: 10, output_tokens: 0, cache_read_tokens: 5000, cache_write_tokens: 0, total_tokens: 10,
  };
  assert.ok(costOfUsage(spec, usage) > 0);
  assert.ok(Math.abs(costOfUsage(spec, usage) - (5000 / 1_000_000) * 1) < 1e-12);
});

// The user's phrasing that started a full session instead of answering.
test('an explicit refusal of writes is a question, not an objective', () => {
  assert.equal(looksLikeQuestion('give me a quick summary of this project, no writes, only read'), true);
  assert.equal(looksLikeQuestion('walk me through the architecture'), true);
  assert.equal(looksLikeQuestion('explain the auth flow'), true);
  // The opening verb still wins: these ask for work, whatever qualifies them.
  assert.equal(looksLikeQuestion('add a read-only flag to the config'), false);
  assert.equal(looksLikeQuestion('refactor the solver without changing behaviour'), false);
  assert.equal(looksLikeQuestion('give me a login button'), false);
});

// `/ask` compiles against an ephemeral session, so a question about the run
// itself — "what have we done so far" — used to be answered with "I have no
// session record to summarize" by the tool that was doing the work.
test('the ask path can see the session it was asked inside', async () => {
  const { Sessions, Tasks } = await import('../../src/storage/sessions.js');
  const { Reasoning } = await import('../../src/storage/reasoning.js');
  const { id, now } = await import('../../src/util/id.js');

  const sid = id('session');
  const live = {
    id: sid, created_at: now(), updated_at: now(), status: 'active',
    objective: 'ship the parser', repository: { path: process.cwd(), commit: 'x' },
    progress: { total: 2, completed: 1, failed: 0 },
    constraints: [], open_questions: [{ text: 'unicode identifiers?', status: 'open' }],
    working_files: [], decisions: [], provider_history: [], checkpoints: [],
    token_usage: { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 },
    metadata: {},
  };
  Sessions.insert(live as never);
  const task = (title: string, status: string) => ({
    id: id('task'), session_id: sid, title, description: title, type: 'implement', status,
    input_files: [], output_files: [], dependencies: [], blocking: [],
    reasoning_refs: [], decision_refs: [], estimated_tokens: 0, order: 0,
  });
  Tasks.insert(task('Write the lexer', 'completed') as never);
  Tasks.insert(task('Write the parser', 'in_progress') as never);
  Reasoning.insert({
    id: id('reasoning'), type: 'decision', session_id: sid, task_id: 't',
    summary: 'recursive descent over a table-driven parser', detail: '', evidence: [],
    confidence: 0.9, produced_by: { provider_id: 'x', model_id: 'y' }, produced_at: now(),
    affected_files: [], affected_modules: [], tags: [],
    permanent: false, wiki_keys: [], reference_count: 0, importance: 0.8,
  } as never);

  const block = sessionState(live as never);

  assert.match(block, /ship the parser/);
  assert.match(block, /1\/2 tasks completed/);
  assert.match(block, /\[completed\] Write the lexer/);
  assert.match(block, /\[in_progress\] Write the parser/);
  assert.match(block, /recursive descent/);
  assert.match(block, /unicode identifiers\?/);

  // A session with nothing recorded yet still states what it is working on
  // rather than emitting an empty component.
  const bare = sessionState({
    ...live, id: id('session'), objective: 'start something',
    progress: { total: 0, completed: 0, failed: 0 }, open_questions: [],
  } as never);
  assert.match(bare, /start something/);
  assert.ok(!/Tasks:/.test(bare));
});
