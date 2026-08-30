import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CLI_VENDORS,
  allCliStates,
  cliState,
  parseClaudeStatus,
  parseCodexStatus,
  parseOpencodeStatus,
  vendorFor,
  MAX_ACCOUNTS_PER_VENDOR,
  DEFAULT_ACCOUNT,
  accountDir,
  accountEnv,
  addCliAccount,
  removeCliAccount,
  cliAccounts,
  cliRef,
  parseCliRef,
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

test('opencode reports how many credentials it holds, and whose', () => {
  // Real output shape: box drawing, ANSI colour, a bullet per provider.
  const yes = parseOpencodeStatus(
    '\u250c  Credentials ~/.local/share/opencode/auth.json\n\u25cf  opencode \u001b[90mapi\n\u2514  1 credentials\n',
  );
  assert.equal(yes.signedIn, true);
  assert.equal(yes.identity, 'opencode');

  assert.equal(parseOpencodeStatus('\u2514  0 credentials\n').signedIn, false);
  assert.equal(parseOpencodeStatus('').signedIn, false);
});

test('an account is a directory the vendor CLI is pointed at', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cli-'));
  process.env.CODEMASTER_DATA_DIR = dir;
  t.after(() => {
    delete process.env.CODEMASTER_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The machine-wide sign-in overrides nothing, so what the user already has
  // keeps working.
  assert.equal(accountDir('anthropic', DEFAULT_ACCOUNT), undefined);
  assert.equal(accountEnv('anthropic', DEFAULT_ACCOUNT).CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);

  assert.equal(addCliAccount('anthropic', 'work').ok, true);
  const home = accountDir('anthropic', 'work');
  assert.ok(home && fs.existsSync(home));
  assert.equal(accountEnv('anthropic', 'work').CLAUDE_CONFIG_DIR, home);
  assert.deepEqual(cliAccounts('anthropic'), [DEFAULT_ACCOUNT, 'work']);

  // Each vendor keeps its own directory under its own variable.
  addCliAccount('opencode', 'work');
  assert.ok(accountEnv('opencode', 'work').XDG_DATA_HOME);
  assert.notEqual(accountDir('opencode', 'work'), accountDir('anthropic', 'work'));

  assert.equal(addCliAccount('anthropic', 'work').ok, false, 'a name is taken once');
  assert.equal(addCliAccount('anthropic', DEFAULT_ACCOUNT).ok, false, 'default is the global sign-in');
  assert.equal(addCliAccount('anthropic', 'no spaces here').ok, false);
  assert.equal(addCliAccount('nope', 'work').ok, false);

  while (cliAccounts('anthropic').length < MAX_ACCOUNTS_PER_VENDOR) {
    assert.equal(addCliAccount('anthropic', `a${cliAccounts('anthropic').length}`).ok, true);
  }
  assert.equal(addCliAccount('anthropic', 'one-too-many').ok, false);

  // Removing takes the credentials with it; the global sign-in is untouchable.
  assert.equal(removeCliAccount('anthropic', 'work'), true);
  assert.equal(fs.existsSync(home!), false);
  assert.equal(removeCliAccount('anthropic', DEFAULT_ACCOUNT), false);
});

test('a CLI account reference survives a round trip and rejects anything else', () => {
  assert.equal(cliRef('google', 'work'), 'cli:google#work');
  assert.deepEqual(parseCliRef('cli:google#work'), { provider_id: 'google', account: 'work' });
  assert.deepEqual(parseCliRef('cli:google'), { provider_id: 'google', account: DEFAULT_ACCOUNT });
  assert.equal(parseCliRef('env:GEMINI_API_KEY'), undefined);
  assert.equal(parseCliRef('cred:google::mine'), undefined);
});
