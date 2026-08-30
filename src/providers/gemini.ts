// Google Gemini provider adapter (spec §13.4-13.5).

import { GoogleGenerativeAI } from '@google/generative-ai';
import { irFromJson } from '../workers/irFromJson.js';
import { JSON_OUTPUT_FORMAT } from '../context/outputFormat.js';
import { CredentialManager } from './credentials.js';
import { cliEnvFor, cliSignedIn } from './cliAuth.js';
import { runCli } from './cliRun.js';
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
    // No key but the signed-in `gemini` CLI is present -> run on the user's
    // Google account, the same way the Anthropic and Codex adapters fall back to
    // theirs. Without this, signing in with the Gemini CLI bought nothing.
    if (!apiKey) {
      if (geminiCliAvailable()) return await invokeViaGeminiCli(request, cliEnvFor('google', account.credential_ref));
      throw new Error('No Google credentials. Set GEMINI_API_KEY, or sign in with the `gemini` CLI via /account login.');
    }
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
    return resolveKey(account) || geminiCliAvailable() ? 'healthy' : 'unavailable';
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

/** Installed *and* signed in — see the note on `claudeCliAvailable`. */
export function geminiCliAvailable(): boolean {
  return cliSignedIn('google');
}

/**
 * Single-shot completion via the signed-in `gemini` CLI. The context is already
 * compiled, so the prompt says so — otherwise the CLI explores the repository
 * itself and re-derives what the compiler just supplied.
 *
 * `-o json` is asked for because the plain output is prose with no token counts
 * at all: this path used to record zeros for every call. The JSON body is
 * `{ session_id, response, stats, error? }`, and `stats.models[<model>].tokens`
 * carries the real numbers, thinking tokens among them.
 */
async function invokeViaGeminiCli(request: ProviderRequest, env: NodeJS.ProcessEnv): Promise<ProviderResponse> {
  const started = Date.now();
  const input = `${request.system}\n\nAll context needed is below. Do not read files or run commands; answer from the context provided.\n\n${request.user}`;
  const r = await runCli('gemini', ['-m', request.model, '-o', 'json', '-p', input], '', undefined, env);
  const body = parseGeminiJson(r.stdout ?? '');
  const text = (body?.response ?? '').trim();
  if (r.status !== 0 || !text) {
    const why = [
      body?.error ? `${body.error.type}: ${body.error.message}` : null,
      r.error ? `spawn ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}` : null,
      r.signal ? `signal ${r.signal}` : null,
      r.status ? `exit ${r.status}` : null,
      text ? null : 'no output',
      r.stderr ? `stderr: ${r.stderr.slice(0, 400)}` : null,
    ].filter(Boolean).join('; ');
    throw new Error(`gemini CLI failed (${why || 'no diagnostic available'})`);
  }
  return {
    text,
    usage: usageFromGeminiStats(body?.stats),
    model: request.model,
    latency_ms: Date.now() - started,
  };
}

interface GeminiTokens {
  input?: number;
  prompt?: number;
  candidates?: number;
  total?: number;
  cached?: number;
  thoughts?: number;
}

export interface GeminiJson {
  response?: string;
  error?: { type?: string; message?: string };
  stats?: { models?: Record<string, { tokens?: GeminiTokens }> };
}

/** The CLI prints a banner before the body on a first run in a directory, so
 *  the JSON is found rather than assumed to start at character zero. */
export function parseGeminiJson(out: string): GeminiJson | null {
  const start = out.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(out.slice(start)) as GeminiJson;
  } catch {
    return null;
  }
}

/** Summed across models, because a single call can route through more than one
 *  (a flash pre-pass in front of pro). Thinking is billed as output and the CLI
 *  reports it separately, so it is folded in rather than left uncounted. */
export function usageFromGeminiStats(stats: GeminiJson['stats']): TokenUsage {
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const m of Object.values(stats?.models ?? {})) {
    const t = m.tokens ?? {};
    input += t.prompt ?? t.input ?? 0;
    output += (t.candidates ?? 0) + (t.thoughts ?? 0);
    cached += t.cached ?? 0;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cached || undefined,
    total_tokens: input + output,
  };
}
