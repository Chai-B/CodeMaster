// PatchApplier — applies unified-diff patches + new files (spec §12.2, deterministic).

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { Patch, NewFile } from '../types/index.js';

export interface ApplyResult {
  applied: string[];
  created: string[];
  failed: Array<{ file: string; reason: string }>;
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
  const result: ApplyResult = { applied: [], created: [], failed: [] };

  for (const nf of newFiles) {
    const full = resolveInRepo(repoPath, nf.path);
    if (!full) {
      result.failed.push({ file: nf.path, reason: 'path resolves outside the repository' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, nf.content, 'utf8');
      result.created.push(nf.path);
    } catch (e) {
      result.failed.push({ file: nf.path, reason: String(e) });
    }
  }

  for (const p of patches) {
    if (!p.diff.trim()) continue;
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
