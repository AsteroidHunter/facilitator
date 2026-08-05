"""Triage facilitator — thinnest possible local server.

One page, one state file. The human types into per-item boxes; messages queue
FIFO; the agent (Claude, in the terminal session that launched this) drains the
queue one box at a time via GET /wait (long-poll) and answers via POST /reply.

Endpoints:
  GET  /                    -> index.html
  GET  /state               -> full UI state (page polls this)
  POST /send?box=ID         -> body = the human's message text (plain text)
  POST /done?box=ID&v=1|0   -> mark a box done / not done
  POST /park?box=ID&v=1|0   -> park a box to Later / bring it back
  POST /context?box=ID      -> body = the box's two-line context strip (agent-kept)
  POST /create              -> body's first line titles a new meta box (empty =
                               "…", named later by its first message); ids m1, m2...
  POST /delete?box=ID       -> remove a user-created meta box (not box 0)
  POST /end                 -> ask the agent to wrap up once the queue drains
  GET  /wait?timeout=S      -> agent long-poll; returns next claimed box + its
                               pending messages, or {"idle":true} on timeout,
                               or {"end":true} once ended and drained
  POST /reply?box=ID        -> body = the agent's reply text (plain text)

State persists to state.json next to this file; every send/reply also appends
to transcript.jsonl so the discussion survives anything.
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
STATE_PATH = HERE / "state.json"
TRANSCRIPT_PATH = HERE / "transcript.jsonl"
PORT = 8877

SEED = []  # (scrubbed)

_lock = threading.Condition()
_state: dict = {}
# runtime-only listener presence (not persisted): how the UI knows whether the
# agent's long-poll is actually connected right now
_waiters = 0
_last_wait = time.time()


def _seed_state() -> dict:
    return {
        "boxes": [
            {
                "id": bid, "bucket": bucket, "title": title, "reply": reply,
                "pending": [], "done": False, "replies": 0,
            }
            for bid, bucket, title, reply in SEED
        ],
        "inbox": [],          # box ids, FIFO
        "busy": None,         # box id the agent is composing for
        "claimed": [],        # message ids included in the current claim
        "end": False,
        "next_mid": 1,
    }


def _load() -> None:
    global _state
    if STATE_PATH.exists():
        _state = json.loads(STATE_PATH.read_text())
        for b in _state["boxes"]:  # ages start counting from first sight
            b.setdefault("ts", time.time())
    else:
        _state = _seed_state()
        _save()


def _save() -> None:
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(_state, indent=1))
    os.replace(tmp, STATE_PATH)


def _log(kind: str, box: str, text: str) -> None:
    with TRANSCRIPT_PATH.open("a") as f:
        f.write(json.dumps({"ts": time.time(), "kind": kind, "box": box, "text": text}) + "\n")


def _box(bid: str) -> dict | None:
    return next((b for b in _state["boxes"] if b["id"] == bid), None)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict | bytes, ctype: str = "application/json") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> str:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n).decode("utf-8", "replace") if n else ""

    # -- GET ------------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/":
            self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif url.path == "/state":
            with _lock:
                self._send(200, self._ui_state())
        elif url.path == "/wait":
            timeout = float(parse_qs(url.query).get("timeout", ["570"])[0])
            self._wait(timeout)
        else:
            self._send(404, {"error": "not found"})

    def _ui_state(self) -> dict:
        st = _state
        return {
            "boxes": [
                {
                    "id": b["id"], "bucket": b["bucket"], "title": b["title"],
                    "reply": b["reply"], "done": b["done"], "replies": b["replies"],
                    "ball": b.get("ball", "you"),
                    "parked": b.get("parked", False),
                    "ts": b.get("ts", 0),
                    "context": b.get("context", ""),
                    "pending": len(b["pending"]),
                    "writing": st["busy"] == b["id"],
                    "queuePos": (st["inbox"].index(b["id"]) + 1) if b["id"] in st["inbox"] else 0,
                }
                for b in st["boxes"]
            ],
            "busy": st["busy"],
            "queued": len(st["inbox"]),
            "end": st["end"],
            "listening": _waiters > 0,
            "listenerGap": round(time.time() - _last_wait, 1),
        }

    def _wait(self, timeout: float) -> None:
        global _waiters, _last_wait
        deadline = time.monotonic() + min(timeout, 590)
        with _lock:
            _waiters += 1
        try:
            self._wait_inner(deadline)
        finally:
            with _lock:
                _waiters -= 1
                _last_wait = time.time()

    def _wait_inner(self, deadline: float) -> None:
        with _lock:
            while True:
                # a claim older than 15 min with no reply is a dead listener: steal it back
                if _state["busy"] is not None and time.time() - _state.get("busy_ts", 0) > 900:
                    stale = _state["busy"]
                    _state["busy"] = None
                    _state["claimed"] = []
                    if _box(stale)["pending"] and stale not in _state["inbox"]:
                        _state["inbox"].insert(0, stale)
                    _save()
                if _state["inbox"] and _state["busy"] is None:
                    bid = _state["inbox"].pop(0)
                    box = _box(bid)
                    _state["busy"] = bid
                    _state["claimed"] = [m["mid"] for m in box["pending"]]
                    _state["busy_ts"] = time.time()
                    _save()
                    try:
                        self._send(200, {
                            "box": bid, "title": box["title"],
                            "messages": [m["text"] for m in box["pending"]],
                            "queued_after": len(_state["inbox"]),
                        })
                    except OSError:
                        # listener died mid-handoff: roll the claim back so the
                        # message is never stranded on a dead connection
                        _state["busy"] = None
                        _state["claimed"] = []
                        _state["inbox"].insert(0, bid)
                        _save()
                    return
                if _state["end"] and not _state["inbox"] and _state["busy"] is None:
                    self._send(200, {"end": True})
                    return
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._send(200, {"idle": True})
                    return
                _lock.wait(min(remaining, 5))

    # -- POST -----------------------------------------------------------------
    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        q = parse_qs(url.query)
        bid = (q.get("box") or [""])[0]
        text = self._read_body().strip()

        with _lock:
            if url.path == "/send":
                box = _box(bid)
                if box is None or not text:
                    self._send(400, {"error": "bad box or empty text"})
                    return
                box["pending"].append({"mid": _state["next_mid"], "text": text})
                box["ball"] = "me"  # his message sent: the ball is in the agent's court
                box["ts"] = time.time()
                _state["next_mid"] += 1
                # untitled user-created meta box: its first message names it
                if box["bucket"] == "meta" and box["id"] != "0" and box["title"] == "…":
                    first = text.splitlines()[0].strip()
                    box["title"] = (first[:48] + "…") if len(first) > 48 else first
                if bid not in _state["inbox"] and _state["busy"] != bid:
                    _state["inbox"].append(bid)
                _log("user", bid, text)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/reply":
                global _last_wait
                _last_wait = time.time()  # a reply proves the agent is alive too
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                box["reply"] = text
                box["replies"] += 1
                box["ball"] = "you"  # agent replied: awaiting the human
                box["ts"] = time.time()
                claimed = set(_state["claimed"]) if _state["busy"] == bid else set()
                box["pending"] = [m for m in box["pending"] if m["mid"] not in claimed]
                if _state["busy"] == bid:
                    _state["busy"] = None
                    _state["claimed"] = []
                # anything he sent while I was composing goes back in line
                if box["pending"] and bid not in _state["inbox"]:
                    _state["inbox"].append(bid)
                _log("agent", bid, text)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/done":
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                box["done"] = (q.get("v") or ["1"])[0] == "1"
                if box["done"]:
                    box["parked"] = False
                _log("done" if box["done"] else "undone", bid, "")
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/park":
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                box["parked"] = (q.get("v") or ["1"])[0] == "1"
                if box["parked"]:
                    box["done"] = False
                _log("park" if box["parked"] else "unpark", bid, "")
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/context":
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                box["context"] = text[:220]  # two lines, agent-maintained
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/create":
                title = (text or "…").splitlines()[0][:80]
                n = 1 + sum(1 for b in _state["boxes"] if b["id"].startswith("m"))
                bid_new = f"m{n}"
                # keep meta boxes grouped: insert after the last meta-bucket box
                idx = max(i for i, b in enumerate(_state["boxes"]) if b["bucket"] == "meta") + 1
                _state["boxes"].insert(idx, {
                    "id": bid_new, "bucket": "meta", "title": title, "reply": "",
                    "pending": [], "done": False, "parked": False, "replies": 0,
                    "ball": "me",
                })
                _log("create", bid_new, title)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "id": bid_new})

            elif url.path == "/delete":
                box = _box(bid)
                if box is None or bid == "0" or box["bucket"] != "meta":
                    self._send(400, {"error": "only user-created meta boxes can be deleted"})
                    return
                _state["boxes"].remove(box)
                if bid in _state["inbox"]:
                    _state["inbox"].remove(bid)
                if _state["busy"] == bid:
                    _state["busy"] = None
                    _state["claimed"] = []
                _log("delete", bid, box["title"])
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/end":
                _state["end"] = True
                _log("end", "", "")
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            else:
                self._send(404, {"error": "not found"})

    def log_message(self, *args) -> None:  # quiet
        pass


def main() -> None:
    _load()
    with _lock:
        _state["busy"] = None  # a restart never resumes mid-claim
        _state["claimed"] = []
        # re-queue any box that still has unanswered messages
        for b in _state["boxes"]:
            if b["pending"] and b["id"] not in _state["inbox"]:
                _state["inbox"].append(b["id"])
        _save()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"facilitator on http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
