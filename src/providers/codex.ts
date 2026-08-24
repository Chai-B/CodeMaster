// OpenAI Codex provider adapter (spec §13.4-13.5, §15.1).
// Codex returns raw unified diffs; the adapter parses them natively via irFromDiff.

import OpenAI from 'openai';
import { irFromDiff } from '../workers/irFromDiff.js';
import { DIFF_OUTPUT_FORMAT } from '../context/outputFormat.js';
import { CredentialManager } from './credentials.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  Account,
  CompiledPrompt,
  IntermediateRepresentation,
  TokenUsage,
  ModelSpec,
} from '../types/index.js';

export class CodexAdapter implements ProviderAdapter {
  provider_id = 'openai-codex';
  models: ModelSpec[];
  capabilities = {
    max_context_tokens: 32_000,
    supports_streaming: true,
    supports_tool_use: false,
    supports_vision: false,
    native_languages: ['python', 'typescript', 'javascript', 'go', 'rust'],
  };
  characteristics = {
    planning_quality: 2 as const,
    code_generation_quality: 5 as const,
    refactoring_quality: 4 as const,
    speed_tier: 'fast' as const,
    cost_tier: 'cheap' as const,
  };

  constructor(models: ModelSpec[]) {
    this.models = models.length
      ? models
      : [{ id: 'codex-2', context_size: 32_000, cost_per_1m_input: 1.5, cost_per_1m_output: 6 }];
  }

  format_prompt(compiled: CompiledPrompt, model: string): ProviderRequest {
    // Codex is asked for precise unified diffs only (spec §15.1).
    return { system: compiled.system, user: `${compiled.body}\n\n${DIFF_OUTPUT_FORMAT}`, model, max_tokens: 8192 };
  }

  async invoke(request: ProviderRequest, account: Account): Promise<ProviderResponse> {
    const apiKey = resolveKey(account);
    if (!apiKey) throw new Error('No OpenAI API key for Codex. Set OPENAI_API_KEY or add an account.');
    const client = new OpenAI({ apiKey });
    const started = Date.now();
    const resp = await client.chat.completions.create({
      model: request.model,
      max_tokens: request.max_tokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    });
    const latency = Date.now() - started;
    const text = resp.choices[0]?.message?.content ?? '';
    const u = resp.usage;
    return {
      text,
      usage: {
        input_tokens: u?.prompt_tokens ?? 0,
        output_tokens: u?.completion_tokens ?? 0,
        total_tokens: u?.total_tokens ?? 0,
      },
      model: request.model,
      latency_ms: latency,
    };
  }

  parse_response(response: ProviderResponse, sessionId: string, taskId: string): IntermediateRepresentation {
    return irFromDiff(response.text, sessionId, taskId, { provider_id: this.provider_id, model_id: response.model });
  }

  async ping(account: Account): Promise<'healthy' | 'degraded' | 'unavailable'> {
    return resolveKey(account) ? 'healthy' : 'unavailable';
  }

  extract_token_usage(response: ProviderResponse): TokenUsage {
    return response.usage;
  }
}

function resolveKey(account: Account): string | undefined {
  if (account.credential_ref.startsWith('env:')) return process.env[account.credential_ref.slice(4)];
  if (account.credential_ref.startsWith('cred:')) return CredentialManager.retrieve(account.credential_ref.slice(5)) ?? undefined;
  return process.env.OPENAI_API_KEY || account.credential_ref || undefined;
}
