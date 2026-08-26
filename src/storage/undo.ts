// Undo journal. Every run that writes to the tree records what each file held
// beforehand, so a change can be taken back exactly — without `git checkout`,
// which would also discard edits the tool never made.

import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { now } from '../util/id.js';

export interface UndoEntry {
  path: string;
  before: string | null;
}

export interface UndoRecord {
  id: number;
  repo_path: string;
  session_id: string | null;
  task_id: string | null;
  created_at: string;
  summary: string | null;
  entries: UndoEntry[];
}

interface Row {
  id: number;
  repo_path: string;
  session_id: string | null;
  task_id: string | null;
  created_at: string;
  summary: string | null;
  entries_json: string;
}

const hydrate = (r: Row): UndoRecord => ({ ...r, entries: JSON.parse(r.entries_json) as UndoEntry[] });

export const Undo = {
  record(repoPath: string, sessionId: string | null, taskId: string | null, summary: string, entries: UndoEntry[]): void {
    if (!entries.length) return;
    getDb()
      .prepare('INSERT INTO undo_journal (repo_path, session_id, task_id, created_at, summary, entries_json) VALUES (?,?,?,?,?,?)')
      .run(repoPath, sessionId, taskId, now(), summary, JSON.stringify(entries));
  },

  latest(repoPath: string): UndoRecord | null {
    const r = getDb()
      .prepare('SELECT * FROM undo_journal WHERE repo_path=? ORDER BY id DESC LIMIT 1')
      .get(repoPath) as unknown as Row | undefined;
    return r ? hydrate(r) : null;
  },

  list(repoPath: string, limit = 10): UndoRecord[] {
    return (
      getDb().prepare('SELECT * FROM undo_journal WHERE repo_path=? ORDER BY id DESC LIMIT ?').all(repoPath, limit) as unknown as Row[]
    ).map(hydrate);
  },

  /** Newest first, so a caller reverting them in order ends at the state the
   *  task started from — the oldest record holds the true pre-task bytes. */
  forTask(repoPath: string, taskId: string): UndoRecord[] {
    return (
      getDb()
        .prepare('SELECT * FROM undo_journal WHERE repo_path=? AND task_id=? ORDER BY id DESC')
        .all(repoPath, taskId) as unknown as Row[]
    ).map(hydrate);
  },

  drop(id: number): void {
    getDb().prepare('DELETE FROM undo_journal WHERE id=?').run(id);
  },
};

export interface RevertResult {
  restored: string[];
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
}

/** Put the files back the way the record found them. A file the run created is
 *  removed; a file it modified is rewritten with its exact prior bytes. */
export function revert(repoPath: string, rec: UndoRecord): RevertResult {
  const out: RevertResult = { restored: [], removed: [], failed: [] };
  for (const e of rec.entries) {
    const full = path.resolve(repoPath, e.path);
    try {
      if (e.before === null) {
        fs.rmSync(full, { force: true });
        out.removed.push(e.path);
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, e.before, 'utf8');
        out.restored.push(e.path);
      }
    } catch (err) {
      out.failed.push({ path: e.path, reason: String(err) });
    }
  }
  return out;
}
