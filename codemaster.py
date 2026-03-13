#!/usr/bin/env python3
"""Codemaster """

import sys
import os
import re
import json
import subprocess
import shutil
import threading
import time
from pathlib import Path

# ── Bootstrap ─────────────────────────────────────────────────────────────────
_SCRIPT_DIR  = Path(__file__).parent
PROJECT_ROOT = _SCRIPT_DIR.parent
sys.path.insert(0, str(_SCRIPT_DIR))

from core.search import find_relevant_code
from core.context_builder import build_context
from core import command_router
from core import task_classifier
from core import dependency_expander
from core import auto_fixer
from core import patch_simulator
from core import risk_scorer
from core import patch_minimizer
from core import logger

_RICH_RE = re.compile(r"\[/?[a-zA-Z0-9 _#]+\]")

def _clean(msg): return _RICH_RE.sub("", str(msg)).strip()

class _TUI:
    def _emit_metrics(self):
        print(f"CM_METRICS:{json.dumps(METRICS.get_data())}", flush=True)

    def tokens(self, msg):
        print(f"  (tokens) {_clean(msg)}", flush=True)
        self._emit_metrics()

    def success(self, msg): print(f"✓ {_clean(msg)}", flush=True)
    def info(self, msg):    print(f"  {_clean(msg)}", flush=True)
    def warn(self, msg):    print(f"⚠ {_clean(msg)}", flush=True)
    def error(self, msg):   print(f"✗ {_clean(msg)}", flush=True)
    def print_banner(self, t, s=""): pass  # suppressed — TUI shows branding
    def section(self, t):   print(f"\n── {_clean(t)} ──", flush=True)
    def loading(self, msg):
        import contextlib
        @contextlib.contextmanager
        def _stub():
            print(f"  {_clean(msg)}", flush=True)
            yield
        return _stub()
    def print_diff(self, d): print(d, flush=True)
    def print_metrics(self, m): self._emit_metrics()
    def prompt(self, p, default=""): return default  # non-interactive in TUI mode
    def confirm(self, p, default=True): return default
    def settings_menu(self, current_settings): return current_settings
    def clear(self): pass

tui = _TUI()

# ── Config ────────────────────────────────────────────────────────────────────
AGENTS       = _SCRIPT_DIR / "agents"
_CONFIG_PATH = _SCRIPT_DIR / "config.json"

def _load_cfg():
    if _CONFIG_PATH.exists():
        try:
            return json.load(open(_CONFIG_PATH))
        except Exception:
            pass
    return {}

_cfg           = _load_cfg()
MAX_FILES      = int(os.environ.get("CM_MAX_FILES",  _cfg.get("max_files",  3)))
MAX_FNS        = int(os.environ.get("CM_MAX_FNS",    _cfg.get("max_fns",    3)))
MAX_PATCH_LINES = 200
MAX_DEBUG_CYCLES = int(os.environ.get("CM_MAX_DEBUG", _cfg.get("max_debug", 2)))
CLAUDE_CMD     = os.environ.get("CM_CLAUDE_CMD", _cfg.get("claude_cmd", "claude"))
MAX_CONTEXT_TOKENS = 4000


# ── Metrics ───────────────────────────────────────────────────────────────────
class Metrics:
    def __init__(self):
        self.calls        = 0
        self.total_tokens = 0
        self.total_chars  = 0
        self.context_sizes = []
        self.call_log     = []
        self.start_time   = time.time()

    def record(self, agent, prompt, response):
        pt = int(len(prompt.split()) * 1.3)
        rt = int(len(response.split()) * 1.3)
        self.calls        += 1
        self.total_tokens += pt + rt
        self.total_chars  += len(prompt) + len(response)
        self.context_sizes.append(pt)
        self.call_log.append({"agent": agent, "in": pt, "out": rt, "total": pt + rt})
        logger.event("claude_call", {"agent": agent, "in_tokens": pt, "out_tokens": rt})

    def get_data(self):
        elapsed = time.time() - self.start_time
        avg_ctx = int(sum(self.context_sizes)/len(self.context_sizes)) if self.context_sizes else 0
        return {
            "calls": self.calls,
            "elapsed": elapsed,
            "total_tokens": self.total_tokens,
            "avg_context": avg_ctx,
            "call_log": self.call_log,
        }


METRICS = Metrics()


# ── Helpers ───────────────────────────────────────────────────────────────────
def call_claude(agent_file, user_content):
    system_prompt = (AGENTS / agent_file).read_text().strip()
    full_prompt   = f"{system_prompt}\n\n{user_content}"
    pt = int(len(full_prompt.split()) * 1.3)
    agent_name = agent_file.replace(".md", "")
    tui.info(f"→ {agent_name}  (~{pt:,} tokens)")

    # Find the binary — resolves if not in PATH
    claude_bin = shutil.which(CLAUDE_CMD) or CLAUDE_CMD

    # Build a clean env: strip vars that break claude when called as a subprocess
    claude_env = os.environ.copy()
    for key in ("FORCE_COLOR", "NO_COLOR", "PYTHON_COLORS", "CLAUDECODE"):
        claude_env.pop(key, None)
    if not claude_env.get("TERM") or claude_env["TERM"] == "dumb":
        claude_env["TERM"] = "xterm-256color"

    try:
        proc = subprocess.Popen(
            [claude_bin, "-p", full_prompt, "--output-format", "text"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=claude_env,
        )

        # Show a heartbeat so the user knows we're waiting
        def _slow_warn():
            tui.info(f"  {agent_name} still running... (claude is generating)")
        timer = threading.Timer(15.0, _slow_warn)
        timer.start()
        try:
            stdout, stderr = proc.communicate(timeout=120)
        finally:
            timer.cancel()

        output = stdout.strip()
        if proc.returncode != 0 and not output:
            tui.error(f"{agent_name} failed (exit {proc.returncode})")
            for line in stderr.strip()[:600].splitlines():
                tui.error(f"  {line}")
            return ""
        if not output and stderr.strip():
            tui.warn(f"{agent_name} returned empty — stderr: {stderr.strip()[:300]}")
            return ""

        rt = int(len(output.split()) * 1.3)
        METRICS.record(agent_name, full_prompt, output)
        tui.info(f"← {agent_name}  (~{rt:,} tokens)")
        return output

    except subprocess.TimeoutExpired:
        proc.kill()
        tui.error(f"{agent_name} timed out after 120s — check your Claude CLI and network")
        return ""
    except FileNotFoundError:
        tui.error(f"'{CLAUDE_CMD}' not found — is Claude Code installed and in PATH?")
        tui.error(f"  Searched for: {claude_bin}")
        sys.exit(1)


def extract_diff(raw):
    if not raw or raw.strip() == "NO_CHANGE":
        return None
    fenced = re.search(r"```(?:diff)?\n([\s\S]*?)```", raw)
    if fenced:
        candidate = fenced.group(1).strip()
        if candidate.startswith("---"):
            return candidate
    if raw.strip().startswith("---"):
        return raw.strip()
    m = re.search(r"(---\s+\S.*)", raw, re.DOTALL)
    if m:
        return m.group(1).strip()
    return None


def apply_diff_python(diff):
    file_blocks = re.split(r"(?=^--- )", diff, flags=re.MULTILINE)
    applied = []
    errors  = []

    for block in file_blocks:
        block = block.strip()
        if not block:
            continue

        header_match = re.match(r"^--- (.+)\n\+\+\+ (.+)\n([\s\S]*)", block)
        if not header_match:
            continue

        src_path = header_match.group(1).strip()
        dst_path = header_match.group(2).strip()
        hunks    = header_match.group(3)

        dst_path = re.sub(r"^[ab]/", "", dst_path).strip().lstrip("./")

        if src_path.strip() == "/dev/null":
            new_lines = [l[1:] for l in hunks.splitlines() if l.startswith("+") and not l.startswith("++")]
            target = PROJECT_ROOT / dst_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("\n".join(new_lines))
            applied.append(f"Created: {dst_path} ({len(new_lines)} lines)")
            continue

        target = PROJECT_ROOT / dst_path
        if not target.exists():
            alt = PROJECT_ROOT / re.sub(r"^[ab]/", "", src_path).lstrip("./")
            if alt.exists():
                target = alt
            else:
                errors.append(f"File not found: {dst_path}")
                continue

        original_lines = target.read_text(errors="replace").splitlines()
        result_lines   = list(original_lines)
        offset = 0

        for hunk in re.finditer(
            r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n([\s\S]*?)(?=^@@|\Z)",
            hunks, re.MULTILINE,
        ):
            src_start  = int(hunk.group(1)) - 1
            hunk_lines = hunk.group(5).splitlines()
            patch_pos  = src_start + offset
            new_hunk   = []

            for line in hunk_lines:
                if line.startswith("+"):
                    new_hunk.append(line[1:])
                elif line.startswith("-"):
                    patch_pos += 1
                elif line.startswith("\\"):
                    continue
                else:
                    new_hunk.append(line[1:] if line.startswith(" ") else line)
                    patch_pos += 1

            del_count = sum(1 for l in hunk_lines if l.startswith("-") or (not l.startswith("+") and not l.startswith("\\")))
            start_idx = src_start + offset
            result_lines[start_idx:start_idx + del_count] = new_hunk
            offset += len(new_hunk) - del_count

        target.write_text("\n".join(result_lines))
        applied.append(f"Modified: {dst_path}")

    return applied, errors


def run_static_analysis(diff=None):
    targets = ["."]
    if diff:
        py_files = re.findall(r'^\+\+\+ (?:[ab]/)?(.+\.py)', diff, re.MULTILINE)
        py_files = [f.lstrip("./") for f in py_files if "dev/null" not in f]
        if py_files:
            existing = [f for f in py_files if Path(f).exists()]
            if existing:
                targets = existing
    linters = [
        ["ruff", "check", "--quiet"] + targets,
        ["flake8", "--max-line-length=100", "--quiet"] + targets,
    ]
    for cmd in linters:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if r.returncode != 0:
                return (r.stdout + r.stderr).strip()[:500]
            return None
        except FileNotFoundError:
            continue
    return None


def needs_planning(task, task_type=None):
    if task_type in (task_classifier.BUG_FIX, task_classifier.TEST, task_classifier.DOCS):
        return False
    complex_keywords = {"implement", "refactor", "migrate", "redesign", "add support", "introduce"}
    return len(task) > 120 or any(kw in task.lower() for kw in complex_keywords)


def parse_plan(plan_text, original_task):
    steps = []
    for line in plan_text.strip().splitlines():
        m = re.match(r"^\d+\.\s+(.+)$", line.strip())
        if m:
            steps.append(m.group(1))
    return steps if steps else [original_task]


def manage_settings():
    global MAX_FILES, MAX_FNS, MAX_DEBUG_CYCLES, CLAUDE_CMD
    current = {
        "MAX_FILES": MAX_FILES,
        "MAX_FNS": MAX_FNS,
        "MAX_DEBUG": MAX_DEBUG_CYCLES,
        "CLAUDE_CMD": CLAUDE_CMD,
    }
    updated = tui.settings_menu(current)
    MAX_FILES        = updated["MAX_FILES"]
    MAX_FNS          = updated["MAX_FNS"]
    MAX_DEBUG_CYCLES = updated["MAX_DEBUG"]
    CLAUDE_CMD       = updated["CLAUDE_CMD"]


# ── Repo map ───────────────────────────────────────────────────────────────────
_repo_map_refreshed = False

def refresh_repo_map(root: Path):
    global _repo_map_refreshed
    if _repo_map_refreshed:
        return
    map_script = _SCRIPT_DIR / "core" / "repo_map_gen.py"
    if not map_script.exists():
        _repo_map_refreshed = True
        return
    map_file = root / "repo_map.json"
    if map_file.exists() and (time.time() - map_file.stat().st_mtime) < 300:
        _repo_map_refreshed = True
        return
    tui.info("Refreshing repo map...")
    try:
        subprocess.run(
            [sys.executable, str(map_script), str(root)],
            capture_output=True, timeout=30, cwd=str(root),
        )
    except Exception:
        pass
    _repo_map_refreshed = True


# ── Core pipeline ─────────────────────────────────────────────────────────────
def process_task(task, command=None):
    tui.section("TASK")
    task_type = task_classifier.classify(task, command)
    tui.info(f"{task}  ({task_type})")
    logger.event("task_start", {"task": task, "type": task_type, "command": command})

    # Search
    results = []
    tui.info("Searching repository...")
    try:
        results = find_relevant_code(task) or []
    except Exception as e:
        tui.warn(f"Search error: {e}")
        logger.error("search", str(e))

    results = results[:MAX_FILES]
    for r in results:
        r["functions"] = r.get("functions", [])[:MAX_FNS]

    if results:
        tui.info(f"Found {len(results)} file(s): {', '.join(r['file'] for r in results)}")
    else:
        tui.info("No relevant code found — new file mode")

    # Context
    tui.info("Building context...")
    ctx = build_context(task, results)

    # Dependency expansion — enrich context with imports/calls from target files
    dep_parts = []
    if results:
        tui.info("Expanding dependencies...")
    for r in results:
        fp = Path(r["file"])
        if fp.suffix == ".py" and fp.exists():
            deps = dependency_expander.expand(fp)
            summary = []
            if deps["imports"]:
                summary.append("imports: " + ", ".join(deps["imports"][:8]))
            if deps["function_calls"]:
                summary.append("calls: " + ", ".join(deps["function_calls"][:8]))
            if summary:
                dep_parts.append(f"Dependencies ({r['file']}): {'; '.join(summary)}")
    if dep_parts:
        ctx += "\n\n" + "\n".join(dep_parts)

    ctx_tokens = int(len(ctx.split()) * 1.3)
    if ctx_tokens > MAX_CONTEXT_TOKENS:
        words = ctx.split()
        ctx = " ".join(words[:MAX_CONTEXT_TOKENS]) + "\n... [context truncated]"
        tui.warn(f"Context truncated to {MAX_CONTEXT_TOKENS} tokens (was {ctx_tokens:,})")
        ctx_tokens = MAX_CONTEXT_TOKENS
    tui.tokens(f"context size: ~{ctx_tokens:,} tokens")

    # Coder
    tui.section("CODER")
    raw  = call_claude("coder.md", ctx)
    diff = extract_diff(raw)

    if not diff:
        tui.info("No code change produced.")
        logger.event("task_end", {"result": "no_change"})
        return

    # Patch size guard
    patch_lines = len(diff.splitlines())
    if patch_lines > MAX_PATCH_LINES:
        tui.warn(f"Patch is {patch_lines} lines (limit {MAX_PATCH_LINES}). Proceed?")
        if not tui.confirm("Apply oversized patch?", default=False):
            logger.event("task_end", {"result": "oversized_patch_rejected"})
            return

    tui.print_diff(diff)

    # Patch simulation (syntax check)
    tui.section("PATCH SIMULATION")
    tui.info("Simulating patch (syntax check)...")
    sim = patch_simulator.simulate(diff, PROJECT_ROOT)
    if not sim["valid"]:
        tui.error("Patch simulation failed:")
        for err in sim["errors"]:
            tui.error(f"  {err}")
        logger.error("patch_simulator", "; ".join(sim["errors"]))
        if not tui.confirm("Patch has syntax errors. Proceed anyway?", default=False):
            return

    # Minimize
    tui.info("Minimizing patch...")
    diff = patch_minimizer.minimize(diff) or diff

    # Static analysis
    tui.info("Running static analysis...")
    lint_output = run_static_analysis(diff)
    if lint_output:
        tui.section("LINT")
        tui.warn(lint_output)

    # Risk scoring
    tui.info("Scoring risk...")
    risk = risk_scorer.score(diff)
    tui.section("RISK")
    tui.info(f"Score: {risk['score']}  Level: {risk['level'].upper()}")
    for reason in risk["reasons"]:
        tui.info(f"  · {reason}")
    logger.event("risk_score", risk)

    reviewer_required = risk["level"] in ("medium", "high") or bool(lint_output)
    if not reviewer_required:
        tui.info("Low risk — skipping reviewer")

    # Review loop
    if reviewer_required:
        for attempt in range(1, MAX_DEBUG_CYCLES + 1):
            tui.section(f"REVIEWER (attempt {attempt}/{MAX_DEBUG_CYCLES})")
            review_input = f"Diff:\n{diff}"
            if lint_output:
                review_input += f"\n\nLint:\n{lint_output}"

            review = call_claude("reviewer.md", review_input)

            if "status: ok" in review.lower():
                tui.success("Review passed!")
                break

            tui.warn(f"Feedback: {review[:300]}")
            logger.event("review_feedback", {"attempt": attempt, "feedback": review[:300]})

            if attempt >= MAX_DEBUG_CYCLES:
                tui.section("MAX CYCLES REACHED")
                if not tui.confirm("Apply anyway?"):
                    logger.event("task_end", {"result": "max_cycles_rejected"})
                    return
            else:
                tui.section(f"PATCHER (attempt {attempt})")
                patch_input = f"Issue:\n{review[:600]}\n\nDiff:\n{diff}"
                raw2  = call_claude("patcher.md", patch_input)
                diff2 = extract_diff(raw2)
                if diff2:
                    diff = patch_minimizer.minimize(diff2) or diff2
                    tui.print_diff(diff)

    # Final
    tui.section("FINAL DIFF")
    tui.print_diff(diff)
    logger.patch(diff)

    choice = tui.prompt("Apply changes? [y/n/copy/settings]", default="y").strip().lower()

    if choice == "y":
        tui.info("Applying patch...")
        applied, errors = apply_diff_python(diff)
        for msg in applied:
            tui.success(msg)
        for msg in errors:
            tui.error(msg)
        modified_files = [re.sub(r'^(Modified|Created): ', '', m) for m in applied]
        fix_result = auto_fixer.run(PROJECT_ROOT, files=modified_files or None)
        if fix_result["applied"]:
            tui.info("Auto-fixed: " + ", ".join(t["tool"] for t in fix_result["applied"]))
        logger.event("task_end", {"result": "applied", "files": applied, "errors": errors})
    elif choice == "copy":
        for tool in [["pbcopy"], ["xclip", "-selection", "clipboard"]]:
            try:
                subprocess.run(tool, input=diff, text=True)
                tui.success("Copied to clipboard.")
                break
            except FileNotFoundError:
                continue
        else:
            tui.error("No clipboard tool found.")
    elif choice == "settings":
        manage_settings()
        tui.info("Settings updated. Run task again if needed.")
    else:
        logger.event("task_end", {"result": "skipped"})


def run(task, command=None):
    try:
        refresh_repo_map(PROJECT_ROOT)

        _task_type = task_classifier.classify(task, command)
        if needs_planning(task, _task_type):
            tui.section("PLANNER")
            plan_text = call_claude("planner.md", f"Task: {task}")
            steps = parse_plan(plan_text, task)
            tui.info(f"→ {len(steps)} step(s) planned")
        else:
            steps = [task]

        for i, step in enumerate(steps, 1):
            if len(steps) > 1:
                tui.section(f"STEP {i}/{len(steps)}: {step}")
            process_task(step, command)

    except KeyboardInterrupt:
        tui.error("Interrupted.")
    finally:
        tui.print_metrics(METRICS.get_data())


# ── Entry ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _args = sys.argv[1:]
    _task_parts = []
    _i = 0
    while _i < len(_args):
        if _args[_i] == "--root" and _i + 1 < len(_args):
            PROJECT_ROOT = Path(_args[_i + 1]).resolve()
            _i += 2
        else:
            _task_parts.append(_args[_i])
            _i += 1

    os.chdir(PROJECT_ROOT)

    try:
        raw_input = " ".join(_task_parts).strip()
        if not raw_input:
            sys.exit(0)
        command, task = command_router.parse(raw_input)
        run(task, command)
    except KeyboardInterrupt:
        tui.error("Exited.")
        sys.exit(0)
