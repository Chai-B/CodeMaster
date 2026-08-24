import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_PROFILES, profileForTask, resolveBudget } from '../../src/context/budget.js';

test('every budget profile sums to ~1.0', () => {
  for (const [name, profile] of Object.entries(BUDGET_PROFILES)) {
    const sum = Object.values(profile).reduce((a, v) => a + (v ?? 0), 0);
    assert.ok(Math.abs(sum - 1) < 0.011, `${name} sums to ${sum}`);
  }
});

test('task types map to expected profiles', () => {
  assert.equal(profileForTask('plan'), 'planning');
  assert.equal(profileForTask('implement'), 'implementation');
  assert.equal(profileForTask('debug'), 'debugging');
  assert.equal(profileForTask('refactor'), 'refactoring');
  assert.equal(profileForTask('test'), 'testing');
  assert.equal(profileForTask('review'), 'review');
});

test('resolveBudget reserves overhead and allocates by percentage', () => {
  const { profileName, allocations } = resolveBudget('implement', 200_000);
  assert.equal(profileName, 'implementation');
  // relevant_files is the largest implementation bucket (45% of 88% usable)
  assert.ok(allocations.relevant_files! > allocations.objective!);
  const total = Object.values(allocations).reduce((a, v) => a + v, 0);
  assert.ok(total <= 200_000 * 0.88 + 10);
});
