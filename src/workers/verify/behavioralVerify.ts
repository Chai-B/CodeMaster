// Behavioral VerifyFn (spec §12.2/§14.1, §2 rule 1). Composes a deterministic
// signal the orchestrator (not the LLM) runs: crash-guard → admitted repro →
// the repo's own relevant tests. Honest fallbacks (no coverage / tool missing /
// timeout) never produce a false negative. Only ever runs the repo's own
// discovered tests + the admitted repro — never an externally supplied oracle.

import fs from 'fs';
import path from 'path';
import { staticAnalysis } from '../../analysis/api.js';
import { unvisitedUseSites, describeUseSiteGaps } from '../../analysis/useSites.js';
import { runTests, typeOrImportCheck, type RunOpts } from '../../analysis/testRunner.js';
import type { VerifyFn } from '../solver.js';
import { isTestFile } from '../../util/testFiles.js';
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

/** Paths that exist and resolve inside the repository. A path we cannot resolve
 *  is not evidence of a broken patch — it is evidence we were handed the wrong
 *  path, and gating on it fails a run nothing was ever wrong with. */
function insideRepo(repoPath: string, files: string[]): string[] {
  const root = path.resolve(repoPath) + path.sep;
  return files.filter((f) => {
    const abs = path.resolve(repoPath, f);
    return (abs + path.sep).startsWith(root) && fs.existsSync(abs);
  });
}

export function makeBehavioralVerify(
  repoPath: string,
  /** Files that exist and live inside `repoPath`, supplied by the caller from
   *  what the patcher actually wrote. This used to be a `git status` closure,
   *  which read whatever repository sat above a non-git working directory. */
  getChangedFiles: () => string[],
  opts: RunOpts = {},
  repro?: Repro | null,
  /** Files the task named. When the patch misses all of them, nothing checked
   *  the thing that was asked for, however green the suite is. */
  locus: string[] = [],
  /** Admitted only because it PASSED before the change. Its failure afterwards
   *  is a regression the task caused, which no other check in this chain can
   *  see when the repo ships no tests of its own. */
  characterization?: Repro | null,
): BehavioralVerify {
  let last: TestResults | null = null;

  const verify: VerifyFn = async (written: string[] = []) => {
    // The patcher's own list first — it is authoritative and needs no git.
    // `getChangedFiles` only adds anything when the working directory really is
    // a repository root, so a nested non-git directory contributes nothing.
    const changed = insideRepo(repoPath, [...new Set([...written, ...getChangedFiles()])]);

    // 1. Crash guard — syntax/type/import errors on the changed files (hard gate).
    const guard = typeOrImportCheck(repoPath, changed, opts);
    if (guard.ran && !guard.ok) {
      // A file the guard could not open is our path handling failing, not the
      // model's patch. Feeding it back bought three identical answers and an
      // escalation on a run where nothing was wrong with the code. It is
      // recorded as "no gate ran", not as a guard rejection, so `deriveStatus`
      // reports the task unverified rather than failed.
      const unreadable = /FileNotFoundError|No such file or directory/.test(guard.output);
      last = { ran: false, passed: 0, failed: 0, total: 0, framework: unreadable ? 'none' : 'guard', guardOk: !unreadable, reproUsed: !!repro, discoveredTests: [], output: guard.output };
      if (unreadable) {
        return { ok: false, actionable: false, output: `the crash guard could not read a changed file:\n${guard.output}` };
      }
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

    // 3. Characterization: behavior that worked before the change must still work.
    if (characterization) {
      const c = characterization.run();
      if (!c.ok) {
        last = { ran: true, passed: 0, failed: 1, total: 1, framework: 'characterization', guardOk: true, reproUsed: !!repro, discoveredTests: [characterization.path], output: c.output };
        return {
          ok: false,
          output:
            `Your change broke behavior that worked before it. This test passed on the original code and fails now:\n${c.output}\n\n` +
            `Do not weaken or delete this check — fix the change so both it and the reported bug are satisfied.`,
        };
      }
    }

    // 4. The repo's own tests that cover the changed files (regression + behavior).
    // Locus coverage: a change that never touched the files the task named was
    // not verified by any suite, no matter what the suite reports.
    const missedLocus = locus.length > 0 && !locus.some((f) => changed.includes(f));

    // 5. Use-site coverage: a changed signature whose callers were never opened
    // is broken code that a green suite cannot see. This is a hard gate, not a
    // confidence flag — the callers really are wrong.
    const gaps = await unvisitedUseSites(repoPath, changed);
    if (gaps.length > 0) {
      const detail = describeUseSiteGaps(gaps);
      last = { ran: false, passed: 0, failed: 0, total: 0, framework: 'use-sites', guardOk: true, reproUsed: !!repro, discoveredTests: [], output: detail };
      return { ok: false, output: detail };
    }

    // A test file this run just wrote is not in the index yet, so `relevantTests`
    // cannot see it and the suite the model produced was never executed at all.
    // Run it: its failure is real evidence of failure. Its success is not
    // evidence of success — `buildEvidence` refuses to call a self-authored
    // oracle verification, and that check is what keeps this honest.
    const authored = changed.filter((f) => isTestFile(f));
    const indexed = staticAnalysis(repoPath).relevantTests(changed);
    const tests = [...new Set([...indexed, ...authored])].slice(0, opts.maxTestFiles ?? 30);
    if (tests.length === 0) {
      const conf = repro ? 'repro passed' : 'crash-guard only';
      last = { ran: !!repro, passed: repro ? 1 : 0, failed: 0, total: repro ? 1 : 0, framework: 'none', guardOk: true, reproUsed: !!repro, discoveredTests: [], output: `No relevant existing tests; ${conf}.` };
      return { ok: true, confident: !!repro && !missedLocus, output: `No relevant existing tests discovered; ${conf}.` };
    }

    const res = runTests(repoPath, tests, opts);
    last = { ran: res.ran, passed: res.passed, failed: res.failed, total: res.total, framework: res.framework, guardOk: true, reproUsed: !!repro, discoveredTests: tests, output: res.output };

    if (!res.ran) return { ok: true, confident: false, output: 'Relevant tests skipped (runner unavailable).' };
    if (res.output === 'test run timed out') return { ok: true, confident: false, output: 'Relevant tests timed out; skipped (non-blocking).' };
    if (res.failed > 0) return { ok: false, output: `${res.failed} relevant test(s) failed:\n${res.output}` };
    return missedLocus
      ? { ok: true, confident: false, output: `All ${res.passed} relevant tests passed, but the patch never touched ${locus.join(', ')}.` }
      : { ok: true, confident: true, output: `All ${res.passed} relevant tests passed.` };
  };

  return { verify, lastResults: () => last };
}
