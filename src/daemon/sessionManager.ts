// SessionManager — session lifecycle orchestration (spec §14.1).

import { Sessions, Tasks } from '../storage/sessions.js';
import { Reasoning } from '../storage/reasoning.js';
import { Tokens } from '../storage/tokens.js';
import { LongTerm } from '../storage/memory.js';
import { staticAnalysis } from '../analysis/api.js';
import { startWatching, stopWatching } from '../analysis/watcher.js';
import { parseObjective } from '../workers/intentParser.js';
import { generatePlan } from '../workers/planner.js';
import { executeTask, type ExecuteResult } from '../workers/taskExecutor.js';
import { solveWithVerification } from '../workers/solver.js';
import { makeBehavioralVerify } from '../workers/verify/behavioralVerify.js';
import { generateRepro } from '../workers/verify/reproGenerator.js';
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
import type { Session, Task, TokenBudget } from '../types/index.js';

/** Files changed in the working tree (staged + unstaged), for verify test discovery. */
function gitChangedFiles(repoPath: string): string[] {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repoPath, encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function emptyBudget(): TokenBudget {
  return { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 };
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
      current_provider: { provider_id: 'anthropic', model_id: this.cfg.providers.default },
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
      const repro = this.cfg.verify.genRepro
        ? await generateRepro(session.repository.path, `${next.title}\n${next.description}`, '', this.manager, this.cfg, session.id, { timeoutMs: this.cfg.verify.timeoutMs }).catch(() => null)
        : null;
      const bv = makeBehavioralVerify(session.repository.path, changedGetter, { timeoutMs: this.cfg.verify.timeoutMs }, repro);
      let result: ExecuteResult;
      try {
        result = (await solveWithVerification(session, next, this.manager, this.cfg, bv.verify, this.cfg.verify.maxIters)).last;
      } catch (e) {
        bus.emit({ type: 'log', level: 'warn', message: `Behavioral verify infra error (non-blocking): ${String(e).slice(0, 120)}` });
        result = await executeTask(session, next, this.manager, this.cfg);
      }
      repro?.cleanup();
      const bvResults = bv.lastResults() ?? undefined;
      next.status = result.ir.status === 'completed' ? 'completed' : result.ir.status === 'blocked' ? 'blocked' : 'failed';
      next.completed_at = now();
      Tasks.update(next);

      if (next.status === 'completed') {
        session.progress.completed += 1;
        // Verifier pass (spec §12.2) — only when patches were produced.
        if (result.applied.length || result.created.length) {
          try {
            const verdict = await runWorker(
              VerifierWorker,
              { session, task: next, manager: this.manager, cfg: this.cfg, testResults: bvResults },
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
              bus.emit({ type: 'log', level: 'success', message: `Verifier: ${verdict.verdict}` });
            }
          } catch {
            /* verification is best-effort */
          }
        }
      } else if (next.status === 'failed') {
        session.progress.failed += 1;
        next.failure_reason = result.ir.summary;
      }
      this.persist(session);
      await createCheckpoint(session, 'task-complete');
      return next;
    } catch (e) {
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

  async runAll(session: Session): Promise<void> {
    let guard = 0;
    while (guard++ < 100) {
      const t = await this.runNextTask(session);
      if (!t) break;
    }
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
}
