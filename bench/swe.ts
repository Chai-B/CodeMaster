// SWE-bench-style scored run: CodeMaster vs. raw Claude Code on real fastapi PRs.
// Each system gets ONLY the linked issue text. Graded two ways:
//   (1) OBJECTIVE  — does the system's patch make the PR's fail-to-pass tests pass
//                    (run in an era-correct venv against the real regression tests)
//   (2) JUDGE      — LLM scores each patch vs the ACTUAL merged fix (ground truth)
// The system never sees the tests or the reference fix. Nothing is fabricated.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { staticAnalysis } from '../src/analysis/api.js';
import { compileContext } from '../src/context/compiler.js';
import { ProviderManager } from '../src/providers/manager.js';
import { loadConfig } from '../src/config.js';
import { Sessions, Tasks } from '../src/storage/sessions.js';
import { parseObjective } from '../src/workers/intentParser.js';
import { solveWithVerification } from '../src/workers/solver.js';
import { makeBehavioralVerify } from '../src/workers/verify/behavioralVerify.js';
import { generateRepro } from '../src/workers/verify/reproGenerator.js';
import { id, now } from '../src/util/id.js';
import type { Session, Task } from '../src/types/index.js';

const H = '/Users/chaitanyabansal/cm-bench/harness';
const cfg = JSON.parse(fs.readFileSync(`${H}/config.json`, 'utf8'));
const REPO: string = cfg.repo;
const MODEL: string = cfg.model;
process.env.CODEMASTER_DATA_DIR = `${H}/cm-data`; // fresh, isolated from portfolio
const ONLY = process.env.PR_ONLY;
const CLAUDE_ONLY = process.env.CLAUDE_ONLY === '1'; // re-validate the Claude baseline without re-running CM
const CM_ONLY = process.env.CM_ONLY === '1'; // measure CodeMaster only (skip the expensive Claude agentic side)

const git = (args: string[]) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8 });
const baseOf = (hash: string) => fs.readFileSync(`${H}/meta/${hash}.info.txt`, 'utf8').trim().split(/\s+/)[0]!;
const f2pOf = (hash: string) => fs.readFileSync(`${H}/meta/${hash}.f2p.txt`, 'utf8').trim().split('\n').filter(Boolean);
const goldDiff = (hash: string) => fs.readFileSync(`${H}/patches/${hash}.gold.patch`, 'utf8');

function resetTo(base: string) {
  git(['checkout', '-f', base]);
  git(['clean', '-fdq', 'fastapi', 'tests']);
  fs.rmSync(`${REPO}/.codemaster`, { recursive: true, force: true });
}
function sysFastapiDiff() { return git(['diff', '--', 'fastapi']).stdout ?? ''; }
function applyGoldTest(hash: string) { return spawnSync('git', ['apply', `${H}/patches/${hash}.test.patch`], { cwd: REPO, encoding: 'utf8' }).status === 0; }

function venvPython(hash: string): string {
  const cands = [`${H}/venvs/${hash}/bin/python`, `${REPO}/.venv-base/bin/python`, `${REPO}/.venv/bin/python`];
  return cands.find((p) => fs.existsSync(p)) ?? cands[cands.length - 1]!;
}

function runPytest(hash: string, tests: string[]): { passed: number; total: number } {
  const r = spawnSync(venvPython(hash), ['-m', 'pytest', ...tests, '-q', '-p', 'no:cacheprovider', '--no-header'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8, timeout: 240000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const passed = Number(/(\d+) passed/.exec(out)?.[1] ?? 0);
  return { passed, total: tests.length };
}

function claudeJson(prompt: string, opts: { agentic?: boolean; system?: string; timeout?: number }) {
  const args = ['--model', MODEL, '-p', '--output-format', 'json'];
  if (opts.system) args.push('--system-prompt', opts.system);
  if (opts.agentic) args.push('--permission-mode', 'bypassPermissions');
  else args.push('--disallowed-tools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'NotebookEdit', '--exclude-dynamic-system-prompt-sections');
  // Empty stdout is a transient CLI-overload symptom; retry so one flaky call
  // doesn't zero out the baseline (matches the CM provider path).
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, [2000, 5000, 10000][attempt - 1]!);
    const r = spawnSync('claude', args, { cwd: REPO, input: prompt, encoding: 'utf8', maxBuffer: 1e8, timeout: opts.timeout ?? 420000 });
    try {
      const d = JSON.parse(r.stdout);
      const u = d.usage ?? {};
      const text = d.result ?? '';
      if (!text && attempt < 3) continue; // empty result → transient; retry
      return { text, tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0), turns: d.num_turns ?? 1 };
    } catch {
      if (attempt < 3) continue;
    }
  }
  return { text: '', tokens: 0, turns: 0 };
}

function runClaude(pr: any) {
  const base = baseOf(pr.hash);
  resetTo(base);
  const started = Date.now();
  const prompt = `${pr.problem}\n\nThis is the FastAPI repository (Python) at a commit BEFORE this bug was fixed. Fix the bug by editing the source files under fastapi/. Do NOT modify or add any tests.`;
  let r = claudeJson(prompt, { agentic: true, timeout: 1_200_000 });
  // Retry once if the agentic run produced nothing (transient CLI failure).
  if (!sysFastapiDiff().trim()) { git(['checkout', '-f', base]); git(['clean', '-fdq', 'fastapi', 'tests']); r = claudeJson(prompt, { agentic: true, timeout: 1_200_000 }); }
  const ms = Date.now() - started;
  git(['checkout', '--', 'tests']); // discard any test edits — only source counts
  const diff = sysFastapiDiff();
  applyGoldTest(pr.hash);
  const res = runPytest(pr.hash, f2pOf(pr.hash));
  resetTo(base);
  return { diff, ms, tokens: r.tokens, turns: r.turns, ...res };
}

async function runCodeMaster(pr: any) {
  const base = baseOf(pr.hash);
  resetTo(base);
  const api = staticAnalysis(REPO);
  await api.reindex({ embed: true });
  const cm = loadConfig();
  const mgr = new ProviderManager(cm);
  const objective = `${pr.problem}\n\nFix this by editing the FastAPI source under fastapi/. Make the MINIMAL change necessary — do not reorganize imports, rename symbols, or rewrite unrelated code, and use only modules and names that already exist in this repository.`;
  const session: Session = {
    id: id('session'), created_at: now(), updated_at: now(), status: 'active', objective,
    objective_parsed: parseObjective(objective), repository: { path: REPO, commit: base },
    progress: { total: 0, completed: 0, failed: 0 }, constraints: [], open_questions: [], working_files: [],
    decisions: [], provider_history: [], checkpoints: [], token_usage: { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 },
    current_provider: { provider_id: 'anthropic', model_id: MODEL }, metadata: {},
  };
  Sessions.insert(session);
  const task: Task = { id: id('task'), session_id: session.id, title: pr.title, description: objective, type: 'debug', status: 'in_progress', input_files: [], output_files: [], dependencies: [], blocking: [], reasoning_refs: [], decision_refs: [], estimated_tokens: 0, order: 0 };
  Tasks.insert(task);
  // Context size for reporting (executeTask recompiles each iteration internally).
  const compiled = await compileContext(session, task, { maxContextTokens: 200_000, fileCompressionThreshold: 8000 });

  // Verify-and-iterate (spec §12.2/§14.1): behavioral signal the orchestrator runs
  // — crash-guard → admitted repro (synthesized from the PUBLIC problem, admitted
  // only if it fails on the buggy code) → the repo's own relevant tests. Fair: the
  // hidden fail-to-pass tests are applied only AFTER solve (applyGoldTest), so they
  // can never leak into verify.
  const venvPy = venvPython(pr.hash);
  const changedGetter = () => (sysFastapiDiff().match(/\+\+\+ b\/(\S+)/g) ?? []).map((m) => m.replace('+++ b/', ''));
  const hint = compiled.components.find((c) => c.component === 'relevant_files')?.content.slice(0, 2500) ?? '';
  const repro = await generateRepro(REPO, pr.problem, hint, mgr, cm, session.id, { pythonBin: venvPy, timeoutMs: 90_000 }).catch(() => null);
  const bv = makeBehavioralVerify(REPO, changedGetter, { pythonBin: venvPy, timeoutMs: 180_000 }, repro);
  const started = Date.now();
  const solved = await solveWithVerification(session, task, mgr, cm, bv.verify, 3);
  repro?.cleanup();
  const ms = Date.now() - started;
  const written = (sysFastapiDiff().match(/\+\+\+ b\/(\S+)/g) ?? []).map((m) => m.replace('+++ b/', ''));
  const diff = sysFastapiDiff();
  applyGoldTest(pr.hash);
  const res = runPytest(pr.hash, f2pOf(pr.hash));
  resetTo(base);
  return { diff, ms, tokens: solved.totalTokens, ctx: compiled.total_tokens, written, iterations: solved.iterations, verified: solved.verified, ...res };
}

function judge(pr: any, claudeDiff: string, cmDiff: string, seed: number) {
  const swap = seed % 2 === 0;
  const s1 = swap ? cmDiff : claudeDiff;
  const s2 = swap ? claudeDiff : cmDiff;
  const sys = 'You grade two attempted bug-fix diffs against the REFERENCE (correct, merged) fix. Score each attempt 0-10 for how correctly and completely it addresses the bug relative to the reference (an empty or irrelevant diff scores 0). Respond ONLY JSON: {"s1":<0-10>,"s2":<0-10>,"note":"one sentence"}.';
  const prompt = `Bug:\n${pr.problem}\n\n=== REFERENCE fix (correct) ===\n${goldDiff(pr.hash).slice(0, 8000)}\n\n=== Attempt 1 ===\n${(s1 || '(no changes)').slice(0, 8000)}\n\n=== Attempt 2 ===\n${(s2 || '(no changes)').slice(0, 8000)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = claudeJson(prompt, { system: sys, timeout: 180000 });
    let j: any = {};
    try { j = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] ?? '{}'); } catch { /* retry */ }
    const c = Number(swap ? j.s2 : j.s1);
    const m = Number(swap ? j.s1 : j.s2);
    if (Number.isFinite(c) && Number.isFinite(m)) return { claude: c, cm: m, note: j.note ?? '' };
  }
  return { claude: 0, cm: 0, note: '(judge unparseable)' };
}

async function main() {
  const prs = (cfg.prs as any[]).filter((p) => !ONLY || ONLY.split(',').includes(p.hash));
  const results: any[] = [];
  let i = 0;
  for (const pr of prs) {
    i++;
    console.log(`\n########## [${i}/${prs.length}] ${pr.hash} #${pr.issue} — ${pr.title} ##########`);
    let m: any;
    if (CLAUDE_ONLY) {
      const prev = JSON.parse(fs.readFileSync(`${H}/results/${pr.hash}.json`, 'utf8'));
      m = { ...prev.cm, diff: prev.cmDiff ?? '' };
      console.log(`     CodeMaster (reused): tests ${m.passed}/${m.total} · ${m.tokens} tok`);
    } else {
      console.log('  → CodeMaster…');
      m = await runCodeMaster(pr);
      console.log(`     tests ${m.passed}/${m.total} · ${m.tokens} tok · ctx ${m.ctx} · wrote [${m.written.join(', ')}] · ${(m.ms / 1000).toFixed(0)}s`);
    }
    let c: any = { passed: 0, total: 0, turns: 0, tokens: 0, ms: 0, diff: '' };
    let j = { claude: 0, cm: 0, note: '(cm-only)' };
    if (!CM_ONLY) {
      console.log('  → Claude Code (agentic)…');
      c = runClaude(pr);
      console.log(`     tests ${c.passed}/${c.total} · ${c.turns} turns · ${c.tokens} tok · ${(c.ms / 1000).toFixed(0)}s · diff ${c.diff.length}b`);
      console.log('  → judging vs merged fix…');
      j = judge(pr, c.diff, m.diff, i);
      console.log(`     judge: Claude ${j.claude}/10 · CodeMaster ${j.cm}/10 — ${j.note}`);
    }
    const row = { pr: pr.hash, issue: pr.issue, title: pr.title, claude: { ...c, diff: undefined, judge: j.claude }, cm: { ...m, diff: undefined, judge: j.cm }, judgeNote: j.note };
    results.push(row);
    fs.mkdirSync(`${H}/results`, { recursive: true });
    fs.writeFileSync(`${H}/results/${pr.hash}.json`, JSON.stringify({ ...row, claudeDiff: c.diff, cmDiff: m.diff }, null, 2));
    fs.writeFileSync(`${H}/results/summary.json`, JSON.stringify(results, null, 2));
  }

  // Summary
  const solved = (x: any) => x.passed === x.total && x.total > 0;
  console.log('\n══════════ SWE-BENCH SUMMARY (fastapi, Sonnet 4.6) ══════════');
  console.log('PR'.padEnd(12), 'Claude tests   CM tests   Claude judge   CM judge');
  for (const r of results) {
    console.log(
      `#${r.issue}`.padEnd(12),
      `${r.claude.passed}/${r.claude.total}`.padEnd(14),
      `${r.cm.passed}/${r.cm.total}`.padEnd(11),
      `${r.claude.judge}/10`.padEnd(15),
      `${r.cm.judge}/10`,
    );
  }
  const cSolved = results.filter((r) => solved(r.claude)).length;
  const mSolved = results.filter((r) => solved(r.cm)).length;
  console.log(`\nObjective (fail-to-pass fully solved): Claude ${cSolved}/${results.length} · CodeMaster ${mSolved}/${results.length}`);
  const avg = (f: (r: any) => number) => results.length ? (results.reduce((a, r) => a + f(r), 0) / results.length).toFixed(1) : '0';
  console.log(`Avg judge vs merged fix: Claude ${avg((r) => r.claude.judge)}/10 · CodeMaster ${avg((r) => r.cm.judge)}/10`);
  console.log(`Avg tokens: Claude ${Math.round(+avg((r) => r.claude.tokens))} · CodeMaster ${Math.round(+avg((r) => r.cm.tokens))}`);
}

void main();
