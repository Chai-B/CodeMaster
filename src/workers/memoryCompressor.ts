// MemoryCompressor worker (spec §7.6, §12.2) — summarize old low-importance reasoning.

import { callLlm } from './llm.js';
import { getDb } from '../storage/db.js';
import type { Worker } from './base.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';

export interface CompressInput {
  sessionId: string;
  manager: ProviderManager;
  cfg: Config;
  candidates: Array<{ id: string; summary: string; detail: string }>;
}

export interface CompressResult {
  compressed: number;
}

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';

const SYSTEM = 'Summarize this reasoning into <=200 tokens, preserving the conclusion and key evidence. Output plain text only.';

export const MemoryCompressorWorker: Worker<CompressInput, CompressResult> = {
  name: 'MemoryCompressor',
  version: '1.0',
  requires_llm: true,
  validate: (i) => ({ ok: true, error: undefined }),
  async execute(input) {
    let n = 0;
    const db = getDb();
    const archiveDir = path.join(DATA_DIR, 'archive', 'reasoning');
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
    } catch {
      /* best effort */
    }

    for (const c of input.candidates) {
      // Non-destructive compression: archive the full raw candidate first
      try {
        const archiveFile = path.join(archiveDir, `${c.id}.json`);
        fs.writeFileSync(
          archiveFile,
          JSON.stringify({ id: c.id, summary: c.summary, detail: c.detail, archived_at: new Date().toISOString() }, null, 2),
          'utf8',
        );
      } catch {
        /* archiving is best-effort */
      }

      const { text } = await callLlm(input.manager, input.cfg, {
        role: 'summarize',
        system: SYSTEM,
        user: `${c.summary}\n\n${c.detail}`,
        sessionId: input.sessionId,
        maxTokens: 300,
      });
      db.prepare('UPDATE reasoning SET detail=?, importance=importance*0.5 WHERE id=?').run(text.trim(), c.id);
      n += 1;
    }
    return { compressed: n };
  },
};
