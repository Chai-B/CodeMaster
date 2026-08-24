// WikiReader — relevance-based section extraction (spec §9.4, §12.2, never LLM).

import { Wiki } from '../storage/wiki.js';
import type { WikiSection, TaskType } from '../types/index.js';

// Namespaces most relevant per task type.
// Only namespaces some writer actually produces: bootstrap emits `architecture`,
// `modules`, `conventions` and `external_docs`; everything else (LLM wiki
// updates, /wiki) is normalized into `notes` by updater.normalizeKey. The old
// table asked for `decisions`, `roadmap` and `failures`, which no writer has
// ever created — those live in the reasoning and failure stores, not the wiki.
const NAMESPACE_PRIORITY: Record<TaskType, string[]> = {
  plan: ['architecture', 'modules', 'conventions', 'notes'],
  implement: ['conventions', 'architecture', 'modules'],
  test: ['conventions', 'modules'],
  review: ['conventions', 'architecture', 'notes'],
  verify: ['conventions', 'architecture'],
  refactor: ['architecture', 'conventions', 'modules'],
  debug: ['modules', 'architecture', 'notes'],
};

export function readRelevantSections(
  taskType: TaskType,
  keywords: string[],
  limit = 8,
): WikiSection[] {
  const priorities = NAMESPACE_PRIORITY[taskType] ?? ['architecture', 'conventions'];
  const scored = new Map<string, { section: WikiSection; score: number }>();

  // namespace-priority candidates
  for (let i = 0; i < priorities.length; i++) {
    for (const e of Wiki.byNamespace(priorities[i]!)) {
      scored.set(e.wiki_key, {
        section: { wiki_key: e.wiki_key, title: e.front_matter.title, content: firstSection(e.content_markdown) },
        score: (priorities.length - i) * 2 + keywordScore(e.content_markdown, keywords),
      });
    }
  }

  // keyword search across all entries
  for (const kw of keywords) {
    for (const e of Wiki.search(kw, 5)) {
      const prev = scored.get(e.wiki_key);
      const score = (prev?.score ?? 0) + 3;
      scored.set(e.wiki_key, {
        section: prev?.section ?? {
          wiki_key: e.wiki_key,
          title: e.front_matter.title,
          content: firstSection(e.content_markdown),
        },
        score,
      });
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.section);
}

export function readConventions(limit = 6): WikiSection[] {
  return Wiki.byNamespace('conventions')
    .slice(0, limit)
    .map((e) => ({ wiki_key: e.wiki_key, title: e.front_matter.title, content: firstSection(e.content_markdown) }));
}

export function readArchitecture(): string {
  const overview = Wiki.get('architecture/overview');
  if (overview) return overview.content_markdown;
  const all = Wiki.byNamespace('architecture');
  return all.map((e) => `### ${e.front_matter.title}\n${firstSection(e.content_markdown)}`).join('\n\n');
}

function keywordScore(content: string, keywords: string[]): number {
  const lower = content.toLowerCase();
  let s = 0;
  for (const k of keywords) if (lower.includes(k.toLowerCase())) s += 1;
  return s;
}

// Extract the Summary section (or first ~600 chars) to keep injections small.
function firstSection(md: string): string {
  const summary = /##\s*Summary\s*\n([\s\S]*?)(?:\n##\s|\n#\s|$)/.exec(md);
  if (summary) return summary[1]!.trim().slice(0, 800);
  return md.replace(/^#.*\n/, '').trim().slice(0, 600);
}
