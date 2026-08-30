#!/usr/bin/env node
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import os from 'os';
import { createRequire } from 'module';

import { Header, headerRows } from './components/Header.js';
import { MessageList, totalRows } from './components/MessageList.js';
import { Autocomplete, type Cmd } from './components/Autocomplete.js';
import { Prompt, promptRows } from './components/Prompt.js';
import { eventToLog, phaseOf, type LogEntry, type LogType, type Phase, type SessionStatusView, type UsageView } from './util/parser.js';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED, AMBER, BRAILLE, VERBS } from './themes/blue.js';

import { bus } from './events/bus.js';
import { cancelActive } from './util/cancel.js';
import { Daemon } from './daemon/daemon.js';
import { COMMANDS } from './commands/catalog.js';
import { Sessions, Tasks } from './storage/sessions.js';
import { staticAnalysis } from './analysis/api.js';
import { Tokens } from './storage/tokens.js';
import { QuotaLedger } from './providers/quotaLedger.js';
import { setPrompter, type PromptSpec, type PromptResult } from './ui/prompt.js';
import { setSuspender } from './ui/terminal.js';

const require_ = createRequire(import.meta.url);
const VERSION = (require_('../package.json') as { version: string }).version;
const AC_COMMANDS: Cmd[] = COMMANDS.map((c) => ({ cmd: c.cmd, desc: c.desc }));

process.env.CODEMASTER_TUI = '1';
const daemon = new Daemon();
const sm = daemon.sm;
const router = daemon.router;

// ── Log state ───────────────────────────────────────────────────────────────
// Two regions, not one list. `settled` is the transcript proper; `live` is the
// phase currently running. When a phase ends it collapses to a single result
// line and moves across, so a finished run reads as a few lines rather than
// every line the workers emitted.
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

/** Lines that are the run's output rather than a note about its progress.
 *  These never enter the live region, so a phase ending can never take them
 *  with it — the answer, the reasoning and the verdict stay on screen while
 *  "FileSelector — 7 files" does not. */
const KEEP = new Set<LogType>(['md', 'reasoning', 'heading', 'success', 'error', 'warn', 'sep', 'user']);

/** What a finished phase leaves behind: how long it took and how many steps it
 *  took to get there. Only progress lines are ever in `live`, so this discards
 *  nothing a reader would want back. */
function collapse(state: LogState): LogEntry[] {
  const n = state.live.length;
  if (!state.phase || n === 0) return [];
  const secs = Math.max(0, Math.round((Date.now() - state.phaseStart) / 1000));
  return [{ id: ++_id, type: 'dim', text: `${state.phase} · ${n} step${n === 1 ? '' : 's'} · ${secs}s` }];
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

  // A phase boundary settles whatever the outgoing phase left running.
  const turned = phase !== state.phase;
  const flushed = turned ? collapse(state) : [];
  const live = turned ? [] : state.live;

  // Verbose settles everything, which is what /verbose is for. Otherwise a line
  // settles if it is output and stays live if it is progress.
  const settle = state.verbose || !phase || KEEP.has(entry.type);
  const settled = settle
    ? [...state.settled, ...flushed, entry]
    : [...state.settled, ...flushed];
  return {
    ...state,
    phase,
    phaseStart: turned ? Date.now() : state.phaseStart,
    settled: settled.slice(-2000),
    live: settle ? live : [...live, entry].slice(-40),
  };
}

function computeUsage(): UsageView {
  let windowTokens = 0;
  let blockedMs = 0;
  try {
    for (const q of QuotaLedger.all()) {
      windowTokens += q.tokens_used;
      const until = Math.max(
        q.rate_limited_until ? Date.parse(q.rate_limited_until) : 0,
        q.cooldown_until ? Date.parse(q.cooldown_until) : 0,
      );
      blockedMs = Math.max(blockedMs, until - Date.now());
    }
  } catch {
    /* an unreadable quota table must not stop the interface from drawing */
  }
  return {
    model: sm.getCurrent()?.current_provider?.model_id ?? sm.cfg.providers.default,
    windowTokens,
    blockedMs: Math.max(0, blockedMs),
    spend: Tokens.grandTotal().cost,
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
    cost: tok.cost,
    provider: s.current_provider?.model_id ?? sm.cfg.providers.default,
    lastCheckpoint: s.latest_checkpoint?.slice(0, 12),
  };
}

// ── Mini components ───────────────────────────────────────────────────────────
/** One line that updates in place, replacing the repeated "still working — 15s
 *  elapsed" lines that used to accumulate one per poll.
 *
 *  The word changes as well as the frame. A single frozen label for three
 *  minutes reads as a hang; a spinner that is visibly thinking about something
 *  reads as work. Tokens tick up beside it, so the cost of waiting is legible
 *  while you are waiting rather than only afterwards. */
function useCols(): number {
  const { stdout } = useStdout();
  return Math.max(28, stdout?.columns ?? 80);
}

/** Rows the frame may occupy: one fewer than the window has.
 *
 *  Ink terminates every frame with a newline, so a frame as tall as the window
 *  writes one line past the last row and the terminal scrolls by one. In the
 *  alternate screen there is no scrollback to scroll into, so the top row is
 *  simply lost — and it comes back on the next repaint, which reads as the
 *  whole interface twitching. One row of slack costs nothing and removes it. */
function useRows(): number {
  const { stdout } = useStdout();
  return Math.max(8, (stdout?.rows ?? 24) - 1);
}

function Spinner({ label, since, tokens }: { label: string; since: number; tokens: number }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((i) => i + 1), 90);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
  const verb = VERBS[Math.floor(f / 44) % VERBS.length];
  const tok = tokens > 0 ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : '';
  const cols = useCols();
  return (
    <Box marginTop={1} width={cols}>
      <Text color={BLUE_HI} bold>{' '}{BRAILLE[f % BRAILLE.length]}{'  '}</Text>
      <Box width={cols - 4}>
        <Text wrap="truncate-end">
          <Text color={BLUE_HI}>{label === 'working' ? verb : label}…</Text>
          <Text color={MUTED}>{`  ${secs}s${tok} · esc to interrupt`}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/** A framed prompt, the way every terminal agent draws one. The old input was
 *  a rule above and a rule below a bare line, which read as two separators with
 *  something trapped between them rather than as a box you type into. */
function InputArea({
  value, onChange, onSubmit, running, ghost, queued, focus, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  running: boolean;
  ghost: string;
  queued: number;
  /** Off while a command is asking something: two focused fields would both
   *  take the keystroke. */
  focus: boolean;
  placeholder?: string;
}) {
  return (
    <Box flexDirection="column">
      {queued > 0 && (
        <Box paddingX={1}>
          <Text color={AMBER}>{`  ${queued} line${queued > 1 ? 's' : ''} waiting`}</Text>
        </Box>
      )}
      {/* The frame changes colour with what the tool is doing, so the state of
          the run is visible at the place you are already looking. */}
      <Box borderStyle="round" borderColor={running ? AMBER : BLUE} paddingX={1}>
        <Text bold color={running ? AMBER : BLUE_HI}>{'❯ '}</Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus={focus} showCursor placeholder={placeholder} />
        {/* The rest of the only command that still matches, greyed in place —
            tab takes it. Guessing at a name and reading /help are both slower. */}
        {ghost ? <Text color={BLUE_DIM}>{ghost}</Text> : null}
      </Box>
    </Box>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['enter', 'send'],
  ['tab', 'complete'],
  ['↑ ↓', 'scroll transcript · history when there is none'],
  ['ctrl+p/n', 'history'],
  ['esc', 'interrupt'],
  ['wheel', 'scroll transcript'],
  ['drag', 'select and copy, with the terminal'],
  ['shift+↑↓', 'scroll three lines'],
  ['pgup pgdn', 'scroll a page'],
  ['ctrl+r', 'expand reasoning'],
  ['ctrl+l', 'clear'],
  ['ctrl+q', 'quit'],
];

/** An SGR mouse report: ESC [ < button ; col ; row M|m. Ink strips the ESC
 *  before it reaches a text field, so the pattern must not require it. */
const MOUSE = /\x1b?\[<(\d+);\d+;\d+[Mm]/g;

/** Rows per wheel notch. Three is what terminals send for their own scrolling. */
const WHEEL_ROWS = 3;

const KEY_COL = 11;

function Shortcuts() {
  const cols = useCols();
  const desc = Math.max(6, cols - 4 - KEY_COL);
  return (
    <Box flexDirection="column" paddingX={2} marginTop={1}>
      {SHORTCUTS.map(([k, d]) => (
        <Box key={k} width={cols - 4}>
          <Text color={BLUE_HI}>{k.padEnd(KEY_COL)}</Text>
          <Box width={desc}><Text color={MUTED} wrap="truncate-end">{d}</Text></Box>
        </Box>
      ))}
    </Box>
  );
}

/** One dim line under the prompt. It used to repeat the provider and task count
 *  that the header already shows, and spend the rest of its width listing two
 *  keybindings; the hint now changes with what you can actually do next. */
function StatusBar({ running, status, expanded, help, since }: {
  running: boolean; status: SessionStatusView | null; expanded: boolean; help: boolean; since: number;
}) {
  // Re-rendered once a second while running so the elapsed time is live rather
  // than frozen at whatever it was when the last event happened to arrive.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  const hint = help
    ? 'esc to close'
    : running
      ? `running ${Math.round((Date.now() - since) / 1000)}s · type to queue · esc to interrupt`
      : status
        ? `${status.status} · ? for shortcuts`
        : '? for shortcuts · /help for commands';
  const cols = useCols();
  const right = `${expanded ? 'reasoning shown · ' : ''}v${VERSION}`;
  // The version is dropped rather than wrapped when the hint needs the room;
  // a status bar that becomes two rows unpins everything above it.
  const room = cols - 2 - right.length >= 12;
  return (
    <Box paddingX={1} width={cols}>
      <Box width={room ? cols - 2 - right.length : cols - 2}>
        <Text color={BLUE_DIM} wrap="truncate-end">{hint}</Text>
      </Box>
      {room && <Text color={BLUE_DIM}>{right}</Text>}
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
  // Clearing the log state is not enough on its own: the alternate screen
  // still holds the last frame until something repaints over it.
  const [expanded, setExpanded] = useState(false);
  const [help, setHelp] = useState(false);
  const [scroll, setScroll] = useState(0);
  const { stdout } = useStdout();
  const { stdin, setRawMode } = useStdin();
  // Bumped after another program has had the terminal: the alternate screen we
  // come back to is empty and nothing else would ask Ink to draw the frame again.
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const rows = useRows();
  const cols = useCols();

  // The alternate screen buffer is what makes the header and the composer stay
  // put: the interface gets its own page, with no scrollback of its own, so the
  // only thing that can move is what this frame chooses to redraw. Without it
  // every line CodeMaster prints joins the shell's scroll region and drags the
  // prompt along with it.
  //
  // That page having no scrollback is also why the wheel needs handling at all:
  // the terminal has nothing of its own to scroll. The app used to claim the
  // mouse for that (SGR reporting, `?1000h` + `?1006h`), and the cost was the
  // thing a terminal is for — with the mouse claimed, dragging selects nothing
  // and there is no way to copy a line of output. Alternate scroll (`?1007h`)
  // buys the wheel back without taking the mouse: the terminal itself turns a
  // wheel notch into cursor keys while the alternate screen is up, so selection
  // and copy keep working and the wheel arrives as ↑/↓ below.
  useEffect(() => {
    if (!stdout?.isTTY) return;
    stdout.write('\x1b[?1049h\x1b[?1007h\x1b[H');
    const leave = () => {
      try { stdout.write('\x1b[?1007l\x1b[?1049l'); } catch { /* stream already gone */ }
    };
    process.once('exit', leave);
    return () => {
      process.off('exit', leave);
      leave();
    };
  }, [stdout]);

  useEffect(() => {
    if (logs.clearGen > 0) stdout?.write('\x1b[2J\x1b[3J\x1b[H');
  }, [logs.clearGen, stdout]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [status, setStatus] = useState<SessionStatusView | null>(null);
  const [usage, setUsage] = useState<UsageView>(computeUsage);
  const [acOptions, setAcOptions] = useState<Cmd[]>([]);
  // A question a command is waiting on. Nothing else has the keyboard while one
  // is up: the composer loses focus and the global bindings stand down.
  const [prompt, setPrompt] = useState<{ spec: PromptSpec; resolve: (r: PromptResult | null) => void } | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState(0);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  /** Set by the raw stdin reader: the chunk being parsed was a wheel notch. */
  const wheelRef = useRef(false);
  const maxScrollRef = useRef(0);
  const cwd = process.cwd();
  const shortCwd = cwd.startsWith(os.homedir()) ? '~' + cwd.slice(os.homedir().length) : cwd;

  const log = useCallback((type: LogType, text: string) => dispatch({ type: 'add', entry: { type, text } }), []);

  // Subscribe to the event bus once.
  useEffect(() => {
    const off = bus.onAny((ev) => {
      const entry = eventToLog(ev);
      if (entry && (entry.type !== 'plain' || entry.text)) dispatch({ type: 'add', entry });
      setStatus(computeStatus());
    setUsage(computeUsage());
      setUsage(computeUsage());
    });
    if (firstRunHere(cwd)) {
      // Nothing has been indexed and nothing has been run here, so the generic
      // one-liner would leave a new user with no idea what order to do things
      // in. Three lines, in the order they actually need to happen.
      log('dim', 'First run in this repository. Run /setup — it asks three questions and does the rest.');
      log('dim', 'Or type / to browse every command, arrows to pick, tab to take it.');
    } else {
      log('dim', 'Persistent reasoning OS. /new <objective> to begin, /help for commands.');
    }
    if (!sm.manager.hasAnyProvider())
      log('warn', 'No provider credentials — run /setup to add one. Deterministic commands still work.');
    void daemon.start().then(({ incomplete, reaped, plugins }) => {
      if (plugins > 0) log('dim', `${plugins} plugin(s) loaded.`);
      if (reaped > 0) log('dim', `${reaped} abandoned session(s) closed.`);
      if (incomplete > 0) log('warn', `${incomplete} incomplete session(s) detected — run /recover to restore.`);
    });
    setStatus(computeStatus());
    setUsage(computeUsage());
    return () => {
      void daemon.stop();
      off();
    };
  }, [log]);

  // Commands ask through a module-level hook rather than a channel: the router
  // runs in this process. Headless and MCP runs never install one, so every
  // command keeps the non-interactive path it had.
  useEffect(() => {
    setPrompter((spec) => new Promise((resolve) => setPrompt({ spec, resolve })));
    return () => setPrompter(null);
  }, []);

  // A vendor's own sign-in draws its own interface and reads its own keys, so
  // it gets the terminal: off the alternate screen, out of raw mode, stdin
  // released. Everything is put back afterwards and the frame is repainted,
  // because the page we return to is blank and Ink only writes what changed.
  useEffect(() => {
    setSuspender(async (run) => {
      if (!stdout?.isTTY) return await run();
      const wasRaw = stdin?.isRaw ?? false;
      stdout.write('\x1b[?1007l\x1b[?1049l');
      if (wasRaw) setRawMode(false);
      stdin?.pause();
      try {
        return await run();
      } finally {
        stdin?.resume();
        if (wasRaw) setRawMode(true);
        stdout.write('\x1b[?1049h\x1b[?1007h\x1b[2J\x1b[H');
        repaint();
      }
    });
    return () => setSuspender(null);
  }, [stdout, stdin, setRawMode, repaint]);

  useInput((c, key) => {
    // The chunk this key came from was a wheel notch, already handled as
    // scrolling by the raw reader below. Ink parses one key per chunk, so
    // dropping it here drops the whole notch.
    if (wheelRef.current) return;

    const prevHistory = () => {
      const hist = inputHistoryRef.current;
      if (!hist.length) return;
      const next = Math.min(historyIdxRef.current + 1, hist.length - 1);
      historyIdxRef.current = next;
      setInput(hist[hist.length - 1 - next] ?? '');
    };
    const nextHistory = () => {
      if (historyIdxRef.current <= 0) { historyIdxRef.current = -1; setInput(''); return; }
      historyIdxRef.current -= 1;
      const hist = inputHistoryRef.current;
      setInput(hist[hist.length - 1 - historyIdxRef.current] ?? '');
    };

    if (key.ctrl && c === 'q') exit();
    if (key.ctrl && c === 'l') dispatch({ type: 'clear' });
    // Reasoning is folded away by default and this unfolds it, everywhere at
    // once — a settled line cannot expand on its own, so the whole transcript
    // repaints.
    if (key.ctrl && c === 'r') { setExpanded((v) => !v); return; }
    // `?` on an empty prompt is a question about the prompt itself; typed into
    // a sentence it is just a question mark.
    if (c === '?' && !input && !running) { setHelp((v) => !v); return; }
    if (key.escape && help) { setHelp(false); return; }

    // History has keys of its own because the arrows now belong to the wheel:
    // alternate scroll delivers a notch as ↑/↓, so those cannot also be recall
    // once anything has scrolled off the top.
    if (key.ctrl && c === 'p') { prevHistory(); return; }
    if (key.ctrl && c === 'n') { nextHistory(); return; }

    // The transcript is a viewport, so it needs its own scroll. Shift and the
    // page keys move the window; bare arrows do too, below, when there is
    // anything to move.
    const page = Math.max(1, viewportRows - 1);
    if (key.pageUp) { setScroll((v) => Math.min(maxScroll, v + page)); return; }
    if (key.pageDown) { setScroll((v) => Math.max(0, v - page)); return; }
    if (key.shift && key.upArrow) { setScroll((v) => Math.min(maxScroll, v + WHEEL_ROWS)); return; }
    if (key.shift && key.downArrow) { setScroll((v) => Math.max(0, v - WHEEL_ROWS)); return; }
    // Ctrl-C stops the running task and keeps the session; with nothing
    // running there is nothing to stop, so it leaves.
    if (key.ctrl && c === 'c') { if (!cancelActive()) exit(); return; }
    // Esc is what people reach for to stop a running thing. It stops the task,
    // not the process — the session and everything on disk survive. Interrupting
    // outranks returning to the bottom, which has the page keys as its own way out.
    if (key.escape && running) { cancelActive(); return; }
    if (key.escape && scroll > 0) { setScroll(0); return; }

    if (acOptions.length > 0) {
      if (key.upArrow) setAcIndex((i) => (i <= 0 ? acOptions.length - 1 : i - 1));
      if (key.downArrow) setAcIndex((i) => (i >= acOptions.length - 1 ? 0 : i + 1));
      if (key.tab) {
        const sel = acOptions[acIndex];
        if (sel) { setInput(sel.cmd + ' '); setAcOptions([]); }
      }
      if (key.escape) setAcOptions([]);
      return;
    }
    // Recall, always. Scrolling belongs to the wheel, shift-arrows and the page
    // keys; it no longer takes the arrows away once the output runs long.
    if (key.upArrow) prevHistory();
    if (key.downArrow) nextHistory();
  }, { isActive: !prompt });

  function handleChange(val: string) {
    historyIdxRef.current = -1;
    // Ink hands an unrecognised escape sequence to the focused field as text,
    // so a wheel event would otherwise type `[<64;33;12M` into the prompt.
    val = val.replace(MOUSE, '');
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
      // A menu open over a command already typed in full is just decoration:
      // Enter runs it. Enter on a partial word still completes it instead.
      const typed = raw.trim().toLowerCase();
      if (acOptions.length > 0 && !acOptions.some((o) => o.cmd === typed)) {
        const sel = acOptions[acIndex];
        if (sel) setInput(sel.cmd + ' ');
        setAcOptions([]);
        return;
      }
      const text = raw.trim();
      setInput('');
      // setInput does not run handleChange, so without this the menu outlived
      // the command that was picked from it.
      setAcOptions([]);
      if (!text) return;
      // A run in progress does not block the prompt; the line waits its turn
      // and the count of waiting lines is shown above the composer.
      if (running) {
        queueRef.current.push(text);
        setQueued(queueRef.current.length);
        return;
      }

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
        setStatus(computeStatus());
    setUsage(computeUsage());
      setUsage(computeUsage());
        const next = queueRef.current.shift();
        setQueued(queueRef.current.length);
        setRunning(false);
        if (next) void submitRef.current?.(next);
      }
    },
    [acOptions, acIndex, running, exit, log],
  );
  // The queue drains by re-entering the same handler, which cannot reference
  // itself directly in its own dependency list.
  const submitRef = useRef<((s: string) => Promise<void>) | null>(null);
  submitRef.current = handleSubmit;

  const ghost = acOptions.length === 1 && acOptions[0]!.cmd.startsWith(input)
    ? acOptions[0]!.cmd.slice(input.length)
    : '';

  // Everything below the transcript is drawn at a height that can be counted
  // ahead of time, and the transcript is given whatever is left. This is the
  // whole of the pinning: the frame is exactly as tall as the window, so there
  // is no row for the composer to be pushed onto.
  const chrome =
    headerRows(cols, rows, !!status) +
    (running ? 2 : 0) + // spinner, with its top margin
    (help ? 1 + SHORTCUTS.length : 0) +
    (acOptions.length > 0 && !prompt ? Math.min(acOptions.length, 8) + (acOptions.length > 8 ? 1 : 0) : 0) +
    (prompt ? promptRows(prompt.spec) : 0) +
    (queued > 0 ? 1 : 0) +
    3 + // the framed prompt
    1; // status bar
  const viewportRows = Math.max(1, rows - chrome);
  const maxScroll = Math.max(0, totalRows([...logs.settled, ...logs.live], cols, expanded) - viewportRows);
  // Content arriving while scrolled back must not push the view past its own
  // top, and a window resize can shrink the range under a scroll already set.
  const clamped = Math.min(scroll, maxScroll);

  // Scroll counts rows up from the bottom, so a line arriving while the reader
  // is scrolled back would slide the passage they are reading off the top.
  // Growth is added to the offset instead, which holds the view where it is.
  const totalRef = useRef(0);
  useEffect(() => {
    const grown = maxScroll - totalRef.current;
    totalRef.current = maxScroll;
    if (grown > 0) setScroll((v) => (v > 0 ? v + grown : 0));
  }, [maxScroll]);

  // The wheel and the arrow keys arrive as the same bytes: alternate-scroll
  // mode — which is what keeps mouse selection working — turns a notch into
  // several ↑ or ↓ sequences. The transcript used to take the arrows for that,
  // leaving command recall on ctrl-p/ctrl-n. They are told apart by the read
  // that delivered them: a notch is one chunk carrying several sequences, a
  // keypress is one chunk carrying one. Nothing is timed and nothing is guessed.
  maxScrollRef.current = maxScroll;
  useEffect(() => {
    const onData = (data: Buffer | string) => {
      const seq = data.toString();
      const up = seq.match(/\x1b\[A/g)?.length ?? 0;
      const down = seq.match(/\x1b\[B/g)?.length ?? 0;
      wheelRef.current = up + down >= 2;
      if (!wheelRef.current) return;
      const delta = up - down;
      setScroll((v) => Math.max(0, Math.min(maxScrollRef.current, v + delta)));
    };
    // Ahead of Ink's own reader, so the flag is set before it parses the chunk.
    process.stdin.prependListener('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, []);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header shortCwd={shortCwd} version={VERSION} session={status} usage={usage} />
      <MessageList settled={logs.settled} live={logs.live} expanded={expanded} height={viewportRows} scroll={clamped} />
      {running && !prompt && <Spinner label={logs.phase ?? 'working'} since={startedAt} tokens={status?.tokens ?? 0} />}
      {help && <Shortcuts />}
      {acOptions.length > 0 && !prompt && <Autocomplete options={acOptions} selectedIndex={acIndex} />}
      {prompt && (
        <Prompt
          spec={prompt.spec}
          onDone={(r) => { setPrompt(null); prompt.resolve(r); }}
        />
      )}
      <InputArea value={input} onChange={handleChange} onSubmit={handleSubmit} running={running} ghost={ghost} queued={queued} focus={!prompt} placeholder="/new <objective> or /help" />
      <StatusBar running={running} status={status} expanded={expanded} help={help} since={startedAt} />
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
