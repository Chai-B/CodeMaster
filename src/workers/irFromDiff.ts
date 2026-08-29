// Native unified-diff → IntermediateRepresentation parser (spec §15.1).
// Used by the Codex adapter, whose provider returns raw unified diffs rather
// than structured XML/JSON. Splits a diff blob into per-file patches.

import { now } from '../util/id.js';
import { irFromJson } from './irFromJson.js';
import { REASONING_MARKER } from '../context/outputFormat.js';
import type { FileRef, IntermediateRepresentation, Patch, ProviderRef } from '../types/index.js';

/** Split a unified-diff blob (optionally wrapped in prose/fences) into per-file patches. */
export function splitUnifiedDiff(raw: string): Patch[] {
  const fence = /```(?:diff|patch)?\s*([\s\S]*?)```/.exec(raw);
  const body = fence ? fence[1]! : raw;
  const lines = body.split('\n');
  const patches: Patch[] = [];
  let current: { file: string; lines: string[] } | null = null;

  const flush = () => {
    if (current && current.lines.length) patches.push({ file: current.file, diff: current.lines.join('\n').trim() });
    current = null;
  };

  for (const line of lines) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitHeader) {
      flush();
      current = { file: gitHeader[2]!, lines: [line] };
      continue;
    }
    const plusHeader = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusHeader && (!current || !current.file || current.file === 'unknown')) {
      if (!current) current = { file: plusHeader[1]!, lines: [] };
      else current.file = plusHeader[1]!;
    }
    // Start an implicit patch when a hunk appears without a git header.
    if (!current && (line.startsWith('--- ') || line.startsWith('@@'))) {
      current = { file: 'unknown', lines: [] };
    }
    if (current) current.lines.push(line);
  }
  flush();
  return patches.filter((p) => /^[-+@]|^diff /m.test(p.diff));
}

export function irFromDiff(
  raw: string,
  sessionId: string,
  taskId: string,
  producedBy: ProviderRef,
): IntermediateRepresentation {
  const cut = raw.indexOf(REASONING_MARKER);
  const patches = splitUnifiedDiff(cut < 0 ? raw : raw.slice(0, cut));
  // The reasoning block is advisory: a provider that ignores it still produces a
  // valid result, so a missing or malformed one degrades to the old behaviour
  // rather than failing a response whose patches are perfectly good.
  let extra: IntermediateRepresentation | null = null;
  const tail = cut < 0 ? '' : raw.slice(cut + REASONING_MARKER.length).trim();
  if (tail) {
    try {
      extra = irFromJson(tail, sessionId, taskId, producedBy);
    } catch {
      extra = null;
    }
  }
  // The JSON carries no paths of its own, so every record it produced would be
  // findable by keyword only. The diff says which files the reasoning is about.
  const touched: FileRef[] = patches.filter((p) => p.file !== 'unknown').map((p) => ({ path: p.file }));
  const located = <T extends { affected_files: FileRef[] }>(xs: T[] | undefined): T[] =>
    !xs?.length ? [] : touched.length ? xs.map((x) => ({ ...x, affected_files: touched })) : xs;

  return {
    ir_version: '1.0',
    session_id: sessionId,
    task_id: taskId,
    produced_by: producedBy,
    produced_at: now(),
    status: patches.length ? 'completed' : 'needs_clarification',
    summary: extra?.summary || (patches.length ? `Applied ${patches.length} patch(es)` : 'No diff produced'),
    patches,
    files_created: [],
    files_deleted: [],
    files_renamed: [],
    decisions: located(extra?.decisions),
    observations: located(extra?.observations),
    risks: located(extra?.risks),
    assumptions: located(extra?.assumptions),
    wiki_updates: [],
    wiki_reads: [],
    next_tasks: [],
    blocked_by: [],
    open_questions: [],
    clarification_needed: patches.length ? undefined : 'Provider returned no parseable diff',
    overall_confidence: patches.length ? 0.7 : 0.3,
    raw_output: raw,
  };
}
