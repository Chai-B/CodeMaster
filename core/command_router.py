# command_router.py
import re
from typing import Optional

COMMANDS = {"fix", "refactor", "generate", "test", "docs", "explain", "git", "files", "context", "model"}

def parse(raw: str) -> tuple[Optional[str], str]:
    raw = raw.strip()
    m = re.match(r"^/(\w+)\s*(.*)", raw, re.DOTALL)
    if m:
        cmd = m.group(1).lower()
        task = m.group(2).strip() or raw
        if cmd in COMMANDS:
            return cmd, task
        return None, raw
    return None, raw
