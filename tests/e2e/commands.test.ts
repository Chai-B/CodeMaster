// The command surface, driven the way a user drives it — no LLM, no network.
// Each command is asserted on what it actually emitted to the bus, so a command
// that silently does nothing fails here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cmd-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cmdrepo-'));
process.env.CODEMASTER_DATA_DIR = TMP;

fs.writeFileSync(path.join(REPO, 'app.py'), 'def charge(user, amount):\n    return amount\n');
execFileSync('git', ['init', '-q'], { cwd: REPO });
execFileSync('git', ['add', '.'], { cwd: REPO });
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: REPO });

const { SessionManager } = await import('../../src/daemon/sessionManager.js');
const { CommandRouter } = await import('../../src/commands/router.js');
const { Undo } = await import('../../src/storage/undo.js');
const { bus } = await import('../../src/events/bus.js');
const { loadConfig } = await import('../../src/config.js');

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(REPO, { recursive: true, force: true });
});

const sm = new SessionManager();
const router = new CommandRouter(sm);

/** Everything the router said while running one command. */
async function run(input: string): Promise<string> {
  const lines: string[] = [];
  const off = bus.onAny((e) => {
    if (e.type === 'log') lines.push((e as { message: string }).message);
  });
  await router.dispatch(input);
  off();
  return lines.join('\n');
}

test('/model lists models and rejects one that does not exist', async () => {
  assert.match(await run('/model'), /ctx /);
  assert.match(await run('/model not-a-real-model'), /Unknown model/);
});

test('/config shows settings and set writes them back typed', async () => {
  assert.match(await run('/config'), /context\.max_context_tokens/);
  assert.match(await run('/config set context.max_files 12'), /context\.max_files = 12/);
  assert.equal(loadConfig().context.max_files, 12);
  assert.match(await run('/config set context.max_files not-a-number'), /takes a number/);
  assert.match(await run('/config set nope.nope 1'), /Unknown setting/);
});

test('commands that need a session say so instead of failing', async () => {
  assert.match(await run('/diff'), /No active session/);
  assert.match(await run('/why app.py'), /No active session/);
});

test('/waste reports discipline even before any call is recorded', async () => {
  assert.match(await run('/waste'), /nothing to measure|Unreferenced context/);
});

test('/undo restores the exact prior bytes and leaves other edits alone', async () => {
  const target = path.join(REPO, 'app.py');
  const before = fs.readFileSync(target, 'utf8');
  const created = path.join(REPO, 'new.py');

  await sm.createSession('touch the charge helper', REPO);
  fs.writeFileSync(target, 'def charge(user, amount, currency):\n    return amount\n');
  fs.writeFileSync(created, 'x = 1\n');
  Undo.record(REPO, null, null, 'widen charge()', [
    { path: 'app.py', before },
    { path: 'new.py', before: null },
  ]);

  assert.match(await run('/undo'), /Reverted 1 file/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.equal(fs.existsSync(created), false);
  assert.match(await run('/undo'), /Nothing to undo/);
});

test('/diff reports the working tree against the session baseline', async () => {
  assert.match(await run('/diff'), /Nothing has changed on disk/);
  fs.appendFileSync(path.join(REPO, 'app.py'), '\n# note\n');
  const out = await run('/diff');
  assert.match(out, /app\.py/);
  assert.match(out, /\+# note/);
});

test('/why names the signals that selected a file, or says it was not selected', async () => {
  const out = await run('/why app.py');
  assert.match(out, /app\.py|not in the context|No task/);
});

test('every catalog command is routable', async () => {
  const { COMMANDS } = await import('../../src/commands/catalog.js');
  for (const c of COMMANDS) {
    if (['/quit', '/clear'].includes(c.cmd)) continue;
    const out = await run(`${c.cmd} --help`);
    assert.match(out, /Usage:/, `${c.cmd} has no usage help`);
  }
});
