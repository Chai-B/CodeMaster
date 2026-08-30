#!/usr/bin/env node
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, measureElement, render, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import os from 'os';
import { createRequire } from 'module';

import { HeaderBar } from './components/Header.js';
import { MessageList, totalRows } from './components/MessageList.js';
import { Activity, StatusBar } from './components/Activity.js';
import { Autocomplete, type Cmd } from './components/Autocomplete.js';
import { Prompt } from './components/Prompt.js';
import { EMPTY_LOGS, eventToLog, logReducer, type LogType, type SessionStatusView, type UsageView } from './util/parser.js';
import { BLUE, BLUE_HI, BLUE_DIM, AMBER } from './themes/blue.js';

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
/** Ink recalculates its own layout on a resize, but nothing tells React, so a
 *  component that reads `stdout.columns` keeps rendering the old number — the
 *  rule under the header stayed its old width until the next keystroke. This
 *  subscribes, so a resize is a state change like any other. */
function useSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => ({ cols: Math.max(28, stdout?.columns ?? 80), rows: Math.max(8, (stdout?.rows ?? 24) - 1) });
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (!stdout) return;
    const on = () => setSize(read());
    stdout.on('resize', on);
    on();
    return () => { stdout.off('resize', on); };
  }, [stdout]);
  return size;
}

function useCols(): number {
  return useSize().cols;
}

/** One row short of the window on purpose. Filling the last row means something
 *  writes one past it and the terminal scrolls by one — and on the alternate
 *  screen there is no scrollback to scroll into, so the top row is what is
 *  lost. That top row is the header. */
function useRows(): number {
  return useSize().rows;
}

/** A framed prompt, the way every terminal agent draws one. The old input was
 *  a rule above and a rule below a bare line, which read as two separators with
 *  something trapped between them rather than as a box you type into. */
function InputArea({
  value, onChange, onSubmit, running, ghost, queued, focus, placeholder, resetKey,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  running: boolean;
  ghost: string;
  queued: number;
  /** Bumped when a keystroke is swallowed rather than typed. ink-text-input
   *  keeps its own cursor offset and only re-clamps it when the value prop
   *  changes, so a swallowed key leaves the offset one past the end, where it
   *  clamps to zero on the next character — after `?` or ctrl+r, typing
   *  `/help` produced `help/`. Remounting puts the cursor back at the end. */
  resetKey: number;
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
        <TextInput key={resetKey} value={value} onChange={onChange} onSubmit={onSubmit} focus={focus} showCursor placeholder={placeholder} />
        {/* The rest of the only command that still matches, greyed in place —
            tab takes it. Guessing at a name and reading /help are both slower. */}
        {ghost ? <Text color={BLUE_DIM}>{ghost}</Text> : null}
      </Box>
    </Box>
  );
}

/** What the keyboard does. Every line here has to be true: the last two builds
 *  each advertised a scroll binding that had stopped working, which is worse
 *  than advertising none. */
const SHORTCUTS: Array<[string, string]> = [
  ['enter', 'send'],
  ['tab', 'complete the highlighted command'],
  ['\u2191 \u2193', 'previous commands (ctrl+p / ctrl+n too)'],
  ['wheel', 'scroll the transcript'],
  ['pgup pgdn', 'scroll a page'],
  ['shift+\u2191\u2193', 'scroll three lines'],
  ['esc', 'back to the newest line, or interrupt the running task'],
  ['ctrl+r', 'print every piece of reasoning so far'],
  ['ctrl+l', 'clear the transcript'],
  ['ctrl+c', 'stop the task, or quit when idle'],
  ['ctrl+q', 'quit'],
  ['?', 'this list'],
  ['shift+drag', 'select text (option or fn on macOS Terminal, alt in VS Code)'],
];

/** SGR mouse reports. The wheel is the only reason the mouse is claimed at all,
 *  but claiming it means every report lands in stdin, so these bytes have to be
 *  kept out of the composer and out of Ink's key parser. The escape is optional
 *  because Ink strips one leading ESC before the composer ever sees the chunk,
 *  so the first report of a burst arrives as `[<64;…M` and the rest keep theirs. */
const MOUSE = /\x1b?\[<(\d+);\d+;\d+[Mm]/g;

/** Rows per wheel notch. Three is what terminals send for their own scrolling. */
const WHEEL_ROWS = 3;

const KEY_COL = 13;

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
  const [expanded, setExpanded] = useState(false);
  const { stdout } = useStdout();
  const { stdin, setRawMode } = useStdin();
  const { cols, rows } = useSize();

  // The whole interface is one frame exactly as tall as the window, drawn on
  // the alternate screen. That page has no scroll region of its own, which is
  // the point: the header is row one and the status bar is the last row, and
  // rows cannot scroll away from themselves. It is also why the wheel has to be
  // claimed below — the terminal has nothing of its own left to scroll.
  useEffect(() => {
    if (!stdout?.isTTY) return;
    const leave = () => {
      try { stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l'); } catch { /* stream already gone */ }
    };
    stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h');
    process.on('exit', leave);
    return () => { process.off('exit', leave); leave(); };
  }, [stdout]);

  // How far back the transcript is scrolled, counted in rows up from the newest.
  const [scroll, setScroll] = useState(0);
  // The transcript's real height, asked of the layout rather than added up from
  // what the header, the activity panel, the prompt form, the composer and the
  // status bar each claim to draw. Those six numbers drifted out of step every
  // time one of the components changed.
  const viewRef = useRef(null);
  const [viewH, setViewH] = useState(10);
  // Ink only writes when its output changes. Coming back from a vendor's own
  // interface the state is identical but the page underneath is blank, so the
  // frame has to be forced out again.
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  // Remount counter for the composer, bumped whenever a keystroke reaches it
  // but is swallowed here instead of typed.
  const [inputKey, resetInput] = useReducer((n: number) => n + 1, 0);

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
  const cwd = process.cwd();
  const shortCwd = cwd.startsWith(os.homedir()) ? '~' + cwd.slice(os.homedir().length) : cwd;

  // Raw stdin, read ahead of Ink's own parser so both flags are set before any
  // handler sees the chunk.
  //
  // `ctrlKeyRef` — ink-text-input passes ctrl combinations straight through to
  // the field, so ctrl+r would do what it does *and* type an "r". A lone C0
  // byte that is not enter, tab or escape can only be ctrl and a letter.
  //
  // `mouseRef` — a claimed mouse puts its reports in stdin. Every report starts
  // with ESC, so without this flag Ink would read a wheel notch as the escape
  // key and cancel the running task.
  const ctrlKeyRef = useRef(false);
  const mouseRef = useRef(false);
  const maxScrollRef = useRef(0);
  useEffect(() => {
    const onData = (d: Buffer | string) => {
      const b = d.toString();
      ctrlKeyRef.current = b.length === 1 && b < ' ' && b !== '\r' && b !== '\n' && b !== '\t' && b !== '\x1b';
      MOUSE.lastIndex = 0;
      let delta = 0;
      let seen = false;
      for (let m = MOUSE.exec(b); m; m = MOUSE.exec(b)) {
        seen = true;
        // 64 is a notch away from you, 65 towards you. Every other button —
        // clicks, drags, the ones a terminal sends while shift is held — is
        // read and dropped, which is what keeps them out of the composer.
        if (m[1] === '64') delta += WHEEL_ROWS;
        else if (m[1] === '65') delta -= WHEEL_ROWS;
      }
      mouseRef.current = seen;
      if (delta !== 0) setScroll((v) => Math.max(0, Math.min(maxScrollRef.current, v + delta)));
    };
    process.stdin.prependListener('data', onData);
    return () => { process.stdin.off('data', onData); };
  }, []);

  const log = useCallback((type: LogType, text: string) => dispatch({ type: 'add', entry: { type, text } }), []);

  // Subscribe to the event bus once.
  useEffect(() => {
    const off = bus.onAny((ev) => {
      const entry = eventToLog(ev);
      if (entry && (entry.type !== 'plain' || entry.text)) dispatch({ type: 'add', entry });
      setStatus(computeStatus());
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

  // A vendor's own sign-in draws its own interface, opens a browser and reads
  // its own keys, so it gets the whole terminal: the alternate page released,
  // the mouse given back, stdin out of raw mode. What it prints belongs in the
  // real scrollback, not on a page that is about to be thrown away. Taking the
  // page back afterwards leaves it blank, so Ink is asked to repaint.
  useEffect(() => {
    setSuspender(async (run) => {
      if (!stdout?.isTTY) return await run();
      const wasRaw = stdin?.isRaw ?? false;
      if (wasRaw) setRawMode(false);
      stdin?.pause();
      stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l');
      try {
        return await run();
      } finally {
        stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h');
        stdin?.resume();
        if (wasRaw) setRawMode(true);
        repaint();
      }
    });
    return () => setSuspender(null);
  }, [stdout, stdin, setRawMode, repaint]);

  useInput((c, key) => {
    // The chunk this "key" came from was a mouse report, already handled by the
    // raw reader above. Ink parses one key per chunk, and a report begins with
    // ESC — without this a wheel notch would read as escape and cancel the run.
    if (mouseRef.current) return;

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

    if (key.ctrl && c === 'q') { exit(); return; }
    if (key.ctrl && c === 'l') { dispatch({ type: 'clear' }); setScroll(0); return; }
    // Unfolds every future line, and prints what was already reasoned as a
    // fresh block rather than re-rendering lines that may be scrolled out of
    // sight. Reasoning is paid for whether or not it is read.
    if (key.ctrl && c === 'r') {
      setExpanded((v) => !v);
      const seen = logs.settled.filter((e) => e.type === 'reasoning');
      if (!seen.length) log('dim', 'No reasoning recorded yet.');
      else {
        log('heading', `Reasoning · ${seen.length}`);
        for (const e of seen) dispatch({ type: 'add', entry: { type: 'reasoning', text: e.text, detail: e.detail } });
      }
      return;
    }

    // Aliases, for hands that already know them from a shell.
    if (key.ctrl && c === 'p') { prevHistory(); return; }
    if (key.ctrl && c === 'n') { nextHistory(); return; }

    // Ctrl-C stops the running task and keeps the session; with nothing
    // running there is nothing to stop, so it leaves.
    if (key.ctrl && c === 'c') { if (!cancelActive()) exit(); return; }

    // The transcript is a viewport, so it has its own scroll. The wheel is
    // handled in the raw reader; these are for hands already on the keyboard.
    // The arrows are plain recall — shift is what makes them scroll.
    const page = Math.max(1, viewH - 2);
    if (key.pageUp) { setScroll((v) => Math.min(maxScroll, v + page)); return; }
    if (key.pageDown) { setScroll((v) => Math.max(0, v - page)); return; }
    if (key.shift && key.upArrow) { setScroll((v) => Math.min(maxScroll, v + WHEEL_ROWS)); return; }
    if (key.shift && key.downArrow) { setScroll((v) => Math.max(0, v - WHEEL_ROWS)); return; }

    // Esc means "put me back". Scrolled away from the newest line that is where
    // you want to be; otherwise it stops the running task — not the process, so
    // the session and everything on disk survive.
    if (key.escape && scroll > 0) { setScroll(0); return; }
    if (key.escape && running) { cancelActive(); return; }

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
    // Recall, and nothing else. Scrolling has the wheel, shift and the page
    // keys, so the arrows stay unambiguous however long the output runs.
    if (key.upArrow) prevHistory();
    if (key.downArrow) nextHistory();
  }, { isActive: !prompt });

  function handleChange(val: string) {
    if (ctrlKeyRef.current) { resetInput(); return; }
    // ink-text-input treats a multi-byte chunk as a paste, so a wheel notch
    // would otherwise type `[<64;33;12M` into the prompt.
    if (mouseRef.current) { val = val.replace(MOUSE, ''); if (val === input) { resetInput(); return; } }
    historyIdxRef.current = -1;
    // Typing is a request to see what you are typing.
    if (scroll > 0) setScroll(0);
    // `?` alone is a question about the prompt itself; inside a sentence it is
    // just a question mark. Handled here rather than as a key binding because
    // the composer takes the keystroke either way — intercepting it upstream
    // printed the list and left the `?` sitting in the input.
    if (val === '?' && !running) {
      log('heading', 'Keys');
      for (const [k, what] of SHORTCUTS) log('dim', `  ${k.padEnd(KEY_COL)}${what}`);
      setInput('');
      setAcOptions([]);
      resetInput();
      return;
    }
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

  // What the task bar is counting: the last rule the run drew is the task it
  // is inside. It is also what the header shows on its right, so the top row
  // says what is being worked on rather than repeating the path below.
  const taskTitle = [...logs.settled].reverse().find((e) => e.type === 'sep')?.text ?? '';

  // Measuring every entry is a pass over the whole transcript, so it is done
  // once per event rather than once per keystroke.
  const maxScroll = useMemo(
    () => Math.max(0, totalRows([...logs.settled, ...logs.live], cols, expanded) - viewH),
    [logs.settled, logs.live, cols, expanded, viewH],
  );
  // A resize can shrink the range under a scroll already set.
  const clamped = Math.min(scroll, maxScroll);

  // Scroll counts rows up from the bottom, so a line arriving while the reader
  // is scrolled back would slide the passage they are reading off the top.
  const totalRef = useRef(0);
  useEffect(() => {
    const grown = maxScroll - totalRef.current;
    totalRef.current = maxScroll;
    if (grown > 0) setScroll((v) => (v > 0 ? v + grown : 0));
  }, [maxScroll]);
  maxScrollRef.current = maxScroll;

  // Asked of the layout after it settles, not added up from what each piece of
  // chrome claims to draw. No dependency array on purpose: it re-measures every
  // render and the equality guard stops the loop.
  useEffect(() => {
    const h = viewRef.current ? measureElement(viewRef.current).height : 0;
    if (h > 0 && h !== viewH) setViewH(h);
  });

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <HeaderBar version={VERSION} shortCwd={shortCwd} title={taskTitle} cols={cols} />

      {/* The only part of the frame that scrolls. `flexGrow` hands it whatever
          the header and the footer below did not take, however tall those are
          on this frame. */}
      <Box ref={viewRef} flexGrow={1} flexShrink={1} overflow="hidden">
        <MessageList settled={logs.settled} live={logs.live} expanded={expanded} height={viewH} scroll={clamped} />
      </Box>

      <Box flexShrink={0} flexDirection="column">
        {running && !prompt && (
          <Activity
            phase={logs.phase}
            phaseStart={logs.phaseStart || startedAt}
            phaseDone={logs.phaseDone}
            steps={logs.live}
            status={status}
            taskTitle={taskTitle}
          />
        )}
        {acOptions.length > 0 && !prompt && <Autocomplete options={acOptions} selectedIndex={acIndex} />}
        {prompt && (
          <Prompt
            spec={prompt.spec}
            onDone={(r) => { setPrompt(null); prompt.resolve(r); }}
          />
        )}
        <InputArea value={input} onChange={handleChange} onSubmit={handleSubmit} running={running} ghost={ghost} queued={queued} focus={!prompt} placeholder="/new <objective> or /help" resetKey={inputKey} />
        <StatusBar shortCwd={shortCwd} usage={usage} status={status} running={running} since={startedAt} />
      </Box>
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
