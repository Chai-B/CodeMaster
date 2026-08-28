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

test('a task stuck on one model escalates one rung without touching shared config', async () => {
  const { solveWithVerification } = await import('../../src/workers/solver.js');
  const cfg = {
    providers: {
      default: 'cheap',
      anthropic: { models: [
        { id: 'cheap', context_size: 200_000, cost_per_1m_input: 1, cost_per_1m_output: 5 },
        { id: 'mid', context_size: 200_000, cost_per_1m_input: 3, cost_per_1m_output: 15 },
        { id: 'top', context_size: 200_000, cost_per_1m_input: 15, cost_per_1m_output: 75 },
      ] },
    },
  } as unknown as Parameters<typeof solveWithVerification>[3];

  const models = cfg.providers.anthropic.models as { id: string; cost_per_1m_output: number }[];
  const manager = {
    strongerThan: (id: string): string | null => {
      const here = models.find((m) => m.id === id)!;
      return (
        models
          .filter((m) => m.cost_per_1m_output > here.cost_per_1m_output)
          .sort((a, b) => a.cost_per_1m_output - b.cost_per_1m_output)[0]?.id ?? null
      );
    },
  } as unknown as Parameters<typeof solveWithVerification>[2];

  const seen: string[] = [];
  // The escalation target now arrives as exec's 7th argument. Absent means the
  // call takes whatever routing resolves, which is the default.
  const exec = async (...args: unknown[]): Promise<unknown> => {
    seen.push((args[6] as string | undefined) ?? cfg.providers.default);
    return { ir: { status: 'completed', summary: '' }, tokens: 1, ms: 1, applied: [], created: [], failed: [], reasoningStored: 0, wikiUpdated: 0 };
  };
  // Byte-identical failure every time: the same model would only repeat itself.
  const verify = (): { ok: boolean; output: string } => ({ ok: false, output: 'AssertionError: bound exceeded' });

  const session = { id: 's', repository: { path: process.cwd() }, objective: 'o' } as unknown as Parameters<typeof solveWithVerification>[0];
  const task = { id: 't', title: 'fix it', description: 'd', type: 'implement' } as unknown as Parameters<typeof solveWithVerification>[1];

  await solveWithVerification(session, task, manager, cfg, verify, 3, exec as never);

  assert.deepEqual(seen, ['cheap', 'cheap', 'mid']);
  // One rung only, and the shared config was never written — escalation is a
  // stack local, so a concurrent task cannot be re-priced by this one.
  assert.equal(cfg.providers.default, 'cheap');
});

test('a failure the model cannot act on stops at one iteration and keeps the work', async () => {
  let verifyCalls = 0;
  let execCalls = 0;
  const exec = async () => {
    execCalls++;
    return { ir: { summary: 'wrote the page' } as any, tokens: 80_000, ms: 1, applied: [], created: ['index.html'], failed: [], reasoningStored: 0, wikiUpdated: [] };
  };
  const r = await solveWithVerification({ repository: { path: repo } } as any, mkTask(), {} as any, {} as any,
    () => { verifyCalls++; return { ok: false, actionable: false, output: 'the crash guard could not read a changed file' }; },
    3, exec);
  assert.equal(r.iterations, 1);
  assert.equal(execCalls, 1);
  assert.equal(verifyCalls, 1);
  assert.equal(r.verified, false);
  // One call, not three, and no escalation: 80k rather than 240k plus opus rates.
  assert.equal(r.totalTokens, 80_000);
  assert.deepEqual(r.last.created, ['index.html']);
});

test('the solver hands the verifier the files it actually wrote', async () => {
  let seen: string[] = [];
  const exec = async () => ({
    ir: {} as any, tokens: 10, ms: 1, applied: ['a.ts'], created: ['b.ts'], failed: [], reasoningStored: 0, wikiUpdated: [],
  });
  await solveWithVerification({ repository: { path: repo } } as any, mkTask(), {} as any, {} as any,
    (changed) => { seen = changed; return { ok: true, output: '' }; }, 3, exec);
  assert.deepEqual(seen, ['a.ts', 'b.ts']);
});
