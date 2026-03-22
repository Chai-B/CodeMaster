# CodeMaster — Project Summary

## Project Purpose

CodeMaster is a token-efficient AI coding orchestrator that wraps [Claude Code CLI](https://github.com/anthropics/claude-code). It accepts natural-language task descriptions from a terminal UI, runs a deterministic multi-stage preprocessing pipeline to build minimal context, then calls Claude to read/write/edit files in the user's project. The goal is to keep LLM token usage low and precise while still executing non-trivial coding tasks end-to-end.

---

## Architecture Overview

```
User input (TUI / CLI)
        │
        ▼
  codemaster.py  ← pipeline orchestrator (Python)
        │
        ├─ ROUTER & CLASSIFIER  (deterministic)
        │     pipeline/command_router.py   — parses /slash commands
        │     pipeline/task_classifier.py  — keyword-based task typing
        │
        ├─ SEARCH               (deterministic)
        │     pipeline/searcher.py         — grep + repo_map.json lookup
        │
        ├─ DEPENDENCIES         (deterministic)
        │     pipeline/dependency_expander.py — traces imports
        │
        ├─ [PLANNER]            (LLM — FEATURE/REFACTOR only)
        │     agents/planner.md            — system prompt
        │
        ├─ CODER                (LLM — edit_mode, full tool access)
        │     agents/coder.md              — system prompt
        │     Supports NEEDS_CONTINUATION multi-pass for large tasks
        │
        ├─ CHANGES              (deterministic — git diff)
        │
        ├─ ANALYSIS + AUTOFIX   (deterministic, parallel)
        │     pipeline/static_analysis.py  — linters / type checkers
        │     pipeline/auto_fixer.py       — formatters
        │
        ├─ VALIDATION           (deterministic)
        │     pipeline/patch_simulator.py  — syntax check
        │
        ├─ RISK ASSESSMENT      (deterministic)
        │     pipeline/risk_scorer.py      — scores diff risk 0-10
        │
        └─ [REVIEWER + PATCHER] (LLM — only when risk ≥ 7)
              agents/reviewer.md / patcher.md
```

The TUI is a React/Ink TypeScript application (`src/`) spawned by the Node.js entry point (`bin/codemaster`). It drives `codemaster.py` as a subprocess and captures `CM_METRICS:` and `CM_DIFF:` lines from stdout to power the live metrics display and `/diff` command.

---

## Key Files and Their Roles

| File / Directory | Role |
|---|---|
| `codemaster.py` | Top-level pipeline orchestrator. Wires every stage together, calls Claude CLI via subprocess, tracks token metrics. |
| `bin/codemaster` | Node.js ESM CLI entry point. Launches the Ink TUI. |
| `src/index.tsx` | React/Ink terminal UI. Handles user input, spawns the Python pipeline, renders output. |
| `src/components/Header.tsx` | TUI header component. |
| `src/components/Autocomplete.tsx` | Command autocomplete in the TUI input bar. |
| `src/themes/blue.ts` | Colour theme for the TUI. |
| `pipeline/command_router.py` | Parses `/fix`, `/refactor`, `/generate`, `/test`, `/docs` slash commands. Returns `(command, task_description)`. |
| `pipeline/task_classifier.py` | Keyword-based fallback classifier when no slash command is present. Returns `BUG_FIX`, `REFACTOR`, `FEATURE`, `TEST`, `DOCS`, or `UNKNOWN`. |
| `pipeline/searcher.py` | Finds relevant files for a task via grep and `repo_map.json`. |
| `pipeline/dependency_expander.py` | Traces imports from seed files to surface related modules. |
| `pipeline/context_builder.py` | Builds compact file-pointer directives (~30 tokens/file) instead of pasting full file contents. |
| `pipeline/static_analysis.py` | Runs linters and type checkers (e.g. mypy, eslint) on changed files. |
| `pipeline/auto_fixer.py` | Applies formatters (e.g. black, prettier) before the LLM review. |
| `pipeline/patch_simulator.py` | Syntax-validates changed files to catch obvious errors early. |
| `pipeline/risk_scorer.py` | Scores a diff 0–10 based on heuristics (scope, deletions, file types). Reviewer is only invoked at ≥ 7. |
| `pipeline/repo_builder.py` | AST-walks a project and writes `repo_map.json` — a compact symbol index used by Search and Context stages. |
| `agents/*.md` | System prompt templates for each LLM stage: `planner.md`, `coder.md`, `reviewer.md`, `patcher.md`. Loaded at runtime; built-in defaults are used if files are absent. |
| `repo_map.json` | Auto-generated project index. Created by `/scan` or `repo_builder.py`. Should be gitignored in target projects. |
| `logs/codemaster.log` | Timestamped pipeline trace for every run. |
| `logs/calls.jsonl` | Per-LLM-call log with token estimates and durations. |
| `logs/last_patch.diff` | Diff saved after each completed task. |
| `requirements.txt` | Python dependencies. |
| `package.json` | Node.js dependencies (Ink, React, tsx). |
| `install.sh` | One-command installer: clones repo, runs `npm install && npm link`, installs Python deps. |

---

## Main Functions and Entry Points

### `codemaster.py`

| Function | Line | Description |
|---|---|---|
| `main()` | 628 | CLI entry point. Parses `--root` flag, assembles task string, calls `run_pipeline()`. |
| `run_pipeline(task, root, base_dir)` | 376 | Executes the full pipeline end-to-end. Loads config, runs each stage, emits metrics. |
| `load_config()` | 44 | Reads `CM_*` environment variables and returns a config dict. |
| `claude(prompt, cfg, stage, edit_mode)` | 111 | Calls the `claude` CLI via subprocess. `edit_mode=True` gives full tool access; `edit_mode=False` is text-only for planner/reviewer. Logs every call to `calls.jsonl`. |
| `_run_coder_with_continuation(...)` | 299 | Wraps `claude()` with a multi-pass loop. If Claude emits `NEEDS_CONTINUATION:`, injects a git-diff progress snapshot and continues until the task is complete or `max_passes` is hit. |
| `build_directive(files, root, repo_map)` | 247 | Converts a file list into a compact pointer context (path + line count + top symbols). Avoids pasting full file contents. |
| `load_prompt(name, base_dir, **kwargs)` | 198 | Loads an agent prompt template from `agents/<name>.md` or falls back to built-in defaults. Fills template variables. |
| `extract_subtasks(plan_text)` | 283 | Parses a numbered list from planner output into individual step strings for sequential coder calls. |
| `emit_metrics()` | 76 | Prints `CM_METRICS:{...}` JSON to stdout — captured by the TUI for live display. |
| `step / detail / subdetail / ok / fail / warning` | 69–74 | Output helpers that emit Claude Code–style indented log lines (`⏺`, `⎿`, `✓`, `✗`, `⚠`). |
| `get_git_diff / get_changed_files / is_git_repo` | 225–243 | Git helpers. Change detection falls back gracefully when no git repo exists. |

### `pipeline/command_router.py`

| Function | Description |
|---|---|
| `route_command(raw_input)` | Parses a leading slash command and returns `(command_str, task_description)`. Returns `(None, raw_input)` for plain text. |

### `pipeline/task_classifier.py`

| Function | Description |
|---|---|
| `classify_task(task_description)` | Keyword heuristic classifier returning a `TaskType` literal. |

---

## Usage and Install Instructions

### Prerequisites

- **Node.js** 18+
- **Python** 3.10+
- **Claude Code CLI** on your `PATH` — install with `npm install -g @anthropic-ai/claude-code`

### One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/Chai-B/CodeMaster/main/install.sh | bash
```

Clones to `~/.codemaster`, installs Node and Python dependencies, and links the `codemaster` command globally.

### Manual install

```bash
git clone https://github.com/Chai-B/CodeMaster.git
cd CodeMaster
npm install && npm link
pip install -r requirements.txt
```

### Running

```bash
cd ~/your-project
codemaster
```

The TUI launches. Type any task and press Enter:

```
/fix the null check is missing in auth.py
/refactor extract validation logic into its own module
/feature add rate limiting to the API endpoints
/test write unit tests for the parser module
/docs generate docstrings for all public functions in utils/
```

Plain text (no `/` prefix) is treated as a bug-fix task.

### Shell and git commands inside the TUI

```
/run pytest -x
/run npm run build
/git status
/git log --oneline -10
/diff
/scan
```

### Direct CLI usage (bypassing TUI)

```bash
python3 codemaster.py --root /path/to/project "fix the null check in auth.py"
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CM_MAX_FILES` | `3` | Max files included in context per task |
| `CM_MAX_FNS` | `3` | Max symbols shown per file in directives |
| `CM_MAX_DEBUG` | `2` | Max patcher retry cycles |
| `CM_CLAUDE_CMD` | `claude` | Path or alias for the Claude CLI binary |

```bash
CM_MAX_FILES=10 CM_MAX_DEBUG=3 codemaster
```

### Uninstall

```bash
cd ~/.codemaster && npm unlink
rm -rf ~/.codemaster
```
