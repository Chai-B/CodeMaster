// Shared LLM invocation helper for LLM-backed workers — selects provider,
// invokes, records tokens. Returns raw text. (Used by Verifier, summarizer, etc.)

import { Tokens } from '../storage/tokens.js';
import { PromptCache, promptHash } from '../storage/promptCache.js';
import { bus } from '../events/bus.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { CompiledPrompt, LlmRole, LlmEffort, TaskType } from '../types/index.js';

/** The role is what this call is for; task_type is the nearest thing the context
 *  schema can say about it. Only plan and oracle map cleanly — the mechanical
 *  roles are all recorded as review. Better than the flat 'plan' every worker
 *  call used to claim, which made tokensByTaskType unreadable. */
const ROLE_TASK_TYPE: Record<LlmRole, TaskType> = {
  solve: 'implement',
  plan: 'plan',
  oracle: 'test',
  review: 'review',
  summarize: 'review',
  merge: 'review',
};

export interface LlmCallOptions {
  /** Required. Every worker declares what its call is for, and routing follows
   *  from that — optional would let a site silently keep the global model. */
  role: LlmRole;
  /** Override the role's configured reasoning depth for this call. */
  effort?: LlmEffort;
  /** Override the role's configured model for this call — the oracle's
   *  escalation after a failed admission. */
  model?: string;
  system: string;
  user: string;
  sessionId: string;
  taskId?: string;
  maxTokens?: number;
  /** Continue one vendor-side conversation across repeated calls, so a retry
   *  sends only its correction instead of re-paying for the same context.
   *  Measured: three repro attempts on config-precedence cost 108,096 tokens,
   *  and two of them re-sent a code surface the vendor already held. */
  conversation?: { id: string; turn: number; provider_id?: string; delta: string };
  onConversation?: (id: string, providerId: string) => void;
}

export async function callLlm(
  manager: ProviderManager,
  cfg: Config,
  opts: LlmCallOptions,
): Promise<{ text: string; tokens: number }> {
  const compiled: CompiledPrompt = {
    session_id: opts.sessionId,
    task_id: opts.taskId ?? 'worker',
    task_type: ROLE_TASK_TYPE[opts.role],
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
  // A call that carries no conversation is a pure function of its prompt: the
  // same module, the same diff, the same conflict gives the same answer, and
  // buying it twice is W4 by definition. Module summaries were the worst case —
  // up to twelve serial calls re-paid on every cold start. Calls that DO carry a
  // conversation are stateful (the oracle's retries send only a correction), so
  // they are deliberately not cached.
  const cacheable = !opts.conversation;
  const model = manager.modelFor(opts.role, opts.model);
  const key = promptHash(`${opts.system}\n${opts.user}`, model);
  if (cacheable) {
    const hit = PromptCache.getText(key);
    if (hit) {
      bus.emit({ type: 'log', level: 'success', message: `Reused a stored ${opts.role} answer — ${hit.tokens} tokens not spent.` });
      return { text: hit.text, tokens: 0 };
    }
  }

  // Through failover, not straight at one account. Called directly, a single
  // rate-limited account made every worker call throw — and the repro
  // generator swallows that as `null`, so a spent quota silently removed the
  // only sound oracle in the system rather than moving to another provider.
  const { sel, response } = await manager.invokeWithFailover(compiled, cfg.context.max_context_tokens, opts.role, {
    conversation: opts.conversation,
    onConversation: opts.onConversation,
    model: opts.model,
    effort: opts.effort,
  });
  bus.emit({ type: 'provider.invoked', provider_id: sel.adapter.provider_id, account_id: sel.account.id });
  manager.recordUsage(sel.account, response.usage.total_tokens, response.latency_ms);
  Tokens.record({
    session_id: opts.sessionId,
    task_id: opts.taskId,
    role: opts.role,
    provider_id: sel.adapter.provider_id,
    account_id: sel.account.id,
    model_id: sel.model,
    usage: response.usage,
    cost_usd: manager.costOf(sel.spec, response.usage),
    components: ['worker'],
  });
  bus.emit({ type: 'provider.response', provider_id: sel.adapter.provider_id, tokens: response.usage.total_tokens });
  // Keyed on the model that ACTUALLY answered, not the one routing asked for.
  // Failover can move a call to a rescue vendor, and storing that answer under
  // the routed model's key serves one model's reasoning as another's.
  if (cacheable) PromptCache.putText(promptHash(`${opts.system}\n${opts.user}`, sel.model), sel.model, response.text, response.usage.total_tokens);
  return { text: response.text, tokens: response.usage.total_tokens };
}

export function firstTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m?.[1]?.trim();
}
