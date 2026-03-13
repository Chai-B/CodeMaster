# patch_minimizer.py
import re


def minimize(diff: str) -> str:
    file_blocks = re.split(r"(?=^--- )", diff, flags=re.MULTILINE)
    out_blocks  = []

    for block in file_blocks:
        if not block.strip():
            continue

        header_match = re.match(r"^(---.*\n\+\+\+.*\n)", block)
        if not header_match:
            out_blocks.append(block)
            continue

        header = header_match.group(1)
        rest   = block[len(header):]

        kept_hunks = []
        for hunk in re.finditer(
            r"(@@ [^\n]+@@[^\n]*\n)([\s\S]*?)(?=^@@|\Z)",
            rest, re.MULTILINE,
        ):
            hunk_header = hunk.group(1)
            hunk_body   = hunk.group(2)
            if not _is_whitespace_only(hunk_body):
                kept_hunks.append(hunk_header + hunk_body)

        if kept_hunks:
            out_blocks.append(header + "".join(kept_hunks))

    return "".join(out_blocks)


def _is_whitespace_only(hunk_body: str) -> bool:
    changed = [l for l in hunk_body.splitlines() if l.startswith("+") or l.startswith("-")]
    if not changed:
        return True
    for line in changed:
        if line[1:].strip():
            return False
    return True
