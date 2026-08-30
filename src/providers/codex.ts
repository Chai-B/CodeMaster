// OpenAI Codex provider adapter (spec §13.4-13.5, §15.1).
// Codex returns raw unified diffs; the adapter parses them natively via irFromDiff.

import OpenAI from 'openai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCli } from './cliRun.js';
import { cliEnvFor, cliSignedIn } from './cliAuth.js';
import { bus } from '../events/bus.js';
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
    max_context_tokens: 200_000,
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
      : [{ id: 'gpt-5-codex', context_size: 200_000, cost_per_1m_input: 1.25, cost_per_1m_output: 10 }];
  }

  format_prompt(compiled: CompiledPrompt, model: string): ProviderRequest {
    // Codex is asked for precise unified diffs only (spec §15.1).
    // A free-form prompt already carries its own contract; overriding it here
    // would hand back JSON to a caller that asked for prose.
    const body = compiled.free_form ? compiled.body : `${compiled.body}\n\n${DIFF_OUTPUT_FORMAT}`;
    return { system: compiled.system, user: body, model, max_tokens: compiled.max_output_tokens ?? 8192 };
  }

  async invoke(request: ProviderRequest, account: Account): Promise<ProviderResponse> {
    const apiKey = resolveKey(account);
    // No API key but the authenticated `codex` CLI is present -> run on the
    // user's ChatGPT subscription, the same way the Anthropic adapter falls back
    // to the `claude` CLI. This is what gives failover a second vendor to reach.
    if (!apiKey) {
      if (codexCliAvailable()) return await invokeViaCodexCli(request, cliEnvFor('openai-codex', account.credential_ref));
      throw new Error('No OpenAI credentials for Codex. Set OPENAI_API_KEY or install the authenticated `codex` CLI.');
    }
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
    return resolveKey(account) || codexCliAvailable() ? 'healthy' : 'unavailable';
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

/** Installed *and* signed in — see the note on `claudeCliAvailable`. */
export function codexCliAvailable(): boolean {
  return cliSignedIn('openai-codex');
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

/**
 * Surface the steps Codex reports, and keep the reasoning it emits alongside
 * them — the event stream also carries deltas and bookkeeping that would flood
 * the log, so those are dropped.
 *
 * Reasoning items are billed output. They used to go to a debug log that the
 * TUI never shows, which meant paying for the model's thinking and discarding
 * it; `sink` is where it is kept instead.
 */
function reportEvent(line: string, sink: string[]): void {
  if (!line.includes('item.completed')) return;
  try {
    const ev = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
    if (ev.type !== 'item.completed' || !ev.item) return;
    const kind = ev.item.type ?? 'step';
    if (kind === 'agent_message') return; // the answer itself; parsed from the output file
    const text = ev.item.text ?? '';
    if (kind === 'reasoning' && text.trim()) {
      sink.push(text.trim());
      bus.emit({ type: 'log', level: 'debug', message: `codex thinking — ${text.slice(0, 120)}` });
      return;
    }
    bus.emit({ type: 'log', level: 'debug', message: `codex: ${kind}${text ? ` — ${text.slice(0, 120)}` : ''}` });
  } catch {
    // A partial line is not worth reporting.
  }
}

/** Last `turn.completed` usage in the JSONL event stream — the only real token
 *  numbers the CLI reports. Absent means we record nothing rather than guess. */
export function usageFromEvents(jsonl: string): CodexUsage | null {
  let found: CodexUsage | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('turn.completed')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; usage?: CodexUsage };
      if (ev.type === 'turn.completed' && ev.usage) found = ev.usage;
    } catch {
      // Partial line; the next complete one wins.
    }
  }
  return found;
}

/**
 * Single-shot completion via the authenticated `codex` CLI (ChatGPT plan).
 * CodeMaster has already compiled the context, so the sandbox is read-only and
 * the prompt states the context is complete — otherwise Codex explores the repo
 * on its own and spends tokens re-deriving what the compiler already supplied.
 */
async function invokeViaCodexCli(request: ProviderRequest, env: NodeJS.ProcessEnv): Promise<ProviderResponse> {
  const started = Date.now();
  const thinking: string[] = [];
  const outFile = path.join(os.tmpdir(), `codex-out-${process.pid}-${Date.now()}.txt`);
  const args = [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--output-last-message', outFile,
    '-',
  ];
  // Codex has no system-prompt flag, so the system block is prepended.
  const input = `${request.system}\n\nAll context needed is below. Do not read files or run commands; answer from the context provided.\n\n${request.user}`;
  try {
    // Codex streams a JSONL event per step, so the work it is doing can be
    // reported as it happens instead of after the fact.
    const r = await runCli('codex', args, input, (line) => reportEvent(line, thinking), env);
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    if (r.status !== 0 || !text) {
      const why = [
        r.error ? `spawn ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}` : null,
        r.signal ? `signal ${r.signal}` : null,
        r.status ? `exit ${r.status}` : null,
        text ? null : 'no final message',
        r.stderr ? `stderr: ${r.stderr.slice(0, 400)}` : null,
      ].filter(Boolean).join('; ');
      throw new Error(`codex CLI failed (${why || 'no diagnostic available'})`);
    }
    const u = usageFromEvents(r.stdout ?? '') ?? {};
    const cacheRead = u.cached_input_tokens ?? 0;
    const input_tokens = u.input_tokens ?? 0;
    const output_tokens = u.output_tokens ?? 0;
    return {
      text,
      usage: { input_tokens, output_tokens, cache_read_tokens: cacheRead, total_tokens: input_tokens + output_tokens },
      model: request.model,
      latency_ms: Date.now() - started,
      reasoning: thinking.join('\n\n') || undefined,
    };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}
