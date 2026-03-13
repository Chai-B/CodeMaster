```
  ▄████▄
  ██        CodeMaster
  ▀████▀    AI coding assistant for your terminal
```

> Run from any repo. Describe what you want. Get a patch.

Codemaster is a terminal interface that turns plain-English tasks into code changes. You type what you want — it finds the relevant files, generates a diff, validates it, and asks before applying anything. Powered by [Claude Code](https://claude.ai/code).

It's designed to be fast and cheap: simple fixes use a single AI call, complex tasks get broken into steps automatically. Nothing runs without your approval.

---

## Install

**One command:**

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/codemaster/main/install.sh | bash
```

Or clone and install manually:

```bash
git clone https://github.com/YOUR_USERNAME/codemaster
cd codemaster
bash install.sh
```

**Requirements:**
- Python 3.10+
- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) — `claude` must be in your PATH
- Optional: `ruff`, `flake8`, `isort` for static analysis

---

## Usage

Go to any project and run:

```bash
codemaster
```

That's it. The TUI opens in your terminal, already pointed at your project.

---

## The TUI

**Main screen:**

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  CodeMaster  │  Tips                                                         │
│              │  ──────────────────────────────────────────                   │
│  ▄████▄      │  Type a task to run the pipeline                              │
│  ██          │  /help for commands                                            │
│  ▀████▀      │                                                               │
│              │  Recent                                                        │
│  ~/myproject │  ──────────────────────────────────────────                   │
│              │  03/13 10:42  fix divide by zero in calculator                │
╰──────────────────────────────────────────────────────────────────────────────╯
 files 3  fns 3  debug 2  claude claude
────────────────────────────────────────────────────────────────────────────────
❯ Type a task or /help
────────────────────────────────────────────────────────────────────────────────
 ready  ·  Ctrl+Q quit  ·  Ctrl+L clear               codemaster v1.0.0  ·  myproject
```

**While a task runs:**

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  CodeMaster  │  ...                                                           │
╰──────────────────────────────────────────────────────────────────────────────╯
 files 3  fns 3  debug 2  claude claude  ┄  calls 2  tokens 1,842  elapsed 4.2s
────────────────────────────────────────────────────────────────────────────────
  ── TASK ──
  fix divide by zero in calculate_average  (BUG_FIX)
  Searching repository...
  Found 1 file(s): utils/math.py
  (tokens) sending ~380 tokens (coder.md)
  --- utils/math.py
  +++ utils/math.py
  @@ -12,7 +12,8 @@
   def calculate_average(nums):
  -    return sum(nums) / len(nums)
  +    if not nums:
  +        return 0
  +    return sum(nums) / len(nums)

  ── RISK ──
  Score: 1  Level: LOW
  · small change (3 lines)

  ✓ Modified: utils/math.py
  ━━

  ⠿ Running…
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
 ►► running  ·  Ctrl+C interrupt                       codemaster v1.0.0  ·  myproject
```

**Config editor** (`/config`):

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  Config Editor  —  ↑↓ navigate  ·  Enter edit  ·  Ctrl+S save  ·  Esc cancel│
│  ────────────────────────────────────────────────────────────                │
│  Max files per context           3                                           │
│❯ Max functions per file          3                                           │
│  Max debug cycles                2                                           │
│  Claude CLI command              claude                                      │
╰──────────────────────────────────────────────────────────────────────────────╯
```

---

## Commands

| Command | What it does |
|---------|-------------|
| `/fix` | Fix a bug |
| `/refactor` | Refactor code |
| `/test` | Write or fix tests |
| `/explain` | Explain what code does |
| `/config` | Edit settings in TUI |
| `/agents` | Open agent prompts in `$EDITOR` |
| `/clear` | Clear output + reset repo map |
| `/cc` | Hand off to Claude Code directly |
| `/help` | Show all commands |
| `/quit` | Exit |

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `Ctrl+Q` | Quit |
| `Ctrl+L` | Clear screen |
| `Ctrl+C` | Interrupt running task |
| `↑↓` | Navigate autocomplete |
| `Enter` | Submit / select |

You can also prefix anything with `@claude` to pass it directly to Claude without the pipeline:

```
@claude what does the auth middleware do?
```

---

## Configuration

Settings are stored in `config.json` inside the install directory (`~/.codemaster/config.json`). Edit them in the TUI with `/config` or directly in the file:

```json
{
  "max_files": 3,
  "max_fns": 3,
  "max_debug": 2,
  "claude_cmd": "claude"
}
```

| Key | What it controls |
|-----|-----------------|
| `max_files` | How many files are sent to the coder |
| `max_fns` | Max functions extracted per file |
| `max_debug` | Max review→patch cycles before asking you |
| `claude_cmd` | The Claude CLI command (`claude` by default) |

Override any setting with an environment variable: `CM_MAX_FILES`, `CM_MAX_FNS`, `CM_MAX_DEBUG`, `CM_CLAUDE_CMD`.

---

## Agent Prompts

Codemaster uses four agents internally. You can edit their behavior with `/agents`:

| Agent | Role |
|-------|------|
| `coder.md` | Generates the diff |
| `reviewer.md` | Reviews the diff for bugs and security issues |
| `patcher.md` | Fixes issues found by the reviewer |
| `planner.md` | Breaks complex tasks into steps |

Each is a plain markdown system prompt. Edit freely.

---

## Logs

Every run is logged to `logs/` in the install directory:

| File | Contents |
|------|----------|
| `codemaster.log` | Human-readable event log |
| `calls.jsonl` | Per-call token usage (JSON) |
| `last_patch.diff` | The last generated patch |

---

## Tips

- **Be specific.** The more precise the task, the better the search.
  - ✅ `fix divide by zero in calculate_average in utils/math.py`
  - ❌ `fix the math`

- **Simple tasks are cheap.** A bug fix uses 1 LLM call. Only complex tasks trigger the planner.

- **You always approve.** No changes are applied until you confirm. Patches are shown before application.

- **Static analysis is optional.** Install `ruff` and `flake8` for lint checking on changed files only.

---

## Troubleshooting

**`claude: command not found`**
Install the Claude Code CLI: https://claude.ai/code

**`No relevant files found`**
Be more specific in your task, or run from inside the project directory.

**`Patch has syntax errors`**
The diff is shown and you can choose not to apply it. The raw patch is in `logs/last_patch.diff`.

---

## Status

Work in progress — core pipeline is stable and functional. Planned improvements:
- Multi-language context expansion (JS/TS/Go)
- Smarter repo map caching
- Session replay from logs

Contributions welcome.

---

*Powered by [Claude Code](https://claude.ai/code)*
