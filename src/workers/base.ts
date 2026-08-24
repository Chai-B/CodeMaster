// Worker contract (spec §12.3) — every worker implements the same interface.

import { bus } from '../events/bus.js';

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export interface WorkerContext {
  repoPath: string;
  sessionId?: string;
}

export interface Worker<TInput, TOutput> {
  name: string;
  version: string;
  requires_llm: boolean;
  validate(input: TInput): ValidationResult;
  execute(input: TInput, context: WorkerContext): Promise<TOutput>;
  on_success?(output: TOutput, context: WorkerContext): void;
  on_failure?(error: Error, context: WorkerContext): void;
}

const registry = new Map<string, Worker<any, any>>();

export function registerWorker(worker: Worker<any, any>): void {
  registry.set(worker.name, worker);
}

export function getWorker<I, O>(name: string): Worker<I, O> | undefined {
  return registry.get(name) as Worker<I, O> | undefined;
}

export function listWorkers(): Array<{ name: string; version: string; requires_llm: boolean }> {
  return [...registry.values()].map((w) => ({ name: w.name, version: w.version, requires_llm: w.requires_llm }));
}

/** Run a worker with validation, event emission, and lifecycle hooks. */
export async function runWorker<I, O>(worker: Worker<I, O>, input: I, context: WorkerContext): Promise<O> {
  const v = worker.validate(input);
  if (!v.ok) throw new Error(`${worker.name} validation failed: ${v.error}`);
  bus.emit({ type: 'worker.started', worker: worker.name });
  try {
    const out = await worker.execute(input, context);
    worker.on_success?.(out, context);
    bus.emit({ type: 'worker.finished', worker: worker.name });
    return out;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    worker.on_failure?.(err, context);
    bus.emit({ type: 'worker.finished', worker: worker.name, detail: `failed: ${err.message}` });
    throw err;
  }
}
