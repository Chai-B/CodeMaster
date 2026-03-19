from typing import List, Tuple, Optional

CORE_MODULES = {
    "main.py", "app.py", "settings.py", "config.py", "setup.py",
    "manage.py", "index.js", "index.ts", "app.js", "server.js", "__init__.py"
}

SECURITY_PATTERNS = {"eval(", "exec(", "os.system(", "subprocess.call(", "__import__(", "pickle.loads("}

# Task types that are inherently low-risk (content-only, no logic changes)
LOW_RISK_TASKS = {"DOCS", "GENERATE"}


def compute_risk_score(
    diff: str,
    files: List[str],
    task_type: Optional[str] = None,
) -> Tuple[int, List[str]]:
    """
    Compute patch risk score with calibrated thresholds.

    Scoring (max practical ~10):
      - multi-file            → +1
      - core module modified  → +2
      - large patch (>100 ln) → +1
      - security-sensitive    → +3
      - import changes in
        existing code files   → +1
    DOCS/GENERATE tasks are capped at 2 (never trigger reviewer).
    """
    score = 0
    reasons: List[str] = []

    # --- multi-file ---
    if len(files) > 1:
        score += 1
        reasons.append(f"multiple ({len(files)}) files modified")

    # --- core module ---
    for f in files:
        filename = f.rsplit("/", 1)[-1]
        if filename in CORE_MODULES:
            score += 2
            reasons.append(f"core module modified: {filename}")
            break

    # --- patch size (lines with real changes) ---
    change_lines = sum(
        1 for ln in diff.splitlines()
        if (ln.startswith("+") or ln.startswith("-"))
        and not ln.startswith("---")
        and not ln.startswith("+++")
    )
    if change_lines > 100:
        score += 1
        reasons.append(f"large patch ({change_lines} lines)")

    # --- security-sensitive patterns ---
    for ln in diff.splitlines():
        if ln.startswith("+") and not ln.startswith("+++"):
            if any(pat in ln for pat in SECURITY_PATTERNS):
                score += 3
                reasons.append("security-sensitive pattern introduced")
                break

    # --- import changes (only meaningful in existing code, not new files) ---
    has_removals = any(ln.startswith("-") and not ln.startswith("---") for ln in diff.splitlines())
    if has_removals:
        for ln in diff.splitlines():
            if ln.startswith("+") and not ln.startswith("+++"):
                stripped = ln[1:].strip()
                if stripped.startswith("import ") or stripped.startswith("from ") or "require(" in stripped:
                    score += 1
                    reasons.append("dependency changes in existing code")
                    break

    # --- task-type cap ---
    if task_type and task_type.upper() in LOW_RISK_TASKS:
        score = min(score, 2)
        if score < 2:
            reasons.append("low-risk task type (capped)")

    return score, reasons
