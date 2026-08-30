// SessionManager — session lifecycle orchestration (spec §14.1).

import fs from 'fs';
import path from 'path';
import { Sessions, Tasks } from '../storage/sessions.js';
import { Reasoning } from '../storage/reasoning.js';
import { Tokens } from '../storage/tokens.js';
import { LongTerm } from '../storage/memory.js';
import { staticAnalysis } from '../analysis/api.js';
import { isRepoRoot } from '../analysis/git.js';
import { startWatching, stopWatching } from '../analysis/watcher.js';
import { parseObjective } from '../workers/intentParser.js';
import { generatePlan } from '../workers/planner.js';
import { executeTask, type ExecuteResult } from '../workers/taskExecutor.js';
import { solveWithVerification, type VerifyResult } from '../workers/solver.js';
import { makeBehavioralVerify, type TestResults } from '../workers/verify/behavioralVerify.js';
import { generateRepro, generateCharacterization, type Repro } from '../workers/verify/reproGenerator.js';
import { detectFramework } from '../analysis/testRunner.js';
import { runWorker } from '../workers/base.js';
import { VerifierWorker } from '../workers/verifier.js';
import { registerCoreWorkers, nextReadyTask } from '../workers/scheduler.js';
import { createCheckpoint, restoreCheckpoint } from '../workers/checkpointer.js';
import { buildSessionSummary, persistSessionSummary } from '../memory/sessionSummary.js';
import { findIncompleteSessions } from './recovery.js';
import { replayReasoning, renderReplay } from '../memory/replay.js';
import { bootstrapWiki, wikiBootstrapped } from '../wiki/bootstrap.js';
import { ProviderManager } from '../providers/manager.js';
import { bus } from '../events/bus.js';
import { id, now } from '../util/id.js';
import { spawnSync } from 'child_process';
import { loadConfig, setActiveRepo, type Config } from '../config.js';
import { Cancelled, isCancelled } from '../util/cancel.js';
import type { Session, Task, TokenBudget, TaskEvidence, TaskStatus, OracleProvenance } from '../types/index.js';

/** Files changed in the working tree (staged + unstaged), for verify test discovery. */
/**
 * What actually checked this task, and whether that constitutes proof.
 *
 * The rule that matters: a test file this task WROTE cannot verify this task.
 * Before the ledger, a test the model had authored seconds earlier was admitted
 * as a pre-existing oracle and granted full confidence.
 */
function buildEvidence(solverVerified: boolean, bv: TestResults | undefined, result: ExecuteResult): TaskEvidence {
  const touched = new Set([...result.applied, ...result.created]);
  const discovered = bv?.discoveredTests ?? [];
  const selfAuthored = discovered.length > 0 && discovered.every((t) => touched.has(t));

  let provenance: OracleProvenance = 'none';
  if (bv?.reproUsed && bv.ran) provenance = 'repro-admitted';
  else if (selfAuthored) provenance = 'authored-by-task';
  else if (discovered.length > 0 && bv?.ran) provenance = 'pre-existing';

  const verified = solverVerified && (provenance === 'pre-existing' || provenance === 'repro-admitted');

  let reason: string | undefined;
  if (!verified) {
    if (provenance === 'authored-by-task') reason = 'the only tests covering this change were written by this task';
    else if (provenance === 'none') reason = bv?.output || 'no oracle covered this change';
    else reason = bv?.output || 'verification did not confirm the change';
  }

  return {
    verified,
    provenance,
    framework: bv?.framework ?? 'none',
    ran: bv?.ran ?? false,
    passed: bv?.passed ?? 0,
    failed: bv?.failed ?? 0,
    reason,
  };
}

/**
 * Task status from what happened, not from what the model said happened.
 * `ir.status` is the model's self-report and defaults to 'completed', which is
 * why a session could finish green having never executed a line of code.
 */
/** The status AND why. Four different things end a task badly and the reason
 *  used to be taken from the model's summary alone — which is often empty, so a
 *  failed task was reported with no cause at all. */
export function deriveStatus(result: ExecuteResult, evidence: TaskEvidence): { status: TaskStatus; reason?: string } {
  if (result.ir.status === 'blocked') {
    return { status: 'blocked', reason: result.ir.blocked_by.join('; ') || result.ir.summary || 'the model reported it was blocked' };
  }
  if (result.ir.status === 'failed') {
    return { status: 'failed', reason: result.ir.summary || 'the model reported failure without saying why' };
  }
  // Every patch bounced: nothing changed, whatever the summary claims.
  if (result.applied.length + result.created.length === 0 && result.failed.length > 0) {
    return { status: 'failed', reason: `every patch was rejected — ${result.failed.map((f) => `${f.file}: ${f.reason}`).join('; ').slice(0, 400)}` };
  }
  if (evidence.failed > 0) {
    return { status: 'failed', reason: `${evidence.failed} test(s) failed — ${(evidence.reason ?? '').slice(0, 300)}` };
  }
  // Two hard gates say no without any test count: the crash guard and the
  // use-site check. Reading only `failed` let a change that does not even
  // import, or that never touched the file it was asked to fix, report
  // completed and stay in the tree. They record their own name here and
  // record it only when they reject.
  if (evidence.framework === 'guard' || evidence.framework === 'use-sites') {
    return { status: 'failed', reason: (evidence.reason ?? 'a verification gate rejected the change').slice(0, 400) };
  }
  return { status: 'completed' };
}

function gitChangedFiles(repoPath: string): string[] {
  // Only when this directory is itself the top of a work tree. `git status`
  // answers "is this path INSIDE a repository", so running it in a plain
  // directory under a versioned home returned the whole home repo's dirty
  // files, with paths relative to the home directory — and the crash guard
  // then failed on files that do not exist here. This is a supplement to the
  // patcher's own list, never the sole source.
  if (!isRepoRoot(repoPath)) return [];
  // `git diff` cannot see a file that is not tracked yet, so every file the
  // model CREATED was invisible to the crash guard, the use-site gate and the
  // locus check — precisely the files most likely to be wrong.
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoPath, encoding: 'utf8' });
  return (r.stdout ?? '')
    .split('\n')
    .map((l) => l.slice(3).trim())
    // Renames arrive as `old -> new`; only the destination exists on disk.
    .map((l) => (l.includes(' -> ') ? l.split(' -> ')[1]!.trim() : l))
    .filter(Boolean);
}

function emptyBudget(): TokenBudget {
  return { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 };
}

/** File source for a prompt, or null when it is too large to be worth sending. */
function readSource(repoPath: string, rel: string, max: number): string | null {
  try {
    const src = fs.readFileSync(path.join(repoPath, rel), 'utf8');
    return src.length <= max ? src : null;
  } catch {
    return null;
  }
}

export class SessionManager {
  cfg: Config;
  manager: ProviderManager;
  private current: Session | null = null;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  // The Daemon static-analyzer subsystem enables continuous watching (spec §5.3).
  // Left off when SessionManager is driven directly (tests, scripts) so a
  // persistent watcher never keeps the process alive.
  private watchEnabled = false;
  /** One per session; see characterizationFor. `null` records a generation that
   *  was tried and failed, so it is not retried on every task. */
  private characterizations = new Map<string, Repro | null>();

  constructor() {
    this.cfg = loadConfig();
    this.manager = new ProviderManager(this.cfg);
    registerCoreWorkers();
  }

  enableWatching(on = true): void {
    this.watchEnabled = on;
  }

  /** Periodic checkpoint timer (spec §14.3). */
  startCheckpointTimer(): void {
    if (this.checkpointTimer) return;
    const ms = Math.max(1, this.cfg.checkpointing.interval_minutes) * 60_000;
    this.checkpointTimer = setInterval(() => {
      const s = this.current;
      if (s && (s.status === 'active' || s.status === 'planning')) {
        void createCheckpoint(s, 'periodic').catch(() => undefined);
      }
    }, ms);
    if (typeof this.checkpointTimer.unref === 'function') this.checkpointTimer.unref();
  }

  stopCheckpointTimer(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
  }

  getCurrent(): Session | null {
    return this.current;
  }

  setCurrent(s: Session | null): void {
    this.current = s;
  }

  tasksFor(sessionId: string): Task[] {
    return Tasks.forSession(sessionId);
  }

  private persist(s: Session): void {
    s.updated_at = now();
    const tok = Tokens.sessionTotal(s.id);
    s.token_usage = {
      total_input: tok.input,
      total_output: tok.output,
      total: tok.total,
      by_provider: Tokens.byProvider(s.id),
      cost_usd: tok.cost,
    };
    Sessions.update(s);
  }

  // ── create (spec §14.1) ──────────────────────────────────
  async createSession(objective: string, repoPath: string): Promise<Session> {
    setActiveRepo(repoPath);
    const api = staticAnalysis(repoPath);
    const isRepo = await api.git.isRepo();
    const commit = isRepo ? await api.git.headCommit() : 'no-git';

    const session: Session = {
      id: id('session'),
      created_at: now(),
      updated_at: now(),
      status: 'initializing',
      objective,
      objective_parsed: parseObjective(objective),
      repository: { path: repoPath, commit },
      progress: { total: 0, completed: 0, failed: 0 },
      constraints: [],
      open_questions: [],
      working_files: [],
      decisions: [],
      provider_history: [],
      checkpoints: [],
      token_usage: emptyBudget(),
      // Ask which vendor actually owns the default model. Hardcoding 'anthropic'
      // labelled every OpenAI or Gemini session as Anthropic in the handoff
      // package, in /session, and in provider_history.
      current_provider: {
        provider_id: this.manager.providerOf(this.cfg.providers.default),
        model_id: this.cfg.providers.default,
      },
      metadata: {},
    };
    Sessions.insert(session);
    this.current = session;
    bus.emit({ type: 'session.created', session_id: session.id });

    // Ensure repo is indexed (one-time / incremental). Embeddings enabled for
    // semantic file selection (spec §5.2.8); degrades gracefully if unavailable.
    if (!api.stats()) {
      bus.emit({ type: 'worker.started', worker: 'StaticIndexer', detail: 'indexing repository' });
      const stats = await api.reindex({ embed: true });
      bus.emit({ type: 'worker.finished', worker: 'StaticIndexer', detail: `${stats.files} files, ${stats.symbols} symbols` });
    } else if (!api.embeddingsReady()) {
      await api.embedAll().catch(() => 0);
    }

    // One-time wiki bootstrap on first session for this repo (spec §9.6).
    if (!wikiBootstrapped()) {
      try {
        const r = await bootstrapWiki(repoPath, this.manager, this.cfg, session.id);
        bus.emit({ type: 'log', level: 'info', message: `Wiki bootstrapped: ${r.modules} modules, ${r.docsImported} docs imported` });
      } catch {
        /* bootstrap is best-effort */
      }
    }

    // Reasoning replay onboarding (spec §8.4) — surface prior reasoning relevant
    // to this objective instead of replaying conversations.
    const kws = session.objective_parsed?.keywords ?? [];
    if (kws.length) {
      const replay = replayReasoning(kws, 12);
      if (replay.reasoning.length || replay.failures.length || replay.decisions.length) {
        bus.emit({ type: 'log', level: 'info', message: `Replaying ${replay.reasoning.length} prior reasoning object(s), ${replay.failures.length} known failure(s).` });
        bus.emit({ type: 'log', level: 'debug', message: renderReplay(replay) });
      }
    }

    // Continuous incremental indexing while the session is active (spec §5.3).
    if (this.watchEnabled && this.cfg.indexing.auto_index) startWatching(repoPath);

    return session;
  }

  async plan(session: Session): Promise<Task[]> {
    session.status = 'planning';
    this.persist(session);
    const { plan } = await generatePlan(session, this.manager, this.cfg);
    session.plan = plan;
    Tasks.replaceForSession(session.id, plan.tasks);
    session.progress = { total: plan.tasks.length, completed: 0, failed: 0 };
    session.status = 'active';
    this.persist(session);
    bus.emit({ type: 'session.started', session_id: session.id });
    return plan.tasks;
  }

  /** Execute the next pending task (spec §14.1 task loop). */
  async runNextTask(session: Session): Promise<Task | null> {
    const tasks = Tasks.forSession(session.id);
    const next = nextReadyTask(tasks);
    if (!next) return null;

    // Token budget enforcement (spec §20.2) — honor hard_limit_behavior.
    const spent = Tokens.sessionTotal(session.id).total;
    const cap = this.cfg.token_budget.session_default;
    const warnAt = cap * (this.cfg.token_budget.warning_at_percent / 100);
    if (spent >= cap) {
      const behavior = this.cfg.token_budget.hard_limit_behavior;
      if (behavior === 'pause') {
        bus.emit({ type: 'log', level: 'error', message: `Token budget reached (${spent}/${cap}). Session paused.` });
        await this.pause(session);
        return null;
      }
      if (behavior === 'warn') {
        bus.emit({ type: 'log', level: 'warn', message: `Token budget exceeded (${spent}/${cap}). Continuing (hard_limit_behavior=warn).` });
      }
      // 'continue' falls through silently.
    } else if (spent >= warnAt) {
      bus.emit({ type: 'quota.warning', account_id: 'session', percent_used: Math.round((spent / cap) * 100) });
      bus.emit({ type: 'log', level: 'warn', message: `Token budget at ${Math.round((spent / cap) * 100)}% (${spent}/${cap}).` });
    }

    next.status = 'in_progress';
    next.started_at = now();
    session.progress.current_task_id = next.id;
    Tasks.update(next);

    try {
      // Behavioral verify-iterate (spec §12.2/§14.1, §2 rule 1): the orchestrator
      // runs a deterministic hard gate — crash-guard → admitted repro (synthesized
      // from the task, admitted only if it fails on the current code) → the repo's
      // own relevant tests — and feeds concrete failures back for self-correction.
      // Infra errors fall back to a single bare execution (best-effort, as before).
      const changedGetter = () => gitChangedFiles(session.repository.path);
      // Files the task actually named — the locus a green suite must have touched
      // for `verified` to mean anything.
      const locus = next.input_files.map((f) => f.path);
      // Synthesizing a repro costs an LLM call per task (§6 W5). It only adds
      // signal where the repo has no test covering the locus already; when tests
      // exist they are the stronger oracle, and the call bought nothing.
      const covered = locus.length > 0 && staticAnalysis(session.repository.path).relevantTests(locus).length > 0;
      // The source of the files the task names, capped. Signatures alone were not
      // enough: a test that must FAIL on the current code has to be written
      // against what that code actually does, and every repro attempt that only
      // saw signatures asserted behavior the buggy code already satisfied — so it
      // passed, and was discarded. Reading the file is free; withholding it cost
      // the run its only oracle.
      // The locus files plus what they import. A repro has to CONSTRUCT the values
      // the locus consumes, and the constraints on those values (an id coerced
      // with `int()`, a required field) live in the dependency, not in the file
      // being fixed. Without them the generated test dies building its inputs.
      const analysis = staticAnalysis(session.repository.path);
      const deps = locus.flatMap((f) => analysis.getDependencies(f)).filter((d) => !locus.includes(d));
      const hint = [...new Set([...locus, ...deps])]
        .slice(0, 6)
        .flatMap((f) => {
          const src = readSource(session.repository.path, f, 4000);
          if (src) return [`# ${f}\n${src}`];
          const syms = analysis.symbolsInFile(f, 12);
          return syms.length ? [`# ${f}`, ...syms.map((sy) => `  ${sy.signature || sy.name}`)] : [];
        })
        .join('\n\n')
        .slice(0, 12_000);
      const problem = `${next.title}\n${next.description}`;
      const genOpts = { timeoutMs: this.cfg.verify.timeoutMs };
      // Independent calls to two different vendors' worth of latency, run one
      // after the other. Each also shells out to pytest up to three times to
      // admit its result, so the pair was the longest non-solving stretch of
      // the run. They share nothing: separate directories, read-only on the repo.
      const oracles = Promise.all([
        this.cfg.verify.genRepro && !covered
          ? generateRepro(session.repository.path, problem, hint, this.manager, this.cfg, session.id, genOpts).catch(() => null)
          : Promise.resolve(null),
        this.characterizationFor(session, hint),
      ]);

      // Not awaited here. Generating an oracle costs LLM calls plus up to three
      // pytest runs to admit the result — measured on config-precedence, 138s of
      // a 409s run, and for one task 113s that admitted nothing. None of it is
      // needed until the solver has produced something to check, and since the
      // admission gates now run against a snapshot rather than the live tree,
      // generating while the solver patches is safe.
      type BV = ReturnType<typeof makeBehavioralVerify>;
      let bv: BV | null = null;
      const verify = async (changed: string[]): Promise<VerifyResult> => {
        if (!bv) {
          const [r, c] = await oracles;
          bv = makeBehavioralVerify(session.repository.path, changedGetter, genOpts, r, locus, c);
        }
        return (bv as BV).verify(changed);
      };
      let result: ExecuteResult;
      // The solver's own verdict, which used to be dropped on the floor here —
      // `.last` discarded `verified`, so the only real signal in the pipeline
      // never reached the task record.
      let solverVerified = false;
      try {
        const solved = await solveWithVerification(session, next, this.manager, this.cfg, verify, this.cfg.verify.maxIters);
        result = solved.last;
        solverVerified = solved.verified;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        bus.emit({ type: 'log', level: 'warn', message: `Behavioral verify infra error (non-blocking): ${String(e).slice(0, 120)}` });
        result = await executeTask(session, next, this.manager, this.cfg);
      }
      // Resolved by now in every path that verified; awaited anyway so a run that
      // fell through to executeTask still cleans up the generated test.
      const [generatedRepro] = await oracles;
      generatedRepro?.cleanup();
      const bvResults = (bv as BV | null)?.lastResults() ?? undefined;
      next.evidence = buildEvidence(solverVerified, bvResults, result);
      const derived = deriveStatus(result, next.evidence);
      next.status = derived.status;
      if (derived.reason) next.failure_reason = derived.reason;
      next.completed_at = now();
      next.output_files = [...new Set([...result.applied, ...result.created])].map((path) => ({ path }));

      // A failed task keeps its work. Deleting it is not a gate — it destroyed
      // the only deliverable of a run whose files were correct and whose gate
      // was wrong. The undo journal is written for every patch, so `/undo`
      // reverses it in one command when that is actually what is wanted.
      if (next.status === 'failed' && next.output_files.length > 0) {
        bus.emit({
          type: 'log',
          level: 'warn',
          message: `Task failed but its changes were kept: ${next.output_files.map((f) => f.path).join(', ')} — /undo to reverse.`,
        });
      }
      Tasks.update(next);

      if (next.status === 'completed') {
        session.progress.completed += 1;
        // Verifier pass (spec §12.2) — only when patches were produced.
        if ((result.applied.length || result.created.length) && !next.evidence.verified) {
          try {
            const verdict = await runWorker(
              VerifierWorker,
              {
                session,
                task: next,
                manager: this.manager,
                cfg: this.cfg,
                testResults: bvResults,
                files: next.output_files.map((f) => f.path),
              },
              { repoPath: session.repository.path, sessionId: session.id },
            );
            if (verdict.verdict === 'fail') {
              bus.emit({ type: 'log', level: 'warn', message: `Verifier: ${verdict.summary || 'task failed verification'}` });
              // Self-correct once with the verifier's feedback (spec §14.1).
              const origDesc = next.description;
              const feedback = verdict.summary || (verdict.issues ?? []).join('; ') || 'failed verification';
              next.description = `${origDesc}\n\nYour previous attempt FAILED verification: ${feedback}\nProduce a corrected solution that fixes these issues.`;
              bus.emit({ type: 'log', level: 'info', message: 'Retrying task with verifier feedback…' });
              const retry = await executeTask(session, next, this.manager, this.cfg).catch(() => null);
              next.description = origDesc;
              if (retry && retry.ir.status === 'completed') {
                bus.emit({ type: 'log', level: 'success', message: 'Self-correction applied.' });
                Tasks.update(next);
              }
            } else {
              // Advisory only. A model opinion is not evidence, and on the
              // benchmark this path returned "pass" for mathematically wrong
              // code that had never been executed.
              bus.emit({ type: 'log', level: 'info', message: `Verifier (advisory): ${verdict.verdict}` });
            }
          } catch {
            /* verification is best-effort */
          }
        }
      } else if (next.status === 'failed') {
        session.progress.failed += 1;
      }
      this.persist(session);
      await createCheckpoint(session, 'task-complete');
      return next;
    } catch (e) {
      // A cancelled task was not attempted to completion and did not fail on its
      // merits — it goes back on the queue so /run picks it up again.
      if (e instanceof Cancelled) {
        next.status = 'pending';
        Tasks.update(next);
        this.persist(session);
        bus.emit({ type: 'log', level: 'warn', message: `Cancelled: ${next.title} returned to the queue.` });
        throw e;
      }
      next.status = 'failed';
      next.failed_at = now();
      next.failure_reason = String(e);
      Tasks.update(next);
      session.progress.failed += 1;
      this.persist(session);
      bus.emit({ type: 'task.failed', task_id: next.id, reason: String(e) });
      throw e;
    }
  }

  /** The regression half of the oracle, generated ONCE per session and admitted
   *  against the pristine tree. Regenerating it per task would admit a test that
   *  passes on code an earlier task had already broken, cementing the regression
   *  instead of catching it. Only where the repo ships no tests of its own —
   *  where it does, those tests say this already and say it better. */
  private async characterizationFor(session: Session, hint: string): Promise<Repro | null> {
    if (!this.cfg.verify.genRepro) return null;
    const repoPath = session.repository.path;
    if (detectFramework(repoPath) !== 'unknown') return null;
    const cached = this.characterizations.get(session.id);
    if (cached !== undefined) return cached;
    const made = await generateCharacterization(
      repoPath,
      session.objective,
      hint,
      this.manager,
      this.cfg,
      session.id,
      { timeoutMs: this.cfg.verify.timeoutMs },
    ).catch(() => null);
    this.characterizations.set(session.id, made);
    return made;
  }

  async runAll(session: Session): Promise<void> {
    // Bound by the real plan size (with headroom for tasks added mid-run)
    // rather than a magic 100 that silently truncated longer plans.
    const limit = Math.max(Tasks.forSession(session.id).length * 2, 20);
    let ran = 0;
    while (ran < limit) {
      if (isCancelled()) return;
      let t: Task | null;
      try {
        t = await this.runNextTask(session);
      } catch (e) {
        // A cancel is the user's decision and ends the run. Anything else is one
        // task's problem: it is already recorded as failed, so let the rest of
        // the plan proceed instead of abandoning the session mid-flight — that
        // abandonment is what left sessions `active` forever, with their
        // reasoning never reaching long-term memory.
        if (e instanceof Cancelled) throw e;
        ran += 1;
        continue;
      }
      if (!t) break;
      ran += 1;
    }

    const tasks = Tasks.forSession(session.id);
    const unrun = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    // Record WHY each one never ran, rather than leaving it `pending` forever
    // and the session `active` forever. A stranded task is a result too.
    // A paused session is resumable: its remaining tasks stay `pending` so
    // /resume can pick them up. Anything else is over, so say why.
    if (session.status === 'paused') {
      if (unrun.length > 0) bus.emit({ type: 'log', level: 'warn', message: `${unrun.length} task(s) still pending — session paused.` });
      return;
    }
    const reason = ran >= limit ? `stopped after ${ran} task runs (iteration limit)` : 'dependencies never completed';
    for (const t of unrun) {
      t.status = 'blocked';
      t.failure_reason = reason;
      Tasks.update(t);
    }
    if (unrun.length > 0) {
      bus.emit({ type: 'log', level: 'warn', message: `${unrun.length} task(s) blocked — ${reason}.` });
    }

    // Always close the session, whatever the plan did. `complete()` used to be
    // reachable only when every task succeeded, so any real run — the ones with
    // something worth remembering — left the session `active` and its reasoning
    // never reached the long-term memory tier.
    await this.complete(session);
  }

  async pause(session: Session): Promise<void> {
    await createCheckpoint(session, 'pre-pause');
    session.status = 'paused';
    this.persist(session);
    void stopWatching(session.repository.path);
    bus.emit({ type: 'session.paused', session_id: session.id });
  }

  resume(sessionId?: string): Session | null {
    const target = sessionId ? Sessions.get(sessionId) : Sessions.mostRecentActive();
    if (!target) return null;
    // Prefer checkpoint state if present.
    const restored = target.latest_checkpoint ? restoreCheckpoint(target.latest_checkpoint) : null;
    const session = restored ?? target;
    session.status = 'active';
    this.persist(session);
    this.current = session;
    if (this.watchEnabled && this.cfg.indexing.auto_index) startWatching(session.repository.path);
    bus.emit({ type: 'session.resumed', session_id: session.id });
    return session;
  }

  async complete(session: Session): Promise<void> {
    session.status = 'completing';
    this.persist(session);
    this.characterizations.get(session.id)?.cleanup();
    this.characterizations.delete(session.id);

    // Promote important decisions to long-term memory (spec §14.1).
    const reasoning = Reasoning.forSession(session.id);
    for (const r of reasoning) {
      if (r.type === 'decision' && r.importance >= 0.7) {
        LongTerm.upsert({
          id: id('ltm'),
          namespace: 'architecture',
          key: r.summary.slice(0, 60),
          value_json: JSON.stringify(r),
          value_markdown: `${r.summary}\n\n${r.detail}`,
          importance: r.importance,
          confidence: r.confidence,
          created_at: now(),
          updated_at: now(),
          source_session_id: session.id,
          source_decision_id: r.id,
          tags: r.tags,
          permanent: true,
        });
      }
    }

    // Session summarization record (spec §16.3).
    const summary = buildSessionSummary(session);
    persistSessionSummary(summary);
    bus.emit({ type: 'log', level: 'info', message: `Session summary: ${summary.key_decisions.length} key decisions, ${summary.files_modified.length} files` });

    await createCheckpoint(session, 'manual');
    session.status = 'completed';
    this.persist(session);
    void stopWatching(session.repository.path);
    bus.emit({ type: 'session.completed', session_id: session.id });
  }

  async checkpoint(session: Session): Promise<void> {
    await createCheckpoint(session, 'manual');
  }

  /** Detect (don't auto-mutate) incomplete sessions at startup (spec §14.5). */
  async recoverOnStartup(): Promise<number> {
    return findIncompleteSessions().length;
  }

  /**
   * Close out sessions abandoned by a previous process — a crash or Ctrl-C left
   * them `active` forever, so their reasoning never reached long-term memory.
   * A session is stale when every task has reached a terminal state and nothing
   * has touched it for `olderThanHours`. Returns the ids that were completed.
   */
  async reapStaleSessions(olderThanHours = 24): Promise<string[]> {
    const cutoff = Date.now() - olderThanHours * 3_600_000;
    const reaped: string[] = [];
    for (const s of findIncompleteSessions()) {
      if (s.id === this.current?.id) continue;
      if (Date.parse(s.updated_at) > cutoff) continue;
      const tasks = Tasks.forSession(s.id);
      if (tasks.length === 0) continue;
      if (tasks.some((t) => t.status === 'pending' || t.status === 'in_progress')) continue;
      await this.complete(s);
      reaped.push(s.id);
    }
    return reaped;
  }
}
