#!/usr/bin/env node
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import os from 'os';
import { createRequire } from 'module';

import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { Autocomplete, type Cmd } from './components/Autocomplete.js';
import { eventToLog, phaseOf, type LogEntry, type LogType, type Phase, type SessionStatusView } from './util/parser.js';
import { BLUE_HI, BLUE_DIM, MUTED, BRAILLE } from './themes/blue.js';

import { bus } from './events/bus.js';
import { cancelActive } from './util/cancel.js';
import { Daemon } from './daemon/daemon.js';
import { COMMANDS } from './commands/catalog.js';
import { Sessions, Tasks } from './storage/sessions.js';
import { staticAnalysis } from './analysis/api.js';
import { Tokens } from './storage/tokens.js';

const require_ = createRequire(import.meta.url);
const VERSION = (require_('../package.json') as { version: string }).version;
const AC_COMMANDS: Cmd[] = COMMANDS.map((c) => ({ cmd: c.cmd, desc: c.desc }));

const daemon = new Daemon();
const sm = daemon.sm;
const router = daemon.router;

// ── Log state ───────────────────────────────────────────────────────────────
// Two regions, not one list. `settled` is written to the terminal exactly once
// via <Static>; `live` is the phase currently running and is the only thing
// that repaints. When a phase ends it collapses to a single result line and
// moves across, so a finished run reads as a few lines rather than every line
// the workers emitted.
interface LogState {
  settled: LogEntry[];
  live: LogEntry[];
  phase: Phase | null;
  phaseStart: number;
  clearGen: number;
  verbose: boolean;
}

const EMPTY_LOGS: LogState = { settled: [], live: [], phase: null, phaseStart: 0, clearGen: 0, verbose: false };

let _id = 0;

/** One line standing in for a phase's whole output: what it was, and what it
 *  cost in wall time. The detail is gone from the screen, not from the run. */
function collapse(state: LogState): LogEntry[] {
  if (!state.phase || state.live.length === 0) return state.live;
  const secs = Math.max(0, Math.round((Date.now() - state.phaseStart) / 1000));
  const result =
    [...state.live].reverse().find((e) => e.type === 'success' || e.type === 'error')?.text ??
    `${state.live.length} step${state.live.length === 1 ? '' : 's'}`;
  return [{ id: ++_id, type: 'dim', text: `${state.phase.padEnd(11)}${result} · ${secs}s` }];
}

function logReducer(
  state: LogState,
  action:
    | { type: 'add'; entry: Omit<LogEntry, 'id'> }
    | { type: 'clear' }
    | { type: 'verbose'; on: boolean },
): LogState {
  if (action.type === 'clear') return { ...EMPTY_LOGS, clearGen: state.clearGen + 1, verbose: state.verbose };
  if (action.type === 'verbose') return { ...state, verbose: action.on };

  const phase = phaseOf(action.entry, state.phase);
  const entry: LogEntry = { ...action.entry, phase: phase ?? undefined, id: ++_id };

  // Nothing collapses in verbose mode: every line goes straight to the
  // permanent region, which is what /verbose is for.
  if (state.verbose) {
    return { ...state, phase, settled: [...state.settled, entry].slice(-2000), live: [] };
  }
  if (phase === state.phase) {
    return { ...state, live: [...state.live, entry].slice(-40) };
  }
  return {
    ...state,
    phase,
    phaseStart: Date.now(),
    settled: [...state.settled, ...collapse(state), ...(phase ? [] : [entry])].slice(-2000),
    live: phase ? [entry] : [],
  };
}

function computeStatus(): SessionStatusView | null {
  const s = sm.getCurrent();
  if (!s) return null;
  const tasks = Tasks.forSession(s.id);
  const tok = Tokens.sessionTotal(s.id);
  return {
    id: s.id,
    status: s.status,
    taskN: tasks.filter((t) => t.status === 'completed').length,
    taskTotal: tasks.length,
    tokens: tok.total,
    tokenBudget: sm.cfg.token_budget.session_default,
    provider: s.current_provider?.model_id ?? sm.cfg.providers.default,
    lastCheckpoint: s.latest_checkpoint?.slice(0, 12),
  };
}

// ── Mini components ───────────────────────────────────────────────────────────
/** One line that updates in place, replacing the repeated "still working — 15s
 *  elapsed" lines that used to accumulate one per poll. */
function Spinner({ label, since }: { label: string; since: number }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((i) => (i + 1) % BRAILLE.length), 80);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
  return (
    <Box marginLeft={2} marginTop={1}>
      <Text color={BLUE_HI} bold>{BRAILLE[f]} {label}</Text>
      <Text color={MUTED}>  {secs}s · esc to stop</Text>
    </Box>
  );
}

function InputArea({
  value, onChange, onSubmit, active, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  active: boolean;
  placeholder?: string;
}) {
  return (
    <Box borderStyle="single" borderTop borderBottom borderLeft={false} borderRight={false} borderColor={BLUE_DIM} paddingX={1}>
      <Text bold color={active ? BLUE_HI : MUTED}>❯ </Text>
      {active ? (
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus showCursor placeholder={placeholder} />
      ) : (
        <Text color={MUTED}>{placeholder ?? ''}</Text>
      )}
    </Box>
  );
}

function StatusBar({ running, status }: { running: boolean; status: SessionStatusView | null }) {
  const left = running
    ? '►► working  ·  please wait'
    : status
      ? `${status.status}  ·  task ${status.taskN}/${status.taskTotal}  ·  ${status.provider}`
      : 'ready  ·  /new <objective>';
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text color={MUTED} dimColor>{left}  ·  Ctrl+Q quit  ·  Ctrl+L clear</Text>
      <Text color={MUTED} dimColor>codemaster v{VERSION}</Text>
    </Box>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────
/** A repository with no index and no prior session has never been worked on
 *  here — the only state that warrants spelling out the first steps. */
function firstRunHere(repoPath: string): boolean {
  try {
    if (staticAnalysis(repoPath).stats()) return false;
    return Sessions.list(1, repoPath).length === 0;
  } catch {
    return false;
  }
}

function App() {
  const { exit } = useApp();
  const [logs, dispatch] = useReducer(logReducer, EMPTY_LOGS);
  // <Static> lines are already in the terminal's scrollback, so emptying the
  // log state alone leaves them on screen — /clear would look broken. Clear the
  // screen and the scrollback too, which is what the command means.
  const { stdout } = useStdout();
  useEffect(() => {
    if (logs.clearGen > 0) stdout?.write('\x1b[2J\x1b[3J\x1b[H');
  }, [logs.clearGen, stdout]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [status, setStatus] = useState<SessionStatusView | null>(null);
  const [acOptions, setAcOptions] = useState<Cmd[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const cwd = process.cwd();

  const log = useCallback((type: LogType, text: string) => dispatch({ type: 'add', entry: { type, text } }), []);

  // Subscribe to the event bus once.
  useEffect(() => {
    const off = bus.onAny((ev) => {
      const entry = eventToLog(ev);
      if (entry && (entry.type !== 'plain' || entry.text)) dispatch({ type: 'add', entry });
      setStatus(computeStatus());
    });
    if (firstRunHere(cwd)) {
      // Nothing has been indexed and nothing has been run here, so the generic
      // one-liner would leave a new user with no idea what order to do things
      // in. Three lines, in the order they actually need to happen.
      log('dim', 'First run in this repository. Three steps to get going:');
      log('dim', '  1. /doctor      — check Node, git, providers and tooling');
      log('dim', '  2. /reindex     — build this repository’s symbol index');
      log('dim', '  3. /new <objective> — start a session; /help lists every command');
    } else {
      log('dim', 'Persistent reasoning OS. /new <objective> to begin, /help for commands.');
    }
    if (!sm.manager.hasAnyProvider())
      log('warn', 'No provider credentials — set an API key or run `claude setup-token` for account login. Deterministic commands still work.');
    void daemon.start().then(({ incomplete, reaped, plugins }) => {
      if (plugins > 0) log('dim', `${plugins} plugin(s) loaded.`);
      if (reaped > 0) log('dim', `${reaped} abandoned session(s) closed.`);
      if (incomplete > 0) log('warn', `${incomplete} incomplete session(s) detected — run /recover to restore.`);
    });
    setStatus(computeStatus());
    return () => {
      void daemon.stop();
      off();
    };
  }, [log]);

  useInput((c, key) => {
    if (key.ctrl && c === 'q') exit();
    if (key.ctrl && c === 'l') dispatch({ type: 'clear' });
    // Ctrl-C stops the running task and keeps the session; with nothing
    // running there is nothing to stop, so it leaves.
    if (key.ctrl && c === 'c') { if (!cancelActive()) exit(); return; }
    // Esc is what people reach for to stop a running thing. It stops the task,
    // not the process — the session and everything on disk survive.
    if (key.escape && running) { cancelActive(); return; }

    if (acOptions.length > 0) {
      if (key.upArrow) setAcIndex((i) => (i <= 0 ? acOptions.length - 1 : i - 1));
      if (key.downArrow) setAcIndex((i) => (i >= acOptions.length - 1 ? 0 : i + 1));
      if (key.tab) {
        const sel = acOptions[acIndex];
        if (sel) { setInput(sel.cmd + ' '); setAcOptions([]); }
      }
      if (key.escape) setAcOptions([]);
    } else if (!running) {
      if (key.upArrow) {
        const hist = inputHistoryRef.current;
        if (!hist.length) return;
        const next = Math.min(historyIdxRef.current + 1, hist.length - 1);
        historyIdxRef.current = next;
        setInput(hist[hist.length - 1 - next] ?? '');
      }
      if (key.downArrow) {
        if (historyIdxRef.current <= 0) { historyIdxRef.current = -1; setInput(''); return; }
        historyIdxRef.current -= 1;
        const hist = inputHistoryRef.current;
        setInput(hist[hist.length - 1 - historyIdxRef.current] ?? '');
      }
    }
  });

  function handleChange(val: string) {
    historyIdxRef.current = -1;
    setInput(val);
    if (val.startsWith('/')) {
      const m = val.toLowerCase();
      setAcOptions(AC_COMMANDS.filter((c) => c.cmd.startsWith(m)));
      setAcIndex(0);
    } else {
      setAcOptions([]);
    }
  }

  const handleSubmit = useCallback(
    async (raw: string) => {
      if (acOptions.length > 0) {
        const sel = acOptions[acIndex];
        if (sel) { setInput(sel.cmd + ' '); setAcOptions([]); }
        return;
      }
      if (running) return;
      const text = raw.trim();
      setInput('');
      if (!text) return;

      // `/account add <provider> <alias> <key>` is the one line that carries a
      // secret. Up-arrow would replay it and the transcript would keep it, so
      // this line is never recalled and the key is masked in the echo.
      const secret = /^\/account\s+add\s+\S+\s+\S+\s+\S/.test(text);
      if (!secret) inputHistoryRef.current.push(text);
      historyIdxRef.current = -1;

      if (text === '/quit' || text === '/exit') { exit(); return; }
      if (text === '/clear') { dispatch({ type: 'clear' }); return; }
      // Collapsing is a rendering choice, so /verbose has to be honoured here
      // as well as by the router that owns the flag.
      if (/^\/verbose\b/.test(text)) dispatch({ type: 'verbose', on: !/\boff\b/.test(text) });

      log('user', secret ? text.split(/\s+/).slice(0, 4).join(' ') + ' ****' : text);
      setStartedAt(Date.now());
      setRunning(true);
      try {
        await router.dispatch(text);
      } catch (e) {
        log('error', String(e));
      } finally {
        setRunning(false);
        setStatus(computeStatus());
      }
    },
    [acOptions, acIndex, running, exit, log],
  );

  const shortCwd = cwd.startsWith(os.homedir()) ? '~' + cwd.slice(os.homedir().length) : cwd;

  return (
    <Box flexDirection="column" width="100%">
      <Header shortCwd={shortCwd} version={VERSION} session={status} />
      <MessageList settled={logs.settled} live={logs.live} clearGen={logs.clearGen} />
      {running && <Spinner label={logs.phase ?? 'working'} since={startedAt} />}
      {!running && acOptions.length > 0 && <Autocomplete options={acOptions} selectedIndex={acIndex} />}
      <InputArea value={input} onChange={handleChange} onSubmit={handleSubmit} active={!running} placeholder="/new <objective> or /help" />
      <StatusBar running={running} status={status} />
    </Box>
  );
}

// Non-interactive mode when arguments are present; the TUI otherwise.
const argv = process.argv.slice(2);
// `codemaster mcp` is a stdio server: it must never render a TUI, and nothing
// but JSON-RPC may reach stdout.
const repoFlag = argv.indexOf('--repo');
const repoArg = repoFlag >= 0 ? (argv[repoFlag + 1] ?? process.cwd()) : process.cwd();
if (argv[0] === 'mcp') {
  const { runMcpServer } = await import('./mcp.js');
  await runMcpServer(repoArg);
} else if (argv[0] === 'proxy') {
  const portFlag = argv.indexOf('--port');
  const { runProxy } = await import('./proxy.js');
  await runProxy(repoArg, portFlag >= 0 ? Number(argv[portFlag + 1]) || 7433 : 7433);
} else if (argv.length > 0) {
  const { runHeadless } = await import('./commands/headless.js');
  process.exitCode = await runHeadless(argv);
} else {
  render(<App />);
}
