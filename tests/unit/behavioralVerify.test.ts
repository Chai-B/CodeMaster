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

test('behavioralVerify: no relevant tests and no repro → low-confidence pass', () => {
  const repo = mkRepo({ 'README.md': 'x' });
  const { verify, lastResults } = makeBehavioralVerify(repo, () => []);
  const r = verify() as { ok: boolean; output: string };
  assert.equal(r.ok, true);
  assert.match(r.output, /low confidence/i);
  assert.equal(lastResults()?.reproUsed, false);
});

test('behavioralVerify: a still-failing repro forces ok:false', () => {
  const repo = mkRepo({ 'README.md': 'x' });
  const fakeRepro = { path: '.cm_repro/t.py', run: () => ({ ok: false, output: 'AssertionError: alias not used' }), cleanup() {} };
  const { verify, lastResults } = makeBehavioralVerify(repo, () => [], {}, fakeRepro);
  const r = verify() as { ok: boolean; output: string };
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

test('behavioralVerify: a passing repro with no other tests → ok:true', () => {
  const repo = mkRepo({ 'README.md': 'x' });
  const fakeRepro = { path: '.cm_repro/t.py', run: () => ({ ok: true, output: '1 passed' }), cleanup() {} };
  const { verify } = makeBehavioralVerify(repo, () => [], {}, fakeRepro);
  const r = verify() as { ok: boolean };
  assert.equal(r.ok, true);
});
