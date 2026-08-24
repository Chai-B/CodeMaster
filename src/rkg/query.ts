// RKG query engine (spec §6.4) — typed traversal over rkg_nodes/rkg_edges.

import { getRepoDb } from '../storage/db.js';
import type { RKGNode, RKGEdge, RKGNodeType, RKGEdgeType } from './store.js';

const P = <T>(v: unknown, fb: T): T => {
  if (typeof v !== 'string') return fb;
  try {
    return (JSON.parse(v) ?? fb) as T;
  } catch {
    return fb;
  }
};

function rowToNode(r: Record<string, unknown>): RKGNode {
  return {
    id: r.id as string,
    type: r.type as RKGNodeType,
    ref: r.ref as string,
    purpose: (r.purpose as string) ?? undefined,
    responsibilities: P(r.responsibilities_json, [] as string[]),
    architectural_role: (r.architectural_role as string) ?? undefined,
    stability: (r.stability as string) ?? undefined,
    data: P(r.data_json, {} as Record<string, unknown>),
    ast_hash: (r.ast_hash as string) ?? undefined,
  };
}

export class RKGQuery {
  constructor(public readonly repoPath: string) {}

  nodes(type?: RKGNodeType): RKGNode[] {
    const db = getRepoDb(this.repoPath);
    const rows = type
      ? (db.prepare('SELECT * FROM rkg_nodes WHERE type=?').all(type) as Record<string, unknown>[])
      : (db.prepare('SELECT * FROM rkg_nodes').all() as Record<string, unknown>[]);
    return rows.map(rowToNode);
  }

  node(ref: string): RKGNode | null {
    const r = getRepoDb(this.repoPath).prepare('SELECT * FROM rkg_nodes WHERE ref=? LIMIT 1').get(ref) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToNode(r) : null;
  }

  edges(fromRef?: string, type?: RKGEdgeType): RKGEdge[] {
    const db = getRepoDb(this.repoPath);
    let sql = 'SELECT * FROM rkg_edges WHERE 1=1';
    const params: unknown[] = [];
    if (fromRef) {
      sql += ' AND from_ref=?';
      params.push(`file:${fromRef}`);
    }
    if (type) {
      sql += ' AND type=?';
      params.push(type);
    }
    const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      type: r.type as RKGEdgeType,
      from_ref: r.from_ref as string,
      to_ref: r.to_ref as string,
      data: P(r.data_json, {} as Record<string, unknown>),
    }));
  }

  /** Files with no incoming `tests` edge (untested files). */
  filesWithoutTests(): RKGNode[] {
    const db = getRepoDb(this.repoPath);
    const rows = db
      .prepare(
        `SELECT * FROM rkg_nodes WHERE type='file'
         AND id NOT IN (SELECT to_ref FROM rkg_edges WHERE type='tests')
         AND ref NOT LIKE '%.test.%' AND ref NOT LIKE '%.spec.%' AND ref NOT LIKE 'tests/%'`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  /** Files matching an architectural role. */
  filesByRole(role: string): RKGNode[] {
    const rows = getRepoDb(this.repoPath)
      .prepare("SELECT * FROM rkg_nodes WHERE type='file' AND architectural_role=?")
      .all(role) as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  /** Modules a given module depends on (via file-level imports rolled up). */
  moduleDependencies(moduleRef: string): string[] {
    const db = getRepoDb(this.repoPath);
    const containedFiles = (db.prepare("SELECT to_ref FROM rkg_edges WHERE type='contains' AND from_ref=?")
      .all(`module:${moduleRef}`) as Array<{ to_ref: string }>).map((r) => r.to_ref);
    const out = new Set<string>();
    for (const fileRef of containedFiles) {
      const imports = db.prepare("SELECT to_ref FROM rkg_edges WHERE type='imports' AND from_ref=?")
        .all(fileRef) as Array<{ to_ref: string }>;
      for (const imp of imports) {
        const targetPath = imp.to_ref.replace(/^file:/, '');
        const mod = targetPath.split('/')[0]!;
        if (mod !== moduleRef) out.add(mod);
      }
    }
    return [...out];
  }

  /** Task-relevant subgraph (spec §6.4): for each seed file, its architectural
   *  role/purpose plus the files it imports and the files that import it. Gives
   *  the compiler "what this file is for and how it connects" — deterministically
   *  from static edges, enriched with semantic fields when they've been filled. */
  relevantSubgraph(seedFiles: string[]): Map<string, { role?: string; purpose?: string; imports: string[]; importedBy: string[] }> {
    const db = getRepoDb(this.repoPath);
    const impFrom = db.prepare("SELECT to_ref FROM rkg_edges WHERE type='imports' AND from_ref=?");
    const impTo = db.prepare("SELECT from_ref FROM rkg_edges WHERE type='imports' AND to_ref=?");
    const strip = (r: string): string => r.replace(/^file:/, '');
    const out = new Map<string, { role?: string; purpose?: string; imports: string[]; importedBy: string[] }>();
    for (const f of seedFiles) {
      const n = this.node(f);
      const imports = (impFrom.all(`file:${f}`) as Array<{ to_ref: string }>).map((r) => strip(r.to_ref));
      const importedBy = (impTo.all(`file:${f}`) as Array<{ from_ref: string }>).map((r) => strip(r.from_ref));
      out.set(f, {
        role: n?.architectural_role ?? undefined,
        purpose: n?.purpose ?? undefined,
        imports: [...new Set(imports)].slice(0, 8),
        importedBy: [...new Set(importedBy)].slice(0, 8),
      });
    }
    return out;
  }

  /** Test files with a `tests` edge pointing at `file` (reverse of the edge
   *  written in store.ts populateRKG: from_ref=testFile, to_ref=sourceFile). */
  testsFor(file: string): string[] {
    const rows = getRepoDb(this.repoPath)
      .prepare("SELECT from_ref FROM rkg_edges WHERE type='tests' AND to_ref=?")
      .all(`file:${file}`) as Array<{ from_ref: string }>;
    return rows.map((r) => r.from_ref.replace(/^file:/, ''));
  }

  stats(): { nodes: number; edges: number; byType: Record<string, number> } {
    const db = getRepoDb(this.repoPath);
    const nodes = (db.prepare('SELECT COUNT(*) c FROM rkg_nodes').get() as { c: number }).c;
    const edges = (db.prepare('SELECT COUNT(*) c FROM rkg_edges').get() as { c: number }).c;
    const byTypeRows = db.prepare('SELECT type, COUNT(*) c FROM rkg_nodes GROUP BY type').all() as Array<{ type: string; c: number }>;
    const byType: Record<string, number> = {};
    for (const r of byTypeRows) byType[r.type] = r.c;
    return { nodes, edges, byType };
  }
}

const cache = new Map<string, RKGQuery>();
export function rkgQuery(repoPath: string): RKGQuery {
  if (!cache.has(repoPath)) cache.set(repoPath, new RKGQuery(repoPath));
  return cache.get(repoPath)!;
}
