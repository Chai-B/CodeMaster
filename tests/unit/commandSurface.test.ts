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
