import re
from typing import Tuple, Optional

SUPPORTED_COMMANDS = {
    "/fix": "fix",
    "/refactor": "refactor",
    "/generate": "generate",
    "/test": "test",
    "/docs": "docs",
}

def route_command(raw_input: str) -> Tuple[Optional[str], str]:
    """
    Parse slash commands and extract task instructions.
    Returns:
        (command, task) where command is the slash command without slash,
        or None if no slash command was at the beginning.
    """
    raw_input = raw_input.strip()
    parts = raw_input.split(None, 1)
    
    if not parts:
        return None, ""
        
    token = parts[0].lower()
    rest = parts[1] if len(parts) > 1 else ""
    
    if token in SUPPORTED_COMMANDS:
        return SUPPORTED_COMMANDS[token], rest.strip()
    
    return None, raw_input
