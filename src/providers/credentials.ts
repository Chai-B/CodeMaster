// CredentialManager (spec §22.1) — pluggable credential backend selected by
// config.security.credential_backend: system_keychain | master_password | plaintext.
// No other component ever handles raw credentials.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { CREDENTIALS_DIR, ensureDirs, loadConfig } from '../config.js';

const KEY_FILE = path.join(CREDENTIALS_DIR, '.key');
const INDEX_FILE = path.join(CREDENTIALS_DIR, '.index');

type Backend = 'system_keychain' | 'master_password' | 'plaintext';

function backend(): Backend {
  try {
    return loadConfig().security.credential_backend;
  } catch {
    return 'master_password';
  }
}

// ── shared id index (keeps list() backend-agnostic) ──────────────
function readIndex(): string[] {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as string[];
  } catch {
    return [];
  }
}
function writeIndex(ids: string[]): void {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify([...new Set(ids)]), { mode: 0o600 });
}
function addToIndex(id: string): void {
  writeIndex([...readIndex(), id]);
}
function removeFromIndex(id: string): void {
  writeIndex(readIndex().filter((x) => x !== id));
}

// ── master_password (AES-256-GCM) backend ────────────────────────
function masterKey(): Buffer {
  ensureDirs();
  const pw = process.env.CODEMASTER_MASTER_PASSWORD;
  if (pw) return crypto.scryptSync(pw, 'codemaster-salt', 32);
  if (fs.existsSync(KEY_FILE)) return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'hex');
  const seed = `${os.hostname()}:${os.userInfo().username}:codemaster`;
  const key = crypto.scryptSync(seed, 'codemaster-salt', 32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}
function encStore(id: string, secret: string): void {
  ensureDirs();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(path.join(CREDENTIALS_DIR, `${id}.enc`), Buffer.concat([iv, tag, enc]).toString('base64'), { mode: 0o600 });
}
function encRetrieve(id: string): string | null {
  const file = path.join(CREDENTIALS_DIR, `${id}.enc`);
  if (!fs.existsSync(file)) return null;
  try {
    const buf = Buffer.from(fs.readFileSync(file, 'utf8'), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── system keychain backend (macOS `security`, Linux `secret-tool`) ─
function keychainStore(id: string, secret: string): boolean {
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['add-generic-password', '-U', '-a', 'codemaster', '-s', id, '-w', secret]);
    return r.status === 0;
  }
  if (process.platform === 'linux') {
    const r = spawnSync('secret-tool', ['store', '--label=codemaster', 'service', 'codemaster', 'account', id], { input: secret });
    return r.status === 0;
  }
  return false;
}
function keychainRetrieve(id: string): string | null {
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['find-generic-password', '-a', 'codemaster', '-s', id, '-w']);
    return r.status === 0 ? r.stdout.toString().trim() : null;
  }
  if (process.platform === 'linux') {
    const r = spawnSync('secret-tool', ['lookup', 'service', 'codemaster', 'account', id]);
    return r.status === 0 ? r.stdout.toString().trim() : null;
  }
  return null;
}
function keychainDelete(id: string): void {
  if (process.platform === 'darwin') spawnSync('security', ['delete-generic-password', '-a', 'codemaster', '-s', id]);
  if (process.platform === 'linux') spawnSync('secret-tool', ['clear', 'service', 'codemaster', 'account', id]);
}

export const CredentialManager = {
  store(accountId: string, secret: string): void {
    const b = backend();
    if (b === 'plaintext') {
      ensureDirs();
      fs.writeFileSync(path.join(CREDENTIALS_DIR, `${accountId}.txt`), secret, { mode: 0o600 });
    } else if (b === 'system_keychain') {
      // Fall back to encrypted file if the OS keychain is unavailable.
      if (!keychainStore(accountId, secret)) encStore(accountId, secret);
    } else {
      encStore(accountId, secret);
    }
    addToIndex(accountId);
  },

  retrieve(accountId: string): string | null {
    const b = backend();
    if (b === 'plaintext') {
      const file = path.join(CREDENTIALS_DIR, `${accountId}.txt`);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : encRetrieve(accountId);
    }
    if (b === 'system_keychain') {
      return keychainRetrieve(accountId) ?? encRetrieve(accountId);
    }
    return encRetrieve(accountId);
  },

  delete(accountId: string): void {
    keychainDelete(accountId);
    for (const ext of ['.enc', '.txt']) {
      const file = path.join(CREDENTIALS_DIR, `${accountId}${ext}`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    removeFromIndex(accountId);
  },

  list(): string[] {
    ensureDirs();
    // Union of the id index and any legacy .enc files on disk.
    const fromFiles = fs
      .readdirSync(CREDENTIALS_DIR)
      .filter((f) => f.endsWith('.enc'))
      .map((f) => f.replace(/\.enc$/, ''));
    return [...new Set([...readIndex(), ...fromFiles])];
  },
};
