// Learning loop (spec §7 phase 5). Records what actually happened and turns it
// into two decisions: which files the selector should stop paying for, and
// which escalation tier a task type should start on.
//
// Everything here is derived from observed outcomes. There are no priors and no
// scores — a file that has never been included has no opinion attached to it,
// and a task type with too few samples starts where it always did.

import { getRepoDb } from '../storage/db.js';
import { now } from '../util/id.js';

/** Below this many observations a rate is noise, not a signal. */
const MIN_SAMPLES = 4;

export interface FileUtility {
  path: string;
  included: number;
  referenced: number;
  rate: number;
}

export const Learning = {
  /** One observation per file the compiler included, and whether the response
   *  actually mentioned it. */
  recordSelection(repoPath: string, included: string[], referenced: Set<string>): void {
    const db = getRepoDb(repoPath);
    const stmt = db.prepare(
      `INSERT INTO file_utility (path, included, referenced, updated_at) VALUES (?,1,?,?)
       ON CONFLICT(path) DO UPDATE SET included=included+1, referenced=referenced+excluded.referenced, updated_at=excluded.updated_at`,
    );
    for (const p of included) stmt.run(p, referenced.has(p) ? 1 : 0, now());
  },

  /** The tier a task finished on, and whether that finish was a real verification. */
  recordTier(repoPath: string, taskType: string, tier: number, verified: boolean): void {
    getRepoDb(repoPath)
      .prepare(
        `INSERT INTO tier_outcomes (task_type, tier, verified, count) VALUES (?,?,?,1)
         ON CONFLICT(task_type, tier, verified) DO UPDATE SET count=count+1`,
      )
      .run(taskType, tier, verified ? 1 : 0);
  },

  /**
   * Multiplier for a file's selection score. A file included repeatedly and
   * referenced by nothing is costing tokens for no reasoning, so it is ranked
   * down — never to zero, because the next task may be the one that needs it.
   */
  utility(repoPath: string, path: string): number {
    const r = getRepoDb(repoPath)
      .prepare('SELECT included, referenced FROM file_utility WHERE path=?')
      .get(path) as { included: number; referenced: number } | undefined;
    if (!r || r.included < MIN_SAMPLES) return 1;
    return 0.5 + 0.5 * (r.referenced / r.included);
  },

  /**
   * Tier a task type should start on: the lowest tier that has ever produced a
   * verified result here. When nothing has verified, or the samples are too
   * thin, start at the bottom as before.
   */
  startTier(repoPath: string, taskType: string): number {
    const rows = getRepoDb(repoPath)
      .prepare('SELECT tier, verified, count FROM tier_outcomes WHERE task_type=?')
      .all(taskType) as Array<{ tier: number; verified: number; count: number }>;
    const total = rows.reduce((a, r) => a + r.count, 0);
    if (total < MIN_SAMPLES) return 0;
    const wins = rows.filter((r) => r.verified === 1).map((r) => r.tier);
    return wins.length ? Math.min(...wins) : 0;
  },

  /** What has been learned, worst-value first — the /learn report. */
  report(repoPath: string): {
    files: FileUtility[];
    tiers: Array<{ task_type: string; tier: number; verified: number; count: number }>;
  } {
    const db = getRepoDb(repoPath);
    const files = (
      db
        .prepare(
          `SELECT path, included, referenced FROM file_utility WHERE included >= ?
           ORDER BY (CAST(referenced AS REAL)/included) ASC, included DESC LIMIT 20`,
        )
        .all(MIN_SAMPLES) as Array<{ path: string; included: number; referenced: number }>
    ).map((r) => ({ ...r, rate: r.referenced / r.included }));
    const tiers = db
      .prepare('SELECT task_type, tier, verified, count FROM tier_outcomes ORDER BY task_type, tier')
      .all() as Array<{ task_type: string; tier: number; verified: number; count: number }>;
    return { files, tiers };
  },
};
