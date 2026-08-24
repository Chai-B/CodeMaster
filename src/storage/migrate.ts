// One-time migration off the pre-0.1 layout.
//
// Before 0.1 everything lived in ~/.codemaster — which is also the checkout of
// the abandoned Python v1 — and every repository shared one state database and
// one wiki. This moves global artifacts to DATA_DIR and partitions the shared
// database, wiki and session directories by `sessions.repository_path`.
//
// Idempotent: guarded by a marker file, and it copies rather than moves, so the
// legacy directory stays intact and a failed run can simply be retried.

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import {
  DATA_DIR,
  LEGACY_DATA_DIR,
  CREDENTIALS_DIR,
  LOGS_DIR,
  CONFIG_PATH,
  ensureDirs,
  ensureRepoDirs,
  repoDataDir,
  wikiDir,
  sessionsDir,
  dbPath,
} from '../config.js';
import { applyPrimarySchema } from './schema.js';

const MARKER = path.join(DATA_DIR, '.migrated-v1');
const UNATTRIBUTED = '__unattributed__';

export interface MigrationReport {
  migrated: boolean;
  reason?: string;
  repos: Array<{ repository_path: string; sessions: number; rows: number; wiki: number }>;
  unattributedWiki: number;
}

/** Tables reachable from a session id, with the column that holds it. */
const BY_SESSION: Array<[string, string]> = [
  ['tasks', 'session_id'],
  ['reasoning', 'session_id'],
  ['failures', 'session_id'],
  ['session_memory', 'session_id'],
  ['token_usage', 'session_id'],
  ['checkpoints', 'session_id'],
  ['audit_log', 'session_id'],
  ['long_term_memory', 'source_session_id'],
];

export function migrateLegacy(): MigrationReport {
  const empty: MigrationReport = { migrated: false, repos: [], unattributedWiki: 0 };
  if (fs.existsSync(MARKER)) return { ...empty, reason: 'already migrated' };
  const legacyDb = path.join(LEGACY_DATA_DIR, 'codemaster.db');
  if (!fs.existsSync(legacyDb)) return { ...empty, reason: 'no legacy data' };

  ensureDirs();
  copyGlobals();

  const src = new DatabaseSync(legacyDb, { readOnly: true });
  try {
    const report = partition(src);
    fs.writeFileSync(MARKER, new Date().toISOString() + '\n');
    return report;
  } finally {
    src.close();
  }
}

function copyGlobals(): void {
  const legacyCfg = path.join(LEGACY_DATA_DIR, 'config.yaml');
  if (fs.existsSync(legacyCfg) && !fs.existsSync(CONFIG_PATH)) fs.copyFileSync(legacyCfg, CONFIG_PATH);
  for (const [from, to] of [
    [path.join(LEGACY_DATA_DIR, 'credentials'), CREDENTIALS_DIR],
    [path.join(LEGACY_DATA_DIR, 'logs'), LOGS_DIR],
    [path.join(LEGACY_DATA_DIR, 'plugins'), path.join(DATA_DIR, 'plugins')],
  ] as Array<[string, string]>) {
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, force: false });
  }
}

function partition(src: DatabaseSync): MigrationReport {
  const sessions = src.prepare('SELECT id, repository_path FROM sessions').all() as Array<{
    id: string;
    repository_path: string;
  }>;
  const repoOf = new Map<string, string>();
  const byRepo = new Map<string, string[]>();
  for (const s of sessions) {
    const repo = s.repository_path;
    repoOf.set(s.id, repo);
    const list = byRepo.get(repo);
    if (list) list.push(s.id);
    else byRepo.set(repo, [s.id]);
  }

  // Wiki keys follow the session that last touched them; orphans are kept in a
  // dedicated bucket rather than silently dropped or duplicated everywhere.
  const wikiRows = src.prepare('SELECT wiki_key, last_updated_by_session FROM wiki_entries').all() as Array<{
    wiki_key: string;
    last_updated_by_session: string | null;
  }>;
  const wikiByRepo = new Map<string, string[]>();
  let unattributedWiki = 0;
  for (const w of wikiRows) {
    const repo = (w.last_updated_by_session && repoOf.get(w.last_updated_by_session)) || UNATTRIBUTED;
    if (repo === UNATTRIBUTED) unattributedWiki += 1;
    const list = wikiByRepo.get(repo);
    if (list) list.push(w.wiki_key);
    else wikiByRepo.set(repo, [w.wiki_key]);
  }

  const repos: MigrationReport['repos'] = [];
  for (const repo of new Set([...byRepo.keys(), ...wikiByRepo.keys()])) {
    const ids = byRepo.get(repo) ?? [];
    const keys = wikiByRepo.get(repo) ?? [];
    const dest = repo === UNATTRIBUTED ? path.join(DATA_DIR, 'repos', UNATTRIBUTED) : repoDataDir(repo);
    fs.mkdirSync(dest, { recursive: true });
    if (repo !== UNATTRIBUTED) ensureRepoDirs(repo);

    const target = repo === UNATTRIBUTED ? path.join(dest, 'state.db') : dbPath(repo);
    const db = new DatabaseSync(target);
    let rows = 0;
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      applyPrimarySchema(db);
      rows += copyRows(src, db, 'sessions', 'id', ids);
      for (const [table, col] of BY_SESSION) rows += copyRows(src, db, table, col, ids);
      rows += copyRows(src, db, 'wiki_entries', 'wiki_key', keys);
      rows += copyRows(src, db, 'wiki_versions', 'wiki_key', keys);
    } finally {
      db.close();
    }

    if (repo !== UNATTRIBUTED) {
      copyWikiFiles(keys, wikiDir(repo));
      copySessionDirs(ids, sessionsDir(repo));
    }
    repos.push({ repository_path: repo, sessions: ids.length, rows, wiki: keys.length });
  }
  return { migrated: true, repos, unattributedWiki };
}

/** Copy every row of `table` whose `col` is in `values`, preserving all columns. */
function copyRows(src: DatabaseSync, dest: DatabaseSync, table: string, col: string, values: string[]): number {
  if (values.length === 0) return 0;
  const cols = (src.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.length === 0) return 0;
  const destCols = new Set(
    (dest.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const shared = cols.filter((c) => destCols.has(c));
  if (shared.length === 0) return 0;

  const placeholders = values.map(() => '?').join(',');
  const rows = src
    .prepare(`SELECT ${shared.join(',')} FROM ${table} WHERE ${col} IN (${placeholders})`)
    .all(...values) as Array<Record<string, unknown>>;
  const insert = dest.prepare(
    `INSERT OR REPLACE INTO ${table} (${shared.join(',')}) VALUES (${shared.map(() => '?').join(',')})`,
  );
  for (const r of rows) insert.run(...shared.map((c) => (r[c] ?? null) as never));
  return rows.length;
}

function copyWikiFiles(keys: string[], dest: string): void {
  const from = path.join(LEGACY_DATA_DIR, 'wiki');
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const key of keys) {
    const md = path.join(from, `${key}.md`);
    if (fs.existsSync(md)) {
      fs.mkdirSync(path.dirname(path.join(dest, `${key}.md`)), { recursive: true });
      fs.copyFileSync(md, path.join(dest, `${key}.md`));
    }
    const versions = path.join(from, '.versions', key);
    if (fs.existsSync(versions)) {
      fs.cpSync(versions, path.join(dest, '.versions', key), { recursive: true, force: false });
    }
  }
}

function copySessionDirs(ids: string[], dest: string): void {
  const from = path.join(LEGACY_DATA_DIR, 'sessions');
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const id of ids) {
    const dir = path.join(from, id);
    if (fs.existsSync(dir)) fs.cpSync(dir, path.join(dest, id), { recursive: true, force: false });
  }
}
