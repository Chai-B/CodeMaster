// Global configuration (spec §27). Loaded from $XDG_CONFIG_HOME/codemaster/config.yaml.
//
// State is split in two: machine-global (config, credentials, logs, plugins) and
// per-repository (sessions, reasoning, wiki, checkpoints). Per-repo state lives
// under DATA_DIR/repos/<slug> rather than inside the repo, so `git clean -fdx`
// cannot destroy a session's memory.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import type { ModelSpec } from './types/index.js';

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
export const DATA_DIR = process.env.CODEMASTER_DATA_DIR || path.join(XDG_CONFIG, 'codemaster');
/** Pre-0.1 location, shared with the abandoned Python v1 checkout. Migrated once. */
export const LEGACY_DATA_DIR = path.join(os.homedir(), '.codemaster');

export const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
export const CREDENTIALS_DIR = path.join(DATA_DIR, 'credentials');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const REPOS_DIR = path.join(DATA_DIR, 'repos');

let activeRepo = process.cwd();

/** Scope all per-repo state to this repository. Call once at startup. */
export function setActiveRepo(repoPath: string): void {
  activeRepo = path.resolve(repoPath);
}
export function activeRepoPath(): string {
  return activeRepo;
}

/** Stable, human-readable, collision-free directory for one repository's state. */
export function repoSlug(repoPath: string = activeRepo): string {
  const abs = path.resolve(repoPath);
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8);
  const name = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_') || 'repo';
  return `${name}-${hash}`;
}
export function repoDataDir(repoPath: string = activeRepo): string {
  return path.join(REPOS_DIR, repoSlug(repoPath));
}
export function dbPath(repoPath: string = activeRepo): string {
  return path.join(repoDataDir(repoPath), 'state.db');
}
export function wikiDir(repoPath: string = activeRepo): string {
  return path.join(repoDataDir(repoPath), 'wiki');
}
export function sessionsDir(repoPath: string = activeRepo): string {
  return path.join(repoDataDir(repoPath), 'sessions');
}

export interface ProviderModels {
  models: ModelSpec[];
}
export type AnthropicConfig = ProviderModels;

export interface Config {
  daemon: {
    port: number; // spec Appendix A — IPC port (in-process daemon records it)
    log_level: 'debug' | 'info' | 'warn' | 'error' | 'success';
  };
  indexing: {
    auto_index: boolean;
    max_file_size_bytes: number;
    excluded_patterns: string[];
    languages: string[];
    embeddings: {
      model: string;
      provider: 'local';
    };
  };
  memory: {
    importance_threshold: number;
    age_days_before_eligible: number;
  };
  wiki: {
    auto_update: boolean;
    conflict_strategy: 'queue' | 'auto_merge' | 'reject';
  };
  context: {
    max_files: number;
    file_compression_threshold: number;
    max_context_tokens: number;
  };
  verify: {
    maxIters: number;
    timeoutMs: number;
    runTests: boolean;
    genRepro: boolean;
  };
  providers: {
    default: string;
    anthropic: ProviderModels;
    openai: ProviderModels;
    google: ProviderModels;
    openai_codex: ProviderModels;
  };
  checkpointing: {
    enabled: boolean;
    interval_minutes: number;
    max_checkpoints_per_session: number;
    pre_risky_threshold: number; // files changed in one patch = risky
  };
  token_budget: {
    session_default: number;
    warning_at_percent: number;
    hard_limit_behavior: 'pause' | 'warn' | 'continue';
  };
  security: {
    credential_backend: 'system_keychain' | 'master_password' | 'plaintext';
    audit_log: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  daemon: { port: 7432, log_level: 'info' },
  indexing: {
    auto_index: true,
    max_file_size_bytes: 1_000_000,
    excluded_patterns: ['node_modules/**', '.git/**', 'dist/**', '*.min.js', '.codemaster/**'],
    languages: ['python', 'typescript', 'javascript', 'rust', 'go', 'java', 'ruby', 'c', 'cpp', 'swift'],
    embeddings: {
      model: 'Xenova/all-MiniLM-L6-v2',
      provider: 'local',
    },
  },
  memory: {
    importance_threshold: 0.3,
    age_days_before_eligible: 30,
  },
  wiki: { auto_update: true, conflict_strategy: 'queue' },
  context: {
    max_files: 30,
    file_compression_threshold: 8000,
    max_context_tokens: 200_000,
  },
  verify: {
    maxIters: 3,
    timeoutMs: 120_000,
    runTests: true,
    genRepro: true,
  },
  providers: {
    default: 'claude-sonnet-4-6',
    anthropic: {
      models: [
        { id: 'claude-opus-4-8', context_size: 200_000, cost_per_1m_input: 15, cost_per_1m_output: 75 },
        { id: 'claude-sonnet-5', context_size: 200_000, cost_per_1m_input: 3, cost_per_1m_output: 15 },
        { id: 'claude-sonnet-4-6', context_size: 200_000, cost_per_1m_input: 3, cost_per_1m_output: 15 },
        { id: 'claude-haiku-4-5-20251001', context_size: 200_000, cost_per_1m_input: 1, cost_per_1m_output: 5 },
      ],
    },
    openai: {
      models: [
        { id: 'gpt-4.1', context_size: 128_000, cost_per_1m_input: 2, cost_per_1m_output: 8 },
        { id: 'o3', context_size: 200_000, cost_per_1m_input: 10, cost_per_1m_output: 40 },
      ],
    },
    google: {
      models: [
        { id: 'gemini-2.5-pro', context_size: 1_000_000, cost_per_1m_input: 1.25, cost_per_1m_output: 5 },
      ],
    },
    openai_codex: {
      models: [
        { id: 'gpt-5-codex', context_size: 200_000, cost_per_1m_input: 1.25, cost_per_1m_output: 10 },
      ],
    },
  },
  checkpointing: {
    enabled: true,
    interval_minutes: 10,
    max_checkpoints_per_session: 20,
    pre_risky_threshold: 10,
  },
  token_budget: {
    session_default: 500_000,
    warning_at_percent: 80,
    hard_limit_behavior: 'pause',
  },
  security: {
    credential_backend: 'system_keychain',
    audit_log: true,
  },
};

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (override ?? base) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override ?? {})) {
    const bv = (base as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && bv && typeof bv === 'object') {
      out[k] = deepMerge(bv, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function ensureDirs(): void {
  for (const d of [DATA_DIR, CREDENTIALS_DIR, LOGS_DIR, REPOS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Create the active repository's state directories. Idempotent. */
export function ensureRepoDirs(repoPath: string = activeRepo): string {
  const dir = repoDataDir(repoPath);
  for (const d of [dir, wikiDir(repoPath), sessionsDir(repoPath)]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const marker = path.join(dir, 'repo.json');
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, JSON.stringify({ repository_path: path.resolve(repoPath) }, null, 2));
  }
  return dir;
}

export function loadConfig(): Config {
  ensureDirs();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = yaml.load(raw) as Partial<Config>;
    return deepMerge(DEFAULT_CONFIG, parsed ?? {});
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: Config): void {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg), 'utf8');
}

export function allModels(cfg: Config): ModelSpec[] {
  const { default: _default, ...byProvider } = cfg.providers;
  return Object.values(byProvider).flatMap((p) => p.models);
}

export function modelContextSize(cfg: Config, modelId: string): number {
  const m = allModels(cfg).find((x) => x.id === modelId);
  return m?.context_size ?? cfg.context.max_context_tokens;
}
