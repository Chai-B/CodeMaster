# risk_scorer.py
import re

CORE_PATTERNS = {
    "auth", "database", "db", "models", "main", "core",
    "middleware", "security", "payment", "schema",
}


def score(diff: str) -> dict:
    reasons = []
    total   = 0

    files = re.findall(r"^\+\+\+ (.+)$", diff, re.MULTILINE)
    files = [f for f in files if f.strip() != "/dev/null"]
    if len(files) > 1:
        reasons.append(f"{len(files)} files modified")
        total += 2

    for f in files:
        stem = re.sub(r"^[ab]/", "", f).lower()
        if any(pat in stem for pat in CORE_PATTERNS):
            reasons.append(f"core module modified: {f.strip()}")
            total += 2
            break

    added   = len(re.findall(r"^\+(?!\+\+)", diff, re.MULTILINE))
    removed = len(re.findall(r"^-(?!--)",    diff, re.MULTILINE))
    if added + removed > 50:
        reasons.append(f"large patch: {added + removed} lines changed")
        total += 2

    import_changes = re.findall(r"^[+-](?![-+])\s*(import |from .+ import)", diff, re.MULTILINE)
    if import_changes:
        reasons.append(f"{len(import_changes)} import line(s) changed")
        total += 3

    level = "low" if total <= 2 else ("medium" if total <= 4 else "high")
    return {"score": total, "level": level, "reasons": reasons}
