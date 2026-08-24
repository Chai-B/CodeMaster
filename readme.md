```
  ▄████▄
  ██        CodeMaster Next
  ▀████▀    A persistent reasoning operating system for AI software engineering
```

> The model is a replaceable CPU. CodeMaster Next is the OS beneath it.

CodeMaster Next treats LLMs as interchangeable execution engines and supplies the persistent layer they lack: structured session state, a Karpathy-style knowledge wiki, deterministic repository intelligence, reasoning that is stored once and replayed forever, and provider-agnostic checkpointing.

See [SPEC.md](SPEC.md) for the full design. This README is the operational summary.

---

## The five hard rules (spec §2.1)

1. **Never ask an LLM something a script can answer** — tree-sitter/regex extraction, git, ripgrep, dependency graphs.
2. **Never ask the same reasoning twice** — every decision is a structured object, persisted and replayed.
3. **Never store chats. Store state** — sessions, tasks, reasoning, and a wiki; never transcripts.
4. **Never send an entire repository to a model** — a deterministic file selector ships ~10–30 files.
5. **Never allow context drift** — every prompt is compiled from structured state, not history.

---

## Architecture

```
Intent Parser → Static Analysis ┐
                                 ├→ Context Compiler → Budget Scheduler → Provider Adapter (LLM)
            Wiki / Memory Layer ┘                                              │
                                                                               ▼
                        Reasoning Extractor ← IR Parser ← Structured Output (IR)
                                 │
                                 ▼
                  Wiki Updater · Checkpointer · Token Ledger  → Persistent Storage
```

| Layer | Module | LLM? |
|---|---|---|
| Static analysis (tree-sitter, LSP, dep graph, call graph, embeddings, coverage, repo map, file watcher) | `src/analysis/` | never |
| Repository Knowledge Graph (typed nodes/edges + query engine) | `src/rkg/` | never |
| Storage (SQLite via `node:sqlite`) | `src/storage/` | never |
| Memory (long-term / session / reasoning, decay, compression, cold storage) | `src/storage/`, `src/memory/` | never |
| Wiki (markdown + versioning + conflict detection + bootstrap) | `src/wiki/` | bootstrap only |
| Context compiler + budget scheduler | `src/context/` | never |
| Event bus | `src/events/` | never |
| Providers (Anthropic, OpenAI, Gemini) + accounts + encrypted credentials | `src/providers/` | — |
| Worker framework + scheduler | `src/workers/base.ts`, `scheduler.ts` | — |
| IR parser, patch applier, intent parser | `src/workers/` | never |
| Planner, TaskExecutor, Verifier, ModuleSummarizer, MemoryCompressor, ConflictResolver | `src/workers/` | yes |
| Checkpointer + crash recovery | `src/workers/checkpointer.ts`, `src/daemon/recovery.ts` | never |
| Token analytics + budget enforcement | `src/analysis/tokenAnalytics.ts`, `src/context/` | never |
| Plugin system | `src/plugins/` | — |
| Session lifecycle | `src/daemon/sessionManager.ts` | — |
| Command router | `src/commands/` | never |
| TUI (Ink/React) | `src/index.tsx`, `src/components/` | — |

---

## Install

```bash
git clone https://github.com/Chai-B/CodeMaster
cd CodeMaster
npm install
npm start          # or: node bin/codemaster.js
```

**Requirements:** Node.js 22+ (uses the built-in `node:sqlite`). Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and/or `GEMINI_API_KEY` to enable planning/execution. Optional: `ripgrep` for faster search (falls back to a built-in scanner); `pyright`/`typescript-language-server` for LSP queries (degrades gracefully if absent). The local embedding model (`Xenova/all-MiniLM-L6-v2`) downloads once on first `/reindex`, then runs offline.

Run `npm test` for the suite, `npm run typecheck` for types.

---

## Usage

Run `codemaster` (or `npm start`) inside any repository. Type an objective to start a session, or use a command.

```
/new <objective>     create a session, index the repo, and plan
/plan                (re)generate the execution plan
/tasks               list tasks
/run · /runall       execute the next / all pending tasks
/context             show the compiled prompt (no LLM call)
/pause · /resume     checkpoint and restore sessions
/wiki · /reasoning   browse persisted knowledge
/tokens · /stats     token accounting
/help                full command catalog (spec §17.2)
```

Deterministic commands (`/reindex`, `/graph`, `/wiki`, `/tokens`, …) work without an API key. Only `/plan`, `/run`, and `/runall` invoke the model.

---

## Data layout (spec §19.3)

```
~/.codemaster/
├── codemaster.db        # sessions, tasks, reasoning, memory, wiki, tokens, checkpoints
├── config.yaml          # global config
├── wiki/                # markdown mirror of the wiki, with .versions/
└── sessions/<id>/checkpoints/<id>/   # self-sufficient snapshots

<repo>/.codemaster/index.db           # per-repo symbol / file / module index (gitignored)
```

---

## Status

Implements the full SPEC.md architecture: tree-sitter parsing, LSP, dependency + call graphs, ML embedding index, coverage, incremental file watching, the Repository Knowledge Graph, four memory stores with decay/compression/cold-storage, the Karpathy wiki with bootstrap + versioning, deterministic context compilation with budget enforcement, three provider adapters (Anthropic/OpenAI/Gemini) with encrypted credentials and lossless handoff, the worker framework + scheduler, IR pipeline, reasoning persistence/replay, checkpointing + crash recovery, token analytics, the plugin system, and the complete command surface — verified by an automated test suite.
