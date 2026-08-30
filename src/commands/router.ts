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
import { LLM_ROLES } from '../types/index.js';
import { anyProviderAvailable } from '../providers/manager.js';
import fs from 'fs';
import path from 'path';
import { compileContext } from '../context/compiler.js';
import { createCheckpoint, restoreCheckpoint, verifyCheckpointState } from '../workers/checkpointer.js';
import { compileHandoffPackage, validateHandoffPackage, renderHandoffPackage } from '../workers/handoff.js';
import { QuotaLedger, resetsAt } from '../providers/quotaLedger.js';
import { Learning } from '../learning/reflector.js';
import { MemoryCompressorWorker } from '../workers/memoryCompressor.js';
import { runWorker } from '../workers/base.js';
import { applyDecay, findCompressionCandidates } from '../memory/lifecycle.js';
import { recoverAll } from '../daemon/recovery.js';
import { tokensByTaskType, providerEfficiency, profileTask, savingsReport } from '../analysis/tokenAnalytics.js';
import { listPlugins, listCommandPlugins, getCommandPlugin, PLUGINS_DIR } from '../plugins/loader.js';
import { answerQuestion, looksLikeQuestion } from '../workers/asker.js';
import { bootstrapWiki } from '../wiki/bootstrap.js';
import { applyWikiUpdate } from '../wiki/updater.js';
import { bus } from '../events/bus.js';
import { fmtAgo, fmtCost, fmtDuration, fmtTokens } from '../util/tokens.js';
import { COMMANDS } from './catalog.js';
import { beginCancellable, Cancelled, endCancellable } from '../util/cancel.js';
import { activeRepoPath, listProjects, loadConfig, saveConfig, CONFIG_PATH } from '../config.js';
import { select, confirm, form, interactive } from '../ui/prompt.js';
import { withTerminal } from '../ui/terminal.js';
import {
  DEFAULT_ACCOUNT,
  MAX_ACCOUNTS_PER_VENDOR,
  accountEnv,
  addCliAccount,
  allCliStates,
  cliAccounts,
  cliState,
  invalidateCliState,
  removeCliAccount,
  runOnTerminal,
  type CliState,
} from '../providers/cliAuth.js';
import { listWorkers, topoOrder, registerCoreWorkers } from '../workers/scheduler.js';
import type { Session, LlmRole } from '../types/index.js';
import type { Config } from '../config.js';

registerCoreWorkers();

type Out = (level: 'info' | 'warn' | 'error' | 'success' | 'heading' | 'sep' | 'dim' | 'md', msg: string) => void;

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
      // A question is the most common thing typed at a coding tool, and it used
      // to buy a session row, a task list and a planning call. Auto-detection is
      // narrow and always announced, so a misroute costs one cheap call and is
      // visible, never silent.
      if (looksLikeQuestion(text)) {
        this.out('dim', 'Answering read-only — no session started. /new <objective> forces one.');
        await this.ask(text);
        return;
      }
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
      case '/ask': return this.ask(arg);
      case '/resume': return this.resume(arg);
      case '/pause': return this.pause();
      case '/complete': return this.complete();
      case '/session': return this.session(args);
      case '/plan': { await this.plan(); return; }
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
      case '/setup': return this.setup();
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

  /** Reads the repository and answers. Persists nothing — the point is that a
   *  question costs one call and leaves no state to clean up afterwards. */
  private async ask(text: string): Promise<void> {
    if (!text) return this.out('warn', 'Usage: /ask <question about this repository>');
    if (!this.sm.manager.hasAnyProvider()) return this.out('warn', 'No provider credentials. Run /doctor.');
    const live = this.sm.getCurrent();
    const repo = live?.repository.path ?? activeRepoPath();
    const { text: answer, tokens } = await answerQuestion(text, repo, this.sm.manager, this.sm.cfg, live);
    this.out('heading', 'Answer');
    for (const line of answer.split('\n')) this.out('md', line);
    this.out(
      'dim',
      tokens === 0
        ? 'Answered from the index · no model call. /new <objective> to act on this.'
        : `${fmtTokens(tokens)} tokens · nothing was written. /new <objective> to act on this.`,
    );
  }

  // ── Session ───────────────────────────────────────────────
  /** `explicit` distinguishes `/new <objective>` from bare prose typed at the
   *  prompt. Both start a session, but only one of them was asked for by name,
   *  and a user who meant to ask a question deserves to be told that their
   *  sentence just became a session objective. */
  /** An objective plans AND runs. Stopping after the plan meant every request
   *  took two commands and left a planned-but-untouched session behind if the
   *  second was never typed. `/plan` still plans without executing. */
  private async objective(text: string, explicit = false): Promise<void> {
    if (!text) {
      this.out('warn', 'Usage: /new <objective>');
      return;
    }
    this.out('heading', explicit ? 'New session' : 'New session (from your message)');
    const session = await this.sm.createSession(text, process.cwd());
    this.out('dim', `${session.id} · ${session.objective_parsed?.task_type} · ${session.objective}`);
    if (!(await this.plan(true))) return;
    await this.run(true);
  }

  private async resume(arg: string): Promise<void> {
    // Resuming without an id takes the most recent active session, which is
    // right when there is one and a guess when there are several. Offer the
    // list instead of guessing, newest first.
    let target = arg;
    if (!target && interactive()) {
      const recent = Sessions.list(9, activeRepoPath()).filter((x) => x.status !== 'completed');
      if (recent.length > 1) {
        const pick = await select('Resume which session?', recent.map((x) => ({
          value: x.id,
          label: x.objective.slice(0, 60),
          hint: `${x.status} · ${x.progress.completed}/${x.progress.total} · ${x.updated_at.slice(0, 16).replace('T', ' ')}`,
        })));
        if (!pick) return;
        target = pick;
      }
    }
    const s = this.sm.resume(target || undefined);
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
  /** One ending, not a scatter of lines. What was produced, what proved it,
   *  what it cost, and how to take it back — the four things worth reading. */
  private summarise(s: Session): void {
    const tasks = Tasks.forSession(s.id);
    const done = tasks.filter((t) => t.status === 'completed');
    const failed = tasks.filter((t) => t.status === 'failed');
    const blocked = tasks.filter((t) => t.status === 'blocked');
    const verified = tasks.filter((t) => t.evidence?.verified);
    const files = [...new Set(tasks.flatMap((t) => t.output_files.map((f) => f.path)))];
    const tok = Tokens.sessionTotal(s.id);
    const secs = Math.max(0, Math.round((Date.now() - new Date(s.created_at).getTime()) / 1000));
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;

    const state = failed.length || blocked.length
      ? `${failed.length} failed, ${blocked.length} blocked`
      : verified.length === tasks.length
        ? 'verified'
        : 'applied, unverified';
    this.out('heading', `Done · ${done.length}/${tasks.length} · ${state}`);
    if (files.length) this.out('dim', `Files    ${files.join(', ')}`);
    // Why nothing proved it — the question a person actually asks next.
    const why = tasks.find((t) => !t.evidence?.verified)?.evidence?.reason ?? failed[0]?.failure_reason;
    if (why && verified.length < tasks.length) this.out('dim', `Why      ${why.split('\n')[0]!.slice(0, 150)}`);
    this.out('dim', `Cost     ${tok.total.toLocaleString()} tokens · $${tok.cost.toFixed(4)} · ${elapsed}`);
    if (files.length) this.out('dim', `Undo     /undo`);
  }

  /** True when a plan exists afterwards. `auto` suppresses the "now run it"
   *  hint, because the caller is about to. */
  private async plan(auto = false): Promise<boolean> {
    const s = this.requireSession();
    if (!s) return false;
    this.out('heading', 'Planning');
    if (!this.sm.manager.hasAnyProvider()) {
      this.out('warn', 'No provider credentials — planning needs an LLM. Session created; set an API key, run `claude setup-token`, or /account add, then run /plan.');
      return false;
    }
    const tasks = await this.sm.plan(s);
    this.out('success', `${tasks.length} task${tasks.length === 1 ? '' : 's'} planned`);
    this.tasks();
    if (!auto) this.out('dim', 'Run /run to execute the next task, or /runall for all.');
    return tasks.length > 0;
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

  private async taskDetail(arg: string): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    const tasks = Tasks.forSession(s.id);
    if (!arg) arg = (await this.pickTask('Which task?', tasks)) ?? '';
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
        this.summarise(s);
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

  private async skip(arg: string): Promise<void> {
    const s = this.requireSession();
    if (!s) return;
    const tasks = Tasks.forSession(s.id);
    if (!arg) arg = (await this.pickTask('Skip which task?', tasks.filter((x) => x.status === 'pending'))) ?? '';
    const t = tasks[Number(arg) - 1] ?? tasks.find((x) => x.id === arg);
    if (!t) return this.out('warn', 'Task not found');
    t.status = 'skipped';
    Tasks.update(t);
    this.out('success', `Skipped: ${t.title}`);
  }

  private pickTask(title: string, tasks: Array<{ id: string; title: string; status: string; type: string }>): Promise<string | null> {
    return select(title, tasks.map((t) => ({ value: t.id, label: t.title, hint: `${t.type} · ${t.status}` })));
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

  /**
   * Several vendors' keys held at once, and a way to say which one answers.
   * The key goes on the command line — the TUI drops this one line from history
   * and masks its echo, so the secret does not survive the call.
   */
  private async account(args: string[] = []): Promise<void> {
    if (args[0] === 'login') return this.cliLogin(args[1], args[2]);
    if (args[0] === 'logout') return this.cliLogout(args[1], args[2]);
    if (args[0] === 'add') {
      if (args[1] && args[2]) return this.addAccount(args[1], args[2], args[3] ?? process.env.CODEMASTER_NEW_KEY);
      // Three positional arguments in the right order, one of them a secret, is
      // the worst thing to ask anyone to type. Asked field by field instead,
      // with the vendor picked from a list and the key never echoed.
      const answers = await form('Add an account', [
        { name: 'provider', label: 'Vendor', choices: this.sm.manager.listProviders().map((id) => ({ value: id, label: id })) },
        { name: 'alias', label: 'Name it (yours, for /account use)', placeholder: 'work' },
        { name: 'key', label: 'API key', secret: true, placeholder: 'never echoed, never in history' },
      ]);
      if (!answers) return this.out('warn', 'Usage: /account add <provider> <alias> <key>  (or set CODEMASTER_NEW_KEY)');
      return this.addAccount(answers.provider!, answers.alias!, answers.key);
    }
    if (args[0] === 'new') return this.newCliAccount(args[1], args[2]);
    if (args[0] === 'drop') return this.dropCliAccount(args[1], args[2]);
    if (args[0] === 'use') {
      const alias = args[1] ?? (await this.pickAccount('Which account answers first?'));
      if (!alias) return this.out('warn', 'Usage: /account use <alias>');
      const chose = this.sm.manager.useAccount(alias);
      if (!chose) return this.out('warn', `No account named ${alias}. Run /account to list them.`);
      return this.out('success', `${alias} now answers first — calls route to ${this.sm.manager.modelFor('solve')}.`);
    }
    if (args[0] === 'remove') {
      const alias = args[1] ?? (await this.pickAccount('Remove which account?'));
      if (!alias) return this.out('warn', 'Usage: /account remove <alias>');
      const removed = this.sm.manager.removeAccount(alias);
      return this.out(removed ? 'success' : 'warn', `Account ${alias} ${removed ? 'removed' : 'not found'}`);
    }
    this.out('heading', 'Sign-ins');
    let vendor = '';
    for (const c of allCliStates()) {
      if (c.vendor.label !== vendor) {
        vendor = c.vendor.label;
        const n = cliAccounts(c.vendor.provider_id).length;
        this.out('info', `${c.vendor.label} (${c.vendor.binary})  ${n}/${MAX_ACCOUNTS_PER_VENDOR} account${n === 1 ? '' : 's'}`);
      }
      const line = !c.installed
        ? `not installed — ${c.vendor.install}`
        : c.signedIn
          ? `signed in${c.identity ? ` · ${c.identity}` : ''}`
          : `signed out — /account login ${c.vendor.binary} ${c.account}`;
      this.out(c.signedIn ? 'info' : 'dim', `  ${c.signedIn ? '✓' : ' '} ${c.account.padEnd(12)} ${line}`);
    }

    this.out('heading', 'Accounts');
    const active = this.sm.manager.activeAccount();
    for (const a of this.sm.manager.listAccounts()) {
      // Presence is not usability: the constructor makes an env-backed account
      // for every vendor whether or not that variable is ever set.
      const usable = this.sm.manager.accountResolves(a);
      this.out(
        usable ? 'info' : 'dim',
        `${a.alias === active ? '●' : ' '} ${a.alias.padEnd(20)} ${this.sm.manager.credentialSource(a)}`,
      );
      // Spend belongs under the account it was spent on, not summed into one
      // run total: with several accounts per vendor, which one is close to its
      // limit is the only question this screen has to answer.
      const q = a.quota;
      const win = [
        `${fmtTokens(q.tokens_used)} tok`,
        `${q.requests} call${q.requests === 1 ? '' : 's'}`,
        fmtCost(q.cost_usd),
        `resets in ${fmtDuration(Date.parse(q.resets_at) - Date.now())}`,
      ].join(' · ');
      this.out('dim', `    window   ${win}`);
      this.out('dim', `    total    ${fmtTokens(q.lifetime_tokens)} tok · ${fmtCost(q.lifetime_cost_usd)} · last used ${fmtAgo(a.last_used_at)}`);
      if (q.rate_limited_until && Date.parse(q.rate_limited_until) > Date.now()) {
        this.out('warn', `    limited  ${a.provider_id} says wait ${fmtDuration(Date.parse(q.rate_limited_until) - Date.now())}`);
      }
    }
    this.out('dim', '/account login <cli> [account] · /account new <cli> <name> · /account drop <cli> <name>');
    this.out('dim', '/account add <provider> <alias> <key> · /account use <alias> · /account remove <alias>');

    const action = await select('Accounts', [
      { value: 'login', label: 'Sign in with a CLI', hint: 'Claude Code, Codex, Gemini or opencode — no key to paste' },
      { value: 'new', label: 'Add another account for one vendor', hint: `up to ${MAX_ACCOUNTS_PER_VENDOR} each, signed in separately` },
      { value: 'add', label: 'Paste an API key', hint: 'kept in the system keychain' },
      { value: 'use', label: 'Choose which answers first' },
      { value: 'logout', label: 'Sign out of a CLI' },
      { value: 'drop', label: 'Delete a named CLI account' },
      { value: 'remove', label: 'Remove a stored key' },
    ]);
    if (action) return this.account([action]);
  }

  /**
   * Sign in by running the vendor's own login, with the terminal handed to it.
   *
   * Nothing is stored on this path: the CLI keeps the token wherever it keeps
   * it, so CodeMaster never holds the secret and never has to protect it. That
   * is the whole reason to prefer it over pasting a key.
   */
  private async cliLogin(which?: string, account?: string): Promise<void> {
    const state = await this.pickCli(which, account, 'Sign in with which CLI?', (c) => !c.signedIn);
    if (!state) return;
    const { vendor } = state;
    if (!state.installed) {
      this.out('warn', `${vendor.label} is not installed.`);
      return this.out('dim', `Install it with: ${vendor.install}`);
    }
    if (state.signedIn && !(await confirm(`${vendor.label} · ${state.account} is already signed in${state.identity ? ` as ${state.identity}` : ''}. Sign in again?`))) return;

    // The account's own credential directory, so this sign-in cannot overwrite
    // another one. `default` sets nothing and uses whatever the CLI already has.
    const env = accountEnv(vendor.provider_id, state.account);
    if (!vendor.login.length) {
      this.out('info', `${vendor.label} has no sign-in command — it signs in from its own interface.`);
    }
    this.out('info', `Handing the terminal to ${vendor.binary} — follow its prompts; CodeMaster comes back when it finishes.`);
    const result = await withTerminal(() => runOnTerminal(vendor.binary, vendor.login, env));
    invalidateCliState(vendor.provider_id);
    const after = cliState(vendor.provider_id, state.account)!;

    if (!after.signedIn) {
      return this.out('warn', `Not signed in${result.reason ? ` — ${vendor.binary} ${result.reason}` : ''}. Nothing was stored.`);
    }
    this.out('success', `Signed in to ${vendor.label} · ${state.account}${after.identity ? ` as ${after.identity}` : ''}.`);
    this.out('dim', 'The CLI holds the token — CodeMaster stored no credential.');
    const acct = this.sm.manager.accountForProvider(vendor.provider_id);
    if (acct) this.out('dim', `/account use ${acct.alias} makes ${vendor.label} the one that answers.`);
  }

  /** A named account is an empty credential directory until its CLI signs in
   *  there, so creating one and signing in are offered as a single step. */
  private async newCliAccount(which?: string, name?: string): Promise<void> {
    const state = await this.pickCli(which, DEFAULT_ACCOUNT, 'Another account for which CLI?', () => true);
    if (!state) return;
    const { provider_id, label } = state.vendor;
    const chosen = name ?? (await form(`New ${label} account`, [
      { name: 'name', label: 'Name it (yours)', placeholder: 'work' },
    ]))?.name;
    if (!chosen) return this.out('warn', `Usage: /account new ${state.vendor.binary} <name>`);

    const made = addCliAccount(provider_id, chosen);
    if (!made.ok) return this.out('warn', made.reason ?? 'could not create it');
    this.out('success', `${label} · ${chosen} created — no credentials in it yet.`);
    if (await confirm(`Sign in to ${label} as ${chosen} now?`)) return this.cliLogin(provider_id, chosen);
    this.out('dim', `Sign in later with /account login ${state.vendor.binary} ${chosen}.`);
  }

  private async dropCliAccount(which?: string, name?: string): Promise<void> {
    const state = await this.pickCli(which, name, 'Delete an account of which CLI?', (c) => c.account !== DEFAULT_ACCOUNT);
    if (!state) return;
    const account = state.account;
    if (account === DEFAULT_ACCOUNT) {
      return this.out('warn', 'default is the machine-wide sign-in — sign out of it with /account logout instead.');
    }
    if (!(await confirm(`Delete ${state.vendor.label} · ${account}?`, { detail: 'Its stored credentials are deleted with it.' }))) return;
    const gone = removeCliAccount(state.vendor.provider_id, account);
    invalidateCliState(state.vendor.provider_id);
    this.out(gone ? 'success' : 'warn', gone ? `${state.vendor.label} · ${account} deleted.` : `No account named ${account}.`);
  }

  private async cliLogout(which?: string, account?: string): Promise<void> {
    const state = await this.pickCli(which, account, 'Sign out of which CLI?', (c) => c.signedIn);
    if (!state) return;
    const { vendor } = state;
    if (!vendor.logout) return this.out('warn', `${vendor.label} has no sign-out command — clear its credentials with the CLI itself.`);
    if (!state.signedIn) return this.out('dim', `${vendor.label} · ${state.account} is not signed in.`);
    const shared = state.account === DEFAULT_ACCOUNT ? 'Other tools using this CLI lose the session too.' : 'Only this account signs out.';
    if (!(await confirm(`Sign out of ${vendor.label} · ${state.account}?`, { detail: shared }))) return;
    const result = await withTerminal(() => runOnTerminal(vendor.binary, vendor.logout!, accountEnv(vendor.provider_id, state.account)));
    invalidateCliState(vendor.provider_id);
    this.out(result.ok ? 'success' : 'warn', result.ok ? `Signed out of ${vendor.label}.` : `${vendor.binary} ${result.reason}`);
  }

  /** Name it on the command line, or pick from a list that says what each one is
   *  doing right now. `prefer` puts the ones the action applies to at the top. */
  private async pickCli(
    which: string | undefined,
    account: string | undefined,
    title: string,
    prefer: (c: CliState) => boolean,
  ): Promise<CliState | null> {
    const all = allCliStates();
    const names = [...new Set(all.map((c) => c.vendor.binary))];
    if (which) {
      const key = which.toLowerCase();
      const vendorStates = all.filter((c) => c.vendor.binary === key || c.vendor.provider_id === key || c.vendor.label.toLowerCase() === key);
      if (!vendorStates.length) {
        this.out('warn', `Unknown CLI ${which}. Known: ${names.join(', ')}`);
        return null;
      }
      const hit = vendorStates.find((c) => c.account === (account ?? DEFAULT_ACCOUNT));
      if (hit) return hit;
      this.out('warn', `${vendorStates[0]!.vendor.label} has no account named ${account}. Known: ${vendorStates.map((c) => c.account).join(', ')}`);
      return null;
    }
    // One row per account, not per vendor: with several signed in, a vendor
    // name alone no longer says which credentials the command should use.
    const ordered = [...all].sort((a, b) => Number(prefer(b)) - Number(prefer(a)));
    const chosen = await select(title, ordered.map((c) => ({
      value: `${c.vendor.provider_id}#${c.account}`,
      label: c.account === DEFAULT_ACCOUNT ? c.vendor.label : `${c.vendor.label} · ${c.account}`,
      hint: !c.installed ? 'not installed' : c.signedIn ? `signed in${c.identity ? ` · ${c.identity}` : ''}` : 'signed out',
    })));
    if (!chosen) {
      this.out('warn', `Usage: /account login <${names.join('|')}> [account]`);
      return null;
    }
    const [pid, acct] = chosen.split('#');
    return all.find((c) => c.vendor.provider_id === pid && c.account === acct) ?? null;
  }

  private addAccount(provider: string, alias: string, key: string | undefined): void {
    if (!key) return this.out('warn', 'No key given. /account add <provider> <alias> <key>, or set CODEMASTER_NEW_KEY.');
    const acct = this.sm.manager.addAccount(provider, alias, key);
    if (!acct) return this.out('error', `Unknown provider ${provider}. Known: ${this.sm.manager.listProviders().join(', ')}`);
    this.out('success', `Added account ${alias} (${provider})`);
    this.out('dim', `Routing can now reach ${provider}. /account use ${alias} makes it the one that answers.`);
  }

  private async pickAccount(title: string): Promise<string | null> {
    const active = this.sm.manager.activeAccount();
    return select(
      title,
      this.sm.manager.listAccounts().map((a) => ({
        value: a.alias,
        label: `${a.alias === active ? '● ' : '  '}${a.alias}`,
        hint: `${a.provider_id}${this.sm.manager.accountResolves(a) ? '' : ' — no credential'}`,
      })),
    );
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
    // What the money bought, not just which vendor took it. Grouped by role AND
    // model because failover can rescue a call onto another vendor, and folding
    // that spend into the routed model misattributes it.
    const s = this.sm.getCurrent();
    const roles = Tokens.byRole(s?.id);
    if (roles.length) {
      this.out('heading', s ? 'Spend by role (this session)' : 'Spend by role (all sessions)');
      for (const r of roles) {
        this.out('info', `${r.role.padEnd(10)} ${r.model_id.padEnd(28)} ${String(r.calls).padStart(4)} call(s)  ${fmtTokens(r.tokens).padStart(8)}  $${r.cost.toFixed(4)}`);
      }
    }
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
      const avg = st.lifetime_requests ? Math.round(st.latency_ms_total / st.lifetime_requests) : 0;
      this.out(blockedMs > 0 ? 'warn' : 'info', st.key);
      this.out('dim', `    window   ${fmtTokens(st.tokens_used)} tok · ${st.requests} call(s) · ${fmtCost(st.cost_usd)} · resets in ${fmtDuration(Date.parse(resetsAt(st)) - Date.now())}`);
      // in/out/cache split: the same total costs very different money
      // depending on which side of the call it landed on.
      const split = [
        `in ${fmtTokens(st.input_tokens)}`,
        `out ${fmtTokens(st.output_tokens)}`,
        st.reasoning_tokens ? `thinking ${fmtTokens(st.reasoning_tokens)}` : null,
        st.cache_read_tokens ? `cache-read ${fmtTokens(st.cache_read_tokens)}` : null,
        st.cache_write_tokens ? `cache-write ${fmtTokens(st.cache_write_tokens)}` : null,
      ].filter(Boolean).join(' · ');
      this.out('dim', `    split    ${split}`);
      this.out('dim', `    total    ${fmtTokens(st.lifetime_tokens)} tok · ${st.lifetime_requests} call(s) · ${fmtCost(st.lifetime_cost_usd)} · ${avg}ms avg · last ${fmtAgo(st.last_used_at)}`);
      if (blockedMs > 0) this.out('warn', `    blocked  ${fmtDuration(blockedMs)} left${st.last_error ? ` — ${st.last_error.slice(0, 80)}` : ''}`);
      if (st.consecutive_failures > 0) this.out('warn', `    failures ${st.consecutive_failures} in a row`);
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
      if (!anyProviderAvailable()) return this.out('warn', `${cands.length} eligible, but no provider for summarization.`);
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
      if (!anyProviderAvailable()) return this.out('warn', 'LLM-assisted wiki update needs a provider.');
      const s = this.sm.getCurrent();
      const { callLlm } = await import('../workers/llm.js');
      const { text } = await callLlm(this.sm.manager, this.sm.cfg, {
        role: 'summarize',
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
  /**
   * Everything a fresh install needs, asked in order, with nothing to type that
   * can be picked from a list.
   *
   * The three things that used to have to be discovered separately — a
   * credential, which model answers, and an index for this repository — are one
   * pass here, and each step can be skipped.
   */
  private async setup(): Promise<void> {
    this.out('heading', 'Setup');
    if (!interactive()) return this.out('dim', 'Run /setup from the interface — it asks questions. From a script: /account add, /model, /reindex.');

    // 1. A credential, if none of them resolve.
    if (this.sm.manager.hasAnyProvider()) {
      const active = this.sm.manager.activeAccount();
      this.out('success', `Credentials found${active ? ` — ${active} answers first` : ''}.`);
      const signedIn = allCliStates().filter((c) => c.signedIn).length;
      if (signedIn) this.out('dim', `${signedIn} CLI account${signedIn === 1 ? '' : 's'} signed in · /account new <cli> <name> adds another, up to ${MAX_ACCOUNTS_PER_VENDOR} per vendor.`);
    } else {
      // Sending someone to another shell and asking them to come back was the
      // whole problem: the vendor's login runs here, on this terminal.
      const how = await select('No provider credentials yet. How do you want to sign in?', [
        ...allCliStates()
          .filter((c) => c.installed && !c.signedIn)
          .map((c) => ({ value: `cli:${c.vendor.provider_id}#${c.account}`, label: `Sign in with ${c.vendor.label}`, hint: `runs \`${c.vendor.binary}\` here — no key to paste` })),
        { value: 'key', label: 'Paste an API key', hint: 'stored in the system keychain' },
        ...allCliStates()
          .filter((c) => !c.installed)
          .map((c) => ({ value: `install:${c.vendor.provider_id}`, label: `${c.vendor.label} — not installed`, hint: c.vendor.install })),
        { value: 'skip', label: 'Skip for now', hint: 'deterministic commands still work' },
      ]);
      if (how?.startsWith('cli:')) {
        const [pid, acct] = how.slice(4).split('#');
        await this.cliLogin(pid, acct);
      }
      if (how?.startsWith('install:')) {
        const v = allCliStates().find((c) => c.vendor.provider_id === how.slice(8))!.vendor;
        this.out('info', `Install it with: ${v.install}`);
        this.out('dim', 'Then run /setup again, or /account login.');
      }
      if (how === 'key') await this.account(['add']);
    }

    // 2. Which model answers by default.
    const models = this.sm.manager.listModels();
    const current = this.sm.cfg.providers.default;
    const pick = await select(`Default model (now: ${current})`, models.map((m) => ({
      value: m.id,
      label: `${m.id === current ? '● ' : '  '}${m.id}`,
      hint: `ctx ${fmtTokens(m.context_size)} · $${m.cost_per_1m_input}/1M in`,
    })));
    if (pick && pick !== current) await this.model(pick);

    // 3. The index, which every retrieval reads and nothing builds on its own.
    const api = staticAnalysis(activeRepoPath());
    if (api.stats()) {
      this.out('dim', 'This repository is already indexed.');
    } else if (await confirm('Index this repository now?', { detail: 'Reads the tree once so retrieval has symbols to select from.' })) {
      await this.reindex();
    }

    this.out('success', 'Ready. /new <objective> starts a session; type / to browse every command.');
  }

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
    if (args[0] === 'restore' && args[1]) return this.restore(args[1]);
    const s = this.requireSession();
    if (!s) return;
    this.out('heading', 'Checkpoints');
    const cps = Checkpoints.forSession(s.id);
    if (!cps.length) return this.out('dim', 'None.');
    for (const c of cps) this.out('info', `${c.id}  ${c.trigger}  ${c.created_at}`);
    const pick = await select('Restore a checkpoint?', cps.map((c) => ({
      value: c.id,
      label: c.id,
      hint: `${c.trigger} · ${c.created_at.slice(0, 16).replace('T', ' ')}`,
    })));
    if (pick) await this.restore(pick);
  }

  private async restore(id: string): Promise<void> {
    const ok = await confirm(`Restore checkpoint ${id}?`, {
      detail: 'The working tree is rewound to the state recorded there.',
      danger: true,
    });
    if (ok === false) return this.out('dim', 'Left as it is.');
    const s = restoreCheckpoint(id);
    if (!s) return this.out('warn', 'Checkpoint not found');
    this.sm.setCurrent(s);
    this.out('success', `Restored checkpoint ${id} → session ${s.id}`);
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
    const r = savingsReport();
    this.out('heading', 'Savings');
    if (!r.calls) {
      this.out('dim', 'No model calls recorded in this repository yet.');
      return;
    }

    // Spend first. A savings figure with nothing to compare it against is a
    // marketing number, and this one has to survive being checked.
    const gross = r.usdSpent + r.usdSaved;
    const pct = gross > 0 ? (r.usdSaved / gross) * 100 : 0;
    this.out('info', `Spent   $${r.usdSpent.toFixed(2)} over ${r.calls} call${r.calls === 1 ? '' : 's'} · ${fmtTokens(r.tokensSpent)} tokens`);
    this.out('info', `Saved   $${r.usdSaved.toFixed(2)} (${pct.toFixed(0)}% of $${gross.toFixed(2)} at list price)${r.tokensSaved ? ` · ${fmtTokens(r.tokensSaved)} tokens never sent` : ''}`);

    for (const row of r.rows) {
      this.out('info', `  ${row.label.padEnd(16)}$${row.usd.toFixed(2)}${row.tokens ? `  ${fmtTokens(row.tokens)} tok` : ''}`);
      this.out('dim', `  ${' '.repeat(16)}${row.detail}`);
    }

    if (r.window) {
      this.out('heading', 'Context window');
      const w = r.window;
      const filled = (w.peak / w.peakSize) * 100;
      this.out('info', `Largest call ${fmtTokens(w.peak)} of ${fmtTokens(w.peakSize)} (${filled.toFixed(1)}%) on ${w.peakModel}`);
      this.out('info', `Average call filled ${(w.avgFill * 100).toFixed(1)}% of the window`);
      this.out('dim', 'Context is compiled to a budget rather than filled — the headroom is the saving.');
    }
    if (r.waste) {
      this.out('dim', `Of the input sent, ${fmtTokens(r.waste.tokens)} (${(r.waste.ratio * 100).toFixed(1)}%) went to files the answers never referenced.`);
    }

    if (r.quality) {
      this.out('heading', 'Quality');
      const q = r.quality;
      const rate = (n: number) => (q.tasks ? ((n / q.tasks) * 100).toFixed(0) : '0');
      this.out('info', `${q.completed}/${q.tasks} tasks completed (${rate(q.completed)}%) · ${q.verified} verified by a test run (${rate(q.verified)}%)`);
      this.out('info', `${q.failed} failed · ${q.retried} needed more than one solver attempt`);
      this.out('dim', 'Verified means a real test framework ran and passed, not that a patch applied.');
    }
    // Where the tokens actually went. The savings above say what was avoided;
    // this says what was bought, which is the other half of the question.
    const byType = tokensByTaskType();
    if (byType.length) {
      this.out('heading', 'Where the tokens went');
      for (const t of byType.sort((a, b) => b.total_tokens - a.total_tokens)) {
        this.out('info', `${(t.type ?? 'unknown').padEnd(12)}${String(t.invocations).padStart(3)} call${t.invocations === 1 ? ' ' : 's'}  ${fmtTokens(t.total_tokens).padStart(7)}  avg ${fmtTokens(t.avg_tokens)}`);
      }
    }
    const eff = providerEfficiency();
    if (eff.length > 1) {
      for (const e of eff) this.out('dim', `${e.provider.padEnd(12)}${String(e.invocations).padStart(3)} calls  ${fmtTokens(e.total_tokens)}`);
    }

    this.out('dim', 'Cached answers cost nothing and are excluded from spend. /cost breaks spend down by role.');
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
  private async model(arg: string): Promise<void> {
    const s = this.sm.getCurrent();
    if (!arg) {
      const active = s?.current_provider?.model_id ?? this.sm.cfg.providers.default;
      this.out('heading', 'Model');
      for (const m of this.sm.manager.listModels()) {
        const mark = m.id === active ? '→' : ' ';
        this.out(m.id === active ? 'success' : 'info', `${mark} ${m.id.padEnd(28)} ctx ${fmtTokens(m.context_size)}`);
      }
      // Routing is otherwise invisible: nothing in the config says a summarize
       // call buys a cheaper model than a solve call, because the table is
       // derived from `default` rather than written down. Under a pin every row
       // shows the pinned model — the guarantee, made visible.
      this.out('heading', 'By role');
      for (const role of LLM_ROLES) {
        const m = this.sm.manager.modelFor(role);
        this.out(m === active ? 'info' : 'dim', `  ${role.padEnd(10)} ${m}`);
      }
      // The automatic half of routing, made visible for the same reason: a run
      // that quietly answered on three different models is unexplainable
      // afterwards unless the policy is somewhere the user can read it.
      this.out('heading', 'By job size');
      for (const t of ['light', 'standard', 'heavy'] as const) {
        this.out('dim', `  ${t.padEnd(10)} ${this.sm.manager.modelFor('solve', undefined, t)}`);
      }
      this.out('dim', '  (chosen per job from its type, files and context; a pin or a role entry wins)');
      if (this.sm.cfg.providers.pinned) this.out('dim', '  (pinned — every call uses this model)');
      this.out('dim', 'Switch with /model <model_id>. Move one role with /config set providers.roles.<role> <model_id>.');
      // The list is the answer when nobody is watching; when someone is, the
      // list is also the picker, so switching costs an arrow key instead of a
      // model id typed correctly from memory.
      const pick = await select('Switch model', this.sm.manager.listModels().map((m) => ({
        value: m.id,
        label: `${m.id === active ? '● ' : '  '}${m.id}`,
        hint: `ctx ${fmtTokens(m.context_size)} · $${m.cost_per_1m_input}/1M in`,
      })));
      if (!pick || pick === active) return;
      arg = pick;
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

  /**
   * The routing keys, which the flat check in `config` cannot see.
   *
   * `providers.roles` and `providers.pinned` are deliberately absent from
   * DEFAULT_CONFIG — a populated literal would deep-merge over the user's YAML
   * and shadow `providers.default` — and the consequence was that the one table
   * the routing work exists to expose could only be set by hand-editing a file.
   * Handled here rather than by loosening that check, so an unknown role or an
   * unknown model is still rejected by name instead of being written as an
   * entry that silently degrades to the default.
   *
   * Returns true when it owned the key; the message is already emitted.
   */
  private setRouting(cfg: Config, key: string, raw: string): boolean {
    if (key === 'providers.pinned') {
      if (raw !== 'true' && raw !== 'false') {
        this.out('warn', 'providers.pinned takes true or false.');
        return true;
      }
      cfg.providers.pinned = raw === 'true';
      saveConfig(cfg);
      // The running manager holds the config object loaded at startup, so a
      // saved-only change would take effect on the next launch and look like it
      // had done nothing now.
      this.sm.cfg.providers.pinned = cfg.providers.pinned;
      this.out('success', `providers.pinned = ${raw}`);
      this.out('dim', raw === 'true'
        ? 'Every role now uses providers.default — no per-role routing, no escalation, no failover to another vendor.'
        : 'Roles route again, and a stuck task may escalate.');
      return true;
    }

    const m = /^providers\.roles\.([^.]+)(?:\.(model|effort))?$/.exec(key);
    if (!m) return false;
    const role = m[1]!;
    if (!(LLM_ROLES as readonly string[]).includes(role)) {
      this.out('warn', `Unknown role: ${role}. Known: ${LLM_ROLES.join(', ')}`);
      return true;
    }
    const field = m[2] ?? 'model';
    if (field === 'effort' && !['low', 'medium', 'high'].includes(raw)) {
      this.out('warn', `${key} takes low, medium or high.`);
      return true;
    }
    if (field === 'model' && !this.sm.manager.modelSpec(raw)) {
      this.out('warn', `Unknown model: ${raw}. Run /model to see what is configured.`);
      return true;
    }

    // Always written as an object, even when only a model was given. A bare
    // string is a valid entry, but two shapes in one file means the next reader
    // has to guess which one they are looking at.
    const roles = (cfg.providers.roles ??= {});
    const existing = roles[role as LlmRole];
    const base = typeof existing === 'string' ? { model: existing } : { ...(existing ?? {}) };
    roles[role as LlmRole] = { ...base, [field]: raw };
    saveConfig(cfg);
    this.sm.cfg.providers.roles = roles;
    this.out('success', `${key} = ${raw}`);
    this.out('dim', '/model shows what every role buys now.');
    return true;
  }

  /** Read and change settings without leaving the tool or hand-editing YAML. */
  private async config(args: string[]): Promise<void> {
    const cfg = loadConfig();
    const flat = flatten(cfg as unknown as Record<string, unknown>);
    if (!args.length) {
      this.out('heading', 'Configuration');
      this.out('dim', CONFIG_PATH);
      for (const [k, v] of flat) this.out('info', `${k.padEnd(40)} ${v}`);
      this.out('dim', 'Change one with /config set <key> <value>. Role routing lives under providers.roles.<role>, and providers.pinned locks every role to the default.');
      // Settings were readable here and editable only by typing a dotted key
      // back correctly. Pick the row instead; the value is asked for next, with
      // what it is now shown in the field.
      const key = await select('Change a setting', [
        ...flat.map(([k, v]) => ({ value: k, label: k, hint: String(v) })),
        { value: 'providers.pinned', label: 'providers.pinned', hint: `${cfg.providers.pinned ?? false} — lock every role to the default model` },
        ...LLM_ROLES.map((r) => ({
          value: `providers.roles.${r}`,
          label: `providers.roles.${r}`,
          hint: this.sm.manager.modelFor(r),
        })),
      ]);
      if (!key) return;
      const answers = await form(key, [{ name: 'value', label: 'New value', placeholder: String(flat.find(([k]) => k === key)?.[1] ?? '') }]);
      if (!answers?.value) return;
      return this.config(['set', key, answers.value]);
    }
    if (args[0] !== 'set' || args.length < 3) return this.usage('/config');
    const key = args[1]!;
    const raw = args.slice(2).join(' ');
    if (this.setRouting(cfg, key, raw)) return;
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
  private async undo(arg: string): Promise<void> {
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
    // Undo rewrites files on disk. Everything else here is reversible by
    // running it again; this is the one command that is not.
    const ok = await confirm('Undo the last applied change?', {
      detail: `${rec.entries.length} file(s): ${rec.entries.map((e) => e.path).join(', ').slice(0, 80)}`,
      danger: true,
    });
    if (ok === false) return this.out('dim', 'Left as it is.');
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
    const looked = reuse.hits + reuse.misses;
    this.out(
      reuse.hits > 0 ? 'success' : 'dim',
      reuse.hits > 0
        ? `Repeated questions: ${reuse.hits} of ${looked} lookups answered from store (${Math.round((reuse.hits / looked) * 100)}%), ${fmtTokens(reuse.tokens)} tokens never spent.`
        : `Repeated questions: none yet — all ${looked} lookup(s) asked something new.`,
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
      // Only the accounts whose credential resolves. Listing all four vendors as
      // healthy when none of them can be called is worse than saying nothing.
      const usable = this.sm.manager.listAccounts().filter((a) => this.sm.manager.accountResolves(a));
      if (usable.length) ok(`Providers: ${usable.map((a) => `${a.provider_id}/${a.alias} (${a.health.status})`).join(', ')}`);
      else bad('Credentials found, but none of them resolve.', 'Run /account to see which, then /account add <provider> <alias> <key>.');
    } else {
      bad('No provider credentials.', 'Run /account login to sign in with a vendor CLI, or /account add to paste a key.');
    }
    // Installed but signed out is the case that used to read as available and
    // then failed on the first call, so it is called out by name.
    const clis = allCliStates();
    const live = clis.filter((c) => c.signedIn);
    if (live.length) {
      ok(`Signed in: ${live.map((c) => `${c.vendor.binary}/${c.account}`).join(', ')} — vendor plans are used before metered keys.`);
    }
    for (const c of clis.filter((x) => x.installed && !x.signedIn)) {
      // A named account that has never been signed in is half-created, and it
      // reads as an available provider until the first call fails.
      bad(`${c.vendor.label} · ${c.account} is installed but signed out.`, `Run /account login ${c.vendor.binary} ${c.account}.`);
    }
    if (!live.length && !clis.some((c) => c.installed)) this.out('dim', 'No vendor CLI on PATH; calls go through metered API keys.');

    const blocked = QuotaLedger.all().filter((st) => QuotaLedger.blockedForMs(st.key, st.provider_id) > 0);
    for (const st of blocked) {
      bad(`${st.key} is cooling down for ${fmtDuration(QuotaLedger.blockedForMs(st.key, st.provider_id))}.`, st.last_error ? st.last_error.slice(0, 120) : 'Run /cost for the window.');
    }

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
    if (!plugins.length) this.out('dim', `None. Drop plugins into ${PLUGINS_DIR}/<name>/ with a plugin.json.`);
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
    // Forty-eight commands listed as eight group names and a count told a
    // reader nothing about what to type. The dozen that cover almost every
    // session come first, in the order you would actually reach for them.
    this.out('heading', 'Start here');
    for (const [cmd, what] of START_HERE) this.out('info', `${cmd.padEnd(22)}${what}`);
    this.out('heading', 'Everything else');
    for (const g of groups) {
      const cmds = COMMANDS.filter((c) => c.group === g);
      this.out('info', `${g.padEnd(12)}${cmds.map((c) => c.cmd).join(' ')}`);
    }
    this.out('dim', '/help <group> describes a group · /<command> --help shows one command · /doctor checks the setup.');
  }
}

/** The path through the tool, not an index of it: ask a question, start work,
 *  watch it, check it, undo it. Everything here is also in COMMANDS — this is
 *  an ordering, not a second catalogue. */
const START_HERE: Array<[string, string]> = [
  ['<just type it>', 'Describe a change and CodeMaster plans it and does it'],
  ['<ask a question>', 'Anything read-only is answered without starting a session'],
  ['/tasks', 'What the plan is and how far through it you are'],
  ['/diff', 'Everything changed so far in this session'],
  ['/stats', 'Tokens, cost, context window and what was saved'],
  ['/undo', 'Reverse the last patch'],
  ['/model', 'Show or switch the model'],
  ['/account', 'Store credentials for each provider and switch between them'],
  ['/doctor', 'Check that the setup actually works'],
];

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
