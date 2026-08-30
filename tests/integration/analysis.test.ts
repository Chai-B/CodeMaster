import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StaticAnalysisAPI } from '../../src/analysis/api.js';
import { structuralAnswer } from '../../src/workers/asker.js';

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

// A structural question is a lookup the index has already done. Answering it
// from a model costs a context compilation and a call to read back rows that
// are sitting in a table — so the shapes below must never reach one, and every
// other shape must still fall through rather than answer from a guess.
test('the index answers structural questions with no model call', () => {
  const def = structuralAnswer(api, 'where is alpha defined?');
  assert.ok(def?.includes('a.ts:'), `expected a.ts location, got ${def}`);

  const callers = structuralAnswer(api, 'who calls beta?');
  assert.ok(callers?.includes('alpha'), `expected alpha as a caller, got ${callers}`);

  const dependents = structuralAnswer(api, 'what imports a.ts?');
  assert.ok(dependents?.includes('b.ts'), `expected b.ts, got ${dependents}`);

  const deps = structuralAnswer(api, 'what does b.ts import?');
  assert.ok(deps?.includes('a.ts'), `expected a.ts, got ${deps}`);
});

test('anything the index cannot resolve exactly falls through to the model', () => {
  // Not a lookup shape at all.
  assert.equal(structuralAnswer(api, 'why is alpha written this way?'), null);
  // Lookup shape, but the subject is not indexed.
  assert.equal(structuralAnswer(api, 'where is nonexistentSymbol defined?'), null);
  // Two known symbols means a sentence, not a lookup.
  assert.equal(structuralAnswer(api, 'where are alpha and beta defined?'), null);
  // Known shape, unknown file.
  assert.equal(structuralAnswer(api, 'what imports nowhere.ts?'), null);
});
