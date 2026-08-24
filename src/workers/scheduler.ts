// Worker scheduler (spec §12.4) — registers workers and defines the static
// task-execution dependency graph. The graph is known at compile time (no LLM scheduling).

import { registerWorker, listWorkers } from './base.js';
import { VerifierWorker } from './verifier.js';
import { ModuleSummarizerWorker } from './moduleSummarizer.js';
import { MemoryCompressorWorker } from './memoryCompressor.js';
import { ConflictResolverWorker } from './conflictResolver.js';
import { DETERMINISTIC_WORKERS } from './descriptors.js';

export interface PipelineStage {
  worker: string;
  dependsOn: string[];
  requires_llm: boolean;
}

// Canonical task-execution DAG (spec §12.4).
export const TASK_PIPELINE: PipelineStage[] = [
  { worker: 'IntentParser', dependsOn: [], requires_llm: false },
  { worker: 'StaticIndexer', dependsOn: ['IntentParser'], requires_llm: false },
  { worker: 'Planner', dependsOn: ['StaticIndexer'], requires_llm: true },
  { worker: 'FileSelector', dependsOn: ['Planner'], requires_llm: false },
  { worker: 'WikiReader', dependsOn: ['Planner'], requires_llm: false },
  { worker: 'ContextCompiler', dependsOn: ['FileSelector', 'WikiReader'], requires_llm: false },
  { worker: 'TaskExecutor', dependsOn: ['ContextCompiler'], requires_llm: true },
  { worker: 'OutputParser', dependsOn: ['TaskExecutor'], requires_llm: false },
  { worker: 'PatchApplier', dependsOn: ['OutputParser'], requires_llm: false },
  { worker: 'ReasoningExtractor', dependsOn: ['OutputParser'], requires_llm: false },
  { worker: 'WikiUpdater', dependsOn: ['ReasoningExtractor'], requires_llm: false },
  { worker: 'Verifier', dependsOn: ['PatchApplier'], requires_llm: true },
  { worker: 'Checkpointer', dependsOn: ['Verifier', 'WikiUpdater'], requires_llm: false },
];

let registered = false;

export function registerCoreWorkers(): void {
  if (registered) return;
  registerWorker(VerifierWorker);
  registerWorker(ModuleSummarizerWorker);
  registerWorker(MemoryCompressorWorker);
  registerWorker(ConflictResolverWorker);
  for (const w of DETERMINISTIC_WORKERS) registerWorker(w);
  registered = true;
}

export function topoOrder(): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const byName = new Map(TASK_PIPELINE.map((s) => [s.worker, s]));
  const visit = (name: string): void => {
    if (done.has(name)) return;
    const stage = byName.get(name);
    if (stage) for (const dep of stage.dependsOn) visit(dep);
    done.add(name);
    order.push(name);
  };
  for (const s of TASK_PIPELINE) visit(s.worker);
  return order;
}

/**
 * Next pending task whose dependencies are all completed (spec §4.2.2, §12.4).
 * Honors the task DAG instead of naive plan order.
 */
export function nextReadyTask<T extends { id: string; status: string; dependencies: string[]; order?: number }>(
  tasks: T[],
): T | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ready = tasks
    .filter((t) => t.status === 'pending')
    .filter((t) => t.dependencies.every((d) => byId.get(d)?.status === 'completed' || !byId.has(d)))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return ready[0] ?? null;
}

export { listWorkers };
