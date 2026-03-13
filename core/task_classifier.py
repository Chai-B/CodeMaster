# task_classifier.py
from typing import Optional

TaskType = str

BUG_FIX  = "BUG_FIX"
REFACTOR = "REFACTOR"
FEATURE  = "FEATURE"
TEST     = "TEST"
DOCS     = "DOCS"
UNKNOWN  = "UNKNOWN"

COMMAND_MAP = {
    "fix":      BUG_FIX,
    "refactor": REFACTOR,
    "generate": FEATURE,
    "test":     TEST,
    "docs":     DOCS,
}

_KEYWORDS: dict[str, list[str]] = {
    BUG_FIX:  ["fix", "bug", "error", "crash", "exception", "broken", "fail", "zero", "null", "none", "undefined", "wrong", "incorrect", "issue"],
    REFACTOR: ["refactor", "clean", "split", "extract", "rename", "reorganize", "simplify", "dedup", "restructure", "move"],
    FEATURE:  ["add", "implement", "create", "generate", "new", "support", "introduce", "build", "write", "enable"],
    TEST:     ["test", "spec", "unit", "coverage", "assert", "mock", "pytest", "unittest"],
    DOCS:     ["doc", "docstring", "readme", "comment", "document", "explain", "describe"],
}

def classify(task: str, command: Optional[str] = None) -> TaskType:
    if command and command in COMMAND_MAP:
        return COMMAND_MAP[command]
    t = task.lower()
    for task_type, keywords in _KEYWORDS.items():
        if any(kw in t for kw in keywords):
            return task_type
    return UNKNOWN
