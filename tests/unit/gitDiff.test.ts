// Regression: `git diff` alone hides untracked files, so a task whose entire
// output was new files handed the verifier an empty diff and got told the file
// it had just written did not exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { GitWorker } from '../../src/analysis/git.js';

test('fullWorkingDiff includes untracked files and tracked edits', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '.');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'created.txt'), 'hello world\n');

  const diff = new GitWorker(repo).fullWorkingDiff();
  assert.match(diff, /tracked\.txt/);
  assert.match(diff, /created\.txt/);
  assert.match(diff, /hello world/);

  fs.rmSync(repo, { recursive: true, force: true });
});
