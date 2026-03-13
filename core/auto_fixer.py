# auto_fixer.py
import subprocess
from pathlib import Path


def run(root: Path, files=None) -> dict:
    applied = []
    skipped = []
    targets = files if files else ["."]

    def _run(cmd: list[str], label: str) -> None:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=root)
            applied.append({"tool": label, "returncode": r.returncode, "output": (r.stdout + r.stderr).strip()[:300]})
        except FileNotFoundError:
            skipped.append(label)
        except subprocess.TimeoutExpired:
            skipped.append(f"{label} (timeout)")

    _run(["ruff", "check", "--fix", "--quiet"] + targets, "ruff")
    _run(["isort", "--quiet"] + targets,                  "isort")

    if files:
        has_js = any(f.endswith(('.js', '.ts', '.jsx', '.tsx')) for f in files)
    else:
        has_js = bool(list(root.rglob("*.js")) + list(root.rglob("*.ts")))
    if has_js:
        _run(["eslint", "--fix", "--quiet"] + targets, "eslint")
        _run(["prettier", "--write"] + targets,        "prettier")

    return {"applied": applied, "skipped": skipped}
