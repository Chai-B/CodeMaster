// Benchmark: CodeMaster vs direct provider use, on the stream-join-lateness task
// from ~/triton-toolkit/tasks. The task ships a broken operator, a deterministic
// behavioural verifier, and a reference solution — so pass/fail is measured, not
// judged, and the same verifier scores both sides.
//
//   npx tsx bench/streamjoin.ts --verify-only   no LLM: prove the harness scores
//                                               the broken tree and the gold fix
//                                               differently
//   npx tsx bench/streamjoin.ts --cm            run CodeMaster, then verify
//   npx tsx bench/streamjoin.ts --baseline      run `claude -p` directly, verify
//   npx tsx bench/streamjoin.ts                 both, side by side

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const TASK = path.join(os.homedir(), 'triton-toolkit/tasks/stream-join-lateness');
const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = process.env.BENCH_DIR ?? path.join(os.tmpdir(), 'cm-streamjoin');

interface Score {
  passed: number;
  failed: number;
  total: number;
  detail: string;
}

interface Run {
  label: string;
  score: Score;
  tokens: number;
  seconds: number;
  changed: string[];
}

/** `live` passes the child's stderr straight through. A benchmark run takes
 *  minutes; buffering its progress until it exits leaves the operator staring
 *  at nothing, unable to tell a working run from a hung one. */
function sh(cmd: string, args: string[], cwd: string, input = '', live = false): { out: string; err: string; code: number } {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: live ? ['pipe', 'pipe', 'inherit'] : 'pipe',
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
}

/** A scratch repository holding only the broken operator, exactly as the task
 *  ships it. Committed, so `git diff` and the tool's own checkpointing work. */
function prepare(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(TASK, 'environment/streamjoin'), path.join(dir, 'streamjoin'), { recursive: true });
  fs.copyFileSync(path.join(TASK, 'instruction.md'), path.join(dir, 'instruction.md'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'commit', '-qm', 'broken operator'], dir);
}

/**
 * Run the task's own verifier against a scratch tree. The published test file
 * hardcodes `/app`; rewriting that one path is the only change, so the graded
 * behaviour — including the pairing swap and both resource bounds — is the
 * task's, untouched.
 */
function verify(dir: string): Score {
  const src = fs.readFileSync(path.join(TASK, 'tests/test_outputs.py'), 'utf8');
  const test = path.join(dir, '_verify.py');
  fs.writeFileSync(test, src.replaceAll('"/app"', JSON.stringify(dir)), 'utf8');
  const r = sh('uvx', ['--with', 'pytest==8.4.1', 'pytest', test, '-q', '--no-header', '-p', 'no:cacheprovider'], dir);
  const text = r.out + r.err;
  const passed = Number(/(\d+) passed/.exec(text)?.[1] ?? 0);
  const failed = Number(/(\d+) failed/.exec(text)?.[1] ?? 0);
  const errors = Number(/(\d+) errors?/.exec(text)?.[1] ?? 0);
  // uv prints its own install line last, so take the summary line pytest wrote.
  const last = text.split('\n').filter((l) => /\d+ (passed|failed|error)/.test(l)).pop() ?? 'no output';
  fs.rmSync(test, { force: true });
  return { passed, failed: failed + errors, total: passed + failed + errors, detail: last.trim() };
}

function changedFiles(dir: string): string[] {
  return sh('git', ['status', '--porcelain'], dir).out
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((l) => l && !l.startsWith('_verify'));
}

const OBJECTIVE = fs.readFileSync(path.join(TASK, 'instruction.md'), 'utf8').replaceAll('/app/', './');

/** CodeMaster, non-interactive, reporting its own token total. */
function runCodemaster(dir: string): Run {
  prepare(dir);
  const started = Date.now();
  // The objective goes in on stdin so a multi-paragraph instruction survives
  // intact, rather than being re-quoted through an argv slot.
  const r = sh(
    'npx',
    ['tsx', path.join(ROOT, 'src/index.tsx'), 'run', '--repo', dir, '--json', '--verbose'],
    ROOT,
    `${OBJECTIVE}\n\nThe operator is in ./streamjoin/. Fix it in place.`,
    true,
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  let tokens = 0;
  try {
    const j = JSON.parse(r.out) as { tokens?: { total?: number } };
    tokens = j.tokens?.total ?? 0;
  } catch {
    process.stderr.write(`codemaster produced no JSON result:\n${r.err.slice(-2000)}\n`);
  }
  return { label: 'CodeMaster', score: verify(dir), tokens, seconds, changed: changedFiles(dir) };
}

/**
 * The control: the same vendor CLI CodeMaster would call, pointed at the same
 * broken tree with the same instruction and left to explore it itself. Its own
 * reported usage is the token figure, summed the same way the adapter sums it.
 */
function runBaseline(dir: string): Run {
  prepare(dir);
  const started = Date.now();
  const r = sh(
    'claude',
    ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', dir],
    dir,
    `${OBJECTIVE}\n\nThe operator is in ./streamjoin/. Fix it in place.`,
    true,
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  let tokens = 0;
  try {
    const u = (JSON.parse(r.out) as { usage?: Record<string, number> }).usage ?? {};
    tokens =
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
  } catch {
    process.stderr.write(`claude produced no JSON result:\n${r.err.slice(-2000)}\n`);
  }
  return { label: 'claude (direct)', score: verify(dir), tokens, seconds, changed: changedFiles(dir) };
}

/** No LLM: the broken tree must fail and the reference solution must pass. If
 *  those two do not differ, no number this harness reports means anything. */
function selfTest(): number {
  const dir = path.join(WORK, 'selftest');
  prepare(dir);
  const broken = verify(dir);
  console.log(`broken start state: ${broken.passed}/${broken.total} passed — ${broken.detail}`);

  fs.copyFileSync(path.join(TASK, 'solution/solve.py'), path.join(dir, 'streamjoin/join.py'));
  const gold = verify(dir);
  console.log(`reference solution:  ${gold.passed}/${gold.total} passed — ${gold.detail}`);

  const ok = gold.total > 0 && gold.failed === 0 && broken.failed > 0;
  console.log(ok ? '\nHarness discriminates. Benchmark runs are meaningful.' : '\nHarness does NOT discriminate — do not trust its numbers.');
  return ok ? 0 : 1;
}

function report(runs: Run[]): void {
  console.log('');
  for (const r of runs) {
    console.log(
      `${r.label.padEnd(16)} ${String(r.score.passed).padStart(3)}/${r.score.total} tests · ` +
        `${r.tokens.toLocaleString().padStart(10)} tokens · ${String(r.seconds).padStart(5)}s · ${r.changed.join(', ') || 'no changes'}`,
    );
  }
  const [a, b] = runs;
  if (a && b && a.tokens > 0 && b.tokens > 0) {
    console.log(`\nCodeMaster spent ${((a.tokens / b.tokens) * 100).toFixed(0)}% of the tokens the direct run spent.`);
  }
}

if (!fs.existsSync(TASK)) {
  console.error(`Benchmark task not found at ${TASK}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes('--verify-only')) {
  process.exit(selfTest());
} else {
  const runs: Run[] = [];
  if (!argv.includes('--baseline')) runs.push(runCodemaster(path.join(WORK, 'cm')));
  if (!argv.includes('--cm')) runs.push(runBaseline(path.join(WORK, 'baseline')));
  report(runs);
  fs.mkdirSync(path.join(ROOT, 'bench/results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'bench/results/streamjoin.json'), JSON.stringify(runs, null, 2) + '\n', 'utf8');
}
