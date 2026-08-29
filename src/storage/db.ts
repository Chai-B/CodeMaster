// Database connections using Node's built-in SQLite (node:sqlite).

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { activeRepoPath, dbPath, ensureDirs, ensureRepoDirs, loadConfig, allModels } from '../config.js';
import { applyPrimarySchema, repriceLegacyCost, REPO_INDEX_SCHEMA } from './schema.js';
import { migrateLegacy } from './migrate.js';

// Bump when the repo-index schema columns change so stale disposable indexes
// are dropped and rebuilt rather than failing on renamed columns.
const REPO_INDEX_VERSION = 2;

const REPO_INDEX_TABLES = [
  'file_index', 'symbols', 'symbol_references', 'dependency_edges', 'module_index',
  'calls', 'embeddings', 'coverage', 'rkg_nodes', 'rkg_edges',
];

// State DBs are per-repository (one `state.db` per repo under DATA_DIR/repos),
// keyed here by repo path so a process that switches repos does not reuse a
// connection to the wrong file.
const stateDbs = new Map<string, DatabaseSync>();
const repoDbs = new Map<string, DatabaseSync>();

let migrated = false;

export function getDb(repoPath: string = activeRepoPath()): DatabaseSync {
  const existing = stateDbs.get(repoPath);
  if (existing) return existing;
  ensureDirs();
  // Runs at most once per process, before any state DB is opened, so a pre-0.1
  // install is partitioned rather than silently starting from empty.
  if (!migrated) {
    migrated = true;
    migrateLegacy();
  }
  ensureRepoDirs(repoPath);
  const db = new DatabaseSync(dbPath(repoPath));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  applyPrimarySchema(db);
  try {
    const models = allModels(loadConfig());
    repriceLegacyCost(db, (id) => {
      const m = models.find((x) => x.id === id);
      if (!m) return null;
      return {
        input: m.cost_per_1m_input,
        output: m.cost_per_1m_output,
        read: m.cache_read_multiplier ?? 0.1,
        write: m.cache_write_multiplier ?? 1.25,
      };
    });
  } catch {
    /* a stale cost column is not worth failing to open the database over */
  }
  stateDbs.set(repoPath, db);
  return db;
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
  for (const db of stateDbs.values()) db.close();
  stateDbs.clear();
  for (const db of repoDbs.values()) db.close();
  repoDbs.clear();
}
