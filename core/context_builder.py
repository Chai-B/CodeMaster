"""Extracts minimal code context — specific functions only, no full files."""

import ast
import re
from pathlib import Path

MAX_LINES_PER_FN  = 60
MAX_LINES_FALLBACK = 40


def extract_python_function(source, fn_name):
    try:
        tree = ast.parse(source)
        lines = source.splitlines()
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name == fn_name:
                    start = node.lineno - 1
                    end = node.end_lineno
                    return "\n".join(lines[start:end])
    except SyntaxError:
        pass
    return None


def extract_generic_function(source, fn_name):
    pattern = (
        rf"((?:^|\n)(?:def |function |func |fn |pub fn |async fn )"
        rf"[^\n]*{re.escape(fn_name)}[^\n]*\{{?[^\n]*\n"
        rf"(?:(?!\n\n)[\s\S])*?(?:\n\}}|\n(?=\S)))"
    )
    m = re.search(pattern, source)
    return m.group(0) if m else None


def extract_function(filepath, fn_name):
    path = Path(filepath)
    if not path.exists():
        return f"# {filepath} not found"
    source = path.read_text(errors="replace")
    snippet = None
    if path.suffix == ".py":
        snippet = extract_python_function(source, fn_name)
    if snippet is None:
        snippet = extract_generic_function(source, fn_name)
    if snippet is None:
        lines = source.splitlines()
        for i, line in enumerate(lines):
            if fn_name in line:
                start = max(0, i - 1)
                end = min(len(lines), i + MAX_LINES_FALLBACK)
                snippet = "\n".join(lines[start:end])
                break
    return snippet or f"# {fn_name} not found in {filepath}"


def build_context(task, search_results):
    parts = [f"Task: {task}\n"]
    for entry in search_results:
        filepath = entry["file"]
        functions = entry.get("functions", [])
        if functions:
            for fn in functions[:2]:
                snippet = extract_function(filepath, fn)
                parts.append(f"File: {filepath}\nFunction: {fn}\n```\n{snippet}\n```")
        else:
            path = Path(filepath)
            if path.exists():
                lines = path.read_text(errors="replace").splitlines()[:MAX_LINES_FALLBACK]
                parts.append(f"File: {filepath}\n```\n" + "\n".join(lines) + "\n```")
    return "\n\n".join(parts)