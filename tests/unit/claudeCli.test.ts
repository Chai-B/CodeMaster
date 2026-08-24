// Contract test for `claude -p --output-format json`. The CLI reports usage
// limits and stale sessions inside its JSON body while exiting non-zero, and it
// splits billed input across three separate usage fields — so a renamed field
// silently reads zero tokens and a renamed error string silently becomes an
// unrecoverable failure. Both shapes are pinned here against a real recorded
// response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'child_process';
import { describeCliFailure, isMissingConversation, usageFromCliResult, type CliResult } from '../../src/providers/anthropic.js';

// Recorded from: printf 'Reply with exactly: OK' | claude -p --output-format json --model sonnet
const REAL = JSON.parse(
  '{"type":"result","subtype":"success","is_error":false,"result":"OK","api_error_status":null,' +
    '"session_id":"82c90e65-7e5a-4d33-b9ba-74588075e1c3","total_cost_usd":0.061979599999999996,' +
    '"usage":{"input_tokens":3990,"cache_creation_input_tokens":11354,"cache_read_input_tokens":42718,"output_tokens":4}}',
) as CliResult;

function spawned(over: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null, ...over } as SpawnSyncReturns<string>;
}

test('billed input is the sum of fresh, cache-read and cache-write tokens', () => {
  const u = usageFromCliResult(REAL);
  assert.equal(u.input_tokens, 3990 + 42718 + 11354);
  assert.equal(u.cache_read_tokens, 42718);
  assert.equal(u.cache_write_tokens, 11354);
  assert.equal(u.output_tokens, 4);
  assert.equal(u.total_tokens, 58066);
});

test('a result with no usage block reports zero rather than throwing', () => {
  assert.deepEqual(usageFromCliResult({ result: 'OK' }), {
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0,
  });
});

test('the JSON body explains the failure, not the exit code', () => {
  const d: CliResult = { subtype: 'error_max_turns', is_error: true, api_error_status: 'usage limit reached' };
  const detail = describeCliFailure(spawned({ status: 1, stdout: '{}' }), d);
  assert.match(detail, /usage limit reached/);
  assert.match(detail, /exit 1/);
});

test('an unparseable run still reports the process-level facts', () => {
  const detail = describeCliFailure(spawned({ status: 127, stderr: 'command not found' }), null);
  assert.match(detail, /exit 127/);
  assert.match(detail, /empty stdout/);
  assert.match(detail, /command not found/);
});

test('a run that produced nothing at all still yields a diagnostic', () => {
  assert.ok(describeCliFailure(spawned(), null).length > 0);
});

test('a stale resumed session is recognised from prose, not a status code', () => {
  assert.ok(isMissingConversation('No conversation found with session ID: 82c90e65'));
  assert.ok(isMissingConversation('could not find session'));
  assert.equal(isMissingConversation('Claude AI usage limit reached'), false);
});
