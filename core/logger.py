# logger.py
import json
import time
from pathlib import Path

_LOGS = Path(__file__).parent.parent / "logs"


def _ensure():
    _LOGS.mkdir(exist_ok=True)


def event(name: str, data: dict) -> None:
    _ensure()
    record = {"ts": time.time(), "event": name, **data}
    with open(_LOGS / "codemaster.log", "a") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {name}: {json.dumps(data)}\n")
    with open(_LOGS / "calls.jsonl", "a") as f:
        f.write(json.dumps(record) + "\n")


def patch(diff: str) -> None:
    _ensure()
    (_LOGS / "last_patch.diff").write_text(diff)


def error(stage: str, msg: str) -> None:
    event("error", {"stage": stage, "msg": msg})
