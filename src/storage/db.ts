// Database connections using Node's built-in SQLite (node:sqlite).

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { DB_PATH, ensureDirs } from '../config.js';
import { PRIMARY_SCHEMA, REPO_INDEX_SCHEMA } from './schema.js';

// Bump when the repo-index schema columns change so stale disposable indexes
// are dropped and rebuilt rather than failing on renamed columns.
const REPO_INDEX_VERSION = 2;

// Additive migrations for the primary DB (CREATE TABLE IF NOT EXISTS cannot add
// columns to pre-existing tables). Each is idempotent — duplicate-column errors
// are ignored.
const PRIMARY_MIGRATIONS = [
  'ALTER TABLE token_usage ADD COLUMN cache_read_tokens INTEGER',
  'ALTER TABLE token_usage ADD COLUMN cache_write_tokens INTEGER',
  'ALTER TABLE token_usage ADD COLUMN wasted_tokens INTEGER',
  'ALTER TABLE checkpoints ADD COLUMN git_commit TEXT',
  'ALTER TABLE checkpoints ADD COLUMN repository_path TEXT',
  'ALTER TABLE checkpoints ADD COLUMN storage_path TEXT',
  'ALTER TABLE checkpoints ADD COLUMN size_bytes INTEGER',
  'ALTER TABLE checkpoints ADD COLUMN tasks_completed INTEGER',
  'ALTER TABLE checkpoints ADD COLUMN tasks_remaining INTEGER',
];

const REPO_INDEX_TABLES = [
  'file_index', 'symbols', 'symbol_references', 'dependency_edges', 'module_index',
  'calls', 'embeddings', 'coverage', 'rkg_nodes', 'rkg_edges',
];

let primary: DatabaseSync | null = null;
const repoDbs = new Map<string, DatabaseSync>();

export function getDb(): DatabaseSync {
  if (primary) return primary;
  ensureDirs();
  primary = new DatabaseSync(DB_PATH);
  primary.exec('PRAGMA journal_mode = WAL;');
  primary.exec('PRAGMA foreign_keys = ON;');
  primary.exec(PRIMARY_SCHEMA);
  for (const m of PRIMARY_MIGRATIONS) {
    try {
      primary.exec(m);
    } catch {
      /* column already exists */
    }
  }
  return primary;
}

export function getRepoDb(repoPath: string): DatabaseSync {
  const existing = repoDbs.get(repoPath);
  if (existing) return existing;
  const dir = path.join(repoPath, '.codemaster');
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');
  const db = new DatabaseSync(path.join(dir, 'index.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(REPO_INDEX_SCHEMA);
  migrateRepoIndex(db);
  repoDbs.set(repoPath, db);
  return db;
}

function migrateRepoIndex(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS repo_meta (key TEXT PRIMARY KEY, value TEXT);');
  const row = db.prepare("SELECT value FROM repo_meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  const version = row ? Number(row.value) : 0;
  if (version === REPO_INDEX_VERSION) return;
  // Stale/legacy index: drop disposable tables and rebuild from the current schema.
  for (const t of REPO_INDEX_TABLES) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.exec(REPO_INDEX_SCHEMA);
  db.prepare("INSERT OR REPLACE INTO repo_meta (key, value) VALUES ('schema_version', ?)").run(
    String(REPO_INDEX_VERSION),
  );
}

export function closeAll(): void {
  primary?.close();
  primary = null;
  for (const db of repoDbs.values()) db.close();
  repoDbs.clear();
}
