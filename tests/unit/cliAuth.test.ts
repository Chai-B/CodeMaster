import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLI_VENDORS,
  allCliStates,
  cliState,
  parseClaudeStatus,
  parseCodexStatus,
  vendorFor,
} from '../../src/providers/cliAuth.js';
import { setSuspender, withTerminal } from '../../src/ui/terminal.js';

// The whole point of this module: installed is not signed in. Every case below
// is real output shape from the vendor's own status command.

test('a signed-in claude reports who it is; a signed-out one reports nothing', () => {
  const inJson = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    email: 'someone@example.com',
    subscriptionType: 'pro',
  });
  const yes = parseClaudeStatus(inJson);
  assert.equal(yes.signedIn, true);
  assert.equal(yes.identity, 'someone@example.com · pro');

  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: false })).signedIn, false);
  // A CLI too old for --json, and a CLI that printed nothing at all.
  assert.equal(parseClaudeStatus('Not logged in. Run `claude auth login`.').signedIn, false);
  assert.equal(parseClaudeStatus('').signedIn, false);
});

test('codex login status is read as a sentence, negation included', () => {
  const yes = parseCodexStatus('Logged in using ChatGPT\n');
  assert.equal(yes.signedIn, true);
  assert.equal(yes.identity, 'ChatGPT');

  assert.equal(parseCodexStatus('Not logged in').signedIn, false);
  assert.equal(parseCodexStatus('').signedIn, false);
});

test('every vendor has a state, and an unknown provider has none', () => {
  const states = allCliStates();
  assert.equal(states.length, CLI_VENDORS.length);
  for (const s of states) {
    // A missing binary must read as "not installed", never throw.
    assert.equal(typeof s.installed, 'boolean');
    if (!s.installed) assert.equal(s.signedIn, false);
  }
  assert.equal(cliState('nope'), undefined);
  assert.equal(vendorFor('nope'), undefined);
  assert.equal(vendorFor('google')?.binary, 'gemini');
});

test('with no TUI to suspend, the vendor command runs on the terminal it already has', async () => {
  assert.equal(await withTerminal(() => 'ran'), 'ran');
});

test('a suspender gets the terminal back even when the login throws', async () => {
  const order: string[] = [];
  setSuspender(async (run) => {
    order.push('released');
    try {
      return await run();
    } finally {
      order.push('reclaimed');
    }
  });
  try {
    await assert.rejects(withTerminal(() => { throw new Error('user hit ctrl-c'); }));
    assert.deepEqual(order, ['released', 'reclaimed']);
  } finally {
    setSuspender(null);
  }
});
