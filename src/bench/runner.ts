// Benchmark runner (spec §24).
// Executes automated benchmark suites, computes pass@1, Succ/Mtok, apply rate, and formats receipts.

import { createSmokeSuite } from './smoke.js';
import type { BenchmarkCaseResult, BenchmarkReport } from './types.js';

export async function runSmokeBenchmark(): Promise<BenchmarkReport> {
  const suite = createSmokeSuite();
  const results: BenchmarkCaseResult[] = [];
  let totalTokens = 0;
  let totalApplied = 0;
  let totalPatches = 0;
  let totalDuration = 0;

  for (const c of suite) {
    const start = performance.now();
    let ok = false;
    let err: string | undefined;
    let tokens = 0;
    let applied = 0;
    let planned = 1;

    try {
      const res = await c.run();
      ok = res.ok;
      err = res.error;
      tokens = res.tokens ?? 0;
      applied = res.appliedPatches ?? (res.ok ? 1 : 0);
      planned = res.totalPatches ?? 1;
    } catch (e) {
      ok = false;
      err = String(e);
    }

    const duration = Math.round(performance.now() - start);
    totalTokens += tokens;
    totalApplied += applied;
    totalPatches += planned;
    totalDuration += duration;

    results.push({
      id: c.id,
      name: c.name,
      repo: c.repo,
      ok,
      error: err,
      tokensUsed: tokens,
      applyRate: planned > 0 ? applied / planned : 1,
      durationMs: duration,
    });
  }

  const passed = results.filter((r) => r.ok).length;
  const passAt1 = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;
  const avgApplyRate = totalPatches > 0 ? Math.round((totalApplied / totalPatches) * 100) : 100;
  const avgDurationMs = results.length > 0 ? Math.round(totalDuration / results.length) : 0;

  // Succ/Mtok: if tokens are 0 (deterministic suite), score as infinite/perfect
  const succPerMtok = totalTokens > 0 ? Math.round((passed / (totalTokens / 1_000_000))) : passed * 1_000_000;

  return {
    timestamp: new Date().toISOString(),
    suite: 'smoke',
    totalCases: results.length,
    passedCases: passed,
    failedCases: results.length - passed,
    passAt1,
    totalTokens,
    succPerMtok,
    avgApplyRate,
    avgDurationMs,
    results,
  };
}

export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [
    '========================================================================',
    `              CODEMASTER EVALUATION HARNESS: ${report.suite.toUpperCase()} SUITE`,
    '========================================================================',
    `Executed at: ${report.timestamp}`,
    `Total Cases: ${report.totalCases} | Passed: ${report.passedCases} | Failed: ${report.failedCases}`,
    '',
    '------------------------------------------------------------------------',
    'Case ID                      Repo             Status   Time (ms)  Tokens',
    '------------------------------------------------------------------------',
  ];

  for (const r of report.results) {
    const idStr = r.id.padEnd(28, ' ');
    const repoStr = r.repo.padEnd(16, ' ');
    const statusStr = r.ok ? 'PASS   ' : 'FAIL   ';
    const timeStr = `${r.durationMs}ms`.padStart(8, ' ');
    const tokStr = `${r.tokensUsed}`.padStart(8, ' ');
    lines.push(`${idStr} ${repoStr} ${statusStr} ${timeStr} ${tokStr}`);
    if (r.error) lines.push(`   → Error: ${r.error}`);
  }

  lines.push('------------------------------------------------------------------------');
  lines.push('TARGET METRICS SUMMARY:');
  lines.push(`  pass@1           : ${report.passAt1}%`);
  lines.push(`  apply_rate       : ${report.avgApplyRate}%`);
  lines.push(`  Succ/Mtok        : ${report.totalTokens === 0 ? 'Infinity (0 tokens used - deterministic)' : report.succPerMtok}`);
  lines.push(`  time_to_verified : ${report.avgDurationMs}ms (average per case)`);
  lines.push('========================================================================');

  return lines.join('\n');
}

export async function runBenchCli(args: string[]): Promise<number> {
  const sub = args[0] || 'smoke';
  if (sub !== 'smoke') {
    console.error(`Unknown benchmark suite "${sub}". Available: smoke`);
    return 1;
  }

  console.log(`Running CodeMaster benchmark suite: ${sub}...`);
  const report = await runSmokeBenchmark();
  console.log(formatBenchmarkReport(report));

  return report.failedCases === 0 ? 0 : 1;
}
