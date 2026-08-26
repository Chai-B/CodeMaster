// MemoryCompressor worker (spec §7.6, §12.2) — summarize old low-importance reasoning.

import { callLlm } from './llm.js';
import { getDb } from '../storage/db.js';
import { archiveRawOutput } from '../memory/coldStorage.js';
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

const SYSTEM = 'Summarize this reasoning into <=200 tokens, preserving the conclusion and key evidence. Output plain text only.';

export const MemoryCompressorWorker: Worker<CompressInput, CompressResult> = {
  name: 'MemoryCompressor',
  version: '1.0',
  requires_llm: true,
  validate: (i) => ({ ok: true, error: undefined }),
  async execute(input) {
    let n = 0;
    const db = getDb();
    for (const c of input.candidates) {
      const { text } = await callLlm(input.manager, input.cfg, {
        role: 'summarize',
        system: SYSTEM,
        user: `${c.summary}\n\n${c.detail}`,
        sessionId: input.sessionId,
        maxTokens: 300,
      });
      // Archive the full text to cold storage, then replace the active index
      // entry with the summary (spec §7.5).
      archiveRawOutput(input.sessionId, `reasoning-${c.id}`, c.detail);
      db.prepare('UPDATE reasoning SET detail=?, importance=importance*0.5 WHERE id=?').run(text.trim(), c.id);
      n += 1;
    }
    return { compressed: n };
  },
};
