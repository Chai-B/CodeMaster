// Async vendor-CLI runner. The adapters used spawnSync, which blocks the event
// loop for the whole call: the TUI froze mid-frame, no progress reached the
// user, and Ctrl-C only worked because the terminal signalled the child
// directly. This runs the child properly — the interface keeps rendering, each
// line the CLI produces can be surfaced as it arrives, and a long silent call
// says so instead of looking hung.

import { spawn } from 'child_process';
import { bus } from '../events/bus.js';
import { isCancelled } from '../util/cancel.js';

/** What the adapters need from a finished child. Mirrors the fields of
 *  SpawnSyncReturns they actually read, so the failure describers are unchanged. */
export interface CliRun {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

const HEARTBEAT_MS = 15_000;
const CANCEL_POLL_MS = 500;

export function runCli(
  cmd: string,
  args: string[],
  input: string,
  /** Called with each complete stdout line as it arrives. */
  onLine?: (line: string) => void,
  /** The account's environment, when the call is for a named CLI account
   *  rather than the machine-wide sign-in. */
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let error: Error | undefined;
    let done = false;

    // A vendor call routinely runs for minutes with nothing on stdout. Saying
    // how long it has been waiting is the difference between "working" and
    // "hung" for whoever is watching — but the TUI spinner already counts the
    // seconds in place, so emitting it there only stacked up a line per poll.
    const heartbeat = setInterval(() => {
      if (process.env.CODEMASTER_TUI) return;
      bus.emit({ type: 'log', level: 'info', message: `${cmd} still working — ${Math.round((Date.now() - started) / 1000)}s elapsed.` });
    }, HEARTBEAT_MS);

    // Ctrl-C now reaches the child through the same path as everything else,
    // rather than relying on it sharing the terminal's process group.
    const cancelWatch = setInterval(() => {
      if (isCancelled() && !done) child.kill('SIGINT');
    }, CANCEL_POLL_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) onLine(l);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (e) => {
      error = e;
    });
    child.on('close', (status, signal) => {
      done = true;
      clearInterval(heartbeat);
      clearInterval(cancelWatch);
      if (onLine && pending.trim()) onLine(pending);
      resolve({ stdout, stderr, status, signal, error });
    });

    // A CLI that died before reading stdin makes this throw EPIPE, which is a
    // spawn-level failure the close handler already reports.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
