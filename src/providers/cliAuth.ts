// The vendor CLIs, the accounts held in each, and whether each one is signed in.
//
// `--version` answers "installed", which is not the question. A user with the
// binary and no session got a green provider list, a startup banner with no
// warning, and a failure on the first call. Each vendor is asked its own
// question here instead, once per process.
//
// Several accounts per vendor are real accounts, not a swapped credential file.
// Every one of these CLIs reads its credential store from a directory named by
// one environment variable, so an account is a directory: sign-in writes the
// token there under the vendor's own protection, and every later call for that
// account points the CLI back at it. CodeMaster stores no secret for these —
// only the fact that the directory exists.
//
// The `default` account is the machine-wide sign-in, with no override at all,
// so whatever the user already had keeps working untouched.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../config.js';

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
  /**
   * Environment variable that points this CLI at a private credential store.
   * Set to an account's own directory, the CLI signs in and reads back there
   * and nowhere else — which is what makes more than one account per vendor
   * possible without ever touching the token itself.
   */
  profileEnv: string;
  /** Measured on this machine, or taken from the vendor's documentation. */
  profileVerified: boolean;
}

export interface CliState {
  vendor: CliVendor;
  /** `default` for the machine-wide sign-in, otherwise the account's name. */
  account: string;
  installed: boolean;
  signedIn: boolean;
  /** Whatever the CLI says about who is signed in — an email, an account type. */
  identity?: string;
}

/** More than this per vendor is a filing system, not a set of accounts. */
export const MAX_ACCOUNTS_PER_VENDOR = 5;

export const DEFAULT_ACCOUNT = 'default';

export const CLI_VENDORS: CliVendor[] = [
  {
    provider_id: 'anthropic',
    binary: 'claude',
    label: 'Claude Code',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
    profileEnv: 'CLAUDE_CONFIG_DIR',
    profileVerified: true,
  },
  {
    provider_id: 'openai-codex',
    binary: 'codex',
    label: 'Codex',
    install: 'npm i -g @openai/codex',
    login: ['login'],
    logout: ['logout'],
    profileEnv: 'CODEX_HOME',
    profileVerified: true,
  },
  {
    provider_id: 'google',
    binary: 'gemini',
    label: 'Gemini',
    install: 'npm i -g @google/gemini-cli',
    // Gemini has no sign-in subcommand: the documented flow is to start the CLI
    // and choose "Sign in with Google", so the terminal is handed to a bare run.
    login: [],
    // It joins `homedir()` with a hardcoded `.gemini` and has no variable of its
    // own, so the home directory is the only lever — and Node reads $HOME first.
    profileEnv: 'HOME',
    profileVerified: true,
  },
  {
    provider_id: 'opencode',
    binary: 'opencode',
    label: 'opencode',
    install: 'npm i -g opencode-ai',
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
    // It keeps auth.json under XDG_DATA_HOME/opencode.
    profileEnv: 'XDG_DATA_HOME',
    profileVerified: true,
  },
];

export function vendorFor(providerId: string): CliVendor | undefined {
  return CLI_VENDORS.find((v) => v.provider_id === providerId);
}

// ── the account registry ────────────────────────────────────────────────────
// Names only. The tokens live in the per-account directories, held by the
// vendor CLIs; nothing secret is written here.

/** Read per call rather than captured at import: the data directory is an
 *  environment variable, and a test that redirects it must be believed. */
function dataDir(): string {
  return process.env.CODEMASTER_DATA_DIR || DATA_DIR;
}

function registryPath(): string {
  return path.join(dataDir(), 'cli-accounts.json');
}

type Registry = Record<string, string[]>;

function readRegistry(): Registry {
  try {
    const r = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as Registry;
    return r && typeof r === 'object' ? r : {};
  } catch {
    return {};
  }
}

function writeRegistry(r: Registry): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(r, null, 2), { mode: 0o600 });
}

/** Every account name for a vendor, the machine-wide one first. */
export function cliAccounts(providerId: string): string[] {
  return [DEFAULT_ACCOUNT, ...(readRegistry()[providerId] ?? [])];
}

/** Where a named account's credential store lives. `default` has none: it is
 *  whatever the CLI uses when CodeMaster sets nothing. */
export function accountDir(providerId: string, account: string): string | undefined {
  if (account === DEFAULT_ACCOUNT) return undefined;
  return path.join(dataDir(), 'cli', providerId, account);
}

/** The environment a spawn needs to act as this account. */
export function accountEnv(providerId: string, account: string): NodeJS.ProcessEnv {
  const dir = accountDir(providerId, account);
  const vendor = vendorFor(providerId);
  if (!dir || !vendor) return process.env;
  fs.mkdirSync(dir, { recursive: true });
  return { ...process.env, [vendor.profileEnv]: dir };
}

export interface AddAccountResult {
  ok: boolean;
  reason?: string;
}

export function addCliAccount(providerId: string, account: string): AddAccountResult {
  if (!vendorFor(providerId)) return { ok: false, reason: `unknown vendor ${providerId}` };
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(account)) {
    return { ok: false, reason: 'name must be letters, digits, dot, dash or underscore' };
  }
  if (account === DEFAULT_ACCOUNT) return { ok: false, reason: `${DEFAULT_ACCOUNT} is the machine-wide sign-in` };
  const reg = readRegistry();
  const names = reg[providerId] ?? [];
  if (names.includes(account)) return { ok: false, reason: 'that name is already taken' };
  if (names.length + 1 >= MAX_ACCOUNTS_PER_VENDOR) {
    // +1 for `default`, which is an account too.
    return { ok: false, reason: `at most ${MAX_ACCOUNTS_PER_VENDOR} accounts per vendor` };
  }
  reg[providerId] = [...names, account];
  writeRegistry(reg);
  fs.mkdirSync(accountDir(providerId, account)!, { recursive: true });
  invalidateCliState();
  return { ok: true };
}

/** Forgets the account and deletes the credential store the vendor wrote for
 *  it. The machine-wide sign-in is never touched. */
export function removeCliAccount(providerId: string, account: string): boolean {
  if (account === DEFAULT_ACCOUNT) return false;
  const reg = readRegistry();
  const names = reg[providerId] ?? [];
  if (!names.includes(account)) return false;
  reg[providerId] = names.filter((n) => n !== account);
  writeRegistry(reg);
  const dir = accountDir(providerId, account);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  invalidateCliState();
  return true;
}

// ── detection ───────────────────────────────────────────────────────────────

const cache = new Map<string, CliState>();
const installedCache = new Map<string, boolean>();

const key = (providerId: string, account: string) => `${providerId}#${account}`;

/** Re-ask after a login or logout; the answer has just changed. */
export function invalidateCliState(providerId?: string): void {
  if (!providerId) {
    cache.clear();
    return;
  }
  for (const k of [...cache.keys()]) if (k.startsWith(`${providerId}#`)) cache.delete(k);
}

export function cliState(providerId: string, account = DEFAULT_ACCOUNT): CliState | undefined {
  const vendor = vendorFor(providerId);
  if (!vendor) return undefined;
  const k = key(providerId, account);
  const hit = cache.get(k);
  if (hit) return hit;
  const state = detect(vendor, account);
  cache.set(k, state);
  return state;
}

/** Every vendor's every account. Spawns one status check per signed-in-capable
 *  account, so this is for the commands that display them, not for hot paths. */
export function allCliStates(): CliState[] {
  const out: CliState[] = [];
  for (const v of CLI_VENDORS) {
    for (const a of cliAccounts(v.provider_id)) out.push(cliState(v.provider_id, a)!);
  }
  return out;
}

/** Whether this vendor's CLI can answer a call right now, on any account. The
 *  machine-wide one is asked first so the common case costs one spawn. */
export function cliSignedIn(providerId: string): boolean {
  for (const a of cliAccounts(providerId)) {
    if (cliState(providerId, a)?.signedIn) return true;
  }
  return false;
}

/** The account this vendor should answer on: the first one signed in. */
export function signedInAccount(providerId: string): string | undefined {
  for (const a of cliAccounts(providerId)) {
    if (cliState(providerId, a)?.signedIn) return a;
  }
  return undefined;
}

function detect(vendor: CliVendor, account: string): CliState {
  const base = { vendor, account };
  if (!installed(vendor.binary)) return { ...base, installed: false, signedIn: false };
  const env = accountEnv(vendor.provider_id, account);
  const who =
    vendor.provider_id === 'anthropic'
      ? parseClaudeStatus(capture('claude', ['auth', 'status'], env))
      : vendor.provider_id === 'openai-codex'
        ? parseCodexStatus(capture('codex', ['login', 'status'], env))
        : vendor.provider_id === 'opencode'
          ? parseOpencodeStatus(capture('opencode', ['auth', 'list'], env))
          : geminiIdentity(env);
  return { ...base, installed: true, ...who };
}

function installed(binary: string): boolean {
  const hit = installedCache.get(binary);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    ok = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
  } catch {
    ok = false;
  }
  installedCache.set(binary, ok);
  return ok;
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

/**
 * `opencode auth list` draws a box: a line per credential, then "N credentials".
 * The count is the reliable part — the provider names are decorated with colour
 * codes and a leading glyph.
 */
export function parseOpencodeStatus(out: string): { signedIn: boolean; identity?: string } {
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  const count = /(\d+)\s+credentials?/i.exec(plain);
  const n = count ? Number(count[1]) : 0;
  if (n === 0) return { signedIn: false };
  const names = [...plain.matchAll(/^[●•*]\s+(\S+)/gm)].map((m) => m[1]!);
  return { signedIn: true, identity: names.length ? names.join(', ') : `${n} provider${n === 1 ? '' : 's'}` };
}

/** Gemini has no status command. Its OAuth cache on disk is the only signal,
 *  so a stale file reads as signed in and the call reports the truth. */
function geminiIdentity(env: NodeJS.ProcessEnv): { signedIn: boolean; identity?: string } {
  const home = env.HOME ?? os.homedir();
  if (fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json'))) {
    return { signedIn: true, identity: 'Google account' };
  }
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  return apiKey ? { signedIn: true, identity: 'API key in the environment' } : { signedIn: false };
}

function saysLoggedIn(out: string): boolean {
  return /logged in/i.test(out) && !/not logged in|no.{0,10}credentials|please (run )?login/i.test(out);
}

function capture(binary: string, args: string[], env: NodeJS.ProcessEnv): string {
  try {
    const r = spawnSync(binary, args, { encoding: 'utf8', timeout: 20_000, env });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
  } catch {
    return '';
  }
}

// ── binding a CLI account to a provider account ─────────────────────────────

/** How a ProviderManager account says "I am this vendor CLI, signed in here". */
export function cliRef(providerId: string, account: string): string {
  return `cli:${providerId}#${account}`;
}

export function parseCliRef(ref: string): { provider_id: string; account: string } | undefined {
  if (!ref.startsWith('cli:')) return undefined;
  const [provider_id, account] = ref.slice(4).split('#');
  if (!provider_id) return undefined;
  return { provider_id, account: account || DEFAULT_ACCOUNT };
}

/**
 * The environment a vendor call should run under, given the credential the
 * caller was handed. A CLI-backed account names its own store; anything else
 * falls back to whichever account of that vendor is signed in, so a call still
 * lands somewhere real when nobody chose.
 */
export function cliEnvFor(providerId: string, credentialRef?: string): NodeJS.ProcessEnv {
  const bound = credentialRef ? parseCliRef(credentialRef) : undefined;
  const account = bound?.account ?? signedInAccount(providerId) ?? DEFAULT_ACCOUNT;
  return accountEnv(providerId, account);
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
export function runOnTerminal(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliRunResult {
  const r = spawnSync(binary, args, { stdio: 'inherit', env });
  if (r.error) return { ok: false, reason: (r.error as NodeJS.ErrnoException).code ?? r.error.message };
  if (r.signal) return { ok: false, reason: `interrupted (${r.signal})` };
  return r.status === 0 ? { ok: true } : { ok: false, reason: `exit ${r.status}` };
}
