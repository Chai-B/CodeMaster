"""Non-LLM searcher: finds relevant files/functions using repo_map + grep."""

import re
import json
import subprocess
from pathlib import Path

REPO_MAP = Path("repo_map.json")
MAX_RESULTS = 3
SKIP_DIRS = {
    "codemaster", ".venv", "venv", "node_modules",
    "__pycache__", "dist", "build", ".next",
    ".git", ".mypy_cache", ".pytest_cache"
}


def load_map():
    if REPO_MAP.exists():
        return json.loads(REPO_MAP.read_text())
    return {}


def tokenize(text):
    stopwords = {
        "a","an","the","to","for","in","of","and","or","add","fix",
        "update","change","make","get","set","with","that","this",
        "is","it","on","at","be","build","create","simple","page","html"
    }
    words = re.findall(r"[a-zA-Z_][a-zA-Z0-9_]*", text.lower())
    return [w for w in words if len(w) > 2 and w not in stopwords]


def should_skip(filepath):
    parts = {p.lower() for p in Path(filepath).parts}
    return bool(parts & {s.lower() for s in SKIP_DIRS})


def grep_search(keywords):
    extensions = ["py", "js", "ts", "go", "java", "rb", "rs", "cpp", "c", "html", "css"]
    hits = {}
    include_args = []
    for ext in extensions:
        include_args += ["--include", f"*.{ext}"]

    exclude_args = []
    for d in SKIP_DIRS:
        exclude_args += [f"--exclude-dir={d}"]

    for kw in keywords[:4]:
        try:
            r = subprocess.run(
                ["grep", "-rl"] + exclude_args + [kw, "."] + include_args,
                capture_output=True, text=True, timeout=10
            )
            for line in r.stdout.strip().split("\n"):
                fp = line.strip()
                if fp and not should_skip(fp):
                    hits.setdefault(fp, set()).add(kw)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
    return hits


def find_relevant_code(task):
    keywords = tokenize(task)
    if not keywords:
        return []

    repo = load_map()
    results = {}

    for filepath, meta in repo.items():
        if should_skip(filepath):
            continue
        functions = meta.get("functions", [])
        score = 0
        fp_lower = filepath.lower()
        for kw in keywords:
            if kw in fp_lower:
                score += 3
            for fn in functions:
                if kw in fn.lower():
                    score += 2
        if score > 0:
            results[filepath] = {"file": filepath, "functions": functions, "score": score}

    for filepath, matched_kws in grep_search(keywords).items():
        if filepath not in results:
            functions = repo.get(filepath, {}).get("functions", [])
            results[filepath] = {"file": filepath, "functions": functions, "score": 0}
        results[filepath]["score"] += len(matched_kws)

    final = []
    for entry in sorted(results.values(), key=lambda x: x["score"], reverse=True)[:MAX_RESULTS]:
        relevant_fns = [f for f in entry["functions"] if any(kw in f.lower() for kw in keywords)]
        entry["functions"] = relevant_fns[:2] or entry["functions"][:2]
        final.append(entry)

    return final