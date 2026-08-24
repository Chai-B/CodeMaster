// Checkpoint records (spec §14). Heavy artifacts live on disk; this indexes them.

import { getDb } from './db.js';
import type { CheckpointManifest } from '../types/index.js';

export const Checkpoints = {
  insert(m: CheckpointManifest, diskPath: string, sizeBytes = 0): void {
    getDb()
      .prepare(
        `INSERT INTO checkpoints
           (id, session_id, created_at, trigger, git_commit, repository_path,
            storage_path, size_bytes, tasks_completed, tasks_remaining, manifest_json, path)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.id, m.session_id, m.created_at, m.trigger, m.repository_commit ?? null,
        m.repository_path ?? null, diskPath, sizeBytes,
        m.tasks_completed ?? null, m.tasks_remaining ?? null, JSON.stringify(m), diskPath,
      );
  },

  forSession(sessionId: string): Array<CheckpointManifest & { path: string }> {
    const rows = getDb()
      .prepare('SELECT manifest_json, path FROM checkpoints WHERE session_id=? ORDER BY created_at DESC')
      .all(sessionId) as { manifest_json: string; path: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.manifest_json) as CheckpointManifest), path: r.path }));
  },

  latest(sessionId: string): (CheckpointManifest & { path: string }) | null {
    const r = getDb()
      .prepare('SELECT manifest_json, path FROM checkpoints WHERE session_id=? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as { manifest_json: string; path: string } | undefined;
    return r ? { ...(JSON.parse(r.manifest_json) as CheckpointManifest), path: r.path } : null;
  },

  /** Drop the oldest snapshots beyond `keep`, returning their disk paths so the
   *  caller can remove the artifacts. `max_checkpoints_per_session` was inert,
   *  so a long session accumulated a full snapshot every interval forever. */
  prune(sessionId: string, keep: number): string[] {
    const rows = getDb()
      .prepare('SELECT id, path FROM checkpoints WHERE session_id=? ORDER BY created_at DESC')
      .all(sessionId) as { id: string; path: string }[];
    const stale = rows.slice(Math.max(1, keep));
    for (const r of stale) getDb().prepare('DELETE FROM checkpoints WHERE id=?').run(r.id);
    return stale.map((r) => r.path);
  },

  get(idVal: string): (CheckpointManifest & { path: string }) | null {
    const r = getDb()
      .prepare('SELECT manifest_json, path FROM checkpoints WHERE id=?')
      .get(idVal) as { manifest_json: string; path: string } | undefined;
    return r ? { ...(JSON.parse(r.manifest_json) as CheckpointManifest), path: r.path } : null;
  },
};
