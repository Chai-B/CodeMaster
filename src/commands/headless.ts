// Non-interactive entry point. `codemaster run "<objective>"` — usable from
// scripts, CI, and as a subprocess, which the Ink TUI cannot be.

import fs from 'fs';
import { spawnSync } from 'child_process';
import { bus } from '../events/bus.js';
import { Daemon } from '../daemon/daemon.js';
import { Tasks } from '../storage/sessions.js';
import { Tokens } from '../storage/tokens.js';
import { eventToLog } from '../utils/parser.js';
import { GitWorker } from '../analysis/git.js';
import type { Session } from '../types/index.js';

const USAGE = `codemaster — persistent reasoning layer for AI coding agents

  codemaster                        interactive TUI
  codemaster run [objective]        plan and execute an objective, then exit
  codemaster --version

Options for run:
  --json            emit a machine-readable result on stdout
  --repo <path>     repository to work in (default: cwd)
  --verbose         stream progress to stderr even with --json

The objective may be piped instead of passed as an argument:
  echo "fix the parser" | codemaster run --json

Exit codes: 0 ok · 1 task failure · 2 usage · 3 no provider credentials
`;

interface Flags {
  json: boolean;
  verbose: boolean;
  repo: string;
  objective: string;
}

function parse(argv: string[]): Flags | null {
  const flags: Flags = { json: false, verbose: false, repo: process.cwd(), objective: '' };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') flags.json = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--repo') { const v = argv[++i]; if (!v) return null; flags.repo = v; }
    else if (a.startsWith('-')) return null;
    else words.push(a);
  }
  flags.objective = words.join(' ').trim();
  return flags;
}

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

/** Paths touched in the working tree, including files the run created — which
 *  `git diff HEAD` alone omits, making a pure file-creation run look empty. */
function changedFiles(repo: string): string[] {
  return git(repo, ['status', '--porcelain'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

export async function runHeadless(argv: string[]): Promise<number> {
  if (argv[0] !== 'run') {
    process.stderr.write(USAGE);
    return argv[0] === '--help' || argv[0] === '-h' ? 0 : 2;
  }

  const flags = parse(argv.slice(1));
  if (!flags) { process.stderr.write(USAGE); return 2; }

  const objective = flags.objective || readStdin();
  if (!objective) { process.stderr.write('No objective given.\n\n' + USAGE); return 2; }
  if (!fs.existsSync(flags.repo)) { process.stderr.write(`No such directory: ${flags.repo}\n`); return 2; }

  const showProgress = flags.verbose || !flags.json;
  // Failures always reach stderr. Suppressing them under --json hid provider
  // errors entirely, leaving "No available provider account" with no cause.
  const ALWAYS = new Set(['provider.error', 'provider.rate_limited', 'quota.exhausted', 'task.failed']);
  const off = bus.onAny((ev) => {
    const isFailure = ALWAYS.has(ev.type) || (ev.type === 'log' && (ev.level === 'error' || ev.level === 'warn'));
    if (!showProgress && !isFailure) return;
    const entry = eventToLog(ev);
    if (entry?.text) process.stderr.write(`${entry.text}\n`);
  });

  const daemon = new Daemon();
  const sm = daemon.sm;

  // Ctrl-C pauses rather than abandons: applied work stays on disk and the
  // session is resumable, instead of being left `active` for the startup
  // reaper to close. A second Ctrl-C gives up on the clean exit.
  let session: Session | undefined;
  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write('\nInterrupted — pausing session…\n');
    if (!session) process.exit(130);
    void sm.pause(session).finally(() => {
      process.stderr.write(`Paused. Resume with: codemaster /resume ${session!.id}\n`);
      process.exit(130);
    });
  };
  process.on('SIGINT', onSigint);

  try {
    await daemon.start();
    if (!sm.manager.hasAnyProvider()) {
      process.stderr.write('No provider credentials — set an API key, run `claude setup-token`, or use /account add.\n');
      return 3;
    }

    session = await sm.createSession(objective, flags.repo);
    await sm.plan(session);
    await sm.runAll(session);

    const tasks = Tasks.forSession(session.id);
    const failed = tasks.filter((t) => t.status === 'failed');
    const tokens = Tokens.sessionTotal(session.id);

    if (flags.json) {
      process.stdout.write(
        JSON.stringify({
          session_id: session.id,
          status: session.status,
          objective,
          repo: flags.repo,
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, status: t.status, files: t.output_files.map((f) => f.path) })),
          failed: failed.map((t) => ({ title: t.title, reason: t.failure_reason ?? null })),
          tokens: { input: tokens.input, output: tokens.output, total: tokens.total },
          files_changed: changedFiles(flags.repo),
          diff: new GitWorker(flags.repo).fullWorkingDiff(),
        }, null, 2) + '\n',
      );
    } else {
      const done = tasks.filter((t) => t.status === 'completed').length;
      process.stderr.write(`\n${done}/${tasks.length} tasks completed, ${failed.length} failed · ${tokens.total.toLocaleString()} tokens · session ${session.id}\n`);
    }

    return failed.length > 0 || tasks.length === 0 ? 1 : 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // --json consumers get a parseable result on every path, not an empty
    // stdout plus a bare stderr line.
    if (flags.json) process.stdout.write(JSON.stringify({ status: 'error', objective, repo: flags.repo, error: message }, null, 2) + '\n');
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    off();
    await daemon.stop();
  }
}
