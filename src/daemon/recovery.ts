// Crash recovery (spec §14.5) — detect incomplete sessions, check partial patches.

import { Sessions, Tasks } from '../storage/sessions.js';
import { Checkpoints } from '../storage/checkpoints.js';
import { GitWorker } from '../analysis/git.js';
import { restoreCheckpoint } from '../workers/checkpointer.js';
import type { Session } from '../types/index.js';

export interface RecoveryReport {
  session: Session;
  inProgressTask?: string;
  partialPatch: boolean;
  action: 'resumed' | 'reverted-task' | 'needs-attention';
  detail: string;
}

/** Find sessions left in an active/planning state (no clean shutdown). */
export function findIncompleteSessions(): Session[] {
  return Sessions.list(100).filter((s) => s.status === 'active' || s.status === 'planning');
}

export async function recoverSession(session: Session): Promise<RecoveryReport> {
  const tasks = Tasks.forSession(session.id);
  const inProgress = tasks.find((t) => t.status === 'in_progress');

  const git = new GitWorker(session.repository.path);
  const status = await git.status();
  const partialPatch = status.modified.length > 0 || status.created.length > 0;

  // Restore latest checkpoint state if available.
  const latest = Checkpoints.latest(session.id);
  if (latest) restoreCheckpoint(latest.id);

  let action: RecoveryReport['action'] = 'resumed';
  let detail = 'Resumed from last checkpoint.';

  if (inProgress) {
    // Task was mid-flight at crash; mark it back to pending so it re-runs cleanly.
    inProgress.status = 'pending';
    inProgress.started_at = undefined;
    Tasks.update(inProgress);
    action = partialPatch ? 'needs-attention' : 'reverted-task';
    detail = partialPatch
      ? `Task "${inProgress.title}" was interrupted with uncommitted changes — review working tree before continuing.`
      : `Task "${inProgress.title}" reset to pending; no partial changes detected.`;
  }

  return { session, inProgressTask: inProgress?.title, partialPatch, action, detail };
}

export async function recoverAll(): Promise<RecoveryReport[]> {
  const reports: RecoveryReport[] = [];
  for (const s of findIncompleteSessions()) {
    reports.push(await recoverSession(s));
  }
  return reports;
}
