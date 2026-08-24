// Call graph builder (spec §5.2.4) — from tree-sitter call edges stored in `calls`.

import { getRepoDb } from '../storage/db.js';

export interface FunctionRef {
  name: string;
  file: string;
  line: number;
}

export class CallGraph {
  constructor(public readonly repoPath: string) {}

  callersOf(fn: string): FunctionRef[] {
    const rows = getRepoDb(this.repoPath)
      .prepare('SELECT DISTINCT caller, file_path, line FROM calls WHERE callee=?')
      .all(fn) as Array<{ caller: string; file_path: string; line: number }>;
    return rows.map((r) => ({ name: r.caller, file: r.file_path, line: r.line }));
  }

  calleesOf(fn: string): FunctionRef[] {
    const rows = getRepoDb(this.repoPath)
      .prepare('SELECT DISTINCT callee, file_path, line FROM calls WHERE caller=?')
      .all(fn) as Array<{ callee: string; file_path: string; line: number }>;
    return rows.map((r) => ({ name: r.callee, file: r.file_path, line: r.line }));
  }

  /** Full forward execution path from an entry function (breadth-first, deduped). */
  callChain(entry: string, maxDepth = 6): Array<{ from: string; to: string }> {
    const db = getRepoDb(this.repoPath);
    const seen = new Set<string>();
    const edges: Array<{ from: string; to: string }> = [];
    let frontier = [entry];
    let depth = 0;
    while (frontier.length && depth < maxDepth) {
      const next: string[] = [];
      for (const fn of frontier) {
        if (seen.has(fn)) continue;
        seen.add(fn);
        const rows = db.prepare('SELECT DISTINCT callee FROM calls WHERE caller=?').all(fn) as Array<{ callee: string }>;
        for (const r of rows) {
          edges.push({ from: fn, to: r.callee });
          if (!seen.has(r.callee)) next.push(r.callee);
        }
      }
      frontier = next;
      depth += 1;
    }
    return edges;
  }

  /** Defined functions with zero callers (dead-code candidates). */
  deadCodeCandidates(): FunctionRef[] {
    const db = getRepoDb(this.repoPath);
    const rows = db
      .prepare(
        `SELECT s.name, s.file_path, s.line_start FROM symbols s
         WHERE s.kind IN ('function','method')
           AND s.name NOT IN (SELECT DISTINCT callee FROM calls)
           AND s.name NOT IN ('main','default','constructor','render','__init__')`,
      )
      .all() as Array<{ name: string; file_path: string; line_start: number }>;
    return rows.map((r) => ({ name: r.name, file: r.file_path, line: r.line_start }));
  }
}

const cache = new Map<string, CallGraph>();
export function callGraph(repoPath: string): CallGraph {
  if (!cache.has(repoPath)) cache.set(repoPath, new CallGraph(repoPath));
  return cache.get(repoPath)!;
}
