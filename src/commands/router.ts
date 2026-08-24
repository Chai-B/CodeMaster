// Command router — dispatches deterministic commands to workers (spec §17.1).
// Emits log/heading events on the bus; the TUI renders them.

import { SessionManager } from '../daemon/sessionManager.js';
import { Sessions, Tasks } from '../storage/sessions.js';
import { Reasoning } from '../storage/reasoning.js';
import { LongTerm } from '../storage/memory.js';
import { replayReasoning, renderReplay } from '../memory/replay.js';
import { Wiki } from '../storage/wiki.js';
import { Tokens } from '../storage/tokens.js';
import { PromptCache } from '../storage/promptCache.js';
import { Checkpoints } from '../storage/checkpoints.js';
import { Undo, revert } from '../storage/undo.js';
import { staticAnalysis } from '../analysis/api.js';
import { GitWorker } from '../analysis/git.js';
import { claudeCliAvailable } from '../providers/anthropic.js';
import { codexCliAvailable } from '../providers/codex.js';
import fs from 'fs';
import path from 'path';
import { compileContext } from '../context/compiler.js';
import { createCheckpoint, restoreCheckpoint, verifyCheckpointState } from '../workers/checkpointer.js';
import { compileHandoffPackage, validateHandoffPackage, renderHandoffPackage } from '../workers/handoff.js';
import { QuotaLedger } from '../providers/quotaLedger.js';
import { Learning } from '../learning/reflector.js';
import { MemoryCompressorWorker } from '../workers/memoryCompressor.js';
import { runWorker } from '../workers/base.js';
import { applyDecay, findCompressionCandidates } from '../memory/lifecycle.js';
import { recoverAll } from '../daemon/recovery.js';
import { tokensByTaskType, providerEfficiency, profileTask } from '../analysis/tokenAnalytics.js';
import { listPlugins, listCommandPlugins, getCommandPlugin } from '../plugins/loader.js';
import { bootstrapWiki } from '../wiki/bootstrap.js';
import { applyWikiUpdate } from '../wiki/updater.js';
import { bus } from '../events/bus.js';
import { fmtTokens } from '../util/tokens.js';
import { COMMANDS } from './catalog.js';
import { beginCancellable, Cancelled, endCancellable } from '../util/cancel.js';
import { activeRepoPath, listProjects, loadConfig, saveConfig, CONFIG_PATH } from '../config.js';
import { listWorkers, topoOrder, registerCoreWorkers } from '../workers/scheduler.js';
import type { Session } from '../types/index.js';

registerCoreWorkers();

type Out = (level: 'info' | 'warn' | 'error' | 'success' | 'heading' | 'sep' | 'dim', msg: string) => void;

export class CommandRouter {
  verbose = false;
  constructor(public sm: SessionManager) {}

  private out: Out = (level, msg) => {
    bus.emit({ type: 'log', level, message: msg });
  };

  /** Returns true if the input was handled as a command. */
  async dispatch(input: string): Promise<void> {
    const text = input.trim();
    if (!text) return;

    if (!text.startsWith('/')) {
      await this.objective(text);
      return;
    }

    const parts = text.split(/\s+/);
    const cmd = parts[0]!.toLowerCase();
    const arg = text.slice(cmd.length).trim();

    if (arg === '--help' || arg === '-h') return this.usage(cmd);

    try {
      await this.route(cmd, arg, parts.slice(1));
    } catch (e) {
      this.out('error', `${cmd} failed: ${String(e).replace(/^Error:\s*/, '')}`);
      const hint = nextStepFor(String(e));
      if (hint) this.out('dim', `  → ${hint}`);
    }
  }

  private async route(cmd: string, arg: string, args: string[]): Promise<void> {
    switch (cmd) {
      case '/new': return this.objective(arg, true);
      case '/resume': return this.resume(arg);
      case '/pause': return this.pause();
      case '/complete': return this.complete();
      case '/session': return this.session(args);
      case '/plan': return this.plan();
      case '/tasks': return this.tasks();
      case '/task': return this.taskDetail(arg);
      case '/run': return this.run(false);
      case '/runall': return this.run(true);
      case '/skip': return this.skip(arg);
      case '/provider': return this.provider(args);
      case '/cost': return this.cost();
      case '/waste': return this.waste();
      case '/model': return this.model(arg);
      case '/config': return this.config(args);
      case '/diff': return this.diff(arg);
      case '/undo': return this.undo(arg);
      case '/why': return this.why(arg);
      case '/learn': return this.learn();
      case '/projects': return this.projects();
      case '/account': return this.account(args);
      case '/handoff': return this.handoff(arg);
      case '/memory': return this.memory(args);
      case '/wiki': return this.wiki(args);
      case '/reasoning': return this.reasoning(args);
      case '/forget': return this.forget(arg);
      case '/reindex': return this.reindex();
      case '/rebuild-map': return this.rebuildMap();
      case '/graph': return this.graph(arg);
      case '/checkpoint': return this.checkpoint();
      case '/checkpoints': return this.checkpoints(args);
      case '/tokens': return this.tokens(arg);
      case '/context': return this.context();
      case '/stats': return this.stats();
      case '/health': return this.health();
      case '/doctor': return this.doctor();
      case '/workers': return this.workers();
      case '/replay': return this.replay(arg);
      case '/profile': return this.profile(arg);
      case '/verbose': this.verbose = arg !== 'off'; this.out('success', `Verbose ${this.verbose ? 'on' : 'off'}`); return;
      case '/recover': return this.recover();
      case '/plugins': return this.plugins();
      case '/help': return this.help(arg);
      default: {
        const plugin = getCommandPlugin(cmd);
        if (plugin) {
          await plugin.run(args, (level, msg) => this.out(level as 'info', msg));
          return;
        }
        this.out('error', `Unknown command: ${cmd}`);
        const near = COMMANDS.filter((c) => c.cmd.startsWith(cmd.slice(0, 3))).map((c) => c.cmd);
        this.out('dim', near.length ? `  → Did you mean ${near.join(' or ')}?` : '  → /help lists every command.');
      }
    }
  }

  private requireSession(): Session | null {
    const s = this.sm.getCurrent();
    if (!s) {
      this.out('warn', 'No active session. Use /new <objective> first.');
      return null;
    }
    return s;
  }

  // ── Session ───────────────────────────────────────────────
  private async objective(text: string, explicit = false): Promise<void> {
    if (!text) {
      this.out('warn', 'Usage: /new <objective>');
      return;
    }
    this.out('heading', 'New session');
    const session = await this.sm.createSession(text, process.cwd());
    this.out('success', `Session ${session.id} created`);
    this.out('dim', `Objective: ${session.objective}`);
    this.out('dim', `Type: ${session.objective_parsed?.task_type}`);
    await this.plan();
    void explicit;
  }

  private async resume(arg: string): Promise<void> {
    const s = this.sm.resume(arg || undefined);
    if (!s) {
      this.out('warn', 'No session to resume.');
      return;
    }
    // Verify the working tree still matches the checkpoint (spec §14.4).
    const check = await verifyCheckpointState(s);
    if (check && !check.matches) {
      this.out('warn', 'Repository changed since checkpoint — review before continuing:');
      this.out('dim', `  checkpoint @ ${check.checkpointCommit.slice(0, 8)} · current @ ${check.currentCommit.slice(0, 8)}`);
      if (check.workingDiff.trim()) {
        const files = check.workingDiff.split('\n').filter((l) => l.startsWith('+++ ')).length;
        this.out('dim', `  uncommitted changes in ~${files} file(s). Use /checkpoints diff to inspect.`);
      }
    }
    this.out('success', `Resumed ${s.id} (${s.status})`);
    this.tasks();
  }

  private async pause(): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    await this.sm.pause(s);
    this.out('success', 'Session paused + checkpointed');
  }

  private async complete(): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    await this.sm.complete(s);
    this.out('success', `Session ${s.id} completed`);
  }

  private session(args: string[]): void {
    if (args[0] === 'info' && args[1]) {
      const s = Sessions.get(args[1]);
      if (!s) return this.out('warn', 'Not found');
      this.out('heading', `Session ${s.id}`);
      this.out('info', `Status: ${s.status}`);
      this.out('info', `Objective: ${s.objective}`);
      this.out('info', `Progress: ${s.progress.completed}/${s.progress.total}`);
      this.out('info', `Tokens: ${fmtTokens(s.token_usage.total)}  Cost: $${s.token_usage.cost_usd.toFixed(3)}`);
      return;
    }
    this.out('heading', 'Sessions');
    const list = Sessions.list(20);
    if (!list.length) return this.out('dim', 'No sessions yet.');
    for (const s of list) {
      this.out('info', `${s.status.padEnd(11)} ${s.id}  ${s.objective.slice(0, 50)}`);
    }
  }

  // ── Planning ──────────────────────────────────────────────
  private async plan(): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    this.out('heading', 'Planning');
    if (!this.sm.manager.hasAnyProvider()) {
      this.out('warn', 'No provider credentials — planning needs an LLM. Session created; set an API key, run `claude setup-token`, or /account add, then run /plan.');
      return;
    }
    const tasks = await this.sm.plan(s);
    this.out('success', `Plan generated: ${tasks.length} tasks`);
    this.tasks();
    this.out('dim', 'Run /run to execute the next task, or /runall for all.');
  }

  private tasks(): void {
    const s = this.requireSession();
    if (!s) return;
    const tasks = Tasks.forSession(s.id);
    if (!tasks.length) return this.out('dim', 'No tasks. Use /plan.');
    this.out('heading', 'Tasks');
    const icon: Record<string, string> = {
      completed: '✓', in_progress: '►', pending: '·', failed: '✗', blocked: '⊘', skipped: '−',
    };
    tasks.forEach((t, i) => this.out('info', `${icon[t.status] ?? '·'} ${i + 1}. [${t.type}] ${t.title}`));
  }

  private taskDetail(arg: string): void {
    const s = this.requireSession();
    if (!s) return;
    const tasks = Tasks.forSession(s.id);
    const idx = Number(arg) - 1;
    const t = tasks[idx] ?? tasks.find((x) => x.id === arg);
    if (!t) return this.out('warn', 'Task not found (use index or id)');
    this.out('heading', t.title);
    this.out('info', `Type: ${t.type}  Status: ${t.status}`);
    this.out('info', t.description);
    if (t.actual_tokens) this.out('dim', `Tokens: ${fmtTokens(t.actual_tokens)}`);
    if (t.failure_reason) this.out('error', `Failure: ${t.failure_reason}`);
  }

  private async run(all: boolean): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    if (!this.sm.manager.hasAnyProvider()) return this.out('warn', 'No provider credentials — set an API key, run `claude setup-token`, or /account add.');
    // Ctrl-C during a run stops the run, not the process: the session, its
    // reasoning and the work already on disk all survive.
    beginCancellable();
    try {
      if (all) {
        await this.sm.runAll(s);
        this.out('success', `Done. ${s.progress.completed}/${s.progress.total} completed, ${s.progress.failed} failed`);
      } else {
        const t = await this.sm.runNextTask(s);
        if (!t) this.out('dim', 'No pending tasks.');
        else this.out('success', `Task "${t.title}" → ${t.status}`);
      }
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
      this.out('warn', 'Stopped. The session is intact — /run resumes where it left off.');
    } finally {
      endCancellable();
    }
  }

  private skip(arg: string): void {
    const s = this.requireSession();
    if (!s) return;
    const tasks = Tasks.forSession(s.id);
    const t = tasks[Number(arg) - 1] ?? tasks.find((x) => x.id === arg);
    if (!t) return this.out('warn', 'Task not found');
    t.status = 'skipped';
    Tasks.update(t);
    this.out('success', `Skipped: ${t.title}`);
  }

  // ── Provider ──────────────────────────────────────────────
  private provider(args: string[]): void {
    if (args[0] === 'use' && args[1]) {
      if (!this.sm.manager.modelSpec(args[1])) return this.out('warn', `Unknown model: ${args[1]}`);
      const providerId = this.sm.manager.providerOf(args[1]);
      const s = this.sm.getCurrent();
      if (s) {
        s.current_provider = { provider_id: providerId, model_id: args[1] };
        Sessions.update(s);
      }
      this.out('success', `Provider model set to ${args[1]} (${providerId})`);
      return;
    }
    this.out('heading', 'Providers');
    for (const p of this.sm.manager.listProviders()) this.out('info', `• ${p}`);
    this.out('heading', 'Models');
    for (const m of this.sm.manager.listModels()) {
      this.out('info', `${m.id}  ctx ${fmtTokens(m.context_size)}  $${m.cost_per_1m_input}/$${m.cost_per_1m_output} per 1M`);
    }
  }

  private account(args: string[] = []): void {
    if (args[0] === 'add' && args[1] && args[2]) {
      // /account add <provider> <alias>  (key read from env CODEMASTER_NEW_KEY)
      const key = process.env.CODEMASTER_NEW_KEY;
      if (!key) return this.out('warn', 'Set CODEMASTER_NEW_KEY env to the API key, then: /account add <provider> <alias>');
      const acct = this.sm.manager.addAccount(args[1], args[2], key);
      return this.out(acct ? 'success' : 'error', acct ? `Added account ${args[2]} (${args[1]})` : `Unknown provider ${args[1]}`);
    }
    if (args[0] === 'remove' && args[1]) {
      const removed = this.sm.manager.removeAccount(args[1]);
      return this.out(removed ? 'success' : 'warn', `Account ${args[1]} ${removed ? 'removed' : 'not found'}`);
    }
    this.out('heading', 'Accounts');
    for (const a of this.sm.manager.listAccounts()) {
      this.out('info', `${a.alias} (${a.provider_id})  health: ${a.health.status}  used today: ${fmtTokens(a.quota.tokens_used_today)}`);
    }
  }

  /** What this repository has taught the tool — observations only. */
  /**
   * Every repository CodeMaster holds state for. One repo is one project: its
   * sessions, reasoning, wiki and checkpoints live in its own directory, so
   * nothing leaks between them. To work in another project, start CodeMaster
   * there (or pass `--repo`) — the active project always follows the repo.
   */
  private projects(): void {
    const active = activeRepoPath();
    const all = listProjects();
    if (!all.length) return this.out('info', 'No projects yet — the first session in a repository creates one.');
    this.out('heading', 'Projects');
    for (const p of all) {
      const sessions = Sessions.list(500, p.path);
      const marker = p.path === active ? '●' : ' ';
      const note = p.exists ? '' : '  (repository no longer on disk)';
      this.out(p.exists ? 'info' : 'dim', `${marker} ${p.path}  ${sessions.length} session(s)${note}`);
    }
    this.out('dim', `State lives under ${all[0]!.dir.replace(/\/[^/]+$/, '')}`);
  }

  private learn(): void {
    const repo = this.sm.getCurrent()?.repository.path ?? process.cwd();
    const { files, tiers } = Learning.report(repo);
    if (!files.length && !tiers.length) {
      return this.out('info', 'Nothing learned yet — run a few tasks in this repository first.');
    }
    if (files.length) {
      this.out('heading', 'Files the model was given but did not use');
      for (const f of files) {
        this.out(f.rate < 0.34 ? 'warn' : 'info', `${f.path}  referenced ${f.referenced}/${f.included} times (${(f.rate * 100).toFixed(0)}%)`);
      }
    }
    if (tiers.length) {
      this.out('heading', 'Context budget tiers that produced a verified result');
      for (const t of tiers) {
        this.out('info', `${t.task_type}  tier ${t.tier}  ${t.verified ? 'verified' : 'unverified'} ×${t.count}`);
      }
    }
  }

  /** What each subscription window has actually spent, and what is blocked. */
  private cost(): void {
    const waste = Tokens.wasteRatio();
    if (waste) {
      this.out(
        waste.ratio > 0.25 ? 'warn' : 'info',
        `Context waste: ${fmtTokens(waste.wasted)} of ${fmtTokens(waste.input)} input tokens went to files no response referenced (${(waste.ratio * 100).toFixed(1)}%).`,
      );
    }
    const reuse = PromptCache.saved();
    if (reuse.hits > 0) {
      this.out('info', `Reused answers: ${reuse.hits} identical request(s) served from cache, ${fmtTokens(reuse.tokens)} tokens not spent.`);
    }
    const cache = Tokens.cacheReuse();
    if (cache) {
      this.out(
        'info',
        `Prefix cache: ${fmtTokens(cache.cached)} of ${fmtTokens(cache.input)} input tokens were reused (${(cache.ratio * 100).toFixed(0)}%), ${fmtTokens(cache.fresh)} fresh.`,
      );
    }
    const states = QuotaLedger.all();
    if (!states.length) return this.out('info', 'No provider usage recorded yet.');
    this.out('heading', 'Provider windows');
    for (const st of states) {
      const blockedMs = QuotaLedger.blockedForMs(st.key, st.provider_id);
      const parts = [`${fmtTokens(st.tokens_used)} in ${st.requests} call(s) since ${st.window_start.slice(11, 16)}Z`];
      if (blockedMs > 0) parts.push(`blocked ${Math.ceil(blockedMs / 1000)}s`);
      if (st.consecutive_failures > 0) parts.push(`${st.consecutive_failures} consecutive failure(s)`);
      this.out(blockedMs > 0 ? 'warn' : 'info', `${st.key}  ${parts.join('  ·  ')}`);
    }
  }

  private async handoff(arg: string): Promise<void> {
    const s = this.requireSession();
    if (!s || !arg) return this.out('warn', 'Usage: /handoff <model_id>');
    const spec = this.sm.manager.modelSpec(arg);
    if (!spec) return this.out('warn', `Unknown model: ${arg}. See /provider.`);
    await createCheckpoint(s, 'pre-switch');
    const pkg = await compileHandoffPackage(s);
    const valid = validateHandoffPackage(pkg);
    if (!valid.ok) this.out('warn', `Handoff package incomplete: ${valid.missing.join(', ')}`);
    const from = s.current_provider?.model_id ?? 'none';
    const providerId = this.sm.manager.providerOf(arg);
    s.current_provider = { provider_id: providerId, model_id: arg };
    s.provider_history.push({ provider_id: providerId, model_id: arg });
    // The new provider receives the handoff package as initial context (spec §13.6).
    s.metadata = { ...(s.metadata ?? {}), pending_handoff: renderHandoffPackage(pkg) };
    Sessions.update(s);
    bus.emit({ type: 'provider.switched', from, to: arg });
    this.out('success', `Handoff ${from} → ${arg} (${providerId})`);
    this.out('dim', `Package: ${pkg.completed_tasks.length} completed, ${pkg.remaining_tasks.length} remaining, ${pkg.key_decisions.length} decisions carried`);
  }

  // ── Memory / Wiki ─────────────────────────────────────────
  private async memory(args: string[]): Promise<void> {
    if (args[0] === 'compress') {
      const updated = applyDecay();
      const cands = findCompressionCandidates(this.sm.cfg.memory.importance_threshold, this.sm.cfg.memory.age_days_before_eligible);
      this.out('heading', 'Memory compression');
      this.out('info', `Decay applied to ${updated} reasoning objects`);
      if (!cands.length) return this.out('dim', 'No objects eligible for summarization.');
      if (!process.env.ANTHROPIC_API_KEY) return this.out('warn', `${cands.length} eligible, but no API key for summarization.`);
      const s = this.sm.getCurrent();
      const res = await runWorker(MemoryCompressorWorker,
        { sessionId: s?.id ?? 'maintenance', manager: this.sm.manager, cfg: this.sm.cfg, candidates: cands.slice(0, 10) },
        { repoPath: process.cwd(), sessionId: s?.id });
      this.out('success', `Compressed ${res.compressed} objects`);
      return;
    }
    if (args[0] === 'promote' && args[1]) {
      const r = Reasoning.get(args[1]);
      if (!r) return this.out('warn', 'Reasoning object not found');
      LongTerm.upsert({
        id: `ltm-${r.id}`, namespace: 'architecture', key: r.summary.slice(0, 60),
        value_json: JSON.stringify(r), value_markdown: `${r.summary}\n\n${r.detail}`,
        importance: Math.max(0.7, r.importance), confidence: r.confidence, created_at: r.produced_at,
        updated_at: r.produced_at, source_session_id: r.session_id, source_decision_id: r.id, tags: r.tags, permanent: true,
      });
      return this.out('success', `Promoted ${r.id} to long-term memory`);
    }
    if (args[0] === 'expire' && args[1]) {
      const n = LongTerm.markForExpiry(args.slice(1).join(' '));
      return this.out('success', `Marked ${n} memories for expiry`);
    }
    if (args[0] === 'search' && args[1]) {
      const res = LongTerm.search(args.slice(1).join(' '));
      this.out('heading', `Memory: "${args.slice(1).join(' ')}"`);
      for (const m of res) this.out('info', `[${m.namespace}] ${m.key} (importance ${m.importance.toFixed(2)})`);
      if (!res.length) this.out('dim', 'No matches.');
      return;
    }
    this.out('heading', 'Long-term memory');
    const all = LongTerm.all().slice(0, 25);
    if (!all.length) return this.out('dim', 'Empty.');
    for (const m of all) this.out('info', `[${m.namespace}] ${m.key}`);
  }

  private async wiki(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === 'bootstrap') {
      const r = await bootstrapWiki(process.cwd(), this.sm.manager, this.sm.cfg, this.sm.getCurrent()?.id ?? 'manual');
      this.out('success', `Wiki bootstrapped: ${r.modules} modules, ${r.docsImported} docs, overview ${r.architectureWritten ? 'written' : 'skipped'}`);
      return;
    }
    if (sub === 'update' && args[1]) {
      const key = args[1];
      const existing = Wiki.get(key);
      if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY)
        return this.out('warn', 'LLM-assisted wiki update needs a provider API key.');
      const s = this.sm.getCurrent();
      const { callLlm } = await import('../workers/llm.js');
      const { text } = await callLlm(this.sm.manager, this.sm.cfg, {
        system: 'Update or write a concise project wiki entry in markdown. Output only the markdown body.',
        user: `Wiki key: ${key}\n\nExisting content:\n${existing?.content_markdown ?? '(none)'}\n\nProduce an improved, current version.`,
        sessionId: s?.id ?? 'manual',
        maxTokens: 1200,
      });
      applyWikiUpdate({ key, content: text.trim(), is_diff: false }, s?.id, this.sm.cfg.wiki.conflict_strategy);
      return this.out('success', `Wiki entry ${key} updated`);
    }
    if (sub === 'show' && args[1]) {
      const e = Wiki.get(args[1]);
      if (!e) return this.out('warn', 'Not found');
      this.out('heading', e.front_matter.title);
      for (const line of e.content_markdown.split('\n')) this.out('info', line);
      return;
    }
    if (sub === 'search' && args[1]) {
      const res = Wiki.search(args.slice(1).join(' '));
      this.out('heading', `Wiki: "${args.slice(1).join(' ')}"`);
      for (const e of res) this.out('info', `${e.wiki_key} — ${e.front_matter.title}`);
      if (!res.length) this.out('dim', 'No matches.');
      return;
    }
    this.out('heading', 'Wiki');
    const all = Wiki.list();
    if (!all.length) return this.out('dim', 'Empty — populated as sessions run.');
    for (const e of all) this.out('info', `${e.wiki_key} (${e.front_matter.status})`);
  }

  private reasoning(args: string[]): void {
    if (args[0] === 'search' && args[1]) {
      const res = Reasoning.search(args.slice(1).join(' '));
      this.out('heading', `Reasoning: "${args.slice(1).join(' ')}"`);
      for (const r of res) this.out('info', `[${r.type}] ${r.summary} (${r.confidence.toFixed(2)})`);
      if (!res.length) this.out('dim', 'No matches.');
      return;
    }
    const s = this.sm.getCurrent();
    if (!s) return this.out('warn', 'No active session (or use /reasoning search <q>)');
    this.out('heading', 'Reasoning (this session)');
    const all = Reasoning.forSession(s.id);
    if (!all.length) return this.out('dim', 'None yet.');
    for (const r of all) this.out('info', `[${r.type}] ${r.summary} (${r.confidence.toFixed(2)})`);
  }

  private forget(arg: string): void {
    if (!arg) return this.out('warn', 'Usage: /forget <query>');
    const n = LongTerm.markForExpiry(arg);
    this.out('success', `Marked ${n} memories for expiry next compression cycle`);
  }

  // ── Repository ────────────────────────────────────────────
  private async reindex(): Promise<void> {
    this.out('heading', 'Reindex');
    const api = staticAnalysis(process.cwd());
    const stats = await api.reindex({ embed: true });
    this.out('success', `Indexed ${stats.files} files, ${stats.symbols} symbols`);
    this.out('dim', `Languages: ${Object.entries(stats.languages).map(([l, c]) => `${l}:${c}`).join(', ')}`);
    if (api.embeddingsReady()) this.out('dim', 'Embedding index built.');
    const cycles = api.getCycles();
    if (cycles.length) this.out('warn', `${cycles.length} dependency cycle(s) detected (see /graph cycles)`);
  }

  private async rebuildMap(): Promise<void> {
    const api = staticAnalysis(process.cwd());
    if (!api.stats()) await api.reindex();
    this.out('heading', 'Repository map');
    for (const line of api.renderRepositoryMap(20).split('\n')) this.out('info', line);
  }

  private graph(arg: string): void {
    const api = staticAnalysis(process.cwd());
    if (!api.stats()) return this.out('warn', 'Repo not indexed. Run /reindex first.');
    if (arg === 'cycles') {
      this.out('heading', 'Dependency cycles');
      const cycles = api.getCycles();
      if (!cycles.length) return this.out('dim', 'None.');
      cycles.forEach((c, i) => this.out('info', `${i + 1}. ${c.files.join(' → ')}`));
      return;
    }
    if (arg === 'deadcode') {
      this.out('heading', 'Dead-code candidates');
      const dead = api.getDeadCode().slice(0, 30);
      if (!dead.length) return this.out('dim', 'None.');
      for (const d of dead) this.out('info', `${d.name}  ${d.file}:${d.line}`);
      return;
    }
    if (arg === 'rkg') {
      const s = api.rkg().stats();
      this.out('heading', 'Repository knowledge graph');
      this.out('info', `Nodes: ${s.nodes}  Edges: ${s.edges}`);
      this.out('info', `By type: ${Object.entries(s.byType).map(([t, c]) => `${t}:${c}`).join(', ')}`);
      return;
    }
    if (arg === 'untested') {
      const untested = api.rkg().filesWithoutTests().slice(0, 30);
      this.out('heading', 'Files without tests');
      if (!untested.length) return this.out('dim', 'None.');
      for (const n of untested) this.out('info', `${n.ref}${n.architectural_role ? `  (${n.architectural_role})` : ''}`);
      return;
    }
    if (!arg) return this.out('warn', 'Usage: /graph <file> | cycles | deadcode | rkg | untested');
    this.out('heading', `Graph: ${arg}`);
    this.out('info', `Imports (${api.getDependencies(arg).length}): ${api.getDependencies(arg).join(', ') || '—'}`);
    this.out('info', `Imported by (${api.getDependents(arg).length}): ${api.getDependents(arg).join(', ') || '—'}`);
  }

  // ── Checkpoint ────────────────────────────────────────────
  private async checkpoint(): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    await this.sm.checkpoint(s);
    this.out('success', 'Checkpoint created');
  }

  private async checkpoints(args: string[]): Promise<void> {
    if (args[0] === 'diff' && args[1]) return this.checkpointDiff(args[1]);
    if (args[0] === 'restore' && args[1]) {
      const s = restoreCheckpoint(args[1]);
      if (!s) return this.out('warn', 'Checkpoint not found');
      this.sm.setCurrent(s);
      this.out('success', `Restored checkpoint ${args[1]} → session ${s.id}`);
      return;
    }
    const s = this.requireSession();
    if (!s) return;
    this.out('heading', 'Checkpoints');
    const cps = Checkpoints.forSession(s.id);
    if (!cps.length) return this.out('dim', 'None.');
    for (const c of cps) this.out('info', `${c.id}  ${c.trigger}  ${c.created_at}`);
  }

  // ── Diagnostic ────────────────────────────────────────────
  private tokens(arg: string): void {
    const s = this.requireSession();
    if (!s) return;
    if (arg === 'by-provider') {
      this.out('heading', 'Tokens by provider');
      for (const [p, t] of Object.entries(Tokens.byProvider(s.id))) this.out('info', `${p}: ${fmtTokens(t)}`);
      return;
    }
    const tot = Tokens.sessionTotal(s.id);
    this.out('heading', 'Token usage');
    this.out('info', `Input: ${fmtTokens(tot.input)}  Output: ${fmtTokens(tot.output)}  Total: ${fmtTokens(tot.total)}`);
    this.out('info', `Cost: $${tot.cost.toFixed(4)}`);
  }

  private async context(): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    const tasks = Tasks.forSession(s.id);
    const t = tasks.find((x) => x.status === 'pending' || x.status === 'in_progress') ?? tasks[0];
    if (!t) return this.out('warn', 'No task to compile context for. Use /plan first.');
    this.out('heading', `Compiled Context — ${t.title}`);
    const compiled = await compileContext(s, t, {
      maxContextTokens: this.sm.cfg.context.max_context_tokens,
      fileCompressionThreshold: this.sm.cfg.context.file_compression_threshold,
    });
    this.out('info', `Profile components: ${compiled.included.join(', ')}`);
    this.out('info', `Omitted: ${compiled.omitted.join(', ') || 'none'}`);
    this.out('info', `Estimated tokens: ${fmtTokens(compiled.total_tokens)} / ${fmtTokens(compiled.max_tokens)}`);
    for (const c of compiled.components) {
      this.out('dim', `  ${c.heading}: ${fmtTokens(c.estimated_tokens)} tokens`);
    }
  }

  private stats(): void {
    this.out('heading', 'Runtime statistics');
    const g = Tokens.grandTotal();
    const sessions = Sessions.list(1000);
    this.out('info', `Sessions: ${sessions.length}`);
    this.out('info', `Total tokens: ${fmtTokens(g.total)}  Total cost: $${g.cost.toFixed(2)}`);
    const api = staticAnalysis(process.cwd());
    const idx = api.stats();
    if (idx) this.out('info', `Index: ${idx.files} files, ${idx.symbols} symbols`);
    const byType = tokensByTaskType();
    if (byType.length) {
      this.out('heading', 'Tokens by task type');
      for (const t of byType) this.out('info', `${(t.type ?? 'unknown').padEnd(10)} ${t.invocations}x  avg ${fmtTokens(t.avg_tokens)}  total ${fmtTokens(t.total_tokens)}`);
    }
    const eff = providerEfficiency();
    if (eff.length) {
      this.out('heading', 'Provider efficiency');
      for (const e of eff) this.out('info', `${e.provider.padEnd(10)} ${e.invocations}x  total ${fmtTokens(e.total_tokens)}  avg out ${fmtTokens(e.avg_output)}`);
    }
  }

  private profile(arg: string): void {
    const s = this.requireSession();
    if (!s) return;
    const tasks = Tasks.forSession(s.id);
    const t = tasks[Number(arg) - 1] ?? tasks.find((x) => x.id === arg);
    if (!t) return this.out('warn', 'Usage: /profile <task index|id>');
    const p = profileTask(t.id);
    this.out('heading', `Profile: ${t.title}`);
    if (!p) return this.out('dim', 'No token records for this task yet.');
    this.out('info', `Invocations: ${p.invocations}`);
    this.out('info', `Input: ${fmtTokens(p.input_tokens)}  Output: ${fmtTokens(p.output_tokens)}  Total: ${fmtTokens(p.total_tokens)}`);
    this.out('info', `Cost: $${p.cost_usd.toFixed(4)}`);
    this.out('info', `Context components: ${p.components.join(', ') || '—'}`);
  }

  private health(): void {
    this.out('heading', 'Account health');
    for (const a of this.sm.manager.listAccounts()) {
      this.out('info', `${a.alias}: ${a.health.status}  avg latency ${a.health.avg_latency_ms.toFixed(0)}ms`);
    }
  }

  private replay(arg: string): void {
    const s = this.sm.getCurrent();
    const sid = arg || s?.id;
    if (!sid) return this.out('warn', 'Usage: /replay <session_id>');
    this.out('heading', `Reasoning Replay — ${sid}`);
    // Relevance-based replay against the active objective (spec §8.4); falls
    // back to the full session trace when no objective keywords are available.
    const kws = s?.objective_parsed?.keywords ?? [];
    if (kws.length) {
      const rendered = renderReplay(replayReasoning(kws, 20));
      for (const line of rendered.split('\n')) this.out(line.startsWith('##') ? 'heading' : 'info', line);
      return;
    }
    const all = Reasoning.forSession(sid);
    if (!all.length) return this.out('dim', 'No reasoning recorded.');
    for (const r of all) {
      this.out('info', `[${r.type}] ${r.summary}`);
      if (this.verbose) this.out('dim', `   ${r.detail.slice(0, 200)}`);
    }
  }

  private async recover(): Promise<void> {
    this.out('heading', 'Crash recovery');
    const reports = await recoverAll();
    if (!reports.length) return this.out('dim', 'No incomplete sessions found.');
    for (const r of reports) {
      this.out(r.action === 'needs-attention' ? 'warn' : 'info', `${r.session.id}: ${r.detail}`);
    }
    const resumable = reports[0];
    if (resumable) {
      this.sm.setCurrent(resumable.session);
      this.out('success', `Active session set to ${resumable.session.id}`);
    }
  }

  /** The active model, and switching it. `/provider` lists every vendor; this is
   *  the one-word form for the only provider decision most runs need. */
  private model(arg: string): void {
    const s = this.sm.getCurrent();
    if (!arg) {
      const active = s?.current_provider?.model_id ?? this.sm.cfg.providers.default;
      this.out('heading', 'Model');
      for (const m of this.sm.manager.listModels()) {
        const mark = m.id === active ? '→' : ' ';
        this.out(m.id === active ? 'success' : 'info', `${mark} ${m.id.padEnd(28)} ctx ${fmtTokens(m.context_size)}`);
      }
      this.out('dim', 'Switch with /model <model_id>.');
      return;
    }
    if (!this.sm.manager.modelSpec(arg)) return this.out('warn', `Unknown model: ${arg}. Run /model to see what is available.`);
    const providerId = this.sm.manager.providerOf(arg);
    if (s) {
      s.current_provider = { provider_id: providerId, model_id: arg };
      Sessions.update(s);
      this.out('success', `This session now runs on ${arg} (${providerId}).`);
      return;
    }
    // Without a session there is nothing to attach the choice to, so it becomes
    // the default for the next one rather than being silently dropped.
    const cfg = loadConfig();
    cfg.providers.default = arg;
    saveConfig(cfg);
    this.sm.cfg.providers.default = arg;
    this.out('success', `Default model set to ${arg} (${providerId}).`);
  }

  /** Read and change settings without leaving the tool or hand-editing YAML. */
  private config(args: string[]): void {
    const cfg = loadConfig();
    const flat = flatten(cfg as unknown as Record<string, unknown>);
    if (!args.length) {
      this.out('heading', 'Configuration');
      this.out('dim', CONFIG_PATH);
      for (const [k, v] of flat) this.out('info', `${k.padEnd(40)} ${v}`);
      this.out('dim', 'Change one with /config set <key> <value>.');
      return;
    }
    if (args[0] !== 'set' || args.length < 3) return this.usage('/config');
    const key = args[1]!;
    const raw = args.slice(2).join(' ');
    if (!flat.some(([k]) => k === key)) return this.out('warn', `Unknown setting: ${key}. Run /config to see the keys.`);
    const applied = setPath(cfg as unknown as Record<string, unknown>, key, raw);
    if (!applied.ok) return this.out('warn', applied.reason);
    saveConfig(cfg);
    this.out('success', `${key} = ${applied.value}`);
    this.out('dim', 'Settings load per command; running work keeps the value it started with.');
  }

  /** Everything this session has changed on disk, as a diff. */
  private async diff(arg: string): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    const git = new GitWorker(s.repository.path);
    if (!(await git.isRepo())) return this.out('warn', 'Not a git repository, so there is no baseline to diff against.');
    const base = s.repository.commit;
    const text = (base ? await git.diffSince(base) : await git.workingDiff()).trim();
    if (!text) return this.out('info', 'Nothing has changed on disk since this session started.');
    const files = [...text.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
    this.out('heading', `Changes since ${base ? base.slice(0, 8) : 'the last commit'}`);
    if (files.length) this.out('info', `${files.length} file(s): ${files.join(', ')}`);
    const lines = text.split('\n');
    const shown = arg === 'full' ? lines : lines.slice(0, 400);
    for (const l of shown) this.out(l.startsWith('+') ? 'success' : l.startsWith('-') ? 'warn' : 'dim', l);
    if (shown.length < lines.length) this.out('dim', `… ${lines.length - shown.length} more lines. /diff full shows everything.`);
  }

  /** Take back what the last run wrote. Restores the exact prior bytes of the
   *  files it touched, so unrelated edits in the same tree survive. */
  private undo(arg: string): void {
    const repo = this.sm.getCurrent()?.repository.path ?? activeRepoPath();
    if (arg === 'list') {
      const all = Undo.list(repo);
      this.out('heading', 'Undoable changes');
      if (!all.length) return this.out('dim', 'Nothing has been applied to this repository yet.');
      for (const r of all) this.out('info', `${r.created_at.slice(0, 19)}  ${r.entries.length} file(s)  ${r.summary ?? ''}`);
      return;
    }
    const rec = Undo.latest(repo);
    if (!rec) return this.out('warn', 'Nothing to undo — no patch has been applied to this repository.');
    const r = revert(repo, rec);
    Undo.drop(rec.id);
    if (r.restored.length) this.out('success', `Reverted ${r.restored.length} file(s): ${r.restored.join(', ')}`);
    if (r.removed.length) this.out('success', `Removed ${r.removed.length} created file(s): ${r.removed.join(', ')}`);
    for (const f of r.failed) this.out('error', `${f.path}: ${f.reason}`);
    this.out('dim', `Undone: ${rec.summary ?? 'the last applied change'}`);
  }

  /** Why a file is costing context. Answered from the same selector the real
   *  run uses, recompiled locally — no model is asked. */
  private async why(arg: string): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    if (!arg) return this.usage('/why');
    const tasks = Tasks.forSession(s.id);
    const t = tasks.find((x) => x.status === 'pending' || x.status === 'in_progress') ?? tasks[0];
    if (!t) return this.out('warn', 'No task to explain a selection for. Use /plan first.');
    const compiled = await compileContext(s, t, {
      maxContextTokens: this.sm.cfg.context.max_context_tokens,
      fileCompressionThreshold: this.sm.cfg.context.file_compression_threshold,
    });
    const costs = compiled.file_costs ?? [];
    const hit = costs.find((f) => f.path === arg || f.path.endsWith(`/${arg}`));
    if (!hit) {
      this.out('info', `${arg} is not in the context for "${t.title}".`);
      if (costs.length) this.out('dim', `Selected instead: ${costs.map((f) => f.path).join(', ')}`);
      return;
    }
    this.out('heading', `${hit.path} — ${fmtTokens(hit.tokens)} tokens`);
    if (!hit.reasons?.length) return this.out('dim', 'Included as a low-signal neighbour with no single dominant reason.');
    for (const r of hit.reasons) this.out('info', `• ${r}`);
  }

  /** Where tokens went that bought no reasoning, and what was avoided. */
  private waste(): void {
    this.out('heading', 'Token discipline');
    const waste = Tokens.wasteRatio();
    if (!waste) {
      this.out('dim', 'No calls recorded yet, so there is nothing to measure.');
    } else {
      this.out(
        waste.ratio > 0.25 ? 'warn' : 'success',
        `Unreferenced context: ${fmtTokens(waste.wasted)} of ${fmtTokens(waste.input)} input tokens went to files no response mentioned (${(waste.ratio * 100).toFixed(1)}%).`,
      );
      if (waste.ratio > 0.25) this.out('dim', 'Above 25% means the selector is over-including. /learn shows which files keep going unread.');
    }
    const cache = Tokens.cacheReuse();
    if (cache) {
      this.out('info', `Vendor prefix cache: ${fmtTokens(cache.cached)} of ${fmtTokens(cache.input)} input tokens were replayed rather than resent (${(cache.ratio * 100).toFixed(0)}%).`);
    }
    const reuse = PromptCache.saved();
    this.out(
      reuse.hits > 0 ? 'success' : 'dim',
      reuse.hits > 0
        ? `Repeated questions: ${reuse.hits} identical request(s) answered from store, ${fmtTokens(reuse.tokens)} tokens never spent.`
        : 'Repeated questions: none yet — every request so far asked something new.',
    );
    const learned = Learning.report(activeRepoPath()).files.filter((f) => f.rate < 0.25);
    if (learned.length) {
      this.out('info', `Being ranked down: ${learned.length} file(s) included repeatedly and referenced almost never.`);
      for (const f of learned.slice(0, 5)) this.out('dim', `  ${f.path} — read in ${Math.round(f.rate * 100)}% of ${f.included} inclusions`);
    }
  }

  /** What the tree has done since a checkpoint was taken. Reads the snapshot's
   *  recorded commit and diffs against it, so it works after a restart. */
  private async checkpointDiff(checkpointId: string): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    const cp = Checkpoints.forSession(s.id).find((c) => c.id === checkpointId);
    if (!cp) return this.out('warn', `Checkpoint ${checkpointId} is not in this session.`);
    const base = cp.repository_commit;
    if (!base) return this.out('warn', 'That checkpoint recorded no commit, so there is nothing to diff against.');
    const git = new GitWorker(cp.repository_path ?? s.repository.path);
    const text = (await git.diffSince(base)).trim();
    this.out('heading', `Since checkpoint ${checkpointId} (${cp.created_at.slice(0, 19)})`);
    if (!text) return this.out('info', 'The working tree is unchanged since that checkpoint.');
    const lines = text.split('\n');
    for (const l of lines.slice(0, 400)) this.out(l.startsWith('+') ? 'success' : l.startsWith('-') ? 'warn' : 'dim', l);
    if (lines.length > 400) this.out('dim', `… ${lines.length - 400} more lines.`);
  }

  /**
   * One command that answers "is this thing set up correctly?". Every check is
   * a real probe, and every failure names the command or install that fixes it —
   * a diagnostic that only says "missing" makes the user go looking.
   */
  private async doctor(): Promise<void> {
    this.out('heading', 'Doctor');
    const ok = (m: string): void => this.out('success', m);
    const bad = (m: string, fix: string): void => {
      this.out('warn', m);
      this.out('dim', `  → ${fix}`);
    };

    const major = Number(process.versions.node.split('.')[0]);
    const minor = Number(process.versions.node.split('.')[1]);
    if (major > 22 || (major === 22 && minor >= 5)) ok(`Node ${process.versions.node}`);
    else bad(`Node ${process.versions.node} is too old — node:sqlite needs 22.5 or newer.`, 'Install Node 22.5+ and rerun.');

    const repo = this.sm.getCurrent()?.repository.path ?? activeRepoPath();
    this.out('info', `Repository: ${repo}`);
    const git = new GitWorker(repo);
    if (await git.isRepo()) ok(`Git repository on ${await git.branch()} at ${(await git.headCommit()).slice(0, 8)}`);
    else bad('Not a git repository.', 'Checkpoints, /diff and change tracking need one — run git init.');

    const api = staticAnalysis(repo);
    const stats = api.stats();
    if (stats && stats.files > 0) {
      ok(`Index: ${stats.files} file(s), ${stats.symbols} symbol(s), ${Object.keys(stats.languages).join(', ') || 'no languages detected'}`);
      if (!api.embeddingsReady()) this.out('dim', '  Embeddings not built — file selection falls back to symbols and graph signals.');
    } else {
      bad('No repository index.', 'Run /reindex — file selection cannot work without it.');
    }

    if (this.sm.manager.hasAnyProvider()) {
      const accounts = this.sm.manager.listAccounts();
      ok(`Providers: ${accounts.map((a) => `${a.provider_id}/${a.alias} (${a.health.status})`).join(', ')}`);
    } else {
      bad('No provider credentials.', 'Set ANTHROPIC_API_KEY / OPENAI_API_KEY, run `claude setup-token`, or /account add.');
    }
    const clis = [claudeCliAvailable() ? 'claude' : null, codexCliAvailable() ? 'codex' : null].filter(Boolean);
    if (clis.length) ok(`Subscription CLIs available: ${clis.join(', ')} — vendor plans are used before metered keys.`);
    else this.out('dim', 'No vendor CLI on PATH; calls go through metered API keys.');

    const blocked = QuotaLedger.all().filter((st) => QuotaLedger.blockedForMs(st.key, st.provider_id) > 0);
    if (blocked.length) bad(`${blocked.length} provider window(s) are cooling down.`, 'Run /cost to see for how long.');

    for (const [label, bin] of [['ripgrep', 'rg'], ['python', 'python3']] as const) {
      if (which(bin)) ok(`${label} found`);
      else bad(`${label} not on PATH.`, label === 'ripgrep' ? 'Install ripgrep for fast repository search.' : 'Install python3 to verify Python repositories.');
    }
    const servers = ['pyright-langserver', 'typescript-language-server', 'rust-analyzer', 'gopls'].filter(which);
    if (servers.length) ok(`Language servers: ${servers.join(', ')}`);
    else this.out('dim', 'No language server installed — reference lookup falls back to ripgrep, which is less precise.');

    this.out('dim', 'Nothing above needs a model. /waste shows where tokens are going once you start running tasks.');
  }

  private plugins(): void {
    this.out('heading', 'Plugins');
    const plugins = listPlugins();
    if (!plugins.length) this.out('dim', `None. Drop plugins into ~/.codemaster/plugins/<name>/ with a plugin.json.`);
    for (const p of plugins) this.out('info', `${p.name} v${p.version} (${p.type}) — ${p.description}`);
    const cmds = listCommandPlugins();
    if (cmds.length) {
      this.out('heading', 'Plugin commands');
      for (const c of cmds) this.out('info', `${c.command.padEnd(16)} ${c.description}`);
    }
  }

  private workers(): void {
    this.out('heading', 'Workers');
    for (const w of listWorkers()) this.out('info', `${w.name.padEnd(20)} ${w.requires_llm ? 'LLM' : 'deterministic'}`);
    this.out('heading', 'Task pipeline (DAG order)');
    this.out('info', topoOrder().join(' → '));
  }

  /** Per-command help, from the same catalog `/help` reads. */
  private usage(cmd: string): void {
    const def = COMMANDS.find((c) => c.cmd === cmd);
    if (!def) {
      this.out('warn', `Unknown command: ${cmd}`);
      const near = COMMANDS.filter((c) => c.cmd.startsWith(cmd.slice(0, 3))).map((c) => c.cmd);
      this.out('dim', near.length ? `  → Did you mean ${near.join(' or ')}?` : '  → /help lists every command.');
      return;
    }
    this.out('heading', def.cmd);
    this.out('info', def.desc);
    this.out('dim', `Usage: ${def.usage ?? def.cmd}`);
  }

  /** Forty commands listed at once is a wall, not help. Show the groups, and
   *  let the user walk into the one they want. */
  private help(arg?: string): void {
    const groups = [...new Set(COMMANDS.map((c) => c.group))];
    if (arg) {
      const g = groups.find((x) => x.toLowerCase() === arg.toLowerCase());
      if (g) {
        this.out('heading', g);
        for (const c of COMMANDS.filter((x) => x.group === g)) this.out('info', `${c.cmd.padEnd(14)} ${c.desc}`);
        this.out('dim', 'Any command accepts --help for its exact call form.');
        return;
      }
      return this.usage(arg.startsWith('/') ? arg : `/${arg}`);
    }
    this.out('heading', 'Help');
    for (const g of groups) {
      const cmds = COMMANDS.filter((c) => c.group === g);
      this.out('info', `${g.padEnd(12)} ${cmds.length} command(s): ${cmds.slice(0, 5).map((c) => c.cmd).join(' ')}${cmds.length > 5 ? ' …' : ''}`);
    }
    this.out('dim', '/help <group> lists a group · /<command> --help shows one command · /doctor checks the setup.');
  }
}

/** Config as `a.b.c` → value pairs, skipping arrays of objects that have no
 *  useful single-line form. */
function flatten(obj: Record<string, unknown>, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v as Record<string, unknown>, key));
    else if (Array.isArray(v)) out.push([key, `${v.length} entr${v.length === 1 ? 'y' : 'ies'}`]);
    else out.push([key, String(v)]);
  }
  return out;
}

/** Set a dotted key, coercing to the type already stored there. Refuses rather
 *  than writing a string where a number lives — a silently mistyped setting is
 *  worse than a rejected one. */
function setPath(obj: Record<string, unknown>, key: string, raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const parts = key.split('.');
  let cur: Record<string, unknown> = obj;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (!next || typeof next !== 'object') return { ok: false, reason: `${key} is not a settable path.` };
    cur = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1]!;
  const existing = cur[leaf];
  if (Array.isArray(existing) || (existing && typeof existing === 'object')) {
    return { ok: false, reason: `${key} holds structured data; edit ${CONFIG_PATH} directly.` };
  }
  if (typeof existing === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: `${key} takes a number.` };
    cur[leaf] = n;
  } else if (typeof existing === 'boolean') {
    if (!['true', 'false'].includes(raw)) return { ok: false, reason: `${key} takes true or false.` };
    cur[leaf] = raw === 'true';
  } else {
    cur[leaf] = raw;
  }
  return { ok: true, value: String(cur[leaf]) };
}

/** PATH lookup without spawning a shell — the same resolution the adapters get
 *  when they spawn the binary directly, so the report matches reality. */
function which(bin: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/** Turn the failures that actually recur into the command that resolves them.
 *  An error message that stops at "what went wrong" leaves the user to guess. */
function nextStepFor(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes('no such table') || m.includes('no index')) return 'Run /reindex to rebuild this repository\u2019s index.';
  if (m.includes('credential') || m.includes('api key') || m.includes('no provider')) return 'Add credentials with /account add, or set the provider\u2019s API key.';
  if (m.includes('usage limit') || m.includes('rate limit')) return 'Run /cost to see which window is spent, or /model to switch vendors.';
  if (m.includes('not a git repository')) return 'Run git init — checkpoints and /diff need a baseline commit.';
  if (m.includes('enoent') && m.includes('claude')) return 'Install the claude CLI, or set ANTHROPIC_API_KEY to use the metered API.';
  return null;
}
