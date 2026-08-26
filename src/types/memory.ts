// Memory system types (spec §7).

import type { ISO8601 } from './common.js';

export type MemoryNamespace =
  | 'architecture'
  | 'conventions'
  | 'preferences'
  | 'goals'
  | 'constraints'
  | 'failures'
  | string;

export interface MemoryLifecycle {
  importance: number;
  confidence: number;
  recency_weight: number;
  reference_count: number;
  permanent: boolean;

  created_at: ISO8601;
  last_accessed_at: ISO8601;
  expires_at?: ISO8601;
}

export interface LongTermMemory {
  id: string;
  namespace: MemoryNamespace;
  key: string;
  value_json: string;
  value_markdown?: string;
  importance: number;
  confidence: number;
  created_at: ISO8601;
  updated_at: ISO8601;
  source_session_id?: string;
  source_decision_id?: string;
  tags: string[];
  permanent: boolean;
}
