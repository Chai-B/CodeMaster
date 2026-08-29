// Event catalog (spec §21.2).

import type { ReasoningType } from '../types/index.js';

export type RepositoryEvent =
  | { type: 'repository.file.changed'; path: string; change_type: 'created' | 'modified' | 'deleted' }
  | { type: 'repository.index.updated'; changed_files: string[] }
  | { type: 'repository.map.updated' }
  | { type: 'repository.git.committed'; commit: string };

export type SessionEvent =
  | { type: 'session.created'; session_id: string }
  | { type: 'session.started'; session_id: string }
  | { type: 'session.paused'; session_id: string }
  | { type: 'session.resumed'; session_id: string }
  | { type: 'session.completed'; session_id: string }
  | { type: 'session.failed'; session_id: string; reason: string };

export type TaskEvent =
  | { type: 'task.started'; task_id: string; title: string }
  | { type: 'task.completed'; task_id: string; tokens: number; ms: number }
  | { type: 'task.failed'; task_id: string; reason: string }
  | { type: 'task.blocked'; task_id: string; blockers: string[] };

export type MemoryEvent =
  | { type: 'memory.updated'; id: string; namespace: string }
  | { type: 'memory.compressed'; count: number }
  | { type: 'memory.conflict'; object_a: string; object_b: string };

export type WikiEvent =
  | { type: 'wiki.updated'; key: string }
  | { type: 'wiki.created'; key: string }
  | { type: 'wiki.conflict'; key: string };

export type ReasoningEvent =
  | { type: 'reasoning.new'; id: string; reasoning_type: ReasoningType; summary: string; detail?: string }
  | { type: 'reasoning.merged'; from: string; into: string };

export type ProviderEvent =
  | { type: 'provider.invoked'; provider_id: string; account_id: string }
  | { type: 'provider.response'; provider_id: string; tokens: number }
  | { type: 'provider.error'; provider_id: string; error: string }
  | { type: 'provider.rate_limited'; account_id: string; retry_after_ms: number }
  | { type: 'provider.switched'; from: string; to: string };

export type CheckpointEvent =
  | { type: 'checkpoint.created'; id: string; trigger: string }
  | { type: 'checkpoint.restored'; id: string };

export type QuotaEvent =
  | { type: 'quota.warning'; account_id: string; percent_used: number }
  | { type: 'quota.exhausted'; account_id: string }
  | { type: 'quota.reset'; account_id: string };

export type WorkerEvent =
  | { type: 'worker.started'; worker: string; detail?: string }
  | { type: 'worker.finished'; worker: string; detail?: string };

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success' | 'heading' | 'sep' | 'dim' | 'md';

export type LogEvent = {
  type: 'log';
  level: LogLevel;
  message: string;
};

export type CodeMasterEvent =
  | RepositoryEvent
  | SessionEvent
  | TaskEvent
  | MemoryEvent
  | WikiEvent
  | ReasoningEvent
  | ProviderEvent
  | CheckpointEvent
  | QuotaEvent
  | WorkerEvent
  | LogEvent;

export type EventType = CodeMasterEvent['type'];
