// LIVE benchmark v2 — CodeMaster (knowledge layer ON) vs. raw Claude Code.
// Real Sonnet-4.6 calls via the authenticated `claude` CLI (Claude Pro).
//
// Fixes under test: G1 identifier-aware + embedding file selection, G2 wiki +
// conventions bootstrapped on CLI auth. Both sides get identical task text and
// hit the same model/CLI. We measure the CLI's per-process token floor
// EMPIRICALLY and report task-attributable tokens (total − floor) so the
// comparison reflects real per-call work, not the CLI's fixed harness.
//
// Safety: CodeMaster does NOT apply patches here (no processIR); raw Claude runs
// read-only (Write/Edit disallowed). The portfolio repo is never mutated.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { staticAnalysis } from '../src/analysis/api.js';
import { compileContext } from '../src/context/compiler.js';
import { bootstrapWiki, wikiBootstrapped } from '../src/wiki/bootstrap.js';
import { ProviderManager } from '../src/providers/manager.js';
import { Tokens } from '../src/storage/tokens.js';
import { loadConfig } from '../src/config.js';
import { Sessions, Tasks } from '../src/storage/sessions.js';
import { parseObjective } from '../src/workers/intentParser.js';
import { id, now } from '../src/util/id.js';
import type { Session, Task, TaskType } from '../src/types/index.js';

const REPO = '/Users/chaitanyabansal/portfolio';
const MODEL = 'claude-sonnet-4-6';
const OUT_DIR = path.join(process.cwd(), 'bench', 'results');
fs.mkdirSync(OUT_DIR, { recursive: true });

interface CallResult { text: string; input: number; output: number; total: number; ms: number; turns: number; }

function claudeCall(prompt: string, opts: { cwd?: string; agentic?: boolean; system?: string }): CallResult {
  const started = Date.now();
  const args = ['--model', MODEL, '-p', '--output-format', 'json'];
  if (opts.system) args.push('--system-prompt', opts.system);
  if (opts.agentic) {
    args.push('--disallowed-tools', 'Write', 'Edit', 'NotebookEdit');
    args.push('--permission-mode', 'bypassPermissions');
  } else {
    args.push('--disallowed-tools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'NotebookEdit');
    args.push('--exclude-dynamic-system-prompt-sections');
  }
  const r = spawnSync('claude', args, { input: prompt, cwd: opts.cwd ?? process.cwd(), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 300_000 });
  if (r.status !== 0 || !r.stdout) throw new Error(`claude failed: ${(r.stderr || '').slice(0, 300)}`);
  const d = JSON.parse(r.stdout);
  const u = d.usage ?? {};
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  return { text: d.result ?? '', input, output, total: input + output, ms: Date.now() - started, turns: d.num_turns ?? 1 };
}

function extractCodeBlocks(md: string): string {
  const blocks = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.length ? blocks.join('\n\n') : md;
}
function irCode(ir: { files_created: Array<{ path: string; content: string }>; patches: Array<{ diff: string }>; summary: string }): string {
  const parts: string[] = [];
  for (const f of ir.files_created) parts.push(`// ${f.path}\n${f.content}`);
  for (const p of ir.patches) {
    const added = p.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
    parts.push(added.trim() ? added : p.diff); // fall back to raw patch content
  }
  return parts.join('\n\n') || ir.summary;
}

// All targets verified to NOT already exist (new) or to require modifying a real
// existing file (modification) — so "already exists" is not a valid answer.
const TASKS: Array<{ id: string; text: string; type: TaskType }> = [
  { id: 'slugify', text: 'Add a `slugify(text: string): string` helper to my-app/lib/utils.ts that lowercases, trims, and converts a string to a URL-safe slug (spaces and non-alphanumerics to single hyphens).', type: 'implement' },
  { id: 'useMediaQuery', text: 'Add a new typed React hook `useMediaQuery(query: string): boolean` in my-app/hooks that tracks whether a CSS media query matches, SSR-safe and cleaning up its listener.', type: 'implement' },
  { id: 'formatBytes', text: 'Add a `formatBytes(bytes: number, decimals?: number): string` helper to my-app/lib/utils.ts that formats a byte count as a human-readable string (e.g. "1.5 MB").', type: 'implement' },
  { id: 'magnetic-disabled', text: 'Add a `disabled` prop to the existing MagneticButton component (my-app/components/ui/MagneticButton.tsx) that greys it out, disables the magnetic hover effect, and blocks clicks. Keep it consistent with the current implementation.', type: 'debug' },
  { id: 'contact-counter', text: 'Add a live character counter beneath the message textarea in the existing ContactSection component (my-app/components/sections/ContactSection.tsx), showing remaining characters out of a 500 max and turning red when exceeded. Match the existing code and styling.', type: 'debug' },
];

function runRawClaude(taskText: string): CallResult {
  return claudeCall(`${taskText}\n\nProvide the COMPLETE code for your solution in your response (in a code block). Do not modify files.`, { cwd: REPO, agentic: true });
}

async function runCodeMaster(mgr: ProviderManager, cfg: ReturnType<typeof loadConfig>, taskText: string, type: TaskType) {
  const session: Session = {
    id: id('session'), created_at: now(), updated_at: now(), status: 'active', objective: taskText,
    objective_parsed: parseObjective(taskText), repository: { path: REPO, commit: 'bench' },
    progress: { total: 0, completed: 0, failed: 0 }, constraints: [], open_questions: [], working_files: [],
    decisions: [], provider_history: [], checkpoints: [],
    token_usage: { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 },
    current_provider: { provider_id: 'anthropic', model_id: MODEL }, metadata: {},
  };
  Sessions.insert(session);
  const task: Task = { id: id('task'), session_id: session.id, title: taskText.slice(0, 60), description: taskText, type, status: 'in_progress', input_files: [], output_files: [], dependencies: [], blocking: [], reasoning_refs: [], decision_refs: [], estimated_tokens: 0, order: 0 };
  Tasks.insert(task);
  const sel = mgr.select(MODEL, cfg.context.max_context_tokens);
  const compiled = await compileContext(session, task, { maxContextTokens: 200_000, fileCompressionThreshold: 8000 });
  const started = Date.now();
  const resp = await sel.adapter.invoke(sel.adapter.format_prompt(compiled, sel.model), sel.account);
  const ms = Date.now() - started;
  const ir = sel.adapter.parse_response(resp, session.id, task.id);
  return {
    code: irCode(ir), compiledTokens: compiled.total_tokens, components: compiled.included,
    input: resp.usage.input_tokens, output: resp.usage.output_tokens, total: resp.usage.total_tokens, ms,
    hasFiles: ir.files_created.length, hasPatches: ir.patches.length,
  };
}

function judge(taskText: string, rawCode: string, cmCode: string, seed: number) {
  const swap = seed % 2 === 0;
  const sol1 = swap ? cmCode : rawCode;
  const sol2 = swap ? rawCode : cmCode;
  const sys = 'You are a strict senior code reviewer. Score each solution 0-10 on correctness, completeness, and code quality combined. Respond ONLY as JSON: {"s1":<0-10>,"s2":<0-10>,"winner":"1"|"2"|"tie","note":"one sentence"}.';
  try {
    const r = claudeCall(`Task: ${taskText}\n\n=== Solution 1 ===\n${sol1.slice(0, 6000)}\n\n=== Solution 2 ===\n${sol2.slice(0, 6000)}`, { system: sys });
    const j = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] ?? '{}');
    const aScore = swap ? j.s2 : j.s1, bScore = swap ? j.s1 : j.s2;
    const winner = j.winner === 'tie' ? 'tie' : (j.winner === '1') === swap ? 'CodeMaster' : 'RawClaude';
    return { aScore: aScore ?? 0, bScore: bScore ?? 0, winner, note: j.note ?? '' };
  } catch (e) { return { aScore: 0, bScore: 0, winner: 'error', note: String(e).slice(0, 80) }; }
}

async function main(): Promise<void> {
  console.log(`LIVE v2 — ${REPO} — ${MODEL}`);

  // Empirical CLI token floors (per fresh process).
  const floorLean = claudeCall('Reply: READY', {}).total;
  const floorAgentic = claudeCall('Reply: READY', { cwd: REPO, agentic: true }).total;
  console.log(`CLI floors — lean: ${floorLean}, agentic: ${floorAgentic}`);

  const cfg = loadConfig();
  const mgr = new ProviderManager(cfg);

  // One-time knowledge bootstrap (index + embeddings + wiki + conventions).
  console.log('Bootstrapping CodeMaster knowledge layer (one-time)…');
  const api = staticAnalysis(REPO);
  const t0 = Date.now();
  const stats = await api.reindex({ embed: true });
  const embReady = api.embeddingsReady();
  // Wiki/conventions persist in the global DB — only bootstrap if not already done.
  let bootTok = 0;
  if (!wikiBootstrapped()) {
    await bootstrapWiki(REPO, mgr, cfg, 'bench-bootstrap', true).catch((e) => { console.log('bootstrap error', String(e).slice(0, 120)); return null; });
    bootTok = Tokens.sessionTotal('bench-bootstrap').total;
  }
  console.log(`Indexed ${stats.files} files/${stats.symbols} symbols in ${Date.now() - t0}ms · embeddings=${embReady} · wiki bootstrapped=${wikiBootstrapped()} · bootstrap tokens=${bootTok}`);

  const results: any[] = [];
  let i = 0;
  for (const t of TASKS) {
    i++;
    console.log(`\n[${i}/${TASKS.length}] ${t.id}`);
    let raw: CallResult | null = null, cm: any = null;
    try { raw = runRawClaude(t.text); console.log(`  raw: ${raw.total} tok (${raw.total - floorAgentic} task), ${raw.turns} turns, ${(raw.ms / 1000).toFixed(1)}s`); } catch (e) { console.log('  raw failed', String(e).slice(0, 100)); }
    try { cm = await runCodeMaster(mgr, cfg, t.text, t.type); console.log(`  cm:  ${cm.total} tok (${cm.total - floorLean} task, ctx ${cm.compiledTokens}), files=${cm.hasFiles} patches=${cm.hasPatches}, ${(cm.ms / 1000).toFixed(1)}s`); } catch (e) { console.log('  cm failed', String(e).slice(0, 100)); }
    let q = { aScore: 0, bScore: 0, winner: 'skip', note: '' };
    if (raw && cm) { q = judge(t.text, extractCodeBlocks(raw.text), cm.code, i); console.log(`  quality: Raw ${q.aScore}/10 · CM ${q.bScore}/10 · ${q.winner}${q.note ? ' — ' + q.note : ''}`); }
    results.push({ task: t.id, raw, cm, quality: q, floorLean, floorAgentic });
    fs.writeFileSync(path.join(OUT_DIR, `v2-${t.id}.json`), JSON.stringify(results[results.length - 1], null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'live-v2.json'), JSON.stringify(results, null, 2));
  }

  const done = results.filter((r) => r.raw && r.cm);
  const avg = (f: (r: any) => number) => done.length ? done.reduce((a, r) => a + f(r), 0) / done.length : 0;
  const wins = done.reduce((a: any, r) => { a[r.quality.winner] = (a[r.quality.winner] ?? 0) + 1; return a; }, {});
  console.log('\n══════════ SUMMARY (v2, knowledge layer ON) ══════════');
  console.log('Tasks:', done.length, '/', TASKS.length);
  console.log('Avg task tokens (floor-adj) — Raw:', Math.round(avg((r) => r.raw.total - floorAgentic)), ' CM:', Math.round(avg((r) => r.cm.total - floorLean)));
  console.log('Avg raw total tokens        — Raw:', Math.round(avg((r) => r.raw.total)), ' CM:', Math.round(avg((r) => r.cm.total)));
  console.log('Avg latency (s)             — Raw:', avg((r) => r.raw.ms / 1000).toFixed(1), ' CM:', avg((r) => r.cm.ms / 1000).toFixed(1));
  console.log('Avg quality /10             — Raw:', avg((r) => r.quality.aScore).toFixed(1), ' CM:', avg((r) => r.quality.bScore).toFixed(1));
  console.log('Quality wins:', JSON.stringify(wins));
  console.log('One-time bootstrap tokens:', bootTok, '(0 = already cached)');
  console.log('\nValid tasks only (verified new / real modifications). Full-file output format.');
}

void main();
