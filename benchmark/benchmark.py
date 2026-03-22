#!/usr/bin/env python3
"""
CodeMaster vs Claude Code — automated benchmark.

Runs both tools on the same prompts against the same sample project,
measures wall time / tokens / files changed, judges output quality with
an LLM, and prints a comparison report.

Usage:
    python3 benchmark/benchmark.py            # full run (5 prompts)
    python3 benchmark/benchmark.py --quick    # first prompt only
    python3 benchmark/benchmark.py --no-judge # skip LLM quality scoring
    python3 benchmark/benchmark.py --out results.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

BENCH_DIR   = Path(__file__).parent
SAMPLE_DIR  = BENCH_DIR / "sample_project"
PROMPTS_FILE = BENCH_DIR / "prompts.json"


# ── locate codemaster.py ──────────────────────────────────────────────────────

def find_codemaster() -> Path:
    candidates = [
        Path(os.environ.get("CODEMASTER_PATH", "")),
        BENCH_DIR.parent / "codemaster.py",               # running from repo root
        Path.home() / ".codemaster" / "codemaster.py",   # installed via install.sh
    ]
    for p in candidates:
        if p and p.exists():
            return p.resolve()
    sys.exit(
        "ERROR: codemaster.py not found.\n"
        "Set CODEMASTER_PATH or run from the repo root.\n"
        "Install: curl -fsSL https://raw.githubusercontent.com/Chai-B/CodeMaster/main/install.sh | bash"
    )


# ── project fixture ───────────────────────────────────────────────────────────

def setup_project() -> Path:
    """Copy sample project to a fresh temp dir with a git history."""
    tmp = Path(tempfile.mkdtemp(prefix="cm_bench_"))
    shutil.copytree(str(SAMPLE_DIR), str(tmp), dirs_exist_ok=True)
    for cmd in [
        ["git", "init", "-q"],
        ["git", "config", "user.email", "bench@test.local"],
        ["git", "config", "user.name", "Bench"],
        ["git", "add", "."],
        ["git", "commit", "-q", "-m", "initial"],
    ]:
        subprocess.run(cmd, cwd=tmp, check=True, capture_output=True)
    return tmp


def diff_stats(project_dir: Path) -> tuple[str, int, int, int]:
    """Return (diff_text, files_changed, lines_added, lines_deleted)."""
    r = subprocess.run(
        ["git", "diff", "HEAD"], cwd=project_dir, capture_output=True, text=True
    )
    diff = r.stdout.strip()
    added   = max(0, diff.count("\n+") - diff.count("\n+++"))
    deleted = max(0, diff.count("\n-") - diff.count("\n---"))
    files   = len(re.findall(r"^diff --git", diff, re.MULTILINE))
    return diff, files, added, deleted


# ── result dataclass ──────────────────────────────────────────────────────────

@dataclass
class RunResult:
    tool:          str
    task:          str
    success:       bool
    wall_time:     float
    in_tokens:     int
    out_tokens:    int
    total_tokens:  int
    calls:         int
    files_changed: int
    lines_added:   int
    lines_deleted: int
    diff:          str   = field(default="", repr=False)
    output:        str   = field(default="", repr=False)
    error:         str   = ""
    quality_score: float = 0.0
    judge_notes:   str   = ""


# ── run tools ─────────────────────────────────────────────────────────────────

def run_codemaster(task: str, project_dir: Path, codemaster_py: Path,
                   timeout: int = 300) -> RunResult:
    env = {**os.environ, "PYTHONPATH": str(codemaster_py.parent), "PYTHONUNBUFFERED": "1"}
    t0 = time.time()
    try:
        r = subprocess.run(
            [sys.executable, str(codemaster_py), task],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        wall = round(time.time() - t0, 1)

        # Extract the last CM_METRICS line (metrics are emitted after each call)
        metrics: dict = {}
        for line in r.stdout.splitlines():
            if line.startswith("CM_METRICS:"):
                try:
                    metrics = json.loads(line[len("CM_METRICS:"):])
                except Exception:
                    pass

        diff, files, added, deleted = diff_stats(project_dir)
        avg_ctx   = metrics.get("avg_context", 0)
        calls     = metrics.get("calls", 0)
        total_tok = metrics.get("total_tokens", 0)
        in_tok    = avg_ctx * calls
        out_tok   = max(0, total_tok - in_tok)

        return RunResult(
            tool="codemaster", task=task, success=(r.returncode == 0),
            wall_time=wall, in_tokens=in_tok, out_tokens=out_tok,
            total_tokens=total_tok, calls=calls,
            files_changed=files, lines_added=added, lines_deleted=deleted,
            diff=diff, output=r.stdout,
            error=r.stderr[:500] if r.returncode != 0 else "",
        )
    except subprocess.TimeoutExpired:
        return RunResult("codemaster", task, False, timeout, 0, 0, 0, 0, 0, 0, 0,
                         error="Timed out")
    except Exception as e:
        return RunResult("codemaster", task, False, round(time.time()-t0, 1),
                         0, 0, 0, 0, 0, 0, 0, error=str(e))


def run_claude(task: str, project_dir: Path,
               claude_cmd: str = "claude", timeout: int = 300) -> RunResult:
    t0 = time.time()
    try:
        r = subprocess.run(
            [claude_cmd, "--dangerously-skip-permissions", "-p", task,
             "--output-format", "text"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        wall    = round(time.time() - t0, 1)
        output  = r.stdout.strip()
        in_tok  = len(task) // 4
        out_tok = len(output) // 4

        diff, files, added, deleted = diff_stats(project_dir)
        return RunResult(
            tool="claude", task=task, success=(r.returncode == 0),
            wall_time=wall, in_tokens=in_tok, out_tokens=out_tok,
            total_tokens=in_tok + out_tok, calls=1,
            files_changed=files, lines_added=added, lines_deleted=deleted,
            diff=diff, output=output,
            error=r.stderr[:500] if r.returncode != 0 else "",
        )
    except subprocess.TimeoutExpired:
        return RunResult("claude", task, False, timeout, 0, 0, 0, 0, 0, 0, 0,
                         error="Timed out")
    except Exception as e:
        return RunResult("claude", task, False, round(time.time()-t0, 1),
                         0, 0, 0, 0, 0, 0, 0, error=str(e))


# ── LLM judge ─────────────────────────────────────────────────────────────────

_JUDGE_PROMPT = """\
You are an impartial code review judge. Evaluate TWO AI coding tools on the same task.

TASK: {task}

TOOL A (CodeMaster) — git diff of changes made:
{diff_a}

TOOL B (Raw Claude Code) — git diff of changes made:
{diff_b}

Score each tool 0–10 on THREE criteria:
  correctness  — Does the diff correctly solve the task? (0 = not at all, 10 = perfectly)
  completeness — Is the implementation complete? (0 = nothing done, 10 = fully complete)
  quality      — Is the code clean, idiomatic, no obvious bugs? (0 = poor, 10 = excellent)

Rules:
- A tool that made NO changes (empty diff) scores 0 on all criteria.
- Grade each tool independently on absolute quality, not relative to each other.
- Output ONLY the JSON below — no other text.

{{"a":{{"correctness":N,"completeness":N,"quality":N}},"b":{{"correctness":N,"completeness":N,"quality":N}},"winner":"A|B|tie","reason":"one sentence"}}
"""

def judge_outputs(task: str, cm: RunResult, cl: RunResult,
                  claude_cmd: str) -> tuple[float, float, str, str]:
    """Return (cm_score, claude_score, winner, reason). Scores are 0–10."""
    diff_a = (cm.diff[:2500] + "\n...(truncated)") if len(cm.diff) > 2500 else cm.diff or "(no changes)"
    diff_b = (cl.diff[:2500] + "\n...(truncated)") if len(cl.diff) > 2500 else cl.diff or "(no changes)"

    prompt = _JUDGE_PROMPT.format(task=task, diff_a=diff_a, diff_b=diff_b)
    try:
        r = subprocess.run(
            [claude_cmd, "--dangerously-skip-permissions", "-p", prompt,
             "--output-format", "text", "--tools", ""],
            capture_output=True, text=True, timeout=90,
        )
        text = r.stdout.strip()
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return 0.0, 0.0, "tie", f"judge error: no JSON in response"
        j = json.loads(m.group())
        a, b = j.get("a", {}), j.get("b", {})
        score_a = round((a.get("correctness",0)+a.get("completeness",0)+a.get("quality",0))/3, 1)
        score_b = round((b.get("correctness",0)+b.get("completeness",0)+b.get("quality",0))/3, 1)
        raw_winner = j.get("winner", "tie")
        winner = "codemaster" if raw_winner == "A" else ("claude" if raw_winner == "B" else "tie")
        return score_a, score_b, winner, j.get("reason", "")
    except Exception as e:
        return 0.0, 0.0, "error", f"judge error: {e}"


# ── report ────────────────────────────────────────────────────────────────────

def _w(a: float, b: float, lower_is_better: bool = False) -> str:
    if a == b:
        return "─ tie"
    if lower_is_better:
        return "CM ◀" if a < b else "CL ◀"
    return "CM ◀" if a > b else "CL ◀"

def print_report(results: list[dict], totals: dict) -> None:
    W = 92
    print(f"\n{'═'*W}")
    print("  CODEMASTER  vs  CLAUDE CODE  —  BENCHMARK REPORT")
    print(f"{'═'*W}")

    for i, r in enumerate(results, 1):
        cm = r["codemaster"]
        cl = r["claude"]
        print(f"\n  ┌{'─'*(W-2)}┐")
        status_cm = "✓" if cm["success"] else "✗"
        status_cl = "✓" if cl["success"] else "✗"
        print(f"  │  TASK {i} [{r['task_type']}]  CM={status_cm}  CL={status_cl}  winner={r['winner'].upper()}")
        print(f"  │  {r['task'][:W-6]}")
        print(f"  ├{'─'*(W-2)}┤")
        print(f"  │  {'Metric':<28} {'CodeMaster':>14} {'Claude':>14} {'':>8}")
        print(f"  │  {'─'*28} {'─'*14} {'─'*14} {'─'*8}")

        def row(label: str, a, b, lower: bool = False):
            win = _w(float(str(a).rstrip("s/10").replace(",","")),
                     float(str(b).rstrip("s/10").replace(",","")), lower)
            print(f"  │  {label:<28} {str(a):>14} {str(b):>14} {win:>8}")

        row("Wall time",         f"{cm['wall_time']:.1f}s",    f"{cl['wall_time']:.1f}s",    lower=True)
        row("Total tokens (est)", f"{cm['total_tokens']:,}",    f"{cl['total_tokens']:,}",    lower=True)
        row("LLM calls",          cm["calls"],                   cl["calls"])
        row("Files changed",      cm["files_changed"],           cl["files_changed"])
        row("Lines added",        cm["lines_added"],             cl["lines_added"])
        if cm["quality_score"] or cl["quality_score"]:
            row("Quality score",  f"{cm['quality_score']:.1f}/10", f"{cl['quality_score']:.1f}/10")
        if r.get("judge_summary"):
            print(f"  │")
            print(f"  │  Judge: {r['judge_summary'][:W-12]}")
        if cm.get("error"):
            print(f"  │  CM error: {cm['error'][:80]}")
        if cl.get("error"):
            print(f"  │  CL error: {cl['error'][:80]}")
        print(f"  └{'─'*(W-2)}┘")

    print(f"\n{'═'*W}")
    print("  TOTALS")
    print(f"{'═'*W}")
    cm_tok = totals["cm_tokens"]
    cl_tok = totals["cl_tokens"]
    tok_saved_pct = round(100 * (1 - cm_tok / max(cl_tok, 1)))
    speed_ratio   = totals["cm_time"] / max(totals["cl_time"], 0.01)
    speed_msg     = f"CodeMaster was {abs(1-speed_ratio)*100:.0f}% {'faster' if speed_ratio < 1 else 'slower'}"

    print(f"  {'Total wall time':<32} CM={totals['cm_time']:.1f}s   CL={totals['cl_time']:.1f}s   {speed_msg}")
    print(f"  {'Total tokens (est)':<32} CM={cm_tok:,}   CL={cl_tok:,}   CM used ~{tok_saved_pct}% {'fewer' if tok_saved_pct > 0 else 'more'} tokens")
    print(f"  {'Avg quality score':<32} CM={totals['cm_avg_score']:.1f}/10   CL={totals['cl_avg_score']:.1f}/10")
    print(f"  {'Tasks won':<32} CM={totals['cm_wins']}   CL={totals['cl_wins']}   tie={totals['ties']}")
    print(f"{'═'*W}\n")


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="CodeMaster vs Claude benchmark")
    ap.add_argument("--quick",    action="store_true", help="Run first prompt only")
    ap.add_argument("--no-judge", dest="no_judge", action="store_true",
                    help="Skip LLM quality scoring (faster)")
    ap.add_argument("--prompts",  default=str(PROMPTS_FILE), help="Path to prompts JSON")
    ap.add_argument("--out",      default="",   help="Save JSON report to this path")
    ap.add_argument("--claude",   default="claude", help="Claude CLI command name")
    ap.add_argument("--timeout",  type=int, default=300, help="Per-tool timeout in seconds")
    args = ap.parse_args()

    codemaster_py = find_codemaster()
    print(f"CodeMaster : {codemaster_py}")
    print(f"Claude cmd : {args.claude}")
    print(f"Sample proj: {SAMPLE_DIR}")

    with open(args.prompts) as f:
        prompts: list[dict] = json.load(f)

    if args.quick:
        prompts = prompts[:1]
        print("Quick mode: running 1 prompt only\n")

    all_results: list[dict] = []
    totals = dict(cm_time=0.0, cl_time=0.0, cm_tokens=0, cl_tokens=0,
                  cm_wins=0, cl_wins=0, ties=0, cm_scores=[], cl_scores=[])

    for i, prompt_cfg in enumerate(prompts, 1):
        task      = prompt_cfg["task"]
        task_type = prompt_cfg.get("type", "")

        print(f"\n{'─'*70}")
        print(f"  TASK {i}/{len(prompts)}  [{task_type}]")
        print(f"  {task[:66]}")
        print(f"{'─'*70}")

        # ── CodeMaster ──────────────────────────────────────────────────────
        print("► CodeMaster …")
        proj_cm = setup_project()
        cm_result = run_codemaster(task, proj_cm, codemaster_py, timeout=args.timeout)
        print(f"  {cm_result.wall_time}s  |  ~{cm_result.total_tokens:,} tokens  |  "
              f"{cm_result.files_changed} file(s) changed  |  "
              f"{'OK' if cm_result.success else 'FAILED'}")
        if cm_result.error:
            print(f"  error: {cm_result.error[:120]}")
        shutil.rmtree(str(proj_cm))

        # ── Claude raw ──────────────────────────────────────────────────────
        print("► Claude Code …")
        proj_cl = setup_project()
        cl_result = run_claude(task, proj_cl, claude_cmd=args.claude, timeout=args.timeout)
        print(f"  {cl_result.wall_time}s  |  ~{cl_result.total_tokens:,} tokens  |  "
              f"{cl_result.files_changed} file(s) changed  |  "
              f"{'OK' if cl_result.success else 'FAILED'}")
        if cl_result.error:
            print(f"  error: {cl_result.error[:120]}")
        shutil.rmtree(str(proj_cl))

        # ── Judge ───────────────────────────────────────────────────────────
        winner, judge_summary = "tie", ""
        if not args.no_judge:
            print("► Judging …")
            cm_score, cl_score, winner, judge_summary = judge_outputs(
                task, cm_result, cl_result, args.claude
            )
            cm_result.quality_score = cm_score
            cl_result.quality_score = cl_score
            print(f"  CM={cm_score}/10  CL={cl_score}/10  winner={winner.upper()}")
            if judge_summary:
                print(f"  {judge_summary}")

        # accumulate
        totals["cm_time"]   += cm_result.wall_time
        totals["cl_time"]   += cl_result.wall_time
        totals["cm_tokens"] += cm_result.total_tokens
        totals["cl_tokens"] += cl_result.total_tokens
        if winner == "codemaster":
            totals["cm_wins"] += 1
        elif winner == "claude":
            totals["cl_wins"] += 1
        else:
            totals["ties"] += 1
        totals["cm_scores"].append(cm_result.quality_score)
        totals["cl_scores"].append(cl_result.quality_score)

        all_results.append({
            "task": task, "task_type": task_type,
            "winner": winner, "judge_summary": judge_summary,
            "codemaster": asdict(cm_result),
            "claude":     asdict(cl_result),
        })

    totals["cm_avg_score"] = sum(totals["cm_scores"]) / max(len(totals["cm_scores"]), 1)
    totals["cl_avg_score"] = sum(totals["cl_scores"]) / max(len(totals["cl_scores"]), 1)

    print_report(all_results, totals)

    out_path = args.out or str(BENCH_DIR / f"results_{int(time.time())}.json")
    with open(out_path, "w") as f:
        json.dump({"results": all_results, "totals": totals}, f, indent=2)
    print(f"Full results saved → {out_path}\n")


if __name__ == "__main__":
    main()
