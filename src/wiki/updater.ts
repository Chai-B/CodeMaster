// WikiUpdater — applies updates with versioning + conflict detection (spec §9.3).

import { Wiki } from '../storage/wiki.js';
import { bus } from '../events/bus.js';
import { now } from '../util/id.js';
import { writeMarkdown, writeVersion } from './markdown.js';
import type { WikiEntry, WikiUpdate, WikiFrontMatter } from '../types/index.js';

const slug = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Canonical wiki key: `<namespace>/<leaf>`, both slugified. A key with no
 * namespace lands in `notes/` rather than making its own title a namespace —
 * that bug produced sibling entries `Alias Handling` and `alias-handling`,
 * each its own orphan namespace and neither reachable from NAMESPACE_PRIORITY.
 */
export function normalizeKey(key: string): string {
  const parts = key.split('/').map(slug).filter(Boolean);
  if (parts.length === 0) return 'notes/untitled';
  if (parts.length === 1) return `notes/${parts[0]}`;
  return parts.join('/');
}

function deriveMeta(key: string): { namespace: string; title: string } {
  const parts = normalizeKey(key).split('/');
  const namespace = parts[0]!;
  const leaf = parts[parts.length - 1]!;
  const title = leaf.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { namespace, title };
}

export function defaultFrontMatter(key: string, sessionId?: string): WikiFrontMatter {
  const { namespace, title } = deriveMeta(key);
  return {
    wiki_id: key.replace(/\//g, '-'),
    title,
    namespace,
    status: 'current',
    confidence: 0.9,
    last_updated: now(),
    last_updated_by_session: sessionId,
    related_decisions: [],
    related_files: [],
    tags: [],
  };
}

export interface ApplyResult {
  key: string;
  action: 'created' | 'updated' | 'conflict';
  /** On a conflict, the two contradictory texts. Whoever reconciles them needs
   *  to read them; a reconcile request carrying only a key cannot do the job. */
  previous?: string;
  incoming?: string;
}

/**
 * Apply a single wiki update. `conflict_strategy` controls behavior when the
 * existing entry differs materially (spec §9.3 / config wiki.conflict_strategy).
 */
export function applyWikiUpdate(
  update: WikiUpdate,
  sessionId?: string,
  conflictStrategy: 'queue' | 'auto_merge' | 'reject' = 'queue',
): ApplyResult {
  update = { ...update, key: normalizeKey(update.key) };
  const existing = Wiki.get(update.key);
  const stamp = now();

  if (!existing) {
    const entry: WikiEntry = {
      wiki_key: update.key,
      front_matter: defaultFrontMatter(update.key, sessionId),
      content_markdown: update.content,
    };
    Wiki.upsert(entry, sessionId);
    writeMarkdown(entry);
    writeVersion(update.key, entry.content_markdown, stamp);
    bus.emit({ type: 'wiki.created', key: update.key });
    return { key: update.key, action: 'created' };
  }

  // Conflict heuristic: substantial replacement of existing content.
  const materiallyDifferent =
    !update.is_diff &&
    existing.content_markdown.length > 200 &&
    similarity(existing.content_markdown, update.content) < 0.4;

  if (materiallyDifferent && conflictStrategy === 'reject') {
    bus.emit({ type: 'wiki.conflict', key: update.key });
    return { key: update.key, action: 'conflict', previous: existing.content_markdown, incoming: update.content };
  }

  const newContent =
    update.is_diff || conflictStrategy === 'auto_merge'
      ? `${existing.content_markdown}\n\n${update.content}`
      : update.content;

  // version previous content before overwrite
  writeVersion(update.key, existing.content_markdown, stamp);

  const entry: WikiEntry = {
    wiki_key: update.key,
    front_matter: {
      ...existing.front_matter,
      status: materiallyDifferent && conflictStrategy === 'queue' ? 'conflict' : 'current',
      last_updated: stamp,
      last_updated_by_session: sessionId,
    },
    content_markdown: newContent,
  };
  Wiki.upsert(entry, sessionId);
  writeMarkdown(entry);

  if (materiallyDifferent && conflictStrategy === 'queue') {
    bus.emit({ type: 'wiki.conflict', key: update.key });
    return { key: update.key, action: 'conflict', previous: existing.content_markdown, incoming: update.content };
  }
  bus.emit({ type: 'wiki.updated', key: update.key });
  return { key: update.key, action: 'updated' };
}

/**
 * Write the reconciled text over a flagged entry and clear the flag.
 *
 * A conflict leaves the entry holding the incoming text under `status:
 * conflict`, with the previous text kept as a version. Whoever decides between
 * them writes the answer back through here rather than through
 * `applyWikiUpdate`, which would compare the answer against what it replaces
 * and flag it all over again — that loop is what queued an endless chain of
 * resolvers.
 */
export function resolveWikiConflict(key: string, content: string, sessionId?: string): void {
  const existing = Wiki.get(normalizeKey(key));
  if (!existing) return;
  const stamp = now();
  writeVersion(existing.wiki_key, existing.content_markdown, stamp);
  const entry: WikiEntry = {
    wiki_key: existing.wiki_key,
    front_matter: { ...existing.front_matter, status: 'current', last_updated: stamp, last_updated_by_session: sessionId },
    content_markdown: content,
  };
  Wiki.upsert(entry, sessionId);
  writeMarkdown(entry);
  bus.emit({ type: 'wiki.updated', key: entry.wiki_key });
}

// crude token-set Jaccard similarity
function similarity(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/));
  const sb = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 1;
}
