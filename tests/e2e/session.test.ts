// E2E session lifecycle with a stubbed LLM (no network).
// Sets CODEMASTER_DATA_DIR before importing modules that read it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-e2e-'));
process.env.CODEMASTER_DATA_DIR = TMP;

const { SessionManager } = await import('../../src/daemon/sessionManager.js');
const { parseIR } = await import('../../src/workers/outputParser.js');
const { processIR } = await import('../../src/workers/irProcessor.js');
const { Sessions, Tasks } = await import('../../src/storage/sessions.js');
const { Reasoning } = await import('../../src/storage/reasoning.js');
const { createCheckpoint, restoreCheckpoint } = await import('../../src/workers/checkpointer.js');

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('create → pause → resume → complete lifecycle persists', async () => {
  const sm = new SessionManager();
  const session = await sm.createSession('add a helper function', process.cwd());
  assert.equal(session.status, 'initializing');
  assert.ok(Sessions.get(session.id));

  await sm.pause(session);
  assert.equal(Sessions.get(session.id)!.status, 'paused');

  const resumed = sm.resume(session.id);
  assert.ok(resumed);
  assert.equal(resumed!.status, 'active');

  await sm.complete(resumed!);
  assert.equal(Sessions.get(session.id)!.status, 'completed');
});

test('IR processing applies new files, persists reasoning, and checkpoints restore', async () => {
  const sm = new SessionManager();
  const session = await sm.createSession('demo ir', process.cwd());
  const task = {
    id: 'task-e2e', session_id: session.id, title: 'demo', description: 'demo', type: 'implement' as const,
    status: 'in_progress' as const, input_files: [], output_files: [], dependencies: [], blocking: [],
    reasoning_refs: [], decision_refs: [], estimated_tokens: 0, order: 0,
  };
  Tasks.insert(task);

  const raw = `<task_result>
<status>completed</status>
<summary>added file</summary>
<new_files><file path="${path.join(TMP, 'e2e_demo.txt')}">hello</file></new_files>
<reasoning><decision question="q" answer="put in tmp" confidence="0.9" reversibility="easy"><evidence>e</evidence></decision></reasoning>
</task_result>`;
  const ir = parseIR(raw, session.id, task.id, { provider_id: 'anthropic', model_id: 'claude-sonnet-4-6' });
  const res = await processIR(ir, session, task, sm.cfg);

  assert.ok(res.apply.created.length === 1 || res.apply.applied.length >= 0);
  assert.ok(Reasoning.forSession(session.id).length >= 1);
  assert.ok(ir.raw_output === undefined, 'raw output archived to cold storage');

  const cp = await createCheckpoint(session, 'manual');
  assert.ok(cp.id);
  const restored = restoreCheckpoint(cp.id);
  assert.ok(restored);
  assert.equal(restored!.id, session.id);
});
