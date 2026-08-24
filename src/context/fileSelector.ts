// FileSelector — deterministic relevant-file ranking (spec §10.3, §12.2, never LLM).

import fs from 'fs';
import path from 'path';
import { testFilesFor } from '../util/testFiles.js';
import { StaticAnalysisAPI } from '../analysis/api.js';
import { estimateTokens } from '../util/tokens.js';
import type { Task } from '../types/index.js';
import { loadConfig } from '../config.js';

export interface SelectedFile {
  path: string;
  score: number;
  content: string;
  tokens: number;
  compressed: boolean;
}

interface Scored {
  path: string;
  score: number;
}

export async function selectFiles(
  api: StaticAnalysisAPI,
  task: Task,
  budgetTokens: number,
  compressionThreshold: number,
): Promise<SelectedFile[]> {
  const scores = new Map<string, number>();
  // Signals accumulate rather than compete. Under `max()`, a file that a task
  // touched weakly from four independent directions scored the same as one that
  // matched a single keyword, so weak-signal convergence never surfaced. Capped
  // just below 1.0 so an accumulation can never outrank a direct mention.
  const bump = (p: string, s: number) => scores.set(p, Math.min(0.98, Math.max(scores.get(p) ?? 0, s) + (scores.has(p) ? s * 0.35 : 0)));

  // Step 1: direct mentions
  const mentioned = task.input_files.map((f) => f.path);
  const fromDesc = extractFilePaths(task.description).concat(extractFilePaths(task.title));
  const direct = [...new Set([...mentioned, ...fromDesc])].filter((p) => fileExists(api.repoPath, p));
  for (const p of direct) bump(p, 1.0);

  // Step 2: dependency graph expansion
  for (const p of direct) {
    for (const dep of api.getDependencies(p)) bump(dep, 0.8);
    if (task.type === 'refactor' || task.type === 'review') {
      for (const dependent of api.getDependents(p)) bump(dependent, 0.6);
    }
  }

  // Step 3a: identifier resolution — every symbol/component name in the task,
  // not just the first few words. Component/class names (PascalCase) rank high
  // so a task that says "match the existing ContactSection" actually pulls that file.
  const desc = `${task.title} ${task.description}`;
  for (const { file, score } of identifierFiles(api, desc)) bump(file, score);

  // Step 3a′: symbol-term matching — connect prose words in the task to symbol
  // NAMES (spec §5.2.5). A bug report saying "serializing the sequence value"
  // resolves to the `serialize_sequence_value` symbol → its file, even though the
  // exact identifier never appears in the text.
  for (const { file, score } of symbolTermFiles(api, desc)) bump(file, score);

  // Step 3b: embedding similarity (real vectors when available)
  if (api.embeddingsReady()) {
    for (const sim of await api.findSimilar(desc, 10)) {
      bump(sim.file, 0.5 + Math.min(0.2, Math.max(0, sim.score) * 0.2));
    }

    // Step 3c: per-symbol embedding similarity (spec §5.2.8) — prose → the exact
    // symbols to edit, even when the wording never matches an identifier. More
    // precise than file-level vectors and the strongest multi-file discovery
    // signal: on a real bug it surfaces the defining file AND the compat/helper
    // files that must change together. These also seed the step-8 expansion.
    for (const sym of await api.findSimilarSymbols(desc, 12)) {
      bump(sym.file, 0.55 + Math.min(0.3, Math.max(0, sym.score) * 0.45));
    }
  }

  // Step 4: git proximity
  for (const p of direct) {
    const co = await api.git.coChangedFiles(p, 15);
    for (const c of co.slice(0, 5)) if (fileExists(api.repoPath, c)) bump(c, 0.4);
  }

  // Step 5: call-graph expansion — when the task names a function, pull its neighbors
  for (const fn of functionSymbols(api, desc)) {
    for (const caller of api.getCallers(fn)) if (fileExists(api.repoPath, caller.file)) bump(caller.file, 0.5);
    for (const callee of api.getCallees(fn)) if (fileExists(api.repoPath, callee.file)) bump(callee.file, 0.6);
  }

  // Step 6: coverage expansion (tests)
  if (task.type === 'test') {
    for (const p of [...scores.keys()]) {
      for (const t of testFilesFor(api.repoPath, p)) bump(t, 0.7);
    }
  }

  // Step 8: multi-file neighbour expansion (spec §5.2.3, §5.2.4, §6.4) — a real
  // fix usually spans the files that reference the edit target's symbols. Pull in
  // the dependents + referencing/calling files of the top source targets.
  if (['debug', 'implement', 'refactor'].includes(task.type)) {
    const topSource = [...scores.entries()]
      .filter(([p]) => relevanceWeight(p, task.type) >= 0.9)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p]) => p);
    const freq = new Map<string, number>();
    const addN = (f: string) => {
      if (f && relevanceWeight(f, task.type) >= 0.9 && fileExists(api.repoPath, f) && !topSource.includes(f)) {
        freq.set(f, (freq.get(f) ?? 0) + 1);
      }
    };
    for (const f of topSource) {
      for (const dep of api.getImpactOf(f)) addN(dep);
      for (const sym of api.symbolsInFile(f, 12)) {
        // Language-server references when a server is installed; ripgrep otherwise.
        for (const file of (await api.findReferencesResolved(sym.name)).slice(0, 12)) addN(file);
        for (const c of api.getCallers(sym.name)) addN(c.file);
      }
    }
    // Bump the most-referenced neighbours (shared symbols → likely part of the fix).
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([f, n]) => bump(f, Math.min(0.72, 0.45 + 0.04 * n)));
  }

  // Step 6b: structural importance. A hub every module imports is more likely to
  // be part of an arbitrary change than an equally-scoring leaf. Kept small — it
  // breaks ties, it does not decide selection.
  if (scores.size > 1) {
    const pr = api.pagerank();
    const top = Math.max(...pr.values(), 0);
    if (top > 0) for (const p of scores.keys()) bump(p, 0.12 * ((pr.get(p) ?? 0) / top));
  }

  // Step 7: budget-aware greedy selection. Apply the source-relevance multiplier
  // so real source outranks docs/examples/scripts/tests for code tasks (spec §6).
  const ranked: Scored[] = [...scores.entries()]
    .map(([p, s]) => ({ path: p, score: s * relevanceWeight(p, task.type) }))
    .sort((a, b) => b.score - a.score);

  // Task keywords drive symbol-slice compression: when a file is too large to
  // include whole, keep the symbol bodies relevant to the task (real logic),
  // not just signatures (spec §5.2.5, §11.4) — richer context at far fewer tokens.
  const kw = [...new Set(contentWords(`${task.title} ${task.description}`).map((w) => stem(w.toLowerCase())))]
    .filter((s) => s.length >= 4);

  const out: SelectedFile[] = [];
  // `context.max_files` was inert: only the token budget capped selection, so a
  // task could receive forty small files it had no use for.
  const maxFiles = loadConfig().context.max_files;
  let used = 0;
  for (const r of ranked) {
    if (out.length >= maxFiles) break;
    const content = readFile(api.repoPath, r.path);
    if (content === null) continue;
    let body = content;
    let compressed = false;
    let toks = estimateTokens(body);
    if (toks > compressionThreshold) {
      body = compressFile(r.path, content, kw);
      compressed = true;
      toks = estimateTokens(body);
    }
    if (used + toks > budgetTokens && out.length > 0) {
      if (!compressed) {
        body = compressFile(r.path, content, kw);
        compressed = true;
        toks = estimateTokens(body);
      }
      // Skip this file, but keep trying lower-ranked (often smaller) files — a
      // single large file must not starve small high-value ones below it.
      if (used + toks > budgetTokens) continue;
    }
    out.push({ path: r.path, score: r.score, content: body, tokens: toks, compressed });
    used += toks;
  }
  return out;
}

const FILE_PATH_RE = /\b([\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|h|hpp|swift|sql|json|yaml|yml|md))\b/g;
function extractFilePaths(text: string): string[] {
  const out: string[] = [];
  for (let m; (m = FILE_PATH_RE.exec(text)); ) out.push(m[1]!);
  return out;
}

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'into', 'have', 'when', 'then', 'them', 'they', 'your', 'should',
  'must', 'will', 'shall', 'where', 'which', 'while', 'using', 'used', 'make', 'made', 'also', 'each',
  'code', 'file', 'files', 'function', 'component', 'method', 'class', 'value', 'return', 'returns',
  'existing', 'reusable', 'create', 'created', 'creates', 'adding', 'matching', 'inline', 'error',
  'errors', 'message', 'messages', 'valid', 'require', 'requires', 'suitable', 'graceful', 'limit',
]);

const isPascal = (w: string): boolean => /^[A-Z][A-Za-z0-9]*$/.test(w);

// Light suffix stemmer so prose ("serializing") matches symbol tokens ("serialize").
function stem(w: string): string {
  let s = w.toLowerCase();
  s = s.replace(/(ization|isation|izing|ising|ations?|ing|ers?|edly|ed|es|ly|ion|s)$/,'');
  return s;
}

function contentWords(desc: string): string[] {
  const words = desc.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.map((w) => w.toLowerCase()))].filter((w) => !STOPWORDS.has(w));
}

/**
 * Files scored by how many DISTINCT stemmed task words match a symbol name defined
 * there (spec §5.2.5 symbol index). Multi-word matches (e.g. sequence+serialize+value
 * → serialize_sequence_value) rank the defining file highly.
 */
function symbolTermFiles(api: StaticAnalysisAPI, desc: string): Array<{ file: string; score: number }> {
  const stems = [...new Set(contentWords(desc).map(stem))].filter((s) => s.length >= 4);
  const fileHits = new Map<string, Set<string>>();
  for (const s of stems) {
    for (const loc of api.fuzzySymbols(s, 40)) {
      if (!fileHits.has(loc.file)) fileHits.set(loc.file, new Set());
      fileHits.get(loc.file)!.add(s);
    }
  }
  const out: Array<{ file: string; score: number }> = [];
  for (const [file, hits] of fileHits) {
    if (hits.size >= 2) out.push({ file, score: Math.min(0.9, 0.35 + 0.18 * hits.size) });
  }
  return out;
}

// Relevance multiplier: prioritise real source over docs/examples/scripts/assets,
// and (for non-test tasks) de-prioritise tests. A code fix should not pull in docs.
function relevanceWeight(p: string, taskType: string): number {
  const s = p.toLowerCase();
  if (/(^|\/)(docs|docs_src|examples?|scripts|site|\.github|node_modules|dist|build)\//.test(s)) return 0.15;
  if (/(^|\/)(tests?|__tests__|spec)\//.test(s) || /(^|\/)(test_[^/]+|[^/]+_test|[^/]+\.test|[^/]+\.spec)\.[a-z]+$/.test(s)) {
    return taskType === 'test' ? 1.0 : 0.35;
  }
  if (/\.(md|mdx|rst|txt|css|html|json|ya?ml)$/.test(s)) return 0.2;
  if (/\.(js|jsx)$/.test(s) && !/\.config\.[jt]s$/.test(s)) return 0.25;
  return 1.0;
}

// All identifiers in the task text resolved to defining files (no word cap).
// PascalCase names (components/classes) and basename matches rank near direct mentions.
function identifierFiles(api: StaticAnalysisAPI, desc: string): Array<{ file: string; score: number }> {
  const ids = [...new Set(desc.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [])].filter(
    (w) => isPascal(w) || (w.length >= 4 && !STOPWORDS.has(w.toLowerCase())),
  );
  const out: Array<{ file: string; score: number }> = [];
  for (const w of ids) {
    const pascal = isPascal(w);
    const defs = api.findDefinition(w);
    if (defs.length) {
      for (const d of defs) out.push({ file: d.file, score: pascal ? 0.8 : 0.6 });
    } else {
      for (const loc of api.fuzzySymbols(w, 3)) out.push({ file: loc.file, score: pascal ? 0.6 : 0.45 });
    }
    // File whose basename matches the identifier (e.g. ContactSection → **/ContactSection.tsx).
    for (const f of api.filesByBaseName(w)) out.push({ file: f, score: pascal ? 0.75 : 0.5 });
  }
  return out;
}

// Identifiers in the task text that resolve to a defined function/method symbol.
function functionSymbols(api: StaticAnalysisAPI, desc: string): string[] {
  const words = [...new Set(desc.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [])];
  const out: string[] = [];
  for (const w of words) {
    if (api.findDefinition(w).some((d) => d.kind === 'function' || d.kind === 'method')) out.push(w);
  }
  return out;
}

function fileExists(repo: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(repo, rel)).isFile();
  } catch {
    return false;
  }
}

function readFile(repo: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(repo, rel), 'utf8');
  } catch {
    return null;
  }
}

const DEF_RE = /^\s*(export\s+|pub\s+|public\s+|private\s+)?(async\s+)?(function|def|func|fn|class|interface|type|struct|enum|trait)\b/;

// Prefer keeping the task-relevant symbol bodies; fall back to bare signatures
// when nothing matches (spec §5.2.5, §11.4).
function compressFile(rel: string, content: string, keywords: string[]): string {
  return symbolSlice(rel, content, keywords) ?? signaturesOnly(rel, content);
}

// Keep only the symbol bodies whose header or body mentions a task keyword —
// real logic for the relevant parts at a fraction of the file's tokens (spec §5.2.5).
export function symbolSlice(rel: string, content: string, keywords: string[]): string | null {
  if (keywords.length === 0) return null;
  const lines = content.split('\n');
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (DEF_RE.test(lines[i]!)) starts.push(i);
  if (starts.length === 0) return null;
  const kept: string[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : lines.length;
    const span = lines.slice(from, to).join('\n');
    const hay = span.toLowerCase();
    if (keywords.some((k) => hay.includes(k))) kept.push(span.trimEnd());
  }
  if (kept.length === 0) return null;
  return `// ${rel} (relevant symbols only)\n${kept.join('\n\n')}`;
}

// Compress a file to its symbol signatures (spec §11.4).
function signaturesOnly(rel: string, content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [`// ${rel} (compressed to signatures)`];
  for (let i = 0; i < lines.length; i++) {
    if (DEF_RE.test(lines[i]!)) kept.push(lines[i]!.trimEnd());
  }
  return kept.length > 1 ? kept.join('\n') : `// ${rel} (${lines.length} lines, omitted)`;
}
