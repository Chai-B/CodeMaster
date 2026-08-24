// The vendor CLIs run through this, so a regression here silently breaks every
// provider call. Exercised against real child processes, no LLM involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../src/providers/cliRun.js';

test('stdin is delivered and stdout is returned', async () => {
  const r = await runCli('cat', [], 'hello');
  assert.equal(r.stdout, 'hello');
  assert.equal(r.status, 0);
});

test('lines arrive one at a time, including a trailing unterminated one', async () => {
  const seen: string[] = [];
  const r = await runCli('printf', ['a\\nb\\nc'], '', (l) => seen.push(l));
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(r.status, 0);
});

test('a failing command reports its exit code and stderr rather than throwing', async () => {
  const r = await runCli('sh', ['-c', 'echo boom >&2; exit 3'], '');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /boom/);
});

test('a missing binary resolves with a spawn error instead of rejecting', async () => {
  const r = await runCli('codemaster-no-such-binary', [], '');
  assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');
});

test('the event loop keeps running while a child works', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  await runCli('sh', ['-c', 'sleep 0.3'], '');
  clearInterval(timer);
  assert.ok(ticks > 5, `event loop was blocked (${ticks} ticks)`);
});
