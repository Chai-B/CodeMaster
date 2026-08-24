// StaticIndexer — walks repo, extracts symbols/imports into the repo index db (spec §5.3).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getRepoDb } from '../storage/db.js';
import { languageOf, type ExtractedSymbol } from './extractors.js';
import { extractWithFallback } from './treesitter.js';
import { now, uuid } from '../util/id.js';
import { loadConfig } from '../config.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.codemaster', 'build', '.next', 'venv', '.venv',
  '__pycache__', 'target', '.cache', 'coverage', '.serena',
]);

export interface IndexStats {
  files: number;
  symbols: number;
  languages: Record<string, number>;
}

/** Config-driven exclusions, compiled once per walk. `indexing.excluded_patterns`
 *  used to be inert, so a vendored directory was indexed like source. */
function excluder(): (rel: string) => boolean {
  const globs = loadConfig().indexing.excluded_patterns;
  const res = globs.map((g) => new RegExp('^' + g.split('*').map(escapeRe).join('.*') + '$'));
  return (rel: string) => res.some((r) => r.test(rel));
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function walk(root: string, maxSize: number, excluded: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && !excluded(path.relative(root, full))) rec(full);
      } else if (e.isFile() && languageOf(e.name) && !excluded(path.relative(root, full))) {
        try {
          if (fs.statSync(full).size <= maxSize) out.push(full);
        } catch {
          /* skip */
        }
      }
    }
  };
  rec(root);
  return out;
}

export async function indexRepository(repoPath: string, maxSize?: number): Promise<IndexStats> {
  const db = getRepoDb(repoPath);
  db.exec('DELETE FROM file_index; DELETE FROM symbols; DELETE FROM symbol_references; DELETE FROM calls;');

  const files = walk(repoPath, maxSize ?? loadConfig().indexing.max_file_size_bytes, excluder());
  const stats: IndexStats = { files: 0, symbols: 0, languages: {} };

  const insFile = db.prepare(
    `INSERT OR REPLACE INTO file_index
     (path, language, exports_json, imports_json, last_modified, last_indexed, ast_hash)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const insSym = db.prepare(
    `INSERT INTO symbols (id, name, kind, file_path, line_start, signature, is_exported, ast_hash)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insCall = db.prepare('INSERT INTO calls (id, caller, callee, file_path, line) VALUES (?,?,?,?,?)');

  for (const full of files) {
    const rel = path.relative(repoPath, full);
    const lang = languageOf(full)!;
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
    const { symbols, imports, calls } = await extractWithFallback(content, lang);
    const exported = symbols.filter((s) => s.exported).map((s) => s.name);

    insFile.run(rel, lang, JSON.stringify(exported), JSON.stringify(imports), fileMtime(full), now(), hash);
    for (const s of symbols) {
      insSym.run(`${rel}:${s.name}:${s.line}`, s.name, s.kind, rel, s.line, s.signature, s.exported ? 1 : 0, hash);
    }
    for (const c of calls) {
      insCall.run(uuid(), c.caller, c.callee, rel, c.line);
    }
    stats.files += 1;
    stats.symbols += symbols.length;
    stats.languages[lang] = (stats.languages[lang] ?? 0) + 1;
  }

  db.prepare('INSERT OR REPLACE INTO repo_meta (key, value) VALUES (?,?)').run('last_indexed', now());
  db.prepare('INSERT OR REPLACE INTO repo_meta (key, value) VALUES (?,?)').run('stats', JSON.stringify(stats));
  return stats;
}

export async function indexFile(repoPath: string, relPath: string): Promise<void> {
  const db = getRepoDb(repoPath);
  const full = path.join(repoPath, relPath);
  const lang = languageOf(relPath);
  if (!lang) return;
  let content: string;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch {
    db.prepare('DELETE FROM file_index WHERE path=?').run(relPath);
    db.prepare('DELETE FROM symbols WHERE file_path=?').run(relPath);
    db.prepare('DELETE FROM calls WHERE file_path=?').run(relPath);
    return;
  }
  const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
  const { symbols, imports, calls } = await extractWithFallback(content, lang);
  const exported = symbols.filter((s) => s.exported).map((s) => s.name);
  db.prepare('DELETE FROM symbols WHERE file_path=?').run(relPath);
  db.prepare('DELETE FROM calls WHERE file_path=?').run(relPath);
  db.prepare(
    `INSERT OR REPLACE INTO file_index (path, language, exports_json, imports_json, last_modified, last_indexed, ast_hash)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(relPath, lang, JSON.stringify(exported), JSON.stringify(imports), fileMtime(full), now(), hash);
  const insSym = db.prepare(
    `INSERT INTO symbols (id, name, kind, file_path, line_start, signature, is_exported, ast_hash) VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const s of symbols) {
    insSym.run(`${relPath}:${s.name}:${s.line}`, s.name, s.kind, relPath, s.line, s.signature, s.exported ? 1 : 0, hash);
  }
  const insCall = db.prepare('INSERT INTO calls (id, caller, callee, file_path, line) VALUES (?,?,?,?,?)');
  for (const c of calls) insCall.run(uuid(), c.caller, c.callee, relPath, c.line);
}

function fileMtime(full: string): string {
  try {
    return fs.statSync(full).mtime.toISOString();
  } catch {
    return now();
  }
}

export function getIndexStats(repoPath: string): IndexStats | null {
  const db = getRepoDb(repoPath);
  const r = db.prepare('SELECT value FROM repo_meta WHERE key=?').get('stats') as
    | { value: string }
    | undefined;
  return r ? (JSON.parse(r.value) as IndexStats) : null;
}

export type { ExtractedSymbol };
