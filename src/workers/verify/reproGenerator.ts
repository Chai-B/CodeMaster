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
import { uuid } from '../../util/id.js';

export interface Repro {
  path: string; // absolute path to the generated test, outside the repo
  run(): { ok: boolean; output: string }; // ok=true => repro passes (fix satisfies it)
  cleanup(): void;
}

/** `repro` is admitted only if it FAILS on the current code; `characterization`
 *  only if it PASSES. One proves the bug exists, the other proves what already
 *  works — and nothing in the system was checking the second. */
type Kind = 'repro' | 'characterization';

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

const CHARACTERIZATION_SYSTEM = `You write 3 to 5 SHORT tests that pin down behavior the code ALREADY has correctly, so a fix elsewhere cannot silently break it.

Rules:
- Every test MUST PASS on the code exactly as it stands right now. You are not reporting a bug; you are fencing off what already works.
- Make each test INDEPENDENT and cover a DIFFERENT property: the main result, an edge case (empty input, one element, a boundary value), and any invariant the code maintains. One test protects one thing; a fix that breaks something else slips past it.
- Pick behavior the described change could plausibly break as a side effect — the ordinary, correct path through the same code. Do NOT assert the buggy behavior the change is meant to fix, and do NOT assert anything the description says is currently wrong.
- Assert concrete values, not just "no exception". A test that cannot fail protects nothing.
- No fixtures, no conftest, no network. Keep each test to a few lines.
- Respond with ONLY the test source inside a single fenced code block. No prose.`;

function extractCode(text: string): string | null {
  const fence = /```(?:[a-zA-Z0-9_]*)\n([\s\S]*?)```/.exec(text);
  const code = (fence?.[1] ?? text).trim();
  return code.length > 20 ? code : null;
}

/** Outside the repository, always. A generated test is scaffolding, not work
 *  product: it must not appear in the user's `git status`, be picked up by
 *  their own test run, or survive a crash as litter in their tree. */
function reproDir(repoPath: string, kind: Kind): string {
  return path.join(repoDataDir(repoPath), kind === 'repro' ? 'repro' : 'characterization');
}

/** pytest: exit 1 = assertion failures (bug captured); 2 = collection/syntax error
 *  (broken test); 0 = passed. js runners: exit 1 = failures. We admit ONLY on a
 *  genuine assertion failure, so a broken generated test is never admitted. */
function runReproFile(repoPath: string, file: string, fw: Framework, opts: ReproOpts, deselect: string[] = []): { status: number | null; output: string } {
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
    args = [
      ...runner.pre, file, '-q', '-p', 'no:cacheprovider', '--no-header', '--color=no', '--tb=short',
      ...deselect.flatMap((id) => ['--deselect', id]),
    ];
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
  // Strip ANSI. This output is handed back to the model as the correction it
  // must act on; colour codes turn the one line that matters into noise.
  const clean = ((r.stdout ?? '') + (r.stderr ?? '')).replace(/\u001b\[[0-9;]*m/g, '');
  return { status: r.status, output: clean.slice(-2500) };
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

/** pytest's own short-summary lines name every test that failed, which is what
 *  `--deselect` takes. Parsing them is how a partly-correct characterization
 *  file is salvaged instead of thrown away whole. */
export function failedNodeIds(output: string): string[] {
  return [...output.matchAll(/^FAILED (\S+?)(?: - |$)/gm)].map((m) => m[1]!);
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', 'target', '.codemaster']);

/**
 * Which module each public name actually lives in, read off disk.
 * The generator's most common failure is a plausible-but-wrong import
 * (`from streamjoin.join import Event` when `Event` is defined in `pairing`).
 * That errors at collection, so the test never runs and the only sound oracle
 * in the run is discarded. Naming the real surface costs nothing and is right.
 */
/** Small enough to send whole. An outline hides constructor bodies, and that
 *  is where the constraints live: measured on the benchmark, three separate
 *  attempts died on `int(key)` coercion in pairing.py and on guessed attribute
 *  names, because signatures alone cannot show either. Real source costs a few
 *  hundred tokens; each failed attempt costs a whole vendor floor. */
const VERBATIM_MAX = 6000;

export function importSurface(repoPath: string, fw: Framework, budget = 8000): string {
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
      if (src.length <= VERBATIM_MAX) {
        out.push(`# ${path.relative(repoPath, full)} — full source\n${src.trimEnd()}`);
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

async function generateOracle(
  kind: Kind,
  repoPath: string,
  problem: string,
  contextHint: string,
  manager: ProviderManager,
  cfg: Config,
  sessionId: string,
  opts: ReproOpts = {},
): Promise<Repro | null> {
  // Every `return null` below removes a sound oracle from the system, so each
  // one says why. Silence here is what let a whole benchmark run report success
  // with nothing ever executed.
  const label = kind === 'repro' ? 'reproduction test' : 'characterization test';
  const give = (why: string): null => {
    bus.emit({ type: 'log', level: 'warn', message: `No ${label}: ${why}` });
    return null;
  };
  const fw = frameworkForNewTest(repoPath);
  const ext = fw === 'pytest' ? 'py' : fw === 'jest' || fw === 'vitest' ? 'test.ts' : null;
  if (!ext) return give(`no supported test framework for this repository (${fw})`);

  const surface = importSurface(repoPath, fw);
  const dir = reproDir(repoPath, kind);
  const stem = kind === 'repro' ? 'cm_repro' : 'cm_char';
  const fileName = fw === 'pytest' ? `test_${stem}.py` : `${stem}.test.ts`;
  const file = path.join(dir, fileName);
  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });

  // Every attempt after the first differs from the one before it only by the
  // correction. Re-sending the problem and the whole code surface each time
  // buys nothing the vendor does not already hold — measured on
  // config-precedence, three attempts cost 108,096 tokens and admitted nothing.
  const conversation = { id: uuid(), turn: 0, provider_id: undefined as string | undefined, delta: '' };

  const ask = async (correction: string): Promise<string | null> => {
    const closing = kind === 'repro' ? `Write the failing test now.` : `Write the passing test now.`;
    conversation.delta = correction + closing;
    const { text } = await callLlm(manager, cfg, {
      system: kind === 'repro' ? SYSTEM : CHARACTERIZATION_SYSTEM,
      conversation,
      onConversation: (_id, providerId) => {
        conversation.provider_id = providerId;
      },
      user:
        (kind === 'repro'
          ? `## Reported problem\n${problem.slice(0, 4000)}\n\n`
          : `## A change is about to be made for this reason\n${problem.slice(0, 4000)}\n\n` +
            `Your job is the opposite of fixing it: pin down what already works nearby, so the fix cannot break it unnoticed.\n\n`) +
        // Surface is built from the same files the hint quotes, so sending both
        // pays twice for one fact. Prefer the surface; fall back to the hint
        // only where no surface could be built.
        (surface ? '' : `## Relevant code\n${contextHint.slice(0, 6000)}\n\n`) +
        (surface ? `## The real code of this repository — names, arities, attributes and the constraints in each body are EXACT; anything not shown here does not exist. Read the constructors before you build inputs.\n${surface}\n\n` : '') +
        correction +
        closing,
      sessionId,
      maxTokens: 1200,
    });
    conversation.turn += 1;
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
  /** Tests admitted out of the generated file — the ones that did not pass on
   *  the unchanged code, so their later failure would prove nothing. */
  let deselect: string[] = [];
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

    // Admission gate. A repro must genuinely FAIL on the current code: one that
    // passes does not capture the bug, one that errors on collection never ran.
    // A characterization test is the mirror image — it must PASS, because its
    // whole value is that a later failure means the fix broke something.
    const first = runReproFile(repoPath, file, fw, opts);
    let admitted =
      kind === 'repro' ? isGenuineFailure(fw, first.status, first.output) : first.status === 0;

    // A characterization file holds several independent tests. One wrong
    // assertion used to throw away the three correct ones with it, and with
    // them the only regression check the run had. Drop the failures, keep the
    // rest: a smaller true oracle beats no oracle.
    if (!admitted && kind === 'characterization' && fw === 'pytest') {
      const failing = failedNodeIds(first.output);
      if (failing.length > 0 && /\d+ passed/.test(first.output)) {
        const pruned = runReproFile(repoPath, file, fw, opts, failing);
        if (pruned.status === 0) {
          deselect = failing;
          admitted = true;
          bus.emit({
            type: 'log',
            level: 'info',
            message: `Characterization: kept the tests that pass, dropped ${failing.length} that did not.`,
          });
        }
      }
    }
    if (admitted) break;

    const tail = first.output.trim().split('\n').slice(-8).join('\n').slice(0, 900);
    const why =
      kind === 'repro'
        ? first.status === 0
          ? 'the generated test passed on the unfixed code, so it does not capture the bug'
          : `the generated test did not run (exit ${first.status}): ${tail}`
        : `the generated test did not pass on the unchanged code (exit ${first.status}): ${tail}`;
    if (attempt === ATTEMPTS - 1) {
      cleanup();
      return give(why);
    }
    correction =
      kind === 'characterization'
        ? `## Your previous attempt did not pass on the UNCHANGED code\n` +
          `\`\`\`\n${tail}\n\`\`\`\n` +
          `You either asserted behavior this code does not have, or your inputs were the wrong type or ` +
          `shape. Read what the source actually does, and assert only what it does today — including where ` +
          `that is imperfect. Import only names listed above.\n\n`
        : first.status === 0
          ? `## Your previous attempt PASSED on the buggy code, so it is worthless\n` +
            `\`\`\`\n${code.slice(0, 1200)}\n\`\`\`\n` +
            `Do NOT write that test again. It checked behavior that is already correct. Find the property ` +
            `the problem says is VIOLATED right now, assert that property, and make sure the assertion is ` +
            `false on the code as it stands.\n\n`
          : `## Your previous attempt did not run — it errored before reaching its assertion\n` +
            `\`\`\`\n${tail}\n\`\`\`\n` +
            `Read that error. If it came from the code under test rejecting your inputs, your inputs are the wrong ` +
            `type or shape — look at what the source actually does with them and construct valid ones. Import only ` +
            `names listed above.\n\n`;
    bus.emit({ type: 'log', level: 'info', message: `${label} rejected, retrying once: ${why}` });
  }

  return {
    path: file,
    run: () => {
      const r = runReproFile(repoPath, file, fw, opts, deselect);
      return { ok: r.status === 0, output: r.output };
    },
    cleanup,
  };
}

export function generateRepro(
  repoPath: string,
  problem: string,
  contextHint: string,
  manager: ProviderManager,
  cfg: Config,
  sessionId: string,
  opts: ReproOpts = {},
): Promise<Repro | null> {
  return generateOracle('repro', repoPath, problem, contextHint, manager, cfg, sessionId, opts);
}

/** The regression half of the oracle. A repro proves the fix arrived; only this
 *  proves nothing else left. Measured on the benchmark: the fix landed and four
 *  tests that had passed before started failing, and nothing in the system
 *  looked. Where the repo ships tests they are the stronger form of this check
 *  and this is not generated at all. */
export function generateCharacterization(
  repoPath: string,
  problem: string,
  contextHint: string,
  manager: ProviderManager,
  cfg: Config,
  sessionId: string,
  opts: ReproOpts = {},
): Promise<Repro | null> {
  return generateOracle('characterization', repoPath, problem, contextHint, manager, cfg, sessionId, opts);
}
