// Repro generator (spec §12.2, §14.1): synthesize a FAILING test that encodes the
// behavior described in the PUBLIC problem statement, then admit it ONLY if it
// actually fails on the current (buggy) code — a repro that passes on broken code
// doesn't capture the bug and is discarded. This validates a possibly-wrong
// generated test without ever consulting the hidden oracle, so it stays fair.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { callLlm } from '../llm.js';
import { detectFramework, type Framework } from '../../analysis/testRunner.js';
import type { ProviderManager } from '../../providers/manager.js';
import type { Config } from '../../config.js';

export interface Repro {
  path: string; // repo-relative temp test file
  run(): { ok: boolean; output: string }; // ok=true => repro passes (fix satisfies it)
  cleanup(): void;
}

export interface ReproOpts {
  pythonBin?: string;
  timeoutMs?: number;
}

const SYSTEM = `You write ONE minimal, self-contained failing test that reproduces a reported bug.
Rules:
- Use only the public API of the project and the reported behavior. Do NOT import project-internal/private modules.
- The test MUST assert the CORRECT expected behavior, so it FAILS on the buggy code and PASSES once fixed.
- No fixtures, no conftest, no network. Keep it short.
- Respond with ONLY the test source inside a single fenced code block. No prose.`;

function extractCode(text: string): string | null {
  const fence = /```(?:[a-zA-Z0-9_]*)\n([\s\S]*?)```/.exec(text);
  const code = (fence?.[1] ?? text).trim();
  return code.length > 20 ? code : null;
}

function reproDir(repoPath: string): string {
  return path.join(repoPath, '.cm_repro');
}

/** pytest: exit 1 = assertion failures (bug captured); 2 = collection/syntax error
 *  (broken test); 0 = passed. js runners: exit 1 = failures. We admit ONLY on a
 *  genuine assertion failure, so a broken generated test is never admitted. */
function runReproFile(repoPath: string, rel: string, fw: Framework, opts: ReproOpts): { status: number | null; output: string } {
  const timeout = opts.timeoutMs ?? 90_000;
  let cmd: string;
  let args: string[];
  if (fw === 'pytest') {
    cmd = opts.pythonBin ?? 'python3';
    args = ['-m', 'pytest', rel, '-q', '-p', 'no:cacheprovider', '--no-header'];
  } else if (fw === 'jest') {
    cmd = 'npx';
    args = ['jest', rel];
  } else if (fw === 'vitest') {
    cmd = 'npx';
    args = ['vitest', 'run', rel];
  } else {
    return { status: 2, output: 'unsupported framework for repro' };
  }
  const r = spawnSync(cmd, args, { cwd: repoPath, encoding: 'utf8', timeout, maxBuffer: 1e8 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 2, output: 'runner not found' };
  return { status: r.status, output: ((r.stdout ?? '') + (r.stderr ?? '')).slice(-2500) };
}

/** A real assertion failure (bug captured), not a collection/import error. */
function isGenuineFailure(fw: Framework, status: number | null, output: string): boolean {
  if (status === null) return false; // timeout
  if (fw === 'pytest') return status === 1 && /\d+ failed/.test(output) && !/error/i.test(output.split('\n').slice(-3).join(' '));
  return status === 1 && /(fail|✕|✗)/i.test(output);
}

export async function generateRepro(
  repoPath: string,
  problem: string,
  contextHint: string,
  manager: ProviderManager,
  cfg: Config,
  sessionId: string,
  opts: ReproOpts = {},
): Promise<Repro | null> {
  const fw = detectFramework(repoPath);
  const ext = fw === 'pytest' ? 'py' : fw === 'jest' || fw === 'vitest' ? 'test.ts' : null;
  if (!ext) return null; // only python/js supported for now

  let code: string | null = null;
  try {
    const { text } = await callLlm(manager, cfg, {
      system: SYSTEM,
      user: `## Reported problem\n${problem.slice(0, 4000)}\n\n## Relevant public API (signatures)\n${contextHint.slice(0, 3000)}\n\nWrite the failing test now.`,
      sessionId,
      maxTokens: 1200,
    });
    code = extractCode(text);
  } catch {
    return null;
  }
  if (!code) return null;

  const dir = reproDir(repoPath);
  const fileName = fw === 'pytest' ? 'test_cm_repro.py' : 'cm_repro.test.ts';
  const rel = path.join('.cm_repro', fileName);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(repoPath, rel), code);
  } catch {
    cleanup();
    return null;
  }

  // Admission gate: must genuinely FAIL on the current (buggy) code.
  const first = runReproFile(repoPath, rel, fw, opts);
  if (!isGenuineFailure(fw, first.status, first.output)) {
    cleanup();
    return null;
  }

  return {
    path: rel,
    run: () => {
      const r = runReproFile(repoPath, rel, fw, opts);
      return { ok: r.status === 0, output: r.output };
    },
    cleanup,
  };
}
