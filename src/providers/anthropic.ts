// Anthropic provider adapter (spec §13.5).

import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'child_process';
import { runCli, type CliRun } from './cliRun.js';
import { parseIR } from '../workers/outputParser.js';
import { CredentialManager } from './credentials.js';
import { ConversationLost } from '../types/index.js';
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
  /** Only the CLI path can resume; the SDK path is stateless. */
  get supports_continuation(): boolean {
    return claudeCliAvailable();
  }

  /** `invoke` picks the SDK whenever the account carries a key or token, and
   *  the SDK ignores `conversation` entirely. Reporting CLI availability here
   *  meant solver iterations 2+ were sent as a bare delta with the repository
   *  context stripped — silently, and only on accounts that had a key. */
  continuation_available(account: Account): boolean {
    if (!claudeCliAvailable()) return false;
    const auth = resolveAnthropicAuth(account);
    return !auth.apiKey && !auth.authToken;
  }
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
      max_tokens: compiled.max_output_tokens ?? 8192,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface CliResult {
  result?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * The CLI reports usage limits and API errors in its JSON body while exiting
 * non-zero, so an exit code alone explains nothing. Prefer the body, and fall
 * back to the process-level facts when there is no parseable output.
 */
export function describeCliFailure(r: CliRun, d: CliResult | null): string {
  const body = d ? d.api_error_status || d.result || d.subtype : null;
  const proc = [
    r.error ? `spawn ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}` : null,
    r.signal ? `signal ${r.signal}` : null,
    r.status ? `exit ${r.status}` : null,
    r.stdout ? null : 'empty stdout',
    r.stderr ? `stderr: ${r.stderr.slice(0, 400)}` : null,
  ].filter(Boolean).join('; ');
  return [body ? String(body).slice(0, 400) : null, proc].filter(Boolean).join(' \u00b7 ') || 'no diagnostic available';
}

/** The CLI says a resumed id is unknown in prose, not in a status code. */
export function isMissingConversation(text: string): boolean {
  return /no conversation found|session .*not found|no such session|could not find session/i.test(text);
}

/**
 * Cache reads and cache writes are billed input the CLI reports separately from
 * `input_tokens`, so summing all three is what makes the total match the
 * vendor's own accounting. A renamed field would silently read zero, which is
 * why the shape is pinned by a contract test.
 */
export function usageFromCliResult(d: CliResult): TokenUsage {
  const u = d.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const input = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
  const output = u.output_tokens ?? 0;
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, total_tokens: input + output };
}

async function invokeViaClaudeCli(request: ProviderRequest): Promise<ProviderResponse> {
  const started = Date.now();
  const conv = request.conversation;
  // Resuming replays the vendor's system prompt from its own cache, so the
  // continuation turn carries only the new content. Opening under a chosen id
  // is what makes that id resumable later.
  const args = conv?.resume
    ? ['--resume', conv.id, '-p', '--output-format', 'json']
    : [
        ...(conv ? ['--session-id', conv.id] : []),
        '--model', cliModelAlias(request.model),
        '-p',
        '--system-prompt', request.system,
        '--disallowed-tools', ...CLI_DISALLOWED_TOOLS,
        '--exclude-dynamic-system-prompt-sections',
        '--output-format', 'json',
      ];
  // The CLI emits its whole JSON body at the end, so there is no partial output
  // worth surfacing — the runner's heartbeat is what tells the user it is alive.
  const run = (): Promise<CliRun> => runCli('claude', args, request.user);

  // Empty stdout is a transient CLI-overload symptom that a short retry clears.
  // A structured error body is not transient — a usage limit will not lift in
  // seventeen seconds — so retry only when the CLI produced no output at all.
  // A signalled child is not transient either: Ctrl-C interrupts the CLI too,
  // and retrying it made a cancelled run sit for another seventeen seconds.
  let r = await run();
  for (let attempt = 0; !r.stdout && !r.signal && attempt < 3; attempt++) {
    await sleep([2000, 5000, 10000][attempt]!);
    r = await run();
  }

  let d: CliResult | null = null;
  try {
    if (r.stdout) d = JSON.parse(r.stdout) as CliResult;
  } catch {
    d = null;
  }
  if (!d || r.status !== 0 || d.is_error || d.api_error_status || !d.result) {
    const detail = describeCliFailure(r, d);
    // A stale conversation is recoverable by recompiling; a usage limit is not.
    if (conv?.resume && isMissingConversation(detail)) throw new ConversationLost(detail);
    throw new Error(`claude CLI failed (${detail})`);
  }

  return {
    text: d.result,
    usage: usageFromCliResult(d),
    model: request.model,
    latency_ms: Date.now() - started,
  };
}

function hasCredential(account: Account): boolean {
  const a = resolveAnthropicAuth(account);
  return Boolean(a.apiKey || a.authToken) || claudeCliAvailable();
}
