// Intermediate Representation — provider-agnostic model output (spec §15).

import type { ISO8601, FileRef, ProviderRef } from './common.js';
import type { Decision, Observation, Risk, Assumption, Thinking } from './reasoning.js';
import type { WikiUpdate } from './wiki.js';
import type { TaskType } from './session.js';

export type IRStatus =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'blocked'
  | 'needs_clarification';

export interface Patch {
  file: string;
  diff: string; // unified diff
}

export interface NewFile {
  path: string;
  content: string;
}

export interface FileRename {
  from: string;
  to: string;
}

export interface TaskSpec {
  title: string;
  description?: string;
  type?: TaskType;
  priority: 'high' | 'medium' | 'low';
  depends_on?: string[]; // titles/ids of tasks that must complete first (spec §4.2.2)
}

export interface IRQuestion {
  text: string;
}

export interface IntermediateRepresentation {
  ir_version: '1.0';
  session_id: string;
  task_id: string;
  produced_by: ProviderRef;
  produced_at: ISO8601;

  status: IRStatus;
  summary: string;

  patches: Patch[];
  files_created: NewFile[];
  files_deleted: FileRef[];
  files_renamed: FileRename[];

  decisions: Decision[];
  observations: Observation[];
  risks: Risk[];
  assumptions: Assumption[];
  /** The model's own thinking for this call, when the vendor returned it. */
  thinking?: Thinking[];

  wiki_updates: WikiUpdate[];
  wiki_reads: string[];

  next_tasks: TaskSpec[];
  blocked_by: string[];
  open_questions: IRQuestion[];

  clarification_needed?: string;
  overall_confidence: number;

  raw_output?: string;
}
