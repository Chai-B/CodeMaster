// Deterministic test runner + crash guard (spec §12.2 TestResults, §2 rule 1 —
// the orchestrator runs these commands, never the LLM). Robust when a tool is
// absent: returns a `ran:false` skipped signal rather than crashing the loop.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export type Framework = 'pytest' | 'jest' | 'vitest' | 'gotest' | 'cargo' | 'unknown';

export interface TestRunResult {
  ok: boolean; // true iff a run happened AND 0 failures
  ran: boolean; // false => tool missing / detection failed (skipped)
  passed: number;
  failed: number;
  total: number;
  framework: Framework;
  output: string; // trimmed tail for feedback
}

export interface GuardResult {
  ok: boolean;
  ran: boolean;
  output: string;
}

export interface RunOpts {
  timeoutMs?: number;
  pythonBin?: string;
  maxTestFiles?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const tail = (s: string, n = 4000): string => (s.length > n ? s.slice(-n) : s);

export function detectFramework(repoPath: string): Framework {
  const has = (f: string) => fs.existsSync(path.join(repoPath, f));
  if (has('Cargo.toml')) return 'cargo';
  if (has('go.mod')) return 'gotest';
  if (has('pyproject.toml') || has('pytest.ini') || has('conftest.py') || has('setup.cfg') || has('tox.ini')) return 'pytest';
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.vitest) return 'vitest';
      if (deps.jest || /jest/.test(pkg.scripts?.test ?? '')) return 'jest';
      if (deps.vitest === undefined && /vitest/.test(pkg.scripts?.test ?? '')) return 'vitest';
    } catch {
      /* unparseable package.json */
    }
  }
  return 'unknown';
}

const num = (re: RegExp, s: string): number => Number(re.exec(s)?.[1] ?? 0);

/** Run the given test files (or the framework default) and parse pass/fail. */
export function runTests(repoPath: string, testFiles?: string[], opts: RunOpts = {}): TestRunResult {
  const framework = detectFramework(repoPath);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const files = (testFiles ?? []).slice(0, opts.maxTestFiles ?? 30);
  const skipped = (): TestRunResult => ({ ok: true, ran: false, passed: 0, failed: 0, total: 0, framework, output: '' });
  if (framework === 'unknown') return skipped();

  let cmd: string;
  let args: string[];
  switch (framework) {
    case 'pytest':
      cmd = opts.pythonBin ?? 'python3';
      args = ['-m', 'pytest', ...files, '-q', '-p', 'no:cacheprovider', '--no-header'];
      break;
    case 'jest':
      cmd = 'npx';
      args = ['jest', '--silent', ...files];
      break;
    case 'vitest':
      cmd = 'npx';
      args = ['vitest', 'run', ...files];
      break;
    case 'gotest':
      cmd = 'go';
      args = ['test', ...(files.length ? [...new Set(files.map((f) => './' + path.dirname(f)))] : ['./...'])];
      break;
    case 'cargo':
      cmd = 'cargo';
      args = ['test'];
      break;
    default:
      return skipped();
  }

  const r = spawnSync(cmd, args, { cwd: repoPath, encoding: 'utf8', timeout, maxBuffer: 1e8 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return skipped();
  if (r.status === null) return { ok: false, ran: true, passed: 0, failed: 0, total: 0, framework, output: 'test run timed out' };

  let passed = 0;
  let failed = 0;
  if (framework === 'pytest') {
    passed = num(/(\d+) passed/, out);
    failed = num(/(\d+) failed/, out) + num(/(\d+) error/, out);
  } else if (framework === 'gotest') {
    failed = (out.match(/^--- FAIL/gm) ?? []).length;
    passed = (out.match(/^--- PASS/gm) ?? []).length || (r.status === 0 ? 1 : 0);
  } else if (framework === 'cargo') {
    passed = num(/(\d+) passed/, out);
    failed = num(/(\d+) failed/, out);
  } else {
    // jest / vitest
    passed = num(/(\d+) passed/i, out) || num(/Tests:\s+(\d+) passed/i, out);
    failed = num(/(\d+) failed/i, out) || num(/Tests:\s+(\d+) failed/i, out);
  }
  // Trust the exit code when parsing yields nothing.
  if (passed === 0 && failed === 0) {
    if (r.status === 0) passed = files.length || 1;
    else failed = 1;
  }
  return { ok: r.status === 0 && failed === 0, ran: true, passed, failed, total: passed + failed, framework, output: tail(out) };
}

/** Repo-relative .py path → dotted module (`a/b/c.py` → `a.b.c`, `a/__init__.py` → `a`). */
function toModule(rel: string): string | null {
  const noext = rel.replace(/\.py$/, '');
  const parts = noext.split('/').filter(Boolean);
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts.length ? parts.join('.') : null;
}

/** True iff the import error is the env failing to load the module's top package
 *  (not installed) rather than a real breakage introduced by the edit. */
function isEnvImportError(stderr: string, mod: string): boolean {
  const m = /No module named '([^']+)'/.exec(stderr);
  if (!m) return false; // ImportError/AttributeError/etc. — a real, edit-introduced break
  const missing = m[1]!;
  const top = mod.split('.')[0]!;
  // Internal submodule of our own package missing => a break the edit caused.
  if (missing === top || missing.startsWith(top + '.')) return missing === top;
  // A sibling top-level package missing => dependency not installed (environment).
  return true;
}

/** Cheap crash guard on the changed files only: syntax/type/import errors. */
export function typeOrImportCheck(repoPath: string, changedFiles: string[], opts: RunOpts = {}): GuardResult {
  const timeout = opts.timeoutMs ?? 60_000;
  const py = opts.pythonBin ?? 'python3';
  const tsChanged = changedFiles.filter((f) => /\.(ts|tsx)$/.test(f));
  const pyChanged = changedFiles.filter((f) => /\.py$/.test(f));

  if (pyChanged.length) {
    for (const f of pyChanged) {
      // (a) syntax gate.
      const c = spawnSync(py, ['-m', 'py_compile', f], { cwd: repoPath, encoding: 'utf8', timeout });
      if (c.error && (c.error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, ran: false, output: '' };
      if (c.status !== 0) return { ok: false, ran: true, output: tail((c.stderr ?? '') || `py_compile failed: ${f}`, 1500) };

      // (b) import gate — executes the module so broken/hallucinated imports
      // (valid syntax, unresolvable at runtime) are caught. Fair: a module the
      // env can't load at all (top package not installed) is a skip, not a fail.
      const mod = toModule(f);
      if (!mod) continue;
      const im = spawnSync(py, ['-c', `import ${mod}`], { cwd: repoPath, encoding: 'utf8', timeout });
      if (im.error && (im.error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, ran: false, output: '' };
      if (im.status !== 0) {
        const err = (im.stderr ?? '') + (im.stdout ?? '');
        if (isEnvImportError(err, mod)) continue; // env not set up for this module → skip
        return { ok: false, ran: true, output: tail(err || `import failed: ${mod}`, 1500) };
      }
    }
  }

  if (tsChanged.length && fs.existsSync(path.join(repoPath, 'tsconfig.json'))) {
    const r = spawnSync('npx', ['tsc', '--noEmit'], { cwd: repoPath, encoding: 'utf8', timeout, maxBuffer: 1e8 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, ran: false, output: '' };
    // Only fail on diagnostics pointing at a changed file (ignore pre-existing repo errors).
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const relevant = out
      .split('\n')
      .filter((l) => tsChanged.some((f) => l.includes(f)));
    if (relevant.length) return { ok: false, ran: true, output: tail(relevant.join('\n'), 1500) };
    return { ok: true, ran: true, output: '' };
  }

  if (!pyChanged.length && !tsChanged.length) return { ok: true, ran: false, output: '' };
  return { ok: true, ran: true, output: '' };
}
