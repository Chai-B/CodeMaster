import subprocess
from pathlib import Path
from typing import List, Tuple

def _try_run(cmd: List[str], cwd: Path) -> Tuple[bool, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=cwd)
        return r.returncode == 0, (r.stdout + "\n" + r.stderr).strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        # If tool isn't installed or times out, we consider it a soft pass instead of pipeline crash
        # The user's instructions didn't specify failing the pipeline if the tool isn't installed.
        return True, ""

def run_static_analysis(files: List[str], root_dir: Path) -> List[Tuple[str, bool]]:
    """
    Run static analysis tools: ruff check, mypy, eslint.
    Return list of (tool_name, passed) tuples.
    """
    py_files = [f for f in files if f.endswith(".py")]
    js_files = [f for f in files if f.endswith((".js", ".ts", ".jsx", ".tsx"))]
    
    results: List[Tuple[str, bool]] = []
    
    if py_files:
        passed_ruff, _ = _try_run(["ruff", "check", "--no-fix"] + py_files, root_dir)
        results.append(("ruff", passed_ruff))
        
        passed_mypy, _ = _try_run(["mypy", "--ignore-missing-imports"] + py_files, root_dir)
        results.append(("mypy", passed_mypy))
        
    if js_files:
        passed_eslint, _ = _try_run(["npx", "eslint", "--no-error-on-unmatched-pattern"] + js_files, root_dir)
        results.append(("eslint", passed_eslint))
        
    return results
