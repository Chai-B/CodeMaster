// Long-term + session memory persistence (spec §7).

import { getDb } from './db.js';
import { now } from '../util/id.js';
import type { LongTermMemory } from '../types/index.js';

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return (JSON.parse(v) ?? fallback) as T;
  } catch {
    return fallback;
  }
};

function row(r: Record<string, unknown>): LongTermMemory {
  return {
    id: r.id as string,
    namespace: r.namespace as string,
    key: r.key as string,
    value_json: r.value_json as string,
    value_markdown: (r.value_markdown as string) ?? undefined,
    importance: r.importance as number,
    confidence: r.confidence as number,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    source_session_id: (r.source_session_id as string) ?? undefined,
    source_decision_id: (r.source_decision_id as string) ?? undefined,
    tags: typeof r.tags === 'string' && r.tags ? (r.tags as string).split(',') : [],
    permanent: !!r.permanent,
  };
}

export const LongTerm = {
  upsert(m: LongTermMemory): void {
    getDb()
      .prepare(
        `INSERT INTO long_term_memory
        (id, namespace, key, value_json, value_markdown, importance, confidence,
         created_at, updated_at, source_session_id, source_decision_id, tags, permanent,
         reference_count, last_accessed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
        ON CONFLICT(namespace, key) DO UPDATE SET
          value_json=excluded.value_json, value_markdown=excluded.value_markdown,
          importance=excluded.importance, confidence=excluded.confidence,
          updated_at=excluded.updated_at, tags=excluded.tags`,
      )
      .run(
        m.id, m.namespace, m.key, m.value_json, m.value_markdown ?? null, m.importance, m.confidence,
        m.created_at, m.updated_at, m.source_session_id ?? null, m.source_decision_id ?? null,
        m.tags.join(','), m.permanent ? 1 : 0, now(),
      );
  },

  all(): LongTermMemory[] {
    const rows = getDb()
      .prepare('SELECT * FROM long_term_memory ORDER BY importance DESC')
      .all() as Record<string, unknown>[];
    return rows.map(row);
  },

  byNamespace(ns: string): LongTermMemory[] {
    const rows = getDb()
      .prepare('SELECT * FROM long_term_memory WHERE namespace=? ORDER BY importance DESC')
      .all(ns) as Record<string, unknown>[];
    return rows.map(row);
  },

  search(query: string, limit = 20): LongTermMemory[] {
    const like = `%${query}%`;
    const rows = getDb()
      .prepare(
        `SELECT * FROM long_term_memory WHERE key LIKE ? OR value_markdown LIKE ? OR tags LIKE ?
         ORDER BY importance DESC LIMIT ?`,
      )
      .all(like, like, like, limit) as Record<string, unknown>[];
    return rows.map(row);
  },

  markForExpiry(query: string): number {
    // Non-permanent matches get importance zeroed (compressed next cycle).
    const like = `%${query}%`;
    const res = getDb()
      .prepare(
        'UPDATE long_term_memory SET importance=0 WHERE permanent=0 AND (key LIKE ? OR value_markdown LIKE ? OR tags LIKE ?)',
      )
      .run(like, like, like);
    return Number(res.changes);
  },
};

export const SessionMem = {
  set(sessionId: string, key: string, value: unknown): void {
    const db = getDb();
    db.prepare('DELETE FROM session_memory WHERE session_id=? AND key=?').run(sessionId, key);
    db.prepare(
      'INSERT INTO session_memory (id, session_id, key, value_json, created_at) VALUES (?,?,?,?,?)',
    ).run(`${sessionId}:${key}`, sessionId, key, J(value), now());
  },

  get<T>(sessionId: string, key: string, fallback: T): T {
    const r = getDb()
      .prepare('SELECT value_json FROM session_memory WHERE session_id=? AND key=?')
      .get(sessionId, key) as { value_json: string } | undefined;
    return r ? P(r.value_json, fallback) : fallback;
  },

  all(sessionId: string): Record<string, unknown> {
    const rows = getDb()
      .prepare('SELECT key, value_json FROM session_memory WHERE session_id=?')
      .all(sessionId) as { key: string; value_json: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = P(r.value_json, null);
    return out;
  },
};
