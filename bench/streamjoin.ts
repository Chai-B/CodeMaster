// CodeMaster vs direct provider use, on one task with a deterministic verifier
// (~/triton-toolkit/tasks/stream-join-lateness: a broken stream-join operator,
// a behavioural test suite, a reference solution).
//
// What is being measured is the LAYER, not the model — so both sides run the
// same model, the cheapest one that can attempt the task. Whatever that model
// is, the layer should beat calling it directly.
//
//   npx tsx bench/streamjoin.ts --verify-only    no LLM: prove the verifier
//                                                separates broken from fixed
//   npx tsx bench/streamjoin.ts --cm             CodeMaster only
//   npx tsx bench/streamjoin.ts --baseline       direct `claude -p` only
//   npx tsx bench/streamjoin.ts --report         compare saved runs
//
// MODEL=<id> pins the model for both sides (default: haiku).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const TASK = path.join(os.homedir(), 'triton-toolkit/tasks/stream-join-lateness');
const ROOT = path.resolve(import.meta.dirname, '..');
const RESULTS = path.join(ROOT, 'bench/results');
// Never under ~/.claude: the vendor CLI treats that tree as sensitive and
// blocks every write there, which reads as "the agent changed nothing".
const WORK = path.join(os.tmpdir(), 'cm-streamjoin');

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001';
const CLI_MODEL = /haiku/.test(MODEL) ? 'haiku' : /opus/.test(MODEL) ? 'opus' : 'sonnet';

interface Run {
  label: string;
  passed: number;
  total: number;
  failures: string[];
  tokens: number;
  /** The only fair cross-side metric. Token counts are not comparable: one side
   *  folds cache reads into `input`, the other reports them separately. */
  costUsd: number;
  seconds: number;
  changed: string[];
  /** The agent's own account of what it did — the thing a bare score cannot
   *  show, and usually the reason one side beats the other. */
  reasoning: string;
  diff: string;
}

function sh(cmd: string, args: string[], cwd: string, input = ''): { out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** A scratch repo holding only the broken operator, exactly as the task ships it. */
function prepare(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(TASK, 'environment/streamjoin'), path.join(dir, 'streamjoin'), { recursive: true });
  sh('git', ['init', '-q'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.email=b@l', '-c', 'user.name=b', 'commit', '-qm', 'broken operator'], dir);
}

/**
 * The task's own verifier, run against a COPY. The verifier overwrites
 * pairing.py with the grader's version by design, so scoring in place would
 * rewrite the tree being scored and make the agent look like it edited a file
 * the instruction forbids. Only the hardcoded `/app` path is changed.
 */
function verify(dir: string): { passed: number; total: number; failures: string[] } {
  const scratch = `${dir}-verify`;
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.cpSync(dir, scratch, { recursive: true, filter: (p) => !p.includes('.git') });
  const test = path.join(scratch, '_verify.py');
  const src = fs.readFileSync(path.join(TASK, 'tests/test_outputs.py'), 'utf8');
  fs.writeFileSync(test, src.replaceAll('"/app"', JSON.stringify(scratch)));

  const r = sh('uvx', ['--with', 'pytest==8.4.1', 'pytest', test, '-q', '--no-header', '-rf', '-p', 'no:cacheprovider'], scratch);
  const text = (r.out + r.err).replace(/\[[0-9;]*m/g, '');
  const passed = Number(/(\d+) passed/.exec(text)?.[1] ?? 0);
  const failed = Number(/(\d+) failed/.exec(text)?.[1] ?? 0) + Number(/(\d+) errors?/.exec(text)?.[1] ?? 0);
  const failures = text
    .split('\n')
    .filter((l) => l.startsWith('FAILED'))
    .map((l) => /::(\w+)/.exec(l)?.[1] ?? l.trim());

  fs.rmSync(scratch, { recursive: true, force: true });
  return { passed, total: passed + failed, failures };
}

function diffOf(dir: string): { changed: string[]; diff: string } {
  const changed = sh('git', ['status', '--porcelain'], dir)
    .out.split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  sh('git', ['add', '-A'], dir);
  return { changed, diff: sh('git', ['diff', '--cached'], dir).out };
}

// The instruction as published, minus the container path. One added line names
// the failure both sides must fix, so neither has to guess what "doesn't hold
// up" means — the layer is being measured, not prompt luck.
const OBJECTIVE =
  fs.readFileSync(path.join(TASK, 'instruction.md'), 'utf8').replaceAll('/app/', './') +
  '\n\nThe operator is in ./streamjoin/join.py. It is functionally correct but never evicts: ' +
  'retained state grows without bound, which violates the retained-state bound. Fix it in place, ' +
  'without breaking the join contract. Do not edit pairing.py.';

function record(run: Run): Run {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, `${run.label}.json`), JSON.stringify(run, null, 2) + '\n');
  console.log(
    `\n${run.label}: ${run.passed}/${run.total} · $${run.costUsd.toFixed(4)} · ${run.tokens.toLocaleString()} tokens · ${run.seconds}s`,
  );
  if (run.failures.length) console.log(`  failing: ${run.failures.join(', ')}`);
  return run;
}

function runCodemaster(): Run {
  const dir = path.join(WORK, 'cm');
  prepare(dir);
  const started = Date.now();
  const r = spawnSync(
    'npx',
    ['tsx', path.join(ROOT, 'src/index.tsx'), 'run', '--repo', dir, '--model', MODEL, '--json', '--verbose'],
    { cwd: ROOT, input: OBJECTIVE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  let tokens = 0;
  let costUsd = 0;
  let reasoning = '';
  try {
    const j = JSON.parse(r.stdout ?? '') as {
      tokens?: { total?: number; cost_usd?: number; by_model?: Record<string, number> };
      tasks?: Array<{ title: string; status: string }>;
    };
    tokens = j.tokens?.total ?? 0;
    costUsd = j.tokens?.cost_usd ?? 0;
    const models = Object.keys(j.tokens?.by_model ?? {});
    reasoning =
      (j.tasks ?? []).map((t) => `${t.status === 'completed' ? 'ok  ' : 'fail'} ${t.title}`).join('\n') +
      // Failover can move a run onto another model; a result naming one model
      // without checking this is not reproducible.
      (models.length ? `\n\nmodels used: ${models.join(', ')}` : '');
  } catch {
    reasoning = '(no JSON result — see stderr)';
  }
  const { changed, diff } = diffOf(dir);
  return record({ label: 'codemaster', ...verify(dir), tokens, costUsd, seconds, changed, reasoning, diff });
}

/** The control: the same model, the same instruction, exploring the tree itself. */
function runBaseline(): Run {
  const dir = path.join(WORK, 'baseline');
  prepare(dir);
  const started = Date.now();
  const r = spawnSync(
    'claude',
    ['-p', '--model', CLI_MODEL, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', dir],
    { cwd: dir, input: OBJECTIVE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  let tokens = 0;
  let costUsd = 0;
  let reasoning = '';
  try {
    const j = JSON.parse(r.stdout ?? '') as { usage?: Record<string, number>; result?: string; total_cost_usd?: number };
    const u = j.usage ?? {};
    tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    // The first run of this benchmark never recorded this, so the two sides
    // could not be compared on the only metric that is actually comparable.
    costUsd = j.total_cost_usd ?? 0;
    reasoning = j.result ?? '';
  } catch {
    reasoning = `(no JSON result)\n${(r.stderr ?? '').slice(-1000)}`;
  }
  const { changed, diff } = diffOf(dir);
  return record({ label: 'baseline', ...verify(dir), tokens, costUsd, seconds, changed, reasoning, diff });
}

/** No LLM: the broken tree must fail and the reference solution must pass. */
function selfTest(): number {
  const dir = path.join(WORK, 'selftest');
  prepare(dir);
  const broken = verify(dir);
  fs.copyFileSync(path.join(TASK, 'solution/solve.py'), path.join(dir, 'streamjoin/join.py'));
  const gold = verify(dir);
  console.log(`broken start state: ${broken.passed}/${broken.total} — failing: ${broken.failures.join(', ') || 'none'}`);
  console.log(`reference solution: ${gold.passed}/${gold.total} — failing: ${gold.failures.join(', ') || 'none'}`);
  const ok = gold.total > 0 && gold.failures.length === 0 && broken.failures.length > 0;
  console.log(ok ? '\nVerifier discriminates. Runs are meaningful.' : '\nVerifier does NOT discriminate — its numbers mean nothing.');
  return ok ? 0 : 1;
}

function report(): void {
  const runs = ['codemaster', 'baseline']
    .map((l) => path.join(RESULTS, `${l}.json`))
    .filter((p) => fs.existsSync(p))
    .map((p) => JSON.parse(fs.readFileSync(p, 'utf8')) as Run);
  if (!runs.length) {
    console.log('No saved runs. Run --cm and --baseline first.');
    return;
  }

  console.log(`\nmodel: ${MODEL}\n`);
  console.log('side          tests        cost   tokens      time   files changed');
  for (const r of runs) {
    console.log(
      `${r.label.padEnd(12)} ${String(r.passed).padStart(3)}/${r.total}  ` +
        `${(r.costUsd ? `$${r.costUsd.toFixed(4)}` : 'n/a').padStart(10)}  ` +
        `${r.tokens.toLocaleString().padStart(9)}  ${String(r.seconds).padStart(5)}s   ${r.changed.join(', ') || 'none'}`,
    );
  }
  if (runs.some((r) => !r.costUsd)) {
    console.log('\nNOTE: a side reports no cost — that run predates cost capture and cannot be compared on price.');
  }
  for (const r of runs) {
    console.log(`\n-- ${r.label} ${'-'.repeat(40)}`);
    if (r.failures.length) console.log(`failing: ${r.failures.join(', ')}`);
    console.log(r.reasoning.trim().slice(0, 1200) || '(no account given)');
  }
}

if (!fs.existsSync(TASK)) {
  console.error(`Benchmark task not found at ${TASK}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes('--verify-only')) process.exit(selfTest());
else if (argv.includes('--report')) report();
else {
  if (!argv.includes('--baseline')) runCodemaster();
  if (!argv.includes('--cm')) runBaseline();
  report();
}
