// Behavioral verification: framework detection, test discovery, and the compose
// logic of makeBehavioralVerify (spec §12.2/§14.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-bv-'));

const { detectFramework, typeOrImportCheck } = await import('../../src/analysis/testRunner.js');
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
