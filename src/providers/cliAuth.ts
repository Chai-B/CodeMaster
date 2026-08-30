// The vendor CLIs, and whether each one is actually signed in.
//
// `--version` answers "installed", which is not the question. A user with the
// binary and no session got a green provider list, a startup banner with no
// warning, and a failure on the first call. Each vendor is asked its own
// question here instead, once per process.
//
// Signing in goes through the vendor's own command. CodeMaster stores nothing
// for these accounts — the token stays wherever the CLI put it, under whatever
// protection that CLI uses. Pasted API keys are the other path, and those go to
// the system keychain via CredentialManager.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CliVendor {
  /** The adapter id in ProviderManager, so a sign-in maps to a provider. */
  provider_id: string;
  binary: string;
  label: string;
  /** Shown when the binary is missing. */
  install: string;
  /** Arguments that start the vendor's interactive sign-in. */
  login: string[];
  /** Absent when the vendor has no sign-out command. */
  logout?: string[];
}

export interface CliState {
  vendor: CliVendor;
  installed: boolean;
  signedIn: boolean;
  /** Whatever the CLI says about who is signed in — an email, an account type. */
  identity?: string;
}

export const CLI_VENDORS: CliVendor[] = [
  {
    provider_id: 'anthropic',
    binary: 'claude',
    label: 'Claude Code',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
  },
  {
    provider_id: 'openai-codex',
    binary: 'codex',
    label: 'Codex',
    install: 'npm i -g @openai/codex',
    login: ['login'],
    logout: ['logout'],
  },
  {
    provider_id: 'google',
    binary: 'gemini',
    label: 'Gemini',
    install: 'npm i -g @google/gemini-cli',
    // Gemini has no sign-in subcommand: the documented flow is to start the CLI
    // and choose "Sign in with Google", so the terminal is handed to a bare run.
    login: [],
  },
];

export function vendorFor(providerId: string): CliVendor | undefined {
  return CLI_VENDORS.find((v) => v.provider_id === providerId);
}

const cache = new Map<string, CliState>();

/** Re-ask after a login or logout; the answer has just changed. */
export function invalidateCliState(providerId?: string): void {
  if (providerId) cache.delete(providerId);
  else cache.clear();
}

export function cliState(providerId: string): CliState | undefined {
  const vendor = vendorFor(providerId);
  if (!vendor) return undefined;
  const hit = cache.get(providerId);
  if (hit) return hit;
  const state = detect(vendor);
  cache.set(providerId, state);
  return state;
}

export function allCliStates(): CliState[] {
  return CLI_VENDORS.map((v) => cliState(v.provider_id)!);
}

/** Whether this vendor's CLI can answer a call right now. */
export function cliSignedIn(providerId: string): boolean {
  return cliState(providerId)?.signedIn ?? false;
}

function detect(vendor: CliVendor): CliState {
  if (!installed(vendor.binary)) return { vendor, installed: false, signedIn: false };
  const who = vendor.provider_id === 'anthropic'
    ? claudeIdentity()
    : vendor.provider_id === 'openai-codex'
      ? codexIdentity()
      : geminiIdentity();
  return { vendor, installed: true, ...who };
}

function installed(binary: string): boolean {
  try {
    return spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

function claudeIdentity(): { signedIn: boolean; identity?: string } {
  return parseClaudeStatus(capture('claude', ['auth', 'status']));
}

function codexIdentity(): { signedIn: boolean; identity?: string } {
  return parseCodexStatus(capture('codex', ['login', 'status']));
}

/** `claude auth status` prints JSON by default: loggedIn, email, subscriptionType. */
export function parseClaudeStatus(out: string): { signedIn: boolean; identity?: string } {
  try {
    const j = JSON.parse(out) as { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string };
    if (typeof j.loggedIn === 'boolean') {
      const who = [j.email, j.subscriptionType].filter(Boolean).join(' · ');
      return { signedIn: j.loggedIn, identity: who || j.authMethod };
    }
  } catch {
    // An older CLI prints prose; the text test below still reads it.
  }
  return { signedIn: saysLoggedIn(out) };
}

/** `codex login status` prints "Logged in using ChatGPT". */
export function parseCodexStatus(out: string): { signedIn: boolean; identity?: string } {
  const using = /logged in using ([^\n]+)/i.exec(out);
  return { signedIn: saysLoggedIn(out), identity: using?.[1]?.trim() };
}

/** Gemini has no status command. Its OAuth cache on disk is the only signal,
 *  so a stale file reads as signed in and the call reports the truth. */
function geminiIdentity(): { signedIn: boolean; identity?: string } {
  const creds = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  if (fs.existsSync(creds)) return { signedIn: true, identity: 'Google account' };
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return key ? { signedIn: true, identity: 'API key in the environment' } : { signedIn: false };
}

function saysLoggedIn(out: string): boolean {
  return /logged in/i.test(out) && !/not logged in|no.{0,10}credentials|please (run )?login/i.test(out);
}

function capture(binary: string, args: string[]): string {
  try {
    const r = spawnSync(binary, args, { encoding: 'utf8', timeout: 20_000 });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
  } catch {
    return '';
  }
}

export interface CliRunResult {
  ok: boolean;
  reason?: string;
}

/**
 * Run a vendor command with the terminal handed over — it draws its own
 * interface and reads its own keys. The caller is responsible for having got
 * the TUI out of the way first (see `withTerminal`).
 */
export function runOnTerminal(binary: string, args: string[]): CliRunResult {
  const r = spawnSync(binary, args, { stdio: 'inherit' });
  if (r.error) return { ok: false, reason: (r.error as NodeJS.ErrnoException).code ?? r.error.message };
  if (r.signal) return { ok: false, reason: `interrupted (${r.signal})` };
  return r.status === 0 ? { ok: true } : { ok: false, reason: `exit ${r.status}` };
}
