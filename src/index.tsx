#!/usr/bin/env node
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import os from 'os';
import { createRequire } from 'module';
import path from 'path';

import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { Autocomplete, type Cmd } from './components/Autocomplete.js';
import { eventToLog, type LogEntry, type LogType, type SessionStatusView } from './util/parser.js';
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
let _id = 0;
function logReducer(
  state: LogEntry[],
  action: { type: 'add'; entry: Omit<LogEntry, 'id'> } | { type: 'clear' },
): LogEntry[] {
  if (action.type === 'clear') return [];
  return [...state, { ...action.entry, id: ++_id }].slice(-500);
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
function Spinner({ label }: { label: string }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((i) => (i + 1) % BRAILLE.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Box marginLeft={2} marginY={1}>
      <Text color={BLUE_HI} bold>{BRAILLE[f]} {label}</Text>
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
      <Text color={MUTED} dimColor>codemaster-next v{VERSION}</Text>
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
  const [logs, dispatch] = useReducer(logReducer, [] as LogEntry[]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
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
    log('heading', 'CodeMaster Next');
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

      log('user', secret ? text.split(/\s+/).slice(0, 4).join(' ') + ' ****' : text);
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
      <Header shortCwd={path.basename(shortCwd) === shortCwd ? shortCwd : shortCwd} session={status} />
      <MessageList logs={logs} />
      {running && <Spinner label="working…" />}
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
