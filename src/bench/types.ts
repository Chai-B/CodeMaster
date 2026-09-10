// Benchmark types (spec §24, evaluation harness).
// Measures deterministic accuracy, pass@1, tokens, and apply rate.

export interface BenchmarkCase {
  id: string;
  name: string;
  repo: string;
  description: string;
  run: () => Promise<{ ok: boolean; error?: string; tokens?: number; appliedPatches?: number; totalPatches?: number }>;
}

export interface BenchmarkCaseResult {
  id: string;
  name: string;
  repo: string;
  ok: boolean;
  error?: string;
  tokensUsed: number;
  applyRate: number; // 0.0 - 1.0
  durationMs: number;
}

export interface BenchmarkReport {
  timestamp: string;
  suite: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passAt1: number; // percentage (0 - 100)
  totalTokens: number;
  succPerMtok: number; // successes per 1M tokens
  avgApplyRate: number; // percentage (0 - 100)
  avgDurationMs: number;
  results: BenchmarkCaseResult[];
}
