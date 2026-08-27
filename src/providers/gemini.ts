// Google Gemini provider adapter (spec §13.4-13.5).

import { GoogleGenerativeAI } from '@google/generative-ai';
import { irFromJson } from '../workers/irFromJson.js';
import { JSON_OUTPUT_FORMAT } from '../context/outputFormat.js';
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

export class GeminiAdapter implements ProviderAdapter {
  provider_id = 'google';
  models: ModelSpec[];
  capabilities = {
    max_context_tokens: 1_000_000,
    supports_streaming: true,
    supports_tool_use: true,
    supports_vision: true,
    native_languages: ['python', 'typescript', 'javascript', 'go'],
  };
  characteristics = {
    planning_quality: 4 as const,
    code_generation_quality: 4 as const,
    refactoring_quality: 4 as const,
    speed_tier: 'fast' as const,
    cost_tier: 'cheap' as const,
  };

  constructor(models: ModelSpec[]) {
    this.models = models.length
      ? models
      : [{ id: 'gemini-2.5-pro', context_size: 1_000_000, cost_per_1m_input: 1.25, cost_per_1m_output: 5 }];
  }

  format_prompt(compiled: CompiledPrompt, model: string): ProviderRequest {
    // Provider-native output format lives only in the adapter (spec §15.1).
    // A free-form prompt already carries its own contract; overriding it here
    // would hand back JSON to a caller that asked for prose.
    const body = compiled.free_form ? compiled.body : `${compiled.body}\n\n${JSON_OUTPUT_FORMAT}`;
    return { system: compiled.system, user: body, model, max_tokens: compiled.max_output_tokens ?? 8192 };
  }

  async invoke(request: ProviderRequest, account: Account): Promise<ProviderResponse> {
    const apiKey = resolveKey(account);
    if (!apiKey) throw new Error('No Gemini API key. Set GEMINI_API_KEY or add an account.');
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({
      model: request.model,
      systemInstruction: request.system,
      generationConfig: { responseMimeType: 'application/json' },
    });
    const started = Date.now();
    const resp = await model.generateContent(request.user);
    const latency = Date.now() - started;
    const text = resp.response.text();
    const u = resp.response.usageMetadata;
    return {
      text,
      usage: {
        input_tokens: u?.promptTokenCount ?? 0,
        output_tokens: u?.candidatesTokenCount ?? 0,
        total_tokens: u?.totalTokenCount ?? 0,
      },
      model: request.model,
      latency_ms: latency,
    };
  }

  parse_response(response: ProviderResponse, sessionId: string, taskId: string): IntermediateRepresentation {
    return irFromJson(response.text, sessionId, taskId, { provider_id: this.provider_id, model_id: response.model });
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
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || account.credential_ref || undefined;
}
