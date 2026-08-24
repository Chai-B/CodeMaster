// Session summarization record (spec §16.3) — compact permanent record at completion.

import yaml from 'js-yaml';
import { Tasks } from '../storage/sessions.js';
import { Reasoning } from '../storage/reasoning.js';
import { Tokens } from '../storage/tokens.js';
import { LongTerm } from '../storage/memory.js';
import { id, now } from '../util/id.js';
import type { Session } from '../types/index.js';

export interface SessionSummary {
  id: string;
  objective: string;
  outcome: string;
  key_decisions: string[];
  files_modified: string[];
  open_questions_remaining: number;
  token_usage: { total: number; by_provider: Record<string, number> };
  wiki_entries_touched: number;
  created_at: string;
}

export function buildSessionSummary(session: Session): SessionSummary {
  const tasks = Tasks.forSession(session.id);
  const decisions = Reasoning.forSession(session.id)
    .filter((r) => r.type === 'decision')
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8);
  const tok = Tokens.sessionTotal(session.id);

  return {
    id: session.id,
    objective: session.objective,
    outcome: session.status === 'completed' ? 'completed' : session.status,
    key_decisions: decisions.map((d) => d.summary),
    files_modified: session.working_files.map((f) => f.path),
    open_questions_remaining: session.open_questions.filter((q) => q.status === 'open').length,
    token_usage: { total: tok.total, by_provider: Tokens.byProvider(session.id) },
    wiki_entries_touched: 0,
    created_at: now(),
  };
}

/** Persist the summary permanently in long-term memory (spec §16.3). */
export function persistSessionSummary(summary: SessionSummary): void {
  LongTerm.upsert({
    id: id('ltm'),
    namespace: 'sessions',
    key: `summary:${summary.id}`,
    value_json: JSON.stringify(summary),
    value_markdown: `## ${summary.objective}\n\n${yaml.dump(summary)}`,
    importance: 0.8,
    confidence: 1,
    created_at: now(),
    updated_at: now(),
    source_session_id: summary.id,
    tags: ['session-summary'],
    permanent: true,
  });
}
