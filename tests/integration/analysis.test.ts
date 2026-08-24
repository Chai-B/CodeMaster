import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StaticAnalysisAPI } from '../../src/analysis/api.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tiny-ts');
const api = new StaticAnalysisAPI(FIXTURE);

before(async () => {
  await api.reindex({ embed: false });
});

after(() => {
  fs.rmSync(path.join(FIXTURE, '.codemaster'), { recursive: true, force: true });
});

test('indexes symbols via tree-sitter', () => {
  const stats = api.stats();
  assert.ok(stats);
  assert.ok(stats!.symbols >= 6, `expected >=6 symbols, got ${stats!.symbols}`);
  assert.ok(api.findDefinition('alpha').length >= 1);
});

test('resolves dependency edges', () => {
  const deps = api.getDependencies('b.ts');
  assert.deepEqual(deps, ['a.ts']);
  assert.deepEqual(api.getDependents('a.ts'), ['b.ts']);
});

test('detects dependency cycle between c and d', () => {
  const cycles = api.getCycles();
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0]!.files.sort(), ['c.ts', 'd.ts']);
});

test('builds call graph edges', () => {
  const callees = api.getCallees('alpha').map((c) => c.name);
  assert.ok(callees.includes('beta'), `alpha should call beta, got ${callees}`);
  assert.ok(api.getCallers('alpha').some((c) => c.name === 'useAlpha'));
});

test('flags dead-code candidates', () => {
  const dead = api.getDeadCode().map((d) => d.name);
  assert.ok(dead.includes('orphan'), `orphan should be dead code, got ${dead}`);
});

test('populates the RKG', () => {
  const s = api.rkg().stats();
  assert.ok(s.nodes > 0 && s.edges > 0);
  assert.ok((s.byType.file ?? 0) >= 4);
});
