// Session handoff package (spec §13.6) — provider-agnostic state transfer, not a transcript.

import yaml from 'js-yaml';
import { Tasks } from '../storage/sessions.js';
import { Reasoning } from '../storage/reasoning.js';
import { staticAnalysis } from '../analysis/api.js';
import type { Session } from '../types/index.js';

export interface HandoffPackage {
  objective: string;
  completed_tasks: string[];
  remaining_tasks: string[];
  current_task_state?: string;
  architecture_snapshot: string;
  key_decisions: string[];
  working_files: string[];
  recent_changes: string;
  open_questions: string[];
  constraints: string[];
}

export async function compileHandoffPackage(session: Session): Promise<HandoffPackage> {
  const tasks = Tasks.forSession(session.id);
  const reasoning = Reasoning.forSession(session.id)
    .filter((r) => r.type === 'decision')
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 20);
  const api = staticAnalysis(session.repository.path);
  const diff = await api.getWorkingDiff();

  return {
    objective: session.objective,
    completed_tasks: tasks.filter((t) => t.status === 'completed').map((t) => t.title),
    remaining_tasks: tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress').map((t) => t.title),
    current_task_state: tasks.find((t) => t.status === 'in_progress')?.title,
    architecture_snapshot: session.architecture?.summary ?? '',
    key_decisions: reasoning.map((r) => r.summary),
    working_files: session.working_files.map((f) => f.path),
    recent_changes: diff.slice(0, 4000),
    open_questions: session.open_questions.filter((q) => q.status === 'open').map((q) => q.text),
    constraints: session.constraints.map((c) => c.description),
  };
}

export function renderHandoffPackage(pkg: HandoffPackage): string {
  return `# Session Handoff Package\n\n${yaml.dump(pkg)}`;
}

export function validateHandoffPackage(pkg: HandoffPackage): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!pkg.objective) missing.push('objective');
  if (!pkg.architecture_snapshot && !pkg.working_files.length) missing.push('context');
  return { ok: missing.length === 0, missing };
}
