#!/usr/bin/env python3
"""A Claude Code status line command that hands the board the plan limits.

Claude Code runs the command after each reply and sends one JSON object on
stdin. This keeps the two numbers the home page's limits box draws,
rate_limits.five_hour and rate_limits.seven_day (used_percentage and
resets_at), in claude-limits.json beside this file, and prints a short status
line. Nothing else from the input is kept.

Each window is replaced only when the input has it: Claude Code sends the
limits for subscription plans only, only after the first reply of a session,
and either window may be missing on its own, so an input without them leaves
the file as it was. The file is written whole and moved into place.

A status line command already in use keeps working: give it as the one
argument, and the input is passed to it unchanged and its output is the line
printed here.

    python3 claude-statusline.py
    python3 claude-statusline.py "the command that was there before"
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

OUT = Path(__file__).resolve().parent / "claude-limits.json"
WINDOWS = (("five_hour", "5h"), ("seven_day", "wk"))
WRAPPED_SECONDS = 5


def number(value):
    ok = isinstance(value, (int, float)) and not isinstance(value, bool)
    return value if ok and value == value and abs(value) != float("inf") else None


def window(raw):
    used = number(raw.get("used_percentage")) if isinstance(raw, dict) else None
    if used is None:
        return None
    return {"used_percentage": used, "resets_at": number(raw.get("resets_at"))}


def read_stored():
    try:
        data = json.loads(OUT.read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {key: w for key, _ in WINDOWS if (w := window(data.get(key)))}


def write(windows):
    tmp = OUT.with_name(OUT.name + ".tmp")
    try:
        tmp.write_text(json.dumps(windows, separators=(",", ":")))
        os.replace(tmp, OUT)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


def short(windows):
    now = time.time()
    bits = []
    for key, name in WINDOWS:
        w = windows.get(key)
        if not w:
            continue
        over = w["resets_at"] is not None and w["resets_at"] <= now
        bits.append(f"{name} {0 if over else round(min(max(w['used_percentage'], 0), 100))}%")
    return "  ".join(bits)


def main():
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        data = json.loads(raw)
    except ValueError:
        data = {}
    limits = data.get("rate_limits") if isinstance(data, dict) else None
    stored = read_stored()
    windows = dict(stored)
    for key, _ in WINDOWS:
        got = window(limits.get(key)) if isinstance(limits, dict) else None
        if got:
            windows[key] = got
    if windows != stored:
        write(windows)
    if len(sys.argv) > 1:
        try:
            done = subprocess.run(sys.argv[1], shell=True, input=raw, capture_output=True,
                                  text=True, timeout=WRAPPED_SECONDS)
            sys.stdout.write(done.stdout)
        except (OSError, subprocess.TimeoutExpired):
            pass
        return
    line = short(windows)
    if line:
        print(line)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
