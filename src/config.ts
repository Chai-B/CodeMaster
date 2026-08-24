// Global configuration (spec §27). Loaded from ~/.codemaster/config.yaml.

import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import type { ModelSpec } from './types/index.js';

export const DATA_DIR = process.env.CODEMASTER_DATA_DIR || path.join(os.homedir(), '.codemaster');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
export const DB_PATH = path.join(DATA_DIR, 'codemaster.db');
export const WIKI_DIR = path.join(DATA_DIR, 'wiki');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const CREDENTIALS_DIR = path.join(DATA_DIR, 'credentials');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');

export interface ProviderModels {
  models: ModelSpec[];
}
export type AnthropicConfig = ProviderModels;

export interface Config {
  daemon: {
    port: number; // spec Appendix A — IPC port (in-process daemon records it)
    log_level: 'debug' | 'info' | 'warn' | 'error';
    data_dir: string;
  };
  indexing: {
    auto_index: boolean;
    index_interval_ms: number;
    full_reindex_on_startup: boolean;
    max_file_size_bytes: number;
    excluded_patterns: string[];
    languages: string[];
    embeddings: {
      model: string;
      provider: 'local';
      batch_size: number;
      recompute_on_change: boolean;
    };
  };
  memory: {
    compression_enabled: boolean;
    compression_schedule: string; // cron (spec Appendix A)
    importance_threshold: number;
    age_days_before_eligible: number;
  };
  wiki: {
    auto_update: boolean;
    conflict_strategy: 'queue' | 'auto_merge' | 'reject';
  };
  context: {
    default_profile: string;
    max_files: number;
    file_compression_threshold: number;
    max_context_tokens: number;
    session_token_budget: number;
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
  checkpoint: {
    interval_minutes: number;
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
    encrypt_cold_storage: boolean;
    audit_log: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  daemon: { port: 7432, log_level: 'info', data_dir: DATA_DIR },
  indexing: {
    auto_index: true,
    index_interval_ms: 1000,
    full_reindex_on_startup: false,
    max_file_size_bytes: 1_000_000,
    excluded_patterns: ['node_modules/**', '.git/**', 'dist/**', '*.min.js', '.codemaster/**'],
    languages: ['python', 'typescript', 'javascript', 'rust', 'go', 'java', 'ruby', 'c', 'cpp', 'swift'],
    embeddings: {
      model: 'Xenova/all-MiniLM-L6-v2',
      provider: 'local',
      batch_size: 64,
      recompute_on_change: true,
    },
  },
  memory: {
    compression_enabled: true,
    compression_schedule: '0 2 * * *',
    importance_threshold: 0.3,
    age_days_before_eligible: 30,
  },
  wiki: { auto_update: true, conflict_strategy: 'queue' },
  context: {
    default_profile: 'implementation',
    max_files: 30,
    file_compression_threshold: 8000,
    max_context_tokens: 200_000,
    session_token_budget: 500_000,
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
        { id: 'codex-2', context_size: 32_000, cost_per_1m_input: 1.5, cost_per_1m_output: 6 },
      ],
    },
  },
  checkpoint: { interval_minutes: 10 },
  checkpointing: {
    enabled: true,
    interval_minutes: 10,
    max_checkpoints_per_session: 50,
    pre_risky_threshold: 10,
  },
  token_budget: {
    session_default: 500_000,
    warning_at_percent: 80,
    hard_limit_behavior: 'pause',
  },
  security: {
    credential_backend: 'system_keychain',
    encrypt_cold_storage: true,
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
  for (const d of [DATA_DIR, WIKI_DIR, SESSIONS_DIR, CREDENTIALS_DIR, LOGS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
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

export function modelContextSize(cfg: Config, modelId: string): number {
  const m = cfg.providers.anthropic.models.find((x) => x.id === modelId);
  return m?.context_size ?? cfg.context.max_context_tokens;
}
