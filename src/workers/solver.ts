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
import { applyWikiUpdate } from '../wiki/updater.js';
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
  exec: (
    s: Session,
    t: Task,
    m: ProviderManager,
    c: Config,
    tier?: number,
    conv?: Conversation,
    model?: string,
  ) => Promise<ExecuteResult> = executeTask,
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
  let firstFailure = '';
  /** The model this task escalated to, if it did. A stack local, not a write to
   *  `cfg.providers.default`: the config object is shared by every task running
   *  in this process, so mutating it escalated everyone else's next call too, and
   *  a throw between the mutation and its restore left the whole process on the
   *  stronger model. Empty means "whatever routing resolves". */
  let escalatedTo = '';
  /** Not the loop index. Escalation opens a NEW conversation, and turn 0 is what
   *  makes the next call send full context — resuming the old id would keep the
   *  old model, since the CLI's --resume path carries no --model flag. */
  let convTurn = 0;
  let freshConversation = false;

  for (let i = 0; i < Math.max(1, maxIters); i++) {
    throwIfCancelled();
    iterations = i + 1;
    bus.emit({ type: 'log', level: 'info', message: `Solver iteration ${iterations}/${maxIters}…` });
    conversation.turn = convTurn;
    // The context budget climbs only after a pass has actually failed at the
    // current size — the first attempt never pays for a window it did not need.
    last = await exec(session, task, manager, cfg, start + i, conversation, escalatedTo || undefined);
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
    // The model has not moved, so a third identical round on the SAME model will
    // not move it either — measured on the benchmark, two haiku iterations gave
    // byte-identical failures. One rung up is the only thing left that can
    // change the answer, and routing across models is the layer's reason to
    // exist. Once per task, and never when the caller pinned the model.
    if (v.output === lastFailure) {
      // Escalate from where this task actually stands: a session switched with
      // /model runs on `current_provider`, not on the global default, so reading
      // the default would step up from a model nobody was using.
      const from = escalatedTo || session.current_provider?.model_id || cfg.providers?.default;
      const stronger = !from || cfg.providers.pinned ? null : manager.strongerThan(from);
      if (stronger && !escalatedTo && i < maxIters - 1) {
        escalatedTo = stronger;
        conversation.id = uuid();
        conversation.provider_id = undefined;
        freshConversation = true;
        bus.emit({ type: 'log', level: 'warn', message: `Stuck on ${from}; escalating this task to ${stronger}.` });
      } else {
        bus.emit({ type: 'log', level: 'warn', message: 'Same failure as the previous iteration; stopping instead of repeating it.' });
        break;
      }
    }
    if (!firstFailure) firstFailure = v.output;
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
      if (freshConversation) {
        convTurn = 0;
        freshConversation = false;
      } else convTurn += 1;
      bus.emit({ type: 'log', level: 'warn', message: `Verification failed; retrying with feedback.` });
    }
  }

  task.description = origDesc;
  Learning.recordTier(session.repository.path, task.type, start + iterations - 1, verified);
  if (verified && iterations > 1 && firstFailure) recordLesson(session, task, firstFailure, last, iterations);
  return { last, iterations, verified, totalTokens };
}

/**
 * A verified fix that took more than one attempt is the only place this tool
 * learns something it could not have looked up: the obvious approach failed
 * here, and a specific change worked instead. Written to the wiki's `playbook`
 * namespace, which the reader prioritises for exactly the task types that
 * iterate — so the next attempt starts from the lesson rather than rediscovering
 * it. Derived entirely from recorded outcomes; no model is asked to reflect.
 */
function recordLesson(session: Session, task: Task, firstFailure: string, last: ExecuteResult, iterations: number): void {
  const files = [...last.applied, ...last.created];
  const primary = files[0]?.split('/').pop()?.replace(/\.[^.]+$/, '') ?? task.type;
  const entry =
    `## ${task.title}\n\n` +
    `The first attempt failed with:\n\n\`\`\`\n${firstFailure.slice(0, 400).trim()}\n\`\`\`\n\n` +
    `Resolved after ${iterations} attempts by: ${last.ir?.summary || 'a follow-up patch'}\n` +
    (files.length ? `Files changed: ${files.join(', ')}\n` : '');
  try {
    applyWikiUpdate({ key: `playbook/${task.type}-${primary}`, content: entry, is_diff: true }, session.id);
  } catch {
    /* a lesson is worth having, never worth failing a verified task over */
  }
}
