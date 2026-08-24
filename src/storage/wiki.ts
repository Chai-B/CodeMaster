// Wiki entry + version persistence (spec §9, §19.2).

import { getDb } from './db.js';
import { id } from '../util/id.js';
import type { WikiEntry, WikiFrontMatter } from '../types/index.js';

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return (JSON.parse(v) ?? fallback) as T;
  } catch {
    return fallback;
  }
};

function row(r: Record<string, unknown>): WikiEntry {
  return {
    wiki_key: r.wiki_key as string,
    content_markdown: r.content_markdown as string,
    front_matter: P<WikiFrontMatter>(r.front_matter_json, {
      wiki_id: r.wiki_key as string,
      title: r.title as string,
      namespace: r.namespace as string,
      status: 'current',
      confidence: 0.9,
      last_updated: r.last_updated as string,
      related_decisions: [],
      related_files: [],
      tags: [],
    }),
  };
}

export const Wiki = {
  upsert(e: WikiEntry, sessionId?: string): void {
    const fm = e.front_matter;
    getDb()
      .prepare(
        `INSERT INTO wiki_entries
        (wiki_key, title, namespace, status, confidence, content_markdown, front_matter_json,
         last_updated, last_updated_by_session, tags, related_files_json, related_decisions_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(wiki_key) DO UPDATE SET
          title=excluded.title, namespace=excluded.namespace, status=excluded.status,
          confidence=excluded.confidence, content_markdown=excluded.content_markdown,
          front_matter_json=excluded.front_matter_json, last_updated=excluded.last_updated,
          last_updated_by_session=excluded.last_updated_by_session, tags=excluded.tags,
          related_files_json=excluded.related_files_json, related_decisions_json=excluded.related_decisions_json`,
      )
      .run(
        e.wiki_key, fm.title, fm.namespace, fm.status, fm.confidence, e.content_markdown, J(fm),
        fm.last_updated, sessionId ?? fm.last_updated_by_session ?? null, fm.tags.join(','),
        J(fm.related_files), J(fm.related_decisions),
      );
  },

  get(key: string): WikiEntry | null {
    const r = getDb().prepare('SELECT * FROM wiki_entries WHERE wiki_key=?').get(key) as
      | Record<string, unknown>
      | undefined;
    return r ? row(r) : null;
  },

  list(): WikiEntry[] {
    const rows = getDb()
      .prepare('SELECT * FROM wiki_entries ORDER BY namespace, wiki_key')
      .all() as Record<string, unknown>[];
    return rows.map(row);
  },

  byNamespace(ns: string): WikiEntry[] {
    const rows = getDb()
      .prepare('SELECT * FROM wiki_entries WHERE namespace=? ORDER BY wiki_key')
      .all(ns) as Record<string, unknown>[];
    return rows.map(row);
  },

  search(query: string, limit = 20): WikiEntry[] {
    const like = `%${query}%`;
    const rows = getDb()
      .prepare(
        'SELECT * FROM wiki_entries WHERE title LIKE ? OR content_markdown LIKE ? OR tags LIKE ? LIMIT ?',
      )
      .all(like, like, like, limit) as Record<string, unknown>[];
    return rows.map(row);
  },

  saveVersion(key: string, content: string, sessionId?: string, summary?: string): void {
    getDb()
      .prepare(
        `INSERT INTO wiki_versions (id, wiki_key, version_at, content_markdown, changed_by_session, change_summary)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id('wv'), key, new Date().toISOString(), content, sessionId ?? null, summary ?? null);
  },

  versions(key: string): Array<{ version_at: string; change_summary: string | null }> {
    return getDb()
      .prepare('SELECT version_at, change_summary FROM wiki_versions WHERE wiki_key=? ORDER BY version_at DESC')
      .all(key) as Array<{ version_at: string; change_summary: string | null }>;
  },
};
