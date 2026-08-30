import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { Writable } from 'node:stream';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { Transcript } from '../../src/components/MessageList.js';
import { Banner } from '../../src/components/Header.js';
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
      React.createElement(Banner, { shortCwd: '~/Codemaster', version: '1.0.0' }),
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

// `<Static>` prints each item once and never looks at it again, so the settled
// array may only ever grow at the end. Trimming its front, or reusing an id,
// makes Ink reprint the whole transcript from wherever the change landed —
// silently, and only once a session has run long enough to hit the bound.
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

