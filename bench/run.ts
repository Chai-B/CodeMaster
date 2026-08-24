// Benchmark harness — CodeMaster vs. naive "send it to Claude" baselines.
//
// Measures the three dimensions that do NOT require a live model:
//   • Token usage     — compiled context vs naive whole-repo / full-file dumps
//   • Context usage    — window utilisation against a 200k model
//   • Speed (compute)  — index time + per-task context-compilation latency
//
// The 4th dimension (output QUALITY) and end-to-end generation latency require a
// real provider call. Set ANTHROPIC_API_KEY (or run `claude setup-token` for
// account login) and pass --live to exercise that path.

import fs from 'fs';
import path from 'path';
import { staticAnalysis } from '../src/analysis/api.js';
import { compileContext } from '../src/context/compiler.js';
import { selectFiles } from '../src/context/fileSelector.js';
import { Sessions, Tasks } from '../src/storage/sessions.js';
import { parseObjective } from '../src/workers/intentParser.js';
import { estimateTokens } from '../src/util/tokens.js';
import { id, now } from '../src/util/id.js';
import type { Session, Task, TaskType } from '../src/types/index.js';

const REPO = process.cwd();
const MODEL_CONTEXT = 200_000;

const TASKS: Array<{ title: string; description: string; type: TaskType }> = [
  { title: 'Add failover to provider manager', description: 'Implement automatic provider failover in the provider manager invoke path', type: 'implement' },
  { title: 'Fix file selector ranking', description: 'Improve the ranking and call-graph expansion in the context file selector', type: 'debug' },
  { title: 'Write tests for the budget cascade', description: 'Add unit tests covering the context budget compression cascade in the compiler', type: 'test' },
  { title: 'Refactor the checkpoint writer', description: 'Refactor the checkpointer to write the full artifact set deterministically', type: 'refactor' },
  { title: 'Plan the wiki bootstrap flow', description: 'Plan how the wiki bootstrap generates module summaries on first run', type: 'plan' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.codemaster', 'dist', 'var'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function wholeRepoTokens(): number {
  let toks = 0;
  for (const f of walk(path.join(REPO, 'src'))) {
    try {
      toks += estimateTokens(fs.readFileSync(f, 'utf8'));
    } catch {
      /* skip */
    }
  }
  return toks;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function k(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

async function main(): Promise<void> {
  console.log('CodeMaster benchmark — repo:', REPO);
  console.log('Model context window:', k(MODEL_CONTEXT), '\n');

  const api = staticAnalysis(REPO);
  const t0 = Date.now();
  const stats = await api.reindex();
  const indexMs = Date.now() - t0;
  console.log(`Indexed ${stats.files} files / ${stats.symbols} symbols in ${indexMs}ms\n`);

  const repoTokens = wholeRepoTokens();

  const rows: Array<{
    task: string;
    naiveRepo: number;
    naiveFiles: number;
    cm: number;
    compileMs: number;
  }> = [];

  for (const spec of TASKS) {
    const session: Session = {
      id: id('session'), created_at: now(), updated_at: now(), status: 'active',
      objective: spec.description, objective_parsed: parseObjective(spec.description),
      repository: { path: REPO, commit: 'bench' }, progress: { total: 0, completed: 0, failed: 0 },
      constraints: [], open_questions: [], working_files: [], decisions: [], provider_history: [],
      checkpoints: [], token_usage: { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 },
      current_provider: { provider_id: 'anthropic', model_id: 'claude-opus-4-8' }, metadata: {},
    };
    Sessions.insert(session);
    const task: Task = {
      id: id('task'), session_id: session.id, title: spec.title, description: spec.description,
      type: spec.type, status: 'in_progress', input_files: [], output_files: [], dependencies: [],
      blocking: [], reasoning_refs: [], decision_refs: [], estimated_tokens: 0, order: 0,
    };
    Tasks.insert(task);

    // Naive baseline B: the files CodeMaster would pick, dumped in FULL (no budget, no compression).
    const picked = await selectFiles(api, task, MODEL_CONTEXT, 1e9);
    const naiveFiles = picked.reduce((a, f) => a + estimateTokens(f.content), 0) + estimateTokens(spec.description);

    // CodeMaster compiled context.
    const c0 = Date.now();
    const compiled = await compileContext(session, task, { maxContextTokens: MODEL_CONTEXT, fileCompressionThreshold: 8000 });
    const compileMs = Date.now() - c0;

    rows.push({ task: spec.title, naiveRepo: repoTokens, naiveFiles, cm: compiled.total_tokens, compileMs });
  }

  // ── Report ──────────────────────────────────────────────────────
  console.log('Per-task token usage (input context assembled for the model):\n');
  console.log('Task                                  Naive(whole repo)  Naive(files full)  CodeMaster   vs repo   vs files');
  console.log('─'.repeat(108));
  for (const r of rows) {
    console.log(
      r.task.padEnd(38).slice(0, 38),
      k(r.naiveRepo).padStart(14),
      k(r.naiveFiles).padStart(17),
      k(r.cm).padStart(12),
      pct(1 - r.cm / r.naiveRepo).padStart(9),
      pct(1 - r.cm / r.naiveFiles).padStart(9),
    );
  }
  console.log('─'.repeat(108));

  const avgCm = rows.reduce((a, r) => a + r.cm, 0) / rows.length;
  const avgFiles = rows.reduce((a, r) => a + r.naiveFiles, 0) / rows.length;
  const avgCompile = rows.reduce((a, r) => a + r.compileMs, 0) / rows.length;

  console.log('\nSummary');
  console.log('  Whole-repo dump (every session):      ', k(repoTokens), 'tokens →', pct(repoTokens / MODEL_CONTEXT), 'of a 200k window');
  console.log('  Avg naive (relevant files, full):     ', k(avgFiles), 'tokens');
  console.log('  Avg CodeMaster compiled context:      ', k(avgCm), 'tokens →', pct(avgCm / MODEL_CONTEXT), 'of window (useful, ranked)');
  console.log('  Avg token reduction vs whole-repo:    ', pct(1 - avgCm / repoTokens));
  console.log('  Avg token reduction vs full files:    ', pct(1 - avgCm / avgFiles));
  console.log('  Index time (one-time):                ', indexMs + 'ms');
  console.log('  Avg context-compile latency:          ', avgCompile.toFixed(1) + 'ms', '(CodeMaster overhead, no model call)');
  console.log('\n  Quality + end-to-end generation latency need a live model: set ANTHROPIC_API_KEY and re-run with --live.');
}

void main();
