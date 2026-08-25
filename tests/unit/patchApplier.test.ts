import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyPatches } from '../../src/workers/patchApplier.js';

test('new files outside the repository are refused, not written', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-apply-'));
  const outside = path.join(os.tmpdir(), `cm-escape-${process.pid}.txt`);
  try {
    const res = applyPatches(repo, [], [
      { path: 'src/ok.txt', content: 'ok' },
      { path: '../escape.txt', content: 'bad' },
      { path: outside, content: 'bad' },
    ]);

    assert.deepEqual(res.created, ['src/ok.txt']);
    assert.equal(res.failed.length, 2);
    assert.ok(res.failed.every((f) => /outside the repository/.test(f.reason)));
    assert.ok(!fs.existsSync(path.join(repo, '..', 'escape.txt')));
    assert.ok(!fs.existsSync(outside));
    assert.equal(fs.readFileSync(path.join(repo, 'src/ok.txt'), 'utf8'), 'ok\n');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('a task may not rewrite the oracle that judges it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-policy-'));
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests/test_join.py'), 'def test_real(): assert False\n');
  fs.writeFileSync(path.join(repo, 'conftest.py'), '# fixtures\n');
  try {
    const res = applyPatches(repo, [], [
      { path: 'tests/test_join.py', content: 'def test_real(): assert True' },
      { path: 'conftest.py', content: 'collect_ignore = ["tests"]' },
      { path: 'src/fix.py', content: 'x = 1' },
    ], { isTestTask: false });

    assert.deepEqual(res.created, ['src/fix.py']);
    assert.equal(res.failed.length, 2);
    // The originals must survive untouched.
    assert.match(fs.readFileSync(path.join(repo, 'tests/test_join.py'), 'utf8'), /assert False/);
    assert.match(fs.readFileSync(path.join(repo, 'conftest.py'), 'utf8'), /# fixtures/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a test task may write tests, and a named config file is still allowed', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-policy2-'));
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests/test_join.py'), 'old\n');
  fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\n');
  try {
    const res = applyPatches(repo, [], [
      { path: 'tests/test_join.py', content: 'def test_new(): pass' },
      { path: 'pyproject.toml', content: '[project]\nname = "x"' },
    ], { isTestTask: true, locus: ['pyproject.toml'] });

    assert.equal(res.failed.length, 0);
    assert.equal(res.created.length, 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
