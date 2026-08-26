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

test('a failed task can be rolled back to the bytes it started from', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-undo-'));
  process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-undodata-'));
  const { Undo, revert } = await import('../../src/storage/undo.js');
  try {
    const target = path.join(repo, 'join.py');
    fs.writeFileSync(target, 'original\n');
    const created = path.join(repo, 'evict.py');

    // Two iterations of one task, plus an unrelated task that must survive.
    Undo.record(repo, 's1', 'task-a', 'iteration 1', [{ path: 'join.py', before: 'original\n' }]);
    fs.writeFileSync(target, 'attempt 1\n');
    Undo.record(repo, 's1', 'task-a', 'iteration 2', [
      { path: 'join.py', before: 'attempt 1\n' },
      { path: 'evict.py', before: null },
    ]);
    fs.writeFileSync(target, 'attempt 2\n');
    fs.writeFileSync(created, 'x = 1\n');
    Undo.record(repo, 's1', 'task-b', 'other work', [{ path: 'other.py', before: null }]);

    const records = Undo.forTask(repo, 'task-a');
    assert.equal(records.length, 2);
    // Newest first: reverting in order must end at the pre-task bytes, not the
    // intermediate ones.
    for (const rec of records) revert(repo, rec);

    assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
    assert.equal(fs.existsSync(created), false);
    assert.equal(Undo.forTask(repo, 'task-b').length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(process.env.CODEMASTER_DATA_DIR!, { recursive: true, force: true });
  }
});
