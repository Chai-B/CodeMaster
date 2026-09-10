# CodeMaster — how it works, and why

This file describes the tool as it exists in `src/`. Every claim here is
traceable to a file; where a number appears it is a constant in the source, not
an estimate. `SPEC.md` is the *design* document and describes things that were
designed and not built — this file describes only what runs.

Version 1.0.0. TypeScript (ESM, strict), Node ≥ 22.5.0, run through `tsx`.
Test gate: `npm test` → 229 tests, 228 pass, 0 fail, 1 skip.

---

## 0. The one idea

A coding agent that talks to a model spends most of its tokens re-establishing
things it already knew: which files matter, what the repo looks like, what was
decided last time, what already failed. Each of those is a question with a
deterministic answer — `git` knows the co-change history, a parser knows the
call graph, a database knows what was decided.

So CodeMaster is a **deterministic pipeline that calls a model only at the steps
where a model is genuinely required**. Every step is a *worker*, and every
worker declares `requires_llm`:

| Deterministic (never call a model) | LLM-backed |
|---|---|
| IntentParser, StaticIndexer, FileSelector, WikiReader, ContextCompiler, OutputParser, PatchApplier, Ripgrep, Embedding | Planner, TaskExecutor, Verifier, ModuleSummarizer, MemoryCompressor, ConflictResolver, repro/characterization generator |

`src/workers/base.ts` holds the contract, `src/workers/descriptors.ts` makes the
deterministic ones visible to `/workers` so the split is inspectable.

The consequence that drives most design decisions in this repo: **the lever on
cost is the number of calls, not the size of each one.** A vendor CLI call has a
floor of tens of thousands of tokens regardless of what you send it, so
shrinking a prompt by 30% buys almost nothing while skipping a call buys
everything. That is why the planner will skip itself, why the prompt cache
exists, why a "verify" task is refused at plan time, and why the verification
layer is deterministic — a model asked to check its own work is a whole extra
call that returns "pass" for code that was never executed.

---

## 1. Entry points

`bin/codemaster.js` is the launcher. It resolves the bundled `tsx` CLI from
`node_modules` rather than shelling to `npx`, so a global install works with no
network. `--version`/`-v` are answered by reading `package.json` directly,
without paying tsx and Ink startup.

`src/index.tsx` dispatches on `argv[2]`; anything unrecognised falls through to
the TUI. `src/commands/headless.ts` owns the non-interactive shapes.

| Command | Shape | What it does |
|---|---|---|
| `codemaster` | Ink TUI | Interactive session, full command surface |
| `codemaster run [objective]` | one-shot | Plan → execute all tasks → exit. `--json` emits a machine-readable result |
| `codemaster ask [question]` | one-shot, read-only | Answers about the repo. Creates no session, no task, no checkpoint |
| `codemaster mcp [--repo <path>]` | stdio server | Exposes context/reasoning to any MCP client |
| `codemaster proxy [--port <n>]` | HTTP on 127.0.0.1 | OpenAI-compatible `/v1/chat/completions` with context and failover |

Shared flags for `run`/`ask`: `--repo`, `--model`, `--json`, `--verbose`. The
objective may be piped on stdin instead of passed as an argument.

**Exit codes:** `0` ok · `1` task failure · `2` usage error · `3` no provider
credentials. They are distinct because a CI job needs to tell "the agent tried
and the work failed" from "the agent never ran".

---

## 2. Where state lives

`src/config.ts` owns all paths. `DATA_DIR` defaults to
`~/.config/codemaster/` and is overridable with `CODEMASTER_DATA_DIR` (read per
call, not captured at import, so tests can redirect it).

```
~/.config/codemaster/
  config.json            settings, model price table, role routing
  cli-accounts.json      per-vendor account NAMES only, mode 0600, no secrets
  credentials/           encrypted secrets when no system keychain
  quota.db               provider quota + health ledger (survives restarts)
  plugins/               user plugins
  repos/<slug>/
    state.db             PRIMARY database for this repo
    sessions/<id>/       checkpoints, plans, patches
    repro/               generated failing tests   (never inside the user repo)
    characterization/    generated passing tests   (never inside the user repo)
<repo>/.codemaster/
  index.db               REPO INDEX — disposable, self-gitignoring
```

`repoSlug()` = directory basename + first 8 chars of a sha1 of the absolute
path, so two checkouts of the same project do not share state.

### Two databases, on purpose

`src/storage/db.ts` keeps two families apart:

* **PRIMARY** (`state.db`, outside the repo): things that cost something to
  produce and would be painful to lose — `sessions`, `tasks`, `reasoning`,
  `failures`, `long_term_memory`, `token_usage`, `provider_accounts`,
  `checkpoints`, `wiki_entries`, `audit_log`, `undo_journal`, `prompt_cache`,
  `text_cache`, `cache_stat`.
* **REPO INDEX** (`<repo>/.codemaster/index.db`, inside the repo, gitignored by
  a file it writes itself): everything re-derivable from the source in seconds —
  `file_index`, `symbols`, `symbol_references`, `dependency_edges`,
  `file_utility`, `component_utility`, `tier_outcomes`, `module_index`, `calls`,
  `embeddings`, `coverage`, `rkg_nodes`, `rkg_edges`, `repo_meta`.

`REPO_INDEX_VERSION = 2`. On a mismatch the 10 disposable tables are dropped and
rebuilt rather than migrated, because a migration for data you can regenerate in
seconds is pure maintenance cost. The primary database is never dropped.

Both use `node:sqlite`'s `DatabaseSync` — no native dependency, no build step.

`repriceLegacyCost` (marker `repriced_v1`) fixes historical `token_usage` rows
that overstated cost by up to 1.76× because cache reads were priced as fresh
input.

### Configuration, the parts that matter

* `providers.default` — the model ordinary work runs on.
* `providers.pinned` — when set, *nothing* moves off it: not role routing, not
  tier escalation, not failover. A pin is a promise.
* `providers.roles` — per-role overrides, either `"model-id"` or
  `{ model, effort }`.
* `daemon.port: 7432`; the proxy defaults to `7433`.
* `checkpointing` — every 10 minutes, max 20 kept, pre-risky at 10 files.
* `token_budget.session_default: 500_000`, warn at 80%,
  `hard_limit_behavior: 'pause'`.
* `security.credential_backend: 'system_keychain'`.
* The model price table (`cost_per_1m_input` / `_output`, context size,
  cache multipliers) — this is the only capability signal the router has, and
  several routing decisions are literally "sort by output price".

---

## 3. The session, end to end

This is the spine. `src/daemon/sessionManager.ts` orchestrates it.

```
objective
  → IntentParser        deterministic: type, file scope, constraints, keywords
  → StaticIndexer       deterministic: index the repo if stale
  → Planner             LLM — unless the objective is a single unit
  → per task:
      FileSelector      deterministic: which files, and why
      WikiReader        deterministic: which prior knowledge
      ContextCompiler   deterministic: assemble, enforce a budget
      ┌─ repro + characterization generation (LLM, in parallel, not awaited)
      └─ TaskExecutor   LLM — the actual solve
      OutputParser      deterministic: text → IR
      PatchApplier      deterministic: IR → disk, under a write policy
      behavioralVerify  deterministic: run the tests
      Verifier          LLM — advisory only, and only when the above is unsure
      irProcessor       deterministic: IR → reasoning, wiki, follow-ups
      Checkpointer      deterministic
  → complete()          promote decisions to long-term memory, summarise
```

`src/workers/scheduler.ts` holds this as an explicit DAG (`TASK_PIPELINE`) with
`topoOrder()`, and `nextReadyTask()` picks the next task whose `dependencies`
have all completed, ordered by `order`.

### What "done" means — evidence, not the model's opinion

The single most important function here is `buildEvidence()`. It produces an
`OracleProvenance`:

| provenance | meaning |
|---|---|
| `pre-existing` | the repo's own tests covered this change |
| `repro-admitted` | a generated test *failed before* the change and passes now |
| `authored-by-task` | the only test involved was written by this task |
| `none` | nothing executed |

A task is `verified` only when the solver passed **and** provenance is
`pre-existing` or `repro-admitted`. A test file the task itself wrote can prove
a failure but never a success — otherwise "write a test that passes" is a
complete solution to every problem.

`deriveStatus()` then computes the task's status from *what happened*, not from
`ir.status` (which defaults to `completed` and is therefore worthless as a
signal). Every-patch-rejected, failing tests, and the `guard`/`use-sites`
frameworks each produce `failed` with a stated cause taken from the
deterministic gate, never from the model's own summary of its work.

### Things that only make sense once you know why

* **A failed task keeps its work on disk** and tells you `/undo to reverse`.
  Deleting the attempt throws away the only artifact anyone could learn from,
  and the user's stated rule is that the tool should keep building rather than
  accept failure and clean up.
* **Repro and characterization generation are launched as a non-awaited
  `Promise.all` alongside the solver.** Measured on the `config-precedence`
  benchmark task, that overlap covered 138 s of a 409 s run.
* **Repro generation is skipped entirely** when `relevantTests(locus)` shows the
  repo already covers the change — buying an oracle you already own is a wasted
  LLM call.
* **The LLM Verifier runs only when patches exist and evidence is not already
  conclusive**, retries once on `fail`, and is otherwise advisory. On the
  benchmark this path returned "pass" for mathematically wrong code that had
  never been executed; it is kept as a reviewer, not as an oracle.
* **`characterizationFor` runs at most once per session**, only when
  `detectFramework(repo) === 'unknown'`, and caches its result *including
  `null`* so a failure is not re-attempted per task.
* **`runAll` bounds itself** at `max(tasks.length * 2, 20)` iterations. A
  non-cancellation error in one task does not abandon the session; unrun tasks
  are marked `blocked` with a reason.
* **`complete()` always runs**, even after failures. It used to be reachable
  only when every task succeeded, which meant the sessions with the most to
  teach were the ones whose reasoning never reached long-term memory.
* **`gitChangedFiles`** uses `git status --porcelain --untracked-files=all`,
  because plain `git diff` cannot see created files — precisely the files most
  likely to be wrong.
* **`reapStaleSessions(24h)`** closes sessions abandoned by a crashed process.

---

## 4. The deterministic analysis layer

Everything in `src/analysis/`. Nothing here calls a model. `api.ts` is the
facade every other subsystem goes through (`staticAnalysis(repoPath)`).

### 4.1 Indexer and parsers — `indexer.ts`, `treesitter.ts`, `extractors.ts`

Walks the repo, respects ignore rules, and writes `file_index` + `symbols` +
`symbol_references`. Ten tree-sitter grammars are loaded lazily.

**Swift is deliberately regex-only.** Its bundled wasm hard-aborts the process
under web-tree-sitter 0.20.x — not an exception you can catch, a process abort.
A regex extractor that finds most declarations beats a parser that kills the
tool.

`extractors.ts` turns parse trees into symbol rows; `lsp.ts` uses a language
server when one is available.

### 4.2 Dependency graph — `depGraph.ts`

Import edges between files, plus:

* **PageRank**, damping 0.85, 20 iterations, with sink redistribution. Used as a
  *tie-break* in file selection: when two candidates score the same, the one
  more of the repo depends on is more likely to be the one that matters.
* **Tarjan SCC** for cycle detection (`/graph cycles`).
* `resolveImport` handles the TypeScript `./Foo.js` → `Foo.tsx` rule, without
  which a TS repo's entire import graph is empty.

### 4.3 Call graph — `callGraph.ts`

Caller/callee edges in `calls`. Feeds file selection (a function's callers and
callees are candidate context) and the use-site gate in verification.

### 4.4 Use sites — `useSites.ts`

`unvisitedUseSites(repo, changedFiles)` finds callables whose **signature
changed** but whose **callers were never opened**. This is a hard verification
gate, not a hint: changing a function's shape without looking at who calls it is
the standard way an agent produces code that compiles locally and breaks two
files away. `describeUseSiteGaps` renders it for the failure message.

### 4.5 Search — `ripgrep.ts`

`rg --json` when ripgrep exists, a pure-Node `nodeGrep` fallback when it does
not, 1 MB per-file cap. The fallback exists so the tool has no hard external
dependency.

### 4.6 Embeddings — `embeddings.ts`

`Xenova/all-MiniLM-L6-v2`, 384 dimensions, local, stored as blobs in
`embeddings`. Two granularities: whole-file (`indexFileEmbedding`,
`findSimilarFiles`) and per-symbol (`indexSymbolEmbeddings`, cap 2500 symbols,
restricted to `function|class|method|interface|type` and excluding a
tests/docs/examples/scripts path pattern). Optional — everything degrades to the
lexical signals if the model is unavailable.

### 4.7 Coverage — `coverage.ts`

Imports LCOV or Istanbul JSON if the repo has one. `getUncoveredFunctions`
backs `/graph untested`. Coverage tells file selection which files have an
existing safety net, which changes what a change to them costs.

### 4.8 Test runner — `testRunner.ts`

`detectFramework` recognises `pytest | jest | vitest | gotest | cargo |
unknown`. Detection is layered because a repo lies about itself constantly:
config files, then `scanForTestFiles`, then `dominantSourceExt`, then
`jsRunnerFrom(package.json)`. `frameworkForNewTest` answers the different
question "if I write a test here, what will run it". Default timeout 120 s,
`PYTHONDONTWRITEBYTECODE=1` so a run never litters `__pycache__` into the user's
tree.

### 4.9 Git — `git.ts`

Deterministic temporal and authorship context: `headCommit`, `branch`,
`changedFilesSince`, `diffSince`, `workingDiff`, `fullWorkingDiff(paths?)`,
`status`, `log`, `blame`, `coChangedFiles(file, n=20)`, `createCheckpointPatch`,
`diffBetween`, `stashList`, `branchStatus`.

Two details carry real weight:

* **`isRepoRoot`** compares `git rev-parse --show-toplevel` against
  `fs.realpathSync(dir)`. The naive `checkIsRepo()` answers "is this path *inside*
  a work tree", so running in a plain directory under `~` inherited the home
  repository — `--json` output once carried a 16 MB diff of the user's entire
  home directory this way. A private lazy `owns` getter gates **every** method;
  when the directory is not a repo root each returns its empty value rather than
  throwing.
* **`fullWorkingDiff`** enumerates untracked files (`ls-files --others
  --exclude-standard -z`) and diffs each against `/dev/null` with `--no-index`,
  then adds `diff HEAD`. Plain `git diff` misses untracked files, so a task whose
  entire output was new files produced an empty diff and the verifier reported
  that a file which exists had never been created. `maxBuffer` 32 MB. The
  optional `paths` argument scopes the diff to one task's own output.

### 4.10 Repository map — `repoMap.ts`

`generateRepositoryMap(repo, depth=2)` → modules, their key files (`pickKeyFiles`
uses centrality and size), and a rendered form capped at `maxModules`. This is
the cheapest possible orientation: a model that has the map does not need to
list directories.

### 4.11 Watcher — `watcher.ts`

`chokidar` on the repo, ignoring `node_modules`, `.git`, `dist`, `build`,
`.codemaster`, `.next`, `__pycache__`, `target`, `.venv`, `venv`. Incremental
`indexFile` on change so the index does not go stale mid-session.

### 4.12 Staleness — the `derived_stale` flag

`reindex()` rebuilds file index, dependency graph, RKG and coverage.
`indexFile()` refreshes only the first two, because rebuilding the RKG per file
would be ruinous — `indexFile` fires repeatedly during one task. So `indexFile`
sets `repo_meta['derived_stale']`, `reindex()`/`rebuildRKG()` clear it, and
`api.derivedStale()` carries the flag out to callers. `compileContext` checks it
and rebuilds once, at the point where the answer is actually needed.

### 4.13 Reference lookup honesty

`findReferencesResolved` returns `{ files, method: 'lsp' | 'ripgrep' }`. Without
the `method` field, text matches on a same-named symbol are indistinguishable
from resolved ones, and the file selector was treating guesses as facts. It now
keeps a cap of 12 for `lsp` results and a tighter one for `ripgrep`.

---

## 5. The Repository Knowledge Graph — `src/rkg/`

A typed graph over the repo, in `rkg_nodes` / `rkg_edges`.

* **Node types:** `file`, `module`, `function`, `class`, `concept`, `decision`,
  `convention`.
* **Edges** connect code to code (imports, calls, tests) and code to *knowledge*
  (a decision that governs a file, a convention a module follows).

`populateRKG` builds it from the index; `classifyRole` assigns a file a role,
`guessTestTarget` links a test to what it tests, `resolveRel` resolves relative
imports against the known file set. `setFileSemantics` writes an LLM-produced
purpose/responsibilities/role onto a file — the one place a model's output
enters the graph, and it comes from ModuleSummarizer.

`RKGQuery.relevantSubgraph(paths)` is what the compiler uses: given the files
selected for a task, return the neighbourhood — what they import, what tests
them, which decisions govern them. This is why "relevant files" in the compiled
context arrive **annotated** rather than as bare paths.

**Why a graph rather than more tables:** the questions are all traversals
("what would this change break", "what decision covers this file"), and a
traversal over rows with a `type` column is the whole implementation.

---

## 6. Building the prompt

### 6.1 IntentParser — `src/workers/intentParser.ts` (deterministic)

Objective → `ParsedObjective`. `TYPE_SIGNALS` is checked in a fixed order —
debug, test, refactor, review, verify, implement — because "fix the failing test"
is a debug task, not a test task, and the first match must be the more specific
one. Also extracts explicit file scope, constraint clauses
(`must|should not|don't|without|only|never|always|keep|avoid`), and keywords.

Costs nothing, runs first, and its output steers the budget profile, the model
tier, and the write policy.

### 6.2 Planner — `src/workers/planner.ts` (LLM, sometimes skipped)

**`isSingleUnit(objective)`**: `length <= 120 && !ENUMERATED.test(t)`, where
`ENUMERATED` is `/\b(and|then|also|plus|afterwards|followed by|as well as)\b|[;,]|\n\s*[-*\d]/i`.
When it matches, the planning call is skipped and the objective becomes the task.
Measured: planning "create a tic tac toe game" cost 70.5k tokens to produce a
plan whose only content was the objective restated.

**`isSelfVerificationTask`** drops any planned task whose title starts with
`verify|confirm|validate|check|ensure|measure|assert`. The orchestrator already
runs verification deterministically after every task; a planned "Verify X" task
is a paid LLM call to do something free that already happened. Measured: one plan
was three tasks, all "Verify …", and all three failed. If a plan consists
entirely of them, the objective itself is used instead. `PLAN_INSTRUCTIONS`
forbids them at the source and caps titles at 80 characters.

`toTasks` resolves `depends_on` by title, defaults to a sequential chain when
none is given, populates the reverse `blocking` edges, and sets `input_files`
from `namedFiles()` — the *locus*, which the write policy, the verification
confidence gate and the repro coverage check all read.

### 6.3 FileSelector — `src/context/fileSelector.ts` (deterministic)

The heart of context quality. Never calls a model. Nine signals accumulate:

| # | Signal | Score |
|---|---|---|
| 1 | Direct mention in the objective | 1.0 |
| 2 | Dependency expansion | deps 0.8; dependents 0.6 (refactor/review only) |
| 3a | Identifier resolution | PascalCase 0.8, other 0.6, fuzzy 0.6/0.45, basename 0.75/0.5 |
| 3a′ | Symbol-term stem matching | ≥2 distinct stems → 0.35 + 0.18·hits, cap 0.9 |
| 3b | File embedding similarity | scaled |
| 3c | Per-symbol embedding | scaled |
| 4 | Git co-change history | scaled |
| 5 | Call graph | callers 0.5, callees 0.6 |
| 6 | Test coverage expansion | 0.7 |
| 6b | PageRank tie-break | 0.12 × normalised |
| 8 | Multi-file neighbour expansion | 0.45 + 0.04·n, cap 0.72 |

`bump()` is
`min(0.98, max(prev, s) + (has ? s*0.35 : 0))` — signals **accumulate** rather
than taking a maximum, so a file that is weakly implicated five different ways
outranks one implicated once. The 0.98 cap keeps accumulation from ever
outranking a direct mention. **Every bump records a reason**, which is what
`/why <file>` prints.

Final score = raw × `relevanceWeight(path, taskType)` × `Learning.utility(repo, path)`.

`relevanceWeight` is the blunt instrument that stops the selector drowning in
noise: docs/examples/scripts/site/.github/node_modules/dist/build → 0.15; tests →
1.0 for a test task, 0.35 otherwise; md/rst/txt/css/html/json/yaml → 0.2; plain
`.js`/`.jsx` → 0.25; everything else 1.0.

**Compression**: `symbolSlice(rel, content, keywords)` keeps whole symbol bodies
whose span mentions a task keyword, falling back to `signaturesOnly`. Half a
function is worse than no function, so slices are never cut mid-body.

**Selection continues past an over-budget file** rather than stopping, so one
large file cannot starve every smaller high-value file behind it.

`namedFiles(repo, text)` — exported separately — returns file paths mentioned in
prose *that actually exist*. The planner writes these into `task.input_files`.

### 6.4 Budget — `src/context/budget.ts`

Six named profiles (`planning`, `implementation`, `debugging`, `refactoring`,
`testing`, `review`), each a set of fractional shares over the nine context
components. Implementation, for example: OBJECTIVE .02, CURRENT_TASK .05,
ARCHITECTURE .08, REPOSITORY_MAP .10, RELEVANT_FILES .45, RECENT_CHANGES .10,
PRIOR_REASONING .08, CONVENTIONS .08, CONSTRAINTS .04.

```ts
const LADDER = [24_000, 64_000, 160_000];
```

Escalation rungs. The previous code multiplied shares by the model's
`max_context_tokens`, so **every task filled ~176k regardless of how small it
was** — a one-line fix bought a 176k prompt. A task starts on rung 0 and only
climbs when it fails.

`resolveBudget` reserves 12% (`usable = floor(budget * 0.88)`) for instructions,
format and system prompt. Learned component weights multiply each share and are
then renormalised to the profile's original total, so shrinking one component
*feeds the others* instead of shrinking the prompt.

### 6.5 Output contracts — `src/context/outputFormat.ts`

Four formats, because four kinds of provider answer differently and pretending
otherwise means a parser that fails on three of them:

* **`OUTPUT_FORMAT`** — XML `<task_result>`: status, summary, `<files>`
  (**complete final content**, never a diff), `<reasoning>` (decision / risk /
  observation / assumption), `<wiki_updates>`, `<open_questions>`,
  `<next_tasks>` with `depends_on` so a plan can branch rather than being forced
  into a chain.
* **`PROSE_OUTPUT_FORMAT`** + `PROSE_SYSTEM_PROMPT` — the `/ask` contract.
  Markdown, cite `path:line`, no XML, no patches.
* **`JSON_OUTPUT_FORMAT`** — native JSON mode for OpenAI and Gemini, parsed by
  `irFromJson`.
* **`DIFF_OUTPUT_FORMAT`** — unified diffs for Codex, plus an optional trailing
  `<<<REASONING>>>` JSON block so a Codex session still contributes to the
  reasoning layer instead of being a black box.

`REASONING_MARKER = '<<<REASONING>>>'` is deliberately not a bare `---`, which is
legal inside a diff of any file with YAML front matter.

`SYSTEM_PROMPT` opens: *"You are the execution engine of CodeMaster… This context
is assembled from structured state — not conversation history."*

### 6.6 ContextCompiler — `src/context/compiler.ts` (deterministic)

`compileContext(session, task, opts)`. Never calls a model, never reads
conversation history.

Component order (`ORDER`) is fixed: CONVENTIONS, ARCHITECTURE, REPOSITORY_MAP,
WIKI_SECTIONS, CONSTRAINTS, OBJECTIVE, EXECUTION_PLAN, SESSION_STATE,
PRIOR_REASONING, KNOWN_FAILURES, PROVIDER_HANDOFF, OPEN_QUESTIONS,
RELEVANT_FILES, CURRENT_TASK, RECENT_CHANGES, INSTRUCTIONS. **Stable content
first** so a vendor's prefix cache can actually match across calls in a session.

What goes in: objective; current task as YAML; execution plan; session-so-far; a
one-shot provider handoff from `session.metadata.pending_handoff`; wiki sections
(`readRelevantSections(task.type, keywords, 8)`); architecture plus promoted
decisions; the repository map (12 modules); prior reasoning
(`mergeById(Reasoning.relevant(kws,12), Reasoning.byAffectedFiles(paths,8))`,
where the top three carry `detail` sliced to 400 chars); known failures;
conventions (`readConventions(6)`); the selected files **annotated from the RKG
subgraph**; instructions.

**`enforceBudget(components, ceiling)`** runs in two stages — compress, then drop
— along `REDUCE_ORDER`. The ordering principle: things re-derivable from disk or
git for free are sacrificed first; **known failures and prior reasoning go last,
because each of those cost an LLM call to buy.** Per-component compression:
files → declaration and signature lines; reasoning/failures → first 6 bullets;
wiki/architecture → headings plus first sentence; default → halve.

Ceiling is `budget - 8192 - overhead`, where overhead is the measured token
count of the output format plus the system prompt.

`opts.prose` swaps in the prose format and system prompt and sets
`free_form: true`, which every provider adapter checks before appending any
patch-format override. That flag is why `/ask` never emits a diff.

---

## 7. Execution

### 7.1 `callLlm` — `src/workers/llm.ts`

Every LLM call in the tool goes through here. `LlmCallOptions` **requires**
`role` — optional would let a call site silently keep the global model, which
is exactly the bug the role table exists to prevent. Optional: `effort`,
`model`, `tier`, `conversation` (`{id, turn, provider_id, delta}`),
`onConversation`.

It builds a synthetic `CompiledPrompt`, consults the text cache for cacheable
(conversation-free) calls, and then goes through `manager.invokeWithFailover` —
never straight at one account, because a single rate-limited account used to
make every worker call throw. Usage is recorded via `Tokens.record`, and the
result is cached **keyed on the model that actually answered**, not the one
routing asked for.

Recorded in the source as the reason this exists: three repro attempts on the
`config-precedence` benchmark cost 108,096 tokens, two of which re-sent a code
surface the vendor already held.

### 7.2 TaskExecutor — `src/workers/taskExecutor.ts`

`executeTask(session, task, manager, cfg, tier=0, conversation?, model?)`.

**Model resolution happens in exactly one place**, in this order:

```
requested = model ?? session.current_provider?.model_id
jobTier   = tierFor({ role:'solve', taskType, files, contextTokens, contextTier: tier })
primary   = manager.select(manager.modelFor('solve', requested, jobTier), …)
```

Before this was centralised, `/model` changed the prompt-cache key and nothing
else — the call still went to the configured default.

**Prompt cache**: `cacheKey = promptHash(compiled.body, primary.model)`. A hit
reuses the stored IR at zero tokens and still runs `processIR`, so a cached
answer still produces reasoning, patches and follow-ups. `PromptCache.put` only
when `ir.status !== 'failed'` — caching a failure means paying for it forever.

**Vendor switch mid-task**: `invokeWithFailover` is given an `onVendorSwitch`
callback that compiles a handoff package, validates it, stores it as
`session.metadata.pending_handoff` and recompiles the context. The new vendor
gets the reasoning, not a cold start.

**Parse failure**: one retry with a format reminder, and the retry's real cost is
recorded rather than hidden — measured, one such retry was 74,602 tokens.

**`attachThinking`** persists the model's own reasoning blocks as `type:
'thinking'` reasoning objects. Reasoning tokens are billed as output whether or
not anyone reads them, so throwing them away is paying for something and then
discarding it.

**Two measurement functions** feed the learning loop and `/waste`:
* `unreferencedTokens(compiled, text, repoPath)` — a file counts as *referenced*
  when its path or basename appears in the model's own output. This is the W3
  waste measurement, and it also feeds `Learning.recordSelection`.
* `componentUse(compiled, text)` — a context component is credited only through
  terms **unique** to it. A component with nothing unique produces no
  observation at all: silence is not a verdict.

### 7.3 Solver — `src/workers/solver.ts`

`solveWithVerification(session, task, manager, cfg, verify, maxIters=3, exec)`.

`VerifyResult { ok, output, confident?, actionable? }`. **`actionable: false`
means the rejection is about our own tooling** — an unreadable file, a missing
runner — so iterating would buy a byte-identical answer at full price. The work
stays on disk and the task reports unverified rather than burning two more
attempts.

* Starts at `Learning.startTier(repo, task.type)`, not always tier 0 — the repo
  teaches which tier its work actually needs.
* **One vendor-side `Conversation` for the whole task**, so a retry sends only
  the correction (`conversation.delta`), not the whole prompt again.
* Every failed iteration writes a `Failures` row (approach attempted, why it
  failed, affected files, confidence 0.6) — which is how "known failures"
  reaches the next task's context.
* On a *repeated identical* failure it escalates once via
  `manager.strongerThan(from)` into a **fresh conversation id** (the CLI
  `--resume` path carries no `--model` flag, so a resumed conversation cannot
  change model) and holds the result in a local `escalatedTo`, never in
  `cfg.providers.default`, which is a shared object. If it has already escalated
  or the model is pinned, it stops rather than repeating.
* The failure is fed back into both `task.description` and `conversation.delta`
  with an explicit instruction to produce a **minimal** unified-diff patch and
  not to reorganise imports, rename symbols or rewrite unrelated code.
* **`recordLesson`** writes a `playbook/<type>-<file>` wiki entry when a fix took
  more than one attempt — derived entirely from recorded outcomes. No model is
  ever asked to reflect on its own performance.

### 7.4 OutputParser — `src/workers/outputParser.ts` (deterministic)

XML → IR. Never calls a model. `tagBlocks` / `tagBlocksWithAttrs`, `<patch>` and
`<file path=…>` extraction with XML unescaping, `ParseError` on unreadable
output. Two fixes worth knowing:

* `touched` FileRefs are attached to **every** reasoning object, so
  `Reasoning.byAffectedFiles` can retrieve by locus. This was hardcoded empty,
  which made decisions findable only by keyword.
* `depends_on` is split on commas. Previously every XML plan collapsed into a
  strictly linear chain.

`avgConfidence` defaults to 0.7.

### 7.5 PatchApplier — `src/workers/patchApplier.ts` (deterministic)

`resolveInRepo` rejects any path escaping the repository. Then a
`WritePolicy { locus?, isTestTask? }`:

* **`GUARDED` basenames** — `conftest.py`, `pytest.ini`, `tox.ini`, `setup.cfg`,
  `pyproject.toml`, `tsconfig.json`, `package.json`, jest/vitest configs,
  `Cargo.toml`, `go.mod` … — may not be overwritten unless the task explicitly
  named them. An agent that "fixes" a failing test suite by editing its config
  has not fixed anything.
* **An existing test file may not be overwritten unless this is a test task.**
  The task may not rewrite the oracle that judges it.
* **Nothing may be written inside `.git`.**

`git apply` is attempted with progressively looser flags: `--whitespace=nowarn`,
then `--3way`, then `--unidiff-zero`, then `--reject`. `ApplyResult` carries an
`undo` array of `{path, before|null}`, which is what powers `/undo`.

### 7.6 irProcessor — `src/workers/irProcessor.ts`

The IR → persistent-state compression pipeline. This is where one task's output
becomes durable knowledge.

* **Reasoning**: decisions + observations + risks + assumptions + thinking.
  `scoreImportance` = `confidence × 0.6` (+0.3 decision, +0.25 risk, +0.1
  permanent, capped at 1). Dedupe via Jaccard > 0.85 on summaries — a duplicate
  increments the existing row's reference count and emits `reasoning.merged`,
  so repetition raises confidence instead of bloating the store.
* **Pre-risky checkpoint** when `diffLines > 200 || touched >= threshold ||
  files_deleted.length > 0`.
* **Patches** are applied with the write policy above, locus from
  `task.input_files`.
* **Wiki conflicts** are resolved inline by a dedicated `ConflictResolverWorker`
  (merge role, ≤600 output tokens). Only if there is no manager, or it fails, is
  a task queued. Measured: 76,709 tokens on one `notes/` conflict — and an
  earlier version looped forever, because the synthesised merge conflicted again.
* **Follow-up `next_tasks`** are queued, capped, and self-verification titles are
  refused here too.
* **`ir.raw_output` is cleared.** It used to be AES-encrypted to disk and read by
  nobody.

---

## 8. Verification

### 8.1 The deterministic gate — `src/workers/verify/behavioralVerify.ts`

`makeBehavioralVerify(repoPath, getChangedFiles, opts, repro?, locus, characterization?)`
returns the function the solver calls. The orchestrator runs it; no model is
involved. The chain, in order:

1. **Crash guard** — `typeOrImportCheck`. A failure caused by an unreadable file
   is reported as `actionable: false` rather than as a guard rejection, and an
   invented import produces an explicit hint.
2. **The admitted repro must now pass.**
3. **The characterization must still pass.** The source says: *"Do not weaken or
   delete this check."* It is the only thing standing between "made the new test
   pass" and "broke everything else".
4. **Locus coverage** flag — did the change actually touch the files the task was
   about.
5. **`unvisitedUseSites` hard gate** — a changed signature whose callers were
   never opened fails.
6. Then the repo's own `relevantTests`, plus any test files this run authored.

**Self-authored tests can prove failure but never success.** No relevant tests at
all → `{ ok: true, confident: !!repro && !missedLocus }`. Runner unavailable or
timed out → `ok: true, confident: false`. Note the asymmetry: absence of evidence
never fails a task, but it never marks one verified either.

### 8.2 Oracle generation — `src/workers/verify/reproGenerator.ts`

`generateRepro` and `generateCharacterization` (plus `snapshotTree`,
`isGenuineFailure`, `failedNodeIds`, `importSurface`).

* **A repro is admitted only if it FAILS on the current code.** A "reproduction"
  that passes before the fix reproduces nothing.
* **A characterization is admitted only if it PASSES on the current code.** It
  records what already works so a change cannot silently break it.
* Admission runs against a **throwaway `git worktree add --detach`** of `git
  stash create` (or HEAD), so it is isolated from the solver writing to the tree
  at the same moment.
* pytest exit code 1 = assertion failure (admit); exit 2 = collection or syntax
  error (reject) — a test that cannot even be collected is not evidence.
* Generated tests live **outside the repo**, under
  `repoDataDir(repo)/repro|characterization`, so they never appear in the user's
  `git status`.

### 8.3 The LLM verifier — `src/workers/verifier.ts`

Runs only when patches exist and deterministic evidence was inconclusive.

`VerifyInput.files` scopes `getWorkingDiff` to what *this task* wrote — without
it, an unrelated edit sitting in the working tree decides whether this task is
judged correct. The diff is capped at 12,000 chars; the call uses `role: 'review'`
and `maxTokens: 1024`.

The system prompt states that deterministic test results are **authoritative
over** the model's reading of the diff.

`parseVerification` is a pure exported function (so it is testable without a
provider). An unreadable verdict returns **`partial`**, not `pass` and not
`fail`. It used to default to `pass` — twice over — so malformed output was
recorded as a clean bill of health, which is the one direction the mistake must
not go. `partial` rather than `fail` because `fail` re-executes the entire task
for self-correction, and paying for a full retry over a parse error is the wrong
trade.

---

## 9. Memory

### 9.1 What is stored — `src/storage/`

| Store | Holds | Read by |
|---|---|---|
| `Sessions`, `Tasks` | session and task rows, metadata, status | orchestrator, `/session`, `/tasks` |
| `Reasoning` | decisions, risks, observations, assumptions, thinking — each with importance, keywords and affected files | compiler, `/reasoning`, `/replay` |
| `Failures` | approach attempted, why it failed, affected files | compiler (KNOWN_FAILURES), solver |
| `LongTerm` | namespaced durable memory (`architecture`, …) | compiler, `/memory` |
| `Wiki` | repository knowledge, versioned, front-mattered | compiler, `/wiki` |
| `Tokens` | every call: model, role, in/out/cache tokens, cost, latency | `/tokens`, `/stats`, `/cost`, `/waste` |
| `PromptCache`, text cache, `cache_stat` | reuse of identical prompts | `callLlm`, `executeTask`, `/stats` |
| `Undo` | per-application `{path, before}` journal | `/undo` |
| `Checkpoints` | manifests | `/checkpoints` |

### 9.2 Retrieval, not recall

Reasoning is retrieved two ways and merged: `Reasoning.relevant(keywords, 12)`
and `Reasoning.byAffectedFiles(paths, 8)`. Keyword retrieval finds "we decided to
use X"; locus retrieval finds "something was decided about *this file*". A tool
that only had the first could not answer "why is this file like this".

### 9.3 Lifecycle — `src/memory/lifecycle.ts`

`recencyDecay(createdAt)` and `effectiveImportance(m)` — a decision from three
months ago about code that has since been rewritten should not outrank a
decision from this morning. `findCompressionCandidates(threshold, ageDays)`
selects rows for compression; `applyDecay()` applies the decay pass.

`MemoryCompressor` (LLM, `summarize` role) rewrites a memory to ≤200 tokens and
**halves its importance**:
`UPDATE reasoning SET detail=?, importance=importance*0.5 WHERE id=?`. Something
worth keeping in summary is, by construction, worth less than something worth
keeping in full.

### 9.4 Promotion and summary

`complete()` promotes every decision with `importance >= 0.7` into `LongTerm`
namespace `architecture`. `buildSessionSummary` / `persistSessionSummary`
(`src/memory/sessionSummary.ts`) record what the session did.
`replayReasoning(keywords, limit=20)` / `renderReplay` back `/replay`.

### 9.5 The wiki — `src/wiki/`

Human-readable markdown with YAML front matter, versioned on write, mirrored
into `wiki_entries`.

* **`bootstrap.ts`** — first-run population. Thresholds exist so a trivial repo
  does not trigger a pile of LLM calls: `MIN_FILES_FOR_MODULE = 2`,
  `MIN_SOURCE_FOR_MODULE_SUMMARY = 12_000`, `MIN_SOURCE_FOR_CONVENTIONS = 1500`.
  It ingests `README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md` if present, and
  records its own state under `meta/bootstrap` so it runs once.
* **`reader.ts`** — `readRelevantSections(taskType, keywords, limit)`,
  `readConventions(limit=6)`, `readArchitecture()`. Deterministic. This is the
  worker the compiler uses.
* **`updater.ts`** — `applyWikiUpdate` with `normalizeKey`, front-matter
  defaults, and conflict detection; `resolveWikiConflict` writes a resolved
  merge.
* **`markdown.ts`** — file paths, rendering, versioning, front-matter parsing.

**Why a wiki and not just the database:** the wiki is the layer a human can read
and correct. A decision the user disagrees with can be edited in place, and the
next session picks up the corrected version.

### 9.6 Learning — `src/learning/reflector.ts`

Three observations, all from outcomes that actually happened, with
`MIN_SAMPLES = 4` before any of them is trusted:

* **`recordSelection`** — for each file the compiler included, did the response
  actually mention it? Becomes `Learning.utility(repo, path)`, a multiplier on
  that file's selection score in this repo.
* **`recordComponents`** — for each context component, did the response draw on
  it? Becomes the learned weights that reshape the budget profile
  (`0.4 + 0.6 × referenced/included`, so a component is never zeroed out).
* **`tier_outcomes`** — which tier a task type actually finished on, and whether
  that finish carried real verification. Becomes `Learning.startTier`.

There are no priors. A file never included has no opinion attached to it; a task
type with too few samples starts wherever it always did.

---

## 10. Providers

`src/providers/manager.ts` (870 lines) is the largest single piece of policy in
the tool. Five adapters: `anthropic`, `openai`, `google`, `openai-codex`,
`opencode`.

### 10.1 Three orthogonal routing axes

This is the part most worth internalising, because "which model runs this" has
three independent answers that used to be one.

**Role — what the call is FOR.** `LLM_ROLES = ['solve','plan','oracle','review','summarize','merge']`.
Not the task's type: a single `implement` task makes a solve call, an oracle call
and a review call, and they do not need the same model. Roles with no configured
entry get a derived default — `DERIVED_CHEAP = {review, summarize, merge}` go to
the cheapest model **on the default's own vendor**; anything that has to reason
stays on the default.

**Tier — how much model this particular job is worth.** `tierFor(signals)` is
pure scoring:

```
mechanical roles                      → light
debug|refactor +2, implement|plan +1
files > 8  or tokens > 40k  → +2
files > 2  or tokens > 12k  → +1
contextTier > 0             → +2
score ≥ 3 → heavy · score ≤ 0 → (prose ? standard : light) · else standard
```

`standard` is literally `providers.default`; `light` and `heavy` are the cheapest
and strongest models **on that same vendor**. Staying on one vendor keeps the
conversation resumable and keeps a tier step from crossing into a vendor the
user has no key for.

**Effort — how long it thinks.** `LlmEffort = 'low' | 'medium' | 'high'` →
`THINKING_BUDGET = { low: 1024, medium: 4096, high: 12288 }`. Orthogonal to model
choice: opus at `low` and opus at `high` are the same weights at very different
prices, so a role can buy reasoning depth without buying a bigger model.
`DERIVED_EFFORT = { oracle: 'medium' }`; `heavy` tier implies `medium` when
nothing else says otherwise.

**A pin overrides all three.** `providers.pinned` is re-checked in `modelFor`
*and again* as the last thing between a routed call and the vendor, because a
pinned model is a promise that every call used it. Measured: a benchmark pinned
to haiku failed over to gpt-5-codex mid-run, and its numbers meant nothing.

### 10.2 Model selection details

* `modelFor(role?, requested?, tier?)` — pin, then explicit request, then the
  role table, then the global default. A model whose vendor has no credentials
  falls through rather than failing; if the default's own vendor has no key
  either, `cheapestCredentialed()` picks something that works, because the
  shipped default is what most people never edit.
* `defaultModel()` — `/account use` on a *different vendor* used to change
  nothing: routing resolved a model first, and account preference only chose
  between accounts already on that model's vendor. Selecting an account now
  moves the default onto its vendor, at `nearestOn(provider, default)` — the
  model closest **in price** to the configured one. `nearestOn` exists because
  taking the vendor's first listed model sent a haiku-routed summary to opus at
  fifteen times the price.
* `strongerThan(modelId)` — the **cheapest model that is still stronger**, among
  vendors that actually have credentials. One rung, not the top of the list: a
  stuck task should cost the smallest increment that might solve it. Output
  price is the only capability signal the config actually carries.
* `select(modelId, requiredTokens)` filters to the provider, to `available`
  accounts, and to context size, throws a *named* error when candidates exist but
  none resolve, and sorts by explicit preference then inverse latency. A stable
  sort once handed an unset env placeholder the win over a working stored key.

### 10.3 Accounts and credentials

Three kinds of credential coexist, and the point is that they coexist:

1. **Environment variables** — `ENV_REF` maps anthropic/openai/google/openai-codex
   to `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. opencode deliberately has none.
2. **Stored keys** — added with `/account add <provider> <alias> <key>`, held by
   `src/providers/credentials.ts`, referenced as `cred:<provider>::<alias>`.
3. **Vendor CLI sessions** — `src/providers/cliAuth.ts`, referenced as
   `cli:<provider>#<account>`. **CodeMaster stores no secret for these at all.**

`CredentialManager` (`credentials.ts`) has a three-tier backend: system keychain
first (`security` on macOS), then AES-256-GCM under a master key at
`credentials/.key`, then plaintext. An `.index` file lists ids so credentials can
be enumerated without decrypting them. **No other module handles a secret.**

`cliAuth.ts` is the interesting one. `--version` answers "installed", which is
not the question — a user with the binary and no session got a green provider
list, a clean startup banner, and a failure on the first call. Each vendor is
asked its own status question instead, once per process, with per-vendor parsers
(`parseClaudeStatus`, `parseCodexStatus`, `parseOpencodeStatus`).

**Multiple accounts per vendor are real accounts, not a swapped credential
file.** Every one of these CLIs reads its credential store from a directory named
by one environment variable, so *an account is a directory*: sign-in writes the
token there under the vendor's own protection, and every later call for that
account points the CLI back at it.

| Vendor | Binary | Login | Profile env |
|---|---|---|---|
| Claude Code | `claude` | `auth login` | `CLAUDE_CONFIG_DIR` |
| Codex | `codex` | `login` | `CODEX_HOME` |
| Gemini | `gemini` | *(no subcommand — bare run, choose "Sign in with Google")* | `HOME` |
| opencode | `opencode` | `auth login` | `XDG_DATA_HOME` |

Gemini hardcodes `homedir()/.gemini` with no variable of its own, so the home
directory is the only available lever — Node reads `$HOME` first.
`MAX_ACCOUNTS_PER_VENDOR = 5`; more than that is a filing system, not a set of
accounts. The `default` account is the machine-wide sign-in with **no override at
all**, so whatever the user already had keeps working untouched.

The registry at `~/.config/codemaster/cli-accounts.json` holds **names only**,
written with `mode: 0o600`.

The constructor assembles the account list from all three sources: one env
placeholder per vendor **named for its vendor** (they were all called `default`,
so `/account` listed four identical rows), plus stored credentials, plus one row
per named CLI account — skipping `DEFAULT_ACCOUNT` where an env placeholder
already exists. `resolves(a)` distinguishes a real credential from a placeholder;
`credentialSource(a)` prints which of the three it is, in the user's own words.
`/account use` is session-scoped and never written to config.

`anyProviderAvailable()` is free-standing because three call sites had
hand-rolled, disagreeing versions of the same check. It is true if any env key,
stored credential, or signed-in CLI exists.

### 10.4 Quota, health and failover

`src/providers/quotaLedger.ts` — persistent, in its own `quota.db`.

The previous model invented every number: a 50M "daily token limit" and a 50 rpm
cap identical for all four vendors, held in memory and rebuilt from zero on every
process start. **This ledger records only what was actually reported**: tokens
actually spent, rate limits the vendor actually returned, failures that actually
happened. Nothing is estimated, and exhaustion is never *inferred* from the
counters.

Window lengths, because subscriptions reset on rolling windows rather than
calendar days:

```
anthropic     5 h        openai        1 h
openai-codex  5 h        google       24 h        default 1 h
```

Per account (`<provider>::<alias>`) it holds window counters (tokens, requests,
input/output/cache-read/cache-write/**reasoning** split out so the price of
thinking is visible rather than buried, cost), lifetime counters that never
reset, `latency_ms_total`, `rate_limited_until` (set **only** from a vendor
report — Retry-After or a usage-limit reset), `consecutive_failures`,
`cooldown_until`, `last_error`.

Cooldown escalates: `[30 s, 2 min, 10 min]`. One transient error should cost
seconds; a genuinely broken provider should stop being retried.

`available(account)` reads the ledger, so a limit hit in one process is still
known in the next — previously every restart forgot it, and a single error
disabled an account for the whole process lifetime. `makeAccount` seeds an
account's quota **from the ledger**, so a half-spent window survives a restart.

**`failoverModelOrder(head)`** — the call's own model first, then one stand-in per
other credentialed vendor, then sorted so vendors that are usable *right now* go
first (a spent Claude window should not cost a failed call before Codex is
tried). Blocked vendors stay in the list; their own guard skips them. If nothing
is credentialed it still returns `head`, so the resulting error is honest.
A pin collapses the whole list to `[default]`.

`invokeWithFailover` walks that order with `invokeWithBackoff(fn, maxRetries=4)`,
and calls `onVendorSwitch` when it moves — which is what triggers the handoff.

### 10.5 Conversation continuation

`continuationRequest(full, conv, adapterSupports, providerId)` has exactly three
cases:

1. The adapter cannot resume → send the full prompt.
2. The adapter can, but this vendor has not seen this conversation → send the
   full prompt under that conversation id, `resume: false`.
3. The vendor holds it → send `{...full, user: conv.delta, conversation: {id, resume: true}}`.

Case 3 is why a solver retry costs a correction rather than a whole prompt.

### 10.6 Handoff — `src/workers/handoff.ts`

When the run moves vendor mid-task, the new vendor gets a `HandoffPackage`:
objective, completed and remaining tasks, current task state, architecture
snapshot, key decisions (≤20), key risks (≤8), known failures (≤8), working
files, recent changes, open questions, constraints.

`clipDiff(diff, budget=1200)` cuts on line boundaries and **states how much was
dropped**, so the receiving model knows it is looking at an excerpt.
`validateHandoffPackage` requires an objective, context, and a **continuity**
signal — a handoff that carries no continuity is a cold start wearing a costume.
It is delivered exactly once, via `session.metadata.pending_handoff`, and the
compiler places it in the PROVIDER_HANDOFF slot.

### 10.7 Cost

`costOfUsage(spec, usage)` prices fresh input, cache reads and cache writes
separately: `CACHE_READ_MULTIPLIER = 0.1`, `CACHE_WRITE_MULTIPLIER = 1.25`, with
`fresh` clamped at 0. Pricing every input token at the full rate is how the
historical rows came to overstate cost by up to 1.76×.

### 10.8 CLI invocation — `cliRun.ts`

`runCli` spawns a vendor CLI with a 15 s heartbeat and a 500 ms cancellation
poll, so a long CLI call is both visibly alive and interruptible.

---

## 11. Token accounting and waste — `src/analysis/tokenAnalytics.ts`

`/waste`, `/stats` and `/cost` are backed by this. Every figure comes from a
persisted row; **nothing here is a counterfactual about what some other tool
might have done.**

Named waste classes used throughout the source:

| Class | Meaning |
|---|---|
| W2 | An oversized budget — context bought and not needed |
| W3 | Tokens for files the response never referenced |
| W4 | Re-buying an answer already held |
| W5 | Self-verification tasks the orchestrator already runs deterministically |

`savingsReport()` returns rows plus what was *actually billed*, because savings
without spend is a meaningless number. Two row kinds, priced differently on
purpose:

1. **Reused answers** — served from the local store, never reached a provider, so
   the whole input price is avoided and the token count is real.
2. **The vendor's prefix cache** — those tokens *were* sent and *are* billed, at
   a tenth of the rate, so the saving is the nine tenths and the **token count is
   deliberately zero**.

It also reports `waste {tokens, ratio}`, context-window fill (`peak`, `peakModel`,
`peakSize`, `avgFill`), and quality (`tasks, completed, verified, failed,
retried`).

Measured baseline for this tool: the vendor CLI floor is ~37.3k tokens per call
against ~2.2k of our own context, and W3 waste came out at 0.015%. That is the
evidence behind "optimise call count, not prompt size".

---

## 12. Checkpoints, undo, recovery

**`Checkpointer`** (`src/workers/checkpointer.ts`) writes
`sessions/<session>/checkpoints/<ckpt>/` containing a manifest (repo commit,
token usage, task counts, reasoning count), the plan, and a repo patch.
`restoreCheckpoint` idempotently upserts the session and its tasks;
`verifyCheckpointState` compares HEAD and the working diff against the latest
checkpoint. Triggers: every 10 minutes, before a risky change (>200 diff lines,
≥10 touched files, or any deletion), on `/pause`, and at `complete()`.

**Undo** (`src/storage/undo.ts`) is a different mechanism for a different
question. A checkpoint restores a *point in time*; `/undo` reverses **the last
applied change**, using the `{path, before|null}` journal PatchApplier writes.
`before: null` means the file did not exist, so undo deletes it. `/undo list`
shows the journal.

**Recovery** (`src/daemon/recovery.ts`, `/recover`) finds sessions left
incomplete by a crash and offers them back. `reapStaleSessions` closes ones older
than 24 h.

**`/diff`** shows what *this session* changed on disk, which is not the same as
`git diff` when the working tree already had changes.

---

## 13. The command surface

`src/commands/catalog.ts` is the single source of truth — the TUI's autocomplete,
`/help`, and per-command `--help` all read it. `src/commands/router.ts` (1677
lines) implements them.

**Session** — `/ask <question>` (read-only, prose contract, no session created) ·
`/new <objective>` · `/resume [id]` · `/setup` (guided first run: credentials,
model, index) · `/recover` · `/pause` · `/complete` · `/session [info <id>]` ·
`/projects` (every repo CodeMaster holds state for)

**Planning** — `/plan` · `/tasks` · `/task <n|id>` · `/run` · `/runall` ·
`/skip <n|id>`

**Provider** — `/model [id]` · `/provider [use <id>]` · `/account` (`login`,
`logout`, `add`, `use`, `remove`) · `/handoff <model_id>`

**Memory** — `/memory [compress]` · `/wiki [key|bootstrap|update <key>]` ·
`/reasoning [search <q>]` · `/forget <query>`

**Repository** — `/reindex` · `/rebuild-map` ·
`/graph <file>|cycles|deadcode|rkg|untested`

**Checkpoint** — `/checkpoint` · `/checkpoints [restore <id>|diff <id>]` ·
`/undo [list]` · `/diff [full]`

**Diagnostic** — `/tokens [by-provider]` · `/context` (the compiled context, no
LLM call) · `/stats` · `/doctor` · `/health` · `/cost` · `/waste` · `/why <file>`
· `/learn` · `/workers` · `/profile <n|id>` · `/replay <id>` · `/verbose [on|off]`

**Misc** — `/config [set <key> <value>]` · `/plugins` · `/help [group|command]` ·
`/clear` · `/quit`

The diagnostic group is not decoration. `/why` prints the recorded bump reasons
for a file, `/learn` prints what the repo has taught the selector, `/waste`
prints tokens that bought nothing, `/context` shows exactly what would be sent
without sending it. Each answers a question you would otherwise answer by
guessing.

### Credential hygiene in the command layer

When `/account add` is given an inline key, **the secret must not survive the
call**: `src/index.tsx` detects it with
`/^\/account\s+add\s+\S+\s+\S+\s+\S/` and, for that one command, skips the input
history push and masks the transcript echo. The interactive form's key field is
`secret: true`, rendered as `•`, never echoed and never pushed into history.
Covered by `tests/unit/prompt.test.ts`.

---

## 14. The TUI — `src/index.tsx`, `src/components/`, `src/ui/`

Ink 5.2.1 + React 18. Components: `Header`, `MessageList` (transcript),
`Activity` (live worker/phase view, and `StatusBar`), `Prompt` (composer),
`Autocomplete`.

**The pinned frame.** The app runs on the alternate screen, entered with
`\x1b[?1049h\x1b[2J\x1b[H\x1b[?1002h\x1b[?1006h` and left with
`\x1b[?1006l\x1b[?1002l\x1b[?1049l`. The root `<Box>` is `width={cols}
height={rows}`, which makes each Ink frame exactly the terminal's rows in order —
frame line `i` is terminal row `i+1`. That property is what makes the next
feature possible, and a test pins it.

**Selection and copy — `src/ui/selection.ts`.** Claiming the mouse (`?1002h`,
button-event tracking: press, drag, release) is the only way the wheel reaches
the app, and the price is that the terminal's own click-drag selection stops
working. So selection is implemented here: track the drag, invert what it
covers, put the text on the system clipboard on release.

The text comes from **the frame Ink already wrote**, not from React state.
Reconstructing rows from the component tree would mean redoing the wrap and
column arithmetic `estimateRows` does and getting a different answer whenever
that estimate drifts. The frame is not an approximation of what is on screen; it
*is* what is on screen.

* `stdout.write` is wrapped: pass through, then `capture(chunk)`, then re-`paint`
  if a selection is active — Ink repaints on every spinner tick, so a one-shot
  overlay would blink out.
* `capture` accepts a payload as a frame only when its line count is within
  `[rows - 2, rows]`, which filters Ink's incidental writes. Two arrays are kept:
  raw (with ANSI, to repaint a row back to normal) and ANSI-stripped (for the
  copied text and for measuring columns).
* `paint` wraps everything in `\x1b7`…`\x1b8` (DECSC/DECRC), because Ink erases
  its previous frame by counting lines *up from the cursor* — moving the cursor
  and leaving it moved tears the next repaint. Selected rows are drawn plain then
  inverted, since reverse video over the frame's own colours reads as noise.
* `extract(lines, a, b)` is pure and tested: stream selection like a terminal
  (first row from anchor to end, whole middle rows, last row to the head), a
  backwards drag is mirrored, each line is right-trimmed.
* `span()` clamps the end column to the plain line's length, which is why short
  rows highlight only as far as their text.
* Clipboard: `pbcopy` on darwin; `wl-copy` then `xclip -selection clipboard` on
  linux; OSC 52 (`\x1b]52;c;<base64>\x07`) as a last resort.
* A selection is cleared by any keystroke, by scrolling, and by `esc` (checked
  before `esc`'s other meanings).

**Log rendering — `src/util/parser.ts`.** `eventToLog` turns a `CodeMasterEvent`
into a `LogEntry`; `phaseOf` tracks `Planning | Solving | Verifying`;
`logReducer` maintains `{settled, live, phase, phaseStart, phaseDone, clearGen,
verbose}`. `KEEP` is the set of log types that survive a phase transition
(`md`, `reasoning`, `heading`, `success`, `error`, `warn`, `sep`, `user`) — live
progress chatter is transient, conclusions are not.

**Cancellation — `src/util/cancel.ts`.** `beginCancellable()` returns an
`AbortSignal`, `cancelActive()` trips it, and workers call `throwIfCancelled()`.
A cancelled task throws `Cancelled` and is returned to `pending` rather than
recorded as a failure.

---

## 15. Integrations

### 15.1 MCP server — `src/mcp.ts`

Newline-delimited JSON-RPC 2.0 over stdio — the standard MCP stdio transport,
implemented directly so it adds no dependency. Server identifies as
`codemaster`.

Five tools:

| Tool | What it gives the caller |
|---|---|
| `compile_context` | The full deterministic context for an objective |
| `relevant_files` | Ranked files with reasons |
| `prior_reasoning` | Decisions and failures already recorded |
| `record_reasoning` | Write a decision back into the store |
| `repository_map` | Module structure |

The sessions and tasks it builds are **ephemeral** — nothing is persisted,
because an external agent asking for context should not create sessions in the
user's project.

This is the tool's whole claim, exposed to somebody else's agent: a coding agent
should be *handed* the context it needs instead of spending tokens rediscovering
it, and should not re-derive reasoning the repository already holds.

### 15.2 OpenAI-compatible proxy — `src/proxy.ts`

`node:http`, no dependency. `GET /v1/models` lists the configured models;
`POST /v1/chat/completions` takes the standard body. Anything that already speaks
chat-completions gets the two things CodeMaster adds: deterministic repository
context, and failover across every provider the user has, with the session's
reasoning carried across a vendor switch.

Extension field: `codemaster: { context?: boolean, task_type?: string, tier?: number }`.
`context: false` passes the prompt through untouched. Earlier turns in
`messages` are the caller's conversation, not the repository's state, so they are
passed through verbatim *below* the compiled context. Request bodies are capped
at 8 MB.

### 15.3 Plugins — `src/plugins/`

`PluginType = 'provider' | 'worker' | 'memory' | 'analyzer' | 'command' | 'storage'`.
Manifests are validated (`validateManifest`); `isCoreType` guards the types that
would shadow built-ins. `loadPlugins()` reads `DATA_DIR/plugins`;
`getCommandPlugin(cmd)` lets a plugin add a slash command and
`getAnalyzerPlugin(name)` lets one add analysis. Examples live in
`examples/plugins`.

### 15.4 Events — `src/events/`

A single `bus` with levels `error | warn | success | info | debug` and a typed
event union covering repository, session, task, memory, wiki, reasoning,
provider, checkpoint, quota, worker and log events. `runWorker` emits
`worker.started` / `worker.finished` around every worker. The TUI, the `--verbose`
stderr stream and the headless JSON output are all just different subscribers, so
there is exactly one description of what happened.

---

## 16. Tests

`npm test` runs `node --import tsx --test tests/unit/*.test.ts
tests/integration/*.test.ts tests/e2e/*.test.ts` → **229 tests, 228 pass, 0 fail,
1 skip**.

* **unit** (26 files) — `behavioralVerify`, `budget`, `cancel`, `claudeCli`,
  `cliAuth`, `cliRun`, `codexCli`, `commandSurface`, `continuation`,
  `credentials`, `gitDiff`, `learning`, `lifecycle`, `mcp`, `outputParser`,
  `patchApplier`, `prompt`, `properties`, `providers`, `quotaLedger`,
  `reasoningLocus`, `selection`, `solver`, `symbolSlice`, `tokenDiscipline`,
  `tuiLayout`, `verifier`
* **integration** — `analysis`, `fixtures`
* **e2e** — `commands`, `golden`, `session`
* **fixtures** — `legacy-codebase`, `medium-monorepo`, `react-tsx`,
  `small-python`, `tiny-ts`

**There is no module mocking**, because `mock.module` requires
`--experimental-test-module-mocks`. The consequence shapes the code: logic that
needs a test is extracted as a pure exported function instead —
`parseVerification`, `extract`, `tierFor`, `isSingleUnit`, `resolveBudget`,
`continuationRequest`, `parseClaudeStatus`. That constraint has been a net good;
the pure cores are the parts most worth testing anyway.

Some tests are **source-level** rather than behavioural, and deliberately so. The
one guarding `/ask` asserts that every provider file mentioning an
`OUTPUT_FORMAT` override also mentions `compiled.free_form`. Four independent
guards in four adapters is a rule the next adapter will forget, and a source-level
test is the only cheap way to hold it.

---

## 17. What is not here

Stated plainly, because a document that only describes what works is not
grounded.

* **`SPEC.md` describes more than exists.** It is the design document. Where it
  and this file disagree, the code agrees with this file.
* **Pillar 5, worktree isolation for sessions, is not implemented**, despite the
  plan document marking that wave complete. Repro *admission* uses a throwaway
  worktree (§8.2); the session itself does not run in one.
* **The GitHub Actions `Test` step is failing.** Locally the gate is green.
* **`~/.codemaster`** holds ~56 MB of a pre-v1.0.0 session database that was
  never migrated to `~/.config/codemaster`.
* **Provider reality on this machine:** `gemini` 0.57.0 is installed but not
  signed in; Antigravity has no CLI; opencode is signed in but every model it
  lists currently fails upstream.
* A handful of bench-era sessions and tasks from 2026-06-30 are still marked
  `in_progress`/`active` in this repo's own state database.
