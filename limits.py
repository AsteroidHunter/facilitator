"""How much of its plan each coding agent has used, for the home page's limits
box: the 5-hour window and the weekly window of Claude Code and of Codex, as a
percent used. Only those numbers leave this module, and nothing here opens a
sign-in file or calls a web endpoint.

  Codex   `codex app-server` is the tool's own JSON-RPC server on stdio. It is
          started, sent `initialize`, `initialized` and `account/rateLimits/read`,
          answers, and is stopped. Codex does its own sign-in. It is started at
          most once every EVERY seconds, under a hard time limit, so a stuck
          codex cannot hold a request. When it is missing, signed out or too
          slow, the newest limits Codex wrote into its own session logs are
          used (tokens.TokenLedger keeps them). The first ask of a run is waited
          for; after that a request is answered at once from the last reading,
          and a reading EVERY seconds old is renewed in the background, so no
          request waits on codex. A renewal that finds nothing keeps the last
          reading, and the time it was taken stays what it was.
  Claude  Claude Code hands its status line command the limits on stdin, and
          claude-statusline.py beside this file writes the two windows to a
          small file. That file is read here on every request.

A window is named by its length, never by its place in the reply: Codex has
sent the weekly window as `primary` with no 5-hour window at all. A window
whose reset time has passed is shown as 0 percent, since the number stored
with it describes a window that is over.
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path

EVERY = 5 * 60          # seconds between two starts of codex
TIMEOUT = 8.0           # seconds one whole conversation with codex may take
WINDOWS = {300: "five_hour", 10080: "weekly"}   # minutes in a window, and its name
BY_PLACE = {"primary": "five_hour", "secondary": "weekly"}   # only when no length is given


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value == value and abs(value) != float("inf") else None


def codex_windows(snapshot) -> dict:
    """{name: {"used", "resets"}} from one rate limit snapshot, whether it is
    the app server's (usedPercent, windowDurationMins, resetsAt) or a session
    log's (used_percent, window_minutes, resets_at). A window of any length but
    the two the box shows is left out."""
    out = {}
    if not isinstance(snapshot, dict):
        return out
    for place in ("primary", "secondary"):
        window = snapshot.get(place)
        if not isinstance(window, dict):
            continue
        used = _number(window.get("usedPercent", window.get("used_percent")))
        minutes = _number(window.get("windowDurationMins", window.get("window_minutes")))
        resets = _number(window.get("resetsAt", window.get("resets_at")))
        name = BY_PLACE[place] if minutes is None else WINDOWS.get(int(minutes))
        if used is not None and name and name not in out:
            out[name] = {"used": used, "resets": resets}
    return out


def read_claude(path) -> dict:
    """The windows the status line script wrote, or {} when there is no file
    or nothing readable in it."""
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    out = {}
    if not isinstance(data, dict):
        return out
    for key, name in (("five_hour", "five_hour"), ("seven_day", "weekly")):
        window = data.get(key)
        used = _number(window.get("used_percentage")) if isinstance(window, dict) else None
        if used is not None:
            out[name] = {"used": used, "resets": _number(window.get("resets_at"))}
    return out


def settle(windows: dict, now: float) -> dict:
    """The windows as the page gets them: whole percents from 0 to 100, and 0
    for a window whose reset time has passed."""
    out = {}
    for name in ("five_hour", "weekly"):
        window = windows.get(name)
        if not window:
            continue
        resets = window.get("resets")
        used = 0 if resets is not None and resets <= now else window["used"]
        out[name] = {"used": int(round(min(max(used, 0), 100))),
                     "resets": int(resets) if resets is not None else None}
    return out


def find_codex(path: str | None = None) -> str | None:
    return shutil.which("codex", path=path)


def _snapshot(result) -> dict | None:
    """The account's own bucket out of an account/rateLimits/read result: never
    one of the model buckets that ride beside it."""
    if not isinstance(result, dict):
        return None
    by_id = result.get("rateLimitsByLimitId")
    if isinstance(by_id, dict) and isinstance(by_id.get("codex"), dict):
        return by_id["codex"]
    single = result.get("rateLimits")
    if isinstance(single, dict) and single.get("limitId") in (None, "codex"):
        return single
    return None


def ask_codex(command: str, timeout: float = TIMEOUT) -> dict:
    """The windows `codex app-server` reports, or {} when it will not start,
    answers with an error, has no limits or does not answer within timeout."""
    try:
        proc = subprocess.Popen([command, "app-server"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, bufsize=1)
    except OSError:
        return {}
    lines: queue.Queue = queue.Queue()

    def pump() -> None:
        try:
            for line in proc.stdout:
                lines.put(line)
        except (OSError, ValueError):
            pass
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()
    deadline = time.monotonic() + timeout

    def send(message: dict) -> None:
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()

    def reply(wanted: int):
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            try:
                line = lines.get(timeout=left)
            except queue.Empty:
                return None
            if line is None:
                return None
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("id") == wanted:
                return message

    try:
        send({"method": "initialize", "id": 0,
              "params": {"clientInfo": {"name": "facilitator", "title": "Facilitator", "version": "1"}}})
        first = reply(0)
        if not first or "error" in first:
            return {}
        send({"method": "initialized", "params": {}})
        send({"method": "account/rateLimits/read", "id": 1})
        second = reply(1)
        if not second or "error" in second:
            return {}
        return codex_windows(_snapshot(second.get("result")))
    except (OSError, ValueError):
        return {}
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


class Limits:
    """What the page's limits box shows. claude_file is where the status line
    script writes, logged() answers with the newest limits found in Codex's
    session logs (or None), and path is where `codex` is looked for (the
    environment's PATH when None)."""

    def __init__(self, claude_file, logged=None, path: str | None = None,
                 every: float = EVERY, timeout: float = TIMEOUT, clock=time.time):
        self.claude_file = Path(claude_file)
        self.logged = logged
        self.path = path
        self.every = every
        self.timeout = timeout
        self.clock = clock
        self.lock = threading.Lock()
        self.codex: dict = {}
        self.asked = None       # when codex was last asked, to space the asks
        self.fetched = None     # when the reading in self.codex was taken
        self.busy = False       # a background renewal is running
        self.worker = None
        self.source = "none"

    def _ask(self) -> dict:
        command = find_codex(self.path)
        if command:
            got = ask_codex(command, self.timeout)
            if got:
                self.source = "app-server"
                return got
        try:
            got = codex_windows(self.logged()) if self.logged else {}
        except Exception:
            got = {}
        self.source = "log" if got else "none"
        return got

    def _store(self, got: dict) -> None:
        now = self.clock()
        if got or not self.codex:
            self.codex = got
            self.fetched = now
        self.asked = now

    def _renew(self) -> None:
        try:
            got = self._ask()
        except Exception:
            got = {}
        with self.lock:
            self._store(got)
            self.busy = False

    def idle(self, timeout: float = 30.0) -> None:
        """Wait for a background renewal to finish."""
        worker = self.worker
        if worker is not None:
            worker.join(timeout)

    def _view(self):
        now = self.clock()
        with self.lock:
            if self.asked is None:
                self._store(self._ask())
            elif now - self.asked >= self.every and not self.busy:
                self.busy = True
                self.worker = threading.Thread(target=self._renew, daemon=True)
                self.worker.start()
            codex, fetched, busy = self.codex, self.fetched, self.busy
        out = {}
        for tool, windows in (("claude", read_claude(self.claude_file)), ("codex", codex)):
            shown = settle(windows, now)
            if shown:
                out[tool] = shown
        return out, fetched, busy, now

    def read(self) -> dict:
        """{"claude": {"five_hour": {"used", "resets"}, "weekly": ...}, "codex":
        {...}}, holding only the tools that have a window to show."""
        return self._view()[0]

    def answer(self) -> dict:
        """read() plus three keys: "fetched", when codex was last read (None
        before the first reading); "now", this clock's time, so a reader on
        another clock can tell how old the reading is; and "refreshing", true
        while a renewal is running."""
        out, fetched, busy, now = self._view()
        out["fetched"] = None if fetched is None else int(fetched)
        out["now"] = int(now)
        out["refreshing"] = busy
        return out
