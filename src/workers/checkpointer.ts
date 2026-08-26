// Checkpointer — self-sufficient session snapshots (spec §14.2-14.3, deterministic).

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { sessionsDir, loadConfig } from '../config.js';
import { Sessions, Tasks } from '../storage/sessions.js';
import { Reasoning } from '../storage/reasoning.js';
import { Checkpoints } from '../storage/checkpoints.js';
import { GitWorker } from '../analysis/git.js';
import { bus } from '../events/bus.js';
import { id, now } from '../util/id.js';
import type { Session, Task, CheckpointTrigger, CheckpointManifest } from '../types/index.js';

export async function createCheckpoint(
  session: Session,
  trigger: CheckpointTrigger,
): Promise<CheckpointManifest> {
  const cpId = id('ckpt');
  const dir = path.join(sessionsDir(), session.id, 'checkpoints', cpId);
  fs.mkdirSync(dir, { recursive: true });

  const tasks = Tasks.forSession(session.id);
  const reasoning = Reasoning.forSession(session.id);

  const git = new GitWorker(session.repository.path);
  const repoPatch = await git.createCheckpointPatch(session.repository.commit).catch(() => '');

  const completed = tasks.filter((t) => t.status === 'completed').length;
  const manifest: CheckpointManifest = {
    id: cpId,
    session_id: session.id,
    created_at: now(),
    trigger,
    repository_commit: await git.headCommit(),
    repository_path: session.repository.path,
    token_usage: session.token_usage,
    task_count: tasks.length,
    tasks_completed: completed,
    tasks_remaining: tasks.length - completed,
    reasoning_count: reasoning.length,
  };

  // Exactly what restore reads, plus two artifacts for a human: the plan and a
  // patch to recover the tree by hand. The rest of the spec's artifact set —
  // reasoning, memory and wiki snapshots, worker states, the token ledger, the
  // last context — was written on every checkpoint and read by nothing. The wiki
  // snapshot was the expensive one: the whole wiki copied per checkpoint, kept
  // until pruning, for a store that lives in the database anyway.
  write(dir, 'manifest.json', JSON.stringify(manifest, null, 2));
  write(dir, 'session.json', JSON.stringify(session, null, 2));
  write(dir, 'tasks.json', JSON.stringify(tasks, null, 2));
  write(dir, 'plan.yaml', yaml.dump(session.plan ?? { tasks: tasks.map((t) => ({ title: t.title, type: t.type, status: t.status })) }));
  write(dir, 'repo.patch', repoPatch);

  const sizeBytes = dirSize(dir);
  Checkpoints.insert(manifest, dir, sizeBytes);
  for (const stale of Checkpoints.prune(session.id, loadConfig().checkpointing.max_checkpoints_per_session)) {
    fs.rmSync(stale, { recursive: true, force: true });
  }
  session.checkpoints.push(cpId);
  session.latest_checkpoint = cpId;
  bus.emit({ type: 'checkpoint.created', id: cpId, trigger });
  return manifest;
}

export function restoreCheckpoint(checkpointId: string): Session | null {
  const cp = Checkpoints.get(checkpointId);
  if (!cp) return null;
  const sessionFile = path.join(cp.path, 'session.json');
  const tasksFile = path.join(cp.path, 'tasks.json');
  if (!fs.existsSync(sessionFile)) return null;

  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as Session;
  // Restore DB rows from snapshot (idempotent upsert).
  const existing = Sessions.get(session.id);
  if (existing) Sessions.update(session);
  else Sessions.insert(session);

  if (fs.existsSync(tasksFile)) {
    const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')) as Task[];
    Tasks.replaceForSession(session.id, tasks ?? []);
  }

  bus.emit({ type: 'checkpoint.restored', id: checkpointId });
  return session;
}

function write(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

export interface CheckpointStateCheck {
  matches: boolean;
  currentCommit: string;
  checkpointCommit: string;
  workingDiff: string;
}

/**
 * Verify the working tree still matches the latest checkpoint before resuming
 * (spec §14.4). A mismatch means the repository changed externally.
 */
export async function verifyCheckpointState(session: Session): Promise<CheckpointStateCheck | null> {
  const latest = Checkpoints.latest(session.id);
  if (!latest) return null;
  const git = new GitWorker(session.repository.path);
  const currentCommit = await git.headCommit();
  const checkpointCommit = latest.repository_commit;
  const workingDiff = await git.workingDiff();
  return {
    matches: currentCommit === checkpointCommit && !workingDiff.trim(),
    currentCommit,
    checkpointCommit,
    workingDiff,
  };
}
