// PatchApplier — applies unified-diff patches + new files (spec §12.2, deterministic).

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { Patch, NewFile, SymbolEdit } from '../types/index.js';
import { findSymbolRange } from '../analysis/treesitter.js';
import { languageOf } from '../analysis/extractors.js';

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

/** What a task is allowed to write. Without this, a run could silently rewrite
 *  the very tests that were supposed to judge it. */
export interface WritePolicy {
  /** Files the task named. A config file inside the locus was asked for; the
   *  same file outside it is the model redecorating the build. */
  locus?: string[];
  /** Only a test task may overwrite an existing test file. */
  isTestTask?: boolean;
}

// Files that decide how the repository is built or judged. Rewriting one of
// these mid-run changes the rules of the game rather than fixing the bug.
const GUARDED = new Set([
  'conftest.py', 'pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml',
  'tsconfig.json', 'package.json', 'jest.config.js', 'jest.config.ts',
  'vitest.config.ts', 'vitest.config.js', 'Cargo.toml', 'go.mod', 'Makefile',
]);

const isTestPath = (rel: string): boolean => {
  const base = rel.split('/').pop() ?? rel;
  return (
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    /_test\.go$/.test(base) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /(^|\/)tests?\//.test(rel)
  );
};

/**
 * Why a write must not happen, or null to allow it. Path containment is checked
 * separately; this is about what the file MEANS, not where it sits.
 */
function refuseWrite(repoPath: string, rel: string, policy: WritePolicy): string | null {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm === '.git' || norm.startsWith('.git/')) return 'refusing to write inside .git';

  const inLocus = (policy.locus ?? []).some((f) => f.replace(/^\.\//, '') === norm);
  const base = norm.split('/').pop() ?? norm;

  if (GUARDED.has(base) && !inLocus && fs.existsSync(path.join(repoPath, norm))) {
    return `${base} decides how this repository is built or tested; it was not part of this task`;
  }
  if (isTestPath(norm) && !policy.isTestTask && fs.existsSync(path.join(repoPath, norm))) {
    return 'refusing to overwrite an existing test — a task may not rewrite the oracle that judges it';
  }
  return null;
}

export async function applyPatches(
  repoPath: string,
  patches: Patch[],
  newFiles: NewFile[],
  policy: WritePolicy = {},
  symbolEdits: SymbolEdit[] = [],
): Promise<ApplyResult> {
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
    const refusal = refuseWrite(repoPath, nf.path, policy);
    if (refusal) {
      result.failed.push({ file: nf.path, reason: refusal });
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
    if (!target) {
      result.failed.push({ file: p.file, reason: 'path resolves outside the repository' });
      continue;
    }
    const refusal = refuseWrite(repoPath, p.file, policy);
    if (refusal) {
      result.failed.push({ file: p.file, reason: refusal });
      continue;
    }
    capture(p.file, target);
    const ok = applyOne(repoPath, p);
    if (ok.success) result.applied.push(p.file);
    else result.failed.push({ file: p.file, reason: ok.reason });
  }

  if (symbolEdits.length > 0) {
    const symRes = await applySymbolEdits(repoPath, symbolEdits, policy);
    for (const f of symRes.applied) {
      if (!result.applied.includes(f)) result.applied.push(f);
    }
    for (const f of symRes.failed) result.failed.push(f);
    for (const u of symRes.undo) {
      if (!result.undo.some((x) => x.path === u.path)) result.undo.push(u);
    }
  }

  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate the character start and end index of a symbol definition within file content.
 * Supports Python (indentation + decorator tracking) and C-family languages (balanced brace matching).
 */
export async function findSymbolSpan(content: string, filePath: string, symbolName: string): Promise<{ start: number; end: number } | null> {
  const lang = languageOf(filePath);
  if (lang) {
    const range = await findSymbolRange(content, lang, symbolName);
    if (range) return { start: range.startIndex, end: range.endIndex };
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.py') {
    const lines = content.split('\n');
    let defLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (new RegExp(`^[ \\t]*(?:async\\s+)?(?:def|class)\\s+${escapeRegex(symbolName)}\\b`).test(line)) {
        defLineIdx = i;
        break;
      }
    }
    if (defLineIdx === -1) return null;
    let startLineIdx = defLineIdx;
    while (startLineIdx > 0 && /^[ \t]*@/.test(lines[startLineIdx - 1]!)) {
      startLineIdx--;
    }
    const indent = lines[defLineIdx]!.match(/^[ \t]*/)?.[0].length ?? 0;
    let endLineIdx = defLineIdx + 1;
    while (endLineIdx < lines.length) {
      const line = lines[endLineIdx]!;
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const curIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
        if (curIndent <= indent) break;
      }
      endLineIdx++;
    }
    let charStart = 0;
    for (let i = 0; i < startLineIdx; i++) charStart += lines[i]!.length + 1;
    let charEnd = charStart;
    for (let i = startLineIdx; i < endLineIdx; i++) charEnd += lines[i]!.length + 1;
    return { start: charStart, end: Math.min(charEnd, content.length) };
  }

  const sym = escapeRegex(symbolName);
  const symRegex = new RegExp(
    `(^|\\n)([ \\t]*(?:/\\*\\*[\\s\\S]*?\\*/[ \\t]*\\n[ \\t]*)?(?:(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|func|fn|pub\\s+fn)\\s+${sym}\\b|(?:(?:public|private|protected|static|async|get|set|readonly)\\s+)*${sym}\\s*(?:<[^>]*>)?\\s*(?:\\(|=>|:|=)))`,
    'm',
  );
  const m = symRegex.exec(content);
  if (!m) return null;
  const start = m.index + (m[1]?.length ?? 0);
  let searchFrom = start + (m[2]?.length ?? 0);

  // If there is a parameter list `(...)` before the body, skip through it
  // so braces inside type annotations (e.g. `items: Array<{ price: number }>`) aren't mistaken for the body.
  const parenStart = content.indexOf('(', searchFrom);
  const firstBrace = content.indexOf('{', searchFrom);
  if (parenStart !== -1 && (firstBrace === -1 || parenStart < firstBrace)) {
    let pDepth = 0;
    for (let i = parenStart; i < content.length; i++) {
      if (content[i] === '(') pDepth++;
      else if (content[i] === ')') {
        pDepth--;
        if (pDepth === 0) {
          searchFrom = i + 1;
          break;
        }
      }
    }
  }

  let braceStart = -1;
  let semiIndex = -1;
  for (let i = searchFrom; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') {
      braceStart = i;
      break;
    } else if (ch === ';') {
      semiIndex = i;
      break;
    }
  }
  if (semiIndex !== -1 && (braceStart === -1 || semiIndex < braceStart)) {
    return { start, end: semiIndex + 1 };
  }
  if (braceStart === -1) return null;

  let depth = 0;
  let inString: string | null = null;
  let inComment = false;
  let inLineComment = false;
  let end = -1;
  for (let i = braceStart; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  return { start, end };
}

export async function applySymbolEdits(
  repoPath: string,
  symbolEdits: SymbolEdit[],
  policy: WritePolicy = {},
): Promise<ApplyResult> {
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

  for (const edit of symbolEdits) {
    const full = resolveInRepo(repoPath, edit.file);
    if (!full) {
      result.failed.push({ file: edit.file, reason: 'path resolves outside the repository' });
      continue;
    }
    const refusal = refuseWrite(repoPath, edit.file, policy);
    if (refusal) {
      result.failed.push({ file: edit.file, reason: refusal });
      continue;
    }
    if (!fs.existsSync(full)) {
      result.failed.push({ file: edit.file, reason: `target file ${edit.file} does not exist for symbol edit` });
      continue;
    }

    try {
      const content = fs.readFileSync(full, 'utf8');
      const span = await findSymbolSpan(content, edit.file, edit.symbol);
      if (!span) {
        result.failed.push({ file: edit.file, reason: `symbol '${edit.symbol}' not found in ${edit.file}` });
        continue;
      }
      capture(edit.file, full);
      const replacement = edit.content.trimEnd() + '\n';
      const newContent = content.slice(0, span.start) + replacement + content.slice(span.end).replace(/^\n/, '');
      fs.writeFileSync(full, newContent, 'utf8');
      result.applied.push(edit.file);
    } catch (e) {
      result.failed.push({ file: edit.file, reason: String(e) });
    }
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
