// File-locus reasoning/failure retrieval (spec §8.4/§8.5) — memory compounds on
// the files being touched, not just prose keyword overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-locus-'));

const { Reasoning, Failures } = await import('../../src/storage/reasoning.js');
const { solveWithVerification } = await import('../../src/workers/solver.js');
const { id, now } = await import('../../src/util/id.js');

test('Reasoning.byAffectedFiles retrieves by code locus, ignoring keywords', () => {
  Reasoning.insert({
    id: id('reasoning'), type: 'decision', session_id: 's', task_id: 't',
    summary: 'chose approach zebra', detail: 'unrelated wording', evidence: [],
    confidence: 0.9, produced_by: { provider_id: 'x', model_id: 'y' }, produced_at: now(),
    affected_files: [{ path: 'src/widget/foo.ts' }], affected_modules: [], tags: [],
    permanent: false, wiki_keys: [], reference_count: 0, importance: 0.8,
  } as never);

  const byFile = Reasoning.byAffectedFiles(['src/widget/foo.ts']);
  assert.equal(byFile.length, 1);
  assert.equal(byFile[0]!.summary, 'chose approach zebra');

  // A file with no reasoning returns nothing; empty input is safe.
  assert.equal(Reasoning.byAffectedFiles(['src/other.ts']).length, 0);
  assert.equal(Reasoning.byAffectedFiles([]).length, 0);
});

test('Failures.byAffectedFiles surfaces non-working approaches on the same files', () => {
  Failures.insert({
    id: id('failure'), session_id: 's', task_id: 't',
    approach_attempted: 'patched only foo.ts', why_it_failed: 'bar.ts still crashed',
    evidence_of_failure: [], alternatives_suggested: [],
    affected_files: [{ path: 'src/widget/bar.ts' }], confidence_in_failure_diagnosis: 0.6,
    created_at: now(), permanent: false,
  } as never);

  const hits = Failures.byAffectedFiles(['src/widget/bar.ts']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.why_it_failed, 'bar.ts still crashed');
  assert.equal(Failures.byAffectedFiles([]).length, 0);
});

test('solver records a failure on verify-fail, keyed to the changed files', async () => {
  const task = {
    id: 'tk', session_id: 'sess', title: 'fix thing', description: 'DESC', type: 'debug',
    status: 'in_progress', input_files: [], output_files: [], dependencies: [], blocking: [],
    reasoning_refs: [], decision_refs: [], estimated_tokens: 0, order: 0,
  } as never;
  const exec = async () => ({
    ir: { summary: 'edited only alpha.py' } as never, tokens: 5, ms: 1,
    applied: ['pkg/alpha.py'], created: [], failed: [], reasoningStored: 0, wikiUpdated: [],
  });
  const r = await solveWithVerification(
    { id: 'sess', repository: { path: process.cwd() } } as never, task, {} as never, {} as never,
    () => ({ ok: false, output: 'beta.py import error' }), 1, exec,
  );
  assert.equal(r.verified, false);
  const rec = Failures.byAffectedFiles(['pkg/alpha.py']);
  assert.equal(rec.length, 1);
  assert.equal(rec[0]!.approach_attempted, 'edited only alpha.py');
});

test('IR round-trip keys reasoning to the files the patch touched', async () => {
  const { parseIR } = await import('../../src/workers/outputParser.js');
  const { irFromJson } = await import('../../src/workers/irFromJson.js');

  const ir = parseIR(
    `<task_result><status>completed</status>
     <patch file="pkg/gamma.py">--- a\n+++ b\n</patch>
     <reasoning><decision><question>q</question><answer>use a copy</answer></decision></reasoning>
     </task_result>`,
    's2', 't2', { provider_id: 'x', model_id: 'y' },
  );
  assert.deepEqual(ir.decisions[0]!.affected_files, [{ path: 'pkg/gamma.py' }]);

  const jsonIr = irFromJson(
    JSON.stringify({ status: 'completed', patches: [{ file: 'pkg/delta.py', diff: 'd' }], decisions: [{ answer: 'a' }] }),
    's2', 't2', { provider_id: 'x', model_id: 'y' },
  );
  assert.deepEqual(jsonIr.decisions[0]!.affected_files, [{ path: 'pkg/delta.py' }]);

  // The point of the field: stored reasoning is retrievable by the code it is about.
  for (const d of ir.decisions) Reasoning.insert(d as never);
  assert.equal(Reasoning.byAffectedFiles(['pkg/gamma.py']).length, 1);
});

test('a wiki conflict queues at most one open resolver, not a chain', async () => {
  const { Sessions, Tasks } = await import('../../src/storage/sessions.js');
  const { processIR } = await import('../../src/workers/irProcessor.js');
  const { applyWikiUpdate } = await import('../../src/wiki/updater.js');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-conf-'));
  const session = {
    id: 'conf-s', created_at: now(), updated_at: now(), status: 'active',
    objective: 'fix the resolver', repository: { path: repo, commit: 'no-git' },
    progress: { total: 0, completed: 0, failed: 0 }, constraints: [], open_questions: [],
    working_files: [], decisions: [], provider_history: [], checkpoints: [],
    token_usage: { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 }, current_provider: { provider_id: 'anthropic', model_id: 'm' },
    metadata: {},
  } as never;
  Sessions.insert(session);

  const KEY = 'notes/thing';
  applyWikiUpdate({ key: KEY, content: 'A'.repeat(400), is_diff: false }, 'conf-s', 'queue');

  const task = {
    id: 'conf-t', session_id: 'conf-s', title: 'work', description: '', type: 'implement',
    status: 'in_progress', input_files: [], output_files: [], dependencies: [], blocking: [],
    reasoning_refs: [], decision_refs: [], estimated_tokens: 0, order: 1,
  } as never;
  Tasks.insert(task);

  const cfg = { wiki: { auto_update: true, conflict_strategy: 'queue' }, memory: {}, checkpointing: {} } as never;
  const ir = (content: string): never => ({
    session_id: 'conf-s', task_id: 'conf-t', status: 'completed', patches: [], files_created: [],
    files_deleted: [], commands_run: [], decisions: [], observations: [], risks: [], assumptions: [],
    wiki_updates: [{ key: KEY, content, is_diff: false }], next_tasks: [], open_questions: [],
    produced_by: { provider_id: 'x', model_id: 'y' },
  }) as never;

  // The resolver's own wiki update lands on the same key and is a synthesis of
  // two entries, so it is materially different by construction and conflicts
  // again. Without a guard each resolution queued the next: measured on a real
  // run at three solver iterations and 106k tokens spent on a `notes/` entry
  // unrelated to the objective, while the code fix cost 41k.
  await processIR(ir('B'.repeat(400)), session, task, cfg);
  const resolvers = (): unknown[] =>
    Tasks.forSession('conf-s').filter((t) => t.title === `Resolve knowledge conflict: ${KEY}`);
  assert.equal(resolvers().length, 1, 'first conflict queues a resolver');

  await processIR(ir('C'.repeat(400)), session, task, cfg);
  assert.equal(resolvers().length, 1, 'a second conflict on the same key must not queue a chain');
});
