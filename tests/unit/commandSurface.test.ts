// The catalog is the only place command help comes from, so it must not drift
// from what the router actually dispatches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const { COMMANDS } = await import('../../src/commands/catalog.js');

const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/router.ts'), 'utf8');
const routed = new Set([...src.matchAll(/case '(\/[a-z-]+)':/g)].map((m) => m[1]!));
// Handled by the TUI shell, not the router.
const SHELL = new Set(['/clear', '/quit']);

test('every catalog command is dispatched by the router', () => {
  const missing = COMMANDS.map((c) => c.cmd).filter((c) => !routed.has(c) && !SHELL.has(c));
  assert.deepEqual(missing, []);
});

test('every routed command is listed in the catalog', () => {
  const known = new Set(COMMANDS.map((c) => c.cmd));
  assert.deepEqual([...routed].filter((c) => !known.has(c)), []);
});

test('a usage line, where present, names its own command', () => {
  for (const c of COMMANDS) {
    if (c.usage) assert.ok(c.usage.startsWith(c.cmd), `${c.cmd}: ${c.usage}`);
  }
});

// Phase grouping keys off the text the router and workers already emit, so it
// drifts silently the moment one of those messages is reworded.

const { phaseOf, eventToLog } = await import('../../src/util/parser.js');

test('a real run walks Planning → Solving → Verifying → done', () => {
  const run: Array<[Parameters<typeof phaseOf>[0], string | null]> = [
    [{ type: 'heading', text: 'New session' }, null],
    [{ type: 'heading', text: 'Planning' }, 'Planning'],
    [{ type: 'success', text: '1 task planned' }, 'Planning'],
    [{ type: 'heading', text: 'Tasks' }, 'Planning'],
    [{ type: 'sep', text: '' }, 'Solving'],
    [{ type: 'tool', text: '→ Worker: FileSelector' }, 'Solving'],
    [{ type: 'plain', text: 'Solver iteration 1/3…' }, 'Solving'],
    [{ type: 'warn', text: 'Applied, but unverified: no test framework' }, 'Verifying'],
    [{ type: 'success', text: 'Task completed (12.3s, 78,745 tokens)' }, 'Verifying'],
    [{ type: 'heading', text: 'Done · 1/1 · applied, unverified' }, null],
  ];
  let phase: ReturnType<typeof phaseOf> = null;
  for (const [entry, want] of run) {
    phase = phaseOf(entry, phase);
    assert.equal(phase, want, `after ${JSON.stringify(entry.text)}`);
  }
});

test('every phase marker still exists in the code that emits it', () => {
  const emitters = ['src/commands/router.ts', 'src/workers/solver.ts', 'src/daemon/sessionManager.ts']
    .map((f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8'))
    .join('\n');
  for (const marker of ["'heading', 'Planning'", 'Solver iteration ', 'Applied, but unverified: ', 'Verification passed', 'Verifier: ']) {
    assert.ok(emitters.includes(marker), `no longer emitted: ${marker}`);
  }
});

test('a task boundary is what ends planning', () => {
  const sep = eventToLog({ type: 'task.started', task_id: 't', title: 'x' });
  assert.equal(sep?.type, 'sep');
  assert.equal(phaseOf(sep!, 'Planning'), 'Solving');
});

// The pinned frame has three load-bearing pieces whose absence is silent
// rather than loud: the alternate page (without it the header and the composer
// are just lines in the shell's scroll region and drag away), and the two
// guards that keep mouse reports out of Ink's key parser and out of the
// composer. Losing the second one makes every wheel notch read as escape and
// cancel the running task, which looks like a bug in the task.
test('the pinned frame keeps its page, its wheel and its two mouse guards', () => {
  const tui = fs.readFileSync(path.join(process.cwd(), 'src/index.tsx'), 'utf8');
  assert.ok(/\?1049h/.test(tui), 'the alternate screen is gone, so nothing is pinned');
  assert.ok(/\?1049l/.test(tui), 'the alternate screen is never released, so quitting strands the terminal');
  // `?1002h`, not `?1000h`: button-event tracking is what adds motion and
  // release, and without those a drag cannot be selected or copied.
  assert.ok(/\?1002h/.test(tui) && /\?1006h/.test(tui), 'the mouse is not claimed, so the wheel does nothing');
  assert.ok(/\?1002l/.test(tui) && /\?1006l/.test(tui), 'mouse reporting is never released');
  // Selection reads the frame Ink wrote and maps line `i` to row `i + 1`. That
  // holds only while the root box is exactly the window's height.
  assert.ok(/height=\{rows\}/.test(tui), 'the root box no longer spans the window, so selected rows are off by however much it shrank');
  assert.ok(!/\?1007h/.test(tui), 'alternate scroll is back, which makes the wheel and the arrows the same key');
  assert.ok(!/<Static\b/.test(tui), '<Static> writes past the frame and breaks the pinning');
  assert.ok(/if \(mouseRef\.current\) return;/.test(tui), 'useInput reads wheel notches as escape');
  assert.ok(/replace\(MOUSE, ''\)/.test(tui), 'wheel notches are typed into the composer');
  // The arrows are recall and nothing else; scrolling has the wheel, shift and
  // the page keys. Recall keeps its shell aliases as well.
  assert.ok(/if \(key\.upArrow\) prevHistory\(\);/.test(tui), 'the arrows no longer recall');
  assert.ok(tui.includes("c === 'p'") && tui.includes("c === 'n'"), 'history lost its keys');
});
