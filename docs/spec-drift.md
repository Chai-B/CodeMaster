# Spec drift — `SPEC.md` vs. the build

`SPEC.md` is a pre-implementation design document. It predates the evidence
layer, the learning loop, the MCP server and the proxy. It is history, and it is
useful for exactly three things:

1. recovering intent the build dropped,
2. understanding why a mechanism exists,
3. knowing what was deliberately abandoned.

**This file exists so nobody re-litigates a decision that was already made.** If
you are about to "restore" something from `SPEC.md`, find its row first. If a
wave touches a subsystem with a row here, update the row in the same PR.

Verdicts: **improved** (build is better than the design) · **regressed** (design
was better, worth fixing) · **abandoned** (deliberately dead, do not restore) ·
**not yet built**.

---

## The table

| Spec § | What the spec designed | What the source actually does | Verdict |
|---|---|---|---|
| **§7.6** decay | `effective_importance = importance × confidence × (1 + log(1+refs)) × exp(-0.05·days)`; `permanent` bypasses | Implemented exactly. `memory/lifecycle.ts` — `recencyDecay`, `effectiveImportance`, `permanent → Infinity`. Adds a `detail.length > 400` floor so short entries are never compressed | **improved** (faithful + a sensible floor) |
| **§7.6** compression, steps 1–2 | Summarize via a light LLM call ≤200 tokens; the summary replaces the active entry | `workers/memoryCompressor.ts:20` (`<=200 tokens`), `:36` (`maxTokens: 300`), `:38` replaces `detail` | **improved** — routes through `callLlm` with `role: 'summarize'`, which `DERIVED_CHEAP` maps to the light tier |
| **§7.6** compression, step 3 | "The full object is archived to cold storage" | **Nothing archives.** `memoryCompressor.ts:38` is a bare in-place `UPDATE reasoning SET detail=?, importance=importance*0.5`. No archive path exists in `storage/reasoning.ts` either | **regressed** — the single most consequential regression in the build. A lossy-but-recoverable design became a destructive one. Wave 3.2 |
| **§7.6** conflict resolution | Contradiction creates a conflict record and a verification task; both entries shown flagged until resolved | `ConflictResolverWorker` is registered (`scheduler.ts:36-44`); `memory.conflict` and `wiki.conflict` events exist (`events/types.ts:28,33`) | **improved** — event-driven rather than a queued task |
| **§10.3** file selection | Seven steps, each assigning a score. Scores read as a **maximum** | Nine signals that **accumulate** through `bump()`, each recording its reason. Plus `relevanceWeight`, `Learning.utility`, PageRank tie-break at `0.12·(pr/top)` explicitly "breaks ties, does not decide selection", symbol-term stem matching, per-symbol embeddings, multi-file neighbour expansion for `debug/implement/refactor`. `fileSelector.ts:159` is the final rank | **improved** — materially. The per-bump reason is what makes `/why` possible; the spec had no such affordance |
| **§10.5** output format | `<task_result>` containing **`<patches>`** with unified diffs | `<task_result>` containing **`<files>`** with complete file content. `outputFormat.ts:12-15` argues the case explicitly: *"Full files apply deterministically; diffs do not."* But `DIFF_OUTPUT_FORMAT` (`:112`) and `applyPatches()` (`patchApplier.ts:78`) exist and are used for Codex today | **regressed, partially** — whole-file is the most expensive line item in the system (output tokens scale with file size, not edit size). The machinery to fix it is already here; only the default and a parser are missing. Wave 1.2 |
| **§10.5** rejection rule | "Free-form responses are rejected by the output parser and the task is flagged for retry with clarification" | Kept for the IR path (`outputParser.parseIR:56` throws `ParseError`). Deliberately bypassed for `/ask` via `PROSE_OUTPUT_FORMAT` (`:64`) and `free_form` on `CompiledPrompt` (`types/context.ts`) — a question has no file to apply and nothing to store | **improved** — the spec assumed one contract; the build has five, each matched to what the caller needs |
| **§11.2** budget profiles | Six profiles with named percentages, including `scratchpad: 2%` (planning) and `7%` (testing) | Same six profiles, same percentages, `budget.ts:8-70` — **including both `scratchpad` entries** (`:19`, `:59`). But `scratchpad` is not a `ContextComponent` (`types/context.ts:6-25`) and nothing emits or reads it. `resolveBudget` renormalizes over it (`:124-132`), so the share is taken and then spent on nothing | **regressed** — see D1 in `docs/plan/00-discovery.md`. 7% of every testing budget is allocated to a component that does not exist. Either wire it up or delete the two lines |
| **§11.3** rule 1 — scale by context window | "Different providers have different limits. The scheduler adapts" | **Deliberately abandoned.** `LADDER = [24_000, 64_000, 160_000]` (`budget.ts:101`) — absolute rungs, capped by `Math.min(maxContextTokens, rung)`. The comment at `:95-100` names the bug this fixed: the old code multiplied by `max_context_tokens` and "every task filled ~176k regardless of how small it was" | **abandoned — DO NOT RESTORE.** This is the documented cause of a measured bug |
| **§11.3** rule 2 — redistribute compression savings | Saved space is redistributed | Implemented, differently and better: `resolveBudget` renormalizes against the profile's *original* total so shrinking one component feeds the others (`budget.ts:124-132`), driven by `Learning.componentWeights` from observed reference rates rather than from compression outcomes | **improved** |
| **§11.3** rule 3 — task names N files | "If the task explicitly names 15 files, `relevant_files` gets more budget" | Not a budget adjustment. Named files instead enter selection at score 1.0 (`fileSelector` step 1) and win the greedy fill on merit | **abandoned**, reasonably — the effect is achieved by ranking rather than by allocation |
| **§11.3** rule 4 — grow reasoning after a failure | "If a previous attempt failed due to insufficient reasoning context, the retry increases `prior_reasoning` budget by 10%" | Not implemented. The escalation ladder raises the *whole* budget a rung rather than one component by 10% | **not yet built** — and the right generalization is Wave 1.1's `<context_request>`: let the model **name** what is missing instead of guessing which component to grow. The spec was reaching for this and not quite arriving |
| **§11.4** compression cascade | Compress low-priority first, files → signatures, reasoning → 2–3 sentences, wiki → bullets, then drop lowest-priority and flag | Implemented and **reordered on principle**. `REDUCE_ORDER` (`compiler.ts:340-344`) sheds by *replacement cost*: anything re-derivable from disk or git for free goes first; `KNOWN_FAILURES` and `PRIOR_REASONING` go last because each cost an LLM call to buy. `KEEP` (`:348`) never drops `RELEVANT_FILES` — a patch needs something to patch — but compresses it first. The comment records that this order "used to be exactly inverted" | **improved** |
| **§11.4** budget header | A timestamped `<!-- Context compiled at 2025-07-01T14:23:00Z … -->` comment at the **top** of every context | Not present. `ORDER` (`compiler.ts:301-307`) is ordered most-stable-first specifically so the vendor's prefix cache can match a long shared prefix | **abandoned — DO NOT RESTORE.** A timestamp at the top busts the prefix cache on every single call. These are exact opposites and the build is right. If prompt metadata is ever wanted, it goes at the *end* and carries no timestamp |
| **§12.2** worker catalog | Workers with typed contracts, mostly deterministic, LLM-backed the exception | `Worker<TInput,TOutput>` with `validate`/`execute`/`on_success`/`on_failure`, a module-level registry, `runWorker` wrapping every call with event-bus emission, and `requires_llm` declared per worker in `descriptors.ts`. 8 deterministic + 4 LLM-backed = 12 registered | **improved** — `requires_llm` as a declared field is what makes `/workers` honest |
| **§12.2** `<patches>` in the executor contract | See §10.5 | See §10.5 | **regressed** — same row, Wave 1.2 |
| **§12.4** scheduling | Static dependency graph, no LLM. Diagram reads `[for each task in parallel where safe]` | `TASK_PIPELINE` (`scheduler.ts:18-32`) declares 13 stages; `registerCoreWorkers()` (`:36-44`) registers 12 workers and **six pipeline stages have no worker at all** (`Planner`, `ContextCompiler`, `ReasoningExtractor`, `WikiUpdater`, `TaskExecutor`, `Checkpointer`). The real pipeline is straight-line code in `sessionManager.runNextTask():295-493`. `topoOrder()` sorts a graph nothing executes | **regressed** — the pipeline is a diagram that drifted. `ARCHITECTURE.md:162` calls it "an explicit DAG", which overstates it |
| **§12.4** parallelism | `[for each task in parallel where safe]` | `nextReadyTask()` (`scheduler.ts:65-74`) returns **one** task; `runAll` (`sessionManager.ts:519-568`) is strictly sequential. Worktree isolation — the thing that would make parallel safe — exists only inside `reproGenerator.ts:75-94` for oracle admission | **not yet built.** Correctly deferred: parallel execution without isolation is parallel corruption. The isolation primitive is already written and reusable |
| **§13** provider abstraction | A common `Provider` interface; an account selector | Three orthogonal routing axes (provider, model tier, thinking effort) with `providers.pinned` re-checked in `modelFor` **and again as the last thing before the vendor call**. `tierFor` (`manager.ts:100-122`) is a pure, tested scoring function. `THINKING_BUDGET` (`:65`), `DERIVED_CHEAP` (`:55`), `DERIVED_EFFORT` (`:62`). **The word `effort` does not appear in `SPEC.md` at all** | **improved** |
| **§13** quota | Not specified in detail | `quotaLedger.ts` records only what vendors actually reported. Rolling per-vendor windows (`WINDOW_MS:84`, `DEFAULT_WINDOW_MS:90`), escalating cooldowns `[30s, 2m, 10m]` (`:105`). No estimated or inferred limit exists anywhere in the file | **improved** — and this is a rule, not just an implementation: never introduce an inferred limit |
| **§13** conversation continuation | Not designed | `continuationRequest` (`manager.ts:140-151`), three cases, used at `:680`. Case 3 resumes a vendor conversation with only the delta. `workers/handoff.ts` carries session reasoning across a vendor switch | **improved** — did not exist in the design |
| **§19.2** schema | Single-database SQL for `sessions`, `tasks`, etc. | **Two** databases on purpose. PRIMARY (`schema.ts:5-227`, 14 tables) is never dropped and evolves by 11 additive `PRIMARY_MIGRATIONS` (`:384-396`). REPO INDEX (`:229-378`, 14 tables) is per-repo, droppable, versioned by `REPO_INDEX_VERSION = 2` (`db.ts:12`) — a version bump drops and rebuilds, so index schema changes need no migration at all | **improved** — the split is what makes index evolution cheap |
| **§19.2** `symbols` | Symbol table with location | `symbols` (`schema.ts:244-255`) declares `line_start` and `line_end` — but **`line_end` is never written**: both inserts (`indexer.ts:74`, `:133`) name eight columns and omit it. **No byte offsets exist anywhere.** `ExtractedSymbol` (`extractors.ts:4-10`) carries a single `line` | **regressed** — a declared column that no code populates is worse than an absent one, because it reads as available. Blocks symbol-anchored edits; costed in `00-discovery.md` §2.3 |
| **§22.3** sensitive content | Four rules: index structure not content · load file content only at compile time · never log context in plaintext · **archive raw model output in encrypted cold storage** | The first three hold. The fourth was **removed**: `ir.raw_output` was AES-encrypted to disk and read by nobody | **abandoned — DO NOT RESTORE the encryption.** Encrypting an artifact nothing reads is cost without benefit. Wave 0.3 replaces it with a readable trace store plus a retention policy, which is the thing that was actually wanted |
| **§22.3** the gap in both documents | The threat is stated correctly — "repository code contains secrets (API keys in code, passwords in configs, PII in test data)" — then all four rules protect **logs and archives** | **Nothing protects the compiled context, which is the only thing that actually leaves the machine.** The build inherits the gap unchanged | **not yet built** — and it is the one that must ship before any public release. Wave 0.5 |
| **§22.4** audit log | Append-only; provider, account, session, task, token counts, component names, no key, no full context | `audit_log` table (`schema.ts:175`). `token_usage` (`:111`) carries `components` and, via migration, `role`, `cache_read_tokens`, `cache_write_tokens`, `wasted_tokens` | **improved** — the spec's log "is not used by the system"; the build's usage rows are what `/waste`, `/stats` and `/cost` are computed from |
| **§25.1** response time | Sub-100ms for non-LLM commands | Not measured. No benchmark harness exists (`package.json:9-14`) | **not yet built** — Wave 0.1 |
| **§25.2** "token reduction vs. naive approach: 60–90%" | Headline efficiency target | Not implemented, and must not be. It is a counterfactual about what some other tool would have spent, and `ARCHITECTURE.md:1043-1045` states that nothing in waste accounting is a counterfactual | **abandoned — DO NOT RESTORE.** The spec's headline metric contradicts the build's measurement ethic. Keep the ethic. Replace the metric with `Succ/Mtok` |
| **§25.2** other targets | Repeated reasoning overhead <5% · context redundancy <10% · useful-content utilization >80% | Partially expressible: W4 (re-buying a held answer) maps to the first, W3 (`wasteRatio()`, `tokenAnalytics.ts:211,241`) to the third. Measured W3 today is **0.015%** (`ARCHITECTURE.md:1070-1072`) | **improved in ethic, incomplete in coverage** — of W2/W3/W4/W5 (`ARCHITECTURE.md:1049-1054`) **only W3 is implemented**. Note there is **no W1**; any plan proposing "W1" is inventing a class over a numbering gap |
| **§25.3** scale targets | 1M+ files · 10 concurrent sessions · 20 accounts/provider · <100MB checkpoints · <5% index overhead | Unmeasured. 10 concurrent sessions is unreachable before worktree isolation lands | **abandoned — DO NOT RESTORE.** Publishing unmeasured scale targets is how a project loses trust on its first bug report |
| **§25.4** reliability | Crash recovery >99% · checkpoint integrity 100% · resume accuracy 100% · handoff fidelity 100% | Mechanisms exist — `checkpoints` + 6 migrated columns, `undo_journal` (`schema.ts:191`), `handoff.ts`. The **rates are unmeasured** | **not yet built** as a measurement |
| **Appendix A** config | `daemon.port: 7432` IPC · `log_level` · `indexing.*` · `memory.compression.schedule` cron · `wiki.conflict_strategy` · `context.max_files: 30` · `providers.*` | `daemon.log_level` is real and load-bearing (`events/bus.ts:13-24`, filtering by `LEVELS`). No IPC port — single process, no daemon. Compression is triggered by threshold, not by a cron schedule. Much of what Appendix A calls config lives as source constants — the full list is `00-discovery.md` §3 | **partially abandoned** (the daemon) **/ not yet built** (config externalization) — Wave 5.1 |

---

## Binding: what must stay dead

Carried from `CODEMASTER-10X.md` §1.5, verified against source, and binding on
every future wave. Do not resurrect these from `SPEC.md` under any circumstances.

1. **The timestamped budget-summary header at the top of every prompt (§11.4).**
   It busts the vendor prefix cache on every call. If prompt metadata is ever
   wanted, it goes at the end and carries no timestamp.
2. **Scaling budget shares by the provider's context window (§11.3 rule 1).**
   The documented cause of the every-task-fills-176k bug that `LADDER` fixed.
3. **The seven-process daemon and Redis session memory (§4.1).** The build is a
   single process on `node:sqlite` `DatabaseSync` — no native dependency, no build
   step. For a tool people install with `npm i -g`, better on every axis.
4. **The "60–90% token reduction vs. naive approach" target (§25.2).** A
   counterfactual. It contradicts the rule that nothing in waste accounting is a
   counterfactual. Replaced by `Succ/Mtok`.
5. **Encrypted cold storage for raw model output (§22.3).** Already removed for
   good reason. Wave 0.3 gives readable traces with a retention policy instead.
6. **The 1M-file and 10-concurrent-session scale targets (§25.3).** Neither
   measured, neither reachable before worktree isolation lands.

## Worth reviving

1. **`<patches>` instead of whole-file output** (§10.5, §12.2) — Wave 1.2. Half
   the machinery is already built.
2. **The archive step on compression** (§7.6 step 3) — Wave 3.2. A plain sidecar
   file, not encrypted storage.
3. **Parallel task execution** (§12.4) — after worktree isolation, not before.
4. **§11.3 rule 4** — generalized into Wave 1.1's `<context_request>`: let the
   model name what is missing rather than guessing which component to grow.
5. **The scratchpad** (§11.2) — currently half-alive and costing budget for
   nothing (D1). Either wire it into Wave 1.1 as the model's working-notes
   channel, or delete the two allocations.
