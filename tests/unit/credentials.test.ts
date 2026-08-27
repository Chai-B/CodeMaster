// A credential you stored has to be a credential the tool will actually use.
// Isolated data dir, set before anything loads config: CREDENTIALS_DIR is
// resolved at module load, so a later assignment would write into the real one.

import fs from 'fs';
import os from 'os';
import path from 'path';
process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cred-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const models = (id: string, out = 5) => [{ id, context_size: 200_000, cost_per_1m_input: 1, cost_per_1m_output: out }];

/** No env keys for the vendors under test — the whole point is that the store
 *  is the only thing holding a credential. */
function withoutEnv<T>(keys: string[], fn: () => T): T {
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

const OPENAI_ENV = ['OPENAI_API_KEY'];

test('a stored credential makes its vendor routable', async () => {
  const { CredentialManager } = await import('../../src/providers/credentials.js');
  const { ProviderManager } = await import('../../src/providers/manager.js');

  const cfg = {
    providers: {
      default: 'claude-sonnet-4-6',
      anthropic: { models: models('claude-sonnet-4-6', 15) },
      openai: { models: models('gpt-5-codex') },
      google: { models: [] },
      openai_codex: { models: [] },
    },
  } as unknown as ConstructorParameters<typeof ProviderManager>[0];

  withoutEnv(OPENAI_ENV, () => {
    const blind = new ProviderManager(cfg);
    assert.equal(blind.providerHasCredentials('openai'), false, 'no key anywhere yet');

    CredentialManager.store('openai::work', 'sk-test-stored');
    // Constructed after the store, the way a real process starts.
    const seeing = new ProviderManager(cfg);
    assert.equal(
      seeing.providerHasCredentials('openai'),
      true,
      'a stored key is a key — routing, failover and escalation all gate on this',
    );
  });
});

test('the account that answers is one whose credential resolves', async () => {
  const { CredentialManager } = await import('../../src/providers/credentials.js');
  const { ProviderManager } = await import('../../src/providers/manager.js');

  const cfg = {
    providers: {
      default: 'gpt-5-codex',
      anthropic: { models: [] },
      openai: { models: models('gpt-5-codex') },
      google: { models: [] },
      openai_codex: { models: [] },
    },
  } as unknown as ConstructorParameters<typeof ProviderManager>[0];

  withoutEnv(OPENAI_ENV, () => {
    CredentialManager.store('openai::work', 'sk-test-stored');
    const m = new ProviderManager(cfg);
    const sel = m.select('gpt-5-codex', 1000);
    // Every fresh account scores identically on latency, so before this fix the
    // sort fell back to insertion order and the keyless env-backed `default`
    // account — pushed first by the constructor — always won.
    assert.equal(sel.account.credential_ref, 'cred:openai::work');
  });
});

test('a default model on a vendor with no credentials is not the model chosen', async () => {
  const { CredentialManager } = await import('../../src/providers/credentials.js');
  const { ProviderManager } = await import('../../src/providers/manager.js');

  const cfg = {
    providers: {
      // Points at Anthropic, but only OpenAI has a credential.
      default: 'claude-sonnet-4-6',
      anthropic: { models: models('claude-sonnet-4-6', 15) },
      openai: { models: models('gpt-5-codex') },
      google: { models: [] },
      openai_codex: { models: [] },
    },
  } as unknown as ConstructorParameters<typeof ProviderManager>[0];

  withoutEnv(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', ...OPENAI_ENV], () => {
    CredentialManager.store('openai::work', 'sk-test-stored');
    const m = new ProviderManager(cfg);
    if (m.providerHasCredentials('anthropic')) return; // an authenticated `claude` CLI is a real credential
    assert.equal(m.modelFor('solve'), 'gpt-5-codex', 'holding one usable key should mean the tool runs');
  });
});

test('a pin still wins, even when its vendor has no credential', async () => {
  const { ProviderManager } = await import('../../src/providers/manager.js');
  const cfg = {
    providers: {
      default: 'claude-sonnet-4-6',
      pinned: true,
      anthropic: { models: models('claude-sonnet-4-6', 15) },
      openai: { models: models('gpt-5-codex') },
      google: { models: [] },
      openai_codex: { models: [] },
    },
  } as unknown as ConstructorParameters<typeof ProviderManager>[0];

  withoutEnv(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], () => {
    const m = new ProviderManager(cfg);
    // A pin is a measurement promise. Falling back to a credentialed vendor
    // here would silently answer a benchmark's question with another model.
    assert.equal(m.modelFor('solve'), 'claude-sonnet-4-6');
  });
});
