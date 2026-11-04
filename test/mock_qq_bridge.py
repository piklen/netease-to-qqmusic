#!/usr/bin/env python3
"""测试用 QQ 桥接器：实现与 src/py/qq_bridge.py 相同的 JSON Lines 协议。"""

import json
import os
import sys
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    options = json.loads(sys.argv[1])
    data_dir = Path(options["dataDir"])
    calls = data_dir / "mock-calls.jsonl"
    emit({"ok": True, "ready": True, "protocol": 2})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        command = json.loads(line)
        with calls.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(command, ensure_ascii=False) + "\n")
        name = command.get("command")
        if name == "create_playlist":
            emit({"ok": True, "dirid": 777, "name": command["name"]})
        elif name == "add_song":
            if command["songId"] == 999:
                emit({"ok": False, "error": "simulated failure"})
            else:
                emit({"ok": True})
        elif name == "add_song_batch":
            if any(song[0] == 999 for song in command["songs"]):
                emit({"ok": False, "error": "simulated batch failure"})
            else:
                emit({"ok": True})
        elif name == "search":
            emit({"ok": True, "results": []})
        elif name == "list_playlist":
            emit({"ok": True, "songs": [{"id": 1, "mid": "m1", "name": "歌曲0", "artists": []}]})
        else:
            emit({"ok": True})


if __name__ == "__main__":
    main()
