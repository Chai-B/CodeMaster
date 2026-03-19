from typing import List


def strip_markdown(diff: str) -> str:
    """Strip markdown codeblock wrappers (``` or ~~~) and preamble text."""
    lines = diff.splitlines()
    out: List[str] = []
    active = False
    for ln in lines:
        if ln.startswith("---") or ln.startswith("+++") or ln.startswith("@@"):
            active = True
        # Skip fence lines (``` or ~~~)
        if ln.startswith("```") or ln.startswith("~~~"):
            if active:
                break
            continue
        if active:
            out.append(ln)
    return "\n".join(out) if out else diff


def optimize_patch(diff: str) -> str:
    """
    Remove whitespace-only hunks and formatting-only edits.
    Returns minimal patch.
    """
    diff = strip_markdown(diff)
    lines = diff.splitlines()
    result: List[str] = []
    current_hunk: List[str] = []
    has_real_changes = False

    def _flush():
        nonlocal current_hunk, has_real_changes
        if current_hunk and has_real_changes:
            result.extend(current_hunk)
        current_hunk = []
        has_real_changes = False

    for ln in lines:
        if ln.startswith("---") or ln.startswith("+++"):
            _flush()
            result.append(ln)
        elif ln.startswith("@@"):
            _flush()
            current_hunk.append(ln)
        elif ln.startswith("+") or ln.startswith("-"):
            current_hunk.append(ln)
            if ln[1:].strip():
                has_real_changes = True
        else:
            current_hunk.append(ln)

    _flush()
    return "\n".join(result)
