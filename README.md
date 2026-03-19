# CodeMaster

An AI-powered coding assistant that combines a multi-stage analysis pipeline with an interactive terminal UI to help you understand, fix, and improve code.

## How It Works

CodeMaster routes your requests through a pipeline of specialized stages:

1. **Classify** — determines the task type (fix, refactor, explain, etc.)
2. **Search** — finds relevant files in your codebase
3. **Expand** — resolves dependencies and imports
4. **Context** — builds a minimal, focused context for Claude
5. **Analyze** — runs static analysis on the target code
6. **Fix** — applies auto-fixers for common issues
7. **Validate** — simulates patches and checks syntax
8. **Score** — computes a risk score before applying changes
9. **Generate** — calls Claude to produce the final diff

## Prerequisites

- Python 3.10+
- Node.js 18+
- [Claude Code CLI](https://github.com/anthropics/claude-code) (`claude` on your PATH)

## Installation

```bash
# Clone the repo
git clone https://github.com/your-org/codemaster.git
cd codemaster

# Install Python dependencies
pip install -r requirements.txt

# Install and build the terminal UI
npm install
npm run build
```

Or use the install script:

```bash
bash install.sh
```

## Usage

### Interactive UI

```bash
node bin/codemaster
```

The UI is a full-screen terminal application built with [Ink](https://github.com/vadimdemedes/ink). Type a task and press Enter. Use Tab for command autocomplete.

### Python CLI

```bash
python codemaster.py "<your task>" [target_file_or_directory]
```

**Examples:**

```bash
# Fix a bug
python codemaster.py "fix the null pointer in auth.py" src/auth.py

# Explain code
python codemaster.py "explain how the retry logic works" src/client.py

# Refactor
python codemaster.py "extract the validation logic into a separate function" src/models.py
```

## Configuration

CodeMaster is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `CM_MAX_FILES` | `2` | Max files included in context |
| `CM_MAX_FNS` | `2` | Max functions included per file |
| `CM_MAX_DEBUG` | `1` | Debug verbosity level |
| `CM_CLAUDE_CMD` | `claude` | Path or command name for the Claude CLI |

## Project Structure

```
codemaster/
├── codemaster.py          # Main entry point and pipeline orchestrator
├── pipeline/
│   ├── command_router.py  # Routes commands to the right handler
│   ├── task_classifier.py # Classifies task type
│   ├── searcher.py        # Finds relevant files
│   ├── dependency_expander.py
│   ├── context_builder.py
│   ├── static_analysis.py
│   ├── auto_fixer.py
│   ├── patch_simulator.py
│   └── risk_scorer.py
└── src/                   # Terminal UI (TypeScript + Ink)
    ├── index.tsx           # App shell, config, history
    ├── components/
    │   ├── Autocomplete.tsx
    │   ├── Header.tsx
    │   └── MessageList.tsx
    └── utils/parser.ts     # Log and diff parsing
```

## Commands (UI)

| Command | Description |
|---|---|
| `/fix` | Fix a bug or error |
| `/explain` | Explain selected code |
| `/refactor` | Suggest a refactor |
| `/review` | Review for issues |
| `/plan` | Outline an implementation plan |

Type `/` to see the full autocomplete list.
