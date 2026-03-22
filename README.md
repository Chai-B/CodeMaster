# CodeMaster

A token-efficient AI coding orchestrator built on [Claude Code CLI](https://github.com/anthropics/claude-code). Runs a multi-stage pipeline from your terminal — search, plan, edit, validate — while keeping LLM calls minimal and precise.

---

## Prerequisites

- **Node.js** 18+
- **Python** 3.10+
- **Claude Code CLI** — `claude` must be on your PATH ([install guide](https://docs.anthropic.com/en/docs/claude-code))

Verify your setup:
```bash
node --version    # v18+
python3 --version # 3.10+
claude --version  # any version
```

---

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Chai-B/CodeMaster/main/install.sh | bash
```

This clones CodeMaster to `~/.codemaster`, installs all dependencies, and links the `codemaster` command globally. Run `codemaster` from any directory when done.

**Manual install** (if you prefer):
```bash
git clone https://github.com/Chai-B/CodeMaster.git
cd CodeMaster
npm install && npm link
pip install -r requirements.txt
```

---

## Usage

Navigate into any project and run:

```bash
cd ~/your-project
codemaster
```

The TUI launches in your terminal. Your current working directory is the project CodeMaster will read and edit. All file operations run relative to where you called it from.

### Running tasks

Type a command and press Enter:

```
/fix the null check is missing in auth.py
/refactor extract the validation logic into its own module
/feature add rate limiting to the API endpoints
/explain how the retry logic works in client.py
/test write unit tests for the parser module
/docs generate docstrings for all public functions in utils/
```

Commands prefixed with `/` are routed through the full pipeline. Plain text is treated as a `/fix` task by default.

### Shell and git integration

Run any shell command without leaving the TUI:

```
/run pytest -x
/run npm run build
/git status
/git log --oneline -10
/diff
```

`/diff` shows a live `git diff HEAD` of all changes made in the current session.

---

## Commands Reference

| Command | Type | Description |
|---|---|---|
| `/fix <description>` | Bug fix | Locate and fix a specific bug or error |
| `/refactor <description>` | Refactor | Restructure code without changing behaviour |
| `/feature <description>` | Feature | Implement a new feature (runs planner first) |
| `/generate <description>` | Generate | Create new files or boilerplate |
| `/test <description>` | Tests | Write or update tests |
| `/docs <description>` | Docs | Generate or update documentation |
| `/explain <description>` | Explain | Explain how something works (read-only) |
| `/scan` | Utility | Index the current project into `repo_map.json` |
| `/run <command>` | Shell | Run any shell command in the project directory |
| `/git <command>` | Git | Run a git command in the project directory |
| `/diff` | Git | Show `git diff HEAD` |
| `/cc` | Claude | Drop into a raw `claude` session |
| `/help` | Meta | Show all available commands |

---

## How the Pipeline Works

Every task goes through a deterministic preprocessing pipeline before any LLM call is made. This keeps token usage low and results precise.

```
Router → Search → Deps → [Planner] → Coder → Changes → Analysis → Validator → Reviewer
```

| Stage | Type | What it does |
|---|---|---|
| **Router** | Deterministic | Classifies task type (FIX, REFACTOR, FEATURE, etc.) |
| **Search** | Deterministic | Finds relevant files using grep, glob, and the repo map |
| **Deps** | Deterministic | Traces imports to surface related modules |
| **Planner** | LLM | For FEATURE/REFACTOR — produces a numbered execution plan |
| **Coder** | LLM | Edits files directly using Claude's native Read/Write/Edit/Bash tools |
| **Changes** | Deterministic | Runs `git diff` to capture exactly what changed |
| **Analysis** | Deterministic | Runs linters, type checkers, and test commands |
| **Validator** | Deterministic | If errors found, triggers a targeted fix loop |
| **Reviewer** | LLM | Reviews the diff, flags issues, approves or rejects |

LLM stages (Planner, Coder, Reviewer) are called with `--dangerously-skip-permissions` so they run non-interactively. The Coder has full tool access — it reads, writes, and edits files natively.

For large tasks, the Coder will continue across multiple passes until the work is complete (`NEEDS_CONTINUATION` protocol).

---

## Configuration

### Complexity preset (quickest way to tune)

Set `CM_COMPLEXITY` or edit it in `/config`:

| Preset | max_files | max_fns | max_debug | Plan types |
|---|---|---|---|---|
| `simple` | 3 | 3 | 1 | _(none — no planner)_ |
| `standard` _(default)_ | 5 | 5 | 2 | FEATURE, REFACTOR |
| `thorough` | 8 | 8 | 3 | FEATURE, REFACTOR, BUG_FIX, TEST |

```bash
CM_COMPLEXITY=thorough codemaster
```

### Fine-grained env vars

Individual variables override the preset:

| Variable | Default | Description |
|---|---|---|
| `CM_COMPLEXITY` | `standard` | Preset: `simple`, `standard`, or `thorough` |
| `CM_PLAN_TYPES` | `FEATURE,REFACTOR` | Task types that trigger the planner stage |
| `CM_MAX_FILES` | _(from preset)_ | Max files included in context |
| `CM_MAX_FNS` | _(from preset)_ | Max symbols shown per file |
| `CM_MAX_DEBUG` | _(from preset)_ | Max reviewer→patcher cycles |
| `CM_CLAUDE_CMD` | `claude` | Path or alias for the Claude CLI |

Example — thorough preset, override to cap files at 6:
```bash
CM_COMPLEXITY=thorough CM_MAX_FILES=6 codemaster
```

### In-TUI config editor

Run `/config` inside CodeMaster to edit all settings interactively. Changes are saved to `config.json` and take effect on the next task.

---

## Benchmark: CodeMaster vs Claude Code

Run the automated benchmark to measure token efficiency, speed, and output quality:

```bash
./benchmark/run             # full run — 5 prompts
./benchmark/run --quick     # smoke test — 1 prompt
./benchmark/run --no-judge  # skip LLM quality scoring (faster)
```

Each prompt runs both tools against an identical sample Python project. The benchmark measures:

- **Wall time** — how long each tool takes
- **Token usage** — estimated tokens sent/received per tool
- **Files changed** — concrete output of each tool
- **Quality score** — LLM judge rates correctness, completeness, and code quality (0–10)

Results are saved to `benchmark/results_<timestamp>.json`.

---

## Project Structure

```
CodeMaster/
├── bin/
│   └── codemaster          # CLI entry point (Node.js ESM)
├── src/
│   └── index.tsx           # React/Ink TUI
├── codemaster.py           # Pipeline orchestrator
├── pipeline/
│   ├── command_router.py   # Routes task types
│   ├── task_classifier.py  # Classifies intent
│   ├── searcher.py         # File search
│   ├── dependency_expander.py
│   ├── context_builder.py  # Builds compact directives (~30 tokens/file)
│   ├── static_analysis.py  # Linters, type checks
│   ├── auto_fixer.py       # Pre-LLM fixers
│   ├── patch_simulator.py  # Syntax validation
│   ├── risk_scorer.py      # Risk score before apply
│   └── repo_builder.py     # AST scanner → repo_map.json
├── agents/
│   ├── planner.md          # Planner system prompt
│   ├── coder.md            # Coder system prompt
│   ├── reviewer.md         # Reviewer system prompt
│   └── patcher.md          # Patch-fix system prompt
├── web/                    # Marketing website (Next.js)
├── requirements.txt
└── package.json
```

---

## repo_map.json

On first run, CodeMaster auto-scans your project and writes `repo_map.json` to the project root. This is a compact index of all files and their exported symbols — used by the Search and Context stages to build precise, low-token context.

To manually regenerate:
```
/scan
```

Or from the shell:
```bash
python3 /path/to/CodeMaster/pipeline/repo_builder.py --root .
```

The file is project-specific and should be gitignored:
```bash
echo "repo_map.json" >> .gitignore
```

---

## Logs

All pipeline logs are written to `CodeMaster/logs/` (the installation directory, not your project):

| File | Contents |
|---|---|
| `logs/codemaster.log` | Full pipeline trace for each run |
| `logs/calls.jsonl` | LLM call log with token counts |
| `logs/last_patch.diff` | Diff from the most recent task |

---

## Troubleshooting

**`codemaster: command not found`**
Run `npm link` again from the CodeMaster directory (or `~/.codemaster` if installed via the script). If it still fails, check that your npm global bin is on PATH (`npm bin -g`).

**`claude: command not found`**
Install Claude Code CLI and ensure `claude` is on your PATH.

**Pipeline hangs or times out**
Claude calls have a 120s timeout. For large tasks, increase `CM_MAX_PASSES`. If a stage hangs, check `logs/codemaster.log` for the last completed step.

**Wrong files being edited**
Run `/scan` to regenerate the repo map. If CodeMaster is editing the wrong directory, ensure you launched it from the correct project root.

**`repo_map.json` not found**
The TUI auto-scans on startup if no map exists. You can also run `/scan` manually.

---

## Uninstall

```bash
cd ~/.codemaster
npm unlink
rm -rf ~/.codemaster
```

---

## License

MIT
