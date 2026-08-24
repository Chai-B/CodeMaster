// Verify-and-iterate solver (spec §14.1 execution loop, §12.2 Verifier takes
// TestResults). Executes a task, runs a DETERMINISTIC verification command
// (tests / type-check / import-check — the orchestrator runs it, never the LLM,
// per §2 rule 1), and on failure re-invokes with the failure output fed back as
// context, iterating up to `maxIters`. This is the self-correction that lets a
// deterministic-context engine handle multi-file fixes and edge cases.

import { executeTask, type Conversation, type ExecuteResult } from './taskExecutor.js';
import { bus } from '../events/bus.js';
import { Learning } from '../learning/reflector.js';
import { throwIfCancelled } from '../util/cancel.js';
import { Failures } from '../storage/reasoning.js';
import { id, now, uuid } from '../util/id.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { Session, Task } from '../types/index.js';

export interface VerifyResult {
  ok: boolean;
  output: string; // failure detail fed back to the model when !ok
  /** False when nothing actually exercised the change — no relevant test, a
   *  runner that could not start, a timeout, or a patch that never touched the
   *  files the task named. The work still stands, but `verified` must not claim
   *  it was checked. */
  confident?: boolean;
}
export type VerifyFn = () => VerifyResult | Promise<VerifyResult>;

export interface SolveResult {
  last: ExecuteResult;
  iterations: number;
  verified: boolean;
  totalTokens: number;
}

export async function solveWithVerification(
  session: Session,
  task: Task,
  manager: ProviderManager,
  cfg: Config,
  verify: VerifyFn,
  maxIters = 3,
  // Injectable for testing; defaults to the real LLM-backed executor.
  exec: (s: Session, t: Task, m: ProviderManager, c: Config, tier?: number, conv?: Conversation) => Promise<ExecuteResult> = executeTask,
): Promise<SolveResult> {
  const origDesc = task.description;
  let last!: ExecuteResult;
  let verified = false;
  let totalTokens = 0;
  let iterations = 0;

  // Start where this repository has actually verified this kind of task before,
  // instead of always paying for a failed pass at the smallest budget first.
  const start = Learning.startTier(session.repository.path, task.type);

  // One vendor-side conversation for the whole task. The vendor CLI charges its
  // own system prompt on every fresh invocation — tens of thousands of tokens —
  // so iterating three times in three conversations pays that floor three
  // times. Resuming pays it once and sends only the new failure each turn.
  const conversation: Conversation = { id: uuid(), turn: 0, delta: '' };
  let lastFailure = '';

  for (let i = 0; i < Math.max(1, maxIters); i++) {
    throwIfCancelled();
    iterations = i + 1;
    bus.emit({ type: 'log', level: 'info', message: `Solver iteration ${iterations}/${maxIters}…` });
    conversation.turn = i;
    // The context budget climbs only after a pass has actually failed at the
    // current size — the first attempt never pays for a window it did not need.
    last = await exec(session, task, manager, cfg, start + i, conversation);
    totalTokens += last.tokens;

    const v = await verify();
    if (v.ok) {
      verified = v.confident !== false;
      bus.emit(
        verified
          ? { type: 'log', level: 'success', message: `Verification passed on iteration ${iterations}.` }
          : { type: 'log', level: 'warn', message: `Applied, but unverified: ${v.output}` },
      );
      break;
    }
    // Record the non-working approach (spec §8.5) so it is retrievable as a
    // "do not repeat" both by the next iteration and by future tasks that touch
    // the same files — this is how failure memory compounds.
    const changed = [...last.applied, ...last.created];
    if (changed.length) {
      try {
        Failures.insert({
          id: id('failure'),
          session_id: session.id,
          task_id: task.id,
          approach_attempted: last.ir?.summary || task.title,
          why_it_failed: v.output.slice(0, 1000),
          evidence_of_failure: [],
          alternatives_suggested: [],
          affected_files: changed.map((p) => ({ path: p })),
          confidence_in_failure_diagnosis: 0.6,
          created_at: now(),
          permanent: false,
        });
      } catch {
        /* failure logging is best-effort */
      }
    }

    // Iterating on an unchanged failure is paying to be told the same thing.
    // The model has not moved, so a third identical round will not move it
    // either — stop and report honestly instead of burning the budget.
    if (v.output === lastFailure) {
      bus.emit({ type: 'log', level: 'warn', message: 'Same failure as the previous iteration; stopping instead of repeating it.' });
      break;
    }
    lastFailure = v.output;

    if (i < maxIters - 1) {
      // Feed the failure back so the next pass sees exactly what broke. The context
      // is recompiled from the now-modified working tree, so the model iterates on
      // its own changes (spec §14.1).
      task.description =
        `${origDesc}\n\n--- ITERATION ${iterations} DID NOT PASS VERIFICATION ---\n` +
        `The current code produced this failure:\n${v.output.slice(0, 3500)}\n\n` +
        `Diagnose the root cause, then produce a MINIMAL unified-diff patch that changes only what is ` +
        `necessary to fix it (the fix may span multiple files). Do not reorganize imports, rename symbols, ` +
        `or rewrite unrelated code. Use only modules and names that already exist in this repository.`;
      // What a resumed conversation actually sends: the vendor still holds the
      // repository context from the opening turn, so only the new failure and
      // the standing instruction need to cross the wire.
      conversation.delta =
        `Your previous patch did not pass verification.\n\n${v.output.slice(0, 3500)}\n\n` +
        `Diagnose the root cause, then produce a MINIMAL unified-diff patch that changes only what is ` +
        `necessary to fix it. Do not reorganize imports, rename symbols, or rewrite unrelated code. ` +
        `Use only modules and names that already exist in this repository. Respond in the same format as before.`;
      bus.emit({ type: 'log', level: 'warn', message: `Verification failed; retrying with feedback.` });
    }
  }

  task.description = origDesc;
  Learning.recordTier(session.repository.path, task.type, start + iterations - 1, verified);
  return { last, iterations, verified, totalTokens };
}
