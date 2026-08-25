// Shared LLM invocation helper for LLM-backed workers — selects provider,
// invokes, records tokens. Returns raw text. (Used by Verifier, summarizer, etc.)

import { Tokens } from '../storage/tokens.js';
import { bus } from '../events/bus.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { CompiledPrompt } from '../types/index.js';

export interface LlmCallOptions {
  system: string;
  user: string;
  sessionId: string;
  taskId?: string;
  maxTokens?: number;
}

export async function callLlm(
  manager: ProviderManager,
  cfg: Config,
  opts: LlmCallOptions,
): Promise<{ text: string; tokens: number }> {
  const compiled: CompiledPrompt = {
    session_id: opts.sessionId,
    task_id: opts.taskId ?? 'worker',
    task_type: 'plan',
    compiled_at: '',
    system: opts.system,
    components: [],
    body: opts.user,
    total_tokens: 0,
    max_tokens: cfg.context.max_context_tokens,
    included: [],
    omitted: [],
    max_output_tokens: opts.maxTokens,
  };
  // Through failover, not straight at one account. Called directly, a single
  // rate-limited account made every worker call throw — and the repro
  // generator swallows that as `null`, so a spent quota silently removed the
  // only sound oracle in the system rather than moving to another provider.
  const { sel, response } = await manager.invokeWithFailover(compiled, cfg.context.max_context_tokens);
  bus.emit({ type: 'provider.invoked', provider_id: sel.adapter.provider_id, account_id: sel.account.id });
  manager.recordUsage(sel.account, response.usage.total_tokens, response.latency_ms);
  Tokens.record({
    session_id: opts.sessionId,
    task_id: opts.taskId,
    provider_id: sel.adapter.provider_id,
    account_id: sel.account.id,
    model_id: sel.model,
    usage: response.usage,
    cost_usd: manager.costOf(sel.spec, response.usage.input_tokens, response.usage.output_tokens),
    components: ['worker'],
  });
  bus.emit({ type: 'provider.response', provider_id: sel.adapter.provider_id, tokens: response.usage.total_tokens });
  return { text: response.text, tokens: response.usage.total_tokens };
}

export function firstTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m?.[1]?.trim();
}
