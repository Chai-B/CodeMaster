// The vendor CLI charges its whole system prompt on every fresh invocation, so
// a task that iterates pays that floor once per iteration unless the vendor's
// own conversation is resumed. Measured against the `claude` CLI: opening costs
// ~49k input tokens, resuming the same conversation costs 1 fresh token plus
// cache reads. These tests pin the decision that produces that difference.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuationRequest } from '../../src/providers/manager.js';
import type { ProviderRequest } from '../../src/types/index.js';

const full: ProviderRequest = { system: 'S', user: 'FULL CONTEXT', model: 'm', max_tokens: 100 };
const conv = { id: 'c1', turn: 1, provider_id: 'anthropic', delta: 'ONLY THE NEW FAILURE' };

test('a stateless adapter always receives the full context', () => {
  const r = continuationRequest(full, conv, false, 'anthropic');
  assert.equal(r.conversation, undefined);
  assert.equal(r.user, 'FULL CONTEXT');
});

test('the first turn opens the conversation with the full context', () => {
  const r = continuationRequest(full, { ...conv, turn: 0, provider_id: undefined }, true, 'anthropic');
  assert.deepEqual(r.conversation, { id: 'c1', resume: false });
  assert.equal(r.user, 'FULL CONTEXT');
});

test('a later turn on the same vendor sends only the delta', () => {
  const r = continuationRequest(full, conv, true, 'anthropic');
  assert.deepEqual(r.conversation, { id: 'c1', resume: true });
  assert.equal(r.user, 'ONLY THE NEW FAILURE');
});

test('after a vendor switch the new vendor opens its own conversation', () => {
  const r = continuationRequest(full, conv, true, 'openai-codex');
  assert.deepEqual(r.conversation, { id: 'c1', resume: false });
  assert.equal(r.user, 'FULL CONTEXT', 'the new vendor has never seen the earlier turns');
});

test('an empty delta never resumes into silence', () => {
  const r = continuationRequest(full, { ...conv, delta: '' }, true, 'anthropic');
  assert.equal(r.conversation!.resume, false);
  assert.equal(r.user, 'FULL CONTEXT');
});

// The SDK path ignores `conversation` entirely, so claiming continuation on an
// account that will take it strips the repository context off every solver
// iteration after the first.
test('an account with an api key does not claim continuation', async () => {
  const { AnthropicAdapter } = await import('../../src/providers/anthropic.js');
  const a = new AnthropicAdapter([]);
  const acct = (ref: string) =>
    ({ id: 'a', provider_id: 'anthropic', auth_type: 'api_key', credential_ref: ref }) as never;
  assert.equal(a.continuation_available(acct('env:__CM_NO_SUCH_KEY__')), a.supports_continuation);
  assert.equal(a.continuation_available(acct('oauth:tok-123')), false);
});
