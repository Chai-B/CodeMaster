// Planner — LLM-backed execution plan generation (spec §12.2, §14.1).

import { compileContext } from '../context/compiler.js';
import { Tokens } from '../storage/tokens.js';
import { bus } from '../events/bus.js';
import { id, now } from '../util/id.js';
import { staticAnalysis } from '../analysis/api.js';
import { namedFiles } from '../context/fileSelector.js';
import { tierFor, type ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { Session, Task, ExecutionPlan, TaskType, TaskSpec } from '../types/index.js';

const PLAN_INSTRUCTIONS = `Decompose the objective into the SMALLEST number of concrete tasks that actually change code.
Each task is a single unit of work (implement one component, write one test suite, etc.).

Do NOT plan tasks that only check, verify, confirm, validate or measure work another task does.
Every change is already run against the repository's tests, a crash guard and a generated
reproduction test before it is accepted. A task that only re-checks that costs a full model
call and buys nothing.

Titles must be short imperative phrases under 80 characters. Never continue one task's
sentence into the next task's title.

Return the tasks via <next_tasks> with a type attribute. Record the high-level approach as a
planning decision. Do not write code in this step — only plan.`;

/** Titles the planner emits when it plans its own verification. Those tasks are
 *  pure W5 waste: the orchestrator already runs the suite, the crash guard and
 *  an admitted repro deterministically. Measured on the benchmark, three of six
 *  tasks were these, they consumed half the budget, and all three failed. */
const VERIFICATION_ONLY = /^\s*(verify|confirm|validate|check|ensure|measure|assert)\b/i;

export function isSelfVerificationTask(title: string): boolean {
  return VERIFICATION_ONLY.test(title);
}

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
    input_files: namedFiles(session.repository.path, session.objective).map((path) => ({ path })),
    output_files: [],
    dependencies: [],
    blocking: [],
    reasoning_refs: [],
    decision_refs: [],
    estimated_tokens: 0,
    order: -1,
  };

  bus.emit({ type: 'worker.started', worker: 'Planner', detail: 'compiling planning context' });

  const planTier = tierFor({ role: 'plan', taskType: 'plan', files: planningTask.input_files.length });
  const primary = manager.select(manager.modelFor('plan', undefined, planTier), cfg.context.max_context_tokens);
  const compiled = await compileContext(session, planningTask, {
    maxContextTokens: primary.spec.context_size,
    fileCompressionThreshold: cfg.context.file_compression_threshold,
    taskInstructions: PLAN_INSTRUCTIONS,
  });

  // Plan with automatic failover across healthy providers (spec §13, §26.7).
  const { sel, response } = await manager.invokeWithFailover(compiled, cfg.context.max_context_tokens, 'plan', {
    tier: planTier,
  });
  bus.emit({ type: 'provider.invoked', provider_id: sel.adapter.provider_id, account_id: sel.account.id });
  manager.recordUsage(sel.account, response.usage.total_tokens, response.latency_ms);

  const cost = manager.costOf(sel.spec, response.usage);
  Tokens.record({
    session_id: session.id,
    task_id: planningTask.id,
    role: 'plan',
    provider_id: sel.adapter.provider_id,
    account_id: sel.account.id,
    model_id: sel.model,
    usage: response.usage,
    cost_usd: cost,
    components: compiled.included,
  });
  bus.emit({ type: 'provider.response', provider_id: sel.adapter.provider_id, tokens: response.usage.total_tokens });

  const ir = sel.adapter.parse_response(response, session.id, planningTask.id);

  const emitted: TaskSpec[] = ir.next_tasks.length
    ? ir.next_tasks
    : [{ title: session.objective, priority: 'high', type: session.objective_parsed?.task_type }];
  const kept = emitted.filter((s) => !VERIFICATION_ONLY.test(s.title));
  for (const s of emitted) {
    if (!kept.includes(s)) {
      bus.emit({ type: 'log', level: 'info', message: `Dropped self-verification task: ${s.title.slice(0, 80)}` });
    }
  }
  // A plan made entirely of verification is not a plan — measured: three tasks,
  // all "Verify …", no task that changed anything, and all three failed. Running
  // them reproduces exactly that. Fall back to the objective itself.
  const specs: TaskSpec[] = kept.length
    ? kept
    : [{ title: session.objective.slice(0, 120), description: session.objective, priority: 'high', type: session.objective_parsed?.task_type }];

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
      // The files this task names, if they exist. Left empty, `locus` is empty,
      // so the repro generator runs even when the repo already has tests over
      // the change and the verifier's confidence gate can never fire.
      input_files: namedFiles(session.repository.path, `${s.title}\n${s.description ?? ''}`).map((path) => ({ path })),
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
