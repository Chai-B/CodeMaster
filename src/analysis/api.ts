// StaticAnalysisAPI — single typed query surface over deterministic tooling (spec §5.4).

import { getRepoDb } from '../storage/db.js';
import { GitWorker, type ChangedFile } from './git.js';
import { search as rgSearch, type SearchResult, type SearchOptions } from './ripgrep.js';
import { indexRepository, indexFile, getIndexStats, type IndexStats } from './indexer.js';
import { generateRepositoryMap, renderRepositoryMap, type RepositoryMap } from './repoMap.js';
import { dependencyGraph, type DependencyCycle } from './depGraph.js';
import { callGraph, type FunctionRef } from './callGraph.js';
import { findSimilarFiles, indexFileEmbedding, indexSymbolEmbeddings, findSimilarSymbols, embavailable, embeddingCount, type SimilarFile, type SimilarSymbol } from './embeddings.js';
import { importCoverage, getCoverage, getUncoveredFunctions, type CoverageReport } from './coverage.js';
import { lspClient, type Location } from './lsp.js';
import { populateRKG } from '../rkg/store.js';
import { rkgQuery } from '../rkg/query.js';
import { isTestFile, testFilesFor } from '../util/testFiles.js';
import fs from 'fs';
import path from 'path';

export interface SymbolLocation {
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
}

export class StaticAnalysisAPI {
  readonly git: GitWorker;
  constructor(public readonly repoPath: string) {
    this.git = new GitWorker(repoPath);
  }

  // ── Indexing ──────────────────────────────────────────────
  async reindex(opts: { embed?: boolean } = {}): Promise<IndexStats> {
    const stats = await indexRepository(this.repoPath);
    dependencyGraph(this.repoPath, true);
    populateRKG(this.repoPath);
    importCoverage(this.repoPath);
    this.setDerivedStale(false);
    if (opts.embed && (await embavailable())) await this.embedAll();
    return stats;
  }

  /** Whether the RKG and coverage stores have fallen behind the file index.
   *
   *  `reindex` rebuilds every derived store; `indexFile` rebuilds only the two
   *  cheap ones, because rebuilding the graph once per file would cost more
   *  than the whole task. So the gap is recorded instead of paid for, and the
   *  one place it changes an answer — compiling a prompt — settles it first. */
  derivedStale(): boolean {
    const row = getRepoDb(this.repoPath)
      .prepare("SELECT value FROM repo_meta WHERE key='derived_stale'")
      .get() as { value: string } | undefined;
    return !!row;
  }

  private setDerivedStale(stale: boolean): void {
    const db = getRepoDb(this.repoPath);
    if (stale) db.prepare('INSERT OR REPLACE INTO repo_meta (key, value) VALUES (?,?)').run('derived_stale', new Date().toISOString());
    else db.prepare("DELETE FROM repo_meta WHERE key='derived_stale'").run();
  }

  rkg() {
    return rkgQuery(this.repoPath);
  }
  rebuildRKG(): { nodes: number; edges: number } {
    const r = populateRKG(this.repoPath);
    importCoverage(this.repoPath);
    this.setDerivedStale(false);
    return r;
  }
  async indexFile(rel: string): Promise<void> {
    await indexFile(this.repoPath, rel);
    dependencyGraph(this.repoPath, true);
    this.setDerivedStale(true);
  }
  stats(): IndexStats | null {
    return getIndexStats(this.repoPath);
  }

  async embedAll(): Promise<number> {
    if (!(await embavailable())) return 0;
    const db = getRepoDb(this.repoPath);
    const files = db.prepare('SELECT path FROM file_index').all() as Array<{ path: string }>;
    let n = 0;
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(this.repoPath, f.path), 'utf8');
        await indexFileEmbedding(this.repoPath, f.path, content);
        n += 1;
      } catch {
        /* skip */
      }
    }
    await indexSymbolEmbeddings(this.repoPath);
    return n;
  }

  /** Semantic symbol search (spec §5.2.8) — prose query → most similar symbols. */
  async findSimilarSymbols(query: string, topK = 12): Promise<SimilarSymbol[]> {
    return findSimilarSymbols(this.repoPath, query, topK);
  }
  embeddingsReady(): boolean {
    return embeddingCount(this.repoPath) > 0;
  }

  // ── Symbol queries ────────────────────────────────────────
  findDefinition(symbol: string): SymbolLocation[] {
    const rows = getRepoDb(this.repoPath)
      .prepare('SELECT name, kind, file_path, line_start, signature FROM symbols WHERE name=?')
      .all(symbol) as Array<Record<string, unknown>>;
    return rows.map(toSymbol);
  }

  fuzzySymbols(query: string, limit = 20): SymbolLocation[] {
    const rows = getRepoDb(this.repoPath)
      .prepare('SELECT name, kind, file_path, line_start, signature FROM symbols WHERE name LIKE ? LIMIT ?')
      .all(`%${query}%`, limit) as Array<Record<string, unknown>>;
    return rows.map(toSymbol);
  }

  /** Indexed files whose basename (without extension) equals `name` — e.g. a
   *  component name like "ContactSection" → src/.../ContactSection.tsx (spec §10.3). */
  filesByBaseName(name: string): string[] {
    const rows = getRepoDb(this.repoPath)
      .prepare('SELECT path FROM file_index')
      .all() as Array<{ path: string }>;
    const lower = name.toLowerCase();
    return rows
      .filter((r) => {
        const base = r.path.split('/').pop() ?? r.path;
        return base.replace(/\.[^.]+$/, '').toLowerCase() === lower;
      })
      .map((r) => r.path);
  }

  findReferences(symbol: string): SearchResult[] {
    return rgSearch(this.repoPath, `\\b${symbol}\\b`, { maxResults: 100 });
  }

  /**
   * Use sites of a symbol, resolved by the language server when one is already
   * installed for that language, and by ripgrep otherwise. The server knows the
   * difference between a call and a same-named local; ripgrep does not, so the
   * selector was pulling in files that merely mentioned the word.
   *
   * The method comes back with the files because the two are not the same
   * evidence: an `lsp` hit is a resolved reference, a `ripgrep` hit is a file
   * containing the word. Returning them indistinguishably let a guess be
   * spent as though it were a fact.
   */
  async findReferencesResolved(symbol: string): Promise<{ files: string[]; method: 'lsp' | 'ripgrep' }> {
    const def = this.findDefinition(symbol)[0];
    const lang = def ? langOf(def.file) : null;
    if (def && lang && def.line) {
      const client = await lspClient(this.repoPath, lang).catch(() => null);
      if (client) {
        // The request must point at the symbol's own column: column 1 is the
        // `def`/`export` keyword, and a server asked about a keyword answers
        // with nothing.
        const col = this.symbolColumn(def.file, def.line, symbol);
        const locs = await client.references(def.file, def.line, col).catch(() => []);
        const rel = [...new Set(locs.map((l) => this.toRepoRelative(l.file)))].filter(
          (f): f is string => f !== null,
        );
        if (rel.length) return { files: rel, method: 'lsp' };
      }
    }
    return { files: [...new Set(this.findReferences(symbol).map((r) => r.file))], method: 'ripgrep' };
  }

  /** 1-based column of `symbol` on its definition line, 1 when not found. */
  private symbolColumn(file: string, line: number, symbol: string): number {
    try {
      const text = fs.readFileSync(path.join(this.repoPath, file), 'utf8').split('\n')[line - 1] ?? '';
      const i = text.indexOf(symbol);
      return i >= 0 ? i + 1 : 1;
    } catch {
      return 1;
    }
  }

  /** Language servers answer with absolute paths; everything else in the engine
   *  speaks repo-relative, so an unconverted hit was being dropped as missing. */
  private toRepoRelative(file: string): string | null {
    if (!path.isAbsolute(file)) return file;
    const rel = path.relative(this.repoPath, file);
    return rel && !rel.startsWith('..') ? rel : null;
  }

  /** Key symbols (functions/classes/methods/types) defined in a file — used to
   *  find the files that reference them (multi-file surface, spec §5.2.5, §6.4). */
  symbolsInFile(file: string, limit = 25): SymbolLocation[] {
    const rows = getRepoDb(this.repoPath)
      .prepare(
        `SELECT name, kind, file_path, line_start, signature FROM symbols
         WHERE file_path=? AND kind IN ('function','class','method','interface','type') LIMIT ?`,
      )
      .all(file, limit) as Array<Record<string, unknown>>;
    return rows.map(toSymbol);
  }

  async findSimilar(query: string, topK = 8): Promise<SimilarFile[]> {
    return findSimilarFiles(this.repoPath, query, topK);
  }

  // ── Dependency graph ──────────────────────────────────────
  getDependencies(file: string, transitive = false): string[] {
    return dependencyGraph(this.repoPath).dependencies(file, transitive);
  }
  getDependents(file: string, transitive = false): string[] {
    return dependencyGraph(this.repoPath).dependents(file, transitive);
  }
  getImpactOf(file: string): string[] {
    return dependencyGraph(this.repoPath).impactOf(file);
  }

  /** Existing test files that cover the given changed files (spec §12.2) — union
   *  of RKG tests-edges, dependents-filtered-to-tests, and on-disk sibling probes,
   *  deduped and existence-checked. Drives deterministic behavioral verification. */
  relevantTests(changedFiles: string[]): string[] {
    const out = new Set<string>();
    const rkg = this.rkg();
    for (const f of changedFiles) {
      for (const t of rkg.testsFor(f)) out.add(t);
      // Transitive, not one hop: a suite that does `from pkg import thing`
      // depends on `pkg/__init__.py`, which depends on the module that was
      // actually changed. One hop finds neither, so a real pre-existing oracle
      // reads as "no relevant tests" for most Python packages.
      for (const dep of this.getImpactOf(f)) if (isTestFile(dep)) out.add(dep);
      for (const sib of testFilesFor(this.repoPath, f)) out.add(sib);
    }
    return [...out].filter((t) => fs.existsSync(path.join(this.repoPath, t)));
  }
  /** Structural importance of every file (see DependencyGraph.pagerank). */
  pagerank(): Map<string, number> {
    return dependencyGraph(this.repoPath).pagerank();
  }
  getCycles(): DependencyCycle[] {
    return dependencyGraph(this.repoPath).cycles();
  }
  shortestPath(a: string, b: string): string[] | null {
    return dependencyGraph(this.repoPath).shortestPath(a, b);
  }

  // ── Call graph ────────────────────────────────────────────
  getCallers(fn: string): FunctionRef[] {
    return callGraph(this.repoPath).callersOf(fn);
  }
  getCallees(fn: string): FunctionRef[] {
    return callGraph(this.repoPath).calleesOf(fn);
  }
  getCallChain(entry: string): Array<{ from: string; to: string }> {
    return callGraph(this.repoPath).callChain(entry);
  }
  getDeadCode(): FunctionRef[] {
    return callGraph(this.repoPath).deadCodeCandidates();
  }

  // ── Coverage ──────────────────────────────────────────────
  getCoverage(file?: string): CoverageReport[] {
    return getCoverage(this.repoPath, file);
  }
  getUncoveredFunctions(): Array<{ name: string; file: string; line: number }> {
    return getUncoveredFunctions(this.repoPath);
  }

  // ── LSP (semantic, optional) ──────────────────────────────
  async lspDefinition(file: string, line: number, character: number, language: string): Promise<Location[]> {
    const client = await lspClient(this.repoPath, language);
    return client ? client.definition(path.join(this.repoPath, file), line, character) : [];
  }
  async lspReferences(file: string, line: number, character: number, language: string): Promise<Location[]> {
    const client = await lspClient(this.repoPath, language);
    return client ? client.references(path.join(this.repoPath, file), line, character) : [];
  }

  // ── Repository overview ───────────────────────────────────
  getRepositoryMap(depth = 2): RepositoryMap {
    return generateRepositoryMap(this.repoPath, depth);
  }
  renderRepositoryMap(maxModules = 15): string {
    return renderRepositoryMap(this.getRepositoryMap(), maxModules);
  }

  // ── Temporal queries (spec §5.2.6, §5.4) ──────────────────
  async getChangedFilesSince(ref: string): Promise<ChangedFile[]> {
    return this.git.changedFilesSince(ref);
  }
  async getDiffSince(ref: string): Promise<string> {
    return this.git.diffSince(ref);
  }
  async getDiff(a: string, b: string): Promise<string> {
    return this.git.diffBetween(a, b);
  }
  async getWorkingDiff(paths?: string[]): Promise<string> {
    return this.git.fullWorkingDiff(paths);
  }
  async getBlame(file: string): Promise<string> {
    return this.git.blame(file);
  }
  async getStashList(): Promise<string[]> {
    return this.git.stashList();
  }
  async getBranchStatus(): Promise<{ branch: string; ahead: number; behind: number; tracking: string | null }> {
    return this.git.branchStatus();
  }

  // ── Module summary (spec §5.4 getModuleSummary) ───────────
  getModuleSummary(module: string): { name: string; languages: string[]; files: number; key_files: string[]; dependencies: string[] } | null {
    const map = this.getRepositoryMap();
    const m = map.top_level_modules.find((x) => x.name === module);
    if (!m) return null;
    const deps = new Set<string>();
    for (const f of m.key_files) for (const d of this.getDependencies(f, false)) deps.add(d);
    return {
      name: m.name,
      languages: m.languages,
      files: m.files,
      key_files: m.key_files,
      dependencies: [...deps],
    };
  }

  // ── Search ────────────────────────────────────────────────
  search(pattern: string, options?: SearchOptions): SearchResult[] {
    return rgSearch(this.repoPath, pattern, options);
  }
}

function langOf(file: string): string | null {
  const ext = file.slice(file.lastIndexOf('.'));
  return { '.py': 'python', '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.rs': 'rust', '.go': 'go' }[ext] ?? null;
}

function toSymbol(r: Record<string, unknown>): SymbolLocation {
  return {
    name: r.name as string,
    kind: r.kind as string,
    file: r.file_path as string,
    line: (r.line_start as number) ?? 0,
    signature: (r.signature as string) ?? '',
  };
}

const cache = new Map<string, StaticAnalysisAPI>();
export function staticAnalysis(repoPath: string): StaticAnalysisAPI {
  let api = cache.get(repoPath);
  if (!api) {
    api = new StaticAnalysisAPI(repoPath);
    cache.set(repoPath, api);
  }
  return api;
}
