// GreenfieldVerify — synthesizes deterministic acceptance tests for test-less repos (spec §12.2, §14.1).
// When a repository lacks a test suite, synthesizes smoke tests, import checks,
// and export existence assertions so changes are verified deterministically with 0 hallucinated verdicts.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { typeOrImportCheck } from '../../analysis/testRunner.js';
import { languageOf } from '../../analysis/extractors.js';
import type { VerifyFn, VerifyResult } from '../solver.js';

export interface GreenfieldAcceptanceCriteria {
  targetFiles: string[];
  expectedExports?: Record<string, string[]>;
  smokeCommands?: string[];
}

export interface GreenfieldVerifyResult {
  ok: boolean;
  output: string;
  checksRun: number;
}

function resolveInRepo(repoPath: string, rel: string): string | null {
  const root = path.resolve(repoPath);
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/**
 * Deterministically check smoke execution and export surface for changed files.
 */
export async function runGreenfieldVerification(
  repoPath: string,
  changedFiles: string[],
  criteria?: GreenfieldAcceptanceCriteria,
): Promise<GreenfieldVerifyResult> {
  const files = criteria?.targetFiles ?? changedFiles;
  if (!files || files.length === 0) {
    return { ok: true, output: 'No changed files to verify in greenfield harness.', checksRun: 0 };
  }

  let checksRun = 0;
  const failures: string[] = [];

  // 1. Crash Guard: Type or Import Check
  const guard = typeOrImportCheck(repoPath, files);
  checksRun++;
  if (guard.ran && !guard.ok) {
    return {
      ok: false,
      output: `Greenfield verification failed syntax/type/import check:\n${guard.output}`,
      checksRun,
    };
  }

  // 2. Export / Symbol Presence Validation
  if (criteria?.expectedExports) {
    for (const [relPath, expNames] of Object.entries(criteria.expectedExports)) {
      const full = resolveInRepo(repoPath, relPath);
      if (!full || !fs.existsSync(full)) {
        failures.push(`Expected file '${relPath}' does not exist.`);
        continue;
      }
      const content = fs.readFileSync(full, 'utf8');
      for (const name of expNames) {
        checksRun++;
        const hasExport = new RegExp(`\\bexport\\s+(?:(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|type|interface|enum)\\s+)?${name}\\b`).test(content) ||
                          new RegExp(`\\bdef\\s+${name}\\b`).test(content);
        if (!hasExport) {
          failures.push(`Expected export '${name}' was not found in ${relPath}.`);
        }
      }
    }
  }

  // 3. Smoke Execution of Changed Scripts (if runnable)
  for (const relPath of files) {
    const full = resolveInRepo(repoPath, relPath);
    if (!full || !fs.existsSync(full)) continue;

    const lang = languageOf(relPath);
    // For standalone JS/TS/Python scripts that contain a main guard or entry execution
    const content = fs.readFileSync(full, 'utf8');
    if (lang === 'python' && content.includes('__main__')) {
      checksRun++;
      const res = spawnSync('python3', [full], { cwd: repoPath, timeout: 5000, encoding: 'utf8' });
      if (res.status !== 0) {
        failures.push(`Smoke execution of Python script '${relPath}' failed:\n${res.stderr || res.stdout}`);
      }
    } else if ((lang === 'javascript' || lang === 'typescript') && (content.includes('process.argv') || /console\.log\(|main\(\)/.test(content))) {
      // Run with node or tsx in dry-run/syntax check mode
      checksRun++;
      const res = spawnSync('node', ['--check', full], { cwd: repoPath, timeout: 5000, encoding: 'utf8' });
      if (res.status !== 0) {
        failures.push(`Node syntax check of '${relPath}' failed:\n${res.stderr || res.stdout}`);
      }
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      output: failures.join('\n\n'),
      checksRun,
    };
  }

  return {
    ok: true,
    output: `Greenfield verification passed (${checksRun} checks executed successfully).`,
    checksRun,
  };
}

/**
 * Creates a VerifyFn conforming to the solver execution loop for test-less repos.
 */
export function makeGreenfieldVerify(
  repoPath: string,
  getChangedFiles: () => string[],
  criteria?: GreenfieldAcceptanceCriteria,
): VerifyFn {
  return async (written: string[] = []): Promise<VerifyResult> => {
    const files = [...new Set([...written, ...getChangedFiles()])];
    const res = await runGreenfieldVerification(repoPath, files, criteria);
    return {
      ok: res.ok,
      output: res.output,
      confident: res.checksRun > 0,
      actionable: true,
    };
  };
}
