import ast
from pathlib import Path
from typing import List, Dict, Set, Any

def expand_dependencies(files: List[Path]) -> List[Dict[str, Any]]:
    """
    Use Python AST parsing to detect dependencies required by the target code.
    Detects function calls, class references, and imports.
    Returns structured dependency objects instead of flat strings.
    """
    dependencies: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    
    for filepath in files:
        if filepath.suffix != ".py":
            continue
            
        try:
            content = filepath.read_text(encoding="utf-8")
            tree = ast.parse(content, filename=str(filepath))
        except (SyntaxError, OSError, UnicodeDecodeError):
            continue
            
        for node in ast.walk(tree):
            name = None
            dep_type = None
            
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.name
                    dep_type = "import"
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                for alias in node.names:
                    name = f"{module}.{alias.name}" if module else alias.name
                    dep_type = "import_from"
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name):
                    name = node.func.id
                    dep_type = "function_call"
                elif isinstance(node.func, ast.Attribute):
                    name = node.func.attr
                    dep_type = "method_call"
                    
            if name and name not in seen:
                seen.add(name)
                dependencies.append({
                    "name": name,
                    "type": dep_type,
                    "source_file": str(filepath)
                })
                
    return dependencies

def extract_functions_and_classes(filepath: Path) -> List[Dict[str, Any]]:
    """
    Extracts purely functions and classes to minimize context payload.
    """
    if filepath.suffix != ".py":
        return []
        
    try:
        content = filepath.read_text(encoding="utf-8")
        tree = ast.parse(content, filename=str(filepath))
    except (SyntaxError, OSError, UnicodeDecodeError):
        return []
        
    lines = content.splitlines()
    extracted = []
    
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = node.lineno - 1
            end = node.end_lineno or start + 1
            source = "\n".join(lines[start:end])
            
            extracted.append({
                "name": node.name,
                "type": "class" if isinstance(node, ast.ClassDef) else "function",
                "file": str(filepath),
                "start": node.lineno,
                "end": end,
                "source": source
            })
            
    return extracted
