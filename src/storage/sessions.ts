// Session + Task persistence (spec §19.2).

import { getDb } from './db.js';
import type { Session, Task, SessionStatus } from '../types/index.js';

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    const parsed = JSON.parse(v);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

function rowToSession(r: Record<string, unknown>): Session {
  return {
    id: r.id as string,
    status: r.status as SessionStatus,
    objective: r.objective as string,
    objective_parsed: P(r.objective_parsed_json, undefined),
    repository: { path: r.repository_path as string, commit: r.repository_commit as string },
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    plan: P(r.current_plan_json, undefined),
    current_provider: P(r.current_provider_json, undefined),
    architecture: P(r.architecture_json, undefined),
    constraints: P(r.constraints_json, []),
    open_questions: P(r.open_questions_json, []),
    working_files: P(r.working_files_json, []),
    progress: P(r.progress_json, { total: 0, completed: 0, failed: 0 }),
    token_usage: P(r.token_usage_json, {
      total_input: 0,
      total_output: 0,
      total: 0,
      by_provider: {},
      cost_usd: 0,
    }),
    decisions: [],
    provider_history: [],
    checkpoints: [],
    metadata: P(r.metadata_json, {}),
  };
}

export const Sessions = {
  insert(s: Session): void {
    getDb()
      .prepare(
        `INSERT INTO sessions
        (id, status, objective, objective_parsed_json, repository_path, repository_commit,
         created_at, updated_at, completed_at, current_plan_json, current_provider_json,
         architecture_json, constraints_json, open_questions_json, working_files_json,
         progress_json, token_usage_json, metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id, s.status, s.objective, J(s.objective_parsed), s.repository.path, s.repository.commit,
        s.created_at, s.updated_at, null, J(s.plan), J(s.current_provider),
        J(s.architecture), J(s.constraints), J(s.open_questions), J(s.working_files),
        J(s.progress), J(s.token_usage), J(s.metadata),
      );
  },

  update(s: Session): void {
    getDb()
      .prepare(
        `UPDATE sessions SET status=?, objective=?, objective_parsed_json=?, updated_at=?,
         completed_at=?, current_plan_json=?, current_provider_json=?, architecture_json=?,
         constraints_json=?, open_questions_json=?, working_files_json=?, progress_json=?,
         token_usage_json=?, metadata_json=? WHERE id=?`,
      )
      .run(
        s.status, s.objective, J(s.objective_parsed), s.updated_at,
        s.status === 'completed' ? s.updated_at : null, J(s.plan), J(s.current_provider), J(s.architecture),
        J(s.constraints), J(s.open_questions), J(s.working_files), J(s.progress),
        J(s.token_usage), J(s.metadata), s.id,
      );
  },

  get(idVal: string): Session | null {
    const r = getDb().prepare('SELECT * FROM sessions WHERE id=?').get(idVal) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToSession(r) : null;
  },

  list(limit = 50): Session[] {
    const rows = getDb()
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToSession);
  },

  mostRecent(): Session | null {
    const r = getDb()
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return r ? rowToSession(r) : null;
  },

  mostRecentActive(): Session | null {
    const r = getDb()
      .prepare(
        "SELECT * FROM sessions WHERE status IN ('active','paused','planning','initializing') ORDER BY updated_at DESC LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    return r ? rowToSession(r) : null;
  },
};

function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    parent_task_id: (r.parent_task_id as string) ?? undefined,
    title: r.title as string,
    description: r.description as string,
    type: r.type as Task['type'],
    status: r.status as Task['status'],
    input_files: P(r.input_files_json, []),
    output_files: P(r.output_files_json, []),
    dependencies: P(r.dependencies_json, []),
    blocking: P(r.blocking_json, []),
    assigned_provider: P(r.assigned_provider_json, undefined),
    reasoning_refs: P(r.reasoning_refs_json, []),
    decision_refs: P(r.decision_refs_json, []),
    started_at: (r.started_at as string) ?? undefined,
    completed_at: (r.completed_at as string) ?? undefined,
    failed_at: (r.failed_at as string) ?? undefined,
    failure_reason: (r.failure_reason as string) ?? undefined,
    estimated_tokens: (r.estimated_tokens as number) ?? 0,
    actual_tokens: (r.actual_tokens as number) ?? undefined,
    order: (r.task_order as number) ?? 0,
  };
}

export const Tasks = {
  insert(t: Task): void {
    getDb()
      .prepare(
        `INSERT INTO tasks
        (id, session_id, parent_task_id, title, description, type, status,
         input_files_json, output_files_json, dependencies_json, blocking_json,
         assigned_provider_json, reasoning_refs_json, decision_refs_json,
         started_at, completed_at, failed_at, failure_reason,
         estimated_tokens, actual_tokens, task_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id, t.session_id, t.parent_task_id ?? null, t.title, t.description, t.type, t.status,
        J(t.input_files), J(t.output_files), J(t.dependencies), J(t.blocking),
        J(t.assigned_provider), J(t.reasoning_refs), J(t.decision_refs),
        t.started_at ?? null, t.completed_at ?? null, t.failed_at ?? null, t.failure_reason ?? null,
        t.estimated_tokens, t.actual_tokens ?? null, t.order,
      );
  },

  update(t: Task): void {
    getDb()
      .prepare(
        `UPDATE tasks SET title=?, description=?, type=?, status=?, input_files_json=?,
         output_files_json=?, dependencies_json=?, blocking_json=?, assigned_provider_json=?,
         reasoning_refs_json=?, decision_refs_json=?, started_at=?, completed_at=?, failed_at=?,
         failure_reason=?, estimated_tokens=?, actual_tokens=?, task_order=? WHERE id=?`,
      )
      .run(
        t.title, t.description, t.type, t.status, J(t.input_files),
        J(t.output_files), J(t.dependencies), J(t.blocking), J(t.assigned_provider),
        J(t.reasoning_refs), J(t.decision_refs), t.started_at ?? null, t.completed_at ?? null, t.failed_at ?? null,
        t.failure_reason ?? null, t.estimated_tokens, t.actual_tokens ?? null, t.order, t.id,
      );
  },

  get(idVal: string): Task | null {
    const r = getDb().prepare('SELECT * FROM tasks WHERE id=?').get(idVal) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToTask(r) : null;
  },

  forSession(sessionId: string): Task[] {
    const rows = getDb()
      .prepare('SELECT * FROM tasks WHERE session_id=? ORDER BY task_order ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToTask);
  },

  replaceForSession(sessionId: string, tasks: Task[]): void {
    const db = getDb();
    db.prepare('DELETE FROM tasks WHERE session_id=?').run(sessionId);
    for (const t of tasks) this.insert(t);
  },
};
