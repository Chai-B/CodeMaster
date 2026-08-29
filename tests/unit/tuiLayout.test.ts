import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { Writable } from 'node:stream';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { MessageList, estimateRows } from '../../src/components/MessageList.js';
import type { LogEntry } from '../../src/util/parser.js';

class Fake extends Writable {
  columns: number;
  rows = 200;
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
    React.createElement(MessageList, {
      settled: entries,
      // Ink ends a frame with a newline and then paints the live region, so the
      // tail of the output is ambiguous — a component's own bottom margin looks
      // exactly like the terminator. A known live row makes the boundary exact.
      live: [{ id: 999, type: 'plain', text: END }],
      clearGen: 0,
      expanded,
    }),
    { stdout: out as never, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 50));
  inst.unmount();
  const lines = stripAnsi(out.buf).split('\n');
  const end = lines.findIndex((l) => l.includes(END));
  assert.ok(end >= 0, 'sentinel row missing from rendered output');
  return lines.slice(0, end);
}

/** Rows one entry adds to the transcript. Measured as a delta rather than in
 *  isolation: Ink discards a static frame that is entirely whitespace, so a
 *  blank line rendered alone vanishes even though it holds a row among
 *  neighbours — which is the only way it ever appears. */
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

const CASES: Array<[string, LogEntry]> = [
  ['banner', { id: 1, type: 'banner', text: '~/Desktop/test', detail: '1.0.0' }],
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

const WIDTHS = [40, 60, 80, 120];

// The composer is pinned to the last row by padding the live region with
// exactly the rows the transcript did not use. If the estimate drifts from what
// Ink actually draws, the prompt creeps off the bottom of the window.
test('estimateRows matches the rendered height of every log type', async () => {
  for (const cols of WIDTHS) {
    for (const [name, entry] of CASES) {
      const drawn = await rowsOf(entry, cols, false);
      assert.equal(
        estimateRows(entry, cols, false),
        drawn,
        `${name} at ${cols} cols: estimated ${estimateRows(entry, cols, false)}, drew ${drawn}`,
      );
    }
  }
});

test('estimateRows matches folded and expanded reasoning', async () => {
  for (const cols of WIDTHS) {
    for (const expanded of [false, true]) {
      const drawn = await rowsOf(REASONING, cols, expanded);
      assert.equal(
        estimateRows(REASONING, cols, expanded),
        drawn,
        `reasoning at ${cols} cols, expanded=${expanded}`,
      );
    }
  }
});

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
