import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { Writable } from 'node:stream';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { MessageList, Transcript, estimateRows } from '../../src/components/MessageList.js';
import { HeaderBar } from '../../src/components/Header.js';
import { Activity, StatusBar } from '../../src/components/Activity.js';
import { EMPTY_LOGS, logReducer, type LogState } from '../../src/util/parser.js';
import type { LogEntry } from '../../src/util/parser.js';

class Fake extends Writable {
  columns: number;
  rows: number = 200;
  isTTY = true;
  buf = '';
  constructor(cols: number) {
    super();
    this.columns = cols;
  }
  _write(c: unknown, _e: unknown, cb: () => void) {
    this.buf += String(c);
    cb();
  }
}

const END = '\u00a7END';
const ANCHOR: LogEntry = { id: 900, type: 'tool', text: 'anchor' };

async function draw(entries: LogEntry[], cols: number, expanded: boolean): Promise<string[]> {
  const out = new Fake(cols);
  const inst = render(
    // Ink ends a frame with a newline and then paints whatever follows, so the
    // tail of the output is ambiguous — a component's own bottom margin looks
    // exactly like the terminator. A known last row makes the boundary exact.
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Transcript, { entries, expanded }),
      React.createElement(Transcript, { entries: [{ id: 999, type: 'plain', text: END }], expanded }),
    ),
    { stdout: out as never, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 50));
  inst.unmount();
  const lines = stripAnsi(out.buf).split('\n');
  const end = lines.findIndex((l) => l.includes(END));
  assert.ok(end >= 0, 'sentinel row missing from rendered output');
  return lines.slice(0, end);
}

const CASES: Array<[string, LogEntry]> = [
  ['user', { id: 2, type: 'user', text: '/ask how do I run the game?' }],
  ['tool', { id: 3, type: 'tool', text: 'Asker — selecting files' }],
  ['result', { id: 4, type: 'result', text: '18,357 tokens' }],
  ['success', { id: 5, type: 'success', text: 'Task completed (47.2s, 78,712 tokens)' }],
  ['warn', { id: 6, type: 'warn', text: 'Applied, but unverified: no relevant existing tests.' }],
  ['error', { id: 7, type: 'error', text: 'Provider anthropic failed: rate limited' }],
  ['heading', { id: 8, type: 'heading', text: 'Answer' }],
  ['sep', { id: 9, type: 'sep', text: 'Implement tic-tac-toe game logic' }],
  ['md blank', { id: 10, type: 'md', text: '' }],
  ['md heading', { id: 11, type: 'md', text: '## Caveat' }],
  ['md short', { id: 12, type: 'md', text: 'Open `index.html` in a browser.' }],
  ['md long', { id: 13, type: 'md', text: '**Short answer:** Open `index.html` in a browser — this is a plain, build-free HTML5/canvas project with no bundler and no package.json anywhere in the tree.' }],
  ['dim', { id: 14, type: 'dim', text: '18.4k tokens · nothing was written.' }],
];

const REASONING: LogEntry = {
  id: 20,
  type: 'reasoning',
  text: 'decision  Serve statically; no build step exists in this stack',
  detail: 'script.js is a self-invoking function loaded by a plain <script> tag.\nNo package.json, no bundler, no import/export statements anywhere.',
};

test('no rendered line exceeds the terminal width', async () => {
  const all = [...CASES.map(([, e]) => e), REASONING];
  for (const cols of [30, 40, 52, 60, 70, 80, 100, 120]) {
    for (const expanded of [false, true]) {
      for (const line of await draw(all, cols, expanded)) {
        const w = stringWidth(line.replace(/\s+$/, ''));
        assert.ok(w <= cols, `${w} > ${cols} (expanded=${expanded}): ${JSON.stringify(line)}`);
      }
    }
  }
});

const baseRows = new Map<string, number>();

async function rowsOf(entry: LogEntry, cols: number, expanded: boolean): Promise<number> {
  const key = `${cols}:${expanded}`;
  let base = baseRows.get(key);
  if (base === undefined) {
    base = (await draw([ANCHOR], cols, expanded)).length;
    baseRows.set(key, base);
  }
  return (await draw([ANCHOR, entry], cols, expanded)).length - base;
}

const WIDTHS = [40, 60, 80, 120];

// The viewport chooses how many entries fit by asking estimateRows how tall
// each one is. If the estimate drifts from what Ink actually draws, the frame
// overruns the window and the terminal scrolls by a row — which is the exact
// drift the pinning exists to remove.
test('estimateRows matches the rendered height of every log type', async () => {
  for (const cols of WIDTHS) {
    for (const [name, entry] of CASES) {
      const drawn = await rowsOf(entry, cols, false);
      assert.equal(estimateRows(entry, cols, false), drawn, `${name} at ${cols} cols`);
    }
  }
});

test('estimateRows matches folded and expanded reasoning', async () => {
  for (const cols of WIDTHS) {
    for (const expanded of [false, true]) {
      const drawn = await rowsOf(REASONING, cols, expanded);
      assert.equal(estimateRows(REASONING, cols, expanded), drawn, `reasoning at ${cols}, expanded=${expanded}`);
    }
  }
});

/** Render just the viewport, with no sentinel: its whole contract is that it is
 *  exactly `height` rows tall whatever it is given. */
async function viewport(entries: LogEntry[], cols: number, height: number, scroll: number): Promise<string[]> {
  const out = new Fake(cols);
  const inst = render(
    React.createElement(MessageList, { settled: entries, live: [], expanded: false, height, scroll }),
    { stdout: out as never, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 50));
  inst.unmount();
  const lines = stripAnsi(out.buf).split('\n');
  // Ink terminates the frame with a newline; that is not a row of the frame.
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

test('the viewport is exactly its given height, empty or overfull', async () => {
  const many: LogEntry[] = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, type: 'tool', text: `step ${i}` }));
  for (const cols of [40, 80, 120]) {
    for (const height of [3, 10, 24]) {
      for (const [label, entries] of [['empty', []], ['one', [ANCHOR]], ['overfull', many]] as Array<[string, LogEntry[]]>) {
        const lines = await viewport(entries, cols, height, 0);
        assert.equal(lines.length, height, `${label} at ${cols}x${height}`);
      }
    }
  }
});

test('the viewport keeps the newest line and scrolling reaches the oldest', async () => {
  const many: LogEntry[] = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, type: 'tool', text: `step ${i}` }));
  const bottom = await viewport(many, 80, 10, 0);
  assert.ok(bottom.at(-1)!.includes('step 59'), `newest line missing: ${JSON.stringify(bottom.at(-1))}`);
  const top = await viewport(many, 80, 10, 55);
  assert.ok(top.join('\n').includes('step 0'), 'scrolling back never reaches the first line');
  const mid = await viewport(many, 80, 10, 20);
  assert.ok(mid.join('\n').includes('earlier line'), 'no indication that lines are hidden above');
  assert.equal(mid.length, 10, 'the hidden-above notice must come out of the budget, not add to it');
});

/** Everything Ink still redraws every frame, at one width. A row wider than
 *  the window wraps, and a wrapped live region tears as it repaints. */
async function liveRows(cols: number, running: boolean): Promise<string[]> {
  const out = new Fake(cols);
  const status = {
    id: 's', status: 'running', taskN: 1, taskTotal: 4,
    tokens: 152_000, tokenBudget: 200_000, cost: 0.31, provider: 'claude-opus-4-8',
  };
  const usage = { model: 'claude-opus-4-8', windowTokens: 152_000, blockedMs: 900_000, spend: 1.17 };
  const steps: LogEntry[] = [
    { id: 1, type: 'tool', text: 'FileSelector — 7 files · 2.1k tok', at: Date.now() - 3000 },
    { id: 2, type: 'result', text: 'ContextCompiler  2,757 tokens from 7 files', at: Date.now() - 5000 },
    { id: 3, type: 'tool', text: 'Solver — calling claude-opus-4-8', at: Date.now() - 12_000 },
  ];
  const inst = render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(HeaderBar, { shortCwd: '~/Codemaster', version: '1.0.0', title: running ? 'Fix configuration precedence between file and flags' : '', cols }),
      running
        ? React.createElement(Activity, {
            phase: 'Solving' as const,
            phaseStart: Date.now() - 47_000,
            phaseDone: { Planning: 12 },
            steps,
            status,
            taskTitle: 'Fix configuration precedence between file and flags',
          })
        : null,
      React.createElement(StatusBar, { shortCwd: '~/Codemaster', usage, status, running, since: Date.now() - 47_000 }),
    ),
    { stdout: out as never, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 50));
  inst.unmount();
  return stripAnsi(out.buf).split('\n');
}

test('no live-region line exceeds the terminal width', async () => {
  for (const cols of [30, 40, 60, 80, 120]) {
    for (const running of [true, false]) {
      for (const line of await liveRows(cols, running)) {
        const w = stringWidth(line.replace(/\s+$/, ''));
        assert.ok(w <= cols, `${w} > ${cols} (running=${running}): ${JSON.stringify(line)}`);
      }
    }
  }
});

// An entry's id is its React key in the viewport and its identity in the
// scroll arithmetic. Rewriting an earlier slot makes Ink reuse the wrong node,
// and a reused id makes two different lines the same line — both silent, and
// both only once a session has run long enough to hit the bound.
test('settled lines are append-only and never reuse an id', async () => {
  const TYPES: LogEntry['type'][] = ['md', 'tool', 'result', 'reasoning', 'success', 'dim', 'sep', 'heading'];
  let state: LogState = EMPTY_LOGS;
  const seen = new Set<number>();
  let prev: LogEntry[] = [];
  for (let i = 0; i < 3000; i++) {
    state = logReducer(state, { type: 'add', entry: { type: TYPES[i % TYPES.length]!, text: `line ${i}` } });
    assert.ok(state.settled.length >= prev.length, `settled shrank at ${i}`);
    for (let j = 0; j < prev.length; j++) assert.equal(state.settled[j], prev[j], `settled[${j}] rewritten at ${i}`);
    for (const e of state.settled.slice(prev.length)) {
      assert.ok(!seen.has(e.id), `id ${e.id} reused at ${i}`);
      seen.add(e.id);
    }
    prev = state.settled;
  }
  assert.ok(state.settled.length > 1000, `too few settled lines: ${state.settled.length}`);
  // The live region is the only thing that is allowed to be bounded.
  assert.ok(state.live.length <= 40, `live region unbounded: ${state.live.length}`);
});

