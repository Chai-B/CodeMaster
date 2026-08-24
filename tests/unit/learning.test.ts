// Learning loop (spec §7 phase 5): both decisions must come from enough real
// observations, and stay neutral until they do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-learn-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-learn-repo-'));

const { Learning } = await import('../../src/learning/reflector.js');

test('a file with too few observations is not ranked down', () => {
  Learning.recordSelection(repo, ['a.ts'], new Set());
  Learning.recordSelection(repo, ['a.ts'], new Set());
  assert.equal(Learning.utility(repo, 'a.ts'), 1);
});

test('a file included repeatedly and never referenced is ranked down', () => {
  for (let i = 0; i < 4; i++) Learning.recordSelection(repo, ['dead.ts'], new Set());
  assert.equal(Learning.utility(repo, 'dead.ts'), 0.5);
});

test('a file that is always referenced keeps full weight', () => {
  for (let i = 0; i < 4; i++) Learning.recordSelection(repo, ['live.ts'], new Set(['live.ts']));
  assert.equal(Learning.utility(repo, 'live.ts'), 1);
});

test('an unseen file has no opinion attached', () => {
  assert.equal(Learning.utility(repo, 'never-seen.ts'), 1);
});

test('a task type starts at the bottom until the samples are real', () => {
  Learning.recordTier(repo, 'debug', 1, true);
  assert.equal(Learning.startTier(repo, 'debug'), 0);
});

test('a task type starts on the lowest tier that has actually verified', () => {
  for (let i = 0; i < 3; i++) Learning.recordTier(repo, 'refactor', 1, true);
  Learning.recordTier(repo, 'refactor', 0, false);
  assert.equal(Learning.startTier(repo, 'refactor'), 1);
});

test('tiers that only ever failed do not raise the starting rung', () => {
  for (let i = 0; i < 5; i++) Learning.recordTier(repo, 'feature', 2, false);
  assert.equal(Learning.startTier(repo, 'feature'), 0);
});

// ── Third feedback edge: budget follows what the answers actually use ──

const { resolveBudget } = await import('../../src/context/budget.js');

test('a component with too few observations does not move the budget', () => {
  Learning.recordComponents(repo, 'debug', [{ component: 'repository_map', referenced: false }]);
  Learning.recordComponents(repo, 'debug', [{ component: 'repository_map', referenced: false }]);
  assert.deepEqual(Learning.componentWeights(repo, 'debug'), {});
});

test('a component included repeatedly and never used is shrunk, and the rest grow', () => {
  for (let i = 0; i < 5; i++) {
    Learning.recordComponents(repo, 'refactor', [
      { component: 'repository_map', referenced: false },
      { component: 'relevant_files', referenced: true },
    ]);
  }
  const w = Learning.componentWeights(repo, 'refactor');
  assert.equal(w.repository_map, 0.4);
  assert.equal(w.relevant_files, 1);

  const base = resolveBudget('refactor', 200_000, 2);
  const learned = resolveBudget('refactor', 200_000, 2, w);
  assert.ok(learned.allocations.repository_map! < base.allocations.repository_map!);
  assert.ok(learned.allocations.relevant_files! > base.allocations.relevant_files!);
  // The budget is redistributed, not reduced: the same total is still spent.
  const sum = (a: Record<string, number>): number => Object.values(a).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum(learned.allocations) - sum(base.allocations)) < 20);
});
