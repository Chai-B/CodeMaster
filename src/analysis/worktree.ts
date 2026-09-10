// WorktreeManager — isolated git worktrees for concurrent worker execution (spec §12.4, Pillar 5).
// Allocates ephemeral git worktrees under .codemaster/worktrees/<task-id> so parallel
// tasks work on isolated working trees with zero cross-talk.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { isRepoRoot } from './git.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
  taskId: string;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function runGit(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

export const WorktreeManager = {
  /**
   * Create an isolated worktree for a task branching off HEAD.
   * Returns null if repo is not a git repository root.
   */
  async create(repoPath: string, taskId: string): Promise<WorktreeInfo | null> {
    if (!isRepoRoot(repoPath)) return null;

    const baseDir = path.join(repoPath, '.codemaster', 'worktrees');
    fs.mkdirSync(baseDir, { recursive: true });

    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const wtPath = path.join(baseDir, safeId);
    const branch = `cm-wt-${safeId}`;

    // Clean up if previous branch or dir exists
    if (fs.existsSync(wtPath)) {
      runGit(['worktree', 'remove', '--force', wtPath], repoPath);
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
    runGit(['branch', '-D', branch], repoPath);

    const addRes = runGit(['worktree', 'add', '-b', branch, wtPath, 'HEAD'], repoPath);
    if (addRes.status !== 0) {
      // If HEAD is unborn or branch creation fails, try without -b
      const fallback = runGit(['worktree', 'add', wtPath], repoPath);
      if (fallback.status !== 0) {
        return null;
      }
    }

    return {
      path: wtPath,
      branch,
      taskId,
    };
  },

  /**
   * Merge changes from an isolated worktree branch back into the active branch.
   */
  async merge(repoPath: string, taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!isRepoRoot(repoPath)) return { success: false, error: 'not a git repository root' };

    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const branch = `cm-wt-${safeId}`;

    const res = runGit(['merge', '--no-ff', branch, '-m', `Merge completed task ${taskId}`], repoPath);
    if (res.status !== 0) {
      // Abort failed merge to avoid leaving the tree in conflict state
      runGit(['merge', '--abort'], repoPath);
      return { success: false, error: res.stderr || 'git merge failed' };
    }

    return { success: true };
  },

  /**
   * Remove the ephemeral worktree and delete its branch.
   */
  async remove(repoPath: string, taskId: string): Promise<void> {
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const wtPath = path.join(repoPath, '.codemaster', 'worktrees', safeId);
    const branch = `cm-wt-${safeId}`;

    if (fs.existsSync(wtPath)) {
      runGit(['worktree', 'remove', '--force', wtPath], repoPath);
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
    runGit(['branch', '-D', branch], repoPath);
    runGit(['worktree', 'prune'], repoPath);
  },

  /**
   * List active worktrees for this repository.
   */
  async list(repoPath: string): Promise<WorktreeInfo[]> {
    if (!isRepoRoot(repoPath)) return [];
    const res = runGit(['worktree', 'list', '--porcelain'], repoPath);
    if (res.status !== 0) return [];

    const out: WorktreeInfo[] = [];
    const entries = res.stdout.split('\n\n');
    for (const entry of entries) {
      const lines = entry.split('\n');
      const worktreeLine = lines.find((l) => l.startsWith('worktree '));
      const branchLine = lines.find((l) => l.startsWith('branch '));
      if (worktreeLine) {
        const wtPath = worktreeLine.slice('worktree '.length).trim();
        if (wtPath.includes('.codemaster/worktrees')) {
          const taskId = path.basename(wtPath);
          const branch = branchLine ? branchLine.slice('branch '.length).trim() : '';
          out.push({ path: wtPath, branch, taskId });
        }
      }
    }
    return out;
  },

  /**
   * Clean up all ephemeral worktrees in .codemaster/worktrees/.
   */
  async cleanupAll(repoPath: string): Promise<void> {
    const baseDir = path.join(repoPath, '.codemaster', 'worktrees');
    if (!fs.existsSync(baseDir)) return;
    const entries = fs.readdirSync(baseDir);
    for (const entry of entries) {
      await WorktreeManager.remove(repoPath, entry);
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  },
};
