// Checkpoint types (spec §14).

import type { ISO8601, TokenBudget } from './common.js';

export type CheckpointTrigger =
  | 'periodic'
  | 'pre-switch'
  | 'manual'
  | 'pre-risky'
  | 'pre-pause'
  | 'task-complete';

export interface CheckpointManifest {
  id: string;
  session_id: string;
  created_at: ISO8601;
  trigger: CheckpointTrigger;
  repository_commit: string;
  repository_path?: string;
  token_usage: TokenBudget;
  task_count: number;
  tasks_completed?: number;
  tasks_remaining?: number;
  reasoning_count: number;
}
