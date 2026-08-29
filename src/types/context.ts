// Context compiler types (spec §10-11).

import type { ISO8601 } from './common.js';
import type { TaskType } from './session.js';

export enum ContextComponent {
  OBJECTIVE = 'objective',
  EXECUTION_PLAN = 'execution_plan',
  CURRENT_TASK = 'current_task',
  SESSION_STATE = 'session_state',
  ARCHITECTURE = 'architecture',
  REPOSITORY_MAP = 'repository_map',
  RELEVANT_FILES = 'relevant_files',
  RECENT_CHANGES = 'recent_changes',
  PRIOR_REASONING = 'prior_reasoning',
  OPEN_QUESTIONS = 'open_questions',
  CONSTRAINTS = 'constraints',
  KNOWN_FAILURES = 'known_failures',
  CONVENTIONS = 'conventions',
  WIKI_SECTIONS = 'wiki_sections',
  CHECKPOINT_STATE = 'checkpoint_state',
  PROVIDER_HANDOFF = 'provider_handoff',
  INSTRUCTIONS = 'instructions',
  OUTPUT_FORMAT = 'output_format',
}

export type BudgetProfile = Partial<Record<ContextComponent | 'scratchpad', number>>;

export interface CompiledComponent {
  component: ContextComponent;
  heading: string;
  content: string;
  estimated_tokens: number;
}

export interface CompiledPrompt {
  /** Cap on the model's own output. A worker asking for a 40-line test does not
   *  need the 8192-token default, and paying for it buys nothing. */
  max_output_tokens?: number;
  session_id: string;
  task_id: string;
  task_type: TaskType;
  compiled_at: ISO8601;

  system: string;
  /** The prompt asks for prose, not the IR envelope. Adapters with a native
   *  structured format must not override it — the caller wants an answer a
   *  person reads, not one a parser does. */
  free_form?: boolean;
  components: CompiledComponent[];
  body: string; // full assembled markdown

  total_tokens: number;
  max_tokens: number;
  included: ContextComponent[];
  omitted: ContextComponent[];
  /** Tokens spent embedding each file, so the executor can measure how many of
   *  them the response never referenced (token-discipline W3). */
  file_costs?: Array<{ path: string; tokens: number; reasons?: string[] }>;
}
