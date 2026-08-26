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
    if (!r) {
      miss();
      return null;
    }
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
  /** A worker answer, which is text rather than an IR. Same key, same contract. */
  getText(hash: string): { text: string; tokens: number } | null {
    const r = getDb().prepare('SELECT text, tokens FROM text_cache WHERE hash=?').get(hash) as
      | { text: string; tokens: number }
      | undefined;
    if (!r) {
      miss();
      return null;
    }
    getDb().prepare('UPDATE text_cache SET hits=hits+1 WHERE hash=?').run(hash);
    return r;
  },

  putText(hash: string, model: string, text: string, tokens: number): void {
    getDb()
      .prepare('INSERT OR REPLACE INTO text_cache (hash, model_id, text, tokens, created_at, hits) VALUES (?,?,?,?,?,0)')
      .run(hash, model, text, tokens, now());
  },

  /** Hits, the tokens they avoided, and the misses — without which `hits` is a
   *  count with no denominator and the hit rate cannot be computed at all. */
  saved(): { hits: number; tokens: number; misses: number } {
    const r = getDb()
      .prepare(
        `SELECT COALESCE(SUM(hits),0) h, COALESCE(SUM(hits*tokens),0) t FROM (
           SELECT hits, tokens FROM prompt_cache UNION ALL SELECT hits, tokens FROM text_cache)`,
      )
      .get() as { h: number; t: number };
    const m = getDb().prepare("SELECT COALESCE(n,0) n FROM cache_stat WHERE k='miss'").get() as { n: number } | undefined;
    return { hits: r.h, tokens: r.t, misses: m?.n ?? 0 };
  },
};

function miss(): void {
  getDb()
    .prepare("INSERT INTO cache_stat (k, n) VALUES ('miss', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1")
    .run();
}
