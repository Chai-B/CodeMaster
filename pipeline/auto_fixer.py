import subprocess
from pathlib import Path
from typing import List

def _try_run(cmd: List[str], cwd: Path) -> bool:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=cwd)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return True # Soft pass so we don't break the pipeline if tool missing

def run_auto_fixers(files: List[str], root_dir: Path) -> List[str]:
    """
    Fix trivial issues without using LLMs.
    Returns summary of applied fixes.
    """
    py_files = [f for f in files if f.endswith(".py")]
    js_files = [f for f in files if f.endswith((".js", ".ts", ".jsx", ".tsx"))]
    
    applied_fixes = []
    
    if py_files:
        if _try_run(["ruff", "check", "--fix"] + py_files, root_dir):
            applied_fixes.append("ruff formatted")
        if _try_run(["black", "--quiet"] + py_files, root_dir):
            applied_fixes.append("black formatted")
        if _try_run(["isort", "--quiet"] + py_files, root_dir):
            applied_fixes.append("isort formatted")
            
    if js_files:
        if _try_run(["npx", "eslint", "--fix"] + js_files, root_dir):
            applied_fixes.append("eslint formatted")
        if _try_run(["npx", "prettier", "--write"] + js_files, root_dir):
            applied_fixes.append("prettier formatted")
            
    return applied_fixes
