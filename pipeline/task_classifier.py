from typing import Literal

TaskType = Literal["BUG_FIX", "REFACTOR", "FEATURE", "TEST", "DOCS", "UNKNOWN"]

def classify_task(task_description: str) -> TaskType:
    """
    Rule-based classifier when no command is provided.
    Uses simple keyword heuristics.
    """
    task_description = task_description.lower()
    
    # Bug fix keywords
    if any(kw in task_description for kw in ["fix", "bug", "error", "crash", "issue", "solve", "resolve", "broken", "exception", "traceback"]):
        return "BUG_FIX"
        
    # Refactor keywords
    if any(kw in task_description for kw in ["refactor", "clean", "rewrite", "rename", "restructure", "optimize", "improve", "split", "extract"]):
        return "REFACTOR"
        
    # Test keywords
    if any(kw in task_description for kw in ["test", "spec", "coverage", "mock", "assert", "pytest", "jest"]):
        return "TEST"
        
    # Docs keywords
    if any(kw in task_description for kw in ["doc", "readme", "comment", "explain", "typehint", "docstring"]):
        return "DOCS"
        
    # Feature/Generate keywords
    if any(kw in task_description for kw in ["add", "create", "generate", "implement", "build", "new", "feature", "support"]):
        return "FEATURE"
        
    return "UNKNOWN"
