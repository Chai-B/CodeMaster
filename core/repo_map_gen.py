"""
Generates repo_map.json — index of files and functions.
Run once per project, re-run after adding new files.
Usage: python codemaster/repo_map_gen.py
"""

import ast
import json
import re
import sys
from pathlib import Path

EXTENSIONS = {".py", ".js", ".ts", ".go", ".rb", ".rs", ".java", ".cpp", ".c", ".tsx", ".jsx", ".html", ".css"}
SKIP_DIRS  = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
              ".next", "codemaster", "Codemaster", ".mypy_cache", ".pytest_cache"}


def extract_python_functions(source):
    try:
        tree = ast.parse(source)
        return [n.name for n in ast.walk(tree)
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    except SyntaxError:
        return []


def extract_generic_functions(source, ext):
    patterns = {
        ".js":  r"(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()",
        ".ts":  r"(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()",
        ".jsx": r"(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()",
        ".tsx": r"(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()",
        ".go":  r"func\s+(?:\(\w+\s+\*?\w+\)\s*)?(\w+)\s*\(",
        ".rs":  r"(?:pub\s+)?fn\s+(\w+)\s*[<(]",
        ".rb":  r"def\s+(\w+)",
        ".java":r"(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+(\w+)\s*\(",
        ".cpp": r"(?:[\w:]+\s+)+(\w+)\s*\([^)]*\)\s*\{",
        ".c":   r"(?:[\w]+\s+)+(\w+)\s*\([^)]*\)\s*\{",
    }
    pattern = patterns.get(ext)
    if not pattern:
        return []
    matches = re.findall(pattern, source)
    result = []
    for m in matches:
        val = m if isinstance(m, str) else next((x for x in m if x), None)
        if val:
            result.append(val)
    return result


def index_file(path):
    try:
        source = path.read_text(errors="replace")
        if path.suffix == ".py":
            return extract_python_functions(source)
        return extract_generic_functions(source, path.suffix)
    except Exception:
        return []


def generate(root):
    repo = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in EXTENSIONS:
            continue
        # Skip any path that contains a skip dir
        parts_lower = {p.lower() for p in path.parts}
        if parts_lower & {s.lower() for s in SKIP_DIRS}:
            continue
        try:
            rel = str(path.relative_to(root))
            repo[rel] = {"functions": index_file(path)}
        except Exception:
            pass
    return repo


if __name__ == "__main__":
    # Always use the parent of the codemaster folder as root
    root = Path(__file__).parent.parent
    print(f"Indexing {root.resolve()} ...")
    data = generate(root)
    out = root / "repo_map.json"
    out.write_text(json.dumps(data, indent=2))
    total_fns = sum(len(v["functions"]) for v in data.values())
    print(f"Indexed {len(data)} files, {total_fns} functions -> {out}")