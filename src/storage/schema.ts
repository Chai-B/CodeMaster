// Primary database schema (spec §19.2).

import type { DatabaseSync } from 'node:sqlite';

export const PRIMARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  objective_parsed_json TEXT,
  repository_path TEXT NOT NULL,
  repository_commit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  current_plan_json TEXT,
  current_provider_json TEXT,
  architecture_json TEXT,
  constraints_json TEXT,
  open_questions_json TEXT,
  working_files_json TEXT,
  progress_json TEXT,
  token_usage_json TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_task_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_files_json TEXT,
  output_files_json TEXT,
  dependencies_json TEXT,
  blocking_json TEXT,
  assigned_provider_json TEXT,
  reasoning_refs_json TEXT,
  decision_refs_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  failure_reason TEXT,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  actual_tokens INTEGER,
  task_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

CREATE TABLE IF NOT EXISTS reasoning (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_json TEXT,
  alternatives_json TEXT,
  confidence REAL NOT NULL,
  produced_by_json TEXT,
  produced_at TEXT NOT NULL,
  affected_files_json TEXT,
  affected_modules_json TEXT,
  tags TEXT,
  permanent INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  reference_count INTEGER DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0.5,
  wiki_keys TEXT,
  extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_reasoning_session ON reasoning(session_id);
CREATE INDEX IF NOT EXISTS idx_reasoning_type ON reasoning(type);

CREATE TABLE IF NOT EXISTS failures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  approach_attempted TEXT NOT NULL,
  why_it_failed TEXT NOT NULL,
  evidence_json TEXT,
  alternatives_json TEXT,
  affected_files_json TEXT,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  permanent INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS long_term_memory (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_markdown TEXT,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_session_id TEXT,
  source_decision_id TEXT,
  tags TEXT,
  permanent INTEGER NOT NULL DEFAULT 1,
  reference_count INTEGER DEFAULT 0,
  last_accessed_at TEXT,
  UNIQUE(namespace, key)
);

CREATE TABLE IF NOT EXISTS session_memory (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_memory ON session_memory(session_id);

CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  invocation_at TEXT NOT NULL,
  context_components_json TEXT,
  wasted_tokens INTEGER,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_token_session ON token_usage(session_id);

-- Provider accounts (spec §19.2) — durable account state.
CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  quota_json TEXT,
  health_json TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  git_commit TEXT,
  repository_path TEXT,
  storage_path TEXT,
  size_bytes INTEGER,
  tasks_completed INTEGER,
  tasks_remaining INTEGER,
  manifest_json TEXT NOT NULL,
  path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_session ON checkpoints(session_id);

CREATE TABLE IF NOT EXISTS wiki_entries (
  wiki_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  namespace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current',
  confidence REAL NOT NULL DEFAULT 0.9,
  content_markdown TEXT NOT NULL,
  front_matter_json TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  last_updated_by_session TEXT,
  tags TEXT,
  related_files_json TEXT,
  related_decisions_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_wiki_namespace ON wiki_entries(namespace);

CREATE TABLE IF NOT EXISTS wiki_versions (
  id TEXT PRIMARY KEY,
  wiki_key TEXT NOT NULL,
  version_at TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  changed_by_session TEXT,
  change_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_wiki_versions_key ON wiki_versions(wiki_key);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  provider_id TEXT,
  account_id TEXT,
  session_id TEXT,
  task_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_components TEXT
);
-- Answers already paid for. Keyed by the exact compiled prompt, so a hit means
-- the model would be asked a question it has already answered against an
-- identical working tree (token discipline W4).
-- Pre-images of every file a patch touched, so a run can be taken back without
-- reaching for git and without discarding edits the tool did not make.
CREATE TABLE IF NOT EXISTS undo_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL,
  summary TEXT,
  entries_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_cache (
  hash TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  ir_json TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
`;

// Per-repository index database schema (spec §19.2).
export const REPO_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS file_index (
  path TEXT PRIMARY KEY,
  language TEXT,
  purpose TEXT,
  responsibilities_json TEXT,
  architectural_role TEXT,
  exports_json TEXT,
  imports_json TEXT,
  last_modified TEXT,
  last_indexed TEXT,
  ast_hash TEXT,
  embedding_id TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  signature TEXT,
  documentation TEXT,
  is_exported INTEGER,
  ast_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);

CREATE TABLE IF NOT EXISTS symbol_references (
  id TEXT PRIMARY KEY,
  symbol_id TEXT NOT NULL REFERENCES symbols(id),
  file_path TEXT NOT NULL,
  line INTEGER,
  reference_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_symrefs_symbol ON symbol_references(symbol_id);

-- Dependency graph edges (spec §19.2 / §5.2.3) — persisted import edges.
CREATE TABLE IF NOT EXISTS dependency_edges (
  from_file TEXT NOT NULL,
  to_file TEXT NOT NULL,
  import_type TEXT,
  imported_symbols_json TEXT,
  PRIMARY KEY (from_file, to_file)
);
CREATE INDEX IF NOT EXISTS idx_depedges_from ON dependency_edges(from_file);
CREATE INDEX IF NOT EXISTS idx_depedges_to ON dependency_edges(to_file);

-- Learning loop (spec §7 phase 5). Per-repository, and derived only from
-- observed outcomes: how often a file the selector included was actually
-- referenced by the response, and the escalation tier a task type really
-- needed. Nothing here is a prior or an estimate.
CREATE TABLE IF NOT EXISTS file_utility (
  path TEXT PRIMARY KEY,
  included INTEGER NOT NULL DEFAULT 0,
  referenced INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- Which context components a task type actually uses. Same shape as
-- file_utility: pure observation, no priors — a component nothing has ever
-- referenced gets a smaller share of the next budget.
CREATE TABLE IF NOT EXISTS component_utility (
  task_type TEXT NOT NULL,
  component TEXT NOT NULL,
  included INTEGER NOT NULL DEFAULT 0,
  referenced INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (task_type, component)
);

CREATE TABLE IF NOT EXISTS tier_outcomes (
  task_type TEXT NOT NULL,
  tier INTEGER NOT NULL,
  verified INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_type, tier, verified)
);

CREATE TABLE IF NOT EXISTS module_index (
  path TEXT PRIMARY KEY,
  name TEXT,
  purpose TEXT,
  responsibilities_json TEXT,
  file_count INTEGER,
  key_files_json TEXT,
  dependencies_json TEXT,
  dependents_json TEXT,
  last_indexed TEXT
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  caller TEXT NOT NULL,
  callee TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,        -- 'file' | 'function' | 'class' | 'module'
  source_ref TEXT NOT NULL,         -- file path or symbol ref
  embedding BLOB NOT NULL,
  embedding_model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_ref ON embeddings(source_type, source_ref);

CREATE TABLE IF NOT EXISTS coverage (
  file_path TEXT PRIMARY KEY,
  covered_lines_json TEXT,
  total_lines INTEGER,
  covered INTEGER,
  pct REAL
);

CREATE TABLE IF NOT EXISTS rkg_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  ref TEXT NOT NULL,
  purpose TEXT,
  responsibilities_json TEXT,
  architectural_role TEXT,
  stability TEXT,
  data_json TEXT,
  ast_hash TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rkg_nodes_type ON rkg_nodes(type);
CREATE INDEX IF NOT EXISTS idx_rkg_nodes_ref ON rkg_nodes(ref);

CREATE TABLE IF NOT EXISTS rkg_edges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_ref TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rkg_edges_from ON rkg_edges(from_ref);
CREATE INDEX IF NOT EXISTS idx_rkg_edges_to ON rkg_edges(to_ref);

CREATE TABLE IF NOT EXISTS repo_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// Additive migrations for the state DB (CREATE TABLE IF NOT EXISTS cannot add
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

export function applyPrimarySchema(db: DatabaseSync): void {
  db.exec(PRIMARY_SCHEMA);
  for (const m of PRIMARY_MIGRATIONS) {
    try {
      db.exec(m);
    } catch {
      /* column already exists */
    }
  }
}
