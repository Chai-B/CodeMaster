// Repository Knowledge Graph store + population (spec §6).
// Deterministic fields from static analysis; semantic fields (purpose/responsibilities/
// architectural_role) are LLM-filled later by ModuleSummarizer and stored permanently.

import path from 'path';
import { getRepoDb } from '../storage/db.js';
import { id, now } from '../util/id.js';
import { isTestFile } from '../util/testFiles.js';

export type RKGNodeType = 'file' | 'module' | 'function' | 'class' | 'concept' | 'decision' | 'convention';

export type RKGEdgeType =
  | 'imports'
  | 'tests'
  | 'implements'
  | 'depends_on'
  | 'governed_by'
  | 'follows'
  | 'documents'
  | 'supersedes'
  | 'conflicts_with'
  | 'calls'
  | 'contains';

export interface RKGNode {
  id: string;
  type: RKGNodeType;
  ref: string; // path, symbol name, decision id, etc.
  purpose?: string;
  responsibilities?: string[];
  architectural_role?: string;
  stability?: string;
  data?: Record<string, unknown>;
  ast_hash?: string;
}

export interface RKGEdge {
  id: string;
  type: RKGEdgeType;
  from_ref: string;
  to_ref: string;
  data?: Record<string, unknown>;
}

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(v: unknown, fb: T): T => {
  if (typeof v !== 'string') return fb;
  try {
    return (JSON.parse(v) ?? fb) as T;
  } catch {
    return fb;
  }
};

export const RKG = {
  upsertNode(node: RKGNode): void {
    getRepoDb(repoPathOf()).prepare(
      `INSERT INTO rkg_nodes (id, type, ref, purpose, responsibilities_json, architectural_role, stability, data_json, ast_hash, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET purpose=excluded.purpose, responsibilities_json=excluded.responsibilities_json,
         architectural_role=excluded.architectural_role, stability=excluded.stability, data_json=excluded.data_json,
         ast_hash=excluded.ast_hash, updated_at=excluded.updated_at`,
    ).run(node.id, node.type, node.ref, node.purpose ?? null, J(node.responsibilities), node.architectural_role ?? null,
      node.stability ?? null, J(node.data), node.ast_hash ?? null, now());
  },
};

// The RKG operates on the active repo; callers set it via populateRKG(repoPath).
let _activeRepo = process.cwd();
function repoPathOf(): string {
  return _activeRepo;
}

function nodeId(type: RKGNodeType, ref: string): string {
  return `${type}:${ref}`;
}

export function populateRKG(repoPath: string): { nodes: number; edges: number } {
  _activeRepo = repoPath;
  const db = getRepoDb(repoPath);
  db.exec('DELETE FROM rkg_nodes; DELETE FROM rkg_edges; DELETE FROM module_index;');

  const insNode = db.prepare(
    `INSERT OR REPLACE INTO rkg_nodes (id, type, ref, purpose, responsibilities_json, architectural_role, stability, data_json, ast_hash, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const insEdge = db.prepare(
    'INSERT INTO rkg_edges (id, type, from_ref, to_ref, data_json) VALUES (?,?,?,?,?)',
  );

  const files = db.prepare('SELECT path, language, exports_json, imports_json, ast_hash FROM file_index').all() as Array<{
    path: string; language: string; exports_json: string; imports_json: string; ast_hash: string;
  }>;

  let nodes = 0;
  let edges = 0;

  // File nodes
  for (const f of files) {
    insNode.run(nodeId('file', f.path), 'file', f.path, null, null, classifyRole(f.path), null,
      J({ language: f.language, exports: P(f.exports_json, []) }), f.ast_hash, now());
    nodes += 1;
    // test edges
    if (isTestFile(f.path)) {
      const target = guessTestTarget(f.path, new Set(files.map((x) => x.path)));
      if (target) {
        insEdge.run(id('e'), 'tests', nodeId('file', f.path), nodeId('file', target), null);
        edges += 1;
      }
    }
  }

  // Module nodes (top-level dirs) + module_index
  const modules = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.path.split(path.sep);
    const mod = parts.length > 1 ? parts[0]! : '.';
    if (!modules.has(mod)) modules.set(mod, []);
    modules.get(mod)!.push(f.path);
  }
  const insMod = db.prepare(
    'INSERT OR REPLACE INTO module_index (path, name, file_count, key_files_json, last_indexed) VALUES (?,?,?,?,?)',
  );
  for (const [mod, modFiles] of modules) {
    insNode.run(nodeId('module', mod), 'module', mod, null, null, null, 'evolving', J({ file_count: modFiles.length }), null, now());
    nodes += 1;
    insMod.run(mod, mod, modFiles.length, J(modFiles.slice(0, 5)), now());
    for (const f of modFiles) {
      insEdge.run(id('e'), 'contains', nodeId('module', mod), nodeId('file', f), null);
      edges += 1;
    }
  }

  // Symbol nodes (functions/classes)
  const symbols = db.prepare("SELECT name, kind, file_path FROM symbols WHERE kind IN ('function','class','method','interface','type')").all() as Array<{ name: string; kind: string; file_path: string }>;
  const symNodeTypes: Record<string, RKGNodeType> = { function: 'function', method: 'function', class: 'class', interface: 'class', type: 'class' };
  for (const s of symbols) {
    const t = symNodeTypes[s.kind] ?? 'function';
    insNode.run(nodeId(t, `${s.file_path}#${s.name}`), t, `${s.file_path}#${s.name}`, null, null, null, null, J({ name: s.name, file: s.file_path }), null, now());
    nodes += 1;
  }

  // imports / depends_on edges
  const known = new Set(files.map((f) => f.path));
  for (const f of files) {
    for (const imp of P<string[]>(f.imports_json, [])) {
      const resolved = resolveRel(f.path, imp, known);
      if (resolved) {
        insEdge.run(id('e'), 'imports', nodeId('file', f.path), nodeId('file', resolved), J({ raw: imp }));
        edges += 1;
      }
    }
  }

  // calls edges
  const calls = db.prepare('SELECT DISTINCT caller, callee FROM calls').all() as Array<{ caller: string; callee: string }>;
  for (const c of calls) {
    insEdge.run(id('e'), 'calls', `fn:${c.caller}`, `fn:${c.callee}`, null);
    edges += 1;
  }

  db.prepare('INSERT OR REPLACE INTO repo_meta (key, value) VALUES (?,?)').run('rkg_built', now());
  return { nodes, edges };
}

function classifyRole(p: string): string {
  const base = path.basename(p).toLowerCase();
  if (/(^|\/)(index|main|app)\.[tj]sx?$/.test(p) || base.startsWith('main')) return 'entry point';
  if (isTestFile(p)) return 'test';
  if (/types?\.|\.d\.ts$|schema\./.test(base)) return 'data model';
  if (/config|settings/.test(base)) return 'configuration';
  // Domain from the feature directory (generic: code organised by feature). Takes
  // precedence over the generic utility label so `openapi/utils.py` reads
  // "openapi", not "utility". Only for nested files, so top-level package files
  // don't inherit the package name.
  const segs = p.split(path.sep).filter(Boolean);
  if (segs.length >= 3) {
    const dir = segs[segs.length - 2]!;
    if (dir.length >= 3 && !/^(src|lib|app|source)$/i.test(dir)) return dir.replace(/^_+/, '').replace(/_/g, ' ');
  }
  if (/util|helper/.test(p)) return 'utility';
  return 'component';
}

function guessTestTarget(testPath: string, known: Set<string>): string | null {
  const base = path.basename(testPath).replace(/\.(test|spec)\./, '.').replace(/^test_/, '').replace(/_test\./, '.');
  for (const k of known) if (path.basename(k) === base && k !== testPath) return k;
  return null;
}

function resolveRel(from: string, imp: string, known: Set<string>): string | null {
  if (!imp.startsWith('.')) return null;
  const base = path.normalize(path.join(path.dirname(from), imp));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.py`, path.join(base, 'index.ts'), path.join(base, '__init__.py')]) {
    if (known.has(c)) return c;
    const tv = c.replace(/\.js$/, '.ts');
    if (known.has(tv)) return tv;
  }
  return null;
}

export function setFileSemantics(repoPath: string, file: string, purpose: string, responsibilities: string[], role: string): void {
  getRepoDb(repoPath).prepare(
    'UPDATE rkg_nodes SET purpose=?, responsibilities_json=?, architectural_role=? WHERE id=?',
  ).run(purpose, J(responsibilities), role, nodeId('file', file));
  getRepoDb(repoPath).prepare('UPDATE file_index SET purpose=?, responsibilities_json=?, architectural_role=? WHERE path=?')
    .run(purpose, J(responsibilities), role, file);
}
