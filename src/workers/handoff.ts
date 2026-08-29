// Session handoff package (spec §13.6) — provider-agnostic state transfer, not a transcript.

import yaml from 'js-yaml';
import { Tasks } from '../storage/sessions.js';
import { Reasoning, Failures } from '../storage/reasoning.js';
import { estimateTokens } from '../util/tokens.js';
import { staticAnalysis } from '../analysis/api.js';
import type { Session } from '../types/index.js';

export interface HandoffPackage {
  objective: string;
  completed_tasks: string[];
  remaining_tasks: string[];
  current_task_state?: string;
  architecture_snapshot: string;
  key_decisions: string[];
  /** Risks the outgoing provider raised and nobody has closed. */
  key_risks: string[];
  /** Approaches already tried and why they failed, so the incoming provider
   *  does not spend its first iterations re-deriving a dead end. */
  known_failures: string[];
  working_files: string[];
  recent_changes: string;
  open_questions: string[];
  constraints: string[];
}

export async function compileHandoffPackage(session: Session): Promise<HandoffPackage> {
  const tasks = Tasks.forSession(session.id);
  const reasoning = Reasoning.forSession(session.id).sort((a, b) => b.importance - a.importance);
  const decisions = reasoning.filter((r) => r.type === 'decision').slice(0, 20);
  const risks = reasoning.filter((r) => r.type === 'risk').slice(0, 8);
  const api = staticAnalysis(session.repository.path);
  const diff = await api.getWorkingDiff();

  return {
    objective: session.objective,
    completed_tasks: tasks.filter((t) => t.status === 'completed').map((t) => t.title),
    remaining_tasks: tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress').map((t) => t.title),
    current_task_state: tasks.find((t) => t.status === 'in_progress')?.title,
    architecture_snapshot: session.architecture?.summary ?? '',
    key_decisions: decisions.map((r) => r.summary),
    key_risks: risks.map((r) => r.summary),
    known_failures: Failures.forSession(session.id, 8).map((f) => `${f.approach_attempted} — ${f.why_it_failed}`),
    working_files: session.working_files.map((f) => f.path),
    recent_changes: clipDiff(diff),
    open_questions: session.open_questions.filter((q) => q.status === 'open').map((q) => q.text),
    constraints: session.constraints.map((c) => c.description),
  };
}

/** The diff is the one unbounded field in the package. A raw character cut
 *  landed mid-line and said nothing about what went missing, and it was the one
 *  field with no relation to the token budget every other context component is
 *  allocated against. Cut on a line boundary instead, and say how much was
 *  dropped — a diff that just stops reads as corruption. */
function clipDiff(diff: string, budget = 1200): string {
  if (estimateTokens(diff) <= budget) return diff;
  const lines = diff.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return `${kept.join('\n')}\n… ${lines.length - kept.length} more diff lines omitted (over ${budget}-token handoff budget)`;
}

export function renderHandoffPackage(pkg: HandoffPackage): string {
  return `# Session Handoff Package\n\n${yaml.dump(pkg)}`;
}

export function validateHandoffPackage(pkg: HandoffPackage): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!pkg.objective) missing.push('objective');
  if (!pkg.architecture_snapshot && !pkg.working_files.length) missing.push('context');
  // A package that carries an objective and one file but nothing to act on and
  // nothing learned is not a handoff — the incoming provider starts from zero.
  const continuity =
    pkg.remaining_tasks.length || pkg.current_task_state || pkg.key_decisions.length || pkg.known_failures.length;
  if (!continuity) missing.push('continuity');
  return { ok: missing.length === 0, missing };
}
