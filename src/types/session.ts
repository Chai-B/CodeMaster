// Session and Task data structures (spec §4.2).

import type { ISO8601, FileRef, ProviderRef, RepositoryRef, TokenBudget } from './common.js';

export type SessionStatus =
  | 'initializing'
  | 'planning'
  | 'active'
  | 'paused'
  | 'completing'
  | 'completed'
  | 'failed';

export interface ParsedObjective {
  goal: string;
  scope: string[];
  constraints: string[];
  keywords: string[];
  task_type: TaskType;
}

export type TaskType =
  | 'plan'
  | 'implement'
  | 'test'
  | 'review'
  | 'verify'
  | 'refactor'
  | 'debug';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped';

export interface Constraint {
  id: string;
  description: string;
  hard: boolean;
}

export interface Question {
  id: string;
  text: string;
  status: 'open' | 'resolved';
  resolution?: string;
}

export interface ExecutionPlan {
  tasks: Task[];
  created_at: ISO8601;
  created_by?: ProviderRef;
}

export interface ProgressState {
  total: number;
  completed: number;
  failed: number;
  current_task_id?: string;
}

export interface ArchitectureSnapshot {
  summary: string;
  components: Record<string, string>;
  updated_at: ISO8601;
}

/** Where the oracle that judged a task came from. A task can never be marked
 *  verified by a test it wrote itself — that is self-grading, not evidence. */
export type OracleProvenance = 'pre-existing' | 'repro-admitted' | 'authored-by-task' | 'none';

/**
 * What actually ran, and what it proved. Replaces trusting the model's own
 * `ir.status`, which defaults to 'completed' and so reported success on code
 * that was never executed.
 */
export interface TaskEvidence {
  verified: boolean;
  provenance: OracleProvenance;
  framework: string;
  ran: boolean;
  passed: number;
  failed: number;
  /** Present when nothing was verified: the reason, in plain words. */
  reason?: string;
}

export interface Task {
  id: string;
  session_id: string;
  parent_task_id?: string;

  title: string;
  description: string;
  type: TaskType;

  status: TaskStatus;

  input_files: FileRef[];
  output_files: FileRef[];

  dependencies: string[];
  blocking: string[];

  assigned_provider?: ProviderRef;

  reasoning_refs: string[];
  decision_refs: string[];

  started_at?: ISO8601;
  completed_at?: ISO8601;
  failed_at?: ISO8601;
  failure_reason?: string;

  estimated_tokens: number;
  actual_tokens?: number;

  /** Deterministic record of what was run to check this task. Absent on tasks
   *  from before the evidence ledger existed. */
  evidence?: TaskEvidence;

  order: number;
}

export interface Session {
  id: string;
  created_at: ISO8601;
  updated_at: ISO8601;
  status: SessionStatus;

  objective: string;
  objective_parsed?: ParsedObjective;

  repository: RepositoryRef;

  plan?: ExecutionPlan;
  progress: ProgressState;

  architecture?: ArchitectureSnapshot;
  decisions: string[];

  constraints: Constraint[];
  open_questions: Question[];

  working_files: FileRef[];

  provider_history: ProviderRef[];
  current_provider?: ProviderRef;

  checkpoints: string[];
  latest_checkpoint?: string;

  token_usage: TokenBudget;

  metadata: Record<string, unknown>;
}
