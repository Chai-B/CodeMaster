// Provider and account types (spec §13).

import type { ISO8601, TokenUsage } from './common.js';
import type { CompiledPrompt } from './context.js';
import type { IntermediateRepresentation } from './ir.js';

export interface ProviderCapabilities {
  max_context_tokens: number;
  supports_streaming: boolean;
  supports_tool_use: boolean;
  supports_vision: boolean;
  native_languages: string[];
}

export interface ProviderCharacteristics {
  planning_quality: 1 | 2 | 3 | 4 | 5;
  code_generation_quality: 1 | 2 | 3 | 4 | 5;
  refactoring_quality: 1 | 2 | 3 | 4 | 5;
  speed_tier: 'fast' | 'medium' | 'slow';
  cost_tier: 'cheap' | 'medium' | 'expensive';
}

export interface ModelSpec {
  id: string;
  context_size: number;
  cost_per_1m_input: number;
  cost_per_1m_output: number;
  /** Fraction of the input price charged for a token served from the vendor's
   *  prefix cache. Omitted means the Anthropic-style default (a tenth). */
  cache_read_multiplier?: number;
  /** Fraction of the input price charged to write a token into that cache.
   *  Omitted means the Anthropic-style default (a quarter more than fresh). */
  cache_write_multiplier?: number;
}

export interface AccountQuota {
  daily_token_limit: number;
  tokens_used_today: number;
  rate_limit_rpm: number;
  rate_limit_tpm: number;
  current_rpm: number;
  current_tpm: number;
  context_size: number;
  resets_at: ISO8601;
}

export interface AccountHealth {
  status: 'healthy' | 'degraded' | 'unavailable';
  last_latency_ms: number;
  avg_latency_ms: number;
  error_rate_last_hour: number;
  last_checked_at: ISO8601;
  unavailable_since?: ISO8601;
  unavailable_reason?: string;
}

export interface Account {
  id: string;
  provider_id: string;
  alias: string;
  credential_ref: string;
  auth_type: 'api_key' | 'oauth';
  quota: AccountQuota;
  health: AccountHealth;
  current_session_id?: string;
  last_used_at: ISO8601;
}

export interface ProviderRequest {
  system: string;
  user: string;
  model: string;
  max_tokens: number;
  /**
   * Continue one vendor-side conversation across solver iterations instead of
   * opening a fresh one each time. The vendor's own system prompt and tooling
   * cost tens of thousands of tokens per invocation; resuming pays that once
   * per task rather than once per iteration. `resume: false` opens the
   * conversation under this id, `true` continues it and `user` carries only the
   * new turn.
   */
  conversation?: { id: string; resume: boolean };
  /** Extended-thinking budget in tokens. Set from the role's effort level;
   *  adapters that cannot vary reasoning depth ignore it. */
  thinking_tokens?: number;
}

export interface ProviderResponse {
  text: string;
  usage: TokenUsage;
  model: string;
  latency_ms: number;
  /**
   * The model's own thinking, when the vendor returns it. Reasoning tokens are
   * billed whether or not anyone reads them, and the adapters used to request
   * extended thinking and then drop every block that was not the answer. Kept
   * so the run can show its working and so the next call can be told what was
   * already worked out.
   */
  reasoning?: string;
}

/** Thrown when a conversation id no longer exists vendor-side. The caller
 *  recompiles the full context and retries once without continuation. */
export class ConversationLost extends Error {
  constructor(detail: string) {
    super(`Conversation lost: ${detail}`);
    this.name = 'ConversationLost';
  }
}

export interface ProviderAdapter {
  provider_id: string;
  /** True when `ProviderRequest.conversation` is honoured. Stateless SDK
   *  adapters leave this false and always receive the full context. */
  supports_continuation?: boolean;
  /** Whether continuation works for THIS account. An adapter that can resume
   *  over one credential and not another must answer here: a wrong `true` sends
   *  a bare delta to a stateless path, and the turn arrives with no repository
   *  context at all. */
  continuation_available?(account: Account): boolean;
  models: ModelSpec[];
  capabilities: ProviderCapabilities;
  characteristics: ProviderCharacteristics;

  format_prompt(compiled: CompiledPrompt, model: string): ProviderRequest;
  invoke(request: ProviderRequest, account: Account): Promise<ProviderResponse>;
  parse_response(
    response: ProviderResponse,
    session_id: string,
    task_id: string,
  ): IntermediateRepresentation;
  ping(account: Account): Promise<AccountHealth['status']>;
  extract_token_usage(response: ProviderResponse): TokenUsage;
}

/** What one LLM call is FOR. Not the task's type: a single `implement` task
 *  makes a solve call, an oracle call and a review call, and they do not need
 *  the same model. This is the routing key. */
export const LLM_ROLES = ['solve', 'plan', 'oracle', 'review', 'summarize', 'merge'] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/** How hard the model should think before answering. Orthogonal to which model
 *  answers: opus at 'low' and opus at 'high' are the same weights and very
 *  different prices, so a role can buy reasoning depth without buying a bigger
 *  model. Providers that cannot vary effort ignore it. */
export type LlmEffort = 'low' | 'medium' | 'high';

/** How much model one job is worth, resolved per call from what the job
 *  actually looks like rather than fixed for the whole run. 'standard' is
 *  whatever `providers.default` names; 'light' and 'heavy' are the cheapest and
 *  strongest models on that same vendor. Orthogonal to effort: this picks the
 *  weights, effort picks how long they think. */
export type LlmTier = 'light' | 'standard' | 'heavy';

/** A role's routing entry. A bare string is the model id at default effort —
 *  the common case, and what configs written before effort existed contain. */
export type RoleRouting = string | { model?: string; effort?: LlmEffort };
