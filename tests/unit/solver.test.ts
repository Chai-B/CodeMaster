// Verify-and-iterate loop (spec §14.1) — stops on pass, retries with feedback on fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Task } from '../../src/types/index.js';

// The loop records tier outcomes and writes playbook lessons, so it must run
// against a scratch repository rather than this checkout.
process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-solver-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-solver-repo-'));

const { solveWithVerification } = await import('../../src/workers/solver.js');
const { Wiki } = await import('../../src/storage/wiki.js');

const mkTask = (): Task => ({
  id: 't', session_id: 's', title: 'x', description: 'DESC', type: 'debug', status: 'in_progress',
  input_files: [], output_files: [], dependencies: [], blocking: [], reasoning_refs: [], decision_refs: [],
  estimated_tokens: 0, order: 0,
});
const fakeExec = (tokens: number) => async () => ({ ir: {} as any, tokens, ms: 1, applied: [], created: [], failed: [], reasoningStored: 0, wikiUpdated: [] });

test('solver stops immediately when verification passes', async () => {
  let calls = 0;
  const r = await solveWithVerification({ repository: { path: repo } } as any, mkTask(), {} as any, {} as any,
    () => { calls++; return { ok: true, output: '' }; }, 3, fakeExec(10));
  assert.equal(r.iterations, 1);
  assert.equal(r.verified, true);
  assert.equal(r.totalTokens, 10);
  assert.equal(calls, 1);
});

test('solver retries with feedback until it passes', async () => {
  let verifyCalls = 0;
  const task = mkTask();
  const r = await solveWithVerification({ repository: { path: repo } } as any, task, {} as any, {} as any,
    () => { verifyCalls++; return { ok: verifyCalls >= 3, output: `fail ${verifyCalls}` }; }, 5, fakeExec(10));
  assert.equal(r.iterations, 3);
  assert.equal(r.verified, true);
  assert.equal(r.totalTokens, 30);
  assert.equal(task.description, 'DESC'); // restored after the loop
});

test('solver gives up after maxIters without verifying', async () => {
  const r = await solveWithVerification({ repository: { path: repo } } as any, mkTask(), {} as any, {} as any,
    () => ({ ok: false, output: 'nope' }), 2, fakeExec(5));
  assert.equal(r.iterations, 2);
  assert.equal(r.verified, false);
  assert.equal(r.totalTokens, 10);
});

test('a fix that took more than one attempt is written to the playbook', async () => {
  const task = mkTask();
  task.title = 'Fix the lateness window';
  let n = 0;
  const exec = async () => ({
    ir: { summary: 'widen the watermark before the join' } as any,
    tokens: 10, ms: 1, applied: ['stream/join.py'], created: [], failed: [], reasoningStored: 0, wikiUpdated: [],
  });
  await solveWithVerification({ id: 's', repository: { path: repo } } as any, task, {} as any, {} as any,
    () => { n++; return { ok: n >= 2, output: `AssertionError: late row dropped (${n})` }; }, 3, exec);

  const entry = Wiki.get('playbook/debug-join');
  assert.ok(entry, 'expected a playbook entry for the changed file');
  assert.match(entry!.content_markdown, /AssertionError: late row dropped \(1\)/);
  assert.match(entry!.content_markdown, /widen the watermark before the join/);
  assert.match(entry!.content_markdown, /stream\/join\.py/);
});

test('a fix that passed first time teaches nothing and writes no playbook entry', async () => {
  const task = mkTask();
  await solveWithVerification({ id: 's', repository: { path: repo } } as any, task, {} as any, {} as any,
    () => ({ ok: true, output: '' }), 3, fakeExec(10));
  assert.equal(Wiki.get('playbook/debug-x'), null);
});
