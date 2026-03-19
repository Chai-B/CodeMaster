#!/usr/bin/env python3
"""CodeMaster Python backend — deterministic modular orchestration pipeline.

Usage: python3 codemaster.py --root <dir> <task description>

Output protocol (Claude Code style):
  ⏺ STEP         main pipeline step
  ⎿  detail       nested info
    ⎿  sub-detail  deep nested info
  ⎿  ✓ success    success within nesting
  ⎿  ✗ error      error within nesting
  ⎿  ⚠ warning    warning within nesting
  CM_METRICS:{...} metrics JSON
  CM_DIFF:line     diff line (captured by TUI, not displayed)
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
from tempfile import NamedTemporaryFile

# ── modular imports ───────────────────────────────────────────────────────────
from pipeline.command_router import route_command
from pipeline.task_classifier import classify_task
from pipeline.searcher import search_files
from pipeline.dependency_expander import expand_dependencies
from pipeline.context_builder import build_minimal_context
from pipeline.static_analysis import run_static_analysis
from pipeline.auto_fixer import run_auto_fixers
from pipeline.patch_simulator import simulate_patch, validate_patch_size, validate_syntax
from pipeline.risk_scorer import compute_risk_score
from pipeline.patch_minimizer import optimize_patch, strip_markdown

# ── config ────────────────────────────────────────────────────────────────────

def load_config() -> dict:
    return {
        "max_files": int(os.environ.get("CM_MAX_FILES", "2")),
        "max_fns":   int(os.environ.get("CM_MAX_FNS",   "2")),
        "max_debug": int(os.environ.get("CM_MAX_DEBUG", "1")),
        "claude_cmd": os.environ.get("CM_CLAUDE_CMD", "claude"),
    }

# ── task-type stage config ────────────────────────────────────────────────────

# Stages that are skipped for each task type
_SKIP_STAGES: dict[str, set[str]] = {
    "DOCS":     {"DEPENDENCIES", "STATIC_ANALYSIS", "AUTO_FIXER", "REVIEWER"},
    "GENERATE": {"DEPENDENCIES", "STATIC_ANALYSIS", "AUTO_FIXER", "REVIEWER"},
}

def _should_skip(stage: str, task_type: str) -> bool:
    return stage in _SKIP_STAGES.get(task_type, set())

# ── output helpers (Claude Code style) ───────────────────────────────────────

_calls = 0
_total_tokens = 0
_total_context = 0
_t0 = time.time()

def step(name: str):
    print(f"\n⏺  {name}", flush=True)

def detail(msg: str):
    print(f"  ⎿  {msg}", flush=True)

def subdetail(msg: str):
    print(f"    ⎿  {msg}", flush=True)

def ok(msg: str):
    print(f"  ⎿  ✓ {msg}", flush=True)

def fail(msg: str):
    print(f"  ⎿  ✗ {msg}", flush=True)

def warning(msg: str):
    print(f"  ⎿  ⚠  {msg}", flush=True)

def emit_metrics():
    avg = _total_context // _calls if _calls else 0
    m = {"calls": _calls, "total_tokens": _total_tokens, "elapsed": round(time.time() - _t0, 1), "avg_context": avg}
    print(f"CM_METRICS:{json.dumps(m)}", flush=True)

# ── claude CLI ────────────────────────────────────────────────────────────────

def _clean_response(text: str) -> str:
    text = re.sub(r'<tool_calls>[\s\S]*?</tool_calls>', '', text)
    text = re.sub(r'<tool_results>[\s\S]*?</tool_results>', '', text)
    text = re.sub(r'<tool_call>[\s\S]*?</tool_call>', '', text)
    text = re.sub(r'<tool_result>[\s\S]*?</tool_result>', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def claude(prompt: str, cfg: dict, stage: str = "unknown") -> str:
    global _calls, _total_tokens, _total_context
    cmd_name = cfg["claude_cmd"]
    est_in = len(prompt) // 4
    detail(f"→ Calling Claude [{stage}] (~{est_in:,} tokens)")
    t0 = time.time()
    try:
        proc = subprocess.Popen(
            [cmd_name, "-p", prompt, "--output-format", "text", "--tools", "",
             "--append-system-prompt",
             "Respond with plain text only. Never output XML tags like <tool_calls>, <tool_results>, or similar markup."],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    except FileNotFoundError:
        raise RuntimeError(f"'{cmd_name}' not found — install Claude Code CLI")

    _done = threading.Event()
    def _heartbeat():
        while not _done.wait(timeout=60):
            detail(f"  ... still working [{stage}] ({time.time() - t0:.0f}s elapsed)")
    hb = threading.Thread(target=_heartbeat, daemon=True)
    hb.start()

    try:
        stdout, stderr = proc.communicate(timeout=1800)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        _done.set()
        partial = (stdout or "") + "\n" + (stderr or "")
        log_dir = Path.home() / ".codemaster" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        (log_dir / f"partial_{stage}.txt").write_text(partial)
        raise RuntimeError(f"Claude timed out — partial saved to ~/.codemaster/logs/")
    finally:
        _done.set()

    dur = time.time() - t0
    out = _clean_response(stdout.strip())
    if proc.returncode != 0:
        raise RuntimeError(f"Claude failed: {stderr.strip()[:300]}")
    est_out = len(out) // 4
    _calls += 1
    _total_tokens += est_in + est_out
    _total_context += est_in
    detail(f"← Done [{stage}] ({est_out:,} tokens, {dur:.1f}s)")
    log_file = Path("logs/calls.jsonl")
    log_file.parent.mkdir(exist_ok=True)
    with log_file.open("a") as f:
        f.write(json.dumps({"stage": stage, "in_tokens": est_in, "out_tokens": est_out, "duration": round(dur, 2)}) + "\n")
    emit_metrics()
    return out

# ── agent prompts ─────────────────────────────────────────────────────────────

def load_prompt(name: str, base_dir: Path, **kwargs: str) -> str:
    agent_file = base_dir / "agents" / f"{name}.md"
    if agent_file.exists():
        tpl = agent_file.read_text()
    else:
        tpl = {
            "coder": "Generate a unified diff for:\n{task}\n\n{plan_section}Context:\n{context}",
            "reviewer": "Review this diff:\n{diff}\n\nTask: {task}",
            "patcher": "Fix these issues in the diff:\n{issues}\n\nDiff:\n{diff}\n\nTask: {task}",
        }.get(name, "{task}")
    return tpl.format(**kwargs)

def diff_files(diff: str) -> list[str]:
    out = []
    for ln in diff.splitlines():
        if ln.startswith("+++ "):
            p = ln[4:].strip().removeprefix("b/")
            if p and p != "/dev/null" and p not in out:
                out.append(p)
    return out

def diff_file_stats(diff: str) -> dict[str, dict[str, int]]:
    stats: dict[str, dict[str, int]] = {}
    current = None
    for ln in diff.splitlines():
        if ln.startswith("+++ "):
            current = ln[4:].strip().removeprefix("b/")
            if current and current != "/dev/null":
                stats[current] = {"added": 0, "removed": 0}
            else:
                current = None
        elif current and current in stats:
            if ln.startswith("+") and not ln.startswith("+++"):
                stats[current]["added"] += 1
            elif ln.startswith("-") and not ln.startswith("---"):
                stats[current]["removed"] += 1
    return stats

def apply_patch(diff: str, root: Path) -> bool:
    with NamedTemporaryFile(mode="w", suffix=".patch", delete=False) as f:
        f.write(diff); f.flush()
        try:
            r = subprocess.run(["git", "apply", f.name], capture_output=True, text=True, timeout=10, cwd=root)
            return r.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

# ── pipeline ──────────────────────────────────────────────────────────────────

def run_pipeline(task_raw: str, root: Path, base_dir: Path):
    cfg = load_config()

    # Load repo map
    repo_map = {}
    rmap_path = root / "repo_map.json"
    if rmap_path.exists():
        try:
            repo_map = json.loads(rmap_path.read_text())
        except Exception:
            pass

    Path("logs").mkdir(exist_ok=True)
    with open("logs/codemaster.log", "a") as f:
        f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Started `{task_raw}`\n")

    # ── route & classify ──
    step("ROUTER & CLASSIFIER")
    cmd, task_desc = route_command(task_raw)

    if cmd:
        task_type = cmd.upper()
        detail(f"Slash command parsed: /{cmd}")
    else:
        task_type = classify_task(task_desc)
        detail(f"Classified: {task_type}")

    if not task_desc:
        fail("No task description"); return

    # ── search ──
    step("SEARCH")
    files = search_files(task_desc, cfg["max_files"], repo_map)
    if not files:
        fallbacks = ["package.json", "codemaster.py", "src/index.tsx", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile"]
        for fb in fallbacks:
            if (root / fb).exists() and len(files) < cfg["max_files"]:
                files.append(fb)
        if files:
            detail(f"No keyword matches — using {len(files)} key project files")
        else:
            warning("No matching files found — context will be empty")
    else:
        detail(f"Search ranked & returned {len(files)} file(s)")

    for f in files: subdetail(f)

    # ── deps (skip for DOCS/GENERATE) ──
    deps: list = []
    if _should_skip("DEPENDENCIES", task_type):
        step("DEPENDENCIES")
        detail("Skipped (not needed for this task type)")
    else:
        step("DEPENDENCIES")
        deps = expand_dependencies([root / f for f in files])
        detail(f"Found {len(deps)} dependent symbols using AST")
        for d in deps[:5]: subdetail(f"{d['type']}: {d['name']}")
        if len(deps) > 5: subdetail(f"... and {len(deps) - 5} more")

    # ── context ──
    step("CONTEXT")
    ctx = build_minimal_context(files, task_desc, root, cfg["max_fns"], deps, repo_map, task_type)
    est_tokens = len(ctx) // 4
    detail(f"Context: {len(ctx):,} chars (~{est_tokens:,} tokens)")

    # ── code ──
    step("CODER")
    prompt = load_prompt("coder", base_dir, task=task_desc, context=ctx, plan_section="")
    diff = strip_markdown(claude(prompt, cfg, "coder"))
    changed = diff_files(diff)
    stats = diff_file_stats(diff)
    detail(f"Generated patch modifying {len(changed)} file{'s' if len(changed) != 1 else ''}")
    for f in changed:
        s = stats.get(f, {"added": 0, "removed": 0})
        subdetail(f"{f} (+{s['added']}, -{s['removed']})")

    for ln in diff.splitlines():
        print(f"CM_DIFF:{ln}", flush=True)

    # ── analyze + autofix (skip for docs/generate) ──
    if _should_skip("STATIC_ANALYSIS", task_type):
        step("ANALYSIS + AUTOFIX")
        detail("Skipped (not needed for this task type)")
    else:
        step("ANALYSIS + AUTOFIX")
        with ThreadPoolExecutor(max_workers=2) as pool:
            fut_analysis = pool.submit(run_static_analysis, changed, root)
            fut_fixes    = pool.submit(run_auto_fixers, changed, root)
            results = fut_analysis.result()
            fixes   = fut_fixes.result()
        for tool_name, passed in results:
            if passed: ok(f"{tool_name}: pass")
            else: fail(f"{tool_name}: FAIL")
        for f in fixes: ok(f"{f}")
        if not fixes: detail("No auto-formatting applied")

    # ── minimize FIRST (before validation) ──
    step("MINIMIZE")
    before = len(diff.splitlines())
    diff = optimize_patch(diff)
    after = len(diff.splitlines())
    removed = before - after
    detail(f"Final: {after} lines" + (f" (removed {removed} irrelevant lines)" if removed else ""))

    with open("logs/last_patch.diff", "w") as f:
        f.write(diff)

    # ── validate the minimized patch ──
    step("VALIDATION")
    patch_errors = validate_patch_size(diff, 300)
    for err in patch_errors:
        warning(err)

    sim_ok, sim_err = simulate_patch(diff, root)
    if sim_ok:
        ok("Dry-run: patch applies cleanly")
    else:
        fail(f"Dry-run: patch does not apply cleanly ({sim_err[:80]})")

    # ── risk ──
    step("RISK ASSESSMENT")
    score, reasons = compute_risk_score(diff, changed, task_type)
    level = "Low" if score <= 3 else ("Medium" if score <= 6 else "High")
    detail(f"Score: {score} ({level} risk)")
    for r in reasons: subdetail(r)

    # ── review (only if score >= 7, and not skipped by task type) ──
    if score >= 7 and not _should_skip("REVIEWER", task_type):
        step("REVIEWER")
        prompt = load_prompt("reviewer", base_dir, task=task_desc, diff=diff)
        rev_raw = claude(prompt, cfg, "reviewer")
        issues = [ln.strip()[6:].strip() for ln in rev_raw.splitlines() if ln.strip().upper().startswith("ISSUE:")]
        if not issues or "APPROVED" in rev_raw.upper():
            ok("Review: APPROVED")
        else:
            warning(f"Review: REJECTED ({len(issues)} issue{'s' if len(issues) != 1 else ''})")
            for iss in issues: subdetail(f"Issue: {iss}")

            for cyc in range(cfg["max_debug"]):
                step(f"PATCHER (cycle {cyc + 1}/{cfg['max_debug']})")
                issues_text = "\n".join(f"- {i}" for i in issues)
                # No context needed — patcher only needs diff + issues
                prompt = load_prompt("patcher", base_dir, task=task_desc, diff=diff, issues=issues_text)
                diff = strip_markdown(claude(prompt, cfg, "patcher"))

                detail("Re-reviewing patched diff...")
                prompt = load_prompt("reviewer", base_dir, task=task_desc, diff=diff)
                rev_raw = claude(prompt, cfg, "reviewer")
                issues = [ln.strip()[6:].strip() for ln in rev_raw.splitlines() if ln.strip().upper().startswith("ISSUE:")]
                if not issues or "APPROVED" in rev_raw.upper():
                    ok("Fixed patch APPROVED")
                    break
                warning(f"Cycle {cyc + 1} still has {len(issues)} issue{'s' if len(issues) != 1 else ''}")
            else:
                fail("Max patch cycles reached — manual intervention needed")
                emit_metrics()
                sys.exit(1)

    # ── apply ──
    step("APPLY")
    applied = apply_patch(diff, root)
    if applied:
        ok(f"Applied to {len(changed)} file{'s' if len(changed) != 1 else ''}")
    else:
        warning("Auto-apply failed — saving patch for manual use")

    # ── syntax validation ──
    if applied:
        syntax_errs = validate_syntax(changed, root)
        if syntax_errs:
            for err in syntax_errs: fail(err)
        else:
            ok("AST Syntax check passed entirely")

    # ── done ──
    step("COMPLETE")
    ok("Pipeline finished")
    detail(f"{_calls} call{'s' if _calls != 1 else ''} · {_total_tokens:,} tokens · {time.time() - _t0:.1f}s")
    emit_metrics()

# ── main ──────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    root = Path.cwd()
    task_parts = []
    i = 0
    while i < len(args):
        if args[i] == "--root" and i + 1 < len(args):
            root = Path(args[i + 1])
            i += 2
        else:
            task_parts.append(args[i])
            i += 1
    task = " ".join(task_parts).strip()
    if not task:
        print("Usage: python3 codemaster.py [--root <dir>] <task>", file=sys.stderr)
        sys.exit(1)

    base_dir = Path(__file__).parent
    try:
        run_pipeline(task, root, base_dir)
    except Exception as e:
        fail(f"Pipeline crashed: {str(e)}")
        log_file = Path("logs/codemaster.log")
        log_file.parent.mkdir(exist_ok=True)
        with log_file.open("a") as f:
            f.write(f"ERROR: {str(e)}\n")
        emit_metrics()
        sys.exit(1)

if __name__ == "__main__":
    main()
