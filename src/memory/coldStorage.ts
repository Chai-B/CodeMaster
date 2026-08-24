// Cold storage (spec §19.1, §22.3) — encrypted archive of raw model output.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SESSIONS_DIR } from '../config.js';
import { CredentialManager } from '../providers/credentials.js';

// Reuse the credential machine key for at-rest encryption of archived output.
function key(): Buffer {
  // store/retrieve a dedicated archive key via the credential manager
  let k = CredentialManager.retrieve('__archive__');
  if (!k) {
    k = crypto.randomBytes(32).toString('hex');
    CredentialManager.store('__archive__', k);
  }
  return Buffer.from(k, 'hex');
}

export function archiveRawOutput(sessionId: string, taskId: string, raw: string): void {
  const dir = path.join(SESSIONS_DIR, sessionId, 'cold');
  fs.mkdirSync(dir, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(path.join(dir, `${taskId}.enc`), Buffer.concat([iv, tag, enc]));
}

export function readRawOutput(sessionId: string, taskId: string): string | null {
  const file = path.join(SESSIONS_DIR, sessionId, 'cold', `${taskId}.enc`);
  if (!fs.existsSync(file)) return null;
  try {
    const buf = fs.readFileSync(file);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
