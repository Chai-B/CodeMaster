// GitWorker — deterministic temporal/authorship context (spec §5.2.6, §12.2).

import { simpleGit, type SimpleGit } from 'simple-git';
import { spawnSync } from 'child_process';
import fs from 'fs';

export interface ChangedFile {
  path: string;
  status: string;
}

/**
 * True only when `dir` is itself the top of a git work tree.
 *
 * `checkIsRepo()` — and a bare `git status` — answer "is this path INSIDE a
 * work tree", so a plain directory under a repository inherits it. A run in
 * `~/Desktop/test` with `~` under version control read the whole home
 * repository: `git status` returned its dirty files, with paths relative to
 * `~`, and the crash guard then failed on files that do not exist relative to
 * the working directory. The working directory is the boundary; nothing above
 * it is ours to read.
 */
export function isRepoRoot(dir: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) return false;
  const top = (r.stdout ?? '').trim();
  if (!top) return false;
  try {
    return fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

export class GitWorker {
  private git: SimpleGit;
  constructor(public readonly repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  /** Every read below runs git with `cwd = repoPath`, and git walks up. Unless
   *  this directory is itself the top of a work tree, the answer would describe
   *  somebody else's repository, so each method returns its empty value instead.
   *  `--json` output once carried a 16MB diff of the user's home repo this way. */
  private owned: boolean | null = null;
  private get owns(): boolean {
    return (this.owned ??= isRepoRoot(this.repoPath));
  }

  async isRepo(): Promise<boolean> {
    return this.owns;
  }

  async headCommit(): Promise<string> {
    if (!this.owns) return 'uncommitted';
    try {
      return (await this.git.revparse(['HEAD'])).trim();
    } catch {
      return 'uncommitted';
    }
  }

  async branch(): Promise<string> {
    if (!this.owns) return 'unknown';
    try {
      return (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    } catch {
      return 'unknown';
    }
  }

  async changedFilesSince(ref: string): Promise<ChangedFile[]> {
    if (!this.owns) return [];
    try {
      const out = await this.git.raw(['diff', '--name-status', ref]);
      return out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [status, ...rest] = l.split('\t');
          return { status: status ?? '?', path: rest.join('\t') };
        });
    } catch {
      return [];
    }
  }

  async diffSince(ref: string): Promise<string> {
    if (!this.owns) return '';
    try {
      return await this.git.diff([ref]);
    } catch {
      return '';
    }
  }

  /**
   * Working-tree diff *including untracked files*. Plain `git diff` reports only
   * modifications to tracked files, so a task whose entire output is new files
   * produced an empty diff — and the verifier then reported that a file which
   * exists on disk had never been created, costing a needless correction round.
   */
  fullWorkingDiff(): string {
    if (!this.owns) return '';
    const run = (args: string[]): string => {
      // `diff --no-index` exits 1 when the files differ, so read stdout rather
      // than gating on the status code.
      const r = spawnSync('git', args, { cwd: this.repoPath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return r.stdout ?? '';
    };
    const empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean)
      .map((f) => run(['diff', '--no-index', '--', empty, f]))
      .join('');
    return run(['diff', 'HEAD']) + untracked;
  }

  async workingDiff(): Promise<string> {
    if (!this.owns) return '';
    try {
      return await this.git.diff();
    } catch {
      return '';
    }
  }

  async status(): Promise<{ modified: string[]; created: string[]; deleted: string[]; staged: string[] }> {
    if (!this.owns) return { modified: [], created: [], deleted: [], staged: [] };
    try {
      const s = await this.git.status();
      return {
        modified: s.modified,
        created: s.not_added.concat(s.created),
        deleted: s.deleted,
        staged: s.staged,
      };
    } catch {
      return { modified: [], created: [], deleted: [], staged: [] };
    }
  }

  async log(file: string | undefined, n: number): Promise<Array<{ hash: string; message: string; date: string }>> {
    if (!this.owns) return [];
    try {
      const opts: string[] = ['--max-count', String(n)];
      if (file) opts.push('--', file);
      const res = await this.git.log(opts);
      return res.all.map((c) => ({ hash: c.hash.slice(0, 8), message: c.message, date: c.date }));
    } catch {
      return [];
    }
  }

  async blame(file: string): Promise<string> {
    if (!this.owns) return '';
    try {
      return await this.git.raw(['blame', '--line-porcelain', file]);
    } catch {
      return '';
    }
  }

  /** Files frequently changed together with the given file (git proximity, spec §10.3 step 4). */
  async coChangedFiles(file: string, n = 20): Promise<string[]> {
    if (!this.owns) return [];
    try {
      const out = await this.git.raw(['log', '--max-count', String(n), '--name-only', '--pretty=format:', '--', file]);
      const counts = new Map<string, number>();
      for (const line of out.split('\n')) {
        const p = line.trim();
        if (p && p !== file) counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    } catch {
      return [];
    }
  }

  async createCheckpointPatch(sinceRef: string): Promise<string> {
    if (!this.owns) return '';
    try {
      return await this.git.diff([sinceRef]);
    } catch {
      return '';
    }
  }

  /** Structured diff between two states (spec §5.2.6 diff(commit_a, commit_b)). */
  async diffBetween(a: string, b: string): Promise<string> {
    if (!this.owns) return '';
    try {
      return await this.git.diff([`${a}..${b}`]);
    } catch {
      return '';
    }
  }

  /** Available stash entries (spec §5.2.6 stash_list). */
  async stashList(): Promise<string[]> {
    if (!this.owns) return [];
    try {
      const out = await this.git.raw(['stash', 'list']);
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Current branch + ahead/behind remote (spec §5.2.6 branch_status). */
  async branchStatus(): Promise<{ branch: string; ahead: number; behind: number; tracking: string | null }> {
    if (!this.owns) return { branch: 'unknown', ahead: 0, behind: 0, tracking: null };
    try {
      const s = await this.git.status();
      return { branch: s.current ?? 'unknown', ahead: s.ahead, behind: s.behind, tracking: s.tracking ?? null };
    } catch {
      return { branch: 'unknown', ahead: 0, behind: 0, tracking: null };
    }
  }
}
