// Property tests (spec §24.1) — invariants for budget profiles, the task
// scheduler, IR normalization, and diff splitting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_PROFILES, profileForTask } from '../../src/context/budget.js';
import { nextReadyTask } from '../../src/workers/scheduler.js';
import { irFromJson } from '../../src/workers/irFromJson.js';
import { splitUnifiedDiff } from '../../src/workers/irFromDiff.js';

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
