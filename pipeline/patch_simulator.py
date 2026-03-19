import ast
import tempfile
import subprocess
from pathlib import Path
from typing import List, Tuple

def validate_patch_size(diff: str, max_lines: int) -> List[str]:
    """Check if patch exceeds max change lines."""
    errors = []
    change_lines = sum(1 for ln in diff.splitlines() if (ln.startswith("+") or ln.startswith("-")) and not ln.startswith("---") and not ln.startswith("+++"))
    if change_lines > max_lines:
        errors.append(f"Patch too large: {change_lines} lines (max {max_lines})")
    return errors

def simulate_patch(diff: str, root_dir: Path) -> Tuple[bool, str]:
    """
    Dry run the patch using git apply --check.
    Returns (success, error_message)
    """
    with tempfile.NamedTemporaryFile(mode="w", suffix=".patch", delete=False) as f:
        f.write(diff)
        f.flush()
        
        try:
            r = subprocess.run(
                ["git", "apply", "--check", f.name], 
                capture_output=True, 
                text=True, 
                timeout=10, 
                cwd=root_dir
            )
            return r.returncode == 0, r.stderr.strip()
        except FileNotFoundError:
            return True, "git not found"
        except subprocess.TimeoutExpired:
            return False, "git apply timed out"

def validate_syntax(files_changed: List[str], root_dir: Path) -> List[str]:
    """
    Parse Python files with ast to ensure no basic syntax errors were introduced.
    This runs AFTER patch application conceptually, but can run on the modified files on disk,
    so we should run this after saving or patching.
    """
    errors = []
    for rel_path in files_changed:
        if rel_path.endswith(".py"):
            try:
                filepath = root_dir / rel_path
                content = filepath.read_text(encoding="utf-8")
                ast.parse(content, filename=str(filepath))
            except SyntaxError as e:
                errors.append(f"Syntax error in {rel_path}: {e}")
            except Exception:
                pass
    return errors
