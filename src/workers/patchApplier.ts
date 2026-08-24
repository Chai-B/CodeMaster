// PatchApplier — applies unified-diff patches + new files (spec §12.2, deterministic).

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { Patch, NewFile } from '../types/index.js';

export interface ApplyResult {
  applied: string[];
  created: string[];
  failed: Array<{ file: string; reason: string }>;
  /** What each touched file held before this run. `null` means it did not
   *  exist. Recorded so `/undo` can put the tree back exactly, without
   *  discarding edits the tool did not make. */
  undo: Array<{ path: string; before: string | null }>;
}

/**
 * Resolve a model-supplied path inside the repository, or null if it escapes.
 * `path.join` does not treat an absolute second argument as absolute, so an
 * absolute or `../`-prefixed path silently wrote outside the repo.
 */
function resolveInRepo(repoPath: string, rel: string): string | null {
  const root = path.resolve(repoPath);
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

export function applyPatches(repoPath: string, patches: Patch[], newFiles: NewFile[]): ApplyResult {
  const result: ApplyResult = { applied: [], created: [], failed: [], undo: [] };
  const capture = (rel: string, full: string): void => {
    if (result.undo.some((u) => u.path === rel)) return;
    let before: string | null = null;
    try {
      before = fs.readFileSync(full, 'utf8');
    } catch {
      before = null;
    }
    result.undo.push({ path: rel, before });
  };

  for (const nf of newFiles) {
    const full = resolveInRepo(repoPath, nf.path);
    if (!full) {
      result.failed.push({ file: nf.path, reason: 'path resolves outside the repository' });
      continue;
    }
    try {
      capture(nf.path, full);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // Trailing newline: the IR parser trims the tag body, so every generated
      // file landed without one and showed up as "\ No newline at end of file"
      // in its own diff and in every diff after it.
      fs.writeFileSync(full, nf.content.endsWith('\n') ? nf.content : `${nf.content}\n`, 'utf8');
      result.created.push(nf.path);
    } catch (e) {
      result.failed.push({ file: nf.path, reason: String(e) });
    }
  }

  for (const p of patches) {
    if (!p.diff.trim()) continue;
    const target = resolveInRepo(repoPath, p.file);
    if (target) capture(p.file, target);
    const ok = applyOne(repoPath, p);
    if (ok.success) result.applied.push(p.file);
    else result.failed.push({ file: p.file, reason: ok.reason });
  }

  return result;
}

function applyOne(repoPath: string, patch: Patch): { success: boolean; reason: string } {
  const diff = normalizeDiff(patch);
  // Try git apply with progressively looser settings.
  for (const args of [
    ['apply', '--whitespace=nowarn'],
    ['apply', '--3way', '--whitespace=nowarn'],
    ['apply', '--whitespace=nowarn', '--unidiff-zero'],
    ['apply', '--reject', '--whitespace=nowarn'],
  ]) {
    const r = spawnSync('git', args, { cwd: repoPath, input: diff, encoding: 'utf8' });
    if (r.status === 0) return { success: true, reason: '' };
  }
  return { success: false, reason: 'git apply failed (patch did not match working tree)' };
}

function normalizeDiff(patch: Patch): string {
  let d = patch.diff.trim();
  // Ensure the diff has file headers; if the model omitted them, synthesize.
  if (!/^---\s/m.test(d) || !/^\+\+\+\s/m.test(d)) {
    d = `--- a/${patch.file}\n+++ b/${patch.file}\n${d}`;
  }
  return d.endsWith('\n') ? d : d + '\n';
}
