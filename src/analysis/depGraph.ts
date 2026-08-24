// Dependency graph builder (spec §5.2.3) — directed import graph with traversal queries.

import path from 'path';
import { getRepoDb } from '../storage/db.js';

export interface DependencyCycle {
  files: string[];
}

export class DependencyGraph {
  // adjacency: file -> resolved internal imports
  private adj = new Map<string, Set<string>>();
  private rev = new Map<string, Set<string>>();

  constructor(public readonly repoPath: string) {
    this.build();
  }

  private build(): void {
    const db = getRepoDb(this.repoPath);
    const rows = db.prepare('SELECT path, imports_json FROM file_index').all() as Array<{
      path: string;
      imports_json: string;
    }>;
    const known = new Set(rows.map((r) => r.path));
    for (const r of rows) {
      this.adj.set(r.path, new Set());
      this.rev.set(r.path, this.rev.get(r.path) ?? new Set());
    }
    for (const r of rows) {
      let imports: string[] = [];
      try {
        imports = JSON.parse(r.imports_json) as string[];
      } catch {
        imports = [];
      }
      for (const imp of imports) {
        const resolved = resolveImport(r.path, imp, known);
        if (resolved && resolved !== r.path) {
          this.adj.get(r.path)!.add(resolved);
          if (!this.rev.has(resolved)) this.rev.set(resolved, new Set());
          this.rev.get(resolved)!.add(r.path);
        }
      }
    }
    this.persist(db);
  }

  /** Write edges to the dependency_edges table (spec §19.2). */
  private persist(db = getRepoDb(this.repoPath)): void {
    db.exec('DELETE FROM dependency_edges;');
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO dependency_edges (from_file, to_file, import_type, imported_symbols_json) VALUES (?,?,?,?)',
    );
    for (const [from, tos] of this.adj) {
      for (const to of tos) stmt.run(from, to, 'internal', '[]');
    }
  }

  dependencies(file: string, transitive = false): string[] {
    return transitive ? this.reach(file, this.adj) : [...(this.adj.get(file) ?? [])];
  }

  dependents(file: string, transitive = false): string[] {
    return transitive ? this.reach(file, this.rev) : [...(this.rev.get(file) ?? [])];
  }

  /** All potentially affected files when `file` changes (transitive dependents). */
  impactOf(file: string): string[] {
    return this.reach(file, this.rev);
  }

  private reach(start: string, graph: Map<string, Set<string>>): string[] {
    const seen = new Set<string>();
    const stack = [...(graph.get(start) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of graph.get(n) ?? []) if (!seen.has(m)) stack.push(m);
    }
    return [...seen];
  }

  shortestPath(a: string, b: string): string[] | null {
    if (a === b) return [a];
    const prev = new Map<string, string>();
    const q = [a];
    const seen = new Set([a]);
    while (q.length) {
      const cur = q.shift()!;
      for (const next of this.adj.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        prev.set(next, cur);
        if (next === b) {
          const path: string[] = [b];
          let p = b;
          while (prev.has(p)) {
            p = prev.get(p)!;
            path.unshift(p);
          }
          return path;
        }
        q.push(next);
      }
    }
    return null;
  }

  /** Tarjan's strongly-connected components (clusters of size > 1 are cycles). */
  stronglyConnectedComponents(): string[][] {
    let index = 0;
    const indices = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const out: string[][] = [];

    const strongconnect = (v: string): void => {
      indices.set(v, index);
      low.set(v, index);
      index += 1;
      stack.push(v);
      onStack.add(v);
      for (const w of this.adj.get(v) ?? []) {
        if (!indices.has(w)) {
          strongconnect(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, indices.get(w)!));
        }
      }
      if (low.get(v) === indices.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        out.push(comp);
      }
    };

    for (const v of this.adj.keys()) if (!indices.has(v)) strongconnect(v);
    return out;
  }

  cycles(): DependencyCycle[] {
    return this.stronglyConnectedComponents()
      .filter((c) => c.length > 1)
      .map((files) => ({ files }));
  }

  nodeCount(): number {
    return this.adj.size;
  }
  edgeCount(): number {
    let n = 0;
    for (const s of this.adj.values()) n += s.size;
    return n;
  }
}

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.cpp', '.h', '.hpp'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', '__init__.py', 'mod.rs'];
const TS_VARIANTS = ['.ts', '.tsx'];

export function resolveImport(fromFile: string, imp: string, known: Set<string>): string | null {
  if (!imp) return null;
  const dir = path.dirname(fromFile);
  // Candidate base paths (repo-relative). Relative imports anchor at the file's
  // directory; bare/dotted module names (Python/Go/Java) anchor at repo root and
  // the importing file's directory.
  const bases: string[] = [];
  if (imp.startsWith('.')) {
    // Strip Python leading-dot package syntax (e.g. "..pkg.mod") to a path.
    const rel = imp.replace(/^\.+/, (m) => '../'.repeat(Math.max(0, m.length - 1)) || './');
    bases.push(path.normalize(path.join(dir, rel.replace(/\./g, path.sep))));
    bases.push(path.normalize(path.join(dir, imp)));
  } else {
    const asPath = imp.replace(/\./g, path.sep).replace(/^["']|["']$/g, '');
    bases.push(asPath);
    bases.push(path.normalize(path.join(dir, asPath)));
  }
  for (const base of bases) {
    for (const ext of EXTS) {
      const cand = ext ? `${base}${ext}` : base;
      if (known.has(cand)) return cand;
      // TS emits `./Foo.js` specifiers that resolve to Foo.ts *or* Foo.tsx;
      // likewise `./Foo.jsx` -> Foo.tsx. Without .tsx here every import of a
      // React component silently drops its dependency edge.
      for (const v of TS_VARIANTS) {
        const tsVariant = cand.replace(/\.[mc]?jsx?$/, v);
        if (tsVariant !== cand && known.has(tsVariant)) return tsVariant;
      }
    }
    for (const idx of INDEX_FILES) {
      const cand = path.join(base, idx);
      if (known.has(cand)) return cand;
    }
  }
  return null;
}

const cache = new Map<string, DependencyGraph>();
export function dependencyGraph(repoPath: string, rebuild = false): DependencyGraph {
  if (rebuild || !cache.has(repoPath)) cache.set(repoPath, new DependencyGraph(repoPath));
  return cache.get(repoPath)!;
}
