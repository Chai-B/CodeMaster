// Memory lifecycle — decay, effective importance, compression trigger (spec §7.6).

import { getDb } from '../storage/db.js';
import { bus } from '../events/bus.js';

export interface DecayInputs {
  importance: number;
  confidence: number;
  reference_count: number;
  created_at: string;
  permanent: boolean;
}

// recency_decay(t) = exp(-0.05 * days_since_creation)
export function recencyDecay(createdAt: string, nowMs = Date.parse(new Date().toISOString())): number {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 1;
  const days = Math.max(0, (nowMs - created) / 86_400_000);
  return Math.exp(-0.05 * days);
}

// effective_importance = importance × confidence × (1 + log(1+refs)) × recency_decay
export function effectiveImportance(m: DecayInputs, nowMs?: number): number {
  if (m.permanent) return Infinity;
  return m.importance * m.confidence * (1 + Math.log(1 + m.reference_count)) * recencyDecay(m.created_at, nowMs);
}

export interface CompressionCandidate {
  id: string;
  summary: string;
  detail: string;
  effective: number;
}

/** Reasoning objects eligible for compression (spec §7.6 trigger). */
export function findCompressionCandidates(threshold: number, ageDays: number): CompressionCandidate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, summary, detail, importance, confidence, reference_count, produced_at
       FROM reasoning WHERE permanent = 0`,
    )
    .all() as Array<{
    id: string; summary: string; detail: string;
    importance: number; confidence: number; reference_count: number; produced_at: string;
  }>;
  const nowMs = Date.parse(new Date().toISOString());
  const cutoff = nowMs - ageDays * 86_400_000;
  return rows
    .filter((r) => Date.parse(r.produced_at) < cutoff)
    .map((r) => ({
      id: r.id,
      summary: r.summary,
      detail: r.detail,
      effective: effectiveImportance(
        { importance: r.importance, confidence: r.confidence, reference_count: r.reference_count, created_at: r.produced_at, permanent: false },
        nowMs,
      ),
    }))
    .filter((c) => c.effective < threshold && c.detail.length > 400);
}

/** Recompute and persist importance for decay (called by scheduled lifecycle run). */
export function applyDecay(): number {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, importance, confidence, reference_count, produced_at, permanent FROM reasoning')
    .all() as Array<{ id: string; importance: number; confidence: number; reference_count: number; produced_at: string; permanent: number }>;
  let updated = 0;
  for (const r of rows) {
    if (r.permanent) continue;
    const eff = effectiveImportance({
      importance: r.importance,
      confidence: r.confidence,
      reference_count: r.reference_count,
      created_at: r.produced_at,
      permanent: false,
    });
    db.prepare('UPDATE reasoning SET importance=? WHERE id=?').run(Math.max(0, Math.min(1, eff)), r.id);
    updated += 1;
  }
  if (updated) bus.emit({ type: 'memory.compressed', count: 0 });
  return updated;
}
