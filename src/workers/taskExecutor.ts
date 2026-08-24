// TaskExecutor — LLM-backed task execution + full IR processing (spec §12.2, §14.1).

import { compileContext } from '../context/compiler.js';
import { processIR } from './irProcessor.js';
import { ParseError } from './outputParser.js';
import { Tokens } from '../storage/tokens.js';
import { bus } from '../events/bus.js';
import { invokeWithBackoff, type ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { Session, Task, IntermediateRepresentation } from '../types/index.js';

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

export async function executeTask(
  session: Session,
  task: Task,
  manager: ProviderManager,
  cfg: Config,
): Promise<ExecuteResult> {
  const started = Date.now();
  bus.emit({ type: 'task.started', task_id: task.id, title: task.title });

  const primary = manager.select(session.current_provider?.model_id ?? cfg.providers.default, cfg.context.max_context_tokens);

  bus.emit({ type: 'worker.started', worker: 'FileSelector', detail: task.title });
  const compiled = await compileContext(session, task, {
    maxContextTokens: primary.spec.context_size,
    fileCompressionThreshold: cfg.context.file_compression_threshold,
  });
  bus.emit({
    type: 'worker.finished',
    worker: 'ContextCompiler',
    detail: `${compiled.total_tokens} tokens, ${compiled.included.length} components`,
  });
  // Retain the last compiled context for checkpoint debugging (spec §14.2 context_last.md).
  session.metadata = { ...(session.metadata ?? {}), last_context: compiled.body };

  // Invoke with automatic failover across healthy providers (spec §13, §26.7).
  const { sel, response } = await manager.invokeWithFailover(compiled, cfg.context.max_context_tokens, task.type);
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
