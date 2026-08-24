// WikiUpdater — applies updates with versioning + conflict detection (spec §9.3).

import { Wiki } from '../storage/wiki.js';
import { bus } from '../events/bus.js';
import { now } from '../util/id.js';
import { writeMarkdown, writeVersion } from './markdown.js';
import type { WikiEntry, WikiUpdate, WikiFrontMatter } from '../types/index.js';

function deriveMeta(key: string): { namespace: string; title: string } {
  const parts = key.split('/');
  const namespace = parts[0] ?? 'general';
  const leaf = parts[parts.length - 1] ?? key;
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
  const existing = Wiki.get(update.key);
  const stamp = now();

  if (!existing) {
    const entry: WikiEntry = {
      wiki_key: update.key,
      front_matter: defaultFrontMatter(update.key, sessionId),
      content_markdown: update.content,
    };
    Wiki.upsert(entry, sessionId);
    Wiki.saveVersion(update.key, entry.content_markdown, sessionId, 'created');
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
    return { key: update.key, action: 'conflict' };
  }

  const newContent =
    update.is_diff || conflictStrategy === 'auto_merge'
      ? `${existing.content_markdown}\n\n${update.content}`
      : update.content;

  // version previous content before overwrite
  Wiki.saveVersion(update.key, existing.content_markdown, sessionId, 'pre-update');
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
    return { key: update.key, action: 'conflict' };
  }
  bus.emit({ type: 'wiki.updated', key: update.key });
  return { key: update.key, action: 'updated' };
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
