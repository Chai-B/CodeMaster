import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSmokeSuite } from '../../src/bench/smoke.js';
import { runSmokeBenchmark, formatBenchmarkReport } from '../../src/bench/runner.js';

test('createSmokeSuite defines test cases across 5 fixtures', () => {
  const suite = createSmokeSuite();
  assert.ok(suite.length >= 5, 'Should have at least 5 benchmark cases');
  const repos = new Set(suite.map((c) => c.repo));
  assert.ok(repos.has('tiny-ts'));
  assert.ok(repos.has('small-python'));
  assert.ok(repos.has('legacy-codebase'));
  assert.ok(repos.has('medium-monorepo'));
  assert.ok(repos.has('react-tsx'));
});

test('runSmokeBenchmark computes pass@1 and valid metrics', async () => {
  const report = await runSmokeBenchmark();
  assert.ok(report.totalCases >= 5);
  assert.equal(report.failedCases, 0, 'All smoke benchmark cases should pass');
  assert.equal(report.passAt1, 100);
  assert.ok(report.avgApplyRate >= 90);

  const formatted = formatBenchmarkReport(report);
  assert.ok(formatted.includes('CODEMASTER EVALUATION HARNESS'));
  assert.ok(formatted.includes('pass@1'));
});
