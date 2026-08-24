# CodeMaster Next
## A Persistent Reasoning Operating System for AI Software Engineering

**Version:** 0.1 — Draft Specification  
**Status:** Pre-implementation  
**Author:** Chaitanya Bansal  
**Repository:** github.com/Chai-B/CodeMaster

---

> *"Every token spent must either create new knowledge or generate code. Everything else should be handled deterministically."*

---

## Table of Contents

1. [Vision and Motivation](#1-vision-and-motivation)
2. [Design Philosophy](#2-design-philosophy)
3. [System Overview](#3-system-overview)
4. [Architecture](#4-architecture)
5. [Static Analysis Layer](#5-static-analysis-layer)
6. [Repository Knowledge Graph](#6-repository-knowledge-graph)
7. [Memory System](#7-memory-system)
8. [Reasoning Engine](#8-reasoning-engine)
9. [The Wiki Layer — Karpathy-Inspired Persistent Knowledge](#9-the-wiki-layer--karpathy-inspired-persistent-knowledge)
10. [Context Compiler](#10-context-compiler)
11. [Context Budget Scheduler](#11-context-budget-scheduler)
12. [Worker Architecture](#12-worker-architecture)
13. [Provider and Account Manager](#13-provider-and-account-manager)
14. [Session Management and Checkpointing](#14-session-management-and-checkpointing)
15. [Intermediate Representation (IR)](#15-intermediate-representation-ir)
16. [Compression Pipeline](#16-compression-pipeline)
17. [Command System](#17-command-system)
18. [Plugin System](#18-plugin-system)
19. [Storage Layer](#19-storage-layer)
20. [Token Profiler and Budget Accounting](#20-token-profiler-and-budget-accounting)
21. [Event Bus](#21-event-bus)
22. [Security and Authentication](#22-security-and-authentication)
23. [CLI and Terminal UX](#23-cli-and-terminal-ux)
24. [Testing Strategy](#24-testing-strategy)
25. [Performance Goals](#25-performance-goals)
26. [Implementation Roadmap](#26-implementation-roadmap)
27. [Appendices](#27-appendices)

---

## 1. Vision and Motivation

### 1.1 The Problem with Existing AI Coding Assistants

Every major AI coding assistant available today — Claude Code, Codex, Gemini CLI, Aider, Cursor — shares a fundamental architectural limitation that has nothing to do with model capability.

They are stateless.

Each session begins from zero. The model spends the first several hundred to several thousand tokens rediscovering what already exists: repository structure, conventions, architectural decisions, past failures, and work already completed. If a developer switches from Claude to Gemini mid-task, the new model has no access to the reasoning that preceded it. If the terminal crashes, planning state is lost. If the context window fills, older reasoning falls off and may need to be regenerated. If the task spans multiple days, each day begins with the overhead of re-establishing context.

This is not a model problem. Models have become extraordinarily capable.

This is an infrastructure problem.

The models are powerful CPUs with no operating system sitting beneath them.

### 1.2 The Operating System Analogy

Consider how a traditional operating system relates to a CPU. The CPU is powerful but raw. It executes instructions, but it does not manage its own memory, schedule its own processes, maintain its own filesystem, or recover from its own failures. The OS does all of that. The CPU is an execution engine. The OS is the persistent layer that makes the CPU useful over time.

Current AI coding tools have powerful CPUs. They have no OS.

CodeMaster Next is that OS.

It manages memory. It compiles context. It schedules workers. It maintains structured state. It checkpoints sessions. It handles provider switching. It builds and maintains repository intelligence. It preserves and replays reasoning. It treats LLMs as interchangeable execution engines rather than the source of truth.

### 1.3 Karpathy's LLM OS Wiki Insight

Andrej Karpathy's notion of treating LLMs as operating systems with peripherals introduces a critical idea for persistent memory: the **wiki model**.

Rather than storing chat transcripts, an LLM OS should maintain a living, structured document — a wiki — that is continuously updated as new knowledge is acquired. This wiki becomes the canonical source of truth about the repository, the project, the decisions made, the conventions established, and the work completed.

Every session reads from this wiki. Every session writes back to it.

The wiki is not a log. It is not a transcript. It is not a memory dump.

It is a continuously curated, structured encyclopedia of everything the system knows about the project.

When Claude generates architecture reasoning, that reasoning does not go into a chat log. It goes into the wiki as a structured decision object under the `architecture` namespace.

When a developer establishes a coding convention, that convention does not live in a `.cursorrules` file that the model may or may not read. It becomes a permanent wiki entry that is deterministically injected into every relevant prompt.

When a function is refactored, the repository knowledge graph is updated, the affected wiki entries are flagged for review, and the model is not asked to rediscover what changed.

This is the foundational idea that separates CodeMaster Next from every existing AI coding tool.

### 1.4 What CodeMaster Next Is Not

- It is not another AI coding assistant.
- It is not a wrapper around Claude Code.
- It is not a multi-agent chatbot framework.
- It is not a prompt engineering toolkit.
- It is not a plugin for an existing editor.

It is a persistent reasoning runtime — an operating system layer that transforms any supported AI coding model into a session-persistent, token-efficient, provider-agnostic, reasoning-preserving engineering agent.

---

## 2. Design Philosophy

### 2.1 The Five Hard Rules

These rules are not guidelines. They are architectural constraints. Every design decision in this system must be consistent with all five.

---

**Rule 1: Never ask an LLM something a script can answer.**

If the answer can be computed deterministically, it must be computed deterministically.

Examples:

| Question | Deterministic Tool |
|---|---|
| Which files import this function? | Tree-sitter + ripgrep |
| Where is this symbol defined? | Language Server Protocol |
| What changed since the last checkpoint? | Git diff |
| What is the cyclomatic complexity of this module? | AST analysis |
| Which tests cover this file? | Coverage data + static analysis |
| What modules depend on the auth layer? | Dependency graph traversal |
| What are all the exported symbols in this package? | AST indexing |
| Which files are most similar to this one? | Embeddings + cosine similarity |

None of these should ever consume a single LLM token.

---

**Rule 2: Never ask the same reasoning twice.**

Every significant reasoning step is immediately converted into a structured knowledge object and written to persistent storage. Future model invocations receive the conclusion, not the conversation.

Instead of a model spending 3,000 tokens reasoning about whether to use Redis or Postgres for a queue:

```yaml
decision:
  id: decision-0042
  question: "Should we use Redis or Postgres for the job queue?"
  answer: "Postgres with SKIP LOCKED"
  reasoning: >
    The repository already uses Postgres extensively. Adding Redis would 
    introduce a new infrastructure dependency. SKIP LOCKED provides 
    sufficient throughput for expected job volume (<10k/day). Redis 
    would only be justified above ~100k jobs/day.
  alternatives_rejected:
    - option: Redis
      reason: "Additional infrastructure dependency not justified by throughput requirements"
    - option: RabbitMQ
      reason: "Operational overhead too high for current team size"
  confidence: 0.93
  affected_files: ["src/queue/", "migrations/"]
  created_at: "2025-01-15T14:32:00Z"
  created_by: "claude-opus-4"
  session_id: "session-20250115-143200"
```

This object is stored. Future models receive it verbatim. Zero tokens are spent re-deriving it.

---

**Rule 3: Never store chats. Store state.**

A chat log is a side effect of computation. It has minimal reuse value.

Structured state is the computation itself. It has maximum reuse value.

The difference:

**Chat (low value):**
```
User: What do you think about the authentication architecture?
Assistant: Great question! Looking at the codebase, I can see that...
User: What about the middleware chain?
Assistant: The middleware chain currently...
```

**State (high value):**
```yaml
architecture:
  authentication:
    approach: "JWT middleware chain"
    entry_point: "src/middleware/auth.ts"
    token_expiry: "24h"
    refresh_strategy: "sliding window"
    known_issues:
      - "Token invalidation on password reset not yet implemented"
    decisions:
      - ref: decision-0038
      - ref: decision-0041
```

The chat answered questions in the moment. The state answers questions forever, with zero tokens.

---

**Rule 4: Never send an entire repository to a model.**

The model receives only what it needs to complete the current task. Everything else stays on disk.

The pipeline:

```
Repository (100,000 files)
↓
Repository Knowledge Graph (structured index)
↓
Task-Relevant Subgraph (filtered by current objective)
↓
Context Compiler (ranked, compressed, assembled)
↓
Model receives ~20 files maximum
```

The model should not know 99% of the repository exists.

---

**Rule 5: Never allow context drift.**

Every prompt is assembled deterministically from structured state. Not from conversation history. Not from memory of what was said earlier. Not from vague summaries.

Each invocation begins with a compiled snapshot of exactly what the model needs and nothing it doesn't.

### 2.2 Tokens Are a Scarce Resource

Tokens should be treated like CPU cycles in an embedded system — precious and rationed.

The economics of LLM usage make this a concrete engineering concern. A single reasoning-heavy session can consume hundreds of thousands of tokens. At scale, this becomes expensive. More importantly, wasted tokens mean degraded output quality — every token spent on redundant context is a token not spent on the actual problem.

The system must track, budget, and account for every token spent. Overspend on context is a bug, not an acceptable cost.

### 2.3 The Model Is a Replaceable CPU

No part of the system's state should be owned by, or dependent on, any specific model provider.

This has several implications:

- Session state must be provider-agnostic.
- The intermediate representation must be consumable by any supported model.
- Provider-specific prompting must be abstracted behind an adapter layer.
- Switching providers mid-session must be lossless.

Claude, Codex, Gemini, GPT, and future models are execution engines. The runtime is the operating system.

---

## 3. System Overview

### 3.1 Top-Level Data Flow

```
Developer
    │
    ▼
┌─────────────────────────────────────────────────┐
│                  Intent Parser                   │
│  (Parses objective, extracts constraints,        │
│   identifies relevant session/project context)   │
└─────────────────────┬───────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
┌─────────────────┐   ┌───────────────────────────┐
│  Static Analysis │   │       Wiki / Memory        │
│  Layer           │   │       Layer                │
│  (AST, LSP, Git, │   │  (Decisions, Architecture, │
│   Graphs, Embed) │   │   Conventions, Reasoning)  │
└────────┬────────┘   └────────────┬──────────────┘
          │                         │
          └───────────┬─────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│               Context Compiler                   │
│  (Assembles optimal context from structured      │
│   state. Never from raw conversation history.)   │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│           Context Budget Scheduler               │
│  (Allocates token budget across context          │
│   components based on task type)                 │
└─────────────────────┬───────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼           ▼           ▼
     ┌─────────┐ ┌─────────┐ ┌─────────┐
     │  Claude  │ │  Codex  │ │ Gemini  │ ...
     └────┬────┘ └────┬────┘ └────┬────┘
          └───────────┼───────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│            Structured Output (IR)                │
│  (Model output normalized to intermediate        │
│   representation regardless of provider)         │
└─────────────────────┬───────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
   ┌───────────┐ ┌─────────┐ ┌──────────┐
   │ Reasoning │ │  Wiki   │ │  Check-  │
   │ Extractor │ │ Updater │ │  pointer │
   └───────────┘ └─────────┘ └──────────┘
          │           │           │
          └───────────┼───────────┘
                      │
                      ▼
              Persistent Storage
```

### 3.2 What Each Layer Is Responsible For

**Intent Parser:** Converts developer input into a structured task object. Extracts objective, constraints, scope, and links to relevant session history. Never calls an LLM if the intent can be resolved from structured commands.

**Static Analysis Layer:** Maintains continuously updated repository intelligence using deterministic tooling. This layer is the reason the model never needs to "understand the repo from scratch."

**Wiki / Memory Layer:** The Karpathy-inspired living knowledge base. Everything the system knows about the project lives here in structured, versioned, searchable form.

**Context Compiler:** Assembles a prompt from structured state components. The only thing that ever reaches a model is the compiled output of this layer.

**Context Budget Scheduler:** Enforces token budgets across context components. Adapts allocation based on task type.

**Provider Adapters:** Translate the compiled context and intermediate representation into provider-specific prompt formats.

**Structured Output / IR:** Normalizes model responses back into structured objects regardless of which model produced them.

**Reasoning Extractor:** Parses model output for decisions, assumptions, risks, and conclusions, converting them to structured reasoning objects.

**Wiki Updater:** Writes new knowledge back to the wiki layer. Handles conflict detection, deduplication, and versioning.

**Checkpointer:** Creates periodic snapshots of full session state. Enables crash recovery, session resume, and model handoff.

---

## 4. Architecture

### 4.1 Process Model

CodeMaster Next is architected as a multi-process runtime with the following top-level processes:

```
codemaster-daemon          # Main orchestration process
├── static-analyzer        # Continuous repository indexing
├── memory-manager         # Wiki and memory layer
├── session-manager        # Session lifecycle management
├── provider-manager       # Model provider connections and health
├── checkpoint-manager     # Automated checkpointing
├── event-bus              # Inter-process event routing
└── cli-server             # IPC endpoint for CLI commands
```

The daemon process is long-running and survives individual task sessions. It maintains in-memory caches for hot data (active session state, recent repository index updates) and persists all durable state to disk.

### 4.2 Core Data Structures

#### 4.2.1 Session Object

```typescript
interface Session {
  id: string;                          // UUID
  created_at: ISO8601DateTime;
  updated_at: ISO8601DateTime;
  status: 'active' | 'paused' | 'completed' | 'failed';
  
  objective: string;                   // Natural language goal
  objective_parsed: ParsedObjective;   // Structured interpretation
  
  repository: RepositoryRef;           // Repo path and commit
  
  plan: ExecutionPlan;                 // Current task decomposition
  progress: ProgressState;            // Completed / remaining tasks
  
  architecture: ArchitectureSnapshot; // Current architectural understanding
  decisions: DecisionRef[];           // All decisions made in this session
  
  constraints: Constraint[];          // Hard limits on scope/approach
  open_questions: Question[];         // Unresolved uncertainties
  
  working_files: FileRef[];           // Files actively being modified
  
  provider_history: ProviderRef[];    // Which providers have been used
  current_provider: ProviderRef;      // Active provider
  
  checkpoints: CheckpointRef[];       // All checkpoints for this session
  latest_checkpoint: CheckpointRef;
  
  token_usage: TokenBudget;           // Running token account
  
  metadata: Record<string, unknown>;
}
```

#### 4.2.2 Task Object

```typescript
interface Task {
  id: string;
  session_id: string;
  parent_task_id?: string;
  
  title: string;
  description: string;
  type: 'plan' | 'implement' | 'test' | 'review' | 'verify' | 'refactor' | 'debug';
  
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'skipped';
  
  input_files: FileRef[];
  output_files: FileRef[];
  
  dependencies: TaskRef[];            // Tasks that must complete first
  blocking: TaskRef[];                // Tasks this is blocking
  
  assigned_provider?: ProviderRef;
  assigned_account?: AccountRef;
  
  reasoning_refs: ReasoningRef[];     // Reasoning objects produced
  decision_refs: DecisionRef[];       // Decisions made
  
  started_at?: ISO8601DateTime;
  completed_at?: ISO8601DateTime;
  failed_at?: ISO8601DateTime;
  failure_reason?: string;
  
  estimated_tokens: number;
  actual_tokens?: number;
  
  output?: TaskOutput;
  patches?: Patch[];
}
```

#### 4.2.3 Reasoning Object

```typescript
interface ReasoningObject {
  id: string;
  session_id: string;
  task_id: string;
  
  type: 'decision' | 'observation' | 'hypothesis' | 'risk' | 'assumption' | 'constraint';
  
  question?: string;                  // What was being reasoned about
  conclusion: string;                 // The conclusion reached
  
  evidence: Evidence[];               // What supports the conclusion
  alternatives_considered: Alternative[];
  
  confidence: number;                 // 0.0 – 1.0
  
  affected_files: FileRef[];
  affected_modules: string[];
  affected_decisions: DecisionRef[];  // Decisions this reasoning produced
  
  implications: string[];             // What this means for future work
  risks: Risk[];
  
  produced_by: ProviderRef;
  produced_at: ISO8601DateTime;
  
  wiki_keys: string[];                // Where this was written in the wiki
  
  expires_at?: ISO8601DateTime;       // Optional: for ephemeral observations
  permanent: boolean;                 // Permanent objects never expire
}
```

---

## 5. Static Analysis Layer

### 5.1 Purpose and Scope

The Static Analysis Layer is the single most important token-saving component in the system.

Its job: maintain a continuously updated, fully structured understanding of the repository using only deterministic tooling. When any other layer needs to know something about the repository, it queries this layer. Under no circumstances does it ask a model.

### 5.2 Component Inventory

#### 5.2.1 Tree-sitter Parser

Tree-sitter provides fast, incremental, error-tolerant parsing across all major programming languages. It produces concrete syntax trees that can be traversed to extract:

- All function/method definitions and their signatures
- All class definitions and their members
- All import/export statements
- All variable declarations at module scope
- All type definitions and interfaces
- Docstrings and inline comments
- Decorators and annotations

Tree-sitter parsers run incrementally. When a file changes, only the changed subtrees are re-parsed. A full repository re-parse is never required unless the index is rebuilt from scratch.

**Supported languages (initial):** Python, TypeScript, JavaScript, Go, Rust, Java, C, C++, Ruby, Swift.

**Languages are added via grammar plugins. No hardcoded language support.**

#### 5.2.2 Language Server Protocol Integration

LSP servers provide semantic analysis beyond what syntax trees alone can offer:

- Go-to-definition across files and packages
- Find-all-references
- Type inference
- Symbol renaming impact analysis
- Hover documentation
- Diagnostic information (type errors, unused imports, etc.)

The system maintains an LSP server process per active repository language. LSP queries are serviced synchronously (with timeout) by the static analysis layer.

**Initial LSP support:** pyright (Python), typescript-language-server (TypeScript/JS), rust-analyzer (Rust), gopls (Go), jdtls (Java).

#### 5.2.3 Dependency Graph Builder

A directed graph where:
- Nodes are modules, packages, or files (configurable granularity)
- Edges represent import relationships

The graph is maintained incrementally via Tree-sitter change events. When a file's imports change, only that node's edges are recomputed.

Graph queries supported:
- `dependencies_of(module)` — direct and transitive
- `dependents_of(module)` — direct and transitive (reverse edges)
- `impact_of_change(file)` — all potentially affected files
- `shortest_path(a, b)` — how does A depend on B?
- `cycles()` — all circular dependency cycles
- `strongly_connected_components()` — tightly coupled clusters

#### 5.2.4 Call Graph Builder

A directed graph where:
- Nodes are functions/methods
- Edges represent call relationships

Built from AST analysis of function call expressions. Supports:

- `callers_of(function)` — what calls this function?
- `callees_of(function)` — what does this function call?
- `call_chain(entry_point)` — full execution path from an entry point
- `dead_code_candidates()` — functions with zero callers

#### 5.2.5 Symbol Index

A flat index mapping every symbol name (function, class, variable, type) to:
- Defining file and line
- All reference locations (file, line)
- Type signature
- Documentation

Supports fuzzy and exact lookup. Updated incrementally on file changes.

#### 5.2.6 Git Integration

Git provides temporal and authorship context:

- `changes_since(ref)` — files and hunks changed since a commit or tag
- `blame(file)` — author/commit per line
- `log(file, n)` — recent commit history for a file
- `diff(commit_a, commit_b)` — structured diff between two states
- `stash_list()` — available stash entries
- `branch_status()` — current branch, ahead/behind remote

The checkpointing system uses git commits to anchor repository state at session boundaries.

#### 5.2.7 Ripgrep Integration

For text-pattern search at filesystem scale. Used when:

- Searching for string literals
- Finding configuration keys
- Locating usages of string-identified APIs
- Scanning comments for TODOs, FIXMEs, HACKs

Results are structured (file, line, column, context) and cached.

#### 5.2.8 Embedding Index

Every function, class, and module has a vector embedding computed from its source code and documentation. Stored in a local vector database (sqlite-vec or DuckDB with vss extension).

Used for:
- Finding semantically similar functions before generating a new one
- Locating the most relevant existing code for a given task description
- Detecting duplicate logic across the codebase

Embeddings are recomputed for changed files only. Batch recomputation on full index rebuild.

#### 5.2.9 Coverage Integration

When test coverage data is available (lcov, Istanbul, tarpaulin outputs), the system maps:
- Which lines are covered by which test files
- Which functions have zero coverage
- Coverage percentage per module

This prevents models from being asked "does this have tests?" when the answer is deterministic.

#### 5.2.10 Repository Map Generator

Produces a hierarchical summary of the repository:

```yaml
repository_map:
  name: "MyJobAtlas"
  total_files: 847
  languages:
    TypeScript: 62%
    Python: 28%
    SQL: 8%
    Other: 2%
  
  top_level_modules:
    - name: "src/api"
      role: "FastAPI backend, REST endpoints"
      files: 142
      key_files: ["main.py", "routers/jobs.py", "routers/auth.py"]
    
    - name: "src/matching"
      role: "pgvector-based job matching engine"
      files: 23
      key_files: ["engine.py", "scorer.py", "embeddings.py"]
    
    - name: "src/scanners"
      role: "Gmail and GitHub inbox scanners"
      files: 31
      key_files: ["gmail.py", "github.py", "classifier.py"]
    
    - name: "frontend/src"
      role: "Next.js 14 frontend"
      files: 198
      key_files: ["app/page.tsx", "components/JobCard.tsx"]
```

The repository map is generated deterministically and updated incrementally. It is one of the primary context injections into every model invocation.

### 5.3 Incremental Indexing Pipeline

```
File system event (inotify/FSEvents/kqueue)
        │
        ▼
Changed file detected
        │
        ▼
Tree-sitter incremental parse
        │
    ┌───┴───┐
    ▼       ▼
Symbol    Import/Export
Update    Change?
    │       │
    │       ▼
    │  Dependency graph
    │  edge update
    │       │
    └───┬───┘
        │
        ▼
Call graph update
(for changed functions only)
        │
        ▼
Embedding recompute
(for changed symbols only)
        │
        ▼
Repository map diff
        │
        ▼
Wiki entries flagged for review
(if architectural files changed)
        │
        ▼
Event emitted: repository.index.updated
```

Full re-index is only triggered on:
- First-time initialization
- Explicit `/reindex` command
- Recovery from a corrupted index

### 5.4 Static Analysis API

All layers access static analysis through a typed query interface. No raw file access.

```typescript
interface StaticAnalysisAPI {
  // Symbol queries
  findDefinition(symbol: string, context?: FileRef): SymbolLocation[];
  findReferences(symbol: string): SymbolLocation[];
  findSimilar(symbol: string, topK?: number): SimilarSymbol[];
  
  // Dependency queries
  getDependencies(module: string, transitive?: boolean): Module[];
  getDependents(module: string, transitive?: boolean): Module[];
  getImpactOf(file: FileRef): FileRef[];
  getCycles(): DependencyCycle[];
  
  // Call graph queries
  getCallers(fn: string): FunctionRef[];
  getCallees(fn: string): FunctionRef[];
  getCallChain(entry: string): CallGraph;
  
  // Repository overview
  getRepositoryMap(depth?: number): RepositoryMap;
  getModuleSummary(module: string): ModuleSummary;
  
  // Temporal queries
  getChangedFilesSince(ref: string): ChangedFile[];
  getDiffSince(ref: string): StructuredDiff;
  getBlame(file: FileRef): BlameResult;
  
  // Search
  search(pattern: string, options?: SearchOptions): SearchResult[];
  
  // Coverage
  getCoverage(file?: FileRef): CoverageReport;
  getUncoveredFunctions(): FunctionRef[];
}
```

---

## 6. Repository Knowledge Graph

### 6.1 What It Is

The Repository Knowledge Graph (RKG) is a persistent, structured, continuously maintained semantic model of the entire codebase. Where the Static Analysis Layer produces factual, syntactic data (what exists where), the RKG adds semantic meaning (what it means, how it relates, why it exists).

The RKG is the bridge between raw code structure and wiki-level understanding.

### 6.2 Node Types

```typescript
// Every node in the RKG
type RKGNode = FileNode | ModuleNode | FunctionNode | ClassNode | ConceptNode | DecisionNode | ConventionNode;

interface FileNode {
  type: 'file';
  path: string;
  language: string;
  purpose: string;                    // One-sentence human-readable purpose
  responsibilities: string[];         // What this file is responsible for
  architectural_role: string;         // e.g., "entry point", "data model", "utility"
  
  exports: SymbolRef[];
  imports: ImportRef[];
  
  test_files: FileRef[];              // Test files that test this
  documentation: string;             // Extracted or inferred documentation
  
  last_modified: ISO8601DateTime;
  change_frequency: 'high' | 'medium' | 'low';  // Based on git history
  
  wiki_entry?: WikiKey;               // If there is a wiki entry for this file
}

interface ModuleNode {
  type: 'module';
  path: string;
  name: string;
  
  purpose: string;
  responsibilities: string[];
  public_api: SymbolRef[];
  internal_components: string[];
  
  dependencies: ModuleRef[];
  dependents: ModuleRef[];
  
  conventions: ConventionRef[];       // Coding conventions specific to this module
  decisions: DecisionRef[];           // Architecture decisions affecting this module
  
  owner?: string;                     // Team or developer responsible
  stability: 'stable' | 'evolving' | 'experimental' | 'deprecated';
  
  wiki_entry?: WikiKey;
}

interface ConceptNode {
  type: 'concept';
  name: string;
  description: string;
  
  implementing_files: FileRef[];
  related_concepts: ConceptRef[];
  decisions: DecisionRef[];
  
  // e.g., "pgvector matching", "JWT authentication", "LangGraph pipeline"
}
```

### 6.3 Edge Types

```typescript
type RKGEdge = 
  | { type: 'imports'; from: FileRef; to: FileRef; symbol?: string }
  | { type: 'tests'; from: FileRef; to: FileRef }
  | { type: 'implements'; from: FileRef; to: ConceptRef }
  | { type: 'depends_on'; from: ModuleRef; to: ModuleRef }
  | { type: 'governed_by'; from: FileRef; to: DecisionRef }
  | { type: 'follows'; from: FileRef; to: ConventionRef }
  | { type: 'documents'; from: WikiKey; to: ModuleRef }
  | { type: 'supersedes'; from: DecisionRef; to: DecisionRef }
  | { type: 'conflicts_with'; from: DecisionRef; to: DecisionRef };
```

### 6.4 Graph Queries

The RKG supports Cypher-like traversal queries through an internal query engine. Example queries:

```
FIND files
WHERE implements('authentication')
AND NOT has_tests
RETURN path, purpose, change_frequency

FIND decisions
WHERE affects('src/api/auth')
ORDER BY created_at DESC
LIMIT 10

FIND modules
WHERE depends_on('src/database')
AND stability = 'evolving'
RETURN name, dependents, decisions
```

These queries are used by the Context Compiler to assemble relevant context without LLM involvement.

### 6.5 Automatic RKG Population

The RKG is partially auto-populated from Static Analysis Layer outputs. The following fields are deterministic:

- File paths, languages, imports/exports, test file relationships
- Module dependencies and dependents
- Symbol locations and references

The following fields require one-time LLM generation and are then permanently stored:

- `purpose` (one-sentence description of a file/module)
- `responsibilities` (bulleted list of what it owns)
- `architectural_role` (semantic classification)

Once generated, these fields do not change unless the file fundamentally changes. Staleness is detected via git diff analysis, not by re-asking the model speculatively.

---

## 7. Memory System

### 7.1 Architecture Overview

The Memory System is composed of four distinct stores. They have different persistence characteristics, different access patterns, and different compression strategies.

```
┌────────────────────────────────────────────────────┐
│                  Memory System                      │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │  Long-Term  │  │   Session   │  │ Repository │ │
│  │   Memory    │  │   Memory    │  │   Memory   │ │
│  │  (Permanent)│  │  (Ephemeral)│  │(Incremental│ │
│  └──────┬──────┘  └──────┬──────┘  └─────┬──────┘ │
│         │                │               │         │
│         └────────────────┼───────────────┘         │
│                          │                         │
│                  ┌───────┴──────┐                  │
│                  │  Reasoning   │                  │
│                  │   Memory     │                  │
│                  │  (Indexed)   │                  │
│                  └──────────────┘                  │
└────────────────────────────────────────────────────┘
```

### 7.2 Long-Term Memory

**Persistence:** Permanent. Survives indefinitely.

**Contents:**

- Architecture decisions (from all past sessions)
- Repository conventions and coding standards
- Developer preferences (inferred and explicit)
- Project goals and non-goals
- Permanent documentation entries
- Known external system constraints
- Historical failure patterns

**Storage backend:** SQLite (structured) + markdown files (human-readable wiki layer)

**Access pattern:** Read on every session start. Write when new permanent knowledge is produced. Never auto-expires.

**Schema excerpt:**

```sql
CREATE TABLE long_term_memory (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,           -- e.g., 'architecture', 'conventions', 'preferences'
  key TEXT NOT NULL,                 -- e.g., 'authentication.approach'
  value_json TEXT NOT NULL,          -- structured JSON value
  value_markdown TEXT,               -- human-readable version
  importance REAL NOT NULL,          -- 0.0 – 1.0, used for context prioritization
  confidence REAL NOT NULL,          -- 0.0 – 1.0
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_session_id TEXT,
  source_decision_id TEXT,
  tags TEXT,                         -- comma-separated
  permanent BOOLEAN DEFAULT TRUE
);
```

### 7.3 Session Memory

**Persistence:** Session-scoped. Deleted or archived when session ends.

**Contents:**

- Current objective
- Active execution plan
- Working file set
- Open questions and blockers
- Scratch notes and intermediate observations
- Pending tasks and their states
- Recent git diffs
- Current architectural snapshot

**Storage backend:** In-memory (Redis or SQLite WAL mode for durability within session)

**Access pattern:** High-frequency read/write. Snapshotted into checkpoints periodically.

**Key difference from long-term memory:** Session memory is about "what we're doing right now." It is not designed to survive past the current session. Important items are promoted to long-term memory at session completion.

### 7.4 Repository Memory

**Persistence:** Project-scoped. Survives across sessions but is invalidated by structural changes.

**Contents:**

- Repository map snapshots
- Module summaries
- Dependency graph snapshots
- Embedding index
- Static analysis cache
- File-level summaries (purpose, responsibilities)

**Storage backend:** SQLite for structured data, DuckDB/sqlite-vec for embeddings.

**Invalidation:** File-level. When a file changes, only its entries are invalidated and recomputed. The rest of repository memory remains valid.

### 7.5 Reasoning Memory

**Persistence:** Permanent for important reasoning; ephemeral for exploratory reasoning.

**Contents:**

Every structured reasoning object produced during any session. This is the core of the Karpathy wiki idea applied to reasoning:

```yaml
reasoning_objects:
  - id: "reasoning-0001"
    type: "decision"
    question: "How should job scraping handle rate limits?"
    conclusion: "Exponential backoff with jitter, max 5 retries"
    evidence:
      - "LinkedIn blocks IPs after >50 req/min without backoff"
      - "Existing scrapers in the repo use simple retry without jitter"
    alternatives:
      - option: "Simple fixed retry"
        rejected_because: "Causes thundering herd on rate limit recovery"
      - option: "Skip on any rate limit"
        rejected_because: "Too aggressive, loses valid job data"
    confidence: 0.89
    permanent: true
    tags: ["scraping", "rate-limits", "resilience"]
```

**Access pattern:** Searchable by tags, affected modules, session, provider, date. Used during context compilation to inject relevant past reasoning.

**Compression:** Reasoning objects older than 30 days that have not been referenced are summarized and compressed. The full text is archived but the active index entry is replaced with a summary.

### 7.6 Memory Lifecycle

Every memory object carries lifecycle metadata:

```typescript
interface MemoryLifecycle {
  importance: number;        // 0.0 – 1.0 (higher = more likely to survive compression)
  confidence: number;        // 0.0 – 1.0 (lower = sooner compressed)
  recency_weight: number;    // Decays over time
  reference_count: number;   // How many times has this been accessed?
  permanent: boolean;        // If true, never expires or compresses
  
  created_at: ISO8601DateTime;
  last_accessed_at: ISO8601DateTime;
  expires_at?: ISO8601DateTime;
}
```

**Decay function:**

```
effective_importance(t) = importance × confidence × (1 + log(1 + reference_count)) × recency_decay(t)

recency_decay(t) = exp(-0.05 × days_since_creation(t))
```

Permanent memories bypass this calculation entirely.

**Compression trigger:** When a memory's `effective_importance(t)` falls below a configurable threshold, it is:
1. Summarized via a lightweight LLM call (≤200 tokens)
2. The summary replaces the full object in the active index
3. The full object is archived to cold storage

**Conflict resolution:** When two memory objects contradict each other, a conflict record is created. The system creates a verification task that, when next executed, asks the model to resolve the conflict explicitly. Until resolved, both entries are presented to the model with the conflict flagged.

---

## 8. Reasoning Engine

### 8.1 Reasoning as First-Class Data

In every existing AI coding system, reasoning is ephemeral. It exists in the context window during generation, then disappears. The only way to recover it is to regenerate it — spending the same tokens again.

CodeMaster Next treats reasoning as a first-class, persistent, structured artifact.

This changes the economics of AI-assisted engineering fundamentally. Reasoning is an investment, not an operating cost. You pay for it once. You benefit from it indefinitely.

### 8.2 Reasoning Object Taxonomy

```
ReasoningObject
├── Decision           -- A choice made between alternatives
├── Observation        -- A factual observation about the codebase
├── Hypothesis         -- An untested belief about the system
├── Risk               -- An identified risk or potential failure
├── Assumption         -- A premise being taken as true without full verification
└── Constraint         -- A hard limit on what approaches are acceptable
```

Each type has a specific schema. The common base:

```typescript
interface ReasoningBase {
  id: string;
  type: ReasoningType;
  session_id: string;
  task_id: string;
  
  summary: string;                   // One sentence
  detail: string;                    // Full elaboration
  
  evidence: Evidence[];
  confidence: number;
  
  produced_by: ProviderRef;
  produced_at: ISO8601DateTime;
  
  affected_files: FileRef[];
  affected_modules: string[];
  
  tags: string[];
  permanent: boolean;
  
  wiki_keys: string[];               // Wiki entries this feeds into
}
```

#### Decision-specific fields:
```typescript
interface Decision extends ReasoningBase {
  type: 'decision';
  question: string;
  answer: string;
  alternatives_rejected: AlternativeRejection[];
  implications: string[];
  reversibility: 'easy' | 'medium' | 'hard' | 'irreversible';
  supersedes?: DecisionRef;
}
```

#### Risk-specific fields:
```typescript
interface Risk extends ReasoningBase {
  type: 'risk';
  risk_description: string;
  likelihood: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high' | 'critical';
  mitigation_strategy?: string;
  monitoring_approach?: string;
  status: 'open' | 'mitigated' | 'accepted' | 'realized';
}
```

### 8.3 Reasoning Extraction Pipeline

After every model invocation, the raw output passes through the Reasoning Extractor:

```
Raw Model Output
      │
      ▼
Structured Output Parser
(Extracts IR blocks from output)
      │
      ▼
Reasoning Block Detector
(Identifies reasoning-eligible content)
      │
      ▼
Reasoning Classifier
(Assigns type: decision/observation/risk/etc.)
      │
      ▼
Field Extractor
(Populates structured reasoning object fields)
      │
      ▼
Deduplication Check
(Does an equivalent reasoning object already exist?)
      │
    ┌─┴─┐
  New  Dup
    │    │
    ▼    ▼
  Store  Merge (update reference_count and evidence)
    │
    ▼
Wiki Updater
(Write to wiki namespace if applicable)
    │
    ▼
Event emitted: reasoning.new
```

### 8.4 Reasoning Replay

When starting a new session on a project with history, the system does not replay conversations. It replays reasoning.

The Reasoning Replay Engine:

1. Queries reasoning objects relevant to the current session's objective
2. Ranks them by importance and relevance
3. Compiles them into a "Prior Reasoning Summary" section of context
4. Includes only the conclusions and key evidence — not the full elaboration

A model receiving a replayed reasoning context knows:
- What architectural decisions have been made and why
- What approaches were tried and failed
- What risks have been identified
- What assumptions the codebase is built on

This typically takes 2–8K tokens and replaces what would otherwise be a 50–200K token onboarding conversation.

### 8.5 Failure Memory

Every failed approach is stored as a special class of reasoning object:

```typescript
interface FailureRecord {
  id: string;
  session_id: string;
  task_id: string;
  
  approach_attempted: string;
  why_it_failed: string;
  evidence_of_failure: string[];
  
  alternatives_suggested: string[];
  
  affected_files: FileRef[];
  confidence_in_failure_diagnosis: number;
  
  created_at: ISO8601DateTime;
  permanent: boolean;
}
```

Failure memory prevents the system from repeating previously failed approaches in new sessions. It is injected into context as a "Known Non-Working Approaches" section when relevant.

---

## 9. The Wiki Layer — Karpathy-Inspired Persistent Knowledge

### 9.1 The Core Idea

Karpathy's LLM OS vision introduces the idea that a language model operating over long time horizons should not store interaction logs — it should maintain a wiki.

A wiki is a curated, structured, continuously updated encyclopedia of knowledge about a domain. In the context of software engineering, this means:

- Every architecture decision has a wiki entry, not just a chat log
- Every coding convention is documented, not just mentioned once
- Every module has a description that is maintained as the module evolves
- Every known bug or limitation is tracked, not buried in conversation history
- Every external dependency has a wiki entry documenting why it was chosen

The wiki is not a log. It does not record what happened. It records what is true.

### 9.2 Wiki Structure

The wiki is organized as a hierarchical namespace:

```
wiki/
├── architecture/
│   ├── overview.md
│   ├── authentication.md
│   ├── database.md
│   ├── api_design.md
│   └── frontend.md
│
├── decisions/
│   ├── 0001-use-postgres-for-queue.md
│   ├── 0002-jwt-authentication.md
│   └── 0042-pgvector-for-matching.md
│
├── conventions/
│   ├── naming.md
│   ├── error_handling.md
│   ├── testing.md
│   └── api_versioning.md
│
├── modules/
│   ├── api/
│   │   ├── overview.md
│   │   ├── jobs_router.md
│   │   └── auth_router.md
│   ├── matching/
│   └── scanners/
│
├── failures/
│   ├── rate_limit_naive_retry.md
│   └── sync_gmail_scan_timeout.md
│
├── external_dependencies/
│   ├── pgvector.md
│   ├── langgraph.md
│   └── supabase.md
│
├── open_questions/
│   └── active.md
│
└── roadmap/
    └── current.md
```

Every entry is markdown with a structured front-matter block:

```markdown
---
wiki_id: "arch-authentication"
title: "Authentication Architecture"
namespace: "architecture"
status: "current"
confidence: 0.95
last_updated: "2025-07-01"
last_updated_by_session: "session-20250701-142300"
related_decisions:
  - decision-0002
  - decision-0015
related_files:
  - "src/middleware/auth.ts"
  - "src/api/routers/auth.py"
tags: ["authentication", "jwt", "middleware", "security"]
---

# Authentication Architecture

## Summary

JWT-based authentication via middleware chain. Tokens issued at login, validated on every protected route. Refresh tokens use sliding window with 7-day expiry.

## Details

...
```

### 9.3 Wiki Update Protocol

Wiki entries are updated according to the following rules:

**Trigger for update:**
- A new decision is made that affects a wiki entry's domain
- Code changes modify files referenced by a wiki entry
- A model explicitly produces a wiki update as part of a task output
- A manual `/wiki update <key>` command is issued

**Update process:**

1. The WikiUpdater receives a proposed update (from reasoning extraction, decision recording, or model output)
2. It reads the existing wiki entry
3. It checks for conflicts with existing content
4. If no conflicts: applies the update, versions the previous content
5. If conflicts: creates a conflict record, queues a resolution task
6. Emits `wiki.updated` event

**What is never in the wiki:**

- Conversation transcripts
- Raw model output
- Debugging logs
- Token counts
- Provider-specific information

The wiki is purely semantic knowledge about the project. Never operational metadata.

### 9.4 Wiki Access During Context Compilation

The Context Compiler has a Wiki Reader component that:

1. Identifies which wiki namespaces are relevant to the current task
2. Extracts relevant sections (not full entries — sections)
3. Formats them for injection into the prompt
4. Tracks which wiki keys were read (for provenance tracking)

Wiki injection is always explicit and budgeted. The model always knows it is receiving wiki content, not conversation history. The prompt section heading is always `## Project Knowledge (from wiki)`.

### 9.5 Wiki Versioning

Every wiki entry is versioned. Changes are stored as diffs against the previous version. This enables:

- Viewing the history of an architectural decision
- Rolling back a wiki entry to a previous state
- Auditing what a model "knew" at any given session

Versioning uses a simple append-only log per wiki entry:

```
wiki/.versions/arch-authentication/
├── 20250601_143200.md
├── 20250615_092100.md
└── 20250701_142300.md   ← current
```

### 9.6 Wiki Initialization

On first run against a new repository, the system does an initial wiki bootstrap:

1. Run full static analysis
2. Generate repository map
3. For each module with more than N files: generate a module wiki entry using one LLM call
4. Generate a top-level architecture overview entry
5. Extract any existing documentation (README, CONTRIBUTING, docs/) and import into wiki

Total initial bootstrap token cost is bounded at approximately 50K–150K tokens depending on repository size. This is a one-time investment. All future sessions benefit from it.

---

## 10. Context Compiler

### 10.1 What the Context Compiler Does

The Context Compiler is the final stage before a model invocation. Its job is to assemble the optimal prompt from structured state components, subject to token budget constraints.

It never reads conversation history. It reads state.

### 10.2 Context Components

Every prompt is assembled from a fixed set of possible components:

```typescript
enum ContextComponent {
  OBJECTIVE          = 'objective',
  EXECUTION_PLAN     = 'execution_plan',
  CURRENT_TASK       = 'current_task',
  ARCHITECTURE       = 'architecture',
  REPOSITORY_MAP     = 'repository_map',
  RELEVANT_FILES     = 'relevant_files',
  RECENT_CHANGES     = 'recent_changes',
  PRIOR_REASONING    = 'prior_reasoning',
  OPEN_QUESTIONS     = 'open_questions',
  CONSTRAINTS        = 'constraints',
  KNOWN_FAILURES     = 'known_failures',
  CONVENTIONS        = 'conventions',
  WIKI_SECTIONS      = 'wiki_sections',
  CHECKPOINT_STATE   = 'checkpoint_state',
  PROVIDER_HANDOFF   = 'provider_handoff',
}
```

Each component is compiled independently from its source layer:

| Component | Source |
|---|---|
| OBJECTIVE | Session object |
| EXECUTION_PLAN | Session plan (YAML) |
| CURRENT_TASK | Task object |
| ARCHITECTURE | Wiki: architecture/ |
| REPOSITORY_MAP | Static Analysis Layer |
| RELEVANT_FILES | File selector (deterministic ranking) |
| RECENT_CHANGES | Git integration |
| PRIOR_REASONING | Reasoning Memory (filtered) |
| OPEN_QUESTIONS | Session memory |
| CONSTRAINTS | Session object + wiki |
| KNOWN_FAILURES | Failure Memory (filtered) |
| CONVENTIONS | Wiki: conventions/ |
| WIKI_SECTIONS | Wiki Reader (task-specific) |
| CHECKPOINT_STATE | Checkpointer |
| PROVIDER_HANDOFF | Session Manager (handoff only) |

### 10.3 File Selection Algorithm

The RELEVANT_FILES component is the most complex to assemble. The system must select the right ~10–30 files from potentially hundreds of thousands.

File selection is fully deterministic:

```
Input: Current task description + current task type

Step 1: Direct mentions
  Extract explicitly named files from task description.
  Score: 1.0

Step 2: Dependency graph expansion
  For each directly mentioned file:
    - Add its direct dependencies (score: 0.8)
    - Add its direct dependents if task_type in ('refactor', 'review') (score: 0.6)

Step 3: Embedding similarity
  Embed task description.
  Find top-K most similar functions/files by cosine similarity.
  Score: 0.5–0.7 depending on similarity

Step 4: Git proximity
  Files changed in the same commits as directly mentioned files (git log).
  Score: 0.4

Step 5: Call graph expansion
  If task involves a specific function:
    - Add all callers (score: 0.5)
    - Add all callees (score: 0.6)

Step 6: Coverage expansion
  If task_type = 'test':
    - Add test files for all selected files

Step 7: Budget-aware selection
  Sort by score descending.
  Greedily add files until token budget for RELEVANT_FILES is exhausted.
  Compress less important files to function signatures only if needed.
```

No model call is made at any point in this pipeline.

### 10.4 Prompt Structure

The assembled prompt follows a fixed structure. Every prompt has the same sections in the same order. This is intentional — determinism and reproducibility matter.

```markdown
# CodeMaster Context

## Objective
{objective}

## Current Task
{current_task_yaml}

## Execution Plan
{plan_yaml}

## Project Knowledge (from wiki)
{relevant_wiki_sections}

## Architecture Context
{architecture_summary}

## Repository Map
{repository_map_excerpt}

## Prior Reasoning (relevant to this task)
{prior_reasoning_objects}

## Known Failures (relevant to this task)
{known_failures}

## Conventions
{relevant_conventions}

## Constraints
{constraints}

## Open Questions
{open_questions}

## Recent Changes
{git_diff_summary}

## Files for This Task
{relevant_files}

## Instructions
{task_instructions}

## Output Format
{output_format_specification}
```

Fields that are empty or not relevant to the task are omitted entirely. The prompt is minimal, not maximal.

### 10.5 Output Format Specification

Every prompt ends with an explicit output format specification. The model is always told exactly what to return:

```markdown
## Output Format

Respond using the following structure only. No prose outside of these tags.

<task_result>
  <status>completed|partial|failed|blocked</status>
  <summary>One sentence summary of what was done</summary>
  <patches>
    <patch file="relative/path/to/file">
    --- a/relative/path/to/file
    +++ b/relative/path/to/file
    @@ ... @@
    ...
    </patch>
  </patches>
  <reasoning>
    <decision question="..." answer="..." confidence="0.0-1.0">
      <evidence>...</evidence>
      <alternatives>...</alternatives>
    </decision>
    <risk likelihood="low|medium|high" impact="low|medium|high|critical">
      <description>...</description>
      <mitigation>...</mitigation>
    </risk>
  </reasoning>
  <wiki_updates>
    <update key="wiki/key/path">New content or diff</update>
  </wiki_updates>
  <open_questions>
    <question>...</question>
  </open_questions>
  <next_tasks>
    <task priority="high|medium|low">...</task>
  </next_tasks>
</task_result>
```

Structured output is mandatory. Free-form responses are rejected by the output parser and the task is flagged for retry with clarification.

---

## 11. Context Budget Scheduler

### 11.1 Budget Philosophy

The Context Budget Scheduler enforces the constraint that every token in the context window serves a purpose. It treats the context window as a finite resource — not a dumping ground.

Different task types require different allocations:

### 11.2 Default Budget Profiles

```yaml
budget_profiles:
  
  planning:
    objective: 3%
    execution_plan: 5%
    architecture: 15%
    repository_map: 15%
    prior_reasoning: 20%   # Heavy reasoning investment
    wiki_sections: 15%
    relevant_files: 15%
    conventions: 5%
    constraints: 5%
    scratchpad: 2%
  
  implementation:
    objective: 2%
    current_task: 5%
    architecture: 8%
    repository_map: 10%
    relevant_files: 45%    # Heavy file investment
    recent_changes: 10%
    prior_reasoning: 8%
    conventions: 8%
    constraints: 4%
  
  debugging:
    objective: 3%
    current_task: 5%
    recent_changes: 25%    # Heavy diff investment
    relevant_files: 35%
    known_failures: 10%
    prior_reasoning: 10%
    architecture: 7%
    constraints: 5%
  
  refactoring:
    objective: 3%
    architecture: 12%
    repository_map: 25%    # Heavy map investment
    relevant_files: 35%
    conventions: 10%
    prior_reasoning: 10%
    constraints: 5%
  
  testing:
    objective: 3%
    current_task: 5%
    relevant_files: 40%
    conventions: 15%
    architecture: 10%
    prior_reasoning: 15%
    constraints: 5%
    scratchpad: 7%
  
  review:
    objective: 3%
    recent_changes: 30%
    relevant_files: 30%
    conventions: 15%
    architecture: 10%
    prior_reasoning: 10%
    constraints: 2%
```

### 11.3 Dynamic Budget Adjustment

Budgets are adjusted dynamically based on:

1. **Available context window:** Different providers have different limits. The scheduler adapts.
2. **Compression results:** If a component compresses smaller than expected, the saved space is redistributed.
3. **Task-specific signals:** If the task explicitly names 15 files, `relevant_files` gets more budget.
4. **Prior failure:** If a previous attempt failed due to insufficient reasoning context, the retry increases `prior_reasoning` budget by 10%.

### 11.4 Budget Enforcement

Components are compiled in priority order. When cumulative size approaches the budget ceiling:

1. Lower-priority components are compressed first
2. File contents are reduced to signatures if the file budget is exceeded
3. Reasoning objects are summarized to 2–3 sentences
4. Wiki sections are reduced to key bullet points
5. If still over budget after all compressions: lowest-priority components are dropped and flagged in the output metadata

The model always receives a budget summary comment at the top of the context:

```
<!-- Context compiled at 2025-07-01T14:23:00Z
     Provider: claude-opus-4 (200k context)
     Tokens used: 48,230 / 200,000
     Components: objective, architecture, repository_map, 
                 prior_reasoning, relevant_files (12 files), conventions
     Omitted: known_failures (none relevant), open_questions (none active)
-->
```

---

## 12. Worker Architecture

### 12.1 Philosophy

Workers are the operating system processes of CodeMaster Next. Like OS processes, they:

- Have a single, well-defined responsibility
- Communicate through structured contracts, not freeform language
- Are independently replaceable
- Are independently testable
- Can run in parallel where dependencies allow

Unlike AI agents in multi-agent frameworks, most workers are deterministic. LLM-backed workers are the exception, not the rule.

### 12.2 Worker Catalog

#### Core Workers (Deterministic)

**IntentParser**
- Input: Raw developer input (string)
- Output: ParsedIntent (structured task, objective, constraints, context refs)
- LLM: Never (uses pattern matching + keyword extraction)

**StaticIndexer**
- Input: FileChangeEvent
- Output: IndexUpdate
- LLM: Never (pure AST + LSP)

**DependencyGraphUpdater**
- Input: IndexUpdate (import changes)
- Output: GraphMutation
- LLM: Never

**FileSelector**
- Input: Task, RepositoryGraph, TokenBudget
- Output: RankedFileList
- LLM: Never (scoring algorithm)

**ContextCompiler**
- Input: Session, Task, BudgetProfile, SelectedFiles
- Output: CompiledPrompt
- LLM: Never (assembly from structured components)

**OutputParser**
- Input: RawModelOutput (string)
- Output: StructuredIR or ParseError
- LLM: Never (XML/YAML parser)

**PatchApplier**
- Input: Patch[]
- Output: ApplyResult
- LLM: Never (unified diff application)

**Checkpointer**
- Input: Session, trigger: 'periodic' | 'pre-switch' | 'manual' | 'pre-risky'
- Output: Checkpoint
- LLM: Never

**TokenAccountant**
- Input: ModelInvocation, response headers/metadata
- Output: TokenRecord
- LLM: Never

**WikiReader**
- Input: Task, WikiIndex
- Output: RelevantWikiSections[]
- LLM: Never (keyword + semantic matching)

#### Core Workers (LLM-Backed)

**Planner**
- Input: Objective, Architecture, RepositoryMap, SessionHistory
- Output: ExecutionPlan (structured YAML)
- LLM: Yes (planning is genuinely hard reasoning)
- Context: Heavy on architecture, wiki, repository map; minimal file content

**TaskExecutor**
- Input: Task, CompiledPrompt
- Output: TaskOutput (patches, reasoning, wiki updates)
- LLM: Yes (code generation is the primary LLM task)

**Verifier**
- Input: Patch, OriginalTask, Conventions, TestResults
- Output: VerificationResult (pass/fail/partial + issues)
- LLM: Yes (semantic verification requires reasoning)

**ReasoningExtractor**
- Input: RawModelOutput, Context
- Output: ReasoningObject[]
- LLM: Optional (structured extraction, often deterministic from XML tags)

**ModuleSummarizer**
- Input: Module (files, exports, structure)
- Output: ModuleSummary (purpose, responsibilities)
- LLM: Yes, but one-time per module at bootstrap

**ConflictResolver**
- Input: ConflictRecord (two contradictory wiki entries or memory objects)
- Output: Resolution (which is correct, or merge, or keep both)
- LLM: Yes (requires judgment)

**MemoryCompressor**
- Input: MemoryObject[] (old, low-importance)
- Output: MemorySummary[]
- LLM: Yes (summarization requires language understanding)

#### Utility Workers (Deterministic)

**GitWorker**
- Wraps git operations with structured input/output
- Operations: diff, log, blame, stash, commit, branch

**EmbeddingWorker**
- Input: text
- Output: vector
- Uses local embedding model (no LLM API call)

**RipgrepWorker**
- Input: pattern, scope
- Output: SearchResult[]

**LSPWorker**
- Input: LSPQuery
- Output: LSPResponse

### 12.3 Worker Contract

Every worker implements the same interface:

```typescript
interface Worker<TInput, TOutput> {
  name: string;
  version: string;
  requires_llm: boolean;
  
  validate(input: TInput): ValidationResult;
  execute(input: TInput, context: WorkerContext): Promise<TOutput>;
  
  // Optional lifecycle hooks
  on_success?(output: TOutput, context: WorkerContext): void;
  on_failure?(error: WorkerError, context: WorkerContext): void;
}
```

Workers communicate only through their typed input and output contracts. No shared mutable state. No direct inter-worker communication. All coordination happens through the event bus or the scheduler.

### 12.4 Worker Scheduling

The Worker Scheduler maintains a dependency graph of worker invocations within a task execution:

```
Intent Parser
    │
    ├─→ Static Analyzer (if files changed)
    │
    └─→ Planner (if new session or objective changed)
            │
            └─→ TaskDecomposer
                    │
                    └─→ [for each task in parallel where safe]
                            │
                            ├─→ FileSelector
                            ├─→ WikiReader
                            ├─→ ReasoningRetriever
                            │
                            └─→ ContextCompiler
                                    │
                                    └─→ TaskExecutor (LLM)
                                            │
                                            ├─→ OutputParser
                                            ├─→ PatchApplier
                                            ├─→ ReasoningExtractor
                                            ├─→ WikiUpdater
                                            └─→ Checkpointer
```

The scheduler does not use an LLM to schedule. The dependency graph is static and known at compile time.

---

## 13. Provider and Account Manager

### 13.1 Provider Abstraction

Every supported model provider is accessed through a common interface:

```typescript
interface Provider {
  id: string;
  name: string;
  
  // Capabilities
  capabilities: {
    max_context_tokens: number;
    supports_streaming: boolean;
    supports_tool_use: boolean;
    supports_vision: boolean;
    native_languages: string[];  // Languages the model handles best
  };
  
  // Performance characteristics
  characteristics: {
    planning_quality: 1 | 2 | 3 | 4 | 5;
    code_generation_quality: 1 | 2 | 3 | 4 | 5;
    refactoring_quality: 1 | 2 | 3 | 4 | 5;
    speed_tier: 'fast' | 'medium' | 'slow';
    cost_tier: 'cheap' | 'medium' | 'expensive';
  };
  
  // Runtime state
  accounts: Account[];
  
  // Adapter (provider-specific)
  adapter: ProviderAdapter;
}
```

### 13.2 Account Manager

Each provider supports multiple authenticated accounts:

```typescript
interface Account {
  id: string;
  provider_id: string;
  
  alias: string;                     // Human-readable name, e.g., "claude-personal"
  
  // Authentication
  credential_ref: string;            // Reference to encrypted credential store
  auth_type: 'api_key' | 'oauth';
  
  // Quota state
  quota: {
    daily_token_limit: number;
    tokens_used_today: number;
    rate_limit_rpm: number;
    rate_limit_tpm: number;
    current_rpm: number;
    current_tpm: number;
    context_size: number;
    resets_at: ISO8601DateTime;
  };
  
  // Health state
  health: {
    status: 'healthy' | 'degraded' | 'unavailable';
    last_latency_ms: number;
    avg_latency_ms: number;
    error_rate_last_hour: number;
    last_checked_at: ISO8601DateTime;
    unavailable_since?: ISO8601DateTime;
    unavailable_reason?: string;
  };
  
  // Session state
  current_session_id?: string;
  last_used_at: ISO8601DateTime;
}
```

### 13.3 Account Selector

When a task needs an LLM invocation, the Account Selector chooses the optimal account:

```
Input: Task, required_tokens, task_type, preferred_provider?

Step 1: Filter by health
  Remove all accounts with health.status != 'healthy'

Step 2: Filter by capacity
  Remove accounts where tokens_used_today > daily_token_limit * 0.95

Step 3: Filter by rate limits
  Remove accounts where current_rpm > rate_limit_rpm * 0.8

Step 4: Filter by context size
  Remove accounts where context_size < required_tokens

Step 5: Score remaining accounts
  score = capability_match(task_type) 
        × (1 - tokens_used_today / daily_token_limit) 
        × (1 / avg_latency_ms)
        × preferred_provider_bonus

Step 6: Return highest scoring account
  If no accounts available: queue task and emit quota.exhausted event
```

### 13.4 Supported Providers (Initial)

| Provider | Models | Context | Strengths |
|---|---|---|---|
| Anthropic | claude-opus-4, claude-sonnet-4 | 200K | Planning, reasoning, long-context |
| OpenAI | gpt-4.1, o3 | 128K | Code generation, speed |
| Google | gemini-2.5-pro | 1M | Very long context, cheap |
| OpenAI Codex | codex-2 | 32K | Precise code edits |

Adding a new provider requires implementing the `ProviderAdapter` interface and registering the provider. No core system changes are needed.

### 13.5 Provider Adapter Interface

```typescript
interface ProviderAdapter {
  provider_id: string;
  
  // Format a compiled prompt for this specific provider
  format_prompt(compiled: CompiledPrompt): ProviderRequest;
  
  // Send request and return raw response
  invoke(request: ProviderRequest, account: Account): Promise<ProviderResponse>;
  
  // Parse raw response to intermediate representation
  parse_response(response: ProviderResponse): StructuredIR;
  
  // Health check
  ping(account: Account): Promise<HealthStatus>;
  
  // Extract token usage from response metadata
  extract_token_usage(response: ProviderResponse): TokenUsage;
}
```

Provider-specific prompt engineering (system prompts, prefills, tool use format) is entirely encapsulated in the adapter. The rest of the system never knows which provider it's talking to.

### 13.6 Session Handoff Protocol

When switching providers mid-session:

```
Pre-switch:
  1. Checkpoint current state
  2. Compile handoff package
  3. Validate handoff package completeness

Handoff package:
  - objective
  - completed_tasks (summary)
  - remaining_tasks
  - current_task_state
  - architecture_snapshot
  - key_decisions (last 20, most relevant)
  - working_files
  - recent_changes (git diff)
  - open_questions
  - constraints
  - relevant_conventions

Post-switch:
  1. New provider receives handoff package as initial context
  2. New provider acknowledges understanding (structured response)
  3. Execution resumes
  4. Session history updated with provider change event
```

The handoff package is not a transcript. The new provider does not read what was said before. It reads what was decided, what was done, and what remains.

---

## 14. Session Management and Checkpointing

### 14.1 Session Lifecycle

```
create_session(objective, repository)
        │
        ▼
Session Status: initializing
        │
        ├─→ Load repository knowledge
        ├─→ Load relevant wiki sections
        ├─→ Load relevant reasoning history
        └─→ Compile initial context
        │
        ▼
Session Status: planning
        │
        └─→ Planner worker (LLM)
                │
                ▼
        ExecutionPlan generated
        │
        ▼
Session Status: active
        │
        └─→ Task execution loop
                │
                ├─→ TaskExecutor (LLM)
                ├─→ PatchApplier
                ├─→ Verifier (LLM)
                ├─→ ReasoningExtractor
                └─→ WikiUpdater
        │
        ▼
All tasks completed?
        │
     ┌──┴──┐
    Yes    No
     │      └─→ Continue loop
     ▼
Session Status: completing
        │
        ├─→ Promote important session memory to long-term
        ├─→ Update wiki from session reasoning
        ├─→ Create final checkpoint
        └─→ Archive session
        │
        ▼
Session Status: completed
```

### 14.2 Checkpoint Contents

Every checkpoint is a complete, self-sufficient snapshot of session state:

```
checkpoints/
└── {session_id}/
    └── {checkpoint_id}/
        ├── manifest.json           # Checkpoint metadata
        ├── session.json            # Full session object
        ├── plan.yaml               # Current execution plan
        ├── reasoning_snapshot.db   # All reasoning objects so far
        ├── wiki_snapshot/          # Copy of all wiki entries
        │   └── {key}.md
        ├── repo.patch              # Git patch from session start to checkpoint
        ├── memory_snapshot.db      # Session memory state
        ├── worker_states.json      # State of each worker
        ├── token_ledger.json       # Token usage to date
        └── context_last.md         # Last compiled context (for debugging)
```

### 14.3 Checkpoint Triggers

Checkpoints are created automatically on:

- Every N minutes (configurable, default: 10 minutes)
- Before any risky operation (large patch, file deletion, breaking change)
- Before provider switch
- Before session pause
- On manual `/checkpoint` command
- After every successful task completion

### 14.4 Session Resume

```
/resume {session_id}
        │
        ▼
Load latest checkpoint
        │
        ▼
Verify repository state matches checkpoint
(git diff against repo.patch)
        │
   Matches?
    │     │
   Yes    No (repository has changed externally)
    │      │
    │      └─→ Conflict resolution wizard
    │              (show diff, ask developer how to proceed)
    ▼
Restore worker states
        │
        ▼
Recompile context from checkpoint state
        │
        ▼
Session Status: active (resumed)
```

### 14.5 Crash Recovery

If the daemon crashes mid-session:

1. On restart, detect incomplete sessions (status = 'active' with no recent heartbeat)
2. Load the last checkpoint for each incomplete session
3. Identify the task that was in-progress at crash
4. Check if its patch was partially applied (git status)
5. If partial application: revert to pre-task state
6. If no partial application: resume from last completed task
7. Present recovery summary to developer before continuing

---

## 15. Intermediate Representation (IR)

### 15.1 The Problem

Different providers return output in wildly different formats. Claude uses XML-tagged responses. GPT uses JSON tool calls. Gemini has its own function call syntax. Codex tends to return raw diffs.

If provider-specific format handling is scattered throughout the codebase, adding a new provider requires changes everywhere.

The Intermediate Representation (IR) solves this: every provider's output is normalized into the same structured format before any other system component touches it. Every provider's input is compiled from the same structured format.

### 15.2 IR Specification

```typescript
interface IntermediateRepresentation {
  // Meta
  ir_version: '1.0';
  session_id: string;
  task_id: string;
  produced_by: ProviderRef;
  produced_at: ISO8601DateTime;
  
  // Task outcome
  status: 'completed' | 'partial' | 'failed' | 'blocked' | 'needs_clarification';
  summary: string;
  
  // Code changes
  patches: Patch[];                  // Unified diff format
  files_created: NewFile[];
  files_deleted: FileRef[];
  files_renamed: FileRename[];
  
  // Reasoning
  decisions: Decision[];
  observations: Observation[];
  risks: Risk[];
  assumptions: Assumption[];
  
  // Wiki
  wiki_updates: WikiUpdate[];
  wiki_reads: WikiKey[];
  
  // Task management
  next_tasks: TaskSpec[];
  blocked_by: string[];              // Description of blockers
  open_questions: Question[];
  
  // Clarification
  clarification_needed?: string;
  
  // Confidence
  overall_confidence: number;
  
  // Debug
  raw_output?: string;               // Original provider output (archived, not used in system)
}
```

### 15.3 IR Parsing

Each ProviderAdapter implements an `ir_parser` that converts raw provider output to IR. This is the only place provider-specific format knowledge lives.

If parsing fails (malformed output, truncated response, hallucinated format):
1. The OutputParser logs a parse error
2. The task is retried with clarified output format instructions
3. If retry also fails, the task is marked `failed` and escalated to the developer

---

## 16. Compression Pipeline

### 16.1 Why Compression Matters

As sessions grow longer, the volume of accumulated reasoning, decisions, and context grows. Without compression, context windows would be dominated by historical information. With compression, the system maintains a compact, high-value representation of everything that matters.

### 16.2 Pipeline Stages

```
Raw model output
      │
      ▼
1. Structured Extraction
   (IR parsing: decisions, patches, wiki updates)
      │
      ▼
2. Reasoning Extraction
   (Convert all reasoning to structured objects)
      │
      ▼
3. Decision Indexing
   (Store decisions in reasoning memory, update wiki)
      │
      ▼
4. Patch Processing
   (Apply patches, update repository index)
      │
      ▼
5. Memory Update
   (Write to session + long-term memory as appropriate)
      │
      ▼
6. Wiki Update
   (Apply wiki_updates from IR)
      │
      ▼
7. Importance Scoring
   (Score all new objects for lifecycle management)
      │
      ▼
8. Deduplication
   (Merge with existing objects if near-identical)
      │
      ▼
9. Checkpoint
   (If checkpoint trigger condition met)
      │
      ▼
10. Archive raw output
    (Store for debugging/audit, not active use)
```

### 16.3 Session Summarization

At session completion, the session is summarized into a compact session record:

```yaml
session_summary:
  id: "session-20250701-142300"
  duration: "2h 34m"
  objective: "Implement GitHub scanner for tech stack verification"
  
  outcome: "completed"
  
  key_decisions:
    - "Used PyGitHub library for API access (decision-0089)"
    - "Rate limit handling via token bucket (decision-0090)"
    - "Cache scan results in Redis for 24h (decision-0091)"
  
  files_modified:
    - "src/scanners/github.py" (created)
    - "src/scanners/__init__.py" (modified)
    - "tests/test_github_scanner.py" (created)
    - "requirements.txt" (modified)
  
  tests_added: 12
  tests_passing: 12
  
  open_questions_resolved: 3
  open_questions_remaining: 1
  
  token_usage:
    total: 84_320
    by_provider:
      claude-opus-4: 52_100
      claude-sonnet-4: 32_220
  
  wiki_entries_updated: 2
  wiki_entries_created: 1
```

This summary is stored permanently and is always available as context for future sessions that work on related functionality.

---

## 17. Command System

### 17.1 Philosophy

Commands are first-class functionality. They are deterministic operations that invoke workers directly, without going through the full planning pipeline.

Commands exist for two reasons:
1. Developer control: explicit actions that shouldn't require a model
2. System inspection: visibility into the runtime's internal state

### 17.2 Command Catalog

#### Session Commands

**`/new <objective>`**  
Create a new session with the given objective. Triggers intent parsing, wiki load, repository map load, and planning.

**`/resume [session_id]`**  
Resume a paused or crashed session. Uses latest checkpoint. If session_id omitted, resumes most recent session.

**`/pause`**  
Pause the current session. Creates a checkpoint. Session can be resumed later.

**`/complete`**  
Mark the current session as complete. Triggers session summarization, memory promotion, and wiki update.

**`/session [list|info <id>]`**  
List all sessions or show details for a specific session.

---

#### Planning Commands

**`/plan`**  
(Re)generate the execution plan for the current session. Forces a planning worker invocation with the current state.

**`/tasks`**  
Show the current task list with status indicators.

**`/task <id>`**  
Show full detail for a specific task.

**`/skip <task_id>`**  
Mark a task as skipped. Useful when a task has been manually completed outside the system.

---

#### Provider Commands

**`/provider [list|use <provider_id>|status]`**  
List available providers, switch to a specific provider, or show current provider status.

**`/account [list|add|remove|status <id>]`**  
Manage provider accounts. Add new credentials, remove old ones, check quota status.

**`/handoff <provider_id>`**  
Explicitly trigger a session handoff to a different provider.

---

#### Memory and Wiki Commands

**`/memory [show|search <query>|promote <id>|expire <id>]`**  
Inspect and manage memory objects.

**`/wiki [show <key>|search <query>|update <key>|list]`**  
Interact with the wiki layer. Show a specific entry, search entries, or trigger an LLM-assisted update.

**`/reasoning [show <id>|search <query>|list]`**  
Browse reasoning objects. Search by tags, session, or content.

**`/forget <query>`**  
Mark specific memories or reasoning objects for expiration. Does not delete immediately — marks for next compression cycle.

---

#### Repository Commands

**`/reindex`**  
Trigger a full repository re-index from scratch. Slow but recovers from corrupted index.

**`/rebuild-map`**  
Regenerate the repository map. Faster than full reindex.

**`/graph [show <module>|visualize]`**  
Show the dependency or knowledge graph for a module, or generate a visualization.

---

#### Checkpoint Commands

**`/checkpoint`**  
Manually create a checkpoint.

**`/checkpoints [list|restore <id>|diff <id1> <id2>]`**  
Manage checkpoints. List all, restore to a previous state, or diff two checkpoints.

---

#### Diagnostic Commands

**`/tokens [session|total|by-provider|by-task]`**  
Show token usage statistics.

**`/context`**  
Show the context that would be compiled for the current task. Useful for debugging context quality.

**`/stats`**  
Show overall runtime statistics: sessions, tasks, tokens, providers, accounts.

**`/profile <task_id>`**  
Show detailed profiling information for a specific task: time in each worker, tokens per component, etc.

**`/health`**  
Show health status for all configured provider accounts.

**`/replay [session_id]`**  
Replay the reasoning from a previous session in structured form. No model calls — pure display.

**`/verbose [on|off]`**  
Toggle verbose reasoning trace output. Shows all worker decisions in real time.

---

## 18. Plugin System

### 18.1 Extension Points

Everything in the system is a plugin:

```
Providers        → Implement ProviderAdapter
Workers          → Implement Worker<TInput, TOutput>
Memory stores    → Implement MemoryStore
Static analyzers → Implement AnalyzerPlugin
Context builders → Implement ContextComponent
Compressors      → Implement CompressionStrategy
Output parsers   → Implement OutputParser
Commands         → Implement Command
Storage backends → Implement StorageBackend
Event handlers   → Register on EventBus
```

No core behavior is hardcoded. Every component can be replaced, extended, or supplemented by plugins.

### 18.2 Plugin Package Format

```
my-plugin/
├── plugin.json        # Plugin manifest
├── src/
│   └── index.ts       # Plugin entry point
├── tests/
└── README.md
```

`plugin.json`:

```json
{
  "id": "my-plugin",
  "version": "1.0.0",
  "name": "My Plugin",
  "description": "Adds support for X",
  "type": "provider|worker|memory|analyzer|command|storage",
  "entry_point": "src/index.ts",
  "requires": ["codemaster-next>=0.1.0"],
  "config_schema": {
    "type": "object",
    "properties": {
      "api_key": { "type": "string" }
    }
  }
}
```

### 18.3 Plugin Loading

Plugins are loaded at daemon startup. Hot-reloading is supported for non-critical plugins (commands, analyzers). Core plugins (storage, providers) require a daemon restart.

---

## 19. Storage Layer

### 19.1 Storage Architecture

The storage layer is organized around three tiers:

**Hot storage:** In-memory. Active session state, current checkpoint, hot reasoning objects. Sub-millisecond access.

**Warm storage:** SQLite (WAL mode). Recent sessions, reasoning objects, wiki entries, repository index. Low-millisecond access.

**Cold storage:** File system (structured JSON/YAML). Archived sessions, old checkpoints, raw model output. Access on demand only.

### 19.2 Database Schema

#### Primary Database (`codemaster.db`)

```sql
-- Sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  objective_parsed_json TEXT,
  repository_path TEXT NOT NULL,
  repository_commit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  current_plan_json TEXT,
  current_provider_id TEXT,
  current_account_id TEXT,
  token_usage_json TEXT,
  metadata_json TEXT
);

-- Tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_files_json TEXT,
  output_files_json TEXT,
  dependencies_json TEXT,
  assigned_provider_id TEXT,
  assigned_account_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  failure_reason TEXT,
  estimated_tokens INTEGER,
  actual_tokens INTEGER,
  output_json TEXT,
  patches_json TEXT
);

-- Reasoning objects
CREATE TABLE reasoning_objects (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_json TEXT,
  alternatives_json TEXT,
  confidence REAL NOT NULL,
  produced_by_json TEXT,
  produced_at TEXT NOT NULL,
  affected_files_json TEXT,
  affected_modules_json TEXT,
  tags TEXT,
  permanent BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TEXT,
  reference_count INTEGER DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0.5,
  wiki_keys TEXT
);

-- Memory (long-term)
CREATE TABLE long_term_memory (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_markdown TEXT,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_session_id TEXT,
  source_decision_id TEXT,
  tags TEXT,
  permanent BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(namespace, key)
);

-- Token ledger
CREATE TABLE token_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id TEXT REFERENCES tasks(id),
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  invocation_at TEXT NOT NULL,
  context_components_json TEXT,        -- What was in the context
  cost_usd REAL                        -- Estimated cost
);

-- Checkpoints
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  trigger TEXT NOT NULL,               -- 'periodic', 'manual', 'pre-switch', etc.
  git_commit TEXT,
  repository_path TEXT NOT NULL,
  storage_path TEXT NOT NULL,          -- Path to checkpoint directory
  size_bytes INTEGER,
  tasks_completed INTEGER,
  tasks_remaining INTEGER
);

-- Provider accounts
CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  credential_ref TEXT NOT NULL,        -- Reference to encrypted credential store
  auth_type TEXT NOT NULL,
  quota_json TEXT,
  health_json TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

-- Wiki
CREATE TABLE wiki_entries (
  id TEXT PRIMARY KEY,
  wiki_key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  namespace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current',
  confidence REAL NOT NULL DEFAULT 0.9,
  content_markdown TEXT NOT NULL,
  front_matter_json TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  last_updated_by_session TEXT,
  tags TEXT,
  related_files_json TEXT,
  related_decisions_json TEXT
);

-- Wiki version history
CREATE TABLE wiki_versions (
  id TEXT PRIMARY KEY,
  wiki_key TEXT NOT NULL,
  version_at TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  changed_by_session TEXT,
  change_summary TEXT
);
```

#### Repository Index Database (`{repo_path}/.codemaster/index.db`)

Stored within the repository (gitignored) for portability:

```sql
-- File index
CREATE TABLE file_index (
  path TEXT PRIMARY KEY,
  language TEXT,
  purpose TEXT,
  responsibilities_json TEXT,
  architectural_role TEXT,
  exports_json TEXT,
  imports_json TEXT,
  last_modified TEXT,
  last_indexed TEXT,
  ast_hash TEXT,
  embedding_id TEXT
);

-- Symbols
CREATE TABLE symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'function', 'class', 'variable', 'type', 'interface'
  file_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  signature TEXT,
  documentation TEXT,
  is_exported BOOLEAN,
  ast_hash TEXT
);

-- Symbol references
CREATE TABLE symbol_references (
  id TEXT PRIMARY KEY,
  symbol_id TEXT NOT NULL REFERENCES symbols(id),
  file_path TEXT NOT NULL,
  line INTEGER,
  reference_type TEXT              -- 'call', 'import', 'type_use', etc.
);

-- Dependency graph (edges)
CREATE TABLE dependency_edges (
  from_file TEXT NOT NULL,
  to_file TEXT NOT NULL,
  import_type TEXT,               -- 'named', 'default', 'namespace', 'side_effect'
  imported_symbols_json TEXT,
  PRIMARY KEY (from_file, to_file)
);

-- Embeddings (using sqlite-vec or stored as blob)
CREATE TABLE embeddings (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,      -- 'file', 'function', 'class', 'module'
  source_ref TEXT NOT NULL,
  embedding BLOB NOT NULL,        -- float32[] serialized
  embedding_model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 19.3 File System Layout

```
~/.codemaster/                    # Global data directory
├── codemaster.db                 # Primary database
├── config.yaml                   # Global configuration
├── credentials/                  # Encrypted credential store
│   └── {account_id}.enc
├── wiki/                         # Wiki entries
│   ├── architecture/
│   ├── decisions/
│   ├── conventions/
│   └── modules/
├── sessions/                     # Session archives
│   └── {session_id}/
│       ├── session.json
│       └── checkpoints/
│           └── {checkpoint_id}/
└── logs/                         # Daemon logs
    ├── daemon.log
    └── worker.log

{repo_path}/.codemaster/          # Per-repository data
├── index.db                      # Repository index
├── config.yaml                   # Repo-specific config (overrides global)
├── .gitignore                    # (auto-generated, ignores everything)
└── cache/                        # Temporary cache files
```

---

## 20. Token Profiler and Budget Accounting

### 20.1 Token Ledger

Every model invocation is recorded with complete metadata:

```typescript
interface TokenRecord {
  id: string;
  session_id: string;
  task_id: string;
  
  provider_id: string;
  account_id: string;
  model_id: string;
  
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;     // If provider supports prompt caching
  cache_write_tokens?: number;
  
  // Context breakdown
  context_breakdown: {
    component: ContextComponent;
    tokens: number;
    was_compressed: boolean;
  }[];
  
  // Timing
  invocation_started_at: ISO8601DateTime;
  first_token_at?: ISO8601DateTime;
  completed_at: ISO8601DateTime;
  total_latency_ms: number;
  
  // Cost
  estimated_cost_usd: number;
  
  // Was this efficient?
  wasted_tokens?: number;         // Tokens in context that were demonstrably unused
}
```

### 20.2 Token Budget Enforcement

At session creation, a token budget can be set:

```yaml
session_token_budget:
  total_limit: 500_000         # Hard limit
  warning_threshold: 400_000   # Emit warning event
  per_task_default: 20_000     # Per-task soft limit
  planning_budget: 30_000      # Budget for planning phase
```

When the budget is approached:
1. Warning emitted at threshold
2. Context compiler switches to more aggressive compression
3. Lower-priority context components are dropped
4. If hard limit reached: session paused, developer notified

### 20.3 Token Analytics

The system tracks token efficiency metrics:

**Tokens per task type:** Are implementation tasks more expensive than review tasks?

**Wasted context rate:** What percentage of injected context is the model actually using (approximated by measuring which injected sections the model's output references)?

**Compression effectiveness:** How much do different compression strategies reduce token usage?

**Provider efficiency:** Which provider produces the best output-per-token for a given task type?

These metrics are available via `/stats` and drive automatic optimization of budget profiles over time.

---

## 21. Event Bus

### 21.1 Event-Driven Architecture

All components communicate through a central event bus. No direct inter-component method calls for cross-cutting concerns. This enables:

- Loose coupling between components
- Easy addition of new listeners (logging, monitoring, new workers)
- Clear audit trail of everything that happens

### 21.2 Event Catalog

```typescript
// Repository events
type RepositoryEvent = 
  | { type: 'repository.file.changed'; path: string; change_type: 'created' | 'modified' | 'deleted' }
  | { type: 'repository.index.updated'; changed_files: string[] }
  | { type: 'repository.map.updated' }
  | { type: 'repository.git.committed'; commit: string }

// Session events
type SessionEvent =
  | { type: 'session.created'; session_id: string }
  | { type: 'session.started'; session_id: string }
  | { type: 'session.paused'; session_id: string }
  | { type: 'session.resumed'; session_id: string }
  | { type: 'session.completed'; session_id: string; summary: SessionSummary }
  | { type: 'session.failed'; session_id: string; error: string }

// Task events
type TaskEvent =
  | { type: 'task.created'; task: Task }
  | { type: 'task.started'; task_id: string }
  | { type: 'task.completed'; task_id: string; output: TaskOutput }
  | { type: 'task.failed'; task_id: string; reason: string }
  | { type: 'task.blocked'; task_id: string; blockers: string[] }

// Memory events
type MemoryEvent =
  | { type: 'memory.updated'; id: string; namespace: string }
  | { type: 'memory.compressed'; count: number }
  | { type: 'memory.conflict'; object_a: string; object_b: string }

// Wiki events
type WikiEvent =
  | { type: 'wiki.updated'; key: string }
  | { type: 'wiki.created'; key: string }
  | { type: 'wiki.conflict'; key: string }

// Reasoning events  
type ReasoningEvent =
  | { type: 'reasoning.new'; id: string; type: ReasoningType }
  | { type: 'reasoning.merged'; from: string; into: string }

// Provider events
type ProviderEvent =
  | { type: 'provider.invoked'; provider_id: string; account_id: string }
  | { type: 'provider.response'; provider_id: string; tokens: TokenUsage }
  | { type: 'provider.error'; provider_id: string; error: string }
  | { type: 'provider.rate_limited'; account_id: string; retry_after_ms: number }
  | { type: 'provider.switched'; from: string; to: string }

// Checkpoint events
type CheckpointEvent =
  | { type: 'checkpoint.created'; id: string; trigger: string }
  | { type: 'checkpoint.restored'; id: string }

// Quota events
type QuotaEvent =
  | { type: 'quota.warning'; account_id: string; percent_used: number }
  | { type: 'quota.exhausted'; account_id: string }
  | { type: 'quota.reset'; account_id: string }
```

### 21.3 Event Bus Implementation

The event bus is an in-process pub/sub system (not a message broker). For the initial implementation, a simple typed EventEmitter is sufficient. The interface is designed to be replaceable with a proper message queue (Redis Pub/Sub, NATS) if needed.

---

## 22. Security and Authentication

### 22.1 Credential Storage

API keys and OAuth tokens are never stored in plaintext. All credentials are encrypted at rest using a key derived from the system keychain (macOS Keychain, Linux Secret Service, Windows Credential Manager) or a master password.

The credential store is accessed exclusively through the `CredentialManager` interface:

```typescript
interface CredentialManager {
  store(account_id: string, credential: Credential): Promise<void>;
  retrieve(account_id: string): Promise<Credential>;
  delete(account_id: string): Promise<void>;
  list(): Promise<AccountId[]>;
}
```

No other component ever handles raw credentials.

### 22.2 Repository Isolation

Each repository has its own index database and configuration. Data from one repository never leaks into another. Wiki entries and reasoning objects are tagged with repository references and are not shared across repositories by default (can be opted in for monorepo setups).

### 22.3 Sensitive Content Handling

The system must handle the possibility that repository code contains secrets (API keys in code, passwords in configs, PII in test data). 

Rules:
- The static analysis layer indexes code structure, not code content
- File content is only loaded into memory at context compilation time
- Context is never logged in plaintext (only token counts and component names)
- Raw model output (which may contain file content) is archived in encrypted cold storage

### 22.4 Audit Log

All model invocations are logged with:
- Timestamp
- Provider and account (but not API key)
- Session and task
- Token counts
- Context component list (but not full context)

This audit log is immutable (append-only) and is not used by the system — it exists purely for security and compliance purposes.

---

## 23. CLI and Terminal UX

### 23.1 UX Philosophy

The CLI is the primary interface. It must be:
- Fast: commands respond in under 100ms (except those that invoke LLMs)
- Informative: the developer always knows what the system is doing and why
- Controllable: the developer can interrupt, inspect, or redirect at any time
- Transparent: no black boxes; every decision is inspectable

### 23.2 Terminal UI Layout

During an active session, the terminal shows a persistent status bar:

```
╔══════════════════════════════════════════════════════════════════════════════╗
║ CodeMaster Next │ Session: impl-github-scanner │ Task 3/7 │ Tokens: 42k/500k ║
║ Provider: claude-opus-4 (acct-A) │ Checkpoint: 8min ago │ Status: executing  ║
╚══════════════════════════════════════════════════════════════════════════════╝

[14:23:01] ▶ Task 3: Implement rate limit handling in github.py
[14:23:01] → Worker: FileSelector — selected 8 files (3.2k tokens)
[14:23:02] → Worker: WikiReader — loaded conventions/error_handling, modules/scanners
[14:23:02] → Worker: ContextCompiler — compiled 28,400 tokens (implementation profile)
[14:23:02] → Provider: claude-opus-4 invoked
[14:23:07] ← Provider: response received (842 tokens output)
[14:23:07] → Worker: OutputParser — parsed: 1 patch, 2 decisions, 0 risks
[14:23:07] → Worker: PatchApplier — applied patch to src/scanners/github.py
[14:23:08] → Worker: ReasoningExtractor — stored 2 reasoning objects
[14:23:08] → Worker: WikiUpdater — updated modules/scanners/overview
[14:23:08] ✓ Task 3 completed (7.2s, 29,242 tokens)

[14:23:08] ▶ Task 4: Write tests for rate limit handling
```

### 23.3 Verbose Mode

In verbose mode (`/verbose on`), every worker decision is expanded:

```
[14:23:01] → Worker: FileSelector
  Input: "Implement rate limit handling in GitHub scanner"
  Step 1 (direct mentions): src/scanners/github.py [1.0]
  Step 2 (dependencies): httpx [0.8], src/scanners/__init__.py [0.8]
  Step 3 (embeddings): src/scanners/gmail.py [0.62] — similar retry logic
  Step 4 (git proximity): requirements.txt [0.4]
  Step 5 (call graph): src/api/routes/scan.py [0.5] — calls github scanner
  Budget: 12,000 tokens for relevant_files
  Selected: 8 files (11,840 tokens)
  Dropped: httpx (stdlib, excluded), requirements.txt (low score, over budget)
```

### 23.4 Interactive Commands

The CLI supports interactive prompts for complex operations:

```
$ codemaster handoff
? Which provider would you like to switch to?
  ► claude-opus-4 (Account B) — 200k context, 100% quota remaining
    gpt-4.1 (Account A) — 128k context, 87% quota remaining
    gemini-2.5-pro (Personal) — 1M context, 92% quota remaining

? Confirm handoff? This will checkpoint the current session and resume on the new provider.
  ► Yes, handoff now
    No, cancel

[14:31:05] Creating checkpoint before handoff...
[14:31:06] ✓ Checkpoint created: checkpoint-0042
[14:31:06] Compiling handoff package...
[14:31:07] Switching to claude-opus-4 (Account B)...
[14:31:09] ✓ Handoff complete. Session resumed on new provider.
```

---

## 24. Testing Strategy

### 24.1 Testing Layers

**Unit tests:** Every worker has unit tests covering its core logic with mocked dependencies. Pure functions (scoring algorithms, parsers, formatters) have high coverage targets (>90%).

**Integration tests:** Multi-worker pipelines are tested with real filesystem, real git, and real SQLite. No mocked LLMs. Test repositories are checked into `tests/fixtures/`.

**Contract tests:** Every ProviderAdapter is tested against a mock server that validates the request format and exercises the response parser.

**End-to-end tests:** Full session simulations on test repositories, with a stubbed LLM that returns pre-scripted responses. These tests verify session lifecycle, checkpointing, and crash recovery.

**Property tests:** The reasoning deduplication algorithm, context budget scheduler, and file selection scoring are tested with property-based testing (fuzzing with valid inputs to check invariants).

### 24.2 LLM Testing Strategy

LLM-backed workers are tested at two levels:

**Deterministic wrapper tests:** The wrapper logic (prompt compilation, response parsing, error handling) is tested with mocked model responses. These tests never call a real API.

**Golden tests:** A small set of golden tests call real APIs against test repositories and check that the output matches expected structure (not content). These run in CI on a separate schedule (daily, not per-commit) due to cost and latency.

### 24.3 Repository Fixtures

The test suite includes several repository fixtures of varying complexity:

- `tiny-ts` — 5 TypeScript files, simple imports
- `small-python` — 20 Python files, flask app with tests
- `medium-monorepo` — 200 files across multiple languages
- `legacy-codebase` — Intentionally tangled dependencies, circular imports, missing tests

Each fixture has a known expected index state, making index correctness assertions possible.

---

## 25. Performance Goals

### 25.1 Response Time Targets

| Operation | Target |
|---|---|
| CLI command response (non-LLM) | < 100ms |
| Repository index update (single file) | < 500ms |
| Context compilation | < 1s |
| File selection (1000 files) | < 200ms |
| Wiki entry lookup | < 50ms |
| Checkpoint creation | < 5s |
| Session resume from checkpoint | < 10s |
| Repository map generation (1000 files) | < 30s |

### 25.2 Token Efficiency Targets

| Metric | Target |
|---|---|
| Token reduction vs. naive approach | 60–90% |
| Repeated reasoning overhead | < 5% |
| Repository context redundancy | < 10% |
| Context window utilization (useful content) | > 80% |

### 25.3 Scale Targets

| Metric | Target |
|---|---|
| Maximum repository size | 1M+ files (index only) |
| Maximum session duration | Unlimited (with checkpointing) |
| Maximum concurrent sessions | 10 (on single machine) |
| Maximum accounts per provider | 20 |
| Maximum supported providers | Unlimited (via plugins) |
| Checkpoint storage per session | < 100MB |
| Index storage overhead | < 5% of repository size |

### 25.4 Reliability Targets

| Metric | Target |
|---|---|
| Crash recovery success rate | > 99% |
| Checkpoint integrity | 100% (verified on write) |
| Session resume accuracy | 100% (no reasoning lost) |
| Provider handoff fidelity | 100% (no state lost) |

---

## 26. Implementation Roadmap

### 26.1 Phase 0 — Foundation (Weeks 1–4)

**Goal:** Basic working runtime with persistent state, no LLM integration yet.

Deliverables:
- [ ] Project scaffolding (TypeScript monorepo, tooling setup)
- [ ] Core data structures and type system
- [ ] SQLite storage layer with schema migrations
- [ ] Event bus implementation
- [ ] CLI skeleton with command routing
- [ ] Basic session lifecycle (create, pause, complete)
- [ ] Git integration (GitWorker)
- [ ] File system watching

**Success criteria:** Can create a session, record a task, and persist state to disk. Full CLI round-trip working.

---

### 26.2 Phase 1 — Static Analysis Layer (Weeks 5–10)

**Goal:** Complete deterministic repository intelligence.

Deliverables:
- [ ] Tree-sitter integration (Python, TypeScript, JavaScript)
- [ ] Symbol indexer
- [ ] Dependency graph builder
- [ ] Repository map generator
- [ ] Ripgrep integration (RipgrepWorker)
- [ ] Incremental indexing pipeline
- [ ] LSP integration (pyright, typescript-language-server)
- [ ] Basic embedding index (local model, e.g., nomic-embed-text)
- [ ] StaticAnalysisAPI implementation
- [ ] `/reindex`, `/rebuild-map`, `/graph` commands

**Success criteria:** Can answer "which files import X", "what does this module do", and "what changed since commit Y" without any LLM call.

---

### 26.3 Phase 2 — Memory and Wiki (Weeks 11–16)

**Goal:** Persistent knowledge foundation.

Deliverables:
- [ ] Long-term memory store
- [ ] Session memory store  
- [ ] Reasoning memory store with full schema
- [ ] Wiki layer implementation (CRUD, versioning)
- [ ] Wiki Reader (relevance-based extraction)
- [ ] Wiki Updater (with conflict detection)
- [ ] Memory lifecycle management (decay, compression triggers)
- [ ] `/memory`, `/wiki`, `/reasoning` commands
- [ ] Memory compression pipeline (stubs for LLM summarization)

**Success criteria:** Can store a decision object, retrieve it by tag, update the wiki, and load relevant wiki sections for a task.

---

### 26.4 Phase 3 — Context Compilation (Weeks 17–22)

**Goal:** Deterministic, optimal context assembly.

Deliverables:
- [ ] File selector (full scoring pipeline)
- [ ] Context compiler (all components)
- [ ] Context budget scheduler (all task type profiles)
- [ ] Reasoning retriever (relevance-based ranking)
- [ ] Prompt template system
- [ ] Output format specification generator
- [ ] `/context` command (show compiled context without invoking LLM)

**Success criteria:** Given a task and session state, can produce an optimal, budget-compliant prompt with no LLM call.

---

### 26.5 Phase 4 — First LLM Integration (Weeks 23–28)

**Goal:** Full end-to-end flow with Claude as the single provider.

Deliverables:
- [ ] Provider abstraction layer
- [ ] Claude adapter (claude-opus-4, claude-sonnet-4)
- [ ] Account manager (single account)
- [ ] Intermediate representation (IR) specification
- [ ] IR parser / OutputParser
- [ ] Reasoning extractor
- [ ] Patch applier
- [ ] Wiki updater (from IR)
- [ ] Planner worker (LLM-backed)
- [ ] TaskExecutor worker (LLM-backed)
- [ ] Verifier worker (LLM-backed)
- [ ] Token accountant
- [ ] Full session execution loop

**Success criteria:** Can run a complete coding session from objective to completed patches, with all reasoning persisted and the wiki updated.

---

### 26.6 Phase 5 — Checkpointing and Recovery (Weeks 29–32)

**Goal:** Crash-proof sessions.

Deliverables:
- [ ] Checkpoint creator (all required artifacts)
- [ ] Checkpoint restorer
- [ ] Crash detection and recovery flow
- [ ] `/checkpoint`, `/checkpoints`, `/resume` commands
- [ ] Session resume from arbitrary checkpoint
- [ ] Crash recovery integration tests

**Success criteria:** Can kill the daemon mid-task and resume from the last checkpoint with no state lost.

---

### 26.7 Phase 6 — Multi-Provider and Account Manager (Weeks 33–38)

**Goal:** Full provider independence.

Deliverables:
- [ ] OpenAI adapter (gpt-4.1)
- [ ] Gemini adapter (gemini-2.5-pro)
- [ ] Multi-account manager (multiple accounts per provider)
- [ ] Account selector (full scoring algorithm)
- [ ] Rate limit handling and backoff
- [ ] Quota tracking and warnings
- [ ] Session handoff protocol
- [ ] Provider health monitoring
- [ ] `/provider`, `/account`, `/handoff` commands
- [ ] Automatic failover on provider error

**Success criteria:** Can run a session across multiple providers and accounts, with automatic failover and lossless handoffs.

---

### 26.8 Phase 7 — Reasoning Replay and Wiki Bootstrap (Weeks 39–44)

**Goal:** Full wiki-first development experience.

Deliverables:
- [ ] Repository bootstrap (initial wiki generation)
- [ ] Reasoning replay engine
- [ ] Module summarizer worker
- [ ] Memory compression (LLM-backed)
- [ ] Failure memory integration
- [ ] Conflict resolution workflow
- [ ] `/replay` command
- [ ] Session summarization at completion
- [ ] Memory promotion pipeline (session → long-term)

**Success criteria:** Starting a new session on a familiar project takes <30 seconds and <10K tokens to reach full context, vs. 200K+ tokens in a naive approach.

---

### 26.9 Phase 8 — Plugin System and Polish (Weeks 45–52)

**Goal:** Extensible, production-ready system.

Deliverables:
- [ ] Plugin loading infrastructure
- [ ] Plugin manifest schema and validation
- [ ] Example plugins (additional language support, custom analyzers)
- [ ] Token profiler with analytics
- [ ] Verbose reasoning trace with full worker detail
- [ ] Complete CLI polish (all commands stable)
- [ ] Performance optimization pass
- [ ] Documentation (user guide, plugin development guide)
- [ ] Comprehensive test suite (unit, integration, e2e)

**Success criteria:** System meets all performance targets from Section 25. External developers can build and load plugins without modifying core code.

---

## 27. Appendices

### Appendix A: Configuration Reference

```yaml
# ~/.codemaster/config.yaml

daemon:
  port: 7432                         # IPC port
  log_level: info                    # debug|info|warn|error
  data_dir: ~/.codemaster

indexing:
  auto_index: true
  index_interval_ms: 1000            # How often to check for file changes
  full_reindex_on_startup: false
  max_file_size_bytes: 1_000_000     # Skip files larger than this
  excluded_patterns:
    - "node_modules/**"
    - ".git/**"
    - "dist/**"
    - "*.min.js"
  
  tree_sitter:
    languages: [python, typescript, javascript, rust, go]
  
  embeddings:
    model: nomic-embed-text-v1.5     # Local model
    batch_size: 64
    recompute_on_change: true

memory:
  compression:
    enabled: true
    schedule: "0 2 * * *"           # Daily at 2am
    importance_threshold: 0.3        # Compress below this
    age_days_before_eligible: 30
  
  wiki:
    auto_update: true
    conflict_strategy: queue         # queue|auto_merge|reject

context:
  default_profile: implementation
  max_files: 30
  file_compression_threshold: 8000  # Compress to signatures above this many tokens

providers:
  default: claude-opus-4
  
  anthropic:
    models:
      - id: claude-opus-4
        context_size: 200000
        cost_per_1m_input: 15.00
        cost_per_1m_output: 75.00
      - id: claude-sonnet-4
        context_size: 200000
        cost_per_1m_input: 3.00
        cost_per_1m_output: 15.00
  
  openai:
    models:
      - id: gpt-4.1
        context_size: 128000
        cost_per_1m_input: 2.00
        cost_per_1m_output: 8.00

checkpointing:
  enabled: true
  interval_minutes: 10
  max_checkpoints_per_session: 50   # Older ones archived
  pre_risky_threshold: 10           # Files changed in one patch = risky

token_budget:
  session_default: 500_000
  warning_at_percent: 80
  hard_limit_behavior: pause        # pause|warn|continue

security:
  credential_backend: system_keychain  # system_keychain|master_password|plaintext (dev only)
  encrypt_cold_storage: true
  audit_log: true
```

### Appendix B: Reasoning Object Examples

```yaml
# Example Decision
id: decision-0089
type: decision
session_id: session-20250701-142300
task_id: task-003

summary: "Use PyGitHub library for GitHub API access rather than raw HTTPX"
detail: >
  Evaluated two approaches for GitHub API access: raw HTTPX with manual 
  authentication, or the PyGitHub library. PyGitHub provides type-safe 
  models, automatic pagination, and handles GitHub's authentication flows 
  including token refresh. The additional 180KB dependency is justified 
  by the reduction in boilerplate and the correctness guarantees around 
  rate limit headers.

evidence:
  - "PyGitHub v2.x supports all required GitHub API endpoints"
  - "Manual HTTPX approach would require reimplementing pagination (seen in 3 similar projects)"
  - "PyGitHub includes built-in rate limit inspection via github.get_rate_limit()"

alternatives_considered:
  - option: "Raw HTTPX"
    rejected_because: "Too much boilerplate for pagination, rate limit headers, and auth"
  - option: "GhAPI"  
    rejected_because: "Less maintained, smaller community, fewer type stubs"

confidence: 0.91
permanent: true
tags: [github, dependencies, api-client, scanners]

affected_files:
  - src/scanners/github.py
  - requirements.txt

produced_by:
  provider_id: anthropic
  model_id: claude-opus-4
  account_id: acct-personal-a

produced_at: "2025-07-01T14:38:22Z"
wiki_keys: ["modules/scanners/overview", "external_dependencies/pygithub"]

---

# Example Risk
id: risk-0021
type: risk

summary: "GitHub API rate limits may throttle scanner at scale"
detail: >
  The authenticated GitHub API provides 5,000 requests/hour. 
  A single organization scan can easily consume 500-2000 requests 
  depending on repository count. If multiple users trigger scans 
  simultaneously, rate limits will be hit. Current implementation 
  does not account for multi-user scenarios.

risk_description: "GitHub rate limits could cause scan failures at scale"
likelihood: medium
impact: high
mitigation_strategy: >
  Implement per-user rate limit tracking. Use token bucket algorithm 
  with conservative limits (500 req/hour per user). Queue scans 
  when approaching limits rather than failing hard.
monitoring_approach: "Log rate limit headers on every response, alert at 80% consumption"
status: open

confidence: 0.85
permanent: true
tags: [github, rate-limits, scalability, scanners]

produced_by:
  provider_id: anthropic
  model_id: claude-opus-4
produced_at: "2025-07-01T14:41:05Z"
wiki_keys: ["modules/scanners/overview", "architecture/scalability"]
```

### Appendix C: Intermediate Representation Example

```xml
<task_result>
  <status>completed</status>
  <summary>Implemented rate limit handling in github.py using token bucket algorithm with 500 req/hour per user limit and graceful queuing on approach.</summary>
  
  <patches>
    <patch file="src/scanners/github.py">
--- a/src/scanners/github.py
+++ b/src/scanners/github.py
@@ -1,8 +1,12 @@
 import os
 from github import Github, GithubException
+from .rate_limiter import TokenBucketRateLimiter
+from typing import Optional
 
 
 class GitHubScanner:
-    def __init__(self, token: str):
+    def __init__(self, token: str, rate_limiter: Optional[TokenBucketRateLimiter] = None):
         self.client = Github(token)
+        self.rate_limiter = rate_limiter or TokenBucketRateLimiter(
+            capacity=500, refill_rate=500/3600
+        )
    </patch>
    <patch file="src/scanners/rate_limiter.py">
--- /dev/null
+++ b/src/scanners/rate_limiter.py
@@ -0,0 +1,42 @@
+import time
+import threading
+from dataclasses import dataclass, field
+
+@dataclass
+class TokenBucketRateLimiter:
+    capacity: float
+    refill_rate: float  # tokens per second
+    _tokens: float = field(init=False)
+    _last_refill: float = field(init=False)
+    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)
+
+    def __post_init__(self):
+        self._tokens = self.capacity
+        self._last_refill = time.monotonic()
+
+    def acquire(self, tokens: float = 1.0) -> float:
+        """Returns wait time in seconds (0 if immediately available)."""
+        with self._lock:
+            self._refill()
+            if self._tokens >= tokens:
+                self._tokens -= tokens
+                return 0.0
+            wait_time = (tokens - self._tokens) / self.refill_rate
+            return wait_time
+
+    def _refill(self) -> None:
+        now = time.monotonic()
+        elapsed = now - self._last_refill
+        self._tokens = min(self.capacity, self._tokens + elapsed * self.refill_rate)
+        self._last_refill = now
    </patch>
  </patches>
  
  <reasoning>
    <decision question="Which rate limiting algorithm to use?" answer="Token bucket with 500 req/hour capacity" confidence="0.91">
      <evidence>Token bucket handles burst traffic better than fixed window. 500 req/hour is 14% of GitHub's 5000 req/hour authenticated limit, leaving headroom for concurrent users.</evidence>
      <alternatives>
        <alternative option="Fixed window counter" rejected_because="Does not handle burst; penalizes users who make all requests at start of window"/>
        <alternative option="Leaky bucket" rejected_because="Too aggressive smoothing; legitimate burst scans get unnecessarily queued"/>
      </alternatives>
    </decision>
    
    <risk likelihood="low" impact="medium">
      <description>TokenBucketRateLimiter uses threading.Lock which could be a bottleneck in async contexts if GitHubScanner is later made async.</description>
      <mitigation>Refactor to asyncio.Lock when async migration occurs (tracked in open questions).</mitigation>
    </risk>
  </reasoning>
  
  <wiki_updates>
    <update key="modules/scanners/overview">
## Rate Limiting (updated 2025-07-01)

GitHub scanner uses a token bucket rate limiter (500 req/hour per user). 
The `TokenBucketRateLimiter` class is in `src/scanners/rate_limiter.py`.
See decision-0091 for the algorithm selection rationale.
    </update>
  </wiki_updates>
  
  <open_questions>
    <question>Should TokenBucketRateLimiter be refactored to use asyncio.Lock when the scanner is made async? Track for future migration.</question>
  </open_questions>
  
  <next_tasks>
    <task priority="high">Write unit tests for TokenBucketRateLimiter covering: burst consumption, refill correctness, concurrent access safety</task>
    <task priority="medium">Add rate limit metrics logging (requests remaining, wait times) for monitoring</task>
  </next_tasks>
</task_result>
```

### Appendix D: Glossary

**Account:** A specific authenticated identity within a provider. Multiple accounts per provider are supported for quota management and failover.

**Budget Profile:** A predefined allocation of the context window across context components, tuned for a specific task type.

**Checkpoint:** A complete, self-sufficient snapshot of a session's state at a specific point in time, enabling crash recovery and session resume.

**Context Compiler:** The component responsible for assembling the optimal prompt from structured state components, subject to token budget constraints.

**Context Component:** A named, typed unit of context (e.g., `relevant_files`, `prior_reasoning`, `wiki_sections`) that the Context Compiler assembles into a prompt.

**Failure Memory:** A persistent record of approaches that were tried and failed, preventing future sessions from repeating the same mistakes.

**Intermediate Representation (IR):** The provider-agnostic structured format that all model outputs are normalized into and all model inputs are compiled from.

**Provider:** A model vendor (Anthropic, OpenAI, Google, etc.) accessed through a standardized adapter interface.

**Reasoning Object:** A structured record of a significant reasoning step (decision, observation, risk, assumption, hypothesis, constraint) produced during a session.

**Repository Knowledge Graph (RKG):** A persistent, structured semantic model of a codebase, capturing the meaning and relationships of its components beyond raw syntax.

**Session:** A bounded unit of AI-assisted development work with a single objective, encompassing all tasks, reasoning, and state from start to completion.

**Static Analysis Layer:** The collection of deterministic tools (Tree-sitter, LSP, Git, ripgrep, dependency graphs) that provide factual repository intelligence without LLM involvement.

**Task:** A single, well-defined unit of work within a session, such as implementing a function, writing tests, or reviewing a change.

**Token Budget:** The maximum number of tokens allocated to a context component or a session, enforced by the Context Budget Scheduler.

**Wiki:** The Karpathy-inspired, continuously maintained, structured encyclopedia of project knowledge. The canonical source of truth about architecture, decisions, conventions, and module structure.

**Worker:** A component with a single, well-defined responsibility that processes a typed input and produces a typed output. Most workers are deterministic; LLM-backed workers are the exception.

---

*End of Specification*

---

**Document metadata**  
Version: 0.1 — Initial Draft  
Total sections: 27  
Status: Pre-implementation  
Next review: After Phase 0 completion
