#!/usr/bin/env node
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { Autocomplete, type Cmd } from './components/Autocomplete.js';
import { classifyLine, parseMetrics, type LogEntry, type LogType, type Metrics } from './utils/parser.js';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED, BRAILLE } from './themes/blue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const AGENTS_DIR = path.join(BASE_DIR, 'agents');
const HISTORY_PATH = path.join(BASE_DIR, 'activity_history.json');
const VERSION = '1.0.0';

// ── Config ────────────────────────────────────────────────────────────────────

interface Config {
  max_files: number;
  max_fns: number;
  max_debug: number;
  claude_cmd: string;
  [key: string]: string | number;
}

const CONFIG_SCHEMA: { key: keyof Config; label: string; type: 'number' | 'string' }[] = [
  { key: 'max_files', label: 'Max files per context', type: 'number' },
  { key: 'max_fns', label: 'Max functions per file', type: 'number' },
  { key: 'max_debug', label: 'Max debug cycles', type: 'number' },
  { key: 'claude_cmd', label: 'Claude CLI command', type: 'string' },
];

function readConfig(): Config {
  try { return { max_files: 3, max_fns: 3, max_debug: 2, claude_cmd: 'claude', ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return { max_files: 3, max_fns: 3, max_debug: 2, claude_cmd: 'claude' }; }
}

function writeConfig(cfg: Config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── History ───────────────────────────────────────────────────────────────────

interface HistoryEntry { task: string; time: string }

function readHistory(): HistoryEntry[] {
  try { const d = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

function appendHistory(task: string) {
  const entries = readHistory();
  const n = new Date();
  const time = `${String(n.getMonth() + 1).padStart(2, '0')}/${String(n.getDate()).padStart(2, '0')} ${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  entries.push({ task: task.slice(0, 55), time });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries.slice(-10), null, 2));
}

// ── Log state ─────────────────────────────────────────────────────────────────

let _id = 0;
function logReducer(state: LogEntry[], action: { type: 'add'; entry: Omit<LogEntry, 'id'> } | { type: 'clear' }): LogEntry[] {
  if (action.type === 'clear') return [];
  return [...state, { ...action.entry, id: ++_id }];
}

// ── Agents ────────────────────────────────────────────────────────────────────

function listAgents(): string[] {
  try { return fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')); }
  catch { return []; }
}

// ── Commands ──────────────────────────────────────────────────────────────────

const BASE_COMMANDS: Cmd[] = [
  { cmd: '/help', desc: 'Show commands' },
  { cmd: '/clear', desc: 'Clear history & maps' },
  { cmd: '/config', desc: 'Edit parameters' },
  { cmd: '/agents', desc: 'Edit agent prompts' },
  { cmd: '/fix', desc: 'Fix bugs in code' },
  { cmd: '/refactor', desc: 'Refactor code' },
  { cmd: '/test', desc: 'Write or fix tests' },
  { cmd: '/explain', desc: 'Explain code' },
  { cmd: '/git', desc: 'Run git operations' },
  { cmd: '/files', desc: 'File operations' },
  { cmd: '/context', desc: 'Context operations' },
  { cmd: '/model', desc: 'Model operations' },
  { cmd: '/cc', desc: 'Launch Claude natively' },
  { cmd: '/quit', desc: 'Exit CodeMaster' }
];

// ── Mini-components ───────────────────────────────────────────────────────────

function Spinner({ label }: { label: string }) {
  const [f, setF] = useState(0);
  useEffect(() => { const t = setInterval(() => setF(i => (i + 1) % BRAILLE.length), 80); return () => clearInterval(t); }, []);
  return <Box marginLeft={2} marginY={1}><Text color={BLUE_HI} bold>{BRAILLE[f]} {label}</Text></Box>;
}

function MetricsBar({ metrics, cfg }: { metrics: Metrics | null; cfg: Config }) {
  return (
    <Box borderStyle="single" borderTop={false} borderBottom borderLeft={false} borderRight={false} borderColor={BLUE_DIM} paddingX={2} justifyContent="space-between">
      <Box gap={3}>
        <Text color={MUTED}>files <Text color={BLUE_HI}>{cfg.max_files}</Text></Text>
        <Text color={MUTED}>fns <Text color={BLUE_HI}>{cfg.max_fns}</Text></Text>
        <Text color={MUTED}>debug <Text color={BLUE_HI}>{cfg.max_debug}</Text></Text>
        <Text color={MUTED}>claude <Text color={BLUE_HI}>{cfg.claude_cmd}</Text></Text>
      </Box>
      {metrics && (
        <Box gap={3}>
          <Text color={MUTED}>calls <Text color={BLUE_HI}>{metrics.calls}</Text></Text>
          <Text color={MUTED}>tokens <Text color={BLUE_HI}>{metrics.total_tokens.toLocaleString()}</Text></Text>
          <Text color={MUTED}>avg ctx <Text color={BLUE_HI}>{metrics.avg_context.toLocaleString()}</Text></Text>
          <Text color={MUTED}>elapsed <Text color={BLUE_HI}>{metrics.elapsed.toFixed(1)}s</Text></Text>
        </Box>
      )}
    </Box>
  );
}

function InputArea({ value, onChange, onSubmit, active, placeholder }: { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; active: boolean; placeholder?: string }) {
  return (
    <Box borderStyle="single" borderTop borderBottom borderLeft={false} borderRight={false} borderColor={BLUE_DIM} paddingX={1}>
      <Text bold color={active ? BLUE_HI : MUTED}>❯ </Text>
      {active
        ? <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus showCursor placeholder={placeholder} />
        : <Text color={MUTED}>{placeholder ?? ''}</Text>
      }
    </Box>
  );
}

function StatusBar({ running, cwd }: { running: boolean; cwd: string }) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text color={MUTED} dimColor>{running ? '►► running  ·  Ctrl+C interrupt' : 'ready  ·  Ctrl+Q quit  ·  Ctrl+L clear'}</Text>
      <Text color={MUTED} dimColor>codemaster v{VERSION}  ·  {path.basename(cwd)}</Text>
    </Box>
  );
}

// ── Config editor ─────────────────────────────────────────────────────────────

function ConfigEditor({ cfg, onSave, onCancel }: { cfg: Config; onSave: (c: Config) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState({ ...cfg });
  const [field, setField] = useState(0);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');

  useInput((_c, key) => {
    if (editing) return;
    if (key.upArrow) setField(i => Math.max(0, i - 1));
    if (key.downArrow) setField(i => Math.min(CONFIG_SCHEMA.length - 1, i + 1));
    if (key.return) { setVal(String(draft[CONFIG_SCHEMA[field].key])); setEditing(true); }
    if (key.escape) onCancel();
    if (_c === 's' && key.ctrl) onSave(draft);
  });

  function commitEdit(v: string) {
    const schema = CONFIG_SCHEMA[field];
    const parsed = schema.type === 'number' ? Number(v) || draft[schema.key] : v;
    setDraft(d => ({ ...d, [schema.key]: parsed }));
    setEditing(false);
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BLUE_HI} marginX={1} paddingX={1}>
      <Text bold color={BLUE_HI}>  Config Editor  —  ↑↓ navigate  ·  Enter edit  ·  Ctrl+S save  ·  Esc cancel</Text>
      <Text color={BLUE_DIM}>{'─'.repeat(60)}</Text>
      {CONFIG_SCHEMA.map((s, i) => (
        <Box key={s.key}>
          <Text color={i === field ? BLUE_HI : MUTED} bold={i === field}>
            {i === field ? '❯ ' : '  '}
            {s.label.padEnd(28)}
          </Text>
          {editing && i === field
            ? <TextInput value={val} onChange={setVal} onSubmit={commitEdit} focus showCursor />
            : <Text color={BLUE_HI}>{String(draft[s.key])}</Text>
          }
        </Box>
      ))}
    </Box>
  );
}

// ── Agent browser ─────────────────────────────────────────────────────────────

function AgentBrowser({ onClose, log }: { onClose: () => void; log: (type: LogType, text: string) => void }) {
  const agents = listAgents();
  const [selected, setSelected] = useState(0);

  useInput((_c, key) => {
    if (key.upArrow) setSelected(i => Math.max(0, i - 1));
    if (key.downArrow) setSelected(i => Math.min(agents.length - 1, i + 1));
    if (key.return) openAgent(agents[selected]);
    if (key.escape) onClose();
  });

  function openAgent(name: string) {
    const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
    const agentPath = path.join(AGENTS_DIR, name);
    spawn(editor, [agentPath], { stdio: 'inherit', detached: false });
    log('tool', `Opened ${name} in ${editor}`);
    onClose();
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BLUE_HI} marginX={1} paddingX={1}>
      <Text bold color={BLUE_HI}>  Agent Files  —  ↑↓ navigate  ·  Enter open in $EDITOR  ·  Esc cancel</Text>
      <Text color={BLUE_DIM}>{'─'.repeat(60)}</Text>
      {agents.map((a, i) => (
        <Box key={a}>
          <Text color={i === selected ? BLUE_HI : MUTED} bold={i === selected}>
            {i === selected ? '❯ ' : '  '}{a}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<Config>(readConfig);
  const [history, setHistory] = useState<HistoryEntry[]>(readHistory);
  const [logs, dispatch] = useReducer(logReducer, [] as LogEntry[]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [acOptions, setAcOptions] = useState<Cmd[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [mode, setMode] = useState<'normal' | 'config' | 'agents'>('normal');
  const proc = useRef<ChildProcessWithoutNullStreams | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIdxRef   = useRef(-1);
  const savedInputRef   = useRef('');
  const cwd = process.cwd();

  const log = useCallback((type: LogType, text: string) => dispatch({ type: 'add', entry: { type, text } }), []);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);

  useInput((_c, key) => {
    if (mode !== 'normal') return;
    if (key.ctrl && _c === 'q') exit();
    if (key.ctrl && _c === 'l') clear();
    if (key.ctrl && _c === 'c' && proc.current) { proc.current.kill('SIGTERM'); log('warn', 'Interrupted'); }
    if (acOptions.length > 0) {
      if (key.upArrow) setAcIndex(i => (i <= 0 ? acOptions.length - 1 : i - 1));
      if (key.downArrow) setAcIndex(i => (i >= acOptions.length - 1 ? 0 : i + 1));
      if (key.return && acIndex < acOptions.length) { setInput(acOptions[acIndex].cmd + ' '); setAcOptions([]); }
      if (key.escape) setAcOptions([]);
    } else if (!running) {
      if (key.upArrow) {
        const hist = inputHistoryRef.current;
        if (!hist.length) return;
        if (historyIdxRef.current === -1) savedInputRef.current = input;
        const next = Math.min(historyIdxRef.current + 1, hist.length - 1);
        historyIdxRef.current = next;
        setInput(hist[hist.length - 1 - next] ?? '');
      }
      if (key.downArrow) {
        if (historyIdxRef.current === -1) return;
        const next = historyIdxRef.current - 1;
        historyIdxRef.current = next;
        setInput(next < 0 ? savedInputRef.current : (inputHistoryRef.current[inputHistoryRef.current.length - 1 - next] ?? ''));
        if (next < 0) historyIdxRef.current = -1;
      }
    }
  });

  const PIPELINE_CMDS = new Set(['/fix', '/refactor', '/test', '/generate', '/explain', '/docs', '/git', '/files', '/context', '/model']);

  function handleInputChange(val: string) {
    historyIdxRef.current = -1;
    setInput(val);
    if (val.startsWith('/')) {
      const m = val.toLowerCase();
      setAcOptions(BASE_COMMANDS.filter(c => c.cmd.startsWith(m)));
      setAcIndex(0);
    } else {
      setAcOptions([]);
    }
  }

  const handleSubmit = useCallback((raw: string) => {
    if (acOptions.length > 0) return;
    setInput(''); setAcOptions([]);
    const text = raw.trim();
    if (!text) return;

    inputHistoryRef.current.push(text);
    historyIdxRef.current = -1;
    savedInputRef.current = '';

    if (text.startsWith('@claude ')) {
      runClaude(text.slice(8).trim());
      return;
    }
    if (text.startsWith('/')) {
      const parts = text.split(' ');
      const cmd = parts[0]!.toLowerCase();
      if (PIPELINE_CMDS.has(cmd)) {
        if (parts.length < 2 || !parts.slice(1).join(' ').trim()) {
          log('warn', `Usage: ${cmd} <description of what to do>`);
          return;
        }
        log('user', text);
        appendHistory(text);
        setHistory(readHistory());
        runTask(text);
        return;
      }
      runSlash(cmd);
      return;
    }
    log('user', text);
    appendHistory(text);
    setHistory(readHistory());
    runTask(text);
  }, [acOptions, running, cfg]);

  function runSlash(cmd: string) {
    log('user', cmd);
    switch (cmd) {
      case '/help':
        log('heading', 'Commands');
        log('sep', '');
        BASE_COMMANDS.forEach(c => log('plain', `${c.cmd.padEnd(14)}${c.desc}`));
        log('plain', '');
        log('heading', 'Keyboard');
        log('sep', '');
        [['Ctrl+Q', 'Quit'], ['Ctrl+L', 'Clear'], ['Ctrl+C', 'Interrupt']].forEach(([k, d]) => log('plain', `${k!.padEnd(14)}${d}`));
        break;
      case '/clear':
        clear();
        setMetrics(null);
        try { fs.unlinkSync(path.join(cwd, 'repo_map.json')); log('success', 'Cleared local repo map & memory'); } catch { log('success', 'Cleared memory (no map found)'); }
        break;
      case '/config': setMode('config'); break;
      case '/agents': setMode('agents'); break;
      case '/cc':
        log('tool', 'Launching Claude Code…');
        setTimeout(() => process.exit(42), 300);
        break;
      case '/exit':
      case '/quit': exit(); break;
      default: log('error', `Unknown: ${cmd}`);
    }
  }

  function spawnProc(args: string[], env: NodeJS.ProcessEnv) {
    setRunning(true);
    const child = spawn(args[0]!, args.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.current = child as unknown as ChildProcessWithoutNullStreams;
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const m = parseMetrics(l);
        if (m) { setMetrics(m); continue; }
        const { type, text } = classifyLine(l);
        if (type !== 'plain' || text) log(type, text);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      chunk.toString().split('\n').forEach(l => { if (l.trim()) log('dim', l.trim()); });
    });
    child.on('exit', code => {
      if (buf.trim()) { const m = parseMetrics(buf); if (!m) { const { type, text } = classifyLine(buf); log(type, text); } }
      proc.current = null;
      setRunning(false);
      if (code === 0) log('sep', '');
      else if (code !== null) log('dim', `exited ${code}`);
    });
  }

  function runClaude(query: string) {
    if (running) { log('warn', 'Already running'); return; }
    log('tool', `claude · "${query.slice(0, 70)}"`);
    spawnProc([cfg.claude_cmd, '-p', query, '--output-format', 'text'],
      { ...process.env });
  }

  function runTask(task: string) {
    if (running) { log('warn', 'Already running'); return; }
    spawnProc(['python3', path.join(BASE_DIR, 'codemaster.py'), '--root', cwd, task], {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHON_COLORS: '0',
      COLUMNS: '100',
      CM_MAX_FILES: String(cfg.max_files), CM_MAX_FNS: String(cfg.max_fns),
      CM_MAX_DEBUG: String(cfg.max_debug), CM_CLAUDE_CMD: String(cfg.claude_cmd),
    });
  }

  const shortCwd = cwd.startsWith(os.homedir()) ? '~' + cwd.slice(os.homedir().length) : cwd;

  if (mode === 'config') {
    return (
      <Box flexDirection="column" width="100%">
        <ConfigEditor
          cfg={cfg}
          onSave={c => { writeConfig(c); setCfg(c); setMode('normal'); log('success', 'Config saved'); }}
          onCancel={() => setMode('normal')}
        />
        <StatusBar running={false} cwd={cwd} />
      </Box>
    );
  }

  if (mode === 'agents') {
    return (
      <Box flexDirection="column" width="100%">
        <AgentBrowser onClose={() => setMode('normal')} log={log} />
        <StatusBar running={false} cwd={cwd} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <Header shortCwd={shortCwd} recent={history.slice(-4).reverse()} />
      <MetricsBar metrics={metrics} cfg={cfg} />
      <MessageList logs={logs} />
      {running && <Spinner label="Running…" />}
      {!running && acOptions.length > 0 && <Autocomplete options={acOptions} selectedIndex={acIndex} />}
      <InputArea value={input} onChange={handleInputChange} onSubmit={handleSubmit} active={!running} placeholder="Type a task or /help" />
      <StatusBar running={running} cwd={cwd} />
    </Box>
  );
}

render(<App />);
