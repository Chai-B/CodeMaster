# patch_simulator.py
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def simulate(diff: str, root: Path) -> dict:
    errors = []

    file_blocks = re.split(r"(?=^--- )", diff, flags=re.MULTILINE)

    for block in file_blocks:
        block = block.strip()
        if not block:
            continue

        header = re.match(r"^---\s+\S+\n\+\+\+\s+(\S+)", block)
        if not header:
            continue

        dst = re.sub(r"^[ab]/", "", header.group(1)).lstrip("./")
        if not dst.endswith(".py"):
            continue

        target = root / dst
        if target.exists():
            original = target.read_text(errors="replace").splitlines()
        else:
            original = []

        new_lines = _apply_hunks(original, block)
        patched   = "\n".join(new_lines)

        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
            f.write(patched)
            tmp = f.name

        try:
            r = subprocess.run(
                [sys.executable, "-m", "py_compile", tmp],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode != 0:
                errors.append(f"{dst}: syntax error — {r.stderr.strip()[:200]}")
        except Exception as e:
            errors.append(f"{dst}: compile check failed — {e}")
        finally:
            Path(tmp).unlink(missing_ok=True)

    return {"valid": len(errors) == 0, "errors": errors}


def _apply_hunks(original: list[str], block: str) -> list[str]:
    result = list(original)
    offset = 0
    for hunk in re.finditer(
        r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*\n([\s\S]*?)(?=^@@|\Z)",
        block, re.MULTILINE,
    ):
        src_start  = int(hunk.group(1)) - 1
        hunk_lines = hunk.group(3).splitlines()
        new_hunk   = []
        pos        = src_start + offset
        for line in hunk_lines:
            if line.startswith("+"):
                new_hunk.append(line[1:])
            elif line.startswith("-"):
                pos += 1
            elif line.startswith("\\"):
                continue
            else:
                new_hunk.append(line[1:] if line.startswith(" ") else line)
                pos += 1
        del_count = sum(1 for l in hunk_lines if l.startswith("-") or (not l.startswith("+") and not l.startswith("\\")))
        result[src_start + offset: src_start + offset + del_count] = new_hunk
        offset += len(new_hunk) - del_count
    return result
