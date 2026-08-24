// Standalone hard multi-file e2e: run CodeMaster (D1 selection + D3 solver + D6
// output) on fastapi #14371 and grade against its 207 fail-to-pass tests.
import fs from 'fs';
import { spawnSync } from 'child_process';
import { staticAnalysis } from '../src/analysis/api.js';
import { ProviderManager } from '../src/providers/manager.js';
import { loadConfig } from '../src/config.js';
import { Sessions, Tasks } from '../src/storage/sessions.js';
import { parseObjective } from '../src/workers/intentParser.js';
import { solveWithVerification } from '../src/workers/solver.js';
import { id, now } from '../src/util/id.js';

const REPO = '/Users/chaitanyabansal/cm-bench/fastapi';
const H = '/Users/chaitanyabansal/cm-bench/harness';
process.env.CODEMASTER_DATA_DIR = '/Users/chaitanyabansal/cm-bench/cm-data-diag';
const log = (m: string) => { fs.appendFileSync(`${H}/mf_e2e.log`, m + '\n'); console.log(m); };
const git = (a: string[]) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' });

const base = git(['rev-parse', 'd86c4747^']).stdout.trim();
const f2p = fs.readFileSync(`${H}/meta/d86c4747.f2p.txt`, 'utf8').trim().split('\n').filter(Boolean);
const venvPy = `${H}/venvs/d86c4747/bin/python`;

git(['checkout', '-f', base]); git(['clean', '-fdq', 'fastapi', 'tests']); fs.rmSync(`${REPO}/.codemaster`, { recursive: true, force: true });
log('indexing…');
const api = staticAnalysis(REPO); await api.reindex({ embed: true }); // D2 symbol embeddings on
const cm = loadConfig(); const mgr = new ProviderManager(cm);
const problem = JSON.parse(fs.readFileSync(`${H}/config.json`, 'utf8')).prs.find((p: any) => p.hash === 'd86c4747').problem;
const objective = problem + '\n\nEdit the FastAPI source under fastapi/ to fix this. A correct fix spans multiple files.';
const s: any = { id: id('session'), created_at: now(), updated_at: now(), status: 'active', objective, objective_parsed: parseObjective(objective), repository: { path: REPO, commit: base }, progress: { total: 0, completed: 0, failed: 0 }, constraints: [], open_questions: [], working_files: [], decisions: [], provider_history: [], checkpoints: [], token_usage: { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 }, current_provider: { provider_id: 'anthropic', model_id: cm.providers.default }, metadata: {} };
Sessions.insert(s);
const t: any = { id: id('task'), session_id: s.id, title: 'param aliases', order: 0, blocking: [], description: objective, type: 'debug', status: 'in_progress', input_files: [], output_files: [], dependencies: [], reasoning_refs: [], decision_refs: [], estimated_tokens: 0 };
Tasks.insert(t);
// Fair verify signal (spec §14.1): exercise the whole request→response→OpenAPI
// path with the alias params named in the PUBLIC problem statement — not the
// hidden fail-to-pass oracle. A partial edit that crashes anywhere across the
// gold files' code paths (params → _compat → dependencies/utils → openapi/utils)
// is caught and fed back to the next iteration. This mirrors what a developer
// (or Claude, agentically) would run to sanity-check the change.
// Validated fair signal: FAILS on base, PASSES on the gold patch. Exercises the
// read path (dependencies/utils.py) AND OpenAPI schema (openapi/utils.py) — the
// two files a definition-only edit misses. validation_alias is a symptom named
// in the public problem statement, so this is a developer repro, not oracle leak.
const REPRO = `
from fastapi import FastAPI, Query
from fastapi.testclient import TestClient
try:
    from typing import Annotated
except ImportError:
    from typing_extensions import Annotated
app = FastAPI()
@app.get("/read/")
def read(q: Annotated[str, Query(validation_alias="q-alias")] = "default"):
    return {"q": q}
c = TestClient(app)
r = c.get("/read/", params={"q-alias": "hit"})
assert r.status_code == 200, r.text
assert r.json()["q"] == "hit", f"validation_alias NOT used for reading param: {r.json()}"
spec = app.openapi()
params = spec["paths"]["/read/"]["get"].get("parameters", [])
names = [p["name"] for p in params]
assert "q-alias" in names, f"OpenAPI does NOT use validation_alias: {names}"
`;
const verify = () => { const r = spawnSync(venvPy, ['-c', REPRO], { cwd: REPO, encoding: 'utf8' }); return { ok: r.status === 0, output: ((r.stderr || '') + (r.stdout || '')).slice(-1800) }; };
try {
  log('solving (up to 2 iters)…');
  const res = await solveWithVerification(s, t, mgr, cm, verify, 3);
  const changed = git(['diff', '--name-only', '--', 'fastapi']).stdout.trim().split('\n').filter(Boolean);
  log(`solver: ${res.iterations} iters, verified=${res.verified}, tokens=${res.totalTokens}, files=${changed.length}: ${changed.join(', ')}`);
  git(['checkout', '--', 'tests']); spawnSync('git', ['apply', `${H}/patches/d86c4747.test.patch`], { cwd: REPO });
  const r = spawnSync(venvPy, ['-m', 'pytest', ...f2p, '-q', '-p', 'no:cacheprovider', '--no-header'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8, timeout: 240000 });
  const passed = Number(/(\d+) passed/.exec((r.stdout || '') + (r.stderr || ''))?.[1] ?? 0);
  log(`RESULT #14371: ${passed}/${f2p.length} fail-to-pass (was 16/207 single-shot)`);
} catch (e) {
  log('BLOCKED: ' + (String(e).split('\n')[0] ?? '').slice(0, 160));
}
git(['checkout', '-f', 'master']); git(['clean', '-fdq', 'fastapi', 'tests']); fs.rmSync(`${REPO}/.codemaster`, { recursive: true, force: true });
