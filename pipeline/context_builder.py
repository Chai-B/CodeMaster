from pathlib import Path
from typing import List, Dict, Any, Optional

from pipeline.dependency_expander import extract_functions_and_classes

# Task types where repo tree and heavy context are unnecessary
_LIGHT_CONTEXT_TASKS = {"DOCS", "GENERATE"}


def build_minimal_context(
    files: List[str],
    task_description: str,
    root_dir: Path,
    max_fns: int,
    dependencies: List[Dict[str, Any]],
    repo_map: Optional[Dict] = None,
    task_type: Optional[str] = None,
) -> str:
    """
    Build minimal context containing only what the LLM needs.
    Token-conscious: caps file reads, skips repo tree for docs tasks,
    limits dependency listing.
    """
    sections: List[str] = []
    is_light = task_type and task_type.upper() in _LIGHT_CONTEXT_TASKS

    # Repo tree — skip for docs/generate tasks, keep compact otherwise
    if repo_map and "tree" in repo_map and not is_light:
        tree_lines = repo_map["tree"].splitlines()
        tree_preview = "\n".join(tree_lines[:30])
        if len(tree_lines) > 30:
            tree_preview += f"\n... ({len(tree_lines) - 30} more)"
        sections.append(f"--- Project Structure ---\n{tree_preview}")

    all_extracted_symbols: List[Dict[str, Any]] = []
    max_file_lines = 50 if is_light else 80

    for rel_path in files:
        filepath = root_dir / rel_path
        if not filepath.exists():
            continue

        if filepath.suffix == ".py":
            symbols = extract_functions_and_classes(filepath)
            all_extracted_symbols.extend(symbols)
        else:
            try:
                content = filepath.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            lines = content.splitlines()
            if len(lines) <= max_file_lines:
                sections.append(f"--- {rel_path} ---\n{content}")
            else:
                sections.append(
                    f"--- {rel_path} (first {max_file_lines}/{len(lines)} lines) ---\n"
                    + "\n".join(lines[:max_file_lines])
                )

    # Rank symbols by relevance to the task
    task_lower = task_description.lower()
    task_words = set(task_lower.split())

    def _score(sym: Dict[str, Any]) -> int:
        name_lower = sym["name"].lower()
        s = 10 if name_lower in task_lower else 0
        s += sum(3 for w in task_words if len(w) > 2 and w in name_lower)
        return s

    scored = sorted(all_extracted_symbols, key=_score, reverse=True)
    selected = scored[:max_fns] if scored else all_extracted_symbols[:max_fns]

    for sym in selected:
        try:
            rel = str(Path(sym["file"]).relative_to(root_dir))
        except Exception:
            rel = sym["file"]
        header = f"--- {rel}:{sym['start']}-{sym['end']} ({sym['type']} {sym['name']}) ---"
        sections.append(f"{header}\n{sym['source']}")

    # Compact dependency listing — 10 max
    if dependencies and not is_light:
        dep_lines = [
            f"  {d['type']}: {d['name']} ({Path(d['source_file']).name})"
            for d in dependencies[:10]
        ]
        sections.append("--- Dependencies ---\n" + "\n".join(dep_lines))

    return "\n\n".join(sections)
