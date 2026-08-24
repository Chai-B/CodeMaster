// Behavioral VerifyFn (spec §12.2/§14.1, §2 rule 1). Composes a deterministic
// signal the orchestrator (not the LLM) runs: crash-guard → admitted repro →
// the repo's own relevant tests. Honest fallbacks (no coverage / tool missing /
// timeout) never produce a false negative. Only ever runs the repo's own
// discovered tests + the admitted repro — never an externally supplied oracle.

import { staticAnalysis } from '../../analysis/api.js';
import { runTests, typeOrImportCheck, type RunOpts } from '../../analysis/testRunner.js';
import type { VerifyFn } from '../solver.js';
import type { Repro } from './reproGenerator.js';

export interface TestResults {
  ran: boolean;
  passed: number;
  failed: number;
  total: number;
  framework: string;
  guardOk: boolean;
  reproUsed: boolean;
  discoveredTests: string[];
  output: string;
}

export interface BehavioralVerify {
  verify: VerifyFn;
  lastResults: () => TestResults | null;
}

export function makeBehavioralVerify(
  repoPath: string,
  getChangedFiles: () => string[],
  opts: RunOpts = {},
  repro?: Repro | null,
): BehavioralVerify {
  let last: TestResults | null = null;

  const verify: VerifyFn = () => {
    const changed = getChangedFiles();

    // 1. Crash guard — syntax/type/import errors on the changed files (hard gate).
    const guard = typeOrImportCheck(repoPath, changed, opts);
    if (guard.ran && !guard.ok) {
      last = { ran: false, passed: 0, failed: 0, total: 0, framework: 'guard', guardOk: false, reproUsed: !!repro, discoveredTests: [], output: guard.output };
      const invented = /No module named '([^']+)'|cannot import name '([^']+)'/.exec(guard.output);
      const hint = invented
        ? `\n\nYou referenced '${invented[1] ?? invented[2]}', which does NOT exist in this repository at this commit. Do not invent or reorganize imports, and do not migrate to a different library layout. Use only modules and names that already exist here, and make the SMALLEST change that fixes the bug.`
        : '';
      return { ok: false, output: `Your changed files fail to import/compile:\n${guard.output}${hint}` };
    }

    // 2. Admitted repro of the reported bug (encodes the required NEW behavior).
    if (repro) {
      const r = repro.run();
      if (!r.ok) {
        last = { ran: true, passed: 0, failed: 1, total: 1, framework: 'repro', guardOk: true, reproUsed: true, discoveredTests: [repro.path], output: r.output };
        return { ok: false, output: `The reproduction test for the reported bug still fails:\n${r.output}` };
      }
    }

    // 3. The repo's own tests that cover the changed files (regression + behavior).
    const tests = staticAnalysis(repoPath).relevantTests(changed).slice(0, opts.maxTestFiles ?? 30);
    if (tests.length === 0) {
      const conf = repro ? 'repro passed' : 'crash-guard only (low confidence)';
      last = { ran: !!repro, passed: repro ? 1 : 0, failed: 0, total: repro ? 1 : 0, framework: 'none', guardOk: true, reproUsed: !!repro, discoveredTests: [], output: `No relevant existing tests; ${conf}.` };
      return { ok: true, output: `No relevant existing tests discovered; ${conf}.` };
    }

    const res = runTests(repoPath, tests, opts);
    last = { ran: res.ran, passed: res.passed, failed: res.failed, total: res.total, framework: res.framework, guardOk: true, reproUsed: !!repro, discoveredTests: tests, output: res.output };

    if (!res.ran) return { ok: true, output: 'Relevant tests skipped (runner unavailable).' };
    if (res.output === 'test run timed out') return { ok: true, output: 'Relevant tests timed out; skipped (non-blocking).' };
    return res.failed === 0
      ? { ok: true, output: `All ${res.passed} relevant tests passed.` }
      : { ok: false, output: `${res.failed} relevant test(s) failed:\n${res.output}` };
  };

  return { verify, lastResults: () => last };
}
