// Answers already paid for (token discipline W4: never ask the same reasoning
// twice). The key is the compiled prompt itself, which embeds the task, the
// selected files and their current contents — so a hit means the model would be
// asked a question it has already answered against an identical working tree,
// and the honest thing to do is reuse the answer rather than buy it again.

import crypto from 'crypto';
import { getDb } from './db.js';
import { now } from '../util/id.js';
import type { IntermediateRepresentation } from '../types/index.js';

/**
 * The trailing `<!-- Profile: ... Compiled: <ISO ms> ... -->` manifest is
 * diagnostics, not content, and its timestamp is unique to the millisecond.
 * Hashing it gave this cache a 0% hit rate by construction — every lookup
 * missed, forever, however identical the actual question was.
 */
function withoutManifest(body: string): string {
  return body.replace(/\n*<!-- Profile:[\s\S]*?-->\s*$/, '');
}

export function promptHash(body: string, model: string): string {
  return crypto.createHash('sha256').update(`${model}\n${withoutManifest(body)}`).digest('hex').slice(0, 32);
}

export const PromptCache = {
  get(hash: string): { ir: IntermediateRepresentation; tokens: number } | null {
    const r = getDb().prepare('SELECT ir_json, tokens FROM prompt_cache WHERE hash=?').get(hash) as
      | { ir_json: string; tokens: number }
      | undefined;
    if (!r) return null;
    getDb().prepare('UPDATE prompt_cache SET hits=hits+1 WHERE hash=?').run(hash);
    try {
      return { ir: JSON.parse(r.ir_json) as IntermediateRepresentation, tokens: r.tokens };
    } catch {
      return null;
    }
  },

  put(hash: string, model: string, ir: IntermediateRepresentation, tokens: number): void {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO prompt_cache (hash, model_id, ir_json, tokens, created_at, hits) VALUES (?,?,?,?,?,0)',
      )
      .run(hash, model, JSON.stringify(ir), tokens, now());
  },

  /** Tokens never spent because a cached answer was reused. */
  saved(): { hits: number; tokens: number } {
    const r = getDb()
      .prepare('SELECT COALESCE(SUM(hits),0) h, COALESCE(SUM(hits*tokens),0) t FROM prompt_cache')
      .get() as { h: number; t: number };
    return { hits: r.h, tokens: r.t };
  },
};
