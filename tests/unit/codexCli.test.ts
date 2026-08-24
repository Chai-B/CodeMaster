// Contract test for the `codex exec --json` event stream. If the CLI ever
// renames the turn.completed usage fields, token accounting silently reads
// zero — so the shape is pinned here against a real recorded event line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageFromEvents } from '../../src/providers/codex.js';

// Recorded from: printf 'Reply with exactly: OK' | codex exec --json --sandbox read-only --skip-git-repo-check -
const REAL = [
  '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":35150,"cached_input_tokens":23040,"cache_write_input_tokens":0,"output_tokens":152,"reasoning_output_tokens":65}}',
].join('\n');

test('usage is read from the turn.completed event', () => {
  const u = usageFromEvents(REAL);
  assert.ok(u);
  assert.equal(u!.input_tokens, 35150);
  assert.equal(u!.cached_input_tokens, 23040);
  assert.equal(u!.output_tokens, 152);
});

test('a stream without turn.completed reports nothing rather than zero', () => {
  assert.equal(usageFromEvents('{"type":"item.started"}\nnot json'), null);
});

test('the last turn wins and a partial line does not throw', () => {
  const s = '{"type":"turn.completed","usage":{"input_tokens":1}}\n{"type":"turn.comp\n{"type":"turn.completed","usage":{"input_tokens":9}}';
  assert.equal(usageFromEvents(s)!.input_tokens, 9);
});
