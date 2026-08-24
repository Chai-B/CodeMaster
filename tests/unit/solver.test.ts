// Verify-and-iterate loop (spec §14.1) — stops on pass, retries with feedback on fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveWithVerification } from '../../src/workers/solver.js';
import type { Task } from '../../src/types/index.js';

const mkTask = (): Task => ({
  id: 't', session_id: 's', title: 'x', description: 'DESC', type: 'debug', status: 'in_progress',
  input_files: [], output_files: [], dependencies: [], blocking: [], reasoning_refs: [], decision_refs: [],
  estimated_tokens: 0, order: 0,
});
const fakeExec = (tokens: number) => async () => ({ ir: {} as any, tokens, ms: 1, applied: [], created: [], failed: [], reasoningStored: 0, wikiUpdated: [] });

test('solver stops immediately when verification passes', async () => {
  let calls = 0;
  const r = await solveWithVerification({ repository: { path: process.cwd() } } as any, mkTask(), {} as any, {} as any,
    () => { calls++; return { ok: true, output: '' }; }, 3, fakeExec(10));
  assert.equal(r.iterations, 1);
  assert.equal(r.verified, true);
  assert.equal(r.totalTokens, 10);
  assert.equal(calls, 1);
});

test('solver retries with feedback until it passes', async () => {
  let verifyCalls = 0;
  const task = mkTask();
  const r = await solveWithVerification({ repository: { path: process.cwd() } } as any, task, {} as any, {} as any,
    () => { verifyCalls++; return { ok: verifyCalls >= 3, output: `fail ${verifyCalls}` }; }, 5, fakeExec(10));
  assert.equal(r.iterations, 3);
  assert.equal(r.verified, true);
  assert.equal(r.totalTokens, 30);
  assert.equal(task.description, 'DESC'); // restored after the loop
});

test('solver gives up after maxIters without verifying', async () => {
  const r = await solveWithVerification({ repository: { path: process.cwd() } } as any, mkTask(), {} as any, {} as any,
    () => ({ ok: false, output: 'nope' }), 2, fakeExec(5));
  assert.equal(r.iterations, 2);
  assert.equal(r.verified, false);
  assert.equal(r.totalTokens, 10);
});
