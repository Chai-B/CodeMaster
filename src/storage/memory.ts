// Long-term + session memory persistence (spec §7).

import { getDb } from './db.js';
import { now } from '../util/id.js';
import { embed, cosine, embavailable } from '../analysis/embeddings.js';
import type { LongTermMemory } from '../types/index.js';

export function calibratedScore(m: LongTermMemory): number {
  const ageDays = Math.max(0, (Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24));
  const decay = m.permanent ? 1.0 : Math.exp(-0.02 * ageDays);
  return (m.confidence ?? 1.0) * (m.importance ?? 0.5) * decay;
}

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
    status: (r.status as 'active' | 'superseded') ?? 'active',
    superseded_by: (r.superseded_by as string) ?? undefined,
    contradicts_id: (r.contradicts_id as string) ?? undefined,
    evidence_refs: typeof r.evidence_refs_json === 'string' ? P<string[]>(r.evidence_refs_json, []) : undefined,
  };
}

export const LongTerm = {
  upsert(m: LongTermMemory): void {
    const db = getDb();

    // Contradiction resolution:
    // If m explicitly names a contradicted id, mark that previous memory as superseded.
    if (m.contradicts_id) {
      db.prepare("UPDATE long_term_memory SET status='superseded', superseded_by=? WHERE id=?").run(m.id, m.contradicts_id);
    }

    // If there is an existing memory with identical namespace + key, find its id to link contradiction
    const existing = db
      .prepare('SELECT id FROM long_term_memory WHERE namespace=? AND key=?')
      .get(m.namespace, m.key) as { id: string } | undefined;
    if (existing && existing.id !== m.id) {
      db.prepare("UPDATE long_term_memory SET status='superseded', superseded_by=? WHERE id=?").run(m.id, existing.id);
    }

    db.prepare(
      `INSERT INTO long_term_memory
      (id, namespace, key, value_json, value_markdown, importance, confidence,
       created_at, updated_at, source_session_id, source_decision_id, tags, permanent,
       reference_count, last_accessed_at, status, superseded_by, contradicts_id, evidence_refs_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        value_json=excluded.value_json, value_markdown=excluded.value_markdown,
        importance=excluded.importance, confidence=excluded.confidence,
        updated_at=excluded.updated_at, tags=excluded.tags,
        status=excluded.status, superseded_by=excluded.superseded_by,
        contradicts_id=excluded.contradicts_id, evidence_refs_json=excluded.evidence_refs_json`,
    )
    .run(
      m.id, m.namespace, m.key, m.value_json, m.value_markdown ?? null, m.importance, m.confidence,
      m.created_at, m.updated_at, m.source_session_id ?? null, m.source_decision_id ?? null,
      m.tags.join(','), m.permanent ? 1 : 0, now(),
      m.status ?? 'active', m.superseded_by ?? null, m.contradicts_id ?? null,
      m.evidence_refs ? J(m.evidence_refs) : null,
    );
  },

  all(includeSuperseded = false): LongTermMemory[] {
    const sql = includeSuperseded
      ? 'SELECT * FROM long_term_memory ORDER BY importance DESC'
      : "SELECT * FROM long_term_memory WHERE status != 'superseded' ORDER BY importance DESC";
    const rows = getDb().prepare(sql).all() as Record<string, unknown>[];
    return rows.map(row);
  },

  byNamespace(ns: string, includeSuperseded = false): LongTermMemory[] {
    const sql = includeSuperseded
      ? 'SELECT * FROM long_term_memory WHERE namespace=? ORDER BY importance DESC'
      : "SELECT * FROM long_term_memory WHERE namespace=? AND status != 'superseded' ORDER BY importance DESC";
    const rows = getDb().prepare(sql).all(ns) as Record<string, unknown>[];
    return rows.map(row);
  },

  search(query: string, limit = 20): LongTermMemory[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // 1. SQLite FTS5 BM25 search with calibrated score re-ranking
    try {
      const ftsQuery = trimmed
        .replace(/["'*]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => `"${w}"*`)
        .join(' ');

      if (ftsQuery) {
        const rows = getDb()
          .prepare(
            `SELECT m.* FROM long_term_fts f
             JOIN long_term_memory m ON m.id = f.memory_id
             WHERE long_term_fts MATCH ? AND m.status != 'superseded'
             ORDER BY rank, m.importance DESC LIMIT ?`,
          )
          .all(ftsQuery, limit * 2) as Record<string, unknown>[];
        if (rows.length > 0) {
          const items = rows.map(row);
          items.sort((a, b) => calibratedScore(b) - calibratedScore(a));
          return items.slice(0, limit);
        }
      }
    } catch {
      /* fallback to LIKE */
    }

    // 2. Fallback to LIKE
    const like = `%${trimmed}%`;
    const rows = getDb()
      .prepare(
        `SELECT * FROM long_term_memory
         WHERE (key LIKE ? OR value_markdown LIKE ? OR tags LIKE ?)
           AND status != 'superseded'
         ORDER BY importance DESC LIMIT ?`,
      )
      .all(like, like, like, limit * 2) as Record<string, unknown>[];
    const items = rows.map(row);
    items.sort((a, b) => calibratedScore(b) - calibratedScore(a));
    return items.slice(0, limit);
  },

  /**
   * Hybrid retrieval (spec §7.4, EverOS / TrueMemory model):
   * Stage 1: SQLite FTS5 BM25 search
   * Stage 2: Dense vector similarity using @xenova/transformers (when available)
   * Stage 3: Reciprocal Rank Fusion (RRF) with calibrated scoring & decay
   */
  async hybridSearch(query: string, limit = 20): Promise<LongTermMemory[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Stage 1: BM25 Candidates via FTS5 / LIKE
    const bm25Results = this.search(trimmed, limit * 2);
    const bm25RankMap = new Map<string, number>();
    bm25Results.forEach((m, idx) => bm25RankMap.set(m.id, idx));

    // Stage 2: Vector Search if embedding extractor is available
    const vectorRankMap = new Map<string, number>();
    try {
      if (await embavailable()) {
        const qVec = await embed(trimmed);
        if (qVec) {
          const allActive = this.all(false);
          const scored = await Promise.all(
            allActive.map(async (m) => {
              const text = `${m.key}\n${m.value_markdown ?? ''}`.slice(0, 500);
              const mVec = await embed(text);
              const score = mVec ? cosine(qVec, mVec) : 0;
              return { m, score };
            }),
          );
          scored.sort((a, b) => b.score - a.score);
          scored.slice(0, limit * 2).forEach((item, idx) => {
            if (item.score > 0.1) vectorRankMap.set(item.m.id, idx);
          });
        }
      }
    } catch {
      /* vector search fallback */
    }

    // Stage 3: Reciprocal Rank Fusion (RRF) with Calibrated Scoring
    const candidates = new Map<string, LongTermMemory>();
    for (const m of bm25Results) candidates.set(m.id, m);

    // If vector search found items not in BM25, add them
    if (vectorRankMap.size > 0) {
      const active = this.all(false);
      for (const m of active) {
        if (vectorRankMap.has(m.id)) candidates.set(m.id, m);
      }
    }

    const fused = Array.from(candidates.values()).map((m) => {
      const rBM25 = bm25RankMap.has(m.id) ? bm25RankMap.get(m.id)! : 100;
      const rVec = vectorRankMap.has(m.id) ? vectorRankMap.get(m.id)! : 100;
      const rrf = 1 / (60 + rBM25) + 1 / (60 + rVec);
      const score = rrf * calibratedScore(m);
      return { m, score };
    });

    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, limit).map((f) => f.m);
  },

  supersede(id: string, supersededBy: string): void {
    getDb()
      .prepare("UPDATE long_term_memory SET status='superseded', superseded_by=? WHERE id=?")
      .run(supersededBy, id);
  },

  markForExpiry(query: string): number {
    // Non-permanent matches get importance zeroed (compressed next cycle).
    const like = `%${query}%`;
    const res = getDb()
      .prepare(
        "UPDATE long_term_memory SET importance=0 WHERE permanent=0 AND (key LIKE ? OR value_markdown LIKE ? OR tags LIKE ?) AND status != 'superseded'",
      )
      .run(like, like, like);
    return Number(res.changes);
  },
};

