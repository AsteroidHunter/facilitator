"""Triage facilitator — thinnest possible local server.

One page, one state file. The human types into per-item boxes; messages queue
FIFO; the agent (Claude, in the terminal session that launched this) drains the
queue one box at a time via GET /wait (long-poll) and answers via POST /reply.

Endpoints:
  GET  /                    -> index.html
  GET  /state               -> full UI state (page polls this)
  POST /send?box=ID         -> body = the human's message text (plain text)
  POST /done?box=ID&v=1|0   -> mark a box done / not done
  POST /working?box=ID&v=1|0 -> a worker's job runs behind this box: it shows
                               green without holding the lane's claim
  POST /park?box=ID&v=1|0   -> park a box to Later / bring it back
  POST /context?box=ID      -> body = the box's two-line context strip (agent-kept)
  POST /title?box=ID        -> body = replacement title (agent keeps titles brief;
                               auto-names are just the chopped first message)
  POST /create?owner=O      -> body's first line titles a new meta box (empty =
                               "…", named later by its first message); ids m1, m2...;
                               owner defaults to facilitator
  POST /delete?box=ID       -> remove a meta box (the standing 0 / t0 included)
  POST /upload?name=F       -> body = raw image bytes; saves to uploads/ beside the
                               server (gitignored), returns {"url": "/uploads/..."};
                               GET /uploads/<file> serves it back
  GET  /uploads/<file>      -> a previously uploaded image
  GET  /thread?box=ID&n=N   -> last N user/agent messages of a box from the
                               transcript (the quick-chat panel's history)
  GET  /log?lines=N         -> tail of the server log file; path from $FACILITATOR_LOG
  POST /ws/goal?owner&ws    -> body = the workspace's goal text
  POST /ws/task?owner&ws[&id][&status][&del=1] -> body = task text; no id creates,
                               status one of pending|ongoing|done, del removes
  POST /ws/current?owner&ws&id -> set the workspace's current task
  POST /assign?box=ID&task=T -> file a chat under a task (empty task unfiles)
  POST /dismiss?box=ID      -> drop the box's queued messages unanswered (they
                               stay in the transcript)
  POST /progress?box=ID     -> interim note while holding a claim; keeps the
                               card green and resets the steal timer, no release
  POST /end                 -> ask the agent to wrap up once the queue drains
  POST /pause?v=1|0         -> pause / resume both listeners (laptop-close mode):
                               while paused /wait returns {"paused":true} at once
                               and agents idle locally, re-checking /state ~1/min
  GET  /wait?owner=O&timeout=S[&agent=NAME] -> agent long-poll; claims the oldest
                               queued box owned by O (facilitator|triage; defaults
                               to triage, the pre-routing loop's role) + its pending
                               messages. agent= states the caller's name; the card
                               rows' little tag shows the lane's live name or
                               offline, never a stored guess. Also returns
                               {"idle":true} on timeout, {"paused":true} while
                               paused, or {"end":true} once ended and O's queue
                               is drained
  POST /reply?box=ID&ctx=S  -> body = the agent's reply text (plain text); ctx
                               is a REQUIRED urlencoded two-line summary strip
                               (220 chars max) stored as the box's context, so
                               a reply and a fresh summary always land together
                               and a reply without one is refused (400). If
                               messages landed on the box that the agent was
                               never handed, the reply does NOT land; the call
                               returns {"retry":true,"folded":[texts]} handing
                               them over, and the agent folds them in and sends
                               again. A reply can never go out stale.

Owner routing (2026-08-05): every box carries an owner tag, facilitator (tool
discussion, this repo's agent) or triage (the project under discussion, its
own agent). Each owner has its own busy/claim slot and listener-presence
tracking, so the two agents drain the same board without blocking each other.

State persists to state.json next to this file; every send/reply also appends
to transcript.jsonl so the discussion survives anything. A first-ever start
(no state.json) seeds the board title and boxes from seed.json if present;
see seed.example.json. Real discussion content never ships in this code.
"""

from __future__ import annotations

import json
import os
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
LOG_PATH = Path(os.environ.get("FACILITATOR_LOG", "/tmp/facilitator-8877.log"))


def _lane_dirs() -> dict:
    """Per-owner project directory from run.config.json (machine-local, gitignored);
    served to the page for the pwd line, never part of tracked content."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
        return {ln["owner"]: str(Path(ln["dir"]).expanduser())
                for ln in cfg.get("lanes", []) if ln.get("owner") and ln.get("dir")}
    except Exception:
        return {}
STATE_PATH = HERE / "state.json"
TRANSCRIPT_PATH = HERE / "transcript.jsonl"
PORT = 8877
OWNERS = ("facilitator", "triage", "journal")  # journal: the quick-chat side panel's lane

# names for unnamed cards, handed out without repeats among live cards
FAIRY_NAMES = (
    "Thistledown Pixie Waltz", "Mossbank Sprite Parade", "Glowworm Court Jester",
    "Dewdrop Troll Picnic", "Bramble Elf Sonata", "Foxglove Gnome Errand",
    "Toadstool Fae Council", "Willow Wisp Detour", "Acorn Imp Heist",
    "Fernshade Nixie Riddle", "Clover Brownie Feast", "Pondlight Kelpie Drift",
    "Twilight Boggart Shuffle", "Honeymead Dryad Toast", "Frostbell Goblin March",
    "Starlit Selkie Crossing", "Buttercup Ogre Nap", "Silverfern Faun Prank",
    "Mushroom Hobgoblin Tea", "Cobweb Banshee Lullaby", "Riverbed Undine Chorus",
)
_LANE_DIRS = _lane_dirs()

SEED_PATH = HERE / "seed.json"

_lock = threading.Condition()
_state: dict = {}
# runtime-only listener presence (not persisted), per owner: how the UI knows
# whether each agent's long-poll is actually connected right now
_waiters = {ow: 0 for ow in OWNERS}
# zero, not boot time: a lane counts as alive only once its agent actually asks
_last_wait = {ow: 0.0 for ow in OWNERS}
# the name each lane's agent last stated on its /wait call; None until stated
_agent_names: dict = {ow: None for ow in OWNERS}


def _seed_state() -> dict:
    """First-ever start: board title and boxes come from seed.json if present
    (see seed.example.json); otherwise the board starts empty."""
    seed = json.loads(SEED_PATH.read_text()) if SEED_PATH.exists() else {}
    return {
        "title": seed.get("title", "facilitator"),
        "boxes": [
            {
                "id": it["id"], "bucket": it["bucket"], "title": it["title"],
                "reply": it.get("context", ""),
                "pending": [], "done": False, "replies": 0,
                "owner": it.get("owner", "triage"),
            }
            for it in seed.get("items", [])
        ],
        "inbox": [],          # box ids, FIFO (shared; owner-filtered at claim time)
        "busy": {ow: None for ow in OWNERS},   # box id each agent is composing for
        "claimed": {ow: [] for ow in OWNERS},  # message ids in each current claim
        "busy_ts": {ow: 0.0 for ow in OWNERS},
        "end": False,
        "paused": False,
        "next_mid": 1,
        "next_bid": 1,
    }


def _load() -> None:
    global _state
    if STATE_PATH.exists():
        _state = json.loads(STATE_PATH.read_text())
        for b in _state["boxes"]:  # ages start counting from first sight
            b.setdefault("ts", time.time())
    else:
        _state = _seed_state()
    _migrate()


def _migrate() -> None:
    """Owner routing (2026-08-05): idempotent upgrade of pre-routing state."""
    _state.setdefault("paused", False)
    _state.setdefault("title", "facilitator")
    # monotonic box-id counter: count-based ids collided after a deletion
    _state.setdefault("next_bid", 1 + max(
        [int(b["id"][1:]) for b in _state["boxes"]
         if b["id"].startswith("m") and b["id"][1:].isdigit()] or [0]))
    for b in _state["boxes"]:
        b.setdefault("owner", "facilitator" if b["id"] == "0" or b["id"].startswith("m") else "triage")
    if not isinstance(_state.get("busy"), dict):  # scalar claim slots -> per-owner maps
        _state["busy"] = {ow: None for ow in OWNERS}
        _state["claimed"] = {ow: [] for ow in OWNERS}
        _state["busy_ts"] = {ow: 0.0 for ow in OWNERS}
    if _box("t0") is None:  # box 0 is the facilitator agent's; triage-meta gets its own pin
        _state["boxes"].insert(_state["boxes"].index(_box("0")) + 1 if _box("0") else 0, {
            "id": "t0", "bucket": "meta", "title": "Release triage: drop meta thoughts here",
            "reply": "", "pending": [], "done": False, "parked": False, "replies": 0,
            "ball": "you", "ts": time.time(), "owner": "triage",
        })
    # a third owner appearing in OWNERS gets its claim slots on upgrade
    for slot in ("busy", "claimed", "busy_ts"):
        if isinstance(_state.get(slot), dict):
            for ow in OWNERS:
                _state[slot].setdefault(ow, [] if slot == "claimed" else (0.0 if slot == "busy_ts" else None))
    if _box("q") is None:  # the quick-chat thread, served by the journal lane
        _state["boxes"].append({
            "id": "q", "bucket": "meta", "title": "quick chat",
            "reply": "", "pending": [], "done": False, "parked": False, "replies": 0,
            "ball": "you", "ts": time.time(), "owner": "journal",
        })
    _state.setdefault("ever_listened", {})
    # workspaces (2026-08-09): each owner gets at least one, a named collection
    # of chats aimed at a goal, with a task list the human and agent both edit
    ws = _state.setdefault("workspaces", {})
    for ow in OWNERS:
        if not ws.get(ow):
            started = min([b.get("ts", time.time()) for b in _state["boxes"]
                           if b.get("owner") == ow] or [time.time()])
            ws[ow] = [{"id": "w1", "name": "main", "started": started,
                       "goal": "", "tasks": [], "current": None}]
    _state.setdefault("next_tid", 1)
    for b in _state["boxes"]:
        b.setdefault("ws", ws[b.get("owner", "triage")][0]["id"])
        b.setdefault("task", None)
        b.setdefault("agent_ts", 0)
    _save()


def _save() -> None:
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(_state, indent=1))
    os.replace(tmp, STATE_PATH)


def _log(kind: str, box: str, text: str) -> None:
    with TRANSCRIPT_PATH.open("a") as f:
        f.write(json.dumps({"ts": time.time(), "kind": kind, "box": box, "text": text}) + "\n")
    snippet = " ".join(str(text).split())[:80]
    tag = f"[{box}]" if box else ""
    print(f"{time.strftime('%H:%M:%S')}  {kind:<7}{tag:<7} {snippet}", flush=True)


def _box(bid: str) -> dict | None:
    return next((b for b in _state["boxes"] if b["id"] == bid), None)


def _ws(owner: str, wid: str) -> dict | None:
    return next((w for w in _state.get("workspaces", {}).get(owner, [])
                 if w["id"] == wid), None)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict | bytes, ctype: str = "application/json") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client hung up mid-response (a timed-out poll); not an error

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
            q = parse_qs(url.query)
            timeout = float(q.get("timeout", ["570"])[0])
            owner = (q.get("owner") or ["triage"])[0]  # default: the pre-routing loop's role
            if owner not in OWNERS:
                self._send(400, {"error": "unknown owner"})
                return
            agent = (q.get("agent") or [None])[0]
            if agent:
                _agent_names[owner] = agent[:24]
            self._wait(timeout, owner)
        elif url.path == "/thread":
            qs = parse_qs(url.query)
            tbid = (qs.get("box") or [""])[0]
            n = int((qs.get("n") or ["60"])[0])
            out = []
            try:
                with TRANSCRIPT_PATH.open() as f:
                    for line in f:
                        try:
                            e = json.loads(line)
                        except ValueError:
                            continue
                        if e.get("box") == tbid and e.get("kind") in ("user", "agent"):
                            out.append({"kind": e["kind"], "text": e.get("text", ""), "ts": e.get("ts", 0)})
            except FileNotFoundError:
                pass
            self._send(200, {"messages": out[-n:]})
        elif url.path == "/log":
            n = int((parse_qs(url.query).get("lines") or ["120"])[0])
            try:
                lines = LOG_PATH.read_text(errors="replace").splitlines()[-n:]
            except OSError:
                lines = []
            self._send(200, {"lines": lines})
        elif url.path.startswith("/uploads/"):
            p = HERE / "uploads" / Path(url.path).name  # .name strips any traversal
            ctypes = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
            if p.is_file() and p.suffix.lower() in ctypes:
                self._send(200, p.read_bytes(), ctypes[p.suffix.lower()])
            else:
                self._send(404, {"error": "not found"})
        else:
            self._send(404, {"error": "not found"})

    def _ui_state(self) -> dict:
        st = _state
        qpos, seen = {}, {ow: 0 for ow in OWNERS}  # queue position within each owner's lane
        for i in st["inbox"]:
            ow = (_box(i) or {}).get("owner", "triage")
            seen[ow] += 1
            qpos[i] = seen[ow]
        return {
            "boxes": [
                {
                    "id": b["id"], "bucket": b["bucket"], "title": b["title"],
                    "reply": b["reply"], "done": b["done"], "replies": b["replies"],
                    "ball": b.get("ball", "you"),
                    "parked": b.get("parked", False),
                    "ts": b.get("ts", 0),
                    "context": b.get("context", ""),
                    "owner": b.get("owner", "triage"),
                    "pending": len(b["pending"]),
                    "pendingTexts": [m["text"] for m in b["pending"]],
                    "ws": b.get("ws"), "task": b.get("task"),
                    "agentTs": b.get("agent_ts", 0),
                    "engine": b.get("engine", "claude"),
                    "writing": st["busy"][b.get("owner", "triage")] == b["id"],
                    "bg": b.get("bg", False),   # a worker's job runs behind this card
                    "queuePos": qpos.get(b["id"], 0),
                }
                for b in st["boxes"]
            ],
            "pwd": str(HERE),
            "pwds": {**{ow: str(HERE) for ow in OWNERS}, **_LANE_DIRS},
            "busy": st["busy"],
            "queued": len(st["inbox"]),
            "end": st["end"],
            "paused": st.get("paused", False),
            "title": st.get("title", "facilitator"),
            "listening": {ow: _waiters[ow] > 0 for ow in OWNERS},
            "everListened": st.get("ever_listened", {}),
            "workspaces": st.get("workspaces", {}),
            "listenerGap": {ow: round(time.time() - _last_wait[ow], 1) for ow in OWNERS},
            # the row tag's truth: the lane's last stated agent name, and alive
            # meaning connected now, seen within the steal window, or holding a card
            "agents": {ow: {
                "name": _agent_names[ow] or "claude",
                "alive": _waiters[ow] > 0
                         or (time.time() - _last_wait[ow]) < 900
                         or bool(st["busy"][ow]),
            } for ow in OWNERS},
        }

    def _wait(self, timeout: float, owner: str) -> None:
        deadline = time.monotonic() + min(timeout, 590)
        with _lock:
            _waiters[owner] += 1
            ev = _state.setdefault("ever_listened", {})
            if not ev.get(owner):
                ev[owner] = True
                _save()
        try:
            self._wait_inner(deadline, owner)
        finally:
            with _lock:
                _waiters[owner] -= 1
                _last_wait[owner] = time.time()

    def _wait_inner(self, deadline: float, owner: str) -> None:
        with _lock:
            while True:
                if _state.get("paused"):  # laptop-close mode: send the listener home
                    self._send(200, {"paused": True})
                    return
                # a claim older than 15 min with no reply is a dead listener: steal it back
                for ow in OWNERS:
                    stale = _state["busy"][ow]
                    if stale is not None and time.time() - _state["busy_ts"].get(ow, 0) > 900:
                        _state["busy"][ow] = None
                        _state["claimed"][ow] = []
                        if _box(stale) and _box(stale)["pending"] and stale not in _state["inbox"]:
                            _state["inbox"].insert(0, stale)
                        _save()
                if _state["busy"][owner] is None:
                    bid = next((i for i in _state["inbox"]
                                if (_box(i) or {}).get("owner", "triage") == owner), None)
                    if bid is not None:
                        _state["inbox"].remove(bid)
                        box = _box(bid)
                        _state["busy"][owner] = bid
                        _state["claimed"][owner] = [m["mid"] for m in box["pending"]]
                        _state["busy_ts"][owner] = time.time()
                        _save()
                        try:
                            self._send(200, {
                                "box": bid, "title": box["title"],
                                "messages": [m["text"] for m in box["pending"]],
                                "queued_after": sum(1 for i in _state["inbox"]
                                                    if (_box(i) or {}).get("owner", "triage") == owner),
                            })
                        except OSError:
                            # listener died mid-handoff: roll the claim back so the
                            # message is never stranded on a dead connection
                            _state["busy"][owner] = None
                            _state["claimed"][owner] = []
                            _state["inbox"].insert(0, bid)
                            _save()
                        return
                if _state["end"] and _state["busy"][owner] is None and not any(
                        (_box(i) or {}).get("owner", "triage") == owner for i in _state["inbox"]):
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

        if url.path == "/upload":  # binary body (dropped image); never decode as text
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            if not raw:
                self._send(400, {"error": "empty upload"})
                return
            name = (q.get("name") or ["file"])[0]
            safe = "".join(c for c in name if c.isalnum() or c in "._-")[-60:] or "file"
            up = HERE / "uploads"
            up.mkdir(exist_ok=True)
            fname = f"{int(time.time() * 1000)}-{safe}"
            (up / fname).write_bytes(raw)
            self._send(200, {"url": "/uploads/" + fname})
            return

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
                if bid not in _state["inbox"] and _state["busy"][box.get("owner", "triage")] != bid:
                    _state["inbox"].append(bid)
                _log("user", bid, text)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/reply":
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                # every reply must carry a fresh two-line summary strip in the
                # ctx query param (urlencoded, 220 chars); a reply without one
                # is refused so the card's summary can never go missing
                ctx = (q.get("ctx") or [""])[0].strip()
                if not ctx:
                    self._send(400, {"error": "missing context strip: pass ctx="})
                    return
                ow = box.get("owner", "triage")
                _last_wait[ow] = time.time()  # a reply proves that agent is alive too
                # the reply gate: a reply cannot land while this box holds
                # messages the agent was never handed. The gate hands them over
                # in the refusal, so the resent reply already folds them in and
                # an answer can never go out stale.
                handed = set(box.get("handed", []))
                if _state["busy"][ow] == bid:
                    handed |= set(_state["claimed"][ow])
                fresh = [m for m in box["pending"] if m["mid"] not in handed]
                if fresh:
                    box["handed"] = list(handed | {m["mid"] for m in fresh})
                    _save()
                    self._send(200, {"retry": True,
                                     "folded": [m["text"] for m in fresh]})
                    return
                box["reply"] = text
                box["replies"] += 1
                box["ball"] = "you"
                box["agent_ts"] = time.time()  # agent replied: awaiting the human
                box["ts"] = time.time()
                box["pending"] = [m for m in box["pending"] if m["mid"] not in handed]
                box["handed"] = []
                box["context"] = ctx[:220]
                if _state["busy"][ow] == bid:
                    _state["busy"][ow] = None
                    _state["claimed"][ow] = []
                # anything he sent while I was composing goes back in line
                if box["pending"] and bid not in _state["inbox"]:
                    _state["inbox"].append(bid)
                # and a fully answered box leaves the line, or the next claim
                # hands the agent an empty turn
                if not box["pending"] and bid in _state["inbox"]:
                    _state["inbox"].remove(bid)
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

            elif url.path == "/working":
                # a worker's job runs behind this card: green without a claim,
                # so the lane stays free while the work happens elsewhere
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                box["bg"] = (q.get("v") or ["1"])[0] == "1"
                _log("working" if box["bg"] else "workdone", bid, "")
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

            elif url.path == "/title":
                box = _box(bid)
                if box is None or (not text and box["title"]):
                    self._send(400, {"error": "bad box or empty title"})
                    return
                if not text:
                    # naming was abandoned: hand out a whimsical name no live
                    # card is already wearing
                    used = {b["title"] for b in _state["boxes"]}
                    free = [n for n in FAIRY_NAMES if n not in used]
                    box["title"] = random.choice(free or FAIRY_NAMES)
                else:
                    box["title"] = text.splitlines()[0][:80]
                _log("title", bid, box["title"])
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "title": box["title"]})

            elif url.path == "/create":
                owner = (q.get("owner") or ["facilitator"])[0]
                if owner not in OWNERS:
                    self._send(400, {"error": "unknown owner"})
                    return
                # born nameless; a whimsical name lands only if naming is walked
                # away from (the empty-body /title call below)
                title = (text or "").splitlines()[0][:80] if text else ""
                bid_new = f"m{_state['next_bid']}"  # never reused, even after deletes
                _state["next_bid"] += 1
                # keep each meta section grouped: insert after its last same-owner meta box
                idx = max([i for i, b in enumerate(_state["boxes"])
                           if b["bucket"] == "meta" and b.get("owner") == owner] or [-1]) + 1
                ws0 = (_state.get("workspaces", {}).get(owner) or [{}])[0].get("id")
                _state["boxes"].insert(idx, {
                    "id": bid_new, "bucket": "meta", "title": title, "reply": "",
                    "pending": [], "done": False, "parked": False, "replies": 0,
                    "ball": "me", "ts": time.time(), "owner": owner,
                    "ws": ws0, "task": None, "agent_ts": 0,
                })
                _log("create", bid_new, title)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "id": bid_new})

            elif url.path == "/delete":
                box = _box(bid)
                if box is None or box["bucket"] != "meta":
                    self._send(400, {"error": "only meta boxes can be deleted"})
                    return
                _state["boxes"].remove(box)
                if bid in _state["inbox"]:
                    _state["inbox"].remove(bid)
                ow = box.get("owner", "triage")
                if _state["busy"][ow] == bid:
                    _state["busy"][ow] = None
                    _state["claimed"][ow] = []
                _log("delete", bid, box["title"])
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/ws/goal":
                w = _ws((q.get("owner") or [""])[0], (q.get("ws") or [""])[0])
                if w is None:
                    self._send(400, {"error": "unknown workspace"})
                    return
                w["goal"] = text
                _log("goal", w["id"], text)
                _save()
                self._send(200, {"ok": True})

            elif url.path == "/ws/task":
                ow = (q.get("owner") or [""])[0]
                w = _ws(ow, (q.get("ws") or [""])[0])
                if w is None:
                    self._send(400, {"error": "unknown workspace"})
                    return
                tid = (q.get("id") or [""])[0]
                status = (q.get("status") or [""])[0]
                if not tid:  # create; body names it
                    tid = f"t{_state['next_tid']}"
                    _state["next_tid"] += 1
                    w["tasks"].append({"id": tid, "text": text, "status": "pending"})
                    _log("task+", tid, text)
                else:
                    t = next((t for t in w["tasks"] if t["id"] == tid), None)
                    if t is None:
                        self._send(400, {"error": "unknown task"})
                        return
                    if (q.get("del") or [""])[0] == "1":
                        w["tasks"].remove(t)
                        for b in _state["boxes"]:
                            if b.get("task") == tid:
                                b["task"] = None
                        _log("task-", tid, t["text"])
                    else:
                        if status in ("pending", "ongoing", "done"):
                            t["status"] = status
                        if text:
                            t["text"] = text
                        _log("task", tid, f"{t['status']} {t['text']}")
                _save()
                self._send(200, {"ok": True, "id": tid})

            elif url.path == "/ws/current":
                w = _ws((q.get("owner") or [""])[0], (q.get("ws") or [""])[0])
                if w is None:
                    self._send(400, {"error": "unknown workspace"})
                    return
                tid = (q.get("id") or [""])[0] or None
                w["current"] = tid
                _log("current", tid or "", "")
                _save()
                self._send(200, {"ok": True})

            elif url.path == "/assign":
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "unknown box"})
                    return
                box["task"] = (q.get("task") or [""])[0] or None
                _log("assign", bid, box["task"] or "none")
                _save()
                self._send(200, {"ok": True})

            elif url.path == "/progress":  # interim note during a build: keeps
                box = _box(bid)                # the claim (card stays green) and
                ow = box.get("owner", "triage") if box else None  # heartbeats
                if box is None or _state["busy"].get(ow) != bid:
                    self._send(400, {"error": "not holding this box"})
                    return
                box["reply"] = text
                box["ts"] = time.time()
                _state["busy_ts"][ow] = time.time()   # resets the 15-min steal
                _log("progress", bid, text)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/dismiss":  # drop a box's queued messages, unanswered
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "unknown box"})
                    return
                n = len(box["pending"])
                box["pending"] = []
                box["handed"] = []
                if bid in _state["inbox"]:
                    _state["inbox"].remove(bid)
                ow = box.get("owner", "triage")
                if _state["busy"].get(ow) == bid:
                    _state["busy"][ow] = None
                    _state["claimed"][ow] = []
                _log("dismiss", bid, f"{n} queued dropped")
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "dropped": n})

            elif url.path == "/pause":
                _state["paused"] = (q.get("v") or ["1"])[0] == "1"
                _log("pause" if _state["paused"] else "unpause", "", "")
                _save()
                _lock.notify_all()  # in-flight waiters return {"paused":true} at once
                self._send(200, {"ok": True, "paused": _state["paused"]})

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
        _state["busy"] = {ow: None for ow in OWNERS}  # a restart never resumes mid-claim
        _state["claimed"] = {ow: [] for ow in OWNERS}
        # re-queue any box that still has unanswered messages
        for b in _state["boxes"]:
            if b["pending"] and b["id"] not in _state["inbox"]:
                _state["inbox"].append(b["id"])
        _save()
    class QuietServer(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            et = sys.exc_info()[0]
            if et in (BrokenPipeError, ConnectionResetError):
                return  # dropped connections are routine here, never worth a traceback
            super().handle_error(request, client_address)

    server = QuietServer(("127.0.0.1", PORT), Handler)
    print(f"facilitator on http://127.0.0.1:{PORT}, {len(_state['boxes'])} boxes", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
