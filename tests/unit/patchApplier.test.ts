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
    assert.equal(fs.readFileSync(path.join(repo, 'src/ok.txt'), 'utf8'), 'ok');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
