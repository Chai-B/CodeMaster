import re
from pathlib import Path
from typing import List, Dict, Optional

STOP_WORDS = {"the", "a", "an", "in", "on", "at", "to", "for", "of", "is", "it", "and", "or", "not", "with", "this", "that", "there"}

def search_files(task_description: str, max_files: int, repo_map: Optional[Dict]) -> List[str]:
    """
    Search functionality using `repo_map.json`.
    Ranking signals:
      - keyword match
      - filename similarity
      - function name similarity
    """
    if not repo_map or "files" not in repo_map:
        return []
    
    file_map = repo_map["files"]
    if not isinstance(file_map, dict):
        return []
        
    # Extract keywords
    kws = [w.lower() for w in re.findall(r"[a-zA-Z_]\w*", task_description) if w.lower() not in STOP_WORDS and len(w) > 1]
    
    if not kws:
        return []

    scored_files = []
    
    for filepath, info in file_map.items():
        score = 0.0
        path_lower = filepath.lower()
        stem_lower = Path(filepath).stem.lower()
        name_lower = Path(filepath).name.lower()
        
        for kw in kws:
            # Filename similarity
            if kw == stem_lower:
                score += 10
            elif kw in name_lower:
                score += 5
            elif kw in path_lower:
                score += 2
                
            if "symbols" in info:
                for sym in info["symbols"]:
                    if isinstance(sym, dict):
                        sym_name = sym.get("name", "").lower()
                        if kw == sym_name:
                            score += 8
                        elif kw in sym_name:
                            score += 3
                        
            # Text chunk search could also be done if available in repo_map, but repo map only has symbols and line counts.
            
        if score > 0:
            scored_files.append((score, filepath))
            
    # Sort by descending score
    scored_files.sort(key=lambda x: x[0], reverse=True)
    
    # Return top max_files
    return [fp for _, fp in scored_files[:max_files]]
