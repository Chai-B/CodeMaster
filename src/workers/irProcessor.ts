// Compression pipeline — IR → persistent structured state (spec §16.2).
// Deterministic: extracts reasoning, applies patches, updates wiki/memory, scores importance.

import { Reasoning, Failures } from '../storage/reasoning.js';
import { Tasks } from '../storage/sessions.js';
import { applyWikiUpdate } from '../wiki/updater.js';
import { applyPatches, type ApplyResult } from './patchApplier.js';
import { Undo } from '../storage/undo.js';
import { createCheckpoint } from './checkpointer.js';
import { indexFile } from '../analysis/indexer.js';
import { bus } from '../events/bus.js';
import { id, now } from '../util/id.js';
import type { IntermediateRepresentation, Session, Task, ReasoningObject } from '../types/index.js';
import type { Config } from '../config.js';

export interface ProcessResult {
  apply: ApplyResult;
  reasoningStored: number;
  wikiUpdated: string[];
  nextTasks: number;
}

export async function processIR(
  ir: IntermediateRepresentation,
  session: Session,
  task: Task,
  cfg: Config,
): Promise<ProcessResult> {
  const repoPath = session.repository.path;

  // 2-3. Reasoning extraction + indexing
  const reasoning: ReasoningObject[] = [
    ...ir.decisions,
    ...ir.observations,
    ...ir.risks,
    ...ir.assumptions,
  ];
  let stored = 0;
  for (const r of reasoning) {
    r.importance = scoreImportance(r);
    if (!dedupes(r)) {
      Reasoning.insert(r);
      task.reasoning_refs.push(r.id);
      if (r.type === 'decision') session.decisions.push(r.id);
      bus.emit({ type: 'reasoning.new', id: r.id, reasoning_type: r.type });
      stored += 1;
    }
  }

  // Pre-risky checkpoint (spec §14.3) — a patch touching many files, a large
  // diff, or any deletion. The configured file threshold was inert; only the
  // hard-coded line count decided.
  const diffLines = ir.patches.reduce((n, p) => n + p.diff.split('\n').length, 0);
  const touched = new Set([...ir.patches.map((p) => p.file), ...ir.files_created.map((f) => f.path)]).size;
  if (diffLines > 200 || touched >= cfg.checkpointing.pre_risky_threshold || ir.files_deleted.length > 0) {
    await createCheckpoint(session, 'pre-risky').catch(() => undefined);
  }

  // 4. Patch processing
  const apply = applyPatches(repoPath, ir.patches, ir.files_created, {
    locus: task.input_files.map((f) => f.path),
    isTestTask: task.type === 'test',
  });
  for (const f of apply.failed) {
    bus.emit({ type: 'log', level: 'warn', message: `Not applied — ${f.file}: ${f.reason}` });
  }
  Undo.record(repoPath, session.id, task.id, ir.summary || task.title, apply.undo);
  for (const f of [...apply.applied, ...apply.created]) {
    await indexFile(repoPath, f);
    if (!session.working_files.some((wf) => wf.path === f)) session.working_files.push({ path: f });
  }

  // Failure memory (spec §8.5)
  if (ir.status === 'failed') {
    Failures.insert({
      id: id('failure'),
      session_id: session.id,
      task_id: task.id,
      approach_attempted: task.title,
      why_it_failed: ir.summary || 'unspecified',
      evidence_of_failure: ir.blocked_by,
      alternatives_suggested: ir.next_tasks.map((t) => t.title),
      affected_files: task.input_files,
      confidence_in_failure_diagnosis: ir.overall_confidence,
      created_at: now(),
      permanent: true,
    });
  }

  // 6. Wiki update
  const wikiUpdated: string[] = [];
  if (cfg.wiki.auto_update) {
    for (const u of ir.wiki_updates) {
      const res = applyWikiUpdate(u, session.id, cfg.wiki.conflict_strategy);
      wikiUpdated.push(`${res.key} (${res.action})`);
      // Contradiction → queue a verification task; keep both entries flagged
      // until a model resolves it (spec §7.6).
      // At most one OPEN resolver per key. The resolution task's own
      // wiki update lands on the same key and is materially different by
      // construction — it is a synthesis of two entries — so it conflicted again
      // and queued another resolver, forever. Measured on a benchmark run: three
      // solver iterations, 106k tokens, on a conflict in a `notes/` entry that
      // had nothing to do with the objective, while the actual code fix cost 41k.
      const title = `Resolve knowledge conflict: ${res.key}`;
      const alreadyQueued = Tasks.forSession(session.id).some(
        (t) => t.title === title && t.status !== 'completed' && t.status !== 'failed',
      );
      if (res.action === 'conflict' && !alreadyQueued) {
        Tasks.insert({
          id: id('task'),
          session_id: session.id,
          title,
          description:
            `Two contradictory updates to wiki entry "${res.key}". The second has been ` +
            `stored and the entry flagged. Decide which is right, or write a single entry ` +
            `that is true of both, and emit ONE wiki update for "${res.key}".\n\n` +
            `## Previously recorded\n${(res.previous ?? '').slice(0, 2000)}\n\n` +
            `## Newly recorded\n${(res.incoming ?? '').slice(0, 2000)}`,
          type: 'verify',
          status: 'pending',
          input_files: [],
          output_files: [],
          dependencies: [],
          blocking: [],
          reasoning_refs: [],
          decision_refs: [],
          estimated_tokens: 0,
          order: 9999,
        });
        bus.emit({ type: 'memory.conflict', object_a: res.key, object_b: res.key });
      }
    }
  }

  // Open questions back into session
  for (const q of ir.open_questions) {
    session.open_questions.push({ id: id('q'), text: q.text, status: 'open' });
  }

  // The raw text is superseded by the parsed IR the moment we get here. It used
  // to be AES-encrypted to disk by a reader that no longer existed, so every
  // response paid a key derivation and a file write to be stored and never read.
  ir.raw_output = undefined;

  return { apply, reasoningStored: stored, wikiUpdated, nextTasks: ir.next_tasks.length };
}

// Importance scoring (spec §16.7) — decisions/risks weigh higher.
function scoreImportance(r: ReasoningObject): number {
  let base = r.confidence * 0.6;
  if (r.type === 'decision') base += 0.3;
  if (r.type === 'risk') base += 0.25;
  if (r.permanent) base += 0.1;
  return Math.min(1, base);
}

// Deduplication (spec §8.3) — near-identical summary already stored this session.
function dedupes(r: ReasoningObject): boolean {
  const existing = Reasoning.search(r.summary.slice(0, 40), 3);
  for (const e of existing) {
    if (e.type === r.type && jaccard(e.summary, r.summary) > 0.85) {
      Reasoning.incrementReference(e.id);
      bus.emit({ type: 'reasoning.merged', from: r.id, into: e.id });
      return true;
    }
  }
  return false;
}

function jaccard(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/));
  const sb = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 1;
}
