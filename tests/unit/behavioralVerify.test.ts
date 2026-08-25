// Behavioral verification: framework detection, test discovery, and the compose
// logic of makeBehavioralVerify (spec §12.2/§14.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-bv-'));

const { detectFramework, frameworkForNewTest, typeOrImportCheck, runTests } = await import('../../src/analysis/testRunner.js');
const { makeBehavioralVerify } = await import('../../src/workers/verify/behavioralVerify.js');
const { rkgQuery } = await import('../../src/rkg/query.js');
const { getRepoDb } = await import('../../src/storage/db.js');

function mkRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

test('detectFramework identifies frameworks from marker files', () => {
  assert.equal(detectFramework(mkRepo({ 'pyproject.toml': '[tool.pytest]' })), 'pytest');
  assert.equal(detectFramework(mkRepo({ 'conftest.py': '' })), 'pytest');
  assert.equal(detectFramework(mkRepo({ 'go.mod': 'module x' })), 'gotest');
  assert.equal(detectFramework(mkRepo({ 'Cargo.toml': '[package]' })), 'cargo');
  assert.equal(detectFramework(mkRepo({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^1' } }) })), 'vitest');
  assert.equal(detectFramework(mkRepo({ 'package.json': JSON.stringify({ devDependencies: { jest: '^29' } }) })), 'jest');
  assert.equal(detectFramework(mkRepo({ 'README.md': 'x' })), 'unknown');
});

test('detectFramework finds tests with no marker file present', () => {
  // The benchmark repo: loose .py modules, no pyproject.toml. This returned
  // 'unknown', which silently disabled every deterministic check in the tool.
  assert.equal(detectFramework(mkRepo({ 'pkg/join.py': 'x = 1', 'pkg/test_join.py': 'def test_a(): pass' })), 'pytest');
  assert.equal(detectFramework(mkRepo({ 'src/thing.py': 'x = 1', 'src/thing_test.py': 'def test_a(): pass' })), 'pytest');
  assert.equal(detectFramework(mkRepo({ 'main.go': 'package main', 'main_test.go': 'package main' })), 'gotest');
  // A directory with source but genuinely no tests is still unknown.
  assert.equal(detectFramework(mkRepo({ 'pkg/join.py': 'x = 1' })), 'unknown');
});

test('a missing runner is reported as unverified, never as a pass', () => {
  const r = runTests(mkRepo({ 'README.md': 'x' }));
  assert.equal(r.ran, false);
  assert.equal(r.ok, false, 'no framework must not read as a passing suite');
  assert.match(r.skipReason ?? '', /no test framework/);
});

test('typeOrImportCheck skips when no ts/py files changed', () => {
  const r = typeOrImportCheck(mkRepo({ 'a.go': 'package a' }), ['a.go']);
  assert.equal(r.ran, false);
  assert.equal(r.ok, true);
});

test('typeOrImportCheck: import gate catches unresolvable imports (valid syntax)', () => {
  const repo = mkRepo({ 'pkg/__init__.py': '', 'pkg/mod.py': 'import pkg.does_not_exist\n' });
  const r = typeOrImportCheck(repo, ['pkg/mod.py']);
  if (r.ran) { assert.equal(r.ok, false); assert.match(r.output, /No module named/); }
});

test('typeOrImportCheck: a clean importable module passes the import gate', () => {
  const repo = mkRepo({ 'pkg/__init__.py': '', 'pkg/mod.py': 'X = 1\n' });
  const r = typeOrImportCheck(repo, ['pkg/mod.py']);
  if (r.ran) assert.equal(r.ok, true);
});

test('typeOrImportCheck: a missing top-level package is an env skip, not a failure', () => {
  const repo = mkRepo({ 'pkg/__init__.py': 'import totally_absent_third_party\n' });
  const r = typeOrImportCheck(repo, ['pkg/__init__.py']);
  if (r.ran) assert.equal(r.ok, true); // ModuleNotFoundError on a sibling top pkg → non-blocking
});

test('behavioralVerify: no relevant tests and no repro → low-confidence pass', async () => {
  const repo = mkRepo({ 'README.md': 'x' });
  const { verify, lastResults } = makeBehavioralVerify(repo, () => []);
  const r = (await verify()) as { ok: boolean; output: string; confident?: boolean };
  assert.equal(r.ok, true);
  // The work stands, but nothing exercised it — `verified` must not claim it did.
  assert.equal(r.confident, false);
  assert.match(r.output, /no relevant existing tests/i);
  assert.equal(lastResults()?.reproUsed, false);
});

test('behavioralVerify: a still-failing repro forces ok:false', async () => {
  const repo = mkRepo({ 'README.md': 'x' });
  const fakeRepro = { path: '.cm_repro/t.py', run: () => ({ ok: false, output: 'AssertionError: alias not used' }), cleanup() {} };
  const { verify, lastResults } = makeBehavioralVerify(repo, () => [], {}, fakeRepro);
  const r = (await verify()) as { ok: boolean; output: string };
  assert.equal(r.ok, false);
  assert.match(r.output, /reproduction test/i);
  assert.equal(lastResults()?.reproUsed, true);
});

test('RKGQuery.testsFor returns test files by reverse tests-edge', () => {
  const repo = mkRepo({ 'src/foo.ts': 'export const x=1;' });
  const db = getRepoDb(repo);
  db.prepare('INSERT INTO rkg_edges (id, type, from_ref, to_ref, data_json) VALUES (?,?,?,?,?)')
    .run('e1', 'tests', 'file:tests/foo.test.ts', 'file:src/foo.ts', null);
  const hits = rkgQuery(repo).testsFor('src/foo.ts');
  assert.deepEqual(hits, ['tests/foo.test.ts']);
  assert.deepEqual(rkgQuery(repo).testsFor('src/other.ts'), []);
});

test('behavioralVerify: a passing repro with no other tests → ok:true', async () => {
  const repo = mkRepo({ 'README.md': 'x' });
  const fakeRepro = { path: '.cm_repro/t.py', run: () => ({ ok: true, output: '1 passed' }), cleanup() {} };
  const { verify } = makeBehavioralVerify(repo, () => [], {}, fakeRepro);
  const r = (await verify()) as { ok: boolean };
  assert.equal(r.ok, true);
});

test('a green suite that never touched the named files is not a verification', async () => {
  const repo = mkRepo({ 'other.py': 'X = 1\n' });
  const { verify } = makeBehavioralVerify(repo, () => ['other.py'], {}, null, ['target.py']);
  const r = (await verify()) as { ok: boolean; confident?: boolean };
  assert.equal(r.ok, true);
  assert.equal(r.confident, false);
});

// ── Use-site coverage gate ──────────────────────────────────
// A changed signature whose callers were never opened is broken code that a
// green suite cannot see. Deterministic; no LLM involved.

const { unvisitedUseSites } = await import('../../src/analysis/useSites.js');

/** Seeds the index the way a pre-patch reindex would have: the OLD signature
 *  for the definition, plus the call edge and the import that proves the
 *  caller really depends on it. */
function seedIndex(repo: string, opts: { def: string; oldSig: string; caller: string; callerFn: string; imports?: string[] }): void {
  const db = getRepoDb(repo);
  const insFile = db.prepare('INSERT INTO file_index (path, language, exports_json, imports_json) VALUES (?,?,?,?)');
  insFile.run(opts.def, 'python', JSON.stringify(['charge']), JSON.stringify([]));
  insFile.run(opts.caller, 'python', JSON.stringify([]), JSON.stringify(opts.imports ?? []));
  db.prepare('INSERT INTO symbols (id, name, kind, file_path, line_start, signature, is_exported) VALUES (?,?,?,?,?,?,1)')
    .run(`${opts.def}:charge`, 'charge', 'function', opts.def, 1, opts.oldSig);
  db.prepare('INSERT INTO calls (id, caller, callee, file_path, line) VALUES (?,?,?,?,?)')
    .run('c1', opts.callerFn, 'charge', opts.caller, 2);
}

test('use sites: a changed signature with an unopened caller is reported', async () => {
  const repo = mkRepo({
    'billing.py': 'def charge(user, amount, currency):\n    return amount\n',
    'checkout.py': 'from billing import charge\n\ndef pay(u):\n    return charge(u, 10)\n',
  });
  seedIndex(repo, { def: 'billing.py', oldSig: 'def charge(user, amount):', caller: 'checkout.py', callerFn: 'pay', imports: ['billing'] });

  const gaps = await unvisitedUseSites(repo, ['billing.py']);
  assert.deepEqual(gaps, [{ symbol: 'charge', definedIn: 'billing.py', usedIn: ['checkout.py'] }]);
});

test('use sites: a body-only edit keeps the signature and reports nothing', async () => {
  const repo = mkRepo({
    'billing.py': 'def charge(user, amount):\n    return amount * 2\n',
    'checkout.py': 'from billing import charge\n\ndef pay(u):\n    return charge(u, 10)\n',
  });
  seedIndex(repo, { def: 'billing.py', oldSig: 'def charge(user, amount):', caller: 'checkout.py', callerFn: 'pay', imports: ['billing'] });

  assert.deepEqual(await unvisitedUseSites(repo, ['billing.py']), []);
});

test('use sites: a caller the patch already opened is not a gap', async () => {
  const repo = mkRepo({
    'billing.py': 'def charge(user, amount, currency):\n    return amount\n',
    'checkout.py': 'from billing import charge\n\ndef pay(u):\n    return charge(u, 10, "usd")\n',
  });
  seedIndex(repo, { def: 'billing.py', oldSig: 'def charge(user, amount):', caller: 'checkout.py', callerFn: 'pay', imports: ['billing'] });

  assert.deepEqual(await unvisitedUseSites(repo, ['billing.py', 'checkout.py']), []);
});

test('use sites: a same-named function in an unrelated file is not a caller', async () => {
  const repo = mkRepo({
    'billing.py': 'def charge(user, amount, currency):\n    return amount\n',
    'unrelated.py': 'def pay(u):\n    return charge(u, 10)\n',
  });
  // No import edge from unrelated.py, so it is not a dependent of billing.py.
  seedIndex(repo, { def: 'billing.py', oldSig: 'def charge(user, amount):', caller: 'unrelated.py', callerFn: 'pay' });

  assert.deepEqual(await unvisitedUseSites(repo, ['billing.py']), []);
});

test('use sites: an unindexed repository yields no gaps rather than guesses', async () => {
  const repo = mkRepo({ 'billing.py': 'def charge(user, amount, currency):\n    return amount\n' });
  assert.deepEqual(await unvisitedUseSites(repo, ['billing.py']), []);
});

test('behavioralVerify: the use-site gate fails the run and names the callers', async () => {
  const repo = mkRepo({
    'billing.py': 'def charge(user, amount, currency):\n    return amount\n',
    'checkout.py': 'from billing import charge\n\ndef pay(u):\n    return charge(u, 10)\n',
  });
  seedIndex(repo, { def: 'billing.py', oldSig: 'def charge(user, amount):', caller: 'checkout.py', callerFn: 'pay', imports: ['billing'] });

  const { verify, lastResults } = makeBehavioralVerify(repo, () => ['billing.py']);
  const r = (await verify()) as { ok: boolean; output: string };
  assert.equal(r.ok, false);
  assert.match(r.output, /checkout\.py/);
  assert.equal(lastResults()?.framework, 'use-sites');
});

// A repo with no tests at all has no oracle — but it can be GIVEN one, and
// refusing to name a framework is what stopped the repro generator before it
// ever reached a model. This is the exact shape of the benchmark repo.
test('a test-less python repo still names a framework a new test could use', () => {
  const dir = mkRepo({
    'streamjoin/__init__.py': '',
    'streamjoin/join.py': 'def join(a, b):\n    return []\n',
    'streamjoin/pairing.py': 'def pair(x):\n    return x\n',
  });
  assert.equal(detectFramework(dir), 'unknown', 'there is genuinely no oracle here');
  assert.equal(frameworkForNewTest(dir), 'pytest', 'but one could be written');
});

test('a repo of nothing recognisable names no framework', () => {
  const dir = mkRepo({ 'README.md': '# hi\n', 'data.csv': 'a,b\n1,2\n' });
  assert.equal(frameworkForNewTest(dir), 'unknown');
});

// The repro admission gate. Rejecting a valid repro is not a safe default: it
// removes the only sound oracle in the system and the run reports `unverified`.
const { isGenuineFailure, importSurface } = await import('../../src/workers/verify/reproGenerator.js');

test('an assertion failure is admitted even though "AssertionError" contains "error"', () => {
  const out = [
    'E       AssertionError: State not bounded (old events not evicted)',
    'streamjoin/join.py:31: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED repro/test_cm_repro.py::test_bounded - AssertionError: State not bounded',
    '1 failed in 0.04s',
  ].join('\n');
  assert.equal(isGenuineFailure('pytest', 1, out), true);
});

test('a test that blew up on its own bad import is not a captured bug', () => {
  const out = 'ImportError: cannot import name \'Event\' from \'streamjoin.join\'\n1 failed in 0.02s';
  assert.equal(isGenuineFailure('pytest', 1, out), false);
});

test('a collection error and a pass are both refused', () => {
  assert.equal(isGenuineFailure('pytest', 2, 'ERROR collecting repro/test_cm_repro.py'), false);
  assert.equal(isGenuineFailure('pytest', 0, '1 passed in 0.01s'), false);
});

test('a small module is sent whole, so constructor constraints are visible', () => {
  const repo = mkRepo({
    'pkg/__init__.py': '',
    'pkg/join.py': 'class StreamJoin:\n    def __init__(self, lower, upper, lateness):\n        self._a = []\n\n    def feed_a(self, event):\n        pass\n\n    def _evict(self):\n        pass\n',
    'pkg/pairing.py': 'class Event:\n    def __init__(self, key, timestamp):\n        pass\n\n\ndef matches(a, b):\n    return True\n',
    'test_ignored.py': 'def test_x():\n    pass\n',
  });
  const s = importSurface(repo, 'pytest');
  assert.match(s, /pkg\/join\.py/);
  assert.match(s, /def __init__\(self, lower, upper, lateness\)/);
  assert.match(s, /def feed_a\(self, event\)/);
  assert.match(s, /pkg\/pairing\.py/);
  assert.match(s, /def matches\(a, b\)/);
  // The body, not just the signature: three benchmark attempts died guessing
  // attribute names and input types that only the body shows.
  assert.match(s, /self\._a = \[\]/);
  assert.doesNotMatch(s, /test_ignored/);
});

test('a module too large to send whole falls back to an outline', () => {
  const big =
    'class Big:\n    def __init__(self, a):\n        self._x = a\n\n' +
    Array.from({ length: 400 }, (_, i) => `    def m${i}(self, v):\n        return v\n`).join('\n');
  const repo = mkRepo({ 'pkg/__init__.py': '', 'pkg/big.py': big });
  const s = importSurface(repo, 'pytest');
  assert.match(s, /# module pkg\.big/);
  assert.match(s, /def __init__\(self, a\)/);
});

test('a relative python import names the submodule, not the package __init__', async () => {
  const { extract } = await import('../../src/analysis/extractors.js');
  const src = ['from . import pairing', 'from .window import Slice as S', 'import os', 'from typing import List, Dict'].join('\n');
  const imports = extract(src, 'python').imports;
  assert.ok(imports.includes('.pairing'), `expected .pairing, got ${JSON.stringify(imports)}`);
  assert.ok(imports.includes('.window'));
  assert.ok(imports.includes('os'));
  assert.ok(imports.includes('typing'));
  // `.` alone would resolve to the package __init__ and lose the real edge.
  assert.ok(!imports.includes('.'), 'bare "." means the submodule was dropped');
});
