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
}

export interface ProviderResponse {
  text: string;
  usage: TokenUsage;
  model: string;
  latency_ms: number;
}

export interface ProviderAdapter {
  provider_id: string;
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
