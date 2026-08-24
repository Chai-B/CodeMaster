// Anthropic provider adapter (spec §13.5).

import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'child_process';
import { parseIR } from '../workers/outputParser.js';
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

export class AnthropicAdapter implements ProviderAdapter {
  provider_id = 'anthropic';
  models: ModelSpec[];
  capabilities = {
    max_context_tokens: 200_000,
    supports_streaming: true,
    supports_tool_use: true,
    supports_vision: true,
    native_languages: ['typescript', 'python', 'rust', 'go', 'javascript'],
  };
  characteristics = {
    planning_quality: 5 as const,
    code_generation_quality: 5 as const,
    refactoring_quality: 5 as const,
    speed_tier: 'medium' as const,
    cost_tier: 'expensive' as const,
  };

  constructor(models: ModelSpec[]) {
    this.models = models;
  }

  format_prompt(compiled: CompiledPrompt, model: string): ProviderRequest {
    return {
      system: compiled.system,
      user: compiled.body,
      model,
      max_tokens: 8192,
    };
  }

  async invoke(request: ProviderRequest, account: Account): Promise<ProviderResponse> {
    const auth = resolveAnthropicAuth(account);
    // No API key / OAuth token, but the authenticated Claude CLI is present →
    // run on the user's Claude subscription via the CLI (spec §13 account creds).
    if (!auth.apiKey && !auth.authToken) {
      if (claudeCliAvailable()) return invokeViaClaudeCli(request);
      throw new Error('No Anthropic credentials. Set ANTHROPIC_API_KEY, run `claude setup-token`, or install the authenticated `claude` CLI.');
    }
    const client = new Anthropic(auth.authToken ? { authToken: auth.authToken } : { apiKey: auth.apiKey });
    const started = Date.now();
    const resp = await client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    });
    const latency = Date.now() - started;
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage = resp.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };
    return {
      text,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_input_tokens ?? undefined,
        cache_write_tokens: usage.cache_creation_input_tokens ?? undefined,
        total_tokens: usage.input_tokens + usage.output_tokens,
      },
      model: request.model,
      latency_ms: latency,
    };
  }

  parse_response(response: ProviderResponse, sessionId: string, taskId: string): IntermediateRepresentation {
    return parseIR(response.text, sessionId, taskId, {
      provider_id: this.provider_id,
      model_id: response.model,
    });
  }

  async ping(account: Account): Promise<'healthy' | 'degraded' | 'unavailable'> {
    return hasCredential(account) ? 'healthy' : 'unavailable';
  }

  extract_token_usage(response: ProviderResponse): TokenUsage {
    return response.usage;
  }
}

/**
 * Resolve credentials for Anthropic. Prefers an account OAuth token (Claude
 * subscription login, e.g. CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`)
 * over a raw API key — so the tool works with account creds, not just API keys.
 */
export function resolveAnthropicAuth(account: Account): { apiKey?: string; authToken?: string } {
  // Explicit per-account references.
  if (account.credential_ref.startsWith('oauth:')) return { authToken: account.credential_ref.slice(6) };
  if (account.credential_ref.startsWith('env:')) {
    const v = process.env[account.credential_ref.slice(4)];
    if (v) return account.credential_ref.includes('OAUTH') || account.credential_ref.includes('AUTH_TOKEN') ? { authToken: v } : { apiKey: v };
  }
  if (account.credential_ref.startsWith('cred:')) {
    const v = credentialFromStore(account.credential_ref.slice(5));
    if (v) return account.auth_type === 'oauth' ? { authToken: v } : { apiKey: v };
  }
  // Environment fallbacks — OAuth token first (account creds), then API key.
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  if (oauth) return { authToken: oauth };
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY };
  if (account.credential_ref && !account.credential_ref.includes(':')) return { apiKey: account.credential_ref };
  return {};
}

function credentialFromStore(id: string): string | undefined {
  return CredentialManager.retrieve(id) ?? undefined;
}

let _cliChecked: boolean | null = null;
export function claudeCliAvailable(): boolean {
  if (_cliChecked !== null) return _cliChecked;
  try {
    _cliChecked = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    _cliChecked = false;
  }
  return _cliChecked;
}

const CLI_DISALLOWED_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'NotebookEdit'];

/**
 * Single-shot completion via the authenticated `claude` CLI (Claude Pro/Max
 * subscription). CodeMaster has already compiled the context, so tools are
 * disabled — the model only completes from the provided context.
 */
// The full model id (e.g. claude-sonnet-4-6) makes the CLI request the 1M-context
// beta, which requires usage credits. CodeMaster's compiled context always fits
// the standard 200k window, so we use the short alias, which stays on standard
// context — same model, no credit gate.
function cliModelAlias(model: string): string {
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/opus/i.test(model)) return 'opus';
  if (/haiku/i.test(model)) return 'haiku';
  return model;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function invokeViaClaudeCli(request: ProviderRequest): ProviderResponse {
  const started = Date.now();
  const args = [
    '--model', cliModelAlias(request.model),
    '-p',
    '--system-prompt', request.system,
    '--disallowed-tools', ...CLI_DISALLOWED_TOOLS,
    '--exclude-dynamic-system-prompt-sections',
    '--output-format', 'json',
  ];
  // Empty stdout is a transient CLI-overload symptom that a short retry clears.
  // Retry in-process so one flaky call doesn't fail an otherwise-healthy task.
  let r = spawnSync('claude', args, { input: request.user, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (let attempt = 0; (r.status !== 0 || !r.stdout) && attempt < 3; attempt++) {
    sleepSync([2000, 5000, 10000][attempt]!);
    r = spawnSync('claude', args, { input: request.user, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }
  if (r.status !== 0 || !r.stdout) {
    // Report what actually happened. "transient overload" was a guess that hid
    // spawn errors, signals and non-zero exits behind one indistinguishable
    // message, leaving nothing to debug when a run failed.
    const why = [
      r.error ? `spawn ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}` : null,
      r.signal ? `signal ${r.signal}` : null,
      r.status !== 0 && r.status !== null ? `exit ${r.status}` : null,
      r.stdout ? null : 'empty stdout',
      r.stderr ? `stderr: ${r.stderr.slice(0, 400)}` : null,
    ].filter(Boolean).join('; ');
    throw new Error(`claude CLI failed (${why || 'no diagnostic available'})`);
  }
  const d = JSON.parse(r.stdout) as {
    result?: string;
    is_error?: boolean;
    api_error_status?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  if (d.is_error || d.api_error_status || !d.result) {
    throw new Error(`claude CLI: ${d.api_error_status || 'empty result (transient overload)'}`);
  }
  const u = d.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const input = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
  const output = u.output_tokens ?? 0;
  return {
    text: d.result ?? '',
    usage: { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, total_tokens: input + output },
    model: request.model,
    latency_ms: Date.now() - started,
  };
}

function hasCredential(account: Account): boolean {
  const a = resolveAnthropicAuth(account);
  return Boolean(a.apiKey || a.authToken) || claudeCliAvailable();
}
