// Reasoning + failure persistence (spec §7.5, §8).

import { getDb } from './db.js';
import type { ReasoningObject, ReasoningType, FailureRecord, Decision, Risk } from '../types/index.js';

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return (JSON.parse(v) ?? fallback) as T;
  } catch {
    return fallback;
  }
};

// Fields specific to subtypes are stored in extra_json.
function extraOf(r: ReasoningObject): Record<string, unknown> {
  if (r.type === 'decision') {
    const d = r as Decision;
    return {
      question: d.question,
      answer: d.answer,
      alternatives_rejected: d.alternatives_rejected,
      implications: d.implications,
      reversibility: d.reversibility,
      supersedes: d.supersedes,
    };
  }
  if (r.type === 'risk') {
    const k = r as Risk;
    return {
      risk_description: k.risk_description,
      likelihood: k.likelihood,
      impact: k.impact,
      mitigation_strategy: k.mitigation_strategy,
      monitoring_approach: k.monitoring_approach,
      status: k.status,
    };
  }
  return {};
}

function rowToReasoning(r: Record<string, unknown>): ReasoningObject {
  const base = {
    id: r.id as string,
    type: r.type as ReasoningType,
    session_id: r.session_id as string,
    task_id: r.task_id as string,
    summary: r.summary as string,
    detail: r.detail as string,
    evidence: P(r.evidence_json, []),
    confidence: r.confidence as number,
    produced_by: P(r.produced_by_json, { provider_id: 'unknown', model_id: 'unknown' }),
    produced_at: r.produced_at as string,
    affected_files: P(r.affected_files_json, []),
    affected_modules: P(r.affected_modules_json, []),
    tags: typeof r.tags === 'string' && r.tags ? (r.tags as string).split(',') : [],
    permanent: !!r.permanent,
    wiki_keys: P(r.wiki_keys, []),
    reference_count: (r.reference_count as number) ?? 0,
    importance: (r.importance as number) ?? 0.5,
    expires_at: (r.expires_at as string) ?? undefined,
  };
  const extra = P<Record<string, unknown>>(r.extra_json, {});
  return { ...base, ...extra } as ReasoningObject;
}

export const Reasoning = {
  insert(r: ReasoningObject): void {
    getDb()
      .prepare(
        `INSERT INTO reasoning
        (id, session_id, task_id, type, summary, detail, evidence_json, alternatives_json,
         confidence, produced_by_json, produced_at, affected_files_json, affected_modules_json,
         tags, permanent, expires_at, reference_count, importance, wiki_keys, extra_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id, r.session_id, r.task_id, r.type, r.summary, r.detail, J(r.evidence), J([]),
        r.confidence, J(r.produced_by), r.produced_at, J(r.affected_files), J(r.affected_modules),
        r.tags.join(','), r.permanent ? 1 : 0, r.expires_at ?? null, r.reference_count, r.importance,
        J(r.wiki_keys), J(extraOf(r)),
      );
  },

  get(idVal: string): ReasoningObject | null {
    const r = getDb().prepare('SELECT * FROM reasoning WHERE id=?').get(idVal) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToReasoning(r) : null;
  },

  forSession(sessionId: string): ReasoningObject[] {
    const rows = getDb()
      .prepare('SELECT * FROM reasoning WHERE session_id=? ORDER BY produced_at ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToReasoning);
  },

  search(query: string, limit = 20): ReasoningObject[] {
    const like = `%${query}%`;
    const rows = getDb()
      .prepare(
        `SELECT * FROM reasoning WHERE summary LIKE ? OR detail LIKE ? OR tags LIKE ?
         ORDER BY importance DESC, reference_count DESC LIMIT ?`,
      )
      .all(like, like, like, limit) as Record<string, unknown>[];
    return rows.map(rowToReasoning);
  },

  /** Relevance ranking by keyword overlap + importance for context replay (spec §8.4). */
  relevant(keywords: string[], limit = 15): ReasoningObject[] {
    if (keywords.length === 0) {
      const rows = getDb()
        .prepare('SELECT * FROM reasoning ORDER BY importance DESC, produced_at DESC LIMIT ?')
        .all(limit) as Record<string, unknown>[];
      return rows.map(rowToReasoning);
    }
    const conds = keywords.map(() => '(summary LIKE ? OR detail LIKE ? OR tags LIKE ?)').join(' OR ');
    const params: unknown[] = [];
    for (const k of keywords) {
      const like = `%${k}%`;
      params.push(like, like, like);
    }
    params.push(limit);
    const rows = getDb()
      .prepare(`SELECT * FROM reasoning WHERE ${conds} ORDER BY importance DESC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[];
    return rows.map(rowToReasoning);
  },

  /** Retrieve reasoning whose affected files overlap the given files (spec §8.4) —
   *  so a prior conclusion about a file resurfaces whenever that file is touched
   *  again, even when the task wording shares no keywords. This is what makes the
   *  memory compound on the code locus, not just on prose overlap. */
  byAffectedFiles(files: string[], limit = 8): ReasoningObject[] {
    if (files.length === 0) return [];
    const conds = files.map(() => 'affected_files_json LIKE ?').join(' OR ');
    const params: unknown[] = files.map((f) => `%${JSON.stringify(f)}%`);
    params.push(limit);
    const rows = getDb()
      .prepare(`SELECT * FROM reasoning WHERE ${conds} ORDER BY importance DESC, reference_count DESC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[];
    return rows.map(rowToReasoning);
  },

  incrementReference(idVal: string): void {
    getDb().prepare('UPDATE reasoning SET reference_count = reference_count + 1 WHERE id=?').run(idVal);
  },

  markExpired(idVal: string, expiresAt: string): void {
    getDb().prepare('UPDATE reasoning SET expires_at=? WHERE id=?').run(expiresAt, idVal);
  },
};

const failRow = (r: Record<string, unknown>): FailureRecord => ({
  id: r.id as string,
  session_id: r.session_id as string,
  task_id: r.task_id as string,
  approach_attempted: r.approach_attempted as string,
  why_it_failed: r.why_it_failed as string,
  evidence_of_failure: P(r.evidence_json, []),
  alternatives_suggested: P(r.alternatives_json, []),
  affected_files: P(r.affected_files_json, []),
  confidence_in_failure_diagnosis: r.confidence as number,
  created_at: r.created_at as string,
  permanent: !!r.permanent,
});

export const Failures = {
  insert(f: FailureRecord): void {
    getDb()
      .prepare(
        `INSERT INTO failures
        (id, session_id, task_id, approach_attempted, why_it_failed, evidence_json,
         alternatives_json, affected_files_json, confidence, created_at, permanent)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        f.id, f.session_id, f.task_id, f.approach_attempted, f.why_it_failed,
        J(f.evidence_of_failure), J(f.alternatives_suggested), J(f.affected_files),
        f.confidence_in_failure_diagnosis, f.created_at, f.permanent ? 1 : 0,
      );
  },

  relevant(keywords: string[], limit = 10): FailureRecord[] {
    if (keywords.length === 0) return [];
    const conds = keywords.map(() => '(approach_attempted LIKE ? OR why_it_failed LIKE ?)').join(' OR ');
    const params: unknown[] = [];
    for (const k of keywords) {
      const like = `%${k}%`;
      params.push(like, like);
    }
    params.push(limit);
    const rows = getDb()
      .prepare(`SELECT * FROM failures WHERE ${conds} LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[];
    return rows.map(failRow);
  },

  /** Everything that failed in one session, newest first. The handoff package
   *  carries these across a provider switch: the incoming model needs "this was
   *  already tried and why it did not work" more than it needs anything else. */
  forSession(sessionId: string, limit = 10): FailureRecord[] {
    const rows = getDb()
      .prepare('SELECT * FROM failures WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(failRow);
  },

  /** Non-working approaches recorded against the given files (spec §8.5) — surfaced
   *  as "do not repeat" whenever those files are edited again. */
  byAffectedFiles(files: string[], limit = 6): FailureRecord[] {
    if (files.length === 0) return [];
    const conds = files.map(() => 'affected_files_json LIKE ?').join(' OR ');
    const params: unknown[] = files.map((f) => `%${JSON.stringify(f)}%`);
    params.push(limit);
    const rows = getDb()
      .prepare(`SELECT * FROM failures WHERE ${conds} ORDER BY created_at DESC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[];
    return rows.map(failRow);
  },
};
