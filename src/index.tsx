#!/usr/bin/env node
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import os from 'os';
import path from 'path';

import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { Autocomplete, type Cmd } from './components/Autocomplete.js';
import { eventToLog, type LogEntry, type LogType, type SessionStatusView } from './utils/parser.js';
import { BLUE_HI, BLUE_DIM, MUTED, BRAILLE } from './themes/blue.js';

import { bus } from './events/bus.js';
import { Daemon } from './daemon/daemon.js';
import { COMMANDS } from './commands/catalog.js';
import { Tasks } from './storage/sessions.js';
import { Tokens } from './storage/tokens.js';

const VERSION = '0.1.0';
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
    tokenBudget: sm.cfg.context.session_token_budget,
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
    log('dim', 'Persistent reasoning OS. /new <objective> to begin, /help for commands.');
    const hasCreds =
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
    if (!hasCreds)
      log('warn', 'No provider credentials — set an API key or run `claude setup-token` for account login. Deterministic commands still work.');
    void daemon.start().then(({ incomplete }) => {
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

      inputHistoryRef.current.push(text);
      historyIdxRef.current = -1;

      if (text === '/quit' || text === '/exit') { exit(); return; }
      if (text === '/clear') { dispatch({ type: 'clear' }); return; }

      log('user', text);
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

render(<App />);
