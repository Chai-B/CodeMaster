#!/usr/bin/env tsx
import React, { useState, useReducer, useCallback, useEffect, useRef } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { Autocomplete, type Cmd } from './components/Autocomplete.js';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED, BRAILLE } from './themes/blue.js';
import { parseMetrics, classifyLine, isDiffLine, extractDiffLine, type LogEntry, type Metrics } from './utils/parser.js';

// ── paths ────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const AGENTS_DIR = path.join(BASE_DIR, 'agents');
const HISTORY_PATH = path.join(BASE_DIR, 'activity_history.json');
const INPUT_HISTORY_PATH = path.join(BASE_DIR, '.input_history.json');
const VERSION = '1.0.0';

// ── config ───────────────────────────────────────────────────────────────────
interface Config {
  max_files: number;
  max_fns: number;
  max_debug: number;
  claude_cmd: string;
  [key: string]: string | number;
}

const CONFIG_SCHEMA = [
  { key: 'max_files', label: 'Max files per context', type: 'number' },
  { key: 'max_fns',   label: 'Max functions per file', type: 'number' },
  { key: 'max_debug', label: 'Max debug cycles',       type: 'number' },
  { key: 'claude_cmd', label: 'Claude CLI command',    type: 'string' },
];

function readConfig(): Config {
  try {
    return { max_files: 3, max_fns: 3, max_debug: 2, claude_cmd: 'claude',
             ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch { return { max_files: 3, max_fns: 3, max_debug: 2, claude_cmd: 'claude' }; }
}

function writeConfig(cfg: Config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── activity history (recent tasks shown in header) ──────────────────────────
interface HistoryEntry { task: string; time: string }

function readHistory(): HistoryEntry[] {
  try { const d = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

function appendHistory(task: string) {
  const entries = readHistory();
  const n = new Date();
  const time = `${String(n.getMonth()+1).padStart(2,'0')}/${String(n.getDate()).padStart(2,'0')} ${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`;
  entries.push({ task: task.slice(0, 55), time });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries.slice(-20), null, 2));
}

// ── persistent input history (↑↓ like a real terminal) ───────────────────────
function loadInputHistory(): string[] {
  try { const d = JSON.parse(fs.readFileSync(INPUT_HISTORY_PATH, 'utf8')); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

function saveInputHistory(items: string[]) {
  fs.writeFileSync(INPUT_HISTORY_PATH, JSON.stringify(items.slice(-100), null, 2));
}

// ── log reducer ──────────────────────────────────────────────────────────────
let _id = 0;
function logReducer(state: LogEntry[], action: { type: 'add'; entry: Omit<LogEntry, 'id'> } | { type: 'clear' }): LogEntry[] {
  if (action.type === 'clear') return [];
  return [...state, { ...action.entry, id: ++_id }];
}

// ── agents ───────────────────────────────────────────────────────────────────
function listAgents(): string[] {
  try { return fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')); }
  catch { return []; }
}

// ── commands ─────────────────────────────────────────────────────────────────
const PIPELINE_CMDS = new Set(['/fix', '/refactor', '/feature', '/generate', '/test', '/docs', '/explain']);

const BASE_COMMANDS: Cmd[] = [
  { cmd: '/fix',       desc: 'Fix a bug in code' },
  { cmd: '/refactor',  desc: 'Refactor code (runs planner first)' },
  { cmd: '/feature',   desc: 'Implement a new feature (runs planner first)' },
  { cmd: '/generate',  desc: 'Generate new code or files' },
  { cmd: '/test',      desc: 'Write or fix tests' },
  { cmd: '/docs',      desc: 'Generate documentation' },
  { cmd: '/explain',   desc: 'Explain code' },
  { cmd: '/run',       desc: 'Run a shell command in the project directory' },
  { cmd: '/git',       desc: 'Run a git command in the project directory' },
  { cmd: '/diff',      desc: 'Show current git diff (uncommitted changes)' },
  { cmd: '/scan',      desc: 'Index current project for search' },
  { cmd: '/config',    desc: 'Edit pipeline parameters' },
  { cmd: '/prompts',   desc: 'Edit agent prompt templates' },
  { cmd: '/status',    desc: 'Show session metrics & context' },
  { cmd: '/cost',      desc: 'Show token usage & estimated cost' },
  { cmd: '/model',     desc: 'Show current Claude model info' },
  { cmd: '/clear',     desc: 'Clear the log' },
  { cmd: '/clearall',  desc: 'Clear log, metrics, context & maps' },
  { cmd: '/cc',        desc: 'Open Claude Code (returns here on exit)' },
  { cmd: '/help',      desc: 'Show all commands' },
  { cmd: '/quit',      desc: 'Exit CodeMaster' },
];

// ── mini components ──────────────────────────────────────────────────────────
function Spinner({ label }: { label: string }) {
  const [f, setF] = useState(0);
  useEffect(() => { const t = setInterval(() => setF(i => (i+1) % BRAILLE.length), 80); return () => clearInterval(t); }, []);
  return <Box marginLeft={2} marginY={1}><Text color={BLUE_HI} bold>{BRAILLE[f]} {label}</Text></Box>;
}

function MetricsBar({ metrics, cfg, elapsed, running }: { metrics: Metrics | null; cfg: Config; elapsed: number; running: boolean }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const wide = cols >= 100;
  const displayTime = running ? elapsed : (metrics?.elapsed ?? 0);
  const cost = metrics ? (metrics.total_tokens * 0.000003) : 0;
  return (
    <Box borderStyle="single" borderTop={false} borderBottom borderLeft={false} borderRight={false} borderColor={BLUE_DIM} paddingX={2} justifyContent="space-between">
      <Box gap={wide ? 3 : 2}>
        <Text color={MUTED}>files <Text color={BLUE_HI}>{cfg.max_files}</Text></Text>
        <Text color={MUTED}>fns <Text color={BLUE_HI}>{cfg.max_fns}</Text></Text>
        <Text color={MUTED}>debug <Text color={BLUE_HI}>{cfg.max_debug}</Text></Text>
      </Box>
      <Box gap={wide ? 3 : 2}>
        {metrics || running ? (<>
          <Text color={MUTED}>calls <Text color={BLUE_HI}>{metrics?.calls ?? 0}</Text></Text>
          <Text color={MUTED}>tokens <Text color="#E8B86D">{(metrics?.total_tokens ?? 0).toLocaleString()}</Text></Text>
          <Text color={MUTED}>cost <Text color="#E8B86D">${cost.toFixed(4)}</Text></Text>
          <Text color={MUTED}><Text color={running ? BLUE_HI : MUTED}>{displayTime.toFixed(1)}s</Text></Text>
        </>) : (
          <Text color={MUTED}>no activity yet</Text>
        )}
      </Box>
    </Box>
  );
}

function InputArea({ value, onChange, onSubmit, active, placeholder }: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void;
  active: boolean; placeholder?: string;
}) {
  return (
    <Box borderStyle="single" borderTop borderBottom borderLeft={false} borderRight={false} borderColor={active ? BLUE_HI : BLUE_DIM} paddingX={1}>
      <Text bold color={active ? BLUE_HI : MUTED}>❯ </Text>
      {active
        ? <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus showCursor placeholder={placeholder} />
        : <Text color={MUTED}>{placeholder ?? ''}</Text>
      }
    </Box>
  );
}

function StatusBar({ running, cwd, metrics, elapsed }: { running: boolean; cwd: string; metrics: Metrics | null; elapsed: number }) {
  const tokens = metrics ? `${metrics.total_tokens.toLocaleString()} tokens` : '';
  const hasMap = fs.existsSync(path.join(cwd, 'repo_map.json'));
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text color={MUTED} dimColor>
        {running
          ? `►► running ${elapsed.toFixed(0)}s  ·  Ctrl+C interrupt`
          : 'ready  ·  Ctrl+Q quit  ·  ↑↓ history  ·  / commands'}
      </Text>
      <Text color={MUTED} dimColor>
        {tokens ? `${tokens}  ·  ` : ''}codemaster v{VERSION}  ·  {path.basename(cwd)}{hasMap ? '' : ' [no map]'}
      </Text>
    </Box>
  );
}

// ── config editor ────────────────────────────────────────────────────────────
function ConfigEditor({ cfg, onSave, onCancel }: {
  cfg: Config; onSave: (c: Config) => void; onCancel: () => void;
}) {
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');

  useInput((ch, key) => {
    if (editing) {
      if (key.return) {
        const schema = CONFIG_SCHEMA[sel]!;
        const updated = { ...cfg };
        updated[schema.key] = schema.type === 'number' ? Number(editVal) || cfg[schema.key] : editVal;
        onSave(updated);
        setEditing(false);
      }
      if (key.escape) { setEditing(false); }
      return;
    }
    if (key.upArrow) setSel(i => Math.max(0, i - 1));
    if (key.downArrow) setSel(i => Math.min(CONFIG_SCHEMA.length - 1, i + 1));
    if (key.return) { setEditing(true); setEditVal(String(cfg[CONFIG_SCHEMA[sel]!.key])); }
    if (key.escape) onCancel();
    if (key.ctrl && ch === 's') onSave(cfg);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BLUE_HI} marginX={1} marginY={1} paddingX={2} paddingY={1}>
      <Text bold color={BLUE_HI}>Configuration</Text>
      <Text color={BLUE_DIM}>{'─'.repeat(40)}</Text>
      {CONFIG_SCHEMA.map((s, i) => (
        <Box key={s.key}>
          <Text color={i === sel ? BLUE_HI : MUTED} bold={i === sel}>
            {i === sel ? '❯ ' : '  '}{s.label.padEnd(24)}
          </Text>
          {editing && i === sel
            ? <TextInput value={editVal} onChange={setEditVal} onSubmit={() => {
                const updated = { ...cfg };
                updated[s.key] = s.type === 'number' ? Number(editVal) || cfg[s.key] : editVal;
                onSave(updated);
                setEditing(false);
              }} focus showCursor />
            : <Text color={BLUE_HI}>{String(cfg[s.key])}</Text>
          }
        </Box>
      ))}
      <Text> </Text>
      <Text color={MUTED}>↑↓ navigate  ·  Enter edit  ·  Ctrl+S save  ·  Esc back</Text>
    </Box>
  );
}

// ── agent browser ────────────────────────────────────────────────────────────
function AgentBrowser({ onClose, log }: { onClose: () => void; log: (type: LogEntry['type'], text: string) => void }) {
  const agents = listAgents();
  const [sel, setSel] = useState(0);

  useInput((_ch, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) setSel(i => Math.max(0, i - 1));
    if (key.downArrow) setSel(i => Math.min(agents.length - 1, i + 1));
    if (key.return && agents[sel]) {
      const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'nano';
      const agentPath = path.join(AGENTS_DIR, agents[sel]!);
      log('tool', `Opening ${agents[sel]} in ${editor}…`);
      const child = spawn(editor, [agentPath], { stdio: 'inherit' });
      child.on('exit', () => onClose());
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BLUE_HI} marginX={1} marginY={1} paddingX={2} paddingY={1}>
      <Text bold color={BLUE_HI}>Agent Prompts</Text>
      <Text color={BLUE_DIM}>{'─'.repeat(40)}</Text>
      <Text color={MUTED}>Edit the markdown templates Claude receives for each stage.</Text>
      <Text> </Text>
      {agents.length === 0
        ? <Text color={MUTED}>No agent files in agents/</Text>
        : agents.map((a, i) => (
          <Box key={a}>
            <Text color={i === sel ? BLUE_HI : MUTED} bold={i === sel}>
              {i === sel ? '❯ ' : '  '}{a.replace('.md','').padEnd(16)}
            </Text>
            <Text color={MUTED}>
              {a.includes('planner') ? 'Task decomposition'
               : a.includes('coder') ? 'Diff generation'
               : a.includes('reviewer') ? 'Patch review'
               : a.includes('patcher') ? 'Issue fixing'
               : ''}
            </Text>
          </Box>
        ))
      }
      <Text> </Text>
      <Text color={MUTED}>↑↓ navigate  ·  Enter open in $EDITOR  ·  Esc back</Text>
    </Box>
  );
}

// ── main app ─────────────────────────────────────────────────────────────────
function App() {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<Config>(readConfig);
  const [history, setHistory] = useState<HistoryEntry[]>(readHistory);
  const [logs, dispatch] = useReducer(logReducer, [] as LogEntry[]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [lastDiff, setLastDiff] = useState('');
  const [acOptions, setAcOptions] = useState<Cmd[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [mode, setMode] = useState<'normal' | 'config' | 'agents'>('normal');
  const [elapsed, setElapsed] = useState(0);
  const proc = useRef<ChildProcessWithoutNullStreams | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputHistoryRef = useRef<string[]>(loadInputHistory());
  const historyIdxRef   = useRef(-1);
  const savedInputRef   = useRef('');
  const cwd = process.cwd();
  const home = process.env['HOME'] || '/';
  const shortCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;

  // ── helpers ──────────────────────────────────────────────────────────────
  const log = useCallback((type: LogEntry['type'], text: string) => {
    dispatch({ type: 'add', entry: { type, text } });
  }, []);

  const clear = useCallback(() => dispatch({ type: 'clear' }), []);

  // ── real-time elapsed timer ─────────────────────────────────────────────
  useEffect(() => {
    if (running) {
      const start = Date.now();
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((Date.now() - start) / 1000), 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running]);

  // ── auto-scan on startup if no repo map ──────────────────────────────────
  useEffect(() => {
    if (!fs.existsSync(path.join(cwd, 'repo_map.json'))) {
      log('dim', 'No repo map found — scanning project…');
      // Defer slightly so the TUI renders first
      setTimeout(() => runScan(), 100);
    }
  }, []);

  // ── process spawning ─────────────────────────────────────────────────────
  function spawnProc(args: string[], env: NodeJS.ProcessEnv) {
    setRunning(true);
    const child = spawn(args[0]!, args.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.current = child as unknown as ChildProcessWithoutNullStreams;
    let buf = '';
    let diffBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const m = parseMetrics(l);
        if (m) { setMetrics(m); continue; }
        // capture diff lines silently (CM_DIFF: protocol)
        if (isDiffLine(l)) {
          diffBuf += extractDiffLine(l) + '\n';
          continue;
        }
        const { type, text } = classifyLine(l);
        if (type !== 'plain' || text) log(type, text);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      chunk.toString().split('\n').forEach(l => { if (l.trim()) log('dim', l.trim()); });
    });

    child.on('exit', code => {
      if (buf.trim()) {
        const m = parseMetrics(buf);
        if (!m) { const { type, text } = classifyLine(buf); log(type, text); }
        else setMetrics(m);
      }
      if (diffBuf) setLastDiff(diffBuf);
      proc.current = null;
      setRunning(false);
      if (code === 0) log('sep', '');
      else if (code !== null) log('dim', `exited ${code}`);
    });
  }

  // ── claude direct call ────────────────────────────────────────────────────
  function runClaude(query: string) {
    if (running) { log('warn', 'Already running'); return; }
    log('tool', `claude · "${query.slice(0, 70)}"`);
    const claudeEnv = { ...process.env };
    for (const key of Object.keys(claudeEnv)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_')) delete claudeEnv[key];
    }
    spawnProc([cfg.claude_cmd, '-p', query, '--output-format', 'text'], claudeEnv);
  }

  // ── task execution ────────────────────────────────────────────────────────
  function runTask(task: string) {
    if (running) { log('warn', 'Already running'); return; }
    spawnProc(['python3', path.join(BASE_DIR, 'codemaster.py'), '--root', cwd, task], {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHON_COLORS: '0',
      COLUMNS: String(process.stdout.columns || 100),
      CM_MAX_FILES: String(cfg.max_files),
      CM_MAX_FNS: String(cfg.max_fns),
      CM_MAX_DEBUG: String(cfg.max_debug),
      CM_CLAUDE_CMD: String(cfg.claude_cmd),
    });
  }

  // ── repo scan ─────────────────────────────────────────────────────────────
  function runScan() {
    if (running) { log('warn', 'Already running'); return; }
    log('tool', `Scanning ${shortCwd}…`);
    spawnProc(['python3', path.join(BASE_DIR, 'pipeline', 'repo_builder.py'), '--root', cwd], {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    });
  }

  // ── slash commands ────────────────────────────────────────────────────────
  function runSlash(cmd: string, rest: string) {
    log('user', cmd + (rest ? ' ' + rest : ''));
    switch (cmd) {
      case '/help':
        log('step', 'Pipeline Commands');
        BASE_COMMANDS.filter(c => PIPELINE_CMDS.has(c.cmd)).forEach(c => log('nested', `${c.cmd.padEnd(14)}${c.desc}`));
        log('step', 'Shell & Git');
        ['/run', '/git', '/diff', '/scan'].forEach(cmd => {
          const c = BASE_COMMANDS.find(b => b.cmd === cmd);
          if (c) log('nested', `${c.cmd.padEnd(14)}${c.desc}`);
        });
        log('step', 'Claude Code');
        ['/cc', '/model', '/cost', '/status'].forEach(cmd => {
          const c = BASE_COMMANDS.find(b => b.cmd === cmd);
          if (c) log('nested', `${c.cmd.padEnd(14)}${c.desc}`);
        });
        log('step', 'TUI');
        ['/config', '/prompts', '/clear', '/clearall', '/help', '/quit'].forEach(cmd => {
          const c = BASE_COMMANDS.find(b => b.cmd === cmd);
          if (c) log('nested', `${c.cmd.padEnd(14)}${c.desc}`);
        });
        log('step', 'Keyboard');
        log('nested', 'Ctrl+Q        Quit');
        log('nested', 'Ctrl+L        Clear log');
        log('nested', 'Ctrl+C        Interrupt running task');
        log('nested', '↑ / ↓         Browse input history');
        log('nested', 'Tab / Enter   Autocomplete command');
        log('step', 'Direct Claude');
        log('nested', '@claude <q>   Ask Claude a question (no file changes)');
        break;

      case '/clear':
        clear();
        log('success', 'Log cleared');
        break;

      case '/clearall':
        clear();
        setMetrics(null);
        setLastDiff('');
        try { fs.unlinkSync(path.join(cwd, 'repo_map.json')); } catch {}
        log('success', 'Cleared log, metrics, context & repo maps');
        break;

      case '/config':
        setMode('config');
        break;

      case '/prompts':
        setMode('agents');
        break;

      case '/status': {
        log('step', 'Session Status');
        log('nested', `Working dir:    ${cwd}`);
        log('nested', `Claude CLI:     ${cfg.claude_cmd}`);
        log('nested', `Max files:      ${cfg.max_files}`);
        log('nested', `Max functions:  ${cfg.max_fns}`);
        log('nested', `Max debug:      ${cfg.max_debug}`);
        if (metrics) {
          log('step', 'Metrics');
          log('nested', `API calls:      ${metrics.calls}`);
          log('nested', `Total tokens:   ${metrics.total_tokens.toLocaleString()}`);
          log('nested', `Avg context:    ${metrics.avg_context.toLocaleString()} tokens`);
          log('nested', `Elapsed:        ${metrics.elapsed.toFixed(1)}s`);
          log('nested', `Est. cost:      $${(metrics.total_tokens * 0.000003).toFixed(4)}`);
        } else {
          log('dim', 'No API calls made yet this session');
        }
        break;
      }

      case '/cost': {
        if (!metrics) { log('dim', 'No API calls made yet'); break; }
        log('step', 'Token Usage');
        log('nested', `Total tokens:   ${metrics.total_tokens.toLocaleString()}`);
        log('nested', `API calls:      ${metrics.calls}`);
        log('nested', `Avg context:    ${metrics.avg_context.toLocaleString()} tokens`);
        log('nested', `Est. cost:      $${(metrics.total_tokens * 0.000003).toFixed(4)}`);
        break;
      }

      case '/model': {
        log('step', 'Model Info');
        log('tool', `Querying ${cfg.claude_cmd}…`);
        try {
          const r = spawnSync(cfg.claude_cmd, ['-p', 'What model are you? Reply with just your model ID.', '--output-format', 'text', '--tools', ''], {
            timeout: 15000, encoding: 'utf8'
          });
          const model = (r.stdout || '').trim();
          if (model) {
            log('success', `Model: ${model}`);
          } else {
            log('dim', 'Could not determine model');
          }
        } catch {
          log('error', 'Failed to query Claude CLI');
        }
        break;
      }

      case '/run': {
        if (!rest) { log('warn', 'Usage: /run <command>'); break; }
        log('tool', `$ ${rest}`);
        spawnProc(['sh', '-c', rest], { ...process.env });
        break;
      }

      case '/git': {
        if (!rest) { log('warn', 'Usage: /git <command>  e.g. /git status'); break; }
        log('tool', `git ${rest}`);
        spawnProc(['sh', '-c', `git ${rest}`], { ...process.env });
        break;
      }

      case '/diff': {
        // Show live git diff — always reflects current actual state
        log('tool', 'git diff HEAD');
        spawnProc(['git', 'diff', 'HEAD'], { ...process.env });
        break;
      }

      case '/scan':
        runScan();
        break;

      case '/cc':
        log('tool', 'Launching Claude Code… (will return here on exit)');
        setTimeout(() => process.exit(42), 200);
        break;

      case '/exit':
      case '/quit':
      case '/q':
        exit();
        break;

      default:
        log('error', `Unknown command: ${cmd}  —  type /help`);
    }
  }

  // ── input handling ────────────────────────────────────────────────────────
  useInput((_c, key) => {
    if (mode !== 'normal') return;
    if (key.ctrl && _c === 'q') exit();
    if (key.ctrl && _c === 'l') { clear(); return; }
    if (key.ctrl && _c === 'c') {
      if (proc.current) {
        proc.current.kill('SIGTERM');
        log('warn', 'Interrupted');
      }
      return;
    }

    // autocomplete navigation
    if (acOptions.length > 0) {
      if (key.upArrow) { setAcIndex(i => (i <= 0 ? acOptions.length - 1 : i - 1)); return; }
      if (key.downArrow) { setAcIndex(i => (i >= acOptions.length - 1 ? 0 : i + 1)); return; }
      if (key.escape) { setAcOptions([]); return; }
      // Tab also selects
      if (key.tab && acIndex < acOptions.length) {
        setInput(acOptions[acIndex]!.cmd + ' ');
        setAcOptions([]);
        return;
      }
      return;
    }

    // prompt history (↑↓) when no autocomplete
    if (!running) {
      if (key.upArrow) {
        const hist = inputHistoryRef.current;
        if (hist.length === 0) return;
        if (historyIdxRef.current === -1) savedInputRef.current = input;
        const next = historyIdxRef.current === -1 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
        historyIdxRef.current = next;
        setInput(hist[next] ?? '');
        return;
      }
      if (key.downArrow) {
        const hist = inputHistoryRef.current;
        if (historyIdxRef.current === -1) return;
        const next = historyIdxRef.current + 1;
        if (next >= hist.length) { historyIdxRef.current = -1; setInput(savedInputRef.current); }
        else { historyIdxRef.current = next; setInput(hist[next] ?? ''); }
        return;
      }
    }
  });

  function handleInputChange(val: string) {
    historyIdxRef.current = -1;
    setInput(val);
    if (val.startsWith('/') && !val.includes(' ')) {
      const m = val.toLowerCase();
      const matches = BASE_COMMANDS.filter(c => c.cmd.startsWith(m) && c.cmd !== m);
      setAcOptions(matches);
      setAcIndex(0);
    } else {
      setAcOptions([]);
    }
  }

  const handleSubmit = useCallback((raw: string) => {
    if (running) return;

    // if autocomplete is open, Enter selects the highlighted option
    if (acOptions.length > 0 && acIndex < acOptions.length) {
      const selected = acOptions[acIndex]!;
      setInput(selected.cmd + ' ');
      setAcOptions([]);
      return;
    }

    setInput('');
    setAcOptions([]);
    const text = raw.trim();
    if (!text) return;

    // persist to input history
    inputHistoryRef.current.push(text);
    saveInputHistory(inputHistoryRef.current);
    historyIdxRef.current = -1;
    savedInputRef.current = '';

    // direct claude call
    if (text.startsWith('@claude ')) {
      const q = text.slice(8).trim();
      if (!q) { log('warn', 'Usage: @claude <question>'); return; }
      runClaude(q);
      return;
    }

    // slash commands
    if (text.startsWith('/')) {
      const parts = text.split(' ');
      const cmd = parts[0]!.toLowerCase();
      const rest = parts.slice(1).join(' ').trim();

      if (PIPELINE_CMDS.has(cmd)) {
        if (!rest) {
          log('warn', `Usage: ${cmd} <description>`);
          return;
        }
        log('user', text);
        appendHistory(text);
        setHistory(readHistory());
        runTask(text);
        return;
      }
      runSlash(cmd, rest);
      return;
    }

    // plain task
    log('user', text);
    appendHistory(text);
    setHistory(readHistory());
    runTask(text);
  }, [acOptions, acIndex, running, cfg]);

  // ── render ────────────────────────────────────────────────────────────────
  if (mode === 'config') {
    return (
      <Box flexDirection="column" width="100%">
        <ConfigEditor
          cfg={cfg}
          onSave={c => { writeConfig(c); setCfg(c); setMode('normal'); log('success', 'Config saved'); }}
          onCancel={() => setMode('normal')}
        />
        <StatusBar running={false} cwd={cwd} metrics={metrics} elapsed={0} />
      </Box>
    );
  }

  if (mode === 'agents') {
    return (
      <Box flexDirection="column" width="100%">
        <AgentBrowser onClose={() => setMode('normal')} log={log} />
        <StatusBar running={false} cwd={cwd} metrics={metrics} elapsed={0} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <Header shortCwd={shortCwd} recent={history.slice(-4).reverse()} />
      <MetricsBar metrics={metrics} cfg={cfg} elapsed={elapsed} running={running} />
      <MessageList logs={logs} />
      {running && <Spinner label={`Running… ${elapsed.toFixed(0)}s`} />}
      {!running && acOptions.length > 0 && <Autocomplete options={acOptions} selectedIndex={acIndex} />}
      <InputArea value={input} onChange={handleInputChange} onSubmit={handleSubmit} active={!running} placeholder="Type a task or /help" />
      <StatusBar running={running} cwd={cwd} metrics={metrics} elapsed={elapsed} />
    </Box>
  );
}

render(<App />);
