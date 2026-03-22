#!/usr/bin/env python3
"""CodeMaster — token-efficient AI coding orchestrator built on Claude Code CLI.

Pipeline:
  Router → Classifier → Search → Dependencies → [Planner] →
  Coder → Changes → Analysis → Validation → Risk → [Reviewer] → Complete

Output protocol (Claude Code style):
  ⏺ STEP         main pipeline step
  ⎿  detail       nested info
    ⎿  sub-detail  deeper nesting
  ⎿  ✓ success    success
  ⎿  ✗ error      error
  ⎿  ⚠ warning    warning
  CM_METRICS:{...} metrics JSON (captured by TUI)
  CM_DIFF:line     diff line (captured by TUI for /diff command)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pipeline.command_router import route_command
from pipeline.task_classifier import classify_task
from pipeline.searcher import search_files
from pipeline.dependency_expander import expand_dependencies
from pipeline.static_analysis import run_static_analysis
from pipeline.auto_fixer import run_auto_fixers
from pipeline.patch_simulator import validate_syntax
from pipeline.risk_scorer import compute_risk_score

# ── module-level base dir (set in main before first use) ──────────────────────
_base_dir: Path = Path(__file__).parent

# ── config ────────────────────────────────────────────────────────────────────

def load_config() -> dict:
    return {
        "max_files":  int(os.environ.get("CM_MAX_FILES",  "3")),
        "max_fns":    int(os.environ.get("CM_MAX_FNS",    "3")),
        "max_debug":  int(os.environ.get("CM_MAX_DEBUG",  "2")),
        "claude_cmd": os.environ.get("CM_CLAUDE_CMD", "claude"),
    }

# ── stage skip rules ──────────────────────────────────────────────────────────

_SKIP_STAGES: dict[str, set[str]] = {
    "DOCS":     {"DEPENDENCIES", "STATIC_ANALYSIS", "REVIEWER"},
    "GENERATE": {"DEPENDENCIES", "STATIC_ANALYSIS"},
}

def _should_skip(stage: str, task_type: str) -> bool:
    return stage in _SKIP_STAGES.get(task_type, set())

# ── output helpers ────────────────────────────────────────────────────────────

_calls = 0
_total_tokens = 0
_total_context = 0
_t0 = time.time()

def step(name: str):      print(f"\n⏺  {name}", flush=True)
def detail(msg: str):     print(f"  ⎿  {msg}", flush=True)
def subdetail(msg: str):  print(f"    ⎿  {msg}", flush=True)
def ok(msg: str):         print(f"  ⎿  ✓ {msg}", flush=True)
def fail(msg: str):       print(f"  ⎿  ✗ {msg}", flush=True)
def warning(msg: str):    print(f"  ⎿  ⚠  {msg}", flush=True)

def emit_metrics():
    avg = _total_context // _calls if _calls else 0
    m = {
        "calls": _calls,
        "total_tokens": _total_tokens,
        "elapsed": round(time.time() - _t0, 1),
        "avg_context": avg,
    }
    print(f"CM_METRICS:{json.dumps(m)}", flush=True)

# ── Claude CLI ────────────────────────────────────────────────────────────────

# System prompts for each mode
_EDIT_SYSTEM = (
    "You are an expert software engineer with full access to all available tools — "
    "Read, Write, Edit, Bash, Grep, Glob, and any others available to you. "
    "Use whatever combination of tools is needed to fully and correctly complete the task. "
    "Run tests, search code, execute commands — do whatever the task requires. "
    "When the entire task is finished, output a short summary of what you changed. "
    "If the task is large and you could not fully complete it in this pass, end your "
    "response with exactly: NEEDS_CONTINUATION: <one sentence describing what remains>"
)
_TEXT_SYSTEM = (
    "Respond with plain text only. "
    "Never output XML tags like <tool_calls>, <tool_results>, or similar markup."
)

def _clean_response(text: str) -> str:
    text = re.sub(r'<tool_calls>[\s\S]*?</tool_calls>', '', text)
    text = re.sub(r'<tool_results>[\s\S]*?</tool_results>', '', text)
    text = re.sub(r'<tool_call>[\s\S]*?</tool_call>', '', text)
    text = re.sub(r'<tool_result>[\s\S]*?</tool_result>', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def claude(prompt: str, cfg: dict, stage: str, edit_mode: bool = False) -> str:
    """Call Claude Code CLI.

    edit_mode=False (default): text-only, no file tools — for planner / reviewer.
    edit_mode=True:            Claude can Read/Write/Edit files in the cwd
                               (which is already the user's project, inherited
                               from the TUI's spawnProc call).
    """
    global _calls, _total_tokens, _total_context
    cmd_name = cfg["claude_cmd"]
    est_in = len(prompt) // 4
    detail(f"→ Claude [{stage}] (~{est_in:,} tokens)")
    t0 = time.time()

    if edit_mode:
        # Full-capability mode: all tools, no permission prompts blocking the pipeline
        args = [
            cmd_name, "-p", prompt,
            "--output-format", "text",
            "--dangerously-skip-permissions",
            "--append-system-prompt", _EDIT_SYSTEM,
        ]
    else:
        # Text-only mode: planning and reviewing — no file side-effects
        args = [
            cmd_name, "-p", prompt,
            "--output-format", "text",
            "--tools", "",
            "--append-system-prompt", _TEXT_SYSTEM,
        ]

    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError:
        raise RuntimeError(
            f"'{cmd_name}' not found — install Claude Code CLI: "
            "npm install -g @anthropic-ai/claude-code"
        )

    _done = threading.Event()

    def _heartbeat():
        while not _done.wait(timeout=60):
            detail(f"  ... still working [{stage}] ({time.time() - t0:.0f}s)")

    hb = threading.Thread(target=_heartbeat, daemon=True)
    hb.start()

    try:
        stdout, stderr = proc.communicate(timeout=1800)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        _done.set()
        raise RuntimeError(f"Claude timed out after 30 min [{stage}]")
    finally:
        _done.set()

    dur = time.time() - t0
    out = _clean_response(stdout.strip())

    if proc.returncode != 0:
        raise RuntimeError(f"Claude failed [{stage}]: {stderr.strip()[:300]}")

    est_out = len(out) // 4
    _calls += 1
    _total_tokens += est_in + est_out
    _total_context += est_in
    detail(f"← Done [{stage}] ({est_out:,} tokens, {dur:.1f}s)")

    log_file = _base_dir / "logs" / "calls.jsonl"
    log_file.parent.mkdir(exist_ok=True)
    with log_file.open("a") as f:
        f.write(json.dumps({
            "stage": stage, "in": est_in, "out": est_out, "dur": round(dur, 2)
        }) + "\n")

    emit_metrics()
    return out

# ── agent prompts ─────────────────────────────────────────────────────────────

def load_prompt(name: str, base_dir: Path, **kwargs: str) -> str:
    agent_file = base_dir / "agents" / f"{name}.md"
    if agent_file.exists():
        tpl = agent_file.read_text()
    else:
        defaults: dict[str, str] = {
            "coder":    "TASK: {task}\n\n{plan_section}FILES:\n{context}\n\nUse Read/Edit/Write to make changes. End with one sentence summary.",
            "reviewer": "Review these git changes for bugs.\n\nTASK: {task}\n\nCHANGES:\n{diff}\n\nOutput APPROVED or ISSUE: <description> (max 3 issues).",
            "patcher":  "Fix these issues.\n\nTASK: {task}\n\nISSUES:\n{issues}\n\nCURRENT DIFF:\n{diff}\n\nUse Read/Edit to fix. End with one sentence summary.",
            "planner":  "Break this task into numbered steps (max 6).\n\nTASK: {task}\n\nFILES:\n{context}\n\nNumbered steps only. No explanations.",
        }
        tpl = defaults.get(name, "TASK: {task}\n\nCONTEXT:\n{context}")
    return tpl.format(**kwargs)

# ── git helpers ───────────────────────────────────────────────────────────────

def _run_git(args: list[str], root: Path, timeout: int = 10) -> tuple[bool, str]:
    """Run a git command in root, return (success, stdout)."""
    try:
        r = subprocess.run(
            ["git"] + args,
            capture_output=True, text=True, timeout=timeout, cwd=root,
        )
        return r.returncode == 0, r.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False, ""

def is_git_repo(root: Path) -> bool:
    ok, _ = _run_git(["rev-parse", "--is-inside-work-tree"], root)
    return ok

def get_changed_files(root: Path) -> list[str]:
    """Files modified vs HEAD; falls back to unstaged-only if no commits yet."""
    for cmd in [["diff", "--name-only", "HEAD"], ["diff", "--name-only"]]:
        success, out = _run_git(cmd, root)
        if success and out:
            return [f for f in out.splitlines() if f.strip()]
    return []

def get_git_diff(root: Path) -> str:
    """Full unified diff vs HEAD with no artificial line cap."""
    for cmd in [["diff", "HEAD"], ["diff"]]:
        success, out = _run_git(cmd, root, timeout=15)
        if success and out:
            return out
    return ""

# ── directive builder (compact context for coder) ─────────────────────────────

def build_directive(files: list[str], root: Path, repo_map: dict) -> str:
    """Return a compact pointer context (~30 tokens/file vs 500+ for full content).

    Tells Claude *where* to look — it uses Read to get actual content.
    """
    parts: list[str] = []
    for rel in files:
        fp = root / rel
        if not fp.exists():
            parts.append(f"  - {rel}  (file not found)")
            continue
        try:
            line_count = fp.read_bytes().count(b"\n") + 1
        except OSError:
            line_count = "?"

        # Pull symbol info from repo_map to help Claude orient quickly
        symbols: list[str] = []
        finfo = (repo_map.get("files") or {}).get(rel, {})
        for sym in (finfo.get("symbols") or [])[:5]:
            if isinstance(sym, dict) and sym.get("name"):
                kind = sym.get("type", "")
                line = sym.get("line", "")
                symbols.append(
                    f"{kind} {sym['name']}" + (f" (line {line})" if line else "")
                )

        entry = f"  - {rel} ({line_count} lines)"
        if symbols:
            entry += "\n    " + ", ".join(symbols)
        parts.append(entry)

    return "Files:\n" + "\n".join(parts)

# ── subtask extractor ─────────────────────────────────────────────────────────

def extract_subtasks(plan_text: str) -> list[str]:
    """Parse a numbered list from planner output into individual step strings."""
    subtasks: list[str] = []
    for ln in plan_text.splitlines():
        ln = ln.strip()
        m = re.match(r"^\d+[\.\)]\s+(.+)$", ln)
        if m:
            task = m.group(1).strip()
            if len(task) > 8:
                subtasks.append(task)
    return subtasks  # no cap — planner determines how many steps are needed

# ── coder with dynamic continuation ──────────────────────────────────────────

_CONTINUATION_MARKER = "NEEDS_CONTINUATION:"

def _run_coder_with_continuation(
    initial_prompt: str,
    task_desc: str,
    directive: str,
    cfg: dict,
    base_dir: Path,
    stage: str,
    max_passes: int,
) -> str:
    """Run a coder call and automatically continue if the task signals incomplete.

    Claude signals NEEDS_CONTINUATION: <what remains> when a complex task
    requires more than one pass. We loop, injecting a progress snapshot (git diff)
    each time so Claude picks up exactly where it left off.

    max_passes is derived from max_debug so the user controls the ceiling.
    """
    prompt = initial_prompt
    last_result = ""

    for pass_num in range(1, max_passes + 1):
        stage_label = stage if pass_num == 1 else f"{stage}-cont{pass_num}"
        result = claude(prompt, cfg, stage_label, edit_mode=True)
        last_result = result or ""

        # Strip the marker and check if more work is needed
        marker_pos = last_result.upper().find(_CONTINUATION_MARKER.upper())
        if marker_pos == -1:
            break  # task complete

        remaining = last_result[marker_pos + len(_CONTINUATION_MARKER):].strip()
        summary_so_far = last_result[:marker_pos].strip()

        if summary_so_far:
            detail(f"Pass {pass_num} done: {summary_so_far[:80]}")
        warning(f"Large task — continuing (pass {pass_num + 1}/{max_passes})…")

        if pass_num >= max_passes:
            detail("Max continuation passes reached — stopping here")
            last_result = summary_so_far  # return clean summary, drop marker
            break

        # Build continuation prompt: inject progress snapshot so Claude
        # knows exactly what's already on disk and what still needs to happen.
        try:
            _r = subprocess.run(
                ["git", "diff", "HEAD"], capture_output=True, text=True, timeout=10,
            )
            progress_diff = (
                _r.stdout.strip()
                if _r.returncode == 0 and _r.stdout.strip()
                else "(no git diff available)"
            )
        except Exception:
            progress_diff = "(could not read git diff)"

        # Keep continuation context compact: hint about progress + what's left
        progress_note = (
            f"PROGRESS SO FAR (changes already applied to disk):\n"
            f"{progress_diff[:1200]}{'...(truncated)' if len(progress_diff) > 1200 else ''}\n\n"
            f"REMAINING WORK: {remaining}"
        )
        cont_context = f"{directive}\n\n{progress_note}"
        prompt = load_prompt(
            "coder", base_dir,
            task=task_desc,
            context=cont_context,
            plan_section="",
        )

    return last_result


# ── main pipeline ─────────────────────────────────────────────────────────────

_PLAN_TASK_TYPES = {"FEATURE", "REFACTOR"}

def run_pipeline(task_raw: str, root: Path, base_dir: Path) -> None:
    cfg = load_config()

    # Load repo map (built by repo_builder.py / /scan command)
    repo_map: dict = {}
    rmap_path = root / "repo_map.json"
    if rmap_path.exists():
        try:
            repo_map = json.loads(rmap_path.read_text())
        except Exception:
            pass

    log_dir = base_dir / "logs"
    log_dir.mkdir(exist_ok=True)
    with open(log_dir / "codemaster.log", "a") as f:
        f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {task_raw}\n")

    # Warn early if not in a git repo (change detection will be limited)
    git_available = is_git_repo(root)
    if not git_available:
        warning(f"No git repo at {root} — change detection disabled")

    # ── ROUTER & CLASSIFIER ──────────────────────────────────────────────────
    step("ROUTER & CLASSIFIER")
    cmd, task_desc = route_command(task_raw)

    if cmd:
        task_type = cmd.upper()
        detail(f"Command: /{cmd}")
    else:
        task_type = classify_task(task_desc)
        detail(f"Classified: {task_type}")

    if not task_desc:
        fail("No task description provided")
        return

    # ── SEARCH ───────────────────────────────────────────────────────────────
    step("SEARCH")
    files = search_files(task_desc, cfg["max_files"], repo_map)

    if not files:
        # Fall back to well-known project entry points
        fallbacks = [
            "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile",
            "codemaster.py", "main.py", "app.py", "index.py",
            "src/index.tsx", "src/index.ts", "src/main.ts", "index.ts",
            "tsconfig.json", "README.md",
        ]
        files = [fb for fb in fallbacks if (root / fb).exists()][: cfg["max_files"]]
        if files:
            detail(f"No keyword matches — using {len(files)} entry-point file(s)")
        else:
            warning("No matching files found — coder will need to explore the project")
    else:
        detail(f"{len(files)} file(s) found")

    for f in files:
        subdetail(f)

    # ── DEPENDENCIES ─────────────────────────────────────────────────────────
    deps: list = []
    if not _should_skip("DEPENDENCIES", task_type):
        step("DEPENDENCIES")
        deps = expand_dependencies([root / f for f in files])
        detail(f"{len(deps)} dependent symbol(s) identified")
        for d in deps[:4]:
            subdetail(f"{d['type']}: {d['name']}")

    # ── PLANNER ──────────────────────────────────────────────────────────────
    plan_section = ""
    subtasks: list[str] = []

    if task_type in _PLAN_TASK_TYPES:
        step("PLANNER")
        directive = build_directive(files, root, repo_map)
        plan_prompt = load_prompt("planner", base_dir, task=task_desc, context=directive)
        plan_text = claude(plan_prompt, cfg, "planner", edit_mode=False)
        subtasks = extract_subtasks(plan_text)

        if subtasks:
            plan_section = "IMPLEMENTATION STEPS:\n" + "\n".join(
                f"{i+1}. {s}" for i, s in enumerate(subtasks)
            ) + "\n\n"
            detail(f"{len(subtasks)} step(s) planned")
            for s in subtasks:
                subdetail(s[:80])
        else:
            plan_section = f"IMPLEMENTATION PLAN:\n{plan_text}\n\n"
            detail("Plan generated")

    # ── CODER ─────────────────────────────────────────────────────────────────
    step("CODER")
    directive = build_directive(files, root, repo_map)

    if deps:
        dep_lines = "\n".join(
            f"  - {d['name']} ({d['type']})" +
            (f" in {Path(d.get('source_file', '')).name}" if d.get('source_file') else "")
            for d in deps[:6]
        )
        directive += f"\n\nKey dependencies:\n{dep_lines}"

    if subtasks and len(subtasks) > 1:
        # Planner broke this into discrete steps — execute each in sequence.
        # Each step is a focused call so even large features are fully handled.
        detail(f"Executing {len(subtasks)} planned step(s)")
        for i, sub in enumerate(subtasks, 1):
            detail(f"Step {i}/{len(subtasks)}: {sub[:70]}")
            sub_prompt = load_prompt(
                "coder", base_dir,
                task=sub, context=directive, plan_section="",
            )
            result = _run_coder_with_continuation(
                sub_prompt, sub, directive, cfg, base_dir,
                stage=f"coder-{i}", max_passes=cfg["max_debug"] + 1,
            )
            if result:
                subdetail(result[:100] + ("…" if len(result) > 100 else ""))
    else:
        coder_prompt = load_prompt(
            "coder", base_dir,
            task=task_desc, context=directive, plan_section=plan_section,
        )
        result = _run_coder_with_continuation(
            coder_prompt, task_desc, directive, cfg, base_dir,
            stage="coder", max_passes=cfg["max_debug"] + 1,
        )
        if result:
            detail(result[:140] + ("…" if len(result) > 140 else ""))

    # ── CHANGES ───────────────────────────────────────────────────────────────
    step("CHANGES")

    if git_available:
        changed = get_changed_files(root)
        git_diff = get_git_diff(root)

        if changed:
            ok(f"{len(changed)} file(s) modified")
            for f in changed:
                subdetail(f)
            if git_diff:
                (log_dir / "last_patch.diff").write_text(git_diff)
                # Emit for TUI /diff command
                for ln in git_diff.splitlines():
                    print(f"CM_DIFF:{ln}", flush=True)
        else:
            warning("No file changes detected via git — Claude may have reported an issue above")
            git_diff = ""
    else:
        changed = []
        git_diff = ""
        detail("Skipped (no git repo)")

    # ── ANALYSIS + AUTOFIX ────────────────────────────────────────────────────
    if not _should_skip("STATIC_ANALYSIS", task_type) and changed:
        step("ANALYSIS + AUTOFIX")
        with ThreadPoolExecutor(max_workers=2) as pool:
            fut_analysis = pool.submit(run_static_analysis, changed, root)
            fut_fixes    = pool.submit(run_auto_fixers, changed, root)
            analysis_results = fut_analysis.result()
            fix_results      = fut_fixes.result()

        for tool_name, passed in analysis_results:
            (ok if passed else fail)(f"{tool_name}: {'pass' if passed else 'FAIL'}")

        for msg in (fix_results or []):
            ok(msg)
        if not fix_results:
            detail("No auto-formatting applied")

    # ── VALIDATION ────────────────────────────────────────────────────────────
    if changed:
        step("VALIDATION")
        syntax_errs = validate_syntax(changed, root)
        if syntax_errs:
            for err in syntax_errs:
                fail(err)
        else:
            ok("Syntax check passed")

    # ── RISK ASSESSMENT ───────────────────────────────────────────────────────
    step("RISK ASSESSMENT")
    score, reasons = compute_risk_score(git_diff, changed, task_type)
    level = "Low" if score <= 3 else ("Medium" if score <= 6 else "High")
    detail(f"Score: {score} ({level} risk)")
    for r in reasons:
        subdetail(r)

    # ── REVIEWER ──────────────────────────────────────────────────────────────
    if score >= 7 and not _should_skip("REVIEWER", task_type) and git_diff:
        step("REVIEWER")
        rev_prompt = load_prompt("reviewer", base_dir, task=task_desc, diff=git_diff)
        rev_raw = claude(rev_prompt, cfg, "reviewer", edit_mode=False)
        issues = [
            ln.strip()[6:].strip()
            for ln in rev_raw.splitlines()
            if ln.strip().upper().startswith("ISSUE:")
        ]

        if not issues or "APPROVED" in rev_raw.upper():
            ok("APPROVED")
        else:
            warning(f"REJECTED — {len(issues)} issue(s)")
            for iss in issues:
                subdetail(f"Issue: {iss}")

            for cyc in range(cfg["max_debug"]):
                step(f"PATCHER (cycle {cyc + 1}/{cfg['max_debug']})")
                issues_text = "\n".join(f"- {i}" for i in issues)
                # Refresh diff before each patcher call
                git_diff = get_git_diff(root)
                patch_prompt = load_prompt(
                    "patcher", base_dir,
                    task=task_desc, diff=git_diff, issues=issues_text,
                )
                patch_summary = claude(patch_prompt, cfg, "patcher", edit_mode=True)
                if patch_summary:
                    detail(patch_summary[:100])

                # Re-review after patching
                git_diff = get_git_diff(root)
                rev_prompt = load_prompt("reviewer", base_dir, task=task_desc, diff=git_diff)
                rev_raw = claude(rev_prompt, cfg, "reviewer", edit_mode=False)
                issues = [
                    ln.strip()[6:].strip()
                    for ln in rev_raw.splitlines()
                    if ln.strip().upper().startswith("ISSUE:")
                ]

                if not issues or "APPROVED" in rev_raw.upper():
                    ok("APPROVED after patching")
                    break
                warning(f"Cycle {cyc + 1}: {len(issues)} issue(s) remain")
            else:
                fail("Max patch cycles reached — review manually with /diff")
                emit_metrics()
                sys.exit(1)

    # ── COMPLETE ──────────────────────────────────────────────────────────────
    step("COMPLETE")
    ok(f"Pipeline finished — {len(changed)} file(s) changed" if changed else "Pipeline finished")
    detail(
        f"{_calls} call{'s' if _calls != 1 else ''} · "
        f"{_total_tokens:,} tokens · "
        f"{time.time() - _t0:.1f}s"
    )
    emit_metrics()

# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args = sys.argv[1:]
    root = Path.cwd()
    task_parts: list[str] = []
    i = 0
    while i < len(args):
        if args[i] == "--root" and i + 1 < len(args):
            root = Path(args[i + 1]).resolve()
            i += 2
        else:
            task_parts.append(args[i])
            i += 1

    task = " ".join(task_parts).strip()
    if not task:
        print("Usage: python3 codemaster.py [--root <dir>] <task>", file=sys.stderr)
        sys.exit(1)

    base_dir = Path(__file__).parent
    global _base_dir
    _base_dir = base_dir

    try:
        run_pipeline(task, root, base_dir)
    except Exception as e:
        fail(f"Pipeline crashed: {e}")
        log_file = base_dir / "logs" / "codemaster.log"
        log_file.parent.mkdir(exist_ok=True)
        with log_file.open("a") as f:
            f.write(f"ERROR: {e}\n")
        emit_metrics()
        sys.exit(1)


if __name__ == "__main__":
    main()
