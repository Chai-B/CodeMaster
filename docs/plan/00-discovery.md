# Phase 1 — Discovery

What the source actually does, verified against it. Every `path:line` here was
read on branch `codemaster` at `a0f36e9`. Where I could not verify a claim I say
so rather than repeating it.

`CODEMASTER-10X.md` and `IMPLEMENTATION-PLAN.md` were written from `ARCHITECTURE.md`
and `SPEC.md` without reading source. This document is the correction pass. Where
those two documents are right, I say so and cite the line that proves it; where
they are wrong, §7 lists it.

---

## 0. Baseline

| Fact | Value | Evidence |
|---|---|---|
| Tests | 229 total · 228 pass · 1 skipped · 0 fail | `npm test` |
| Typecheck | clean | `npm run typecheck` |
| Node floor | `>=22.5.0` | `package.json:6` |
| Scripts | `start`, `dev`, `typecheck`, `test` — **nothing else** | `package.json:9-14` |
| `bench:smoke` | **does not exist** | same |
| `bench:selfhist` | **does not exist** | same |
| `docs/` | did not exist before this document | — |
| CI | `.github/workflows/ci.yml` exists: ubuntu×node{22,24} + macos×node24, plus a `version` job asserting `package.json` version equals `bin/codemaster.js --version` | `.github/workflows/ci.yml:14-55` |

**The brief's per-wave step 5 — "`npm run bench:smoke` before and after with the
metric delta in the PR" — cannot run today.** Waves 0.1 through 0.4 have no
before-number and cannot have one. This is not a reason to skip the ordering
rule; it is the reason Wave 0.1 is first.

**CI status is unverified.** `gh` is not installed on this machine
(`command not found: gh`), so I could not read the run history. Wave 0.4's
premise — "CI is red" — is an assumption, not a finding. Check it before
budgeting work against it.

Test distribution, for the test-surface map in §5:

```
behavioralVerify 38   tokenDiscipline 18   providers 17   commandSurface 17
commands(e2e)    13   learning         9   solver     8   properties      8
cliAuth           8   analysis(int)    8   tuiLayout  7   selection       7
quotaLedger       6   prompt           6   continuation 6  claudeCli      6
fixtures(int)     6   verifier         5   reasoningLocus 5 patchApplier  5
cliRun            5   symbolSlice      4   outputParser 4  credentials    4
cancel            4   session(e2e)     4   mcp        3   lifecycle       3
codexCli          3   budget           3   gitDiff    2   golden(e2e)     1
```

---

## 1. Drift report — source vs. `ARCHITECTURE.md`

### 1.1 Worker contract and the pipeline — `base.ts`, `descriptors.ts`, `scheduler.ts`

`ARCHITECTURE.md:162` says:

> `src/workers/scheduler.ts` holds this as an explicit DAG (`TASK_PIPELINE`) with
> `topoOrder()`, and `nextReadyTask()` picks the next task whose `dependencies`
> have all completed.

The second half is true. The first half is not.

`TASK_PIPELINE` declares **13 stages** (`scheduler.ts:18-32`). `registerCoreWorkers()`
(`scheduler.ts:36-44`) registers **12 workers**: the 8 in `DETERMINISTIC_WORKERS`
(`descriptors.ts` — `IntentParser:18`, `StaticIndexer:26`, `FileSelector:40`,
`WikiReader:51`, `OutputParser:62`, `PatchApplier:73`, `RipgrepWorker:84`,
`EmbeddingWorker:92`) plus `VerifierWorker`, `ModuleSummarizerWorker`,
`MemoryCompressorWorker`, `ConflictResolverWorker`.

**Six `TASK_PIPELINE` stages have no registered worker at all**: `Planner`,
`ContextCompiler`, `ReasoningExtractor`, `WikiUpdater`, `TaskExecutor`,
`Checkpointer`. Nothing executes the pipeline. The real sequence is hand-coded
straight-line control flow in `sessionManager.runNextTask()` (`:295-493`).

`topoOrder()` (`scheduler.ts:46`) sorts `TASK_PIPELINE`, which nothing consumes for
execution. `nextReadyTask()` (`scheduler.ts:65-74`) operates on *plan tasks*, not
pipeline stages — a different graph entirely, and that one is real.

**Verdict:** `TASK_PIPELINE` is a diagram that has drifted from the code it
describes. `ARCHITECTURE.md:162` overstates it. This matters directly for the
brief's working rule that a new worker "appears in `descriptors.ts` so `/workers`
stays truthful" — `/workers` and `TASK_PIPELINE` already disagree by six entries,
so that rule is currently unenforceable as stated.

### 1.2 Session orchestration — `sessionManager.ts`

| Symbol | Line | Exported? | Notes |
|---|---|---|---|
| `buildEvidence` | `:43-71` | **no** | private; Wave 2 must export it to test it |
| `deriveStatus` | `:81-104` | yes | already unit-tested (`behavioralVerify.test.ts:315`) |
| `gitChangedFiles` | `:106` | no | |
| `runNextTask` | `:295-493` | — | the real pipeline |
| `characterizationFor` | `:500-517` | no | |
| `runAll` | `:519-568` | — | strictly sequential |
| `complete` | `:592-630` | — | promotes to long-term memory |

`buildEvidence` core, verbatim (`:60-70`):

```ts
const selfAuthored = discovered.length > 0 && discovered.every((t) => touched.has(t));
let provenance: OracleProvenance = 'none';
if (bv?.reproUsed && bv.ran) provenance = 'repro-admitted';
else if (selfAuthored) provenance = 'authored-by-task';
else if (discovered.length > 0 && bv?.ran) provenance = 'pre-existing';
const verified = solverVerified && (provenance === 'pre-existing' || provenance === 'repro-admitted');
```

This is the load-bearing line. `verified` is unreachable through
`authored-by-task` and through `none`. **A test the task wrote can prove failure
but never success** is implemented here and nowhere else.

`runAll` is sequential — one task at a time, no concurrency primitive anywhere in
the file. The spec's `[for each task in parallel where safe]` (§12.4) was never
built. `nextReadyTask()` returning a single task is the enforcement point.

### 1.3 The `ir.status` asymmetry — **binding, do not "fix"**

The brief states as non-negotiable: "`deriveStatus` computes status from what
happened, never from `ir.status`."

**The source contradicts this, and the source is right.** `deriveStatus` reads
`result.ir.status` at `:82` (`blocked`) and `:85` (`failed`). It does *not* read it
for `completed` — that is derived at `:103`.

Resolved, and recorded here as binding:

> **`ir.status` may only worsen an outcome, never improve one.**
> `ir.status ∈ {blocked, failed}` is honoured — the model reporting its own
> failure is evidence of failure, and discarding it loses `blocked_by` and the
> model's own failure text, which is the only place a human learns *why*.
> `ir.status === 'completed'` is ignored — a self-report can never establish
> success.

Lines `:82` and `:85` stay. Anyone "fixing" them to match the brief's literal
wording regresses the product. This paragraph exists so that never happens.

### 1.4 Context pipeline — `fileSelector.ts`, `budget.ts`, `compiler.ts`, `outputFormat.ts`

**`fileSelector.ts`** — `ARCHITECTURE.md:408-449` is accurate. Signals *accumulate*
through `bump()` with a recorded reason per bump (this is what powers `/why`),
rather than taking a maximum as `SPEC.md` §10.3 specifies. Verified: git
co-change `:~100` (0.4), call-graph callers 0.5 / callees 0.6, coverage expansion
0.7 for `type === 'test'`, multi-file neighbour expansion for
`debug|implement|refactor`, PageRank tie-break at weight `0.12 * (pr/top)` explicitly
commented "breaks ties, does not decide selection". Final rank
(`fileSelector.ts:159`):

```ts
score: s * relevanceWeight(p, task.type) * Learning.utility(api.repoPath, p)
```

**`budget.ts`** — `LADDER = [24_000, 64_000, 160_000]` at `:101`, absolute rungs.
`budgetForTier` `:103`. `resolveBudget` `:108`, 12% reserve at `:122`
(`Math.floor(budget * 0.88)`), learned-weight renormalization `:124-132` against
the profile's *original* total so shrinking one component feeds the others rather
than shrinking the whole context. Six profiles at `:8-70`.

**`compiler.ts`** — `ORDER` (`:301-307`) is 16 components, most-stable-first, with
the stated purpose of letting the vendor prefix cache match a long shared prefix.
`REDUCE_ORDER` `:340-344`, `KEEP` `:348`, `compressContent` `:351`, reduce loop `:401`.
The `REDUCE_ORDER` comment already states the ordering principle the brief asks
future waves to maintain — anything re-derivable from disk or git goes first,
known failures and prior reasoning last because each cost an LLM call to buy.

**`outputFormat.ts`** — five contracts: `OUTPUT_FORMAT` `:8` (whole-file XML),
`PROSE_OUTPUT_FORMAT` `:64`, `PROSE_SYSTEM_PROMPT` `:72`, `JSON_OUTPUT_FORMAT` `:84`,
`DIFF_OUTPUT_FORMAT` `:112`, `SYSTEM_PROMPT` `:138`. `REASONING_MARKER` `:6`.

### 1.5 Execution — `taskExecutor.ts`, `solver.ts`, `outputParser.ts`, `patchApplier.ts`, `irProcessor.ts`

`taskExecutor.executeTask` `:85`; three `role: 'solve'` call sites `:110`, `:197`, `:223`.
`solver.solveWithVerification` `:47`; the confidence rule at `:111`:

```ts
verified = v.ok && v.confident !== false
```

`Learning.recordTier` `:195`, `recordLesson` `:196`.

`outputParser.parseIR` `:56`; `files_created` from `tagBlocksWithAttrs(xml, 'file')` `:77`.

`patchApplier` — `resolveInRepo` `:23`, `WritePolicy` `:31`, `GUARDED` `:41`,
`refuseWrite` `:62`, `applyPatches(repoPath, patches, newFiles, policy)` `:78`.
**Unified-diff application already works today.**

`irProcessor.processIR` `:33`; risky-checkpoint threshold `:69`:
`diffLines > 200 || touched >= cfg.checkpointing.pre_risky_threshold || ir.files_deleted.length > 0`.

### 1.6 Verification — `behavioralVerify.ts`, `reproGenerator.ts`, `useSites.ts`

`behavioralVerify.ts` gate order, as implemented:

1. crash guard `:69`
2. repro (if admitted)
3. **characterization** `:100-108` — on failure returns the directive *"Do not
   weaken or delete this check"* verbatim in the model-facing text
4. locus coverage `:114` — `missedLocus` when the change never touched a named file
5. **use-site coverage** `:117-124` — **a hard gate**, returns `{ok: false}` and
   sets `ran: false`
6. discovered + authored tests `:129-140`

The comment at `:132-135` is worth quoting because it is the invariant stated in
the code itself:

> Its failure is real evidence of failure. Its success is not evidence of
> success — `buildEvidence` refuses to call a self-authored oracle verification.

`unvisitedUseSites` (`useSites.ts:31-80`) is fully deterministic, zero LLM calls.
It compares indexed signatures against on-disk signatures, skips body-only edits
(`:72`), and reports only callers that are genuine dependents (`:74` filters on
`dependents.has(f)`), excluding test files and files the patch already opened.
It returns `[]` — never a manufactured gap — when the file was never indexed (`:59`).

`reproGenerator.ts` — `SYSTEM` `:34`, `CHARACTERIZATION_SYSTEM` `:46`, worktree
machinery `:75-94` (`git stash create` then `git worktree add --detach`, removed with
`--force` at `:268-269`), `TEST_IS_BROKEN` `:148`, `SKIP` `:173`, `VERBATIM_MAX = 6000` `:187`.
Admission in a throwaway worktree is real and reusable — Waves 2.2/2.3 are grounded.

### 1.7 Analysis layer

| File | Lines | Notes |
|---|---|---|
| `api.ts` | 354 | facade over the rest |
| `indexer.ts` | 158 | **see §2.3 — does not write `line_end`** |
| `treesitter.ts` | 284 | `extractWithFallback`, WASM + regex fallback |
| `extractors.ts` | 210 | `ExtractedSymbol {name, kind, line, signature, exported}` `:4-10` |
| `callGraph.ts` | 71 | `callersOf`/`calleesOf`/`callChain(maxDepth=6)`, module-level cache `:67-71` |
| `useSites.ts` | 92 | see §1.6 |
| `depGraph.ts` | 243 | |
| `git.ts` | 225 | `isRepoRoot:23` |
| `testRunner.ts` | 358 | |
| `tokenAnalytics.ts` | 245 | `wasteRatio()` surfaced at `:211`, `:241` |
| `lsp.ts` | 184 | present; I found **no** hardcoded cap of 12 — see §7 |
| `embeddings.ts` | 170 | |
| `coverage.ts` | 132 | |
| `repoMap.ts` | 93 | |
| `ripgrep.ts` | 100 | |
| `watcher.ts` | 51 | |

### 1.8 Providers — `manager.ts`, `quotaLedger.ts`

`manager.ts` is 870 lines. `tierFor` `:100-122` is a pure scoring function and
already unit-tested. Its shape:

```
DERIVED_CHEAP role            → 'light' (early return)
debug|refactor                → +2      implement|plan → +1
files>8 || tokens>40_000      → +2      files>2 || tokens>12_000 → +1
contextTier > 0               → +2
score>=3 → heavy · score<=0 → prose ? 'standard' : 'light' · else 'standard'
```

`continuationRequest` `:140-151` — three cases, real, used at `:680`. Case 3 returns
`{...full, user: conv.delta, conversation: {id, resume: true}}`.

`quotaLedger.ts` — `WINDOW_MS` `:84`, `DEFAULT_WINDOW_MS = 3_600_000` `:90`,
`COOLDOWN_STEPS_MS = [30_000, 120_000, 600_000]` `:105`, `SCHEMA` `:107`,
`ADDED_COLUMNS` `:136`, class `:233`. Records only what vendors reported. No
estimated or inferred limit exists in the file.

### 1.9 Memory, wiki, learning

**`memory/lifecycle.ts` (84 lines)** implements `SPEC.md` §7.6 decay exactly:
`recencyDecay = exp(-0.05 × days)`, `effectiveImportance = importance × confidence ×
(1 + log(1+refs)) × recencyDecay`, `permanent` returns `Infinity`.
`findCompressionCandidates(threshold, ageDays)` additionally requires
`detail.length > 400`.

**`workers/memoryCompressor.ts` is 43 lines and the whole of it matters.** Line 38:

```ts
db.prepare('UPDATE reasoning SET detail=?, importance=importance*0.5 WHERE id=?').run(text.trim(), c.id);
```

**This is the only write path, and it destroys the original.** `SPEC.md` §7.6 step 3
("the full object is archived to cold storage") is not implemented anywhere.
Confirmed by grep: no archive write exists in `src/storage/reasoning.ts` either.
The brief's non-negotiable — "no code path may write a compressed `detail` without
first writing the full original to disk" — is **currently violated at exactly one
line**, which makes Wave 3.2 a small, well-bounded change with an obvious test.

**`memory/replay.ts` (41 lines)** — `replayReasoning(keywords, limit=20)`, pure query,
never calls an LLM.

**`wiki/`** — `bootstrap.ts` (217) with `MIN_FILES_FOR_MODULE = 2`,
`MIN_SOURCE_FOR_MODULE_SUMMARY = 12_000`, `MIN_SOURCE_FOR_CONVENTIONS = 1500`,
`DOC_FILES = ['README.md','readme.md','CONTRIBUTING.md','ARCHITECTURE.md']`,
`BOOTSTRAP_STATE_KEY = 'meta/bootstrap'`; `reader.ts` (90) with `NAMESPACE_PRIORITY`
per task type; `updater.ts` (157); `markdown.ts` (40).

**`learning/reflector.ts` (117)** — `MIN_SAMPLES = 4` `:13`; `Learning` `:22` exposing
`recordSelection:25`, `recordComponents:36`, `componentWeights:51`, `recordTier:61`,
`utility:75`, `startTier:88`, `report:99`. All seven the plan assumes exist, do.

### 1.10 Integration surfaces — `mcp.ts`, `proxy.ts`, `events/`

**`mcp.ts` (297 lines)** — hand-rolled JSON-RPC 2.0 over stdio, no SDK dependency.
Five tools: `compile_context` `:82`, `relevant_files` `:113`, `prior_reasoning` `:133`,
`record_reasoning` `:167`, `repository_map` `:200`. Protocol version `2024-11-05`;
methods `initialize`, `tools/list`, `tools/call`, `ping`. Requests are serialized
through a promise chain `:222` because MCP clients may pipeline. Exported as
`MCP_TOOLS` `:297`, which is what makes `tests/unit/mcp.test.ts` possible.

`compile_context`'s description advertises `tier` as "0 ≈ 24k tokens, 1 ≈ 64k, 2 ≈ 160k"
— the `LADDER` values, surfaced to an external client. Any Wave that changes
`LADDER` must change this string in the same PR or the MCP contract starts lying.

**`proxy.ts` (195 lines)** — `node:http`, no dependency. `GET /v1/models`,
`POST /v1/chat/completions`. `codemaster: { context?, task_type?, tier? }` extension;
`context: false` passes through untouched. Records to `Tokens.record` with
`session_id: 'proxy'`. Streaming is emulated: one content chunk plus terminator,
explicitly commented as not a fabricated token-by-token feed.

**`events/bus.ts` (58)** — `EventEmitter` plus a wildcard set; `daemon.log_level`
filtering via `LEVELS = ['error','warn','success','info','debug']`, threshold cached
on first use. `events/types.ts` (80) — nine event families.

---

## 2. Schema inventory

Two databases. `getDb()` is PRIMARY, `getRepoDb(repoPath)` is the per-repo index.

### 2.1 PRIMARY — `PRIMARY_SCHEMA`, `schema.ts:5-227`. Never dropped.

| Table | Line | Purpose |
|---|---|---|
| `sessions` | `:6` | |
| `tasks` | `:27` | + `idx_tasks_session` `:51` |
| `reasoning` | `:53` | + `idx_reasoning_session` `:75`, `idx_reasoning_type` `:76` |
| `failures` | `:78` | |
| `long_term_memory` | `:92` | |
| `token_usage` | `:111` | + `idx_token_session` `:128` |
| `provider_accounts` | `:131` | |
| `checkpoints` | `:143` | + `idx_checkpoint_session` `:157` |
| `wiki_entries` | `:159` | + `idx_wiki_namespace` `:173` |
| `audit_log` | `:175` | |
| `undo_journal` | `:191` | |
| `prompt_cache` | `:200` | |
| `text_cache` | `:211` | |
| `cache_stat` | `:222` | |

`PRIMARY_MIGRATIONS` — 11 entries, `schema.ts:384-396`, additive only, idempotent
(duplicate-column errors swallowed):

```
token_usage  += cache_read_tokens, cache_write_tokens, wasted_tokens, role
checkpoints  += git_commit, repository_path, storage_path, size_bytes,
                tasks_completed, tasks_remaining
tasks        += evidence_json
```

Any PRIMARY schema change in any wave appends here. Never edit an existing entry.

### 2.2 REPO INDEX — `REPO_INDEX_SCHEMA`, `schema.ts:229-378`. Droppable.

| Table | Line | Columns |
|---|---|---|
| `file_index` | `:230` | `path` PK, `language`, `purpose`, `responsibilities_json`, `architectural_role`, `exports_json`, `imports_json`, `last_modified`, `last_indexed`, `ast_hash`, `embedding_id` |
| `symbols` | `:244` | `id` PK, `name`, `kind`, `file_path`, `line_start`, **`line_end`**, `signature`, `documentation`, `is_exported`, `ast_hash` |
| `symbol_references` | `:259` | `id` PK, `symbol_id`→`symbols(id)`, `file_path`, `line`, `reference_type` |
| `dependency_edges` | `:269` | PK `(from_file, to_file)`, `import_type`, `imported_symbols_json` |
| `file_utility` | `:283` | `path` PK, `included`, `referenced`, `updated_at` |
| `component_utility` | `:293` | PK `(task_type, component)`, `included`, `referenced`, `updated_at` |
| `tier_outcomes` | `:302` | PK `(task_type, tier, verified)`, `count` |
| `module_index` | `:310` | `path` PK, `name`, `purpose`, `responsibilities_json`, `file_count`, `key_files_json`, `dependencies_json`, `dependents_json`, `last_indexed` |
| `calls` | `:322` | `id` PK, `caller`, `callee`, `file_path`, `line` + 2 indexes |
| `embeddings` | `:332` | `id` PK, `source_type`, `source_ref`, `embedding` BLOB, `embedding_model`, `created_at` |
| `coverage` | `:342` | `file_path` PK, `covered_lines_json`, `total_lines`, `covered`, `pct` |
| `rkg_nodes` | `:350` | `id` PK, `type`, `ref`, `purpose`, `responsibilities_json`, `architectural_role`, `stability`, `data_json`, `ast_hash`, `updated_at` |
| `rkg_edges` | `:364` | `id` PK, `type`, `from_ref`, `to_ref`, `data_json` |
| `repo_meta` | `:374` | `key` PK, `value` |

`REPO_INDEX_VERSION = 2` (`db.ts:12`). Written to `repo_meta` at `db.ts:87`, checked
at `db.ts:82`; on mismatch the index is dropped and rebuilt. This is the migration
mechanism for everything in this table — no `ALTER` needed, and no migration to
write.

### 2.3 Symbol spans — the answer Wave 1.2 depends on

**`symbols` stores line numbers only, and in practice only `line_start`.**

- `line_end` is **declared** (`schema.ts:250`) and **never written**. Both inserts
  name exactly eight columns and `line_end` is not among them:
  `indexer.ts:74` and `indexer.ts:133` are both
  `INSERT INTO symbols (id, name, kind, file_path, line_start, signature, is_exported, ast_hash)`.
- **There are no byte offsets anywhere.** No column, no field, no extractor output.
- `ExtractedSymbol` (`extractors.ts:4-10`) carries `{name, kind, line, signature, exported}` —
  a single start line.
- Row id format: `` `${relPath}:${s.name}:${s.line}` `` (`indexer.ts:136`), so id
  identity is already coupled to the start line. A symbol that moves gets a new id.

**Wave 1.2 step 2 as written — "verify the current file bytes at the recorded span
still hash to the indexed value" — is unimplementable today.** There is no span and
no hash of one (`ast_hash` is per-file, not per-symbol span).

**Cost of adding spans:**

| Piece | Cost | Risk |
|---|---|---|
| `ExtractedSymbol` gains `endLine`, `startByte`, `endByte` | ~5 lines | none |
| tree-sitter extractor populates them | ~10 lines — `node.endPosition` and `node.startIndex`/`endIndex` are already on the node, free at parse time | none |
| regex extractor populates them | **cannot do so reliably** — it has no end-of-body knowledge. Best available is `startByte` from the match offset and `endByte` = start of the next symbol, which is wrong for nested and trailing symbols | **this is the real cost** |
| `indexer.ts` inserts add 3 columns, 2 statements | ~4 lines | none |
| `schema.ts` adds `start_byte`, `end_byte` | 2 lines | none |
| `REPO_INDEX_VERSION` 2 → 3 | 1 line | forces a full reindex for every existing user on next run |

Net: roughly 25 lines of source plus a version bump. **The blocker is not the
line count, it is that Swift and every other regex-only language cannot produce a
trustworthy span.** An edit format that requires a verified span therefore has a
silent hole exactly where the parser is weakest — which is where edits are
riskiest. §6 of `01-plan.md` argues from this.

---

## 3. Constants inventory — Wave 5.1 externalization targets

Every tunable I found, with its current home. Wave 5.1 wants these in one place;
this is the list it has to cover.

### Budget and context

| Constant | Location | Value |
|---|---|---|
| `LADDER` | `context/budget.ts:101` | `[24_000, 64_000, 160_000]` |
| budget reserve | `context/budget.ts:122` | `0.88` (12% held back) |
| `BUDGET_PROFILES` | `context/budget.ts:8-70` | 6 profiles |
| `ORDER` | `context/compiler.ts:301` | 16 components, stable-first |
| `REDUCE_ORDER` | `context/compiler.ts:340` | 13 components |
| `KEEP` | `context/compiler.ts:348` | `{OBJECTIVE, CURRENT_TASK, INSTRUCTIONS, RELEVANT_FILES}` |
| file budget fallback | `context/compiler.ts:58` | `maxContextTokens * 0.3` |
| chars-per-token | `context/compiler.ts` `truncateToTokens` | `4` |

### File selection

| Constant | Location | Value |
|---|---|---|
| `FILE_PATH_RE` | `context/fileSelector.ts:211` | |
| `STOPWORDS` | `context/fileSelector.ts:218` | |
| `isPascal` | `context/fileSelector.ts:226` | |
| `relevanceWeight` | `context/fileSelector.ts:263` | source ≥ 0.9 threshold used at `:~140` |
| `DEF_RE` | `context/fileSelector.ts:321` | |
| git co-change bump | `context/fileSelector.ts:~100` | `0.4`, top 5 |
| caller / callee bumps | `context/fileSelector.ts` step 5 | `0.5` / `0.6` |
| test coverage bump | `context/fileSelector.ts` step 6 | `0.7` |
| PageRank tie-break | `context/fileSelector.ts` | `0.12 * (pr/top)` |
| neighbour expansion top-N | `context/fileSelector.ts` step 8 | `3` |
| keyword stem floor | `context/fileSelector.ts` | length `>= 4` |

### Routing and providers

| Constant | Location | Value |
|---|---|---|
| `CACHE_READ_MULTIPLIER` | `providers/manager.ts:21` | `0.1` |
| `CACHE_WRITE_MULTIPLIER` | `providers/manager.ts:22` | `1.25` |
| `DERIVED_CHEAP` | `providers/manager.ts:55` | `{review, summarize, merge}` |
| `DERIVED_EFFORT` | `providers/manager.ts:62` | `{oracle: 'medium'}` |
| `THINKING_BUDGET` | `providers/manager.ts:65` | `{low: 1024, medium: 4096, high: 12288}` |
| `tierFor` thresholds | `providers/manager.ts:109-120` | files 8/2, tokens 40k/12k, score 3/0 |
| `ENV_REF` | `providers/manager.ts:124` | |
| `ROLE_TASK_TYPE` | `workers/llm.ts:15` | |
| `WINDOW_MS` | `providers/quotaLedger.ts:84` | per-vendor |
| `DEFAULT_WINDOW_MS` | `providers/quotaLedger.ts:90` | `3_600_000` |
| `COOLDOWN_STEPS_MS` | `providers/quotaLedger.ts:105` | `[30_000, 120_000, 600_000]` |

### Verification

| Constant | Location | Value |
|---|---|---|
| `VERBATIM_MAX` | `workers/verify/reproGenerator.ts:187` | `6000` |
| `TEST_IS_BROKEN` | `workers/verify/reproGenerator.ts:148` | |
| `SKIP` | `workers/verify/reproGenerator.ts:173` | |
| `maxTestFiles` | `workers/verify/behavioralVerify.ts:~138` | default `30` |
| `CALLABLE` | `analysis/useSites.ts:23` | `{function, method, class}` |
| gap report caps | `analysis/useSites.ts:85-86` | 8 gaps, 6 callers each |
| risky-checkpoint threshold | `workers/irProcessor.ts:69` | `diffLines > 200` |
| `callChain` depth | `analysis/callGraph.ts:29` | `6` |

### Memory, wiki, learning

| Constant | Location | Value |
|---|---|---|
| decay rate | `memory/lifecycle.ts` `recencyDecay` | `-0.05` per day |
| compression detail floor | `memory/lifecycle.ts` | `detail.length > 400` |
| compression summary cap | `workers/memoryCompressor.ts:20,36` | `<=200 tokens` / `maxTokens: 300` |
| importance decay on compress | `workers/memoryCompressor.ts:38` | `× 0.5` |
| `MIN_SAMPLES` | `learning/reflector.ts:13` | `4` |
| `MIN_FILES_FOR_MODULE` | `wiki/bootstrap.ts:23` | `2` |
| `MIN_SOURCE_FOR_MODULE_SUMMARY` | `wiki/bootstrap.ts:29` | `12_000` |
| `MIN_SOURCE_FOR_CONVENTIONS` | `wiki/bootstrap.ts:43` | `1500` |
| `DOC_FILES` | `wiki/bootstrap.ts:44` | 4 filenames |
| `replayReasoning` limit | `memory/replay.ts` | `20` / failures `8` |
| `LEVELS` | `events/bus.ts:13` | 5 log levels |
| `REPO_INDEX_VERSION` | `storage/db.ts:12` | `2` |

**Note for Wave 5.1:** `LADDER` is not purely internal. `mcp.ts:93` describes its
values to external MCP clients in prose. Externalizing it means that string has to
be generated, not hardcoded, or the two will drift.

---

## 4. Confirmed defects

### D1 — `scratchpad` is dead budget · **new, not in either planning document**

`SPEC.md` §11.2 allocates `scratchpad: 2%` to the planning profile and `7%` to
testing. The build **kept both allocations**: `budget.ts:19` and `budget.ts:59`.
`BudgetProfile` even types it specially: `Partial<Record<ContextComponent | 'scratchpad', number>>`
(`types/context.ts:27`).

But `scratchpad` is **not** a `ContextComponent` (`types/context.ts:6-25` — 18
members, no scratchpad), and grep finds exactly three references to the string in
the whole of `src/`: the type and the two profile entries. **Nothing ever emits it,
and nothing ever reads its allocation.**

`resolveBudget` includes it in both `before` and `after` when renormalizing
(`budget.ts:124-132`), so it takes its share and that share is then never spent.
**2% of every planning budget and 7% of every testing budget is allocated to a
component that does not exist.**

`CODEMASTER-10X.md` §1.3 says "the build's nine components do not include one" and
files this under *"the scratchpad was dropped"*. That is wrong in a way that
matters: it was not dropped, it was **half-dropped**, and the surviving half is
silently costing budget. Either wire it up (§1.6 of `CODEMASTER-10X.md` wants it
back as the model's working-notes channel) or delete the two profile entries.
Deleting them is a two-line change that recovers 7% of the testing budget today.

### D2 — Memory compression destroys the original

`workers/memoryCompressor.ts:38` overwrites `reasoning.detail` in place. `SPEC.md`
§7.6 step 3 archives the full object first. Nothing archives. This is Wave 3.2 and
it is a one-line-plus-a-test change.

### D3 — `TASK_PIPELINE` describes six workers that do not exist

§1.1. Either register them, delete them from the pipeline, or demote
`TASK_PIPELINE` to a documented diagram and stop calling it a DAG in
`ARCHITECTURE.md:162`.

### D4 — Retry evidence staleness · **fixed**

Fixed on branch `fix/retry-evidence-staleness` (`6421c18`), ahead of Wave 0 per
explicit instruction. After the self-correction retry wrote to the tree,
`next.evidence`, `next.status` and `output_files` were never recomputed, and
`retry.ir.status === 'completed'` — a model self-report — was the sole gate on
claiming self-correction had worked. Now re-verifies, re-derives through
`buildEvidence`/`deriveStatus`, and reconciles progress counters through a new pure
`reconcileProgress()` with a unit test. 230 tests, 0 failures.

> **Housekeeping:** that commit also swept in the three untracked planning
> documents (`ARCHITECTURE.md`, `CODEMASTER-10X.md`, `IMPLEMENTATION-PLAN.md`,
> 3006 lines). They belong in the commit that adds `docs/`, not in a bugfix.
> Amending was blocked by permissions; the branch needs
> `git rm --cached` on those three plus `--amend` before it becomes a PR.

---

## 5. Test-surface map

### Pure functions the plan assumes exist — all verified present

| Function | Location | Tested in |
|---|---|---|
| `parseVerification` | `workers/verifier.ts` | `verifier.test.ts` |
| `extract` | `analysis/extractors.ts` | `analysis.test.ts` |
| `tierFor` | `providers/manager.ts:100` | `providers.test.ts` |
| `isSingleUnit` | `workers/planner.ts:52` | `prompt.test.ts` |
| `isSelfVerificationTask` | `workers/planner.ts:33` | via `irProcessor` |
| `resolveBudget` | `context/budget.ts:108` | `budget.test.ts` |
| `continuationRequest` | `providers/manager.ts:140` | `continuation.test.ts` |
| `parseClaudeStatus` | `providers/claudeCli` | `claudeCli.test.ts` |
| `deriveStatus` | `daemon/sessionManager.ts:81` | `behavioralVerify.test.ts:315` |
| `unvisitedUseSites` | `analysis/useSites.ts:31` | `behavioralVerify.test.ts:130-190` |
| `failedNodeIds` | `verify/reproGenerator.ts` | `behavioralVerify.test.ts` |
| `recencyDecay`, `effectiveImportance` | `memory/lifecycle.ts` | `lifecycle.test.ts` |
| `MCP_TOOLS` | `mcp.ts:297` | `mcp.test.ts` |

Not yet exported, and needed by later waves: **`buildEvidence`**
(`sessionManager.ts:43`) is private. Wave 2 must export it to test the
`criteria-admitted` path directly.

### Predicted breakage per wave

| Wave | Tests at risk | Why |
|---|---|---|
| 0.1 bench harness | none | new files, new script |
| 0.2 metrics | `tokenDiscipline` (18) | if the waste taxonomy is renumbered, these assert on class names |
| 0.3 trace store | none expected | additive |
| 0.4 CI / `doctor --fix` | `commandSurface` (17), `cliRun` (5) | `/doctor` output shape |
| 0.5 redaction | `prompt` (6), `tokenDiscipline` (18) | compiled-context content changes |
| 1.1 `<context_request>` | `prompt` (6), `continuation` (6), `solver` (8) | a new in-conversation turn changes call sequencing |
| **1.2a spans** | `analysis` (8), `symbolSlice` (4), `selection` (7) | `ExtractedSymbol` shape change; `REPO_INDEX_VERSION` bump forces reindex in fixtures |
| **1.2b `<edits>`** | `outputParser` (4), `patchApplier` (5), `golden` (1), `fixtures` (6) | the output contract itself |
| 2.x evidence | **`behavioralVerify` (38)** — the largest single file | `buildEvidence`, provenance, gate order |
| 3.2 archive | `lifecycle` (3) | plus a new assertion the brief requires |
| 4.x MCP tools | `mcp` (3) | tool list is asserted |
| 5.1 constants | `budget` (3), `providers` (17), `selection` (7) | wherever a constant moves |

The concentration is unmistakable: **`behavioralVerify.test.ts` holds 38 of 229
tests, 17% of the suite, and Wave 2 touches all of it.** Wave 2 is the highest-risk
wave in the plan and should not be scheduled next to another risky one.

---

## 6. Binding rules recorded here

1. **`ir.status` may only worsen an outcome, never improve one.** §1.3. Lines
   `sessionManager.ts:82` and `:85` stay.
2. **A test the task itself wrote can prove failure but never success.**
   Implemented at `sessionManager.ts:70`. Any change to `buildEvidence` preserves it.
3. **`unvisitedUseSites` is a hard gate**, `behavioralVerify.ts:117-124`, not a
   confidence flag.
4. **The characterization check stays.** `behavioralVerify.ts:100-108`, including
   its "do not weaken or delete this check" directive.
5. **The LLM verifier stays advisory.** Unparseable verdict → `partial`, never `pass`.
6. **Cost figures come from persisted rows.** No counterfactual, ever
   (`ARCHITECTURE.md:1043-1045` states this and the code honours it).
7. **Every LLM call goes through `callLlm` with a required `role`** (`workers/llm.ts:49`).
8. **Memory compression writes an archive before it overwrites** — currently false
   (D2), becomes true in Wave 3.2, and gets a test that asserts it.

---

## 7. Where the planning documents are wrong

`CODEMASTER-10X.md` and `IMPLEMENTATION-PLAN.md` are right far more often than not.
These are the exceptions, and each one changes a wave.

| Claim | Where | Verdict |
|---|---|---|
| "Diffs were replaced with whole-file output" | 10X §1.3, G2 | **Half right.** `DIFF_OUTPUT_FORMAT` (`outputFormat.ts:112`) and `applyPatches` (`patchApplier.ts:78`) work today for Codex. Whole-file is the *default*, not the only path. Wave 1.2 changes a default and adds a parser; it does not build diff support from nothing. Smaller than budgeted. |
| "The scratchpad was dropped" | 10X §1.3 | **Wrong, and worse than described.** It was half-dropped: the 2%/7% allocations survive and are spent on nothing. See D1. |
| "`lsp.ts` caps LSP reference results at 12" | 10X §1.3 | **Unverified.** I found no hardcoded 12 in `analysis/lsp.ts` (184 lines). Either the constant moved or the claim is wrong. Do not cite it in a PR without re-checking. |
| "Waste classes W1, W6, W7" | IMPL Wave 0.2 | **Invented over a numbering gap.** The documented set is W2–W5 (`ARCHITECTURE.md:1049-1054`) — **there is no W1** — and only W3 is implemented (`tokenAnalytics.ts:211,241`). Reconcile the taxonomy before building against it. |
| "`TASK_PIPELINE` is the explicit DAG" | `ARCHITECTURE.md:162` | **Overstated.** Six of thirteen stages have no worker. See D3. |
| "Wave 1.2: verify bytes at the recorded span hash to the indexed value" | IMPL Wave 1.2 | **Unimplementable today.** No spans, no byte offsets, `line_end` declared but never written. See §2.3. |
| "Pillar 5 worktree isolation, Wave 1 complete" | IMPL status | **Not implemented.** `runAll` (`sessionManager.ts:519`) is strictly sequential; `nextReadyTask()` returns one task. Worktree machinery exists but only inside `reproGenerator.ts`. |
| "`buildEvidence` is exported" | implied by IMPL Wave 2 | **Not exported** (`sessionManager.ts:43`). Wave 2 must export it first. |

And two places where the planning documents are right and the *brief* is wrong:

| Claim | Verdict |
|---|---|
| Brief: "`deriveStatus` … never from `ir.status`" | Contradicted by `:82`/`:85`. Resolved as the asymmetry rule, §1.3. The code is right. |
| Brief: "run `npm run bench:smoke` before and after each wave" | No such script until Wave 0.1 ships. §0. |
