# dependency_expander.py
import ast
from pathlib import Path
from typing import Union


def expand(source: Union[str, Path]) -> dict:
    if isinstance(source, Path):
        try:
            code = source.read_text(errors="replace")
        except OSError:
            return _empty()
    else:
        code = source

    try:
        tree = ast.parse(code)
    except SyntaxError:
        return _empty()

    imports      = []
    func_calls   = []
    class_refs   = []
    constants    = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            for alias in node.names:
                imports.append(f"{mod}.{alias.name}" if mod else alias.name)

        elif isinstance(node, ast.Call):
            name = _call_name(node)
            if name:
                func_calls.append(name)

        elif isinstance(node, ast.ClassDef):
            for base in node.bases:
                ref = _name_str(base)
                if ref:
                    class_refs.append(ref)

        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.isupper():
                    constants.append(target.id)

    return {
        "imports":        sorted(set(imports)),
        "function_calls": sorted(set(func_calls)),
        "class_refs":     sorted(set(class_refs)),
        "constants":      sorted(set(constants)),
    }


def _empty() -> dict:
    return {"imports": [], "function_calls": [], "class_refs": [], "constants": []}


def _call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return f"{_name_str(node.func.value)}.{node.func.attr}"
    return ""


def _name_str(node) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_name_str(node.value)}.{node.attr}"
    return ""
