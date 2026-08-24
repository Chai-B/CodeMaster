// Planner — LLM-backed execution plan generation (spec §12.2, §14.1).

import { compileContext } from '../context/compiler.js';
import { Tokens } from '../storage/tokens.js';
import { bus } from '../events/bus.js';
import { id, now } from '../util/id.js';
import { staticAnalysis } from '../analysis/api.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { Session, Task, ExecutionPlan, TaskType, TaskSpec } from '../types/index.js';

const PLAN_INSTRUCTIONS = `Decompose the objective into an ordered list of concrete, verifiable tasks.
Each task must be a single unit of work (implement one component, write one test suite, etc.).
Return the tasks via <next_tasks> with a type attribute. Record the high-level approach as a planning decision.
Do not write code in this step — only plan.`;

export async function generatePlan(
  session: Session,
  manager: ProviderManager,
  cfg: Config,
): Promise<{ plan: ExecutionPlan; planningTask: Task }> {
  // Synthetic planning task drives context compilation under the planning profile.
  const planningTask: Task = {
    id: id('task'),
    session_id: session.id,
    title: `Plan: ${session.objective.slice(0, 60)}`,
    description: session.objective,
    type: 'plan',
    status: 'in_progress',
    input_files: [],
    output_files: [],
    dependencies: [],
    blocking: [],
    reasoning_refs: [],
    decision_refs: [],
    estimated_tokens: 0,
    order: -1,
  };

  bus.emit({ type: 'worker.started', worker: 'Planner', detail: 'compiling planning context' });

  const primary = manager.select(cfg.providers.default, cfg.context.max_context_tokens);
  const compiled = await compileContext(session, planningTask, {
    maxContextTokens: primary.spec.context_size,
    fileCompressionThreshold: cfg.context.file_compression_threshold,
    taskInstructions: PLAN_INSTRUCTIONS,
  });

  // Plan with automatic failover across healthy providers (spec §13, §26.7).
  const { sel, response } = await manager.invokeWithFailover(compiled, cfg.context.max_context_tokens, 'plan');
  bus.emit({ type: 'provider.invoked', provider_id: sel.adapter.provider_id, account_id: sel.account.id });
  manager.recordUsage(sel.account, response.usage.total_tokens, response.latency_ms);

  const cost = manager.costOf(sel.spec, response.usage.input_tokens, response.usage.output_tokens);
  Tokens.record({
    session_id: session.id,
    task_id: planningTask.id,
    provider_id: sel.adapter.provider_id,
    account_id: sel.account.id,
    model_id: sel.model,
    usage: response.usage,
    cost_usd: cost,
    components: compiled.included,
  });
  bus.emit({ type: 'provider.response', provider_id: sel.adapter.provider_id, tokens: response.usage.total_tokens });

  const ir = sel.adapter.parse_response(response, session.id, planningTask.id);

  const specs: TaskSpec[] = ir.next_tasks.length
    ? ir.next_tasks
    : [{ title: session.objective, priority: 'high', type: session.objective_parsed?.task_type }];

  // First pass: allocate ids so dependencies can reference siblings by title (spec §4.2.2).
  const ids = specs.map(() => id('task'));
  const idByTitle = new Map<string, string>();
  specs.forEach((s, i) => idByTitle.set(s.title.trim().toLowerCase(), ids[i]!));

  const tasks: Task[] = specs.map((s, i) => {
    // Resolve declared dependencies by title; default to a sequential chain.
    const declared = (s.depends_on ?? [])
      .map((d) => idByTitle.get(d.trim().toLowerCase()))
      .filter((x): x is string => Boolean(x) && x !== ids[i]);
    const dependencies = declared.length ? declared : i > 0 ? [ids[i - 1]!] : [];
    return {
      id: ids[i]!,
      session_id: session.id,
      title: s.title.slice(0, 120),
      description: s.description ?? s.title,
      type: (s.type as TaskType) ?? session.objective_parsed?.task_type ?? 'implement',
      status: 'pending',
      input_files: [],
      output_files: [],
      dependencies,
      blocking: [],
      reasoning_refs: [],
      decision_refs: [],
      estimated_tokens: 0,
      order: i,
    };
  });

  // Populate reverse edges (blocking) from dependencies.
  for (const t of tasks) {
    for (const depId of t.dependencies) {
      const dep = tasks.find((x) => x.id === depId);
      if (dep) dep.blocking.push(t.id);
    }
  }

  // persist planning reasoning
  void staticAnalysis(session.repository.path);
  for (const d of ir.decisions) {
    d.session_id = session.id;
    d.task_id = planningTask.id;
  }

  const plan: ExecutionPlan = {
    tasks,
    created_at: now(),
    created_by: { provider_id: sel.adapter.provider_id, model_id: sel.model },
  };

  bus.emit({ type: 'worker.finished', worker: 'Planner', detail: `${tasks.length} tasks` });
  return { plan, planningTask: { ...planningTask, status: 'completed' } };
}
