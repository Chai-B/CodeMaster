// Common shared types used across the system.

export type ISO8601 = string;

export interface FileRef {
  path: string;
  line_start?: number;
  line_end?: number;
}

export interface ProviderRef {
  provider_id: string;
  model_id: string;
  account_id?: string;
}

export interface RepositoryRef {
  path: string;
  commit: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** Thinking tokens, when the vendor reports them separately. Already part of
   *  `output_tokens` — the vendors bill them as output — and carried apart only
   *  so the cost of reasoning can be shown rather than inferred. */
  reasoning_tokens?: number;
  total_tokens: number;
}

export interface TokenBudget {
  total_input: number;
  total_output: number;
  total: number;
  by_provider: Record<string, number>;
  cost_usd: number;
}

export interface Evidence {
  description: string;
  source?: string;
}

export interface Alternative {
  option: string;
  rejected_because: string;
}
