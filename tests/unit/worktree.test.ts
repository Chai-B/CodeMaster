import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { WorktreeManager } from '../../src/analysis/worktree.js';
import { readyTasks } from '../../src/workers/scheduler.js';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

test('readyTasks returns all tasks whose dependencies are met', () => {
  const tasks = [
    { id: 't1', status: 'completed', dependencies: [], order: 1 },
    { id: 't2', status: 'pending', dependencies: ['t1'], order: 2 },
    { id: 't3', status: 'pending', dependencies: ['t1'], order: 3 },
    { id: 't4', status: 'pending', dependencies: ['t2', 't3'], order: 4 },
  ];

  const ready = readyTasks(tasks);
  assert.equal(ready.length, 2);
  assert.deepEqual(ready.map((t) => t.id), ['t2', 't3']);
});

test('WorktreeManager creates, lists, and cleans up isolated worktrees in a git repo', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-test-'));

  // Initialize a real git repo in tmpDir
  spawnSync('git', ['init'], { cwd: tmpDir, env: GIT_ENV });
  spawnSync('git', ['config', 'user.name', 'Test Runner'], { cwd: tmpDir, env: GIT_ENV });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, env: GIT_ENV });

  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, env: GIT_ENV });
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpDir, env: GIT_ENV });

  // Create isolated worktree for task_1
  const wt = await WorktreeManager.create(tmpDir, 'task_1');
  assert.ok(wt !== null, 'Worktree should be created');
  assert.ok(fs.existsSync(wt.path), 'Worktree directory should exist');

  // Verify list
  const list = await WorktreeManager.list(tmpDir);
  assert.ok(list.some((w) => w.taskId === 'task_1'));

  // Commit change in worktree
  fs.writeFileSync(path.join(wt.path, 'task_1.txt'), 'done\n', 'utf8');
  spawnSync('git', ['add', '.'], { cwd: wt.path, env: GIT_ENV });
  spawnSync('git', ['commit', '-m', 'task 1 done'], { cwd: wt.path, env: GIT_ENV });

  // Merge back
  const mergeRes = await WorktreeManager.merge(tmpDir, 'task_1');
  assert.equal(mergeRes.success, true);
  assert.ok(fs.existsSync(path.join(tmpDir, 'task_1.txt')));

  // Remove worktree
  await WorktreeManager.remove(tmpDir, 'task_1');
  assert.ok(!fs.existsSync(wt.path), 'Worktree path should be removed');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
