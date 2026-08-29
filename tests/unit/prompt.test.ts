import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { Prompt, promptRows } from '../../src/components/Prompt.js';
import { setPrompter, select, confirm, form, interactive, type PromptSpec, type PromptResult } from '../../src/ui/prompt.js';

class Out extends Writable {
  columns: number;
  rows = 200;
  isTTY = true;
  buf = '';
  constructor(cols: number) {
    super();
    this.columns = cols;
  }
  _write(c: unknown, _e: unknown, cb: () => void) {
    this.buf += String(c);
    cb();
  }
}

/** Ink wants a raw-mode TTY; a PassThrough with the three flags it checks is
 *  enough to deliver keystrokes to `useInput`. */
function fakeStdin(): PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void } {
  const s = new PassThrough() as never as PassThrough & {
    isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void;
  };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function drive(spec: PromptSpec, keys: string[], cols = 80) {
  const stdout = new Out(cols);
  const stdin = fakeStdin();
  let answer: PromptResult | null | undefined;
  const inst = render(
    React.createElement(Prompt, { spec, onDone: (r: PromptResult | null) => { answer = r; } }),
    { stdout: stdout as never, stdin: stdin as never, patchConsole: false },
  );
  await tick();
  const drawn = stripAnsi(stdout.buf);
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
  inst.unmount();
  return { answer, drawn, frame: stripAnsi(stdout.buf) };
}

const SELECT: PromptSpec = {
  kind: 'select',
  title: 'Switch model',
  choices: [
    { value: 'haiku', label: 'claude-haiku-4-5', hint: 'ctx 200k · $1/1M in' },
    { value: 'sonnet', label: 'claude-sonnet-5', hint: 'ctx 200k · $3/1M in' },
    { value: 'opus', label: 'claude-opus-5', hint: 'ctx 200k · $15/1M in' },
  ],
};
const CONFIRM: PromptSpec = {
  kind: 'confirm',
  title: 'Undo the last applied change?',
  detail: '3 file(s): a.ts, b.ts, c.ts',
  danger: true,
};
const FORM: PromptSpec = {
  kind: 'form',
  title: 'Add an account',
  fields: [
    { name: 'provider', label: 'Vendor', choices: [{ value: 'anthropic', label: 'anthropic' }, { value: 'openai', label: 'openai' }] },
    { name: 'alias', label: 'Name it' },
    { name: 'key', label: 'API key', secret: true },
  ],
};

const ENTER = '\r';
const DOWN = '\x1b[B';
const ESC = '\x1b';

// Nobody installs a prompter in a headless, MCP or proxy run, and every command
// that grew a picker still has to work there. The contract is that it answers
// null rather than hanging or throwing.
test('with no prompter installed every ask answers null', async () => {
  setPrompter(null);
  assert.equal(interactive(), false);
  assert.equal(await select('pick', [{ value: 'a', label: 'a' }]), null);
  assert.equal(await confirm('sure?'), null);
  assert.equal(await form('fill', [{ name: 'x', label: 'x' }]), null);
});

test('an installed prompter receives the spec and its answer comes back typed', async () => {
  const seen: PromptSpec[] = [];
  setPrompter(async (spec) => { seen.push(spec); return spec.kind === 'confirm' ? true : 'sonnet'; });
  assert.equal(interactive(), true);
  assert.equal(await select('pick', [{ value: 'sonnet', label: 'sonnet' }]), 'sonnet');
  assert.equal(await confirm('sure?'), true);
  // A form answers with an object; a bare string is not one, so it reads as a
  // cancel rather than being handed on as a half-answer.
  assert.equal(await form('fill', [{ name: 'x', label: 'x' }]), null);
  assert.deepEqual(seen.map((s) => s.kind), ['select', 'confirm', 'form']);
  setPrompter(null);
});

// The frame is pinned to the window: the transcript gets whatever the chrome
// does not take. A panel one row taller than the layout was told pushes the
// composer off the bottom of the screen.
test('promptRows matches the height every prompt actually draws', async () => {
  for (const cols of [40, 60, 80, 120]) {
    for (const spec of [SELECT, CONFIRM, FORM]) {
      const { drawn } = await drive(spec, [], cols);
      const lines = drawn.split('\n');
      if (lines.at(-1) === '') lines.pop();
      assert.equal(lines.length, promptRows(spec), `${spec.kind} at ${cols} cols`);
    }
  }
});

test('no prompt line exceeds the terminal width', async () => {
  for (const cols of [30, 40, 52, 80]) {
    for (const spec of [SELECT, CONFIRM, FORM]) {
      for (const line of (await drive(spec, [], cols)).drawn.split('\n')) {
        const w = stringWidth(line.replace(/\s+$/, ''));
        assert.ok(w <= cols, `${spec.kind}: ${w} > ${cols}: ${JSON.stringify(line)}`);
      }
    }
  }
});

test('a select answers with the value under the cursor, and esc answers nothing', async () => {
  assert.equal((await drive(SELECT, [DOWN, ENTER])).answer, 'sonnet');
  // A short list is picked by number without moving at all.
  assert.equal((await drive(SELECT, ['3'])).answer, 'opus');
  assert.equal((await drive(SELECT, [ESC])).answer, null);
});

test('a confirm answers true or false, and esc answers neither', async () => {
  assert.equal((await drive(CONFIRM, [ENTER])).answer, true);
  assert.equal((await drive(CONFIRM, ['n'])).answer, false);
  assert.equal((await drive(CONFIRM, [DOWN, ENTER])).answer, true, 'up/down must not move a left/right pair');
  assert.equal((await drive(CONFIRM, ['\x1b[C', ENTER])).answer, false);
  assert.equal((await drive(CONFIRM, [ESC])).answer, null);
});

// `/account add <provider> <alias> <key>` is the one line in the tool that
// carries a secret, which is why it is asked for rather than typed on a command
// line. That is worth nothing if the field then paints the key on screen.
test('a form fills field by field and never draws the secret', async () => {
  const { answer, frame } = await drive(FORM, [ENTER, 'work', ENTER, 'sk-live-4242', ENTER]);
  assert.deepEqual(answer, { provider: 'anthropic', alias: 'work', key: 'sk-live-4242' });
  assert.ok(!frame.includes('sk-live-4242'), 'the key was painted into the frame');
  assert.ok(frame.includes('••••'), 'the key field is not masked');
  assert.equal((await drive(FORM, [ESC])).answer, null);
});
