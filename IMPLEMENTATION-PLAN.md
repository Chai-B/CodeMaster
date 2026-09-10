# CodeMaster implementation plan

Seven waves. Each wave is independently shippable and independently
falsifiable. Nothing in a later wave is a prerequisite for an earlier one, so
you can stop after any wave and still have a better tool.

The ordering rule: **measurement before mechanism.** Wave 0 exists so that
every wave after it can be proven or reverted.

File paths are the ones named in `ARCHITECTURE.md`. Verify them against the
real tree before editing; the doc may have drifted.

`SPEC.md` is a pre-implementation design document. Where it and `ARCHITECTURE.md`
disagree, `ARCHITECTURE.md` wins, and where both disagree with the source, the
source wins. Several items below deliberately restore something the spec
specified and the build dropped; each says so. Section 1.5 of `CODEMASTER-10X.md`
lists the spec ideas that must **not** be restored, and that list is binding.

---

## Wave 0 — Make it measurable and make it launchable

Nothing else in this plan is meaningful without this wave. Two weeks.

### 0.1 Evaluation harness

New: `bench/`, `src/bench/`.

- `codemaster bench <suite> [--k 2] [--concurrency N] [--model M]`
- Suites:
  - `smoke` — 10 tasks over the existing `tests/fixtures/` repos
    (`tiny-ts`, `small-python`, `react-tsx`, `medium-monorepo`,
    `legacy-codebase`). Runs in CI. Target under 10 minutes.
  - `selfhist` — 30-50 tasks auto-generated from this repo's own git history.
    Generator: pick a commit that touched source and tests, revert it in a
    detached worktree, use the commit message as the objective, grade by
    running the commit's own tests. Zero authoring cost, honest oracle.
  - `external` — Terminal-Bench 2 via Harbor, SWE-bench-verified. Adapter only;
    do not vendor the datasets.
- Output: `bench/results/<timestamp>/result.json` plus per-task directories
  holding the trace, the diff, and the verifier output.
- Metrics emitted: `pass@1`, `Succ/Mtok`, `first_attempt_rate`, `evidence_mix`,
  `apply_rate`, `time_to_verified` p50/p95.
- Infrastructure-aborted trials count as failures in `pass@1` and are excluded
  from token means.

Acceptance: `npm run bench:smoke` produces a `result.json` with all metrics
populated, twice in a row, with variance reported.

### 0.2 Metrics the harness needs

Modify: `src/analysis/tokenAnalytics.ts`, `src/storage/` (new columns).

- Add `selector_recall`. Requires the miss log from Wave 1; until then, record
  files the model *names in output* that were not in the compiled context.
  `outputParser` already extracts `<file path=…>` and reasoning `touched` refs,
  so the miss set is computable today.
- Add waste classes W1 (reverted work), W6 (context misses), W7 (loop tax).
- Add `apply_rate` counters to `patchApplier` keyed by anchor type.
- Extend `savingsReport()` with `succ_per_mtok`.

Acceptance: `/waste` and `/stats` show the new figures; every figure traces to a
persisted row.

### 0.3 Trace store

New: `src/observability/trace.ts`. Modify: `src/events/`.

- Subscribe to the existing bus. Write `sessions/<id>/trace.jsonl`, one JSON
  object per event, with `ts`, `type`, `worker`, `task_id`, `tokens`, `model`,
  and a payload capped at 8 KB with an overflow pointer to a sibling file.
- Retention: keep last N sessions (`observability.keep_traces: 20`), prune on
  `complete()`.
- No new event types. This is a subscriber, not a refactor.

Acceptance: a full `run` produces a replayable trace; `codemaster replay --trace
<id>` reconstructs the phase timeline without any model call.

### 0.4 Launch blockers

- Fix the GitHub Actions `Test` step. If the failure is environmental, pin the
  Node version to 22.5.x and cache `node_modules`; if it is a real test, fix the
  test.
- `codemaster doctor --fix`: migrate or archive `~/.codemaster`, reap sessions
  and tasks stuck in `in_progress`/`active`, verify `REPO_INDEX_VERSION`, report
  disk usage per repo slug.
- Move `SPEC.md` to `docs/history/SPEC-v0.1.md`. Add a header stating that it
  predates the evidence layer, the learning loop, the MCP server and the proxy,
  that `ARCHITECTURE.md` is authoritative, and that a list of deliberately
  abandoned sections lives in `docs/spec-drift.md`.
- Write `docs/spec-drift.md`: a three-column table (spec section, what the build
  did, verdict: improved / regressed / abandoned / not yet built). Seed it from
  §1.2 to §1.6 of `CODEMASTER-10X.md` and correct it against the source during
  Phase 1 discovery. This single file prevents every future contributor from
  re-litigating a decision that was already made.
- Add LICENSE, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue and PR
  templates.

### 0.5 Security posture

New: `src/security/redact.ts`. Modify: `src/context/compiler.ts`,
`src/wiki/bootstrap.ts`, `src/rkg/`.

- **Redaction before egress.** A pass over every component of the compiled
  context: deny-list by path (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`,
  `credentials*`, `.npmrc`, `.netrc`), deny-list by basename inside content,
  regex for common key shapes (AWS, GitHub, Slack, Stripe, JWT, private key
  headers), and a Shannon-entropy scan on long single-token strings. Replace
  with `«redacted:reason»`. Emit a `security.redacted` event with counts.
- `.codemasterignore`, same syntax as `.gitignore`, honoured by the indexer and
  the selector.
- **Injection provenance.** Add `provenance` to `rkg_nodes` and `wiki_entries`:
  `human | repo-file | model`. `readConventions()` returns `repo-file` and
  `model` nodes only when `security.trust_repo_content` is true (default
  false for `CONVENTIONS`, true for `ARCHITECTURE`). Strip lines matching
  imperative-instruction patterns from ingested repo markdown before it becomes
  a wiki entry.
- **Sandbox flag.** `security.test_sandbox: none | docker | bwrap`. Default
  `none` with a one-time warning printed on the first test execution in a repo.

Acceptance: a fixture repo containing a fake `.env` and an injected
`IGNORE PREVIOUS INSTRUCTIONS` block in its README produces a compiled context
with neither present, and the assertion is a test.

---

## Wave 1 — The loop and the edit format

The two critical gaps. Three to four weeks. Highest expected `Succ/Mtok` gain of
any wave.

### 1.1 Context requests

New: `src/context/requestServer.ts`. Modify: `src/context/outputFormat.ts`,
`src/workers/outputParser.ts`, `src/workers/solver.ts`,
`src/workers/taskExecutor.ts`, `src/learning/reflector.ts`.

Contract addition to `OUTPUT_FORMAT`:

```xml
<context_request>
  <need kind="symbol">SessionManager.refresh</need>
  <need kind="callers">resolveBudget</need>
  <need kind="file">src/context/budget.ts</need>
  <need kind="tests">src/auth/session.ts</need>
  <need kind="grep">CACHE_READ_MULTIPLIER</need>
</context_request>
```

Rules:

- A response containing `<context_request>` and no `<files>`/`<edits>` is not a
  parse failure and not a task failure. It is a *turn*.
- `requestServer.serve(needs, repo, budgetRemaining)` resolves every need
  through `src/analysis/api.ts`. Zero LLM calls. Returns rendered blocks plus a
  per-need `served | not_found | over_budget` status.
- The served block goes back as `conversation.delta`, so case 3 of
  `continuationRequest` applies and the vendor resumes rather than re-reading
  the whole prompt.
- `MAX_CONTEXT_REQUESTS = 3` per task. On the fourth, serve nothing and append
  "no further context available; proceed with what you have".
- Every need is logged to a new `context_misses` table
  `(repo, task_id, kind, target, was_in_context, served)`.
- `Learning.recordSelection` gains a negative path: a served need whose target
  file was not in the compiled context decrements that file's utility for this
  keyword set, and the miss feeds `selector_recall`.

**Scratchpad (restores `SPEC.md` §11.2).** Add a `<scratchpad>` output block
that the parser stores in `session.metadata.scratchpad[task_id]` and that rides
the vendor conversation across context-request turns and solver retries. Cap it
at 2,000 tokens, truncate oldest-first. This is where "what I have already ruled
out" lives, and it costs nothing extra because the vendor already holds the
conversation. Note it is an *output* channel, not a budget component; the spec
allocated it 2-7% of input budget, which is the wrong shape.

Risk: a model that requests context reflexively instead of solving. Mitigation:
the cap, plus a system-prompt line stating that a request costs a turn and
should only be used when the answer cannot be derived from what is present, plus
a `context_request_rate` metric per model in the bench output. If a model abuses
it, disable the affordance for that model family via
`harness/output.formats/<family>.json`.

### 1.2 Symbol-anchored edits

This restores the intent of `SPEC.md` §10.5 and §12.2, which specified
`<patches>` carrying unified diff and a PatchApplier doing "unified diff
application". The build replaced that with whole-file output, presumably after
hitting udiff apply failures. Symbol anchors are the correct third option: they
avoid re-emitting unchanged code (the spec's goal) without asking the model to
transcribe context lines (udiff's failure mode).

New: `src/workers/anchors.ts`. Modify: `src/context/outputFormat.ts`,
`src/workers/outputParser.ts`, `src/workers/patchApplier.ts`,
`src/analysis/indexer.ts` (ensure `symbols` carries byte spans, not just line
numbers).

New contract, replacing `<files>` as the default:

```xml
<edits>
  <edit file="src/x.ts" anchor="symbol:Class.method">…new symbol body…</edit>
  <edit file="src/x.ts" anchor="search"><search>…</search><replace>…</replace></edit>
  <edit file="src/y.ts" anchor="create">…full content…</edit>
  <edit file="src/z.ts" anchor="delete"/>
</edits>
```

Applier algorithm for `symbol:`:

1. Resolve `Class.method` against `symbols` for that file. Ambiguous match is a
   hard reject with the candidate list returned as a correction delta.
2. Verify the current file bytes at the recorded span still hash to the indexed
   value. On mismatch, `indexFile()` that one file and re-resolve once.
3. Splice, preserving the indentation of the anchor's first line.
4. Re-parse the file with tree-sitter. A parse error rolls the edit back and
   returns a correction delta naming the syntax error.
5. Record `{anchor_type, model, language, outcome}` for `apply_rate`.

Fallback ladder on failure: `symbol` → `search` → `whole-file`, each recorded.
Per-(model, language) default anchor type is chosen from recorded `apply_rate`
once `MIN_SAMPLES` is met; before that, `symbol` for parsed languages,
`search` for unparsed, `whole-file` for Swift (regex-only extractor).

Keep `DIFF_OUTPUT_FORMAT` for Codex. Keep `WritePolicy` (GUARDED basenames,
test-file protection, `.git` exclusion) unchanged and apply it per edit rather
than per file write.

Undo: extend the existing `{path, before|null}` journal to record per-edit
entries so `/undo` can reverse one edit rather than one file.

Acceptance: on `bench:selfhist`, `apply_rate` for `symbol` anchors ≥ 0.9 on
TS/Python, and mean output tokens per task drops at least 40% against the
Wave-0 baseline with no `pass@1` regression.

### 1.3 Stuck detection

New: `src/workers/stuck.ts`. Modify: `src/workers/solver.ts`,
`src/daemon/sessionManager.ts`.

Deterministic patterns, checked every iteration:

- Identical `(edit target, content hash)` emitted twice.
- Identical failure `cause` three times.
- Context requests for the same target twice.
- Diff size unchanged across two iterations while tokens grew.
- Task iteration count exceeds `maxIters` (already bounded) or session iteration
  exceeds `max(tasks.length * 2, 20)` (already bounded).

On trip: stop the task, keep the work on disk, record a `Failures` row with
cause `stuck:<pattern>`, mark the task `failed`, and let `runAll` continue. Emit
`worker.stuck`. Price the tokens spent after the first trip condition as W7.

---

## Wave 2 — Evidence everywhere, and isolation

Three weeks.

### 2.1 Acceptance criteria and `criteria-admitted`

New: `src/workers/verify/criteria.ts`. Modify:
`src/workers/verify/behavioralVerify.ts`, `src/daemon/sessionManager.ts`
(`buildEvidence`, `deriveStatus`), `src/config.ts` (paths).

- One LLM call at objective time, role `oracle`, produces 3-8 executable
  acceptance criteria from the objective plus the repository map. Each criterion
  is `{id, description, kind: command|http|file|test, spec}`.
- Criteria compile to a runnable harness in
  `repoDataDir(repo)/acceptance/<session>/`, never inside the user's tree.
- **Admission**: a criterion is admitted only if it *fails* against the current
  tree in a throwaway worktree. A criterion that already passes proves nothing
  and is discarded with a recorded reason.
- `buildEvidence()` gains `criteria-admitted`. A task is `verified` when
  provenance is `pre-existing`, `repro-admitted`, or `criteria-admitted`.
- `complete()` runs the full admitted criteria set once at session end and
  reports which criteria the objective actually satisfied. This is the
  end-to-end project answer.

Cost: one call per objective, not per task.

### 2.2 Close the coverage holes

Modify: `src/workers/verify/behavioralVerify.ts`,
`src/analysis/callGraph.ts`.

- **Reachability check.** Before granting `pre-existing` provenance, require
  that at least one relevant test transitively reaches a changed symbol in the
  call graph. If not, treat the locus as uncovered and generate a repro.
- **Delta guard.** Run relevant tests on the pre-change tree (reuse the
  `git stash create` + `worktree add --detach` machinery from repro admission).
  Tests that pass both before and after do not observe the change; downgrade to
  `confident: false`.
- **Characterization policy.** Remove the `detectFramework === 'unknown'`
  restriction. Run characterization once per session on any repo whose changed
  locus has coverage below a threshold, cache the result including `null` as it
  does today.

### 2.3 Worktree isolation (Pillar 5)

`SPEC.md` §12.4 already specified `[for each task in parallel where safe]`, and
the scheduling half exists: `TASK_PIPELINE`, `topoOrder()`, `nextReadyTask()`
with `dependencies` and reverse `blocking` edges. Only isolation is missing, so
this wave is smaller than it looks. Land isolation here; land actual concurrent
task execution only after 2.4 proves the isolation holds.

New: `src/daemon/workspace.ts`. Modify: `src/daemon/sessionManager.ts`,
`src/analysis/git.ts`, `src/workers/patchApplier.ts`,
`src/workers/checkpointer.ts`.

- `session.workspace = { mode: 'inplace' | 'worktree', path }`.
- `worktree` mode: `git worktree add --detach <dataDir>/worktrees/<session>`
  at session start; all writes go there; `complete()` either merges to the
  original branch, opens a branch, or reports the diff and leaves it.
- `inplace` stays the default for interactive use. `worktree` becomes the
  default for `run --json`, `bench`, and any parallel execution.
- Abort becomes free: remove the worktree.
- `gitChangedFiles`, `fullWorkingDiff` and the checkpointer take the workspace
  path rather than the repo path.

Acceptance: two `codemaster run` invocations against the same repo, at the same
time, on different objectives, neither seeing the other's writes.

### 2.4 Speculative tiering (needs 2.3)

Modify: `src/workers/solver.ts`, `src/learning/reflector.ts`.

- When `Learning.startTier(repo, taskType)` reports a historical tier-0 verified
  rate below `speculation.threshold` (default 0.4) and `MIN_SAMPLES` is met,
  launch tier 0 and tier 1 in parallel worktrees and take the first result that
  reaches `verified`.
- Kill the loser as soon as a winner verifies; record both costs, credit the
  saved wall-clock, and price the loser as W1.
- Off by default (`speculation.enabled: false`). This spends money to buy
  latency and pass@1, so it must be opt-in and reported honestly.

---

## Wave 3 — Memory that learns strategies

Two to three weeks.

### 3.1 Playbook store

New: `src/memory/playbook.ts`. Modify: `src/storage/db.ts` (PRIMARY schema),
`src/context/compiler.ts`, `src/workers/solver.ts` (`recordLesson`),
`src/memory/lifecycle.ts`.

Schema (PRIMARY, per repo; global rows carry `repo IS NULL`):

```sql
CREATE TABLE playbook_items (
  id TEXT PRIMARY KEY,
  repo TEXT,                      -- NULL for global
  scope TEXT NOT NULL,            -- lang:ts | area:src/auth | type:debug | global
  bullet TEXT NOT NULL,
  helpful_count INTEGER DEFAULT 0,
  harmful_count INTEGER DEFAULT 0,
  created_at INTEGER, last_used_at INTEGER,
  provenance TEXT,                -- JSON array of task ids
  embedding BLOB
);
```

Rules, enforced in code and covered by tests:

- **Delta-only writes.** `addItem`, `incrementHelpful`, `incrementHarmful`,
  `retire`. There is no `rewriteAll`. A test asserts that no code path
  regenerates the set.
- **No summarization.** Pruning is by `harmful_count > helpful_count` and
  `last_used_at` age. Retire, never compress.
- **Counters from execution.** After `deriveStatus`, every playbook item that
  was in the compiled context gets `helpful += 1` on `verified`, and
  `harmful += 1` on a failure whose cause matches the item's declared failure
  class. Never from a model's opinion.
- **Deterministic selection.** Scope match, then
  `helpful/(helpful+harmful+1)`, then recency. Cap at `playbook.max_items`
  (default 12) in the `CONVENTIONS` slot.
- **Item generation.** One `summarize`-role call per failed-then-fixed task,
  producing at most two bullets, each atomic and testable. This replaces
  `recordLesson`'s wiki write. Dedupe by embedding cosine > 0.9 into a counter
  increment.

### 3.2 Restore the archive, then retire the compressor from the hot path

Modify: `src/memory/lifecycle.ts`, `src/config.ts`, `src/commands/router.ts`.

Do this **first in the wave**, before the playbook lands, so that everything
after it is reversible.

1. **Restore `SPEC.md` §7.6 step 3.** The spec's compression is summarize →
   replace active entry → archive full object. The build does the first two (the
   second by overwriting `detail` in place) and skips the third. Write the
   pre-compression `detail` to `repoDataDir(repo)/archive/reasoning/<id>.md`
   before the `UPDATE`, with the original `importance` in front matter. Add
   `/reasoning restore <id>`. Plain files, not encrypted cold storage; §22.3's
   encrypted archive was already removed from the build for good reason.
2. **Then narrow the compressor.** Restrict it to `long_term_memory` rows older
   than 90 days that have not been retrieved. Never let it touch
   `playbook_items`, `failures`, or anything the compiler reads in
   `KNOWN_FAILURES`. Prefer `applyDecay()` and retirement everywhere else.

Acceptance: a compressed reasoning row can be restored byte-identical, and a
test asserts that no code path writes a compressed `detail` without first
writing the archive.

### 3.3 Global tier

Modify: `src/memory/playbook.ts`, `src/config.ts`.

- Global store at `DATA_DIR/global.db`, same schema.
- Promotion: `helpful_count >= 5` across `>= 2` distinct repo slugs promotes a
  copy with `repo = NULL` and a generalized scope.
- Compilation order: global items first (stable, prefix-cacheable), repo items
  after.
- `codemaster memory export|import` for sharing playbooks. This is a community
  feature: a good `lang:python` playbook is shareable and is exactly the kind of
  artifact that drives OSS adoption.

### 3.4 AGENTS.md, in and out

Modify: `src/wiki/bootstrap.ts`, `src/wiki/reader.ts`. New:
`src/wiki/agentsMd.ts`.

- Ingest `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`
  into `CONVENTIONS`, tagged `provenance: repo-file` and subject to the Wave 0.5
  injection filter.
- `codemaster agents-md` emits a generated `AGENTS.md` from the repository map,
  conventions, and the top playbook items. Deterministic, no LLM call. Idempotent
  with a managed block delimiter so hand-written sections survive regeneration.

---

## Wave 4 — Become the layer

Three weeks. This is the wave that decides adoption.

### 4.1 MCP server v2

Modify: `src/mcp.ts`.

Keep the existing five. Add:

| Tool | Shape | Why |
|---|---|---|
| `verify_change` | `{repo, files[], objective?}` → evidence + provenance + failing output | the thing nobody else has |
| `find_symbol` | `{repo, name, kind?}` → span, signature, neighbourhood | Serena parity from your own index |
| `find_references` | `{repo, symbol}` → `{files, method: lsp\|ripgrep}` | the honesty field is a feature |
| `impact_of` | `{repo, files[]}` → dependents, use-sites, untested reachable symbols | blast radius, deterministic |
| `record_outcome` | `{repo, task, status, cause?}` → ok | lets external agents feed the playbook |
| `playbook` | `{repo, scope}` → items | lets external agents read what was learned |

**Make LSP load-bearing (restores `SPEC.md` Phase 1).** `find_symbol`,
`find_references` and the Wave 1.2 anchor resolver are all materially better
with a language server than with tree-sitter spans alone, because a server
resolves across files and through re-exports. Today `lsp.ts` is used "when one
is available" and caps LSP references at 12. Promote it: auto-start pyright and
typescript-language-server when present, raise the cap for `method: 'lsp'`
results, prefer LSP spans over index spans in the anchor resolver, and keep
`findReferencesResolved`'s `method` field so callers can still tell a resolved
answer from a text match.

Add MCP **resources** for wiki entries and the repository map (cheap to read,
cacheable by the host) and **prompts** for the task-type procedures.

Progressive disclosure: expose three tools by default (`compile_context`,
`verify_change`, `search`) plus a `codemaster_tools` discovery tool that returns
the rest on demand. Tool-definition bloat is now the largest single source of
wasted context in multi-server setups, and a layer should not contribute to it.

Keep sessions ephemeral. That decision is right.

### 4.2 ACP agent

New: `src/acp.ts`, `codemaster acp`.

You already implement newline-delimited JSON-RPC 2.0 over stdio for MCP. ACP is
the same transport with a different method set: `initialize`,
`session/new`, `session/prompt`, `session/update` notifications,
permission requests, client-provided filesystem and terminal.

Map: `session/new` → `Sessions.create`; `session/prompt` → the outer loop;
`session/update` → the existing event bus, filtered; permission requests →
the approval policy from 6.8. Register in the ACP registry.

Payoff: CodeMaster runs inside Zed, JetBrains, Neovim and Emacs with no
per-editor work, and inherits an existing discovery surface.

### 4.3 Claude Code plugin

New: `integrations/claude-code/` containing `.claude-plugin/plugin.json`,
skills, and hooks.

- `PreToolUse` on Read/Grep: call `codemaster context --json` and inject the
  compiled context so the host agent stops rediscovering the repo.
- `PostToolUse` on Edit/Write: call `codemaster verify --files … --json` and
  surface the evidence grade.
- `Stop`: run the deterministic gate and block completion if provenance is
  `none` and the repo has tests.
- A `codemaster` skill documenting `/why`, `/context`, `impact_of`.

This is the highest-leverage distribution move in the plan. Most of your first
users will meet CodeMaster as a plugin, never as a CLI.

### 4.4 NDJSON event contract

Modify: `src/commands/headless.ts`, `src/events/`.

- `--json` streams NDJSON of the event union, each line carrying
  `schema_version`, `ts`, `type`, `session`, `task`.
- Document the schema in `docs/events.md` and version it. Add a test that fails
  when the union changes without a version bump.
- Exit codes stay `0/1/2/3`; document them in the README.

---

## Wave 5 — The self-improvement loop

Four weeks. Requires Wave 0 (bench + trace) and benefits from every other wave.

### 5.1 Harness as files

New: `src/harness/`, `~/.config/codemaster/harness/`.

Externalize, in this order (each is a constant today):

1. `selector.weights.json` — the nine signal scores, `relevanceWeight` table,
   `bump()` parameters.
2. `budget.profiles.json` — the six profiles, `LADDER`, the 12% reserve.
3. `verify.policy.json` — gate order, confidence rules, thresholds.
4. `routing.roles.json` — role table, `tierFor` scoring weights,
   `THINKING_BUDGET`.
5. `output.formats/<family>.json` — per model family: anchor preference,
   context-request affordance on/off, prefill and stop sequences.
6. `middleware/` — new extension point: `beforeWorker`, `afterWorker`,
   `beforeCall`, `afterCall`. The plugin system already has a `worker` type;
   this is the hook-shaped sibling.
7. `skills/` — per task-type procedures, loaded by description match, injected
   into `INSTRUCTIONS`.

Loader with schema validation, defaults baked into the binary, `git init` on the
harness directory on first write. `codemaster harness diff|revert <file>`.

Reconcile the file set with `SPEC.md` Appendix A (the configuration reference).
Anything in Appendix A that is still true belongs in `config.json`; anything that
is a tuning knob belongs in `harness/`. Keeping them in one file is what made
both drift.

Why this order: the measured finding from harness-evolution work is that the
gains live in tools, middleware and memory, and that prompt-only edits regress.
Externalize the mechanical surfaces first and the prose last.

### 5.2 Distillation

New: `src/observability/distill.ts`, `codemaster distill <bench-run>`.

- Input: `bench/results/<ts>/` trace files.
- Per task: a root-cause report (what failed, at which worker, with which
  evidence, what the model asked for and did not get).
- Aggregate: an overview grouping failures into pattern classes with counts.
- Output as files, not as a prompt blob, so an agent reads them progressively.

### 5.3 The evolve loop

New: `codemaster evolve --suite selfhist --iterations N`.

```
for t in 1..N:
  rollouts   = bench(harness_{t-1}, k=2)
  if t >= 2:
    verdicts = attribute(manifest_{t-1}, rollouts_{t-1}, rollouts_t)
    harness  = revert(harness_{t-1}, verdicts.rejected)   # file granularity
  evidence   = distill(rollouts)
  harness_t, manifest_t = evolve(harness, evidence, verdicts)   # LLM, xhigh effort
  commit(harness_t, manifest_t, tag=t)
  if pass@1(rollouts) > best: best = harness_t
```

Constraints, non-negotiable and enforced in code:

- The evolve agent writes only inside `harness/`. Bench results, verifier,
  provider config and model selection are read-only.
- It may not modify `llm_config` (model, effort, temperature, max tokens).
  Model-config edits produce broad, unattributable regressions.
- It may not add task-specific logic or hard-code a fixture's answer.
- Every change carries `{failure_pattern, root_cause, predicted_fixes,
  risk_tasks, component, why_this_component}`.
- Revert is mechanical: intersect predictions with observed task-level deltas.
  Never accept the model's argument for why an edit should have worked. The
  literature on this loop reports fix-prediction roughly 5x better than chance
  and regression-prediction barely better than chance, so regressions must be
  caught by measurement, not foresight.

Ship the loop as an opt-in developer command, not something users run. The
artifact users get is the evolved default harness shipped in the next release.

---

## Wave 6 — Economics and daily-use polish

Two weeks, mostly independent, can be interleaved.

### 6.1 Cost controls

Modify: `src/providers/manager.ts`, `src/commands/headless.ts`,
`src/analysis/tokenAnalytics.ts`.

- **Preflight.** Before `run`, estimate calls and tokens from the ledger's own
  history for this repo and task type, print the estimate with a confidence
  interval, and require confirmation above `cost.confirm_above` (default $1).
- `--max-cost <usd>` hard ceiling with `hard_limit_behavior` reusing the
  existing `pause` semantics.
- **Batch API** for `DERIVED_CHEAP` roles (`review`, `summarize`, `merge`) plus
  ModuleSummarizer and wiki bootstrap, where the vendor supports it. These are
  latency-insensitive by construction.
- **Prefill and stop sequences** per model family from
  `harness/output.formats/`.
- **Session prefix freeze.** Hold `CONVENTIONS`, `ARCHITECTURE`,
  `REPOSITORY_MAP` byte-identical for the whole session so the vendor prefix
  cache hits on every task. Learned component weights apply from the next
  session, not mid-session.

### 6.2 Capability signal

Modify: `src/config.ts` (model table), `src/providers/manager.ts`.

Add an explicit `capability_rank` integer to the model price table, seeded from
published benchmark tiers and overridable by the user. `strongerThan` sorts by
`capability_rank` first and price second. Price stays as the tie-break and as
the router's cost input. This removes the assumption that price tracks
capability, which no longer holds.

### 6.3 Approval policy

New: `src/policy/approval.ts`. Modify: `src/workers/irProcessor.ts`,
`src/workers/patchApplier.ts`, `src/index.tsx`.

`--approve never|risky|always`, default `risky`. Risky is defined by what
`irProcessor` already computes for pre-risky checkpoints (>200 diff lines, ≥10
touched files, any deletion) plus GUARDED basenames plus any command that
installs or reaches the network. Surfaced through the TUI, through ACP
permission requests, and through the MCP host's own permission flow.

### 6.4 Watch mode

New: `src/commands/watch.ts`.

`codemaster watch --on-fail "<objective>"` reuses the existing `chokidar`
watcher and `testRunner`. On red, run the objective; on green, idle. Debounced,
with a per-hour call ceiling. This is the smallest possible loop-engineering
feature and it is what turns the tool into something that runs all day.

### 6.5 TUI

Modify: `src/index.tsx`, `src/ui/selection.ts`.

- `ui.mouse: false` by default. The alternate-screen mouse capture and the
  frame-scraping selection layer become opt-in.
- A plain renderer (`--ui plain`) with no Ink, for CI, dumb terminals, and
  Windows.
- Status line shows phase, tier, context tokens and evidence state, e.g.
  `Solving · tier 1 · 34k ctx · repro admitted · $0.14`.
- `/why` and `/context` promoted in `/help` and in the README's first screen.

---

## Sequencing and effort

| Wave | Weeks | Depends on | Expected effect |
|---|---|---|---|
| 0 Measurement + launch | 2 | — | makes everything else provable |
| 1 Loop + edits | 3-4 | 0 | largest `Succ/Mtok` and `pass@1` gain |
| 2 Evidence + isolation | 3 | 0, 1 | makes greenfield work; enables parallelism |
| 3 Memory | 2-3 | 0 | compounding; cross-repo transfer |
| 4 Layer surface | 3 | 1, 2 | adoption |
| 5 Self-evolution | 4 | 0, 3 | compounding, differentiating |
| 6 Economics + UX | 2 | 1 | retention |

Run Wave 4 in parallel with Wave 3 if you have the capacity; they touch almost
disjoint files.

## Definition of done, per wave

Every wave lands with: new tests in the existing `tests/unit` pure-function
style (no module mocking, extract the pure core), a `bench:smoke` run before and
after with the delta recorded in the PR body, and a `docs/` page. A wave that
does not move a metric in the Wave 0 table gets reverted, not argued about.