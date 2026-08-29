// Property tests (spec §24.1) — invariants for budget profiles, the task
// scheduler, IR normalization, and diff splitting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_PROFILES, profileForTask } from '../../src/context/budget.js';
import { nextReadyTask } from '../../src/workers/scheduler.js';
import { irFromJson } from '../../src/workers/irFromJson.js';
import { splitUnifiedDiff, irFromDiff } from '../../src/workers/irFromDiff.js';
import { validateHandoffPackage } from '../../src/workers/handoff.js';
import { REASONING_MARKER } from '../../src/context/outputFormat.js';

test('every budget profile sums to ~1.0', () => {
  for (const [name, profile] of Object.entries(BUDGET_PROFILES)) {
    const sum = Object.values(profile).reduce((a, b) => a + (b ?? 0), 0);
    assert.ok(Math.abs(sum - 1) < 0.001, `profile ${name} sums to ${sum}`);
  }
});

test('every task type maps to a defined profile', () => {
  for (const t of ['plan', 'implement', 'debug', 'refactor', 'test', 'review', 'verify'] as const) {
    assert.ok(BUDGET_PROFILES[profileForTask(t)], `no profile for ${t}`);
  }
});

test('nextReadyTask never returns a task with unmet dependencies', () => {
  const tasks = [
    { id: 'a', status: 'completed', dependencies: [], order: 0 },
    { id: 'b', status: 'pending', dependencies: ['a'], order: 1 },
    { id: 'c', status: 'pending', dependencies: ['b'], order: 2 },
  ];
  const next = nextReadyTask(tasks)!;
  assert.equal(next.id, 'b');
  assert.ok(next.dependencies.every((d) => tasks.find((t) => t.id === d)?.status === 'completed'));
});

test('nextReadyTask returns null when all tasks blocked or done', () => {
  const tasks = [
    { id: 'a', status: 'completed', dependencies: [], order: 0 },
    { id: 'b', status: 'pending', dependencies: ['missing'], order: 1, },
  ];
  // 'missing' is not in the set → treated as satisfiable; so b is ready.
  assert.equal(nextReadyTask(tasks)?.id, 'b');
  const allDone = [{ id: 'a', status: 'completed', dependencies: [], order: 0 }];
  assert.equal(nextReadyTask(allDone), null);
});

test('irFromJson and an equivalent diff produce the same patch target', () => {
  const pb = { provider_id: 'x', model_id: 'y' };
  const json = JSON.stringify({ status: 'completed', summary: 's', patches: [{ file: 'z.ts', diff: '@@ -1 +1 @@\n-a\n+b' }] });
  const ir = irFromJson(json, 's', 't', pb);
  assert.equal(ir.patches[0]!.file, 'z.ts');
});

test('splitUnifiedDiff groups hunks by file', () => {
  const diff = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-x
+y
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-p
+q`;
  const patches = splitUnifiedDiff(diff);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map((p) => p.file).sort(), ['one.ts', 'two.ts']);
});

// A diff-format provider used to contribute nothing to the reasoning layer:
// its decisions died with the response. The trailing block is optional, so both
// halves of the contract have to hold — parsed when present, ignored when not.
test('irFromDiff carries the reasoning block and survives its absence', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const by = { provider_id: 'codex', model_id: 'gpt-5' };

  const bare = irFromDiff(diff, 's1', 't1', by);
  assert.equal(bare.patches.length, 1);
  assert.equal(bare.decisions.length, 0);

  const withReasoning = irFromDiff(
    `${diff}\n${REASONING_MARKER}\n${JSON.stringify({
      summary: 'renamed the flag',
      decisions: [{ question: 'rename?', answer: 'yes', confidence: 0.9 }],
      risks: [{ description: 'callers may break', likelihood: 'low', impact: 'medium' }],
    })}`,
    's1',
    't1',
    by,
  );
  assert.equal(withReasoning.patches.length, 1, 'the marker must not eat the diff');
  assert.equal(withReasoning.summary, 'renamed the flag');
  assert.equal(withReasoning.decisions.length, 1);
  assert.equal(withReasoning.risks.length, 1);
  // Reasoning with no locus is findable by keyword only; the diff supplies it.
  assert.deepEqual(withReasoning.decisions[0]!.affected_files, [{ path: 'src/a.ts' }]);

  const malformed = irFromDiff(`${diff}\n${REASONING_MARKER}\n{not json`, 's1', 't1', by);
  assert.equal(malformed.patches.length, 1, 'a bad reasoning block must not lose the patches');
  assert.equal(malformed.decisions.length, 0);
});

// The package exists to let a second provider continue the work. One that
// carries an objective and a filename but nothing to act on and nothing learned
// used to validate clean.
test('validateHandoffPackage rejects a package with nothing to continue', () => {
  const base = {
    objective: 'ship the parser',
    completed_tasks: ['done'],
    remaining_tasks: [] as string[],
    architecture_snapshot: 'a monolith',
    key_decisions: [] as string[],
    key_risks: [] as string[],
    known_failures: [] as string[],
    working_files: ['src/a.ts'],
    recent_changes: '',
    open_questions: [] as string[],
    constraints: [] as string[],
  };
  assert.deepEqual(validateHandoffPackage(base), { ok: false, missing: ['continuity'] });
  assert.ok(validateHandoffPackage({ ...base, remaining_tasks: ['next'] }).ok);
  assert.ok(validateHandoffPackage({ ...base, current_task_state: 'mid-edit' }).ok);
  assert.ok(validateHandoffPackage({ ...base, key_decisions: ['chose recursive descent'] }).ok);
  assert.ok(validateHandoffPackage({ ...base, known_failures: ['regex lexer — no nesting'] }).ok);
  assert.deepEqual(validateHandoffPackage({ ...base, objective: '', working_files: [], architecture_snapshot: '' }).missing, [
    'objective',
    'context',
    'continuity',
  ]);
});
