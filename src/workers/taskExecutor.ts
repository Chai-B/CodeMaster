// TaskExecutor — LLM-backed task execution + full IR processing (spec §12.2, §14.1).

import { compileContext } from '../context/compiler.js';
import { compileHandoffPackage, renderHandoffPackage, validateHandoffPackage } from './handoff.js';
import { processIR } from './irProcessor.js';
import { ParseError } from './outputParser.js';
import { Tokens } from '../storage/tokens.js';
import { bus } from '../events/bus.js';
import { Learning } from '../learning/reflector.js';
import { throwIfCancelled } from '../util/cancel.js';
import { invokeWithBackoff, type ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { Session, Task, IntermediateRepresentation, CompiledPrompt } from '../types/index.js';

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

export async function executeTask(
  session: Session,
  task: Task,
  manager: ProviderManager,
  cfg: Config,
  tier = 0,
): Promise<ExecuteResult> {
  const started = Date.now();
  throwIfCancelled();
  bus.emit({ type: 'task.started', task_id: task.id, title: task.title });

  const primary = manager.select(session.current_provider?.model_id ?? cfg.providers.default, cfg.context.max_context_tokens);

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
  // Invoke with automatic failover across healthy providers (spec §13, §26.7).
  // On a vendor switch the context is recompiled with a handoff package, so the
  // new provider inherits the session's decisions and progress instead of
  // starting cold — the one thing no other tool does mid-task.
  const { sel, response } = await manager.invokeWithFailover(
    compiled,
    cfg.context.max_context_tokens,
    task.type,
    {
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
  manager.recordUsage(sel.account, response.usage.total_tokens, response.latency_ms);
  bus.emit({ type: 'provider.response', provider_id: sel.adapter.provider_id, tokens: response.usage.total_tokens });

  const cost = manager.costOf(sel.spec, response.usage.input_tokens, response.usage.output_tokens);
  Tokens.record({
    session_id: session.id,
    task_id: task.id,
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
      manager.recordUsage(sel.account, retry.usage.total_tokens, retry.latency_ms);
      Tokens.record({
        session_id: session.id, task_id: task.id, provider_id: sel.adapter.provider_id,
        account_id: sel.account.id, model_id: sel.model, usage: retry.usage, cost_usd: 0, components: compiled.included,
      });
      ir = sel.adapter.parse_response(retry, session.id, task.id);
    } else {
      throw e;
    }
  }

  bus.emit({ type: 'worker.started', worker: 'IRProcessor', detail: 'applying patches + reasoning' });
  const proc = await processIR(ir, session, task, cfg);

  // The handoff package is one-shot — consumed by the first task after a switch (spec §13.6).
  if ((session.metadata as Record<string, unknown> | undefined)?.pending_handoff) {
    delete (session.metadata as Record<string, unknown>).pending_handoff;
  }

  const ms = Date.now() - started;
  const tokens = response.usage.total_tokens;
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
