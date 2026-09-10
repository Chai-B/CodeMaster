# CodeMaster: landscape, gaps, and the path to 10x

Written against `ARCHITECTURE.md` v1.0.0 and `SPEC.md` v0.1. Every criticism
below points at a specific mechanism in one of those documents, not at the idea
of the tool.

---

## 0. The thesis in one page

CodeMaster made one bet and built everything on it: *the lever on cost is the
number of calls, not the size of each one*. The evidence given is real (a vendor
CLI floor of ~37.3k tokens per call against ~2.2k of own context, W3 waste at
0.015%). The bet produced a genuinely unusual system: a deterministic pipeline
that calls a model only where a model is required, with a verification layer that
refuses to accept the model's own opinion as evidence.

That bet is correct for the vendor-CLI path and it is the reason CodeMaster has
something nobody else has. It also produced three structural consequences that
now cap the tool:

1. **A pipeline cannot recover from a bad context guess.** `compileContext` runs
   once per task and the model has no way to say "I need the caller of this
   function". Escalation costs a whole failed attempt. The 0.015% W3 number
   measures precision and says nothing about recall, and recall is the failure
   mode that actually loses tasks.
2. **Whole-file output is the most expensive representation there is.**
   `OUTPUT_FORMAT` demands complete final file content, never a diff. Output
   tokens cost three to five times input, reasoning tokens bill as output, and a
   1,000-line file re-emitted for a three-line change is the single largest
   avoidable spend in the system.
3. **The evidence layer, which is the crown jewel, is inert on the exact
   workload the tool is being pointed at.** `behavioralVerify` returns
   `{ok: true, confident: false}` when there are no relevant tests. A greenfield
   project has no pre-existing tests, so `buildEvidence()` can only ever return
   `authored-by-task` or `none`, and no task is ever `verified`. "End-to-end
   coding projects from simple prompts" is precisely the case the oracle cannot
   grade.

The 10x is not more features. It is four moves:

- **Give the deterministic layer a loop.** Let the model request context inside
  the same vendor conversation, served deterministically from the index. This
  buys recall at the cost of one resumed round-trip instead of a failed attempt.
- **Change the edit representation to symbol-anchored edits.** CodeMaster is one
  of the only tools that already has the tree-sitter symbol spans required to
  splice deterministically. AST-anchored editing is the most reliable format
  measured across models and it collapses output cost.
- **Make the oracle work on greenfield.** Derive acceptance criteria from the
  objective, admit them by execution, and grade against them. Without this the
  tool's best idea does not apply to its headline use case.
- **Stop being a pipeline that happens to expose MCP. Be the substrate every
  agent runs on, and ship your own agent as one consumer of it.**

Everything else in this document is downstream of those four.

---

## 1. Where the project stands: spec, build, and drift

### 1.1 Five products in one binary

Strip the implementation and there are five products bundled together:

| Layer | What it is | Closest single-purpose competitor |
|---|---|---|
| Repo intelligence | tree-sitter index, dep graph + PageRank, call graph, use-sites, embeddings, RKG | Serena, CodeGraph, Code-Graph-RAG, Sourcegraph MCP |
| Context compiler | 9-signal file selector, 6 budget profiles, escalation ladder, 2-stage budget enforcement | Aider's repo map, Repomix, SDL-MCP |
| Evidence / oracle | repro admission, characterization, use-site gate, `OracleProvenance` | nothing comparable ships in OSS |
| Memory | reasoning, failures, long-term, versioned wiki, learned selector weights | Mem0/OpenMemory, Zep, Letta, agentmemory, memory-bank |
| Provider control plane | 3-axis routing, quota ledger, failover, handoff, CLI account directories | LiteLLM, OpenRouter, Requesty |

No competitor bundles all five. That is the opportunity and also the risk: five
half-products lose to five specialists unless the bundle produces something none
of them can. The thing the bundle produces is **verified change with a cost
receipt**, and that is what the positioning should be.

### 1.2 Where the build improved on the spec

The implementation is not a degraded version of the design. In several places it
is a correction of it.

- **Budget.** `SPEC.md` §11.3 rule 1 says the scheduler adapts allocation to the
  provider's context window. That is precisely the mechanism `ARCHITECTURE.md`
  §6.4 identifies as the bug where every task filled ~176k regardless of size.
  `LADDER = [24_000, 64_000, 160_000]` replaced a percentage-of-window model
  with an absolute rung model, and it is strictly better.
- **File selection.** The spec's §10.3 has seven steps and takes a maximum.
  The build has nine signals that *accumulate* through `bump()`, plus a PageRank
  tie-break, symbol-term stem matching, per-symbol embeddings, multi-file
  neighbour expansion, `relevanceWeight`, and a recorded reason per bump that
  powers `/why`. This is a materially better selector than the one specified.
- **Routing.** The spec has an account selector. The build has three orthogonal
  axes and a pin re-checked twice. The word `effort` does not appear in the spec
  at all.
- **Quota.** The build's rule that the ledger records only what vendors actually
  reported, with rolling per-vendor windows and escalating cooldowns, is harder
  nosed than anything specified.
- **Planner economics.** The spec has no notion of skipping the planner.
  `isSingleUnit` and `isSelfVerificationTask` are implementation-time
  discoveries, each backed by a measurement (70.5k tokens for a plan that
  restated the objective; a three-task plan of nothing but "Verify …" tasks that
  all failed).
- **Prompt ordering.** The spec §11.4 puts a timestamped budget header at the
  top of every prompt. The build's fixed `ORDER` puts stable content first so a
  vendor prefix cache can match. These are opposites and the build is right.

### 1.3 Where the build regressed from the spec

Three of these are worth fixing, and one of them is the most expensive line item
in the whole system.

- **Patches became whole files.** `SPEC.md` §10.5 specifies
  `<patches><patch file="…">` containing unified diff, and §12.2 defines
  PatchApplier as "unified diff application". The build ships `<files>` with
  complete final content and states "never a diff". The project designed the
  cheap representation and shipped the expensive one. `DIFF_OUTPUT_FORMAT`
  exists for Codex, so half the machinery is already there. See G2 and §7.3.
- **Compression lost its archive.** Spec §7.6 says compression summarizes to
  ≤200 tokens, replaces the *active index entry*, and archives the full object
  to cold storage. The build does
  `UPDATE reasoning SET detail=?, importance=importance*0.5 WHERE id=?` in
  place. Dropping step 3 turned a lossy-but-recoverable design into a
  destructive one. See G6 and §7.4.
- **Parallelism was designed and never built.** The spec's §12.4 scheduler
  diagram reads `[for each task in parallel where safe]`. The build's
  `nextReadyTask()` returns one task at a time, and Pillar 5 worktree isolation,
  which is what would make parallel safe, is documented as unimplemented. See G4
  and §7.6 of the plan.
- **LSP is present but not load-bearing.** Spec Phase 1 lists LSP integration
  with pyright and typescript-language-server as a deliverable. The build has
  `lsp.ts` used "when one is available" and caps LSP reference results at 12.
  Symbol-level precision from a language server is exactly what Serena sells.
- **Scratchpad was dropped.** The spec's planning and testing budget profiles
  allocate 2% and 7% to a `scratchpad` component. The build's nine components do
  not include one. Worth reviving, see §1.6.

### 1.4 What the build discovered that the spec never imagined

This is the most important finding in this document, and it changes the
strategy.

Word counts across all 3,595 lines of `SPEC.md`:

| Term | Occurrences in SPEC.md |
|---|---|
| oracle, characterization, use-site | 0, 0, 0 |
| provenance | 1 (unrelated) |
| learning | 0 |
| effort | 0 |
| PageRank | 0 |
| MCP / Model Context Protocol | 0 |
| proxy | 0 |
| worktree, sandbox | 0, 0 |
| benchmark | 0 |
| AGENTS.md, subagent | 0, 0 |
| redact | 0 |

The evidence layer, the learning loop, the effort axis, PageRank centrality, the
MCP server and the HTTP proxy are all things the *implementation found* and the
design document does not contain.

Put plainly: **the spec is a memory-and-context OS. The build is a
memory-and-context OS that grew an evidence engine and two integration
surfaces.** And the parts of CodeMaster with no competitor are exactly the parts
that are not in the spec.

The strategic conclusion follows directly. `SPEC.md` is not the roadmap. It is a
historical design document that got the deterministic-context half right and did
not anticipate the half that turned out to be differentiating. The roadmap is
the thing the build discovered, which is why §6 reframes the product around it.

### 1.5 Spec ideas that must stay dead

Do not let a coding agent resurrect these from `SPEC.md`.

- **The budget header (§11.4).** A timestamped comment at the top of every
  prompt busts every vendor prefix cache on every call. If prompt metadata is
  ever wanted, it goes at the end, and it carries no timestamp.
- **Scaling budget shares by the provider's context window (§11.3).** Already
  the documented cause of one measured bug.
- **The seven-process daemon with Redis (§4.1).** The build is a single process
  on `node:sqlite` `DatabaseSync` with no native dependency and no build step.
  For a tool people install with `npm i -g`, that is better on every axis.
- **"Token reduction vs naive approach: 60-90%" (§25.2).** That is a
  counterfactual about what some other tool would have spent, and
  `ARCHITECTURE.md` §11 states that nothing in the waste accounting is a
  counterfactual. The spec's headline metric contradicts the build's measurement
  ethic. Keep the ethic. Replace the metric with `Succ/Mtok`.
- **Encrypted cold storage for raw model output (§22.3).** The build already
  removed this, correctly: `ir.raw_output` used to be AES-encrypted to disk and
  read by nobody. Wave 0.3 gives you readable traces with a retention policy
  instead.
- **The 1M-file and 10-concurrent-session scale targets (§25.3).** Neither is
  measured and neither is reachable before worktree isolation lands. Publishing
  unmeasured targets is how an OSS project loses trust in its first week.

### 1.6 Spec ideas worth reviving

- **Do not re-emit unchanged code.** The spec's diff intent was right; §7.3
  supersedes the mechanism with symbol anchors, which are cheaper *and* more
  reliable than udiff.
- **Parallel tasks where safe.** Wave 2.3 and 2.4.
- **Archive on compression.** Wave 3.2, as a plain sidecar file rather than
  encrypted storage.
- **LSP as a first-class symbol source.** It strengthens anchor resolution in
  Wave 1.2 and `find_symbol` in Wave 4.1.
- **The scratchpad.** Revive it as the model's working-notes channel inside the
  Wave 1.1 loop. Notes persist across turns within the task's vendor
  conversation and cost nothing extra to carry, because the vendor already holds
  the conversation.
- **§11.3 rule 4**, "if a previous attempt failed due to insufficient reasoning
  context, increase that budget by 10%". This is the spec reaching for
  `<context_request>` and not quite arriving. The right generalization is to let
  the model name what it is missing rather than guess which component to grow.

### 1.7 One gap that is in both documents

Spec §22.3 identifies the threat correctly ("repository code contains secrets,
API keys in code, passwords in configs, PII in test data") and then writes four
rules that all protect *logs and archives*. None of them protect the thing that
actually leaves the machine, which is the compiled context sent to a third-party
vendor. The build inherits the gap. See G12 and Wave 0.5.

---

## 2. The landscape

### 2.1 Full harnesses (the agents themselves)

| Tool | Model | Context strategy | Memory | Verification | Notes |
|---|---|---|---|---|---|
| Claude Code | proprietary | agentic search, no index; tool-search progressive disclosure since v2.1.7 | CLAUDE.md, skills, agent-memory dirs | model self-check, hooks for determinism | extensibility is the moat: skills, subagents, hooks, plugins, agent teams |
| Codex CLI | proprietary | agentic, V4A custom patch format | AGENTS.md | tests when asked | `/goal` durable objectives; strong harness per AHE panel (71.9% TB2) |
| Gemini CLI / Antigravity | proprietary | agentic | AGENTS.md/GEMINI.md | weak | native ACP |
| OpenCode | OSS | agentic, redundant edit-format fallbacks | AGENTS.md | weak | 47.2% TB2 in AHE panel |
| Amp / Goose / Cline / Roo | mixed | agentic + condensers | memory-bank markdown | weak | Roo/Cline memory-bank is a prompt convention, not a store |
| Aider | OSS | **tree-sitter repo map + personalized PageRank, ~1k token budget, SQLite cache** | git history only | lint + test loop, auto-commit | closest technical cousin; battle-tested at ~15B tokens/week |
| OpenHands SDK v1 | OSS | event-sourced state, condenser (`max_size=80, keep_first=4`), microagents | event log replay | sandbox execution | strongest OSS architecture: deterministic replay, opt-in sandboxing, subagent delegation, stuck detection, budget ceilings |

**Read on this group:** they win on loop and lose on determinism. Every one of
them re-derives repo structure with model calls. None of them can tell you what a
run cost, what it bought, or whether the change is actually proven.

### 2.2 Context layers (CodeMaster's most direct competitors)

- **Serena** (oraios). LSP-backed symbol tools (`find_symbol`,
  `find_referencing_symbols`, `insert_after_symbol`) over MCP. 30+ languages.
  Widely reported large token savings. This is the tool people actually reach for
  when they want "IDE brain for my agent". **Its weakness: no memory, no
  evidence, no cost accounting, no learning. It is a better grep.**
- **CodeGraph** (colbymchenry). Local `.codegraph/` index, MCP, auto-sync,
  positioned across Claude Code / Cursor / Codex / OpenCode / Gemini / Kiro.
  Very large adoption. Same weakness as Serena plus a weaker symbol model.
- **Code-Graph-RAG** (vitali87). Tree-sitter to Memgraph, Cypher over a unified
  multi-language schema, MCP server. Heavier install (graph DB daemon).
- **Sourcegraph MCP / Code Finder**. Agentic search subagent that returns file
  paths + line ranges + why they matter. Enterprise, cross-repo. This is the
  commercial version of what CodeMaster's FileSelector does.
- **SDL-MCP** (Symbol Delta Ledger). Explicitly a "context budget layer for
  coding agents". Closest in *framing* to CodeMaster's context half.

**The gap all of them share:** they hand the agent better retrieval and then walk
away. Nobody grades the outcome, nobody records what was learned, nobody prices
it. That is exactly the second half of CodeMaster.

### 2.3 Memory layers

`agentmemory`, Mem0 / OpenMemory, Zep / Graphiti, Letta, Cognee, MemPalace,
ByteRover, Supermemory, plus the Cline/Roo "memory bank" markdown convention.

Two observations that matter for CodeMaster:

- The category has converged on **local-first SQLite + MCP + hooks for
  auto-capture**, which is exactly CodeMaster's shape already. The differentiator
  is no longer storage, it is *what gets stored*.
- Almost all of them store conversational facts. Almost none store **outcomes**
  (what was attempted, what failed, what the evidence said). CodeMaster's
  `failures` table and `tier_outcomes` are rarer and more valuable than another
  vector store. Lean into that.

### 2.4 Orchestration and parallelism

Conductor, Vibe Kanban, Claude Squad, Nimbalyst (successor to Crystal),
parallel-code, Emdash, Baton, ccswarm, plus `git worktree` helper tools
(agentree, gtr, gwq). The whole category exists because of one primitive
CodeMaster documents as unimplemented: **worktree isolation per session**
(Pillar 5).

The consensus from the Anthropic/Cognition debate, as it settled through 2026:
one orchestrator owns continuous context and spawns *ephemeral, read-only*
subagents that return compressed summaries. Parallel *writers* stay off the
table because their implicit decisions conflict. CodeMaster should adopt exactly
that shape and no more.

### 2.5 The apply layer

Morph Fast Apply and similar merge models exist because whole-file rewriting is
so expensive that a specialized model to do the merge pays for itself (reported
50-60% token cut and ~90% latency cut versus full-file rewrite). CodeMaster does
not need to buy this: it has the AST index to do the merge deterministically at
zero marginal cost, which is strictly better than a second model call.

### 2.6 Protocols and conventions

- **MCP** is the tool plane. The 2026 pattern is progressive disclosure: tool
  search and code-execution modes report 85-99% reductions in tool-definition
  tokens. A server that dumps five tool schemas is fine; a server that wants to
  expose thirty is not.
- **ACP** (Zed's Agent Client Protocol) is the editor plane. JSON-RPC 2.0 over
  stdio, native in Gemini CLI / Copilot CLI / Goose / Cline / OpenHands, adapters
  for Claude Code and Codex, shipped in Zed and JetBrains, with a registry. It is
  the LSP moment for agents. CodeMaster already implements newline-delimited
  JSON-RPC 2.0 over stdio for MCP, so an ACP server is days of work, not weeks.
- **AGENTS.md** is the instruction plane and the de facto standard. CodeMaster's
  wiki bootstrap ingests README/CONTRIBUTING/ARCHITECTURE and not AGENTS.md,
  which is the one file specifically written for agents.

---

## 3. What CodeMaster has that nobody else has

These are real and should be defended, not rewritten.

1. **`requires_llm` as a declared, inspectable property of every worker.** No
   other tool can tell you which of its steps are deterministic. `/workers`
   makes the boundary auditable. This is a trust artifact as much as an
   architecture.
2. **`OracleProvenance`.** Four grades of evidence, and the rule that a test the
   task wrote can prove failure but never success. Every other tool in this space
   accepts "the model said it passed" or "some test ran". This is the single most
   valuable idea in the repo.
3. **Repro admission by execution in a throwaway worktree.** A reproduction is
   only admitted if it *fails* on current code; a characterization only if it
   *passes*. pytest exit 1 admits, exit 2 rejects. This is real oracle
   engineering.
4. **The use-sites hard gate.** `unvisitedUseSites` fails a task whose changed
   signature has callers that were never opened. This catches the exact class of
   failure that makes agent-written code compile locally and break two files
   away. Nobody else does this.
5. **Waste accounting from persisted rows.** W2-W5, `savingsReport()` that prices
   reused answers and vendor prefix-cache hits differently and refuses to report
   savings without spend, `repriceLegacyCost` fixing a historical 1.76x
   overstatement. This is unusually honest instrumentation.
6. **Three orthogonal routing axes plus a pin that is re-checked twice.** Role,
   tier, effort. `DERIVED_CHEAP` for mechanical roles. `strongerThan` returning
   one rung up rather than the top. A pin as a promise. This is a better control
   plane than most gateways.
7. **The quota ledger that records only what vendors actually reported.**
   Rolling windows per vendor, escalating cooldowns, `rate_limited_until` set
   only from a vendor report, state that survives process restart. The previous
   invented-numbers version is the version everyone else still ships.

---

## 4. Gap analysis

Ranked by how much each one costs you, with the mechanism named.

### G1. There is no loop. (critical)

`compileContext` runs once. The model gets what the selector guessed and has no
channel to ask for more. If the guess is wrong the model fabricates, the patch
fails verification, and the solver retries with a *bigger budget* rather than the
*right file*. `LADDER = [24_000, 64_000, 160_000]` escalates on failure, so
recovering from a bad selection costs a full failed attempt.

The measurement hides this. `unreferencedTokens` counts a file as referenced when
its path or basename appears in the model's output. Under whole-file output the
model emits every file it edits with its path, so edited files are referenced by
construction and W3 measures only "files read but not edited". W3 = 0.015% is
therefore a precision number for a metric that cannot see the failure mode that
matters: **the file the model needed and did not get.** There is no recall metric
anywhere in the system.

### G2. Whole-file output. (critical, cost)

`OUTPUT_FORMAT` requires `<files>` to contain complete final content, never a
diff. Consequences: output tokens dominate spend; large files become unpatchable
in practice; the model must transcribe unchanged code, which is the task LLMs are
worst at; and every edit rewrites the file's whole surface, which makes review and
undo coarser than they need to be. `DIFF_OUTPUT_FORMAT` exists only for Codex.

This is a regression from the project's own design, not an oversight in it.
`SPEC.md` §10.5 specifies `<patches>` carrying unified diff and §12.2 defines
PatchApplier as "unified diff application". Whoever changed it presumably hit
udiff's apply failures, which are real and well documented, and reached for the
format that always applies. The correct answer is neither: it is symbol anchors
resolved against the index the project already maintains (§7.3).

### G3. No read-only exploration subagent.

The settled 2026 pattern is a single orchestrator plus ephemeral read-only
subagents with isolated context that return compressed summaries. CodeMaster has
none. Every question about the repo either goes through the deterministic layer
(good, but limited to what the selector modelled) or does not get asked.

### G4. No isolation, therefore no parallelism and no cheap rollback.

Pillar 5 is documented as unimplemented. Repro admission uses a throwaway
worktree; the session itself does not. So: no speculative attempts, no parallel
tasks, no clean abort, and `/undo` has to be a journal because there is no branch
to throw away. This is the primitive an entire competitive category is built on.

The spec's §12.4 scheduler diagram already says `[for each task in parallel where
safe]`. The scheduling half exists (`TASK_PIPELINE`, `topoOrder()`,
`nextReadyTask()` with `dependencies` and reverse `blocking` edges). Only the
isolation half is missing, which means this gap is smaller than it looks.

### G5. The layer surface is too thin to be a layer.

Five read-shaped MCP tools, ephemeral sessions, no writes into the graph beyond
`record_reasoning`, no resources, no prompts, no progressive disclosure, no ACP,
no hooks, no plugin for any host, no AGENTS.md in or out. The MCP server says
"here is context" and stops. The most valuable thing CodeMaster owns, the
**evidence gate**, is not exposed to other agents at all.

### G6. Learning is a scalar, not a strategy.

`Learning.utility(repo, path)` is a per-file multiplier. `recordComponents` is a
per-component weight. `tier_outcomes` is a starting tier. `recordLesson` writes a
`playbook/<type>-<file>` wiki entry only when a fix took more than one attempt.
There is no representation of *how to do a kind of task in this repo*.

Worse, `MemoryCompressor` rewrites a memory to ≤200 tokens and halves its
importance. That is a textbook implementation of the two failure modes the ACE
work named: **brevity bias** (each rewrite drops the domain-specific detail that
made the memory useful) and **context collapse** (iterated rewriting erodes
accumulated knowledge into a generic blob). The compressor is actively destroying
the thing it is meant to preserve.

The spec was less wrong here than the build. `SPEC.md` §7.6 specifies three
steps: summarize, replace the *active index entry*, and archive the full object
to cold storage. The build does the first, does the second by overwriting
`detail` in place, and skips the third entirely. Restoring the archive turns an
irreversible loss into a recoverable one, and is a one-file change.

### G7. No trajectory store, therefore no self-improvement.

Events exist on a bus and are consumed by the TUI, stderr and JSON output, then
discarded. There is no durable trace, no distillation of traces into root causes,
and no mechanism that edits the harness based on measured outcomes.

This matters more than it sounds. The AHE result is that ten iterations of
observability-driven harness evolution lifted Terminal-Bench 2 pass@1 from 69.7%
to 77.0%, past a human-designed Codex harness at 71.9%, and the frozen harness
transferred to SWE-bench-verified with **12% fewer tokens than the seed**. The
component ablation is the important part: the gain lived in **tools, middleware
and long-term memory**, and the system-prompt-only variant *regressed*. Prompt
tuning is not where the wins are. Editable non-prompt components are.

CodeMaster has the component substrate (workers, plugins with six types,
descriptors) and the outcome data (tasks, failures, tier_outcomes, token_usage).
It is missing the trace layer and the change manifest that turn those into a loop.

### G8. Verification holes.

- **No tests means pass.** `{ok: true, confident: !!repro && !missedLocus}` when
  `relevantTests(locus)` is empty. Correct as a policy (absence of evidence
  should not fail a task) and fatal as a default for greenfield, where absence of
  evidence is the permanent state.
- **Repro generation is skipped when the repo already covers the change.**
  "Covers the file" is not "covers this change". A pre-existing test suite that
  passes before and after proves nothing about the delta.
- **`characterizationFor` runs at most once per session and only when
  `detectFramework(repo) === 'unknown'`.** So repos with a known framework never
  get a regression baseline beyond their own tests.
- The LLM verifier returned "pass" for mathematically wrong never-executed code
  on your own benchmark. It is correctly demoted to advisory, but that means one
  of the six pipeline LLM roles produces no decision-grade signal.

### G9. Cold start on every new repo.

`repoSlug()` scopes `state.db` per checkout, and `MIN_SAMPLES = 4` gates every
learned signal. A user's fifth TypeScript project starts with zero priors even
though four projects' worth of lessons exist on the same machine. AHE's transfer
result says cross-context lessons do generalize.

### G10. Price is used as the capability signal.

`strongerThan` picks "the cheapest model that is still stronger" and the doc says
plainly that output price is the only capability signal the config carries. That
was defensible when price tracked capability. It no longer does, and it will
misroute (a cheap-but-strong model gets treated as weak, an expensive-but-narrow
one as strong). It also means escalation can move to a *worse* model.

### G11. No eval harness.

229 unit/integration/e2e tests prove the code works. Nothing measures whether the
*agent* works. There is no task-level benchmark, no pass@1, no
success-per-million-tokens. Every optimization in the roadmap is therefore
unfalsifiable.

This is the most correctable gap and the most valuable, because you author
Terminal-Bench 2 and Harbor tasks professionally. You have the one asset most OSS
agent authors do not.

### G12. Open-source readiness.

- **Secret leakage.** `compileContext` reads selected files and ships them to a
  third-party vendor. There is no redaction pass. One `.env` picked up by a
  basename match is a disclosed credential.
- **Prompt injection.** Repo content flows into the wiki (`bootstrap.ts` ingests
  README/CONTRIBUTING/ARCHITECTURE) and `setFileSemantics` writes model output
  about repo files into the RKG. A hostile repo can plant instructions that
  persist across sessions in a store the compiler reads first (`CONVENTIONS` is
  the very first component in `ORDER`).
- **Unsandboxed test execution.** `testRunner` executes the repo's own test suite
  with a 120s timeout and no isolation.
- **Stated defects.** GitHub Actions `Test` step failing; ~56 MB of unmigrated
  `~/.codemaster`; bench-era sessions stuck `in_progress`; `SPEC.md` describing
  things that do not exist. Each of these reads as abandonment to a first-time
  visitor.
- **The TUI mouse hack.** Claiming `?1002h`, wrapping `stdout.write`, and
  reimplementing selection from captured frames is impressive and is a permanent
  maintenance tax with real portability risk. It should be opt-in.

---

## 5. The reframe: substrate plus agent

Stop describing CodeMaster as an agent that also has an MCP server. Describe it
as two things that ship together.

This is not a departure from the vision. It is the completion of what the build
already discovered on its own. `SPEC.md` §1.4 says "it is not a plugin for an
existing editor" and §1.1 frames the problem as everyone else being stateless,
which points at building a better agent. Then the implementation went and built
an MCP server and an OpenAI-compatible proxy, neither of which appears anywhere
in the spec, because the deterministic layer turned out to be worth more to
other people's agents than to its own. Follow that signal.

**codemaster-core**: the deterministic substrate. Index, dep/call graph, RKG,
file selector, context compiler, evidence engine, memory, waste ledger, provider
control plane. Consumable four ways: a library API, an MCP server, an ACP agent,
and an HTTP proxy.

**codemaster-agent**: a small loop that uses the substrate. It is the reference
consumer, not the product.

Why this reframe pays:

- It resolves the "layer" question. Being a layer means other harnesses can adopt
  a piece without adopting the whole opinion. A Claude Code user should be able to
  install one plugin and get deterministic context plus an evidence gate, and
  never run `codemaster` as a CLI.
- It makes the moat legible. Nobody competes with "deterministic evidence for any
  agent". Everybody competes with "another terminal coding agent".
- It survives model churn. Harnesses get rewritten every six months. Index,
  oracle and ledger do not.

The four consumption planes:

| Plane | Transport | Who uses it | What it exposes |
|---|---|---|---|
| Library | TS import | embedders | everything |
| MCP | stdio JSON-RPC | Claude Code, Cursor, Codex, Gemini, OpenCode, Cline | context, symbols, evidence, memory |
| ACP | stdio JSON-RPC | Zed, JetBrains, Neovim, Emacs | full agent sessions in-editor |
| Proxy | HTTP | anything OpenAI-compatible | context injection + failover |

---

## 6. The 10x design

### 6.1 Loop engineering: two loops, deterministic gates

The current shape is `plan → per-task(compile → solve → verify)`. Replace with a
two-loop model where every loop boundary is a deterministic gate.

**Inner loop (solve).** Inside one vendor conversation, per task:

```
compile(tier 0)
  → call
  → parse
      ├─ <context_request>  → serve deterministically → conversation.delta → call
      ├─ <edits>            → apply → behavioralVerify
      │                        ├─ pass + provenance ok  → done
      │                        ├─ fail (actionable)     → delta with failure → call
      │                        └─ fail (not actionable) → stop, keep work
      └─ parse error        → format reminder delta → call
```

The one new element is `<context_request>`, and it is the highest-leverage change
in this document. The model asks for `symbol:Foo.bar`, `callers_of:baz`,
`file:path`, `tests_for:path`, `grep:pattern`. The request is served by the
existing deterministic analysis layer at zero LLM cost, appended as
`conversation.delta`, and the vendor resumes. Case 3 of `continuationRequest`
already makes this a correction-sized payload rather than a new prompt.

Why this does not violate the call-count principle: a resumed conversation turn
against a warm vendor session is far cheaper than a failed attempt plus a
re-compile at the next ladder rung. You are trading one cheap turn for the
elimination of an entire failure class. Cap it (`MAX_CONTEXT_REQUESTS = 3` per
task) and record every request, because **the request log is your first recall
metric**: every `<context_request>` is a file the selector should have chosen and
did not. Feed it straight into `Learning.recordSelection` as a negative signal.

**Outer loop (objective).** Runs until the objective's acceptance criteria are
met or a budget ceiling trips. Owns replanning: when N tasks in a row fail with
the same cause, the plan was wrong, not the execution. Owns the cost ceiling and
the checkpoint cadence. This is where "end-to-end project from a simple prompt"
actually lives.

**The scratchpad, revived.** The spec allocated 2-7% of the budget to a
`scratchpad` component and the build dropped it. Bring it back, but as an
*output* channel rather than an input one: the model emits `<scratchpad>` notes,
they persist in `session.metadata` for the task, and they ride the vendor
conversation for free across context-request turns and retries. This is what
gives the loop continuity of thought between turns without paying to re-establish
it, and it is where "what I have already ruled out" lives.

Add OpenHands-style **stuck detection** at both levels: identical tool/args
repeated, identical patch content, oscillating between two states, monotone token
growth with no diff growth. Cheap, deterministic, and it kills the most expensive
failure mode there is.

### 6.2 Context discipline, upgraded

Keep the nine signals, the accumulate-not-max `bump()`, the reason recording, and
`relevanceWeight`. Add:

- **Recall instrumentation.** Every `<context_request>` and every file the model
  names that was not in the compiled context becomes a miss. Report
  `selector_recall` next to W3 in `/waste`. Right now you optimize precision
  because it is the only thing you can see.
- **Symbol-level compilation as the default unit.** `symbolSlice` already keeps
  whole symbol bodies whose span mentions a keyword. Make the *unit of context* a
  symbol, not a file: `path#Class.method` with its signature, docstring, span, and
  a one-line rendered call-graph neighbourhood. Files become a fallback for small
  or unparseable ones. This is what Serena sells and you already have the index.
- **Budget escalation without failure.** The ladder stays, but the model can now
  climb it inside a conversation via `<context_request>` instead of by failing.
- **Cap the effective window below the advertised one.** Long-context degradation
  is measured on every frontier model and is steepest in the 100k-500k range.
  `LADDER`'s top rung of 160k is already sensible; make it explicit policy and
  never let a learned weight push a component past the middle of a long prompt.
  Keep the stable-first `ORDER` (it is correct for both prefix caching and
  lost-in-the-middle).
- **Ingest AGENTS.md / CLAUDE.md / .cursorrules** into `CONVENTIONS` in bootstrap,
  and **emit** a generated `AGENTS.md` from the RKG so other agents in the repo
  inherit CodeMaster's understanding for free. That single feature is a
  distribution channel.

### 6.3 Edit representation: symbol-anchored edits

Replace whole-file output with a tiered edit contract, most reliable first:

```xml
<edit file="src/auth/session.ts" anchor="symbol:SessionManager.refresh">
  ...complete new body of that symbol only...
</edit>

<edit file="src/auth/session.ts" anchor="search">
  <search>exact existing snippet</search>
  <replace>replacement</replace>
</edit>

<edit file="src/auth/new.ts" anchor="create">...full content...</edit>
```

The applier resolves `symbol:` anchors against the `symbols` table's spans and
splices deterministically. On a stale span (file changed mid-task) it re-indexes
that one file and retries, then falls back to search/replace, then to whole file.
Every fallback is recorded so you learn which anchor type each model handles.

Why this is the right call for this codebase specifically:

- Across models, AST-anchored edits are the most consistently applicable format
  measured; unified diff is the highest-variance (near-perfect on strong models,
  catastrophic on weak ones) because it makes the model transcribe context lines
  from memory. Search/replace sits in between and fails on repeated snippets.
  Whole-file is reliable and ruinously expensive.
- You are one of very few projects with the symbol spans to make the AST path
  deterministic. Everyone else has to pay a second model (Morph-style fast apply)
  to do the merge.
- It makes `unreferencedTokens` honest again, since edited files no longer appear
  in output by construction.
- It makes tier routing cheaper: a small model can produce a symbol body reliably
  even when it cannot produce a valid udiff.

Keep whole-file for new files and for models that demonstrably fail anchors; the
learning layer should pick per (model, language) from recorded apply outcomes.

### 6.4 Memory: four tiers, and stop compressing

**Tier 0, working.** Session state, current task, recent diffs. Ephemeral.

**Tier 1, repo episodic.** `reasoning`, `failures`, `checkpoints`, `undo`. Keep as
is. Keep the Jaccard>0.85 dedupe that increments a reference count, that is the
right primitive.

**Tier 2, repo playbook.** New, and this is the important one. Replace the wiki
`playbook/*` entries and the scalar learning with an ACE-shaped store:

```
playbook_items(
  id, repo, scope,            -- scope: global | lang:ts | area:src/auth | type:debug
  bullet,                     -- one atomic, testable strategy statement
  helpful_count, harmful_count,
  last_used_at, created_at,
  provenance_task_ids, embedding
)
```

Rules, taken directly from what the ACE work established:

- **Only delta updates.** Add a bullet, increment a counter, retire a bullet.
  Never regenerate the playbook wholesale. Wholesale regeneration is what causes
  context collapse.
- **Never summarize to shrink.** Prune by `harmful_count` and staleness. Retire,
  do not compress. Delete `MemoryCompressor`'s importance-halving rewrite from the
  hot path; if you need it, keep it for `long_term_memory` only and never for
  playbook items.
- **Counters come from execution, not reflection.** A bullet that was in the
  context of a task that reached `verified` gets `helpful += 1`. A bullet in the
  context of a failed task with the same failure class it claims to prevent gets
  `harmful += 1`. This is the same discipline as `recordLesson`, generalized.
- **Curation is deterministic.** Selection into context is by scope match plus
  `helpful/(helpful+harmful)` plus recency. No model call.

**Tier 3, global.** Same table, `repo = NULL`, `scope = lang:* | framework:* |
type:*`. Promotion rule: a bullet that reached `helpful_count >= 5` across
`>= 2` distinct repos is promoted. This is the fix for G9 and it is where the
tool starts to feel like it is learning rather than logging.

**Before any of it, restore the archive.** Spec §7.6 step 3 was specified and
never built. Write the pre-compression `detail` to
`repoDataDir(repo)/archive/reasoning/<id>.md` before the `UPDATE`, and add
`/reasoning restore <id>`. One file, one test, and it converts every future
memory bug from data loss into an inconvenience. Do this first because
everything else in this section rewrites memory behaviour, and you want an
undo before you start.

### 6.5 Evidence: make the oracle work everywhere

**Close the greenfield hole.** Add a fifth provenance, `criteria-admitted`:

1. `IntentParser` (deterministic) plus one cheap LLM call at objective time
   produces **acceptance criteria**: a list of executable checks derived from the
   objective ("`npm run build` exits 0", "GET /health returns 200", "the CLI
   prints a board after `move 1`").
2. Criteria are compiled into an executable harness in
   `repoDataDir(repo)/acceptance/`, outside the user's tree, same as repro.
3. A criterion is **admitted** only if it fails on the empty/current state and is
   runnable. Same admission discipline as repro, applied to greenfield.
4. `buildEvidence()` grades against admitted criteria.

This is one extra LLM call per objective (not per task), and it turns
`OracleProvenance` from a code-maintenance feature into a project-building
feature. Without it, the tool's best mechanism does not apply to the workload the
tool is being aimed at.

**Close the "covers the file" hole.** When `relevantTests(locus)` is non-empty,
still require that at least one relevant test *exercises the changed symbols*.
You have the call graph. If no test reaches the changed symbol transitively, treat
it as uncovered and generate a repro. Cheap check, large correctness gain.

**Add a delta guard.** Before accepting `pre-existing` provenance, run relevant
tests on the pre-change tree (you already have `git stash create` +
`worktree add --detach` from repro admission). If they passed before and pass
after, the suite did not observe the change. Downgrade to `confident: false`.

**Keep the LLM verifier advisory.** It is correctly scoped. Consider deleting it
entirely once `criteria-admitted` lands and measuring whether pass@1 moves; a role
that produces no decision-grade signal is a call you are buying for nothing.

### 6.6 Self-evolution: the AHE loop, adapted

This is the mechanism that makes CodeMaster improve faster than the harnesses it
competes with. Three observability layers, mapped onto what you already have.

**Component observability.** Externalize the tunable harness as files under
`~/.config/codemaster/harness/`, git-versioned:

```
harness/
  selector.weights.json      # the nine signal weights + relevanceWeight table
  budget.profiles.json       # the six profiles + LADDER
  output.formats/            # the edit contracts, per model family
  playbook.md                # tier-2/3 bullets, rendered
  verify.policy.json         # gate order, thresholds, confidence rules
  routing.roles.json         # role/tier/effort table
  middleware/                # new: pre/post hooks around every worker
  skills/                    # new: task-type procedures
```

Every one of these is currently a constant in source. Making them files is what
makes them editable by a loop and rollback-able at file granularity. This is also
straightforwardly good for users who want to tune without forking.

**Experience observability.** Persist trajectories. `sessions/<id>/trace.jsonl`,
one line per worker start/finish/event, already available on the bus. Then a
`codemaster distill` command that turns raw traces into per-task root-cause
reports plus a benchmark-level overview, exposed as files for drill-down rather
than dumped into a prompt.

**Decision observability.** Every harness edit ships a manifest entry:

```json
{
  "id": "chg-1",
  "component": "selector.weights.json",
  "failure_pattern": "callers not selected on signature-change tasks",
  "root_cause": "call-graph callers weighted 0.5 vs deps 0.8",
  "predicted_fixes": ["task-a", "task-b"],
  "risk_tasks": ["task-c"]
}
```

Next evaluation round intersects predictions with observed deltas and reverts
edits that did not pay. Note the honest finding from that literature: the loop's
self-attribution is roughly 5x better than chance at predicting *fixes* and
barely better than chance at predicting *regressions*. So the revert rule must be
mechanical (measured deltas), never argued.

**Prerequisite: `codemaster bench`.** None of this exists without an eval. Ship
three tiers:

- `bench:smoke` — 10 tasks from the existing fixtures, runs in CI, minutes.
- `bench:repo` — 30-50 real tasks derived from this repo's own git history
  (revert a commit, ask CodeMaster to reproduce it, grade against the real diff's
  tests). Free to construct, self-hosting, and honest.
- `bench:external` — Terminal-Bench 2 via Harbor, and SWE-bench-verified. This is
  where your day job is an unfair advantage.

Report `pass@1` and `Succ/Mtok` (verified tasks per million tokens). **Make
`Succ/Mtok` the project's headline number.** It is the metric that expresses the
tool's entire thesis in one figure, and no competitor publishes it.

### 6.7 Economics: getting the most from each call

Ordered by expected saving.

1. **Symbol-anchored edits** (§6.3). Largest single cut, on the expensive token
   class.
2. **Context requests instead of failed escalations** (§6.1). Removes whole
   failed attempts, which are the most expensive events in the system.
3. **Batch API for mechanical roles.** `summarize`, `merge`, `review`,
   ModuleSummarizer and wiki bootstrap are all latency-insensitive. Most vendors
   price batch at half. `DERIVED_CHEAP` already identifies exactly this set.
4. **Fold the repro call into the solve call when the repo has no oracle.** You
   already run them in parallel; on the no-test path, asking for the test and the
   fix in one contract removes a call entirely. Keep them separate when a repro
   must be admitted *before* the fix exists (that ordering is load-bearing).
5. **Speculative tiering, gated by learning.** For task types where
   `tier_outcomes` shows tier 0 succeeds under ~40%, launch tier 0 and tier 1 in
   parallel worktrees and take the first verified result. This spends more tokens
   to buy latency and pass@1 on exactly the classes where the cheap attempt is
   predictably wasted. Requires §6.4 isolation.
6. **Prefill and stop sequences.** Force the response to open with `<task_result>`
   and stop on `</task_result>`. Kills preamble and truncates run-on.
7. **Cross-task prompt prefix reuse.** `ORDER` already puts stable content first.
   Go further: hold CONVENTIONS/ARCHITECTURE/REPOSITORY_MAP byte-identical for the
   whole session so the vendor prefix cache hits across every task, and never let
   a learned weight reshape those three mid-session.
8. **Retire the LLM verifier** if §6.5 lands and the numbers hold.

New waste classes to add to `/waste`:

- **W1, reverted work.** Tokens spent on tasks later undone or checkpoint-restored.
- **W6, context misses.** Tokens spent on an attempt that requested context it
  should have been given (the recall metric, priced).
- **W7, loop tax.** Tokens spent after stuck-detection would have fired.

### 6.8 What daily use actually requires

Necessary features, in the order a real user hits them.

**First 60 seconds.** `codemaster init` must produce a repo brief, an
`AGENTS.md`, and a working index without asking a question, and must print what it
found and what it cost. `/setup` exists; make it the default path on first run in
an unindexed repo.

**Trust before spend.** A cost preflight on `run`: estimated calls, estimated
tokens, estimated dollars, based on the ledger's own history for this repo and
task type. Hard ceiling with `--max-cost`. Nobody adopts an autonomous tool that
cannot tell them what it is about to spend.

**Approval policy as an axis, not a mode.** `--approve never|risky|always`
mapping onto what `irProcessor` already computes for pre-risky checkpoints
(>200 diff lines, ≥10 files, any deletion) plus GUARDED basenames plus any
network or install command. Default `risky`.

**Streaming structured output.** `--json` should be NDJSON of the same event
union the bus already carries, versioned with a `schema_version`. That single
change makes CodeMaster scriptable inside other people's loops, which is the whole
point of being a layer.

**Watch mode.** `codemaster watch --on-fail` re-runs the objective when tests go
red. This is the cheapest possible loop-engineering feature and it is what turns
the tool into infrastructure rather than a command.

**Review surface.** `/diff` exists. Add per-task diff with the evidence grade
attached, because "here is the change and here is why we believe it" is the
product.

**Interface choices that matter more than they look:**

- Make the mouse-capture selection layer opt-in (`ui.mouse: false` default). It is
  clever and it is the most likely source of terminal-specific bug reports from
  strangers, which is the worst kind of first issue for an OSS project.
- Ship a plain non-Ink renderer for CI, dumb terminals, and Windows.
- `/why <file>` and `/context` are your best features for building trust and
  should be in the README's first screenful, not the diagnostic section.
- Progress must show *phase and evidence state*, not spinner text. "Solving
  (tier 1, 34k ctx, repro admitted)" tells the user whether to keep waiting.

---

## 7. Metrics that must exist

You cannot claim any of this without these. Add them before the features.

| Metric | Definition | Why |
|---|---|---|
| `pass@1` | verified tasks / attempted tasks, k≥2 rollouts | the only quality number |
| `Succ/Mtok` | verified tasks per million tokens | the thesis, in one figure |
| `selector_recall` | 1 − (context requests + unprovided named files) / files needed | the invisible failure mode |
| `evidence_mix` | share of tasks by `OracleProvenance` | tells you if the oracle is inert |
| `apply_rate` | patches applied cleanly / patches emitted, by anchor type and model | picks the edit format |
| `first_attempt_rate` | tasks verified without a solver retry | measures context quality directly |
| `waste_ratio` | W1..W7 / total | already partly there |
| `time_to_verified` | wall clock, p50/p95 | the number users feel |

### What to do with the spec's own targets

`SPEC.md` §25 already sets targets. Most should survive; two should not.

| Spec target | Verdict |
|---|---|
| CLI response < 100ms, context compilation < 1s, file selection < 200ms, wiki lookup < 50ms | Keep. Cheap to assert in CI and they defend the deterministic layer's whole value proposition. |
| Checkpoint < 5s, resume < 10s, repo map (1000 files) < 30s | Keep. |
| Repeated reasoning overhead < 5%, repository context redundancy < 10% | Keep, once `selector_recall` and the miss log make them measurable. |
| Context window utilization (useful content) > 80% | Keep, but restate as `1 − W3` so it maps onto a persisted row. |
| **Token reduction vs naive approach: 60-90%** | **Drop.** A counterfactual, and it contradicts the build's own rule that nothing in waste accounting is a counterfactual. Replace with `Succ/Mtok`. |
| Crash recovery > 99%, checkpoint integrity 100%, resume accuracy 100%, handoff fidelity 100% | Keep, and actually test them. `restoreCheckpoint` and `validateHandoffPackage` exist; the assertions do not. |
| **1M+ files, 10 concurrent sessions** | **Defer.** Neither is measured, and concurrency is unreachable before worktree isolation. Do not publish either until `bench` covers them. |

None of the spec's targets measure output *quality*, which is the gap the eight
metrics above exist to close.

---

## 8. Open-source launch checklist

Blocking:

- Fix the GitHub Actions `Test` step. A red badge is a dead repo to a visitor.
- Migrate or delete `~/.codemaster`; ship `codemaster doctor --fix` that reaps
  the stuck `in_progress` sessions and the stale data dir.
- Retire `SPEC.md` as a roadmap. Move it to `docs/history/SPEC-v0.1.md` with a
  header stating it is the pre-implementation design from before the evidence
  layer existed, that `ARCHITECTURE.md` is authoritative, and that §1.5 of this
  document lists the parts that were deliberately abandoned. Do not rename it to
  `ROADMAP.md`; a roadmap that predates your best feature will misdirect every
  contributor who reads it. `ARCHITECTURE.md` §17 ("What is not here") is the
  honesty asset. Make that section the norm and delete the document that
  contradicts it.
- Secret redaction in `compileContext` before any content leaves the machine.
  Deny-list by path and basename, entropy scan, `.codemasterignore`.
- Prompt-injection posture: treat all repo-derived text as data. Strip
  instruction-shaped content during wiki ingestion, tag RKG knowledge nodes with
  provenance (`human` vs `model` vs `repo-file`), and never let a `repo-file`
  node land in `CONVENTIONS` unreviewed.
- Sandbox flag for test execution, default off with a loud warning, `--sandbox
  docker` supported.
- LICENSE, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue templates.

Positioning:

- README leads with `Succ/Mtok` and the evidence table, not the feature list.
- One asciinema of `/why`, `/context`, and a verified task with its provenance.
- A comparison table that is fair. Say plainly what Serena does better and what
  Aider does better. Honest comparison tables get shared; unfair ones get
  ratioed.
- Ship the Claude Code plugin on day one. Most of your first thousand users will
  never run your CLI, and that is fine.

---

## 9. Sources

Landscape and technique claims above draw on:

- Aider repo map and edit formats — aider.chat/2023/10/22/repomap.html, aider.chat/docs/more/edit-formats.html
- Serena — github.com/oraios/serena
- CodeGraph, Code-Graph-RAG, SDL-MCP — github.com/topics/context-engine, github.com/vitali87/code-graph-rag
- Sourcegraph MCP / Code Finder — sourcegraph.com/mcp
- OpenHands SDK v1 — arxiv.org/abs/2511.03690
- Agentic Context Engineering (ACE), ICLR 2026 — arxiv.org/abs/2510.04618
- Agentic Harness Engineering (AHE) — arxiv.org/abs/2604.25850
- Context rot — research.trychroma.com/context-rot; Liu et al., lost in the middle
- Diff-XYZ edit-representation benchmark — arxiv.org/abs/2510.12487
- AST edits benchmark — geometricagi.github.io/2026/04/02/ast-edits.html
- Morph Fast Apply — morphllm.com/fast-apply-model
- MCP progressive disclosure / tool search / code execution — anthropic.com/engineering/code-execution-with-mcp
- Agent Client Protocol — agentclientprotocol.com, github.com/agentclientprotocol/agent-client-protocol
- Multi-agent boundary — Anthropic multi-agent research system; Cognition, Don't Build Multi-Agents; Cognition, Multi-Agents: What's Actually Working
- Orchestrator landscape — github.com/andyrewlee/awesome-agent-orchestrators