#!/usr/bin/env python3
"""Scan any project directory and emit repo_map.json.

Output protocol (TUI-compatible):
  ⏺ SCAN
  ⎿  ✓ N files, M symbols
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path
from datetime import datetime, timezone

SKIP_DIRS = {
    "node_modules", "__pycache__", ".git", ".venv", "venv", "dist",
    "build", ".next", "coverage", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", "target", "vendor",
}

SKIP_EXTS = {
    ".pyc", ".pyo", ".lock", ".map", ".min.js", ".min.css",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff",
    ".woff2", ".ttf", ".eot", ".otf", ".pdf", ".zip", ".tar",
    ".gz", ".bz2", ".rar", ".7z", ".exe", ".bin", ".so", ".dylib",
    ".dll", ".class", ".jar",
}

SCAN_EXTS = {".py", ".ts", ".tsx", ".js", ".jsx"}

# JS/TS symbol patterns
_JS_PATTERNS = [
    re.compile(r"^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)"),
    re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)"),
    re.compile(r"^(?:export\s+)?class\s+(\w+)"),
    re.compile(r"^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\("),
    re.compile(r"^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function"),
    re.compile(r"^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*React\."),
]


def _scan_python(path: Path) -> list[dict]:
    symbols: list[dict] = []
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(source, filename=str(path))
    except SyntaxError:
        return symbols

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append({"name": node.name, "type": "function", "line": node.lineno})
        elif isinstance(node, ast.ClassDef):
            symbols.append({"name": node.name, "type": "class", "line": node.lineno})
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    symbols.append({"name": f"{node.name}.{item.name}", "type": "method", "line": item.lineno})
    return symbols


def _scan_js(path: Path) -> list[dict]:
    symbols: list[dict] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return symbols

    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        for pat in _JS_PATTERNS:
            m = pat.match(stripped)
            if m:
                symbols.append({"name": m.group(1), "type": "function", "line": i})
                break
    return symbols


def build_tree(files: list[Path], root: Path) -> dict:
    tree: dict = {}
    for f in files:
        parts = f.relative_to(root).parts
        node = tree
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = None
    return tree


def scan_directory(root: Path) -> dict:
    root = root.resolve()
    file_data: dict[str, dict] = {}
    all_files: list[Path] = []

    for path in sorted(root.rglob("*")):
        if path.is_dir():
            continue
        # skip hidden dirs and known noise
        parts = path.relative_to(root).parts
        if any(p.startswith(".") or p in SKIP_DIRS for p in parts[:-1]):
            continue
        if path.suffix in SKIP_EXTS:
            continue
        if path.suffix not in SCAN_EXTS:
            continue

        all_files.append(path)
        try:
            line_count = len(path.read_bytes().splitlines())
        except OSError:
            line_count = 0

        if path.suffix == ".py":
            symbols = _scan_python(path)
        elif path.suffix in {".ts", ".tsx", ".js", ".jsx"}:
            symbols = _scan_js(path)
        else:
            symbols = []

        rel = str(path.relative_to(root))
        file_data[rel] = {"lines": line_count, "symbols": symbols}

    tree = build_tree(all_files, root)
    total_symbols = sum(len(v["symbols"]) for v in file_data.values())

    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "file_count": len(file_data),
        "symbol_count": total_symbols,
        "files": file_data,
        "tree": tree,
    }


def main():
    root = Path.cwd()
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--root" and i + 1 < len(args):
            root = Path(args[i + 1])
            i += 2
        else:
            i += 1

    print("\n⏺  SCAN", flush=True)
    repo_map = scan_directory(root)
    out_path = root / "repo_map.json"
    out_path.write_text(json.dumps(repo_map, indent=2))
    print(f"  ⎿  ✓ {repo_map['file_count']} files, {repo_map['symbol_count']} symbols", flush=True)


if __name__ == "__main__":
    main()
