// TaskExecutor — LLM-backed task execution + full IR processing (spec §12.2, §14.1).

import { compileContext } from '../context/compiler.js';
import { compileHandoffPackage, renderHandoffPackage, validateHandoffPackage } from './handoff.js';
import { processIR } from './irProcessor.js';
import { ParseError } from './outputParser.js';
import { Tokens } from '../storage/tokens.js';
import { PromptCache, promptHash } from '../storage/promptCache.js';
import { bus } from '../events/bus.js';
import { Learning } from '../learning/reflector.js';
import { throwIfCancelled } from '../util/cancel.js';
import { invokeWithBackoff, tierFor, type ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import { id, now } from '../util/id.js';
import type { Session, Task, IntermediateRepresentation, CompiledPrompt, ProviderResponse } from '../types/index.js';

/** One vendor-side conversation, carried across a task's solver iterations.
 *  The solver owns it; `provider_id` is filled in by the first successful call
 *  so later turns only resume against the vendor that actually has it. */
export interface Conversation {
  id: string;
  turn: number;
  provider_id?: string;
  delta: string;
}

export interface ExecuteResult {
  ir: IntermediateRepresentation;
  tokens: number;
  ms: number;
  applied: string[];
  created: string[];
  failed: Array<{ file: string; reason: string }>;
  reasoningStored: number;
  wikiUpdated: string[];
}

/**
 * Tokens spent embedding files the response never mentioned (token-discipline
 * W3). Measured, not estimated: a file is referenced when its path or basename
 * appears in the model's own output. This is the number the wasteRatio gate is
 * computed from, so it must stay an observation rather than a heuristic score.
 */
function unreferencedTokens(compiled: CompiledPrompt, text: string, repoPath: string): number {
  const referenced = new Set<string>();
  let wasted = 0;
  for (const f of compiled.file_costs ?? []) {
    const base = f.path.split('/').pop() ?? f.path;
    if (text.includes(f.path) || text.includes(base)) referenced.add(f.path);
    else wasted += f.tokens;
  }
  // The same observation the waste number is built from also feeds the learning
  // loop: a file included over and over and referenced by nothing gets ranked
  // down in future selections.
  const paths = (compiled.file_costs ?? []).map((f) => f.path);
  if (paths.length) Learning.recordSelection(repoPath, paths, referenced);
  return wasted;
}

/** Identifiers long enough to be distinctive rather than English. */
function terms(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) ?? []);
}

/**
 * Which context components the response actually drew on. A component is
 * credited only through terms unique to it, so two components carrying the same
 * identifier cannot claim each other's evidence. A component with nothing
 * unique to say produces no observation at all — silence is not a verdict.
 */
function componentUse(compiled: CompiledPrompt, text: string): Array<{ component: string; referenced: boolean }> {
  const perComponent = compiled.components.map((c) => ({ component: String(c.component), t: terms(c.content) }));
  const seen = new Map<string, number>();
  for (const c of perComponent) for (const t of c.t) seen.set(t, (seen.get(t) ?? 0) + 1);

  const out: Array<{ component: string; referenced: boolean }> = [];
  for (const c of perComponent) {
    const unique = [...c.t].filter((t) => seen.get(t) === 1);
    if (unique.length === 0) continue;
    out.push({ component: c.component, referenced: unique.some((t) => text.includes(t)) });
  }
  return out;
}

export async function executeTask(
  session: Session,
  task: Task,
  manager: ProviderManager,
  cfg: Config,
  tier = 0,
  conversation?: Conversation,
  /** This task, on this model — the solver's escalation target. Passed per call
   *  so two tasks escalating at once cannot see each other's choice. */
  model?: string,
): Promise<ExecuteResult> {
  const started = Date.now();
  throwIfCancelled();
  bus.emit({ type: 'task.started', task_id: task.id, title: task.title });

  // What this call will actually use, resolved ONCE: the same string sizes the
  // context, keys the prompt cache and goes to the vendor. They used to be three
  // different answers — `/model` changed the cache key and nothing else, so a
  // sonnet answer was stored under a key that said haiku and later served as
  // haiku's. Resolving here makes all three agree.
  const requested = model ?? session.current_provider?.model_id;
  // Resolved before the context is compiled, not after, for the same reason:
  // the tier decides the model, and the model has to be the one the cache key
  // and the context budget were built from.
  const jobTier = tierFor({
    role: 'solve',
    taskType: task.type,
    files: task.input_files.length,
    contextTokens: task.estimated_tokens || undefined,
    contextTier: tier,
  });
  const primary = manager.select(manager.modelFor('solve', requested, jobTier), cfg.context.max_context_tokens);

  bus.emit({ type: 'worker.started', worker: 'FileSelector', detail: task.title });
  const compiled = await compileContext(session, task, {
    maxContextTokens: primary.spec.context_size,
    fileCompressionThreshold: cfg.context.file_compression_threshold,
    tier,
  });
  bus.emit({
    type: 'worker.finished',
    worker: 'ContextCompiler',
    detail: `${compiled.total_tokens} tokens, ${compiled.included.length} components`,
  });
  // Retain the last compiled context for checkpoint debugging (spec §14.2 context_last.md).
  session.metadata = { ...(session.metadata ?? {}), last_context: compiled.body };

  throwIfCancelled();
  // Already answered? The key is this exact compiled prompt, so a hit means the
  // task, the selected files and their contents are all unchanged since the
  // last time this question was bought. Re-asking would spend tokens to be told
  // the same thing (token discipline W4).
  const cacheKey = promptHash(compiled.body, primary.model);
  const cached = PromptCache.get(cacheKey);
  if (cached) {
    bus.emit({
      type: 'log',
      level: 'success',
      message: `Reused a stored answer for this exact context — ${cached.tokens} tokens not spent.`,
    });
    const reused: IntermediateRepresentation = { ...cached.ir, session_id: session.id, task_id: task.id };
    const rproc = await processIR(reused, session, task, cfg, manager);
    const rms = Date.now() - started;
    bus.emit({ type: 'task.completed', task_id: task.id, tokens: 0, ms: rms });
    return {
      ir: reused,
      tokens: 0,
      ms: rms,
      applied: rproc.apply.applied,
      created: rproc.apply.created,
      failed: rproc.apply.failed,
      reasoningStored: rproc.reasoningStored,
      wikiUpdated: rproc.wikiUpdated,
    };
  }

  // Invoke with automatic failover across healthy providers (spec §13, §26.7).
  // On a vendor switch the context is recompiled with a handoff package, so the
  // new provider inherits the session's decisions and progress instead of
  // starting cold — the one thing no other tool does mid-task.
  const { sel, response } = await manager.invokeWithFailover(
    compiled,
    cfg.context.max_context_tokens,
    'solve',
    {
      model: requested,
      tier: jobTier,
      conversation,
      onConversation: (_id, providerId) => {
        if (conversation) conversation.provider_id = providerId;
      },
      onVendorSwitch: async (from, to) => {
        const pkg = await compileHandoffPackage(session);
        const valid = validateHandoffPackage(pkg);
        if (!valid.ok) bus.emit({ type: 'log', level: 'warn', message: `Handoff missing: ${valid.missing.join(', ')}` });
        session.metadata = { ...(session.metadata ?? {}), pending_handoff: renderHandoffPackage(pkg) };
        bus.emit({ type: 'log', level: 'info', message: `Carrying session state from ${from} to ${to}.` });
        return compileContext(session, task, {
          maxContextTokens: primary.spec.context_size,
          fileCompressionThreshold: cfg.context.file_compression_threshold,
          tier,
        });
      },
    },
  );
  bus.emit({ type: 'provider.invoked', provider_id: sel.adapter.provider_id, account_id: sel.account.id });
  const cost = manager.costOf(sel.spec, response.usage);
  manager.recordUsage(sel.account, response.usage, cost, response.latency_ms);
  bus.emit({ type: 'provider.response', provider_id: sel.adapter.provider_id, tokens: response.usage.total_tokens });
  Tokens.record({
    session_id: session.id,
    task_id: task.id,
    role: 'solve',
    provider_id: sel.adapter.provider_id,
    account_id: sel.account.id,
    model_id: sel.model,
    usage: response.usage,
    cost_usd: cost,
    components: compiled.included,
    wasted_tokens: unreferencedTokens(compiled, response.text, session.repository.path),
  });

  // Parse IR natively per provider; on failure, retry once with a format reminder (spec §15.3).
  let ir: IntermediateRepresentation;
  let retryTokens = 0;
  try {
    ir = sel.adapter.parse_response(response, session.id, task.id);
  } catch (e) {
    if (e instanceof ParseError) {
      bus.emit({ type: 'log', level: 'warn', message: 'Malformed output — retrying with format reminder' });
      const retryReq = sel.adapter.format_prompt(
        { ...compiled, body: compiled.body + '\n\nIMPORTANT: Your previous response was rejected. Respond ONLY in the required output format.' },
        sel.model,
      );
      const retry = await invokeWithBackoff(() => sel.adapter.invoke(retryReq, sel.account));
      const retryCost = manager.costOf(sel.spec, retry.usage);
      manager.recordUsage(sel.account, retry.usage, retryCost, retry.latency_ms);
      Tokens.record({
        session_id: session.id, task_id: task.id, role: 'solve', provider_id: sel.adapter.provider_id,
        account_id: sel.account.id, model_id: sel.model, usage: retry.usage,
        // A retry costs real money. Recording it as free understated the run's
        // own cost by a full call — measured, one such retry was 74,602 tokens.
        cost_usd: retryCost,
        components: compiled.included,
      });
      retryTokens = retry.usage.total_tokens;
      ir = sel.adapter.parse_response(retry, session.id, task.id);
    } else {
      throw e;
    }
  }

  attachThinking(ir, response, session.id, task.id, sel.adapter.provider_id, sel.model);

  Learning.recordComponents(session.repository.path, task.type, componentUse(compiled, response.text));

  // Store the answer against the prompt that bought it, so an identical
  // question later is free. Only clean results are worth keeping.
  if (ir.status !== 'failed') PromptCache.put(cacheKey, sel.model, ir, response.usage.total_tokens);

  bus.emit({ type: 'worker.started', worker: 'IRProcessor', detail: 'applying patches + reasoning' });
  const proc = await processIR(ir, session, task, cfg, manager);

  // The handoff package is one-shot — consumed by the first task after a switch (spec §13.6).
  if ((session.metadata as Record<string, unknown> | undefined)?.pending_handoff) {
    delete (session.metadata as Record<string, unknown>).pending_handoff;
  }

  const ms = Date.now() - started;
  const tokens = response.usage.total_tokens + retryTokens;
  task.actual_tokens = (task.actual_tokens ?? 0) + tokens;
  bus.emit({ type: 'task.completed', task_id: task.id, tokens, ms });

  return {
    ir,
    tokens,
    ms,
    applied: proc.apply.applied,
    created: proc.apply.created,
    failed: proc.apply.failed,
    reasoningStored: proc.reasoningStored,
    wikiUpdated: proc.wikiUpdated,
  };
}

/**
 * Keep the model's own thinking with the answer it produced. Reasoning tokens
 * are billed as output whether or not anyone reads them, and every adapter used
 * to throw the blocks away — so the run paid for the working and then had no
 * record of it. Stored as reasoning, it shows in the transcript and is
 * searchable by the next task that touches the same code.
 */
function attachThinking(
  ir: IntermediateRepresentation,
  response: ProviderResponse,
  sessionId: string,
  taskId: string,
  providerId: string,
  modelId: string,
): void {
  const text = response.reasoning?.trim();
  if (!text) return;
  const first = text.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? text;
  ir.thinking = [
    ...(ir.thinking ?? []),
    {
      id: id('rsn'),
      type: 'thinking',
      session_id: sessionId,
      task_id: taskId,
      summary: first.slice(0, 200),
      detail: text,
      evidence: [],
      confidence: 1,
      produced_by: { provider_id: providerId, model_id: modelId },
      produced_at: now(),
      affected_files: [],
      affected_modules: [],
      tags: ['thinking'],
      permanent: false,
      wiki_keys: [],
      reference_count: 0,
      importance: 0,
    },
  ];
}
