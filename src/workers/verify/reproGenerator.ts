// Repro generator (spec §12.2, §14.1): synthesize a FAILING test that encodes the
// behavior described in the PUBLIC problem statement, then admit it ONLY if it
// actually fails on the current (buggy) code — a repro that passes on broken code
// doesn't capture the bug and is discarded. This validates a possibly-wrong
// generated test without ever consulting the hidden oracle, so it stays fair.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { callLlm } from '../llm.js';
import { bus } from '../../events/bus.js';
import { frameworkForNewTest, resolvePytest, type Framework } from '../../analysis/testRunner.js';
import type { ProviderManager } from '../../providers/manager.js';
import { repoDataDir, type Config } from '../../config.js';

export interface Repro {
  path: string; // absolute path to the generated test, outside the repo
  run(): { ok: boolean; output: string }; // ok=true => repro passes (fix satisfies it)
  cleanup(): void;
}

export interface ReproOpts {
  pythonBin?: string;
  timeoutMs?: number;
}

const SYSTEM = `You write ONE minimal, self-contained failing test that reproduces a reported bug.
Rules:
- Prefer the public API. But when the reported problem is about INTERNAL state — unbounded
  growth, retained data, leaks, resource use — the public API cannot observe it: measure the
  object's own attributes directly (e.g. \`sum(len(v) for v in vars(obj).values() if isinstance(v, (list, dict, set)))\`)
  and assert the bound the problem states. A test that only checks output will pass on such a
  bug and is worthless.
- The test MUST FAIL on the code as it is now and PASS once the bug is fixed. If your test would
  pass on the current buggy code, it does not capture the bug — write a different one.
- No fixtures, no conftest, no network. Keep it short.
- Respond with ONLY the test source inside a single fenced code block. No prose.`;

function extractCode(text: string): string | null {
  const fence = /```(?:[a-zA-Z0-9_]*)\n([\s\S]*?)```/.exec(text);
  const code = (fence?.[1] ?? text).trim();
  return code.length > 20 ? code : null;
}

/** Outside the repository, always. A generated test is scaffolding, not work
 *  product: it must not appear in the user's `git status`, be picked up by
 *  their own test run, or survive a crash as litter in their tree. */
function reproDir(repoPath: string): string {
  return path.join(repoDataDir(repoPath), 'repro');
}

/** pytest: exit 1 = assertion failures (bug captured); 2 = collection/syntax error
 *  (broken test); 0 = passed. js runners: exit 1 = failures. We admit ONLY on a
 *  genuine assertion failure, so a broken generated test is never admitted. */
function runReproFile(repoPath: string, file: string, fw: Framework, opts: ReproOpts): { status: number | null; output: string } {
  const timeout = opts.timeoutMs ?? 90_000;
  let cmd: string;
  let args: string[];
  if (fw === 'pytest') {
    // Same resolution the real test run uses: `python3 -m pytest` is not a
    // given, and "pytest is not installed" must never read as "the bug is not
    // reproduced" — that silently discards every repro on such a machine.
    const runner = resolvePytest(opts.pythonBin ?? 'python3');
    if (!runner) return { status: 2, output: 'no pytest runner available' };
    cmd = runner.cmd;
    args = [...runner.pre, file, '-q', '-p', 'no:cacheprovider', '--no-header'];
  } else if (fw === 'jest') {
    cmd = 'npx';
    args = ['jest', file];
  } else if (fw === 'vitest') {
    cmd = 'npx';
    args = ['vitest', 'run', file];
  } else {
    return { status: 2, output: 'unsupported framework for repro' };
  }
  // The repro lives in `.cm_repro/`, so the repository root is not on the
  // import path by default and every `import <project>` would fail collection.
  const env = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: [repoPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  const r = spawnSync(cmd, args, { cwd: repoPath, encoding: 'utf8', timeout, maxBuffer: 1e8, env });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 2, output: 'runner not found' };
  return { status: r.status, output: ((r.stdout ?? '') + (r.stderr ?? '')).slice(-2500) };
}

/** A test that blew up on a wrong import or a wrong call is a broken test, not a
 *  captured bug. An assertion failure is the capture. */
const TEST_IS_BROKEN =
  /\b(ImportError|ModuleNotFoundError|AttributeError|TypeError|NameError|SyntaxError|IndentationError|ValueError|fixture '[^']*' not found)/;

/** A real assertion failure (bug captured), not a collection/import error. */
export function isGenuineFailure(fw: Framework, status: number | null, output: string): boolean {
  if (status === null) return false; // timeout
  if (fw === 'pytest') {
    // 2 is a collection or usage error; 0 is a pass. Only 1 means tests ran and
    // failed. Note the old check here rejected anything matching /error/i in the
    // tail — which matches the word `AssertionError`, so a correct repro was
    // discarded every single time and no run ever had an oracle.
    if (status !== 1 || !/\d+ failed/.test(output)) return false;
    if (/\d+ error/.test(output)) return false;
    return !TEST_IS_BROKEN.test(output);
  }
  return status === 1 && /(fail|✕|✗)/i.test(output);
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', 'target', '.codemaster']);

/**
 * Which module each public name actually lives in, read off disk.
 * The generator's most common failure is a plausible-but-wrong import
 * (`from streamjoin.join import Event` when `Event` is defined in `pairing`).
 * That errors at collection, so the test never runs and the only sound oracle
 * in the run is discarded. Naming the real surface costs nothing and is right.
 */
export function importSurface(repoPath: string, fw: Framework, budget = 2500): string {
  if (fw !== 'pytest') return '';
  const out: string[] = [];
  const outline = (src: string): string[] => {
    const lines: string[] = [];
    let inClass = false;
    for (const raw of src.split('\n')) {
      const top = /^(class\s+\w+[^:]*|def\s+\w+\([^)]*\)[^:]*):/.exec(raw);
      if (top) {
        inClass = raw.startsWith('class');
        const name = /^(?:class|def)\s+(\w+)/.exec(raw)![1]!;
        if (!name.startsWith('_')) lines.push(top[1]!.replace(/\s+/g, ' '));
        continue;
      }
      // One level in: the methods a caller actually invokes. Without these the
      // model invents `.add()` on a class whose method is `feed_a`, and the
      // test dies at AttributeError instead of at the assertion that matters.
      const meth = inClass ? /^ {4}(def\s+(\w+)\([^)]*\)[^:]*):/.exec(raw) : null;
      if (meth && (meth[2] === '__init__' || !meth[2]!.startsWith('_'))) {
        lines.push(`    ${meth[1]!.replace(/\s+/g, ' ')}`);
      }
    }
    return lines;
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.join('\n').length > budget) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!e.name.endsWith('.py') || e.name.startsWith('test_') || e.name.endsWith('_test.py')) continue;
      let src: string;
      try {
        src = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const body = outline(src);
      if (body.length === 0) continue;
      const mod = path
        .relative(repoPath, full)
        .replace(/\.py$/, '')
        .replace(/\/__init__$/, '')
        .split(path.sep)
        .join('.');
      out.push(`# module ${mod}\n${body.join('\n')}`);
    }
  };
  walk(repoPath, 0);
  return out.join('\n\n').slice(0, budget);
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
  // Every `return null` below removes the only sound oracle in the system, so
  // each one says why. Silence here is what let a whole benchmark run report
  // success with nothing ever executed.
  const give = (why: string): null => {
    bus.emit({ type: 'log', level: 'warn', message: `No reproduction test: ${why}` });
    return null;
  };
  const fw = frameworkForNewTest(repoPath);
  const ext = fw === 'pytest' ? 'py' : fw === 'jest' || fw === 'vitest' ? 'test.ts' : null;
  if (!ext) return give(`no supported test framework for this repository (${fw})`);

  const surface = importSurface(repoPath, fw);
  const dir = reproDir(repoPath);
  const fileName = fw === 'pytest' ? 'test_cm_repro.py' : 'cm_repro.test.ts';
  const file = path.join(dir, fileName);
  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });

  const ask = async (correction: string): Promise<string | null> => {
    const { text } = await callLlm(manager, cfg, {
      system: SYSTEM,
      user:
        `## Reported problem\n${problem.slice(0, 4000)}\n\n` +
        `## Relevant public API (signatures)\n${contextHint.slice(0, 3000)}\n\n` +
        (surface ? `## The real API of this repository (names, arities and methods are EXACT; anything else does not exist)\n${surface}\n\n` : '') +
        correction +
        `Write the failing test now.`,
      sessionId,
      maxTokens: 1200,
    });
    return extractCode(text);
  };

  // Up to three attempts. A first failure is usually a wrong import or a test that
  // does not actually pin the bug — both are fully described by the runner's own
  // output, so handing that back buys a working oracle for one more cheap call.
  // Without it the first attempt is simply thrown away: tokens spent, nothing
  // verified. Repeating itself ends the loop early, since another identical call
  // would buy nothing.
  const ATTEMPTS = 3;
  let correction = '';
  let previous = '';
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let code: string | null;
    try {
      code = await ask(correction);
    } catch (e) {
      return give(`the model call failed (${String(e).slice(0, 200)})`);
    }
    if (!code) return give('the model returned no usable test source');
    if (code === previous) {
      cleanup();
      return give('the model repeated the same rejected test');
    }
    previous = code;

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, code);
    } catch (e) {
      cleanup();
      return give(`could not write the test (${String(e).slice(0, 200)})`);
    }

    // Admission gate: must genuinely FAIL on the current (buggy) code. A repro
    // that passes on broken code does not capture the bug; one that errors on
    // collection never ran at all. Neither may be admitted.
    const first = runReproFile(repoPath, file, fw, opts);
    if (isGenuineFailure(fw, first.status, first.output)) break;

    const tail = first.output.trim().split('\n').slice(-4).join(' ').slice(0, 600);
    const why =
      first.status === 0
        ? 'the generated test passed on the unfixed code, so it does not capture the bug'
        : `the generated test did not run (exit ${first.status}): ${tail}`;
    if (attempt === ATTEMPTS - 1) {
      cleanup();
      return give(why);
    }
    correction =
      first.status === 0
        ? `## Your previous attempt PASSED on the buggy code, so it is worthless\n` +
          `\`\`\`\n${code.slice(0, 1200)}\n\`\`\`\n` +
          `Do NOT write that test again. It checked behavior that is already correct. Find the property ` +
          `the problem says is VIOLATED right now, assert that property, and make sure the assertion is ` +
          `false on the code as it stands.\n\n`
        : `## Your previous attempt did not run\n${tail}\nFix it. Import only names listed above, and use only the public API.\n\n`;
    bus.emit({ type: 'log', level: 'info', message: `Reproduction test rejected, retrying once: ${why}` });
  }

  return {
    path: file,
    run: () => {
      const r = runReproFile(repoPath, file, fw, opts);
      return { ok: r.status === 0, output: r.output };
    },
    cleanup,
  };
}
