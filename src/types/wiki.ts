// Wiki layer types (spec §9).

import type { ISO8601 } from './common.js';

export type WikiStatus = 'current' | 'stale' | 'deprecated' | 'conflict';

export interface WikiFrontMatter {
  wiki_id: string;
  title: string;
  namespace: string;
  status: WikiStatus;
  confidence: number;
  last_updated: ISO8601;
  last_updated_by_session?: string;
  related_decisions: string[];
  related_files: string[];
  tags: string[];
}

export interface WikiEntry {
  wiki_key: string; // e.g. "architecture/authentication"
  front_matter: WikiFrontMatter;
  content_markdown: string;
}

export interface WikiUpdate {
  key: string;
  content: string; // new content or diff
  is_diff: boolean;
}

export interface WikiSection {
  wiki_key: string;
  title: string;
  content: string; // extracted relevant section
}
