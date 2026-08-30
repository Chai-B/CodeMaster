// opencode provider adapter.
//
// opencode is a CLI in front of whichever model the user signed it in to, so
// this adapter owns no SDK: every call goes through `opencode run`. The JSON
// event stream is asked for rather than the formatted output, because it is the
// only surface that carries token counts, and `--thinking` is asked for because
// the reasoning is billed either way.

import { runCli } from './cliRun.js';
import { cliEnvFor, cliSignedIn } from './cliAuth.js';
import { bus } from '../events/bus.js';
import { irFromDiff } from '../workers/irFromDiff.js';
import { DIFF_OUTPUT_FORMAT } from '../context/outputFormat.js';
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

export class OpencodeAdapter implements ProviderAdapter {
  provider_id = 'opencode';
  models: ModelSpec[];
  capabilities = {
    max_context_tokens: 200_000,
    supports_streaming: true,
    supports_tool_use: false,
    supports_vision: false,
    native_languages: ['python', 'typescript', 'javascript', 'go', 'rust'],
  };
  characteristics = {
    planning_quality: 3 as const,
    code_generation_quality: 4 as const,
    refactoring_quality: 3 as const,
    speed_tier: 'medium' as const,
    cost_tier: 'cheap' as const,
  };

  constructor(models: ModelSpec[]) {
    this.models = models.length
      ? models
      : [{ id: 'opencode/deepseek-v4-flash-free', context_size: 200_000, cost_per_1m_input: 0, cost_per_1m_output: 0 }];
  }

  format_prompt(compiled: CompiledPrompt, model: string): ProviderRequest {
    const body = compiled.free_form ? compiled.body : `${compiled.body}\n\n${DIFF_OUTPUT_FORMAT}`;
    return { system: compiled.system, user: body, model, max_tokens: compiled.max_output_tokens ?? 8192 };
  }

  async invoke(request: ProviderRequest, account: Account): Promise<ProviderResponse> {
    if (!opencodeCliAvailable()) throw new Error('opencode CLI is not signed in — run `opencode auth login`.');
    return await invokeViaOpencodeCli(request, cliEnvFor('opencode', account.credential_ref));
  }

  parse_response(response: ProviderResponse, sessionId: string, taskId: string): IntermediateRepresentation {
    return irFromDiff(response.text, sessionId, taskId, { provider_id: this.provider_id, model_id: response.model });
  }

  async ping(): Promise<'healthy' | 'degraded' | 'unavailable'> {
    return opencodeCliAvailable() ? 'healthy' : 'unavailable';
  }

  extract_token_usage(response: ProviderResponse): TokenUsage {
    return response.usage;
  }
}

/** Installed *and* signed in — the binary alone answers no useful question. */
export function opencodeCliAvailable(): boolean {
  return cliSignedIn('opencode');
}

/** One line of `opencode run --format json`: every event is this envelope with
 *  the event's own fields merged in. */
interface OpencodeEvent {
  type?: string;
  error?: { name?: string; data?: { message?: string } };
  part?: {
    text?: string;
    tool?: string;
    cost?: number;
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  };
}

export interface OpencodeResult {
  text: string;
  reasoning: string;
  usage: TokenUsage;
  error?: string;
}

/**
 * Fold the event stream into an answer. Tokens are summed across steps rather
 * than taken from the last one: a call that used a tool reports one
 * `step_finish` per step and only the total is what the run was charged.
 */
export function foldOpencodeEvents(lines: Iterable<string>): OpencodeResult {
  const text: string[] = [];
  const reasoning: string[] = [];
  let input = 0;
  let output = 0;
  let cached = 0;
  let error: string | undefined;

  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    let ev: OpencodeEvent;
    try {
      ev = JSON.parse(line) as OpencodeEvent;
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'text':
        if (ev.part?.text) text.push(ev.part.text);
        break;
      case 'reasoning':
        if (ev.part?.text) reasoning.push(ev.part.text);
        break;
      case 'step_finish': {
        const t = ev.part?.tokens;
        if (!t) break;
        input += t.input ?? 0;
        // Reasoning is billed as output and reported apart from it.
        output += (t.output ?? 0) + (t.reasoning ?? 0);
        cached += t.cache?.read ?? 0;
        break;
      }
      case 'error':
        error = ev.error?.data?.message ?? ev.error?.name ?? 'unknown error';
        break;
    }
  }

  return {
    text: text.join('\n').trim(),
    reasoning: reasoning.join('\n\n').trim(),
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cached || undefined,
      total_tokens: input + output,
    },
    error,
  };
}

async function invokeViaOpencodeCli(request: ProviderRequest, env: NodeJS.ProcessEnv): Promise<ProviderResponse> {
  const started = Date.now();
  // opencode takes no system-prompt flag, so the system block is prepended.
  const input = `${request.system}\n\nAll the context needed is below. Do not read files or run commands; answer from the context provided.\n\n${request.user}`;
  const args = ['run', '--format', 'json', '--thinking', '-m', request.model, input];

  const lines: string[] = [];
  const r = await runCli('opencode', args, '', (line) => {
    lines.push(line);
    reportEvent(line);
  }, env);

  const out = foldOpencodeEvents(lines);
  if (r.status !== 0 || !out.text) {
    const why = [
      out.error,
      r.error ? `spawn ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}` : null,
      r.signal ? `signal ${r.signal}` : null,
      r.status ? `exit ${r.status}` : null,
      out.text ? null : 'no output',
      r.stderr ? `stderr: ${r.stderr.slice(0, 400)}` : null,
    ].filter(Boolean).join('; ');
    throw new Error(`opencode CLI failed (${why || 'no diagnostic available'})`);
  }

  return {
    text: out.text,
    usage: out.usage,
    model: request.model,
    latency_ms: Date.now() - started,
    reasoning: out.reasoning || undefined,
  };
}

/** Say what the CLI is doing while it does it. The answer and the token counts
 *  are folded from the whole stream afterwards, so only progress is logged. */
function reportEvent(line: string): void {
  if (!line.includes('"tool_use"') && !line.includes('"reasoning"')) return;
  try {
    const ev = JSON.parse(line) as OpencodeEvent;
    if (ev.type === 'tool_use' && ev.part?.tool) {
      bus.emit({ type: 'log', level: 'debug', message: `opencode: ${ev.part.tool}` });
    } else if (ev.type === 'reasoning' && ev.part?.text) {
      bus.emit({ type: 'log', level: 'debug', message: `opencode thinking — ${ev.part.text.slice(0, 120)}` });
    }
  } catch { /* A partial line is not worth reporting. */ }
}
