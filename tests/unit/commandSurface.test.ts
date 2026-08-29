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

// Claiming the mouse for wheel scrolling costs selection and copy: with SGR
// reporting on, dragging across the transcript highlights nothing and there is
// no way to get a line of output out of the terminal. Alternate scroll gets the
// wheel back without taking the mouse, and the arrows carry the notches.
test('the TUI never claims the mouse, so selection and copy stay the terminal\'s', () => {
  const tui = fs.readFileSync(path.join(process.cwd(), 'src/index.tsx'), 'utf8');
  const enable = /stdout\.write\('([^']*\?1049h[^']*)'\)/.exec(tui)?.[1];
  assert.ok(enable, 'the alternate-screen enable sequence moved');
  assert.ok(!/\?100[026]h/.test(enable), `mouse reporting is back on: ${JSON.stringify(enable)}`);
  assert.ok(enable.includes('?1007h'), 'alternate scroll is off, so the wheel does nothing');
  // Recall has to live somewhere once the arrows are the wheel.
  assert.ok(tui.includes("c === 'p'") && tui.includes("c === 'n'"), 'history lost its keys');
});
