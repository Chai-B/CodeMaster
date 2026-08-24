// Ctrl-C must stop the task, not the process — and a cancelled task must not
// be recorded as a failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { beginCancellable, cancelActive, endCancellable, isCancelled, throwIfCancelled, Cancelled } =
  await import('../../src/util/cancel.js');

test('nothing running means nothing to cancel', () => {
  endCancellable();
  assert.equal(cancelActive(), false);
  assert.equal(isCancelled(), false);
});

test('a cancelled run reports itself and throws at the next checkpoint', () => {
  beginCancellable();
  assert.equal(isCancelled(), false);
  assert.equal(cancelActive(), true);
  assert.equal(isCancelled(), true);
  assert.throws(() => throwIfCancelled(), (e: unknown) => e instanceof Cancelled);
  endCancellable();
});

test('a second cancel of the same run is a no-op', () => {
  beginCancellable();
  assert.equal(cancelActive(), true);
  assert.equal(cancelActive(), false);
  endCancellable();
});

test('the solver stops between iterations instead of paying for another', async () => {
  const { solveWithVerification } = await import('../../src/workers/solver.js');
  let calls = 0;
  const exec = async () => {
    calls++;
    cancelActive();
    return { ir: { summary: '' } as never, tokens: 1, ms: 1, applied: [], created: [], failed: [], reasoningStored: 0, wikiUpdated: [] };
  };
  beginCancellable();
  await assert.rejects(
    solveWithVerification(
      { id: 's', repository: { path: process.cwd() } } as never,
      { id: 't', type: 'debug', title: 'x', description: 'x' } as never,
      {} as never, {} as never,
      () => ({ ok: false, output: 'nope' }), 5, exec,
    ),
    (e: unknown) => e instanceof Cancelled,
  );
  assert.equal(calls, 1);
  endCancellable();
});
