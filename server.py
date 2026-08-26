"""Triage facilitator — thinnest possible local server.

One page, one state file. The human types into per-item boxes; messages queue
FIFO; the agent (Claude, in the terminal session that launched this) drains the
queue one box at a time via GET /wait (long-poll) and answers via POST /reply.

Endpoints:
  GET  /                    -> index.html, the card board
  GET  /page                -> page.html, the same lanes drawn as one typed page
  GET  /state               -> full UI state (page polls this)
  POST /send?box=ID[&via=mini] -> body = the human's message text (plain text).
                               via states where he typed it: mini is the small
                               card in the corner, no via at all is the big card
                               in the middle. Only the literal "mini" is stored
                               (as the message's via field), so any other value
                               and any older caller land exactly as before
  POST /done?box=ID&v=1|0   -> mark a box done / not done
  POST /working?box=ID&v=1|0 -> a job runs behind this box: it shows green
                               without holding the lane's claim. Registration
                               starts a heartbeat clock; without /ping every
                               75s the green expires on its own. v=0 and that
                               expiry are also where a turn deferred by a
                               reply under the flag is handed over
  POST /ping?box=ID         -> heartbeat for a registered job; refreshes its
                               green while the job actually runs
  POST /park?box=ID&v=1|0   -> park a box to Later / bring it back
  POST /context?box=ID      -> body = the box's two-line context strip (agent-kept)
  POST /title?box=ID        -> body = replacement title (agent keeps titles brief;
                               auto-names are just the chopped first message)
  POST /create?owner=O      -> body's first line titles a new meta box (empty =
                               "…", named later by its first message); ids m1, m2...;
                               owner defaults to facilitator
  POST /project?name=N      -> body = the chosen folder's absolute path (under
                               the home directory): creates a new project lane
                               whose owner id is a slug of N, stores {id, name,
                               dir} in state.json so restarts keep it, and
                               returns the id; no card is created with the lane;
                               a taken id walks numbered suffixes (-2, -3) until
                               free; empty names and bad folders are refused (400)
  POST /delete?box=ID       -> remove a meta box (the standing 0 / t0 included)
  POST /upload?name=F       -> body = raw image bytes; saves to the sibling internal
                               folder ../facilitator-internal/uploads/ (outside the
                               repo, never pushed), returns {"url": "/uploads/..."}
                               unchanged; GET /uploads/<file> serves it back
  GET  /uploads/<file>      -> a previously uploaded image: served from the internal
                               uploads folder, falling back to the old in-repo
                               uploads/ for images saved before the move
  GET  /laneimg/<lane>/<file> -> a picture out of that lane's OWN internal folder,
                               <lane dir>/<lane id>-internal, the same rule this
                               repo's facilitator-internal/ already follows. The
                               lane dirs are the ones /state hands out as pwds.
                               <file> must be one plain file name and the resolved
                               path has to sit inside that folder, so .. segments,
                               nested paths, absolute names and symlinks pointing
                               out of it are all refused. Only the image content
                               types /uploads/ serves are served; anything else,
                               an unknown lane, a missing folder or a missing file
                               is a 404. Lets an agent working in another project
                               show a picture on the board without writing a file
                               into this repo
  GET  /thread?box=ID&n=N   -> last N user/agent messages of a box from the
                               transcript (read by the reply history stepper
                               and the quick chat panel)
  GET  /log?lines=N         -> tail of the server log file; path from $FACILITATOR_LOG
  GET  /dirs?path=P         -> the subdirectories of P (name + absolute path)
                               for the page's folder chooser; empty P means the
                               home directory; hidden folders are excluded and
                               paths outside the home directory are refused
  GET  /pickdir             -> the system folder chooser on the desktop this
                               server runs in: blocks until a folder is chosen,
                               then {"path": "..."}; a dismissed chooser answers
                               {"cancelled": true}, a real failure {"error": "..."}.
                               With FACILITATOR_PICKDIR_STUB set on the server
                               process the value answers at once and no dialog
                               ever opens, so tests can drive the flow headless
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
  GET  /fresh?owner=O       -> while O's agent holds a card: any messages that
                               landed on that card after the claim, handed over
                               and folded into the claim, so the one reply
                               covers them and nothing is delivered twice.
                               Answers {box, messages, message_via}, with
                               message_via in the same shape /wait uses: one
                               entry per handed-over message in the same order,
                               "mini" for a small card message and null for a
                               big card one. A mini message handed over here
                               becomes the newest message the claim covers, so
                               it is the one that decides /reply's 100 word cap,
                               and the agent has to be able to see it;
                               {"messages": [], "message_via": []} when nothing
                               new or no card held
  GET  /wait?owner=O&timeout=S[&agent=NAME] -> agent long-poll; claims the oldest
                               queued box owned by O (facilitator|triage; defaults
                               to triage, the pre-routing loop's role) + its pending
                               messages. agent= states the caller's name; the card
                               rows' little tag shows the lane's live name or
                               offline, never a stored guess. A claim answers
                               {box, title, messages, message_via, queued_after,
                               ack}: messages stays a list of plain strings and
                               message_via runs beside it, one entry per message
                               in the same order, "mini" for a small card message
                               and null for a big card one. Also returns
                               {"idle":true} on timeout, {"paused":true} while
                               paused, or {"end":true} once ended and O's queue
                               is drained.
                               Delivery is confirmed, always: ack carries a short
                               token and the claim counts as provisional until
                               POST /ack names it. There is no unconfirmed mode.
                               An ack=1 in the query is accepted and ignored, so
                               a loop that learned the flag still works
  POST /ack?owner=O&token=T -> confirms the provisional claim that token was
                               minted for and answers {"ok": true}; acking an
                               already confirmed claim again says the same, so a
                               resent ack is safe. An unknown or stale token is a
                               409 with a short reason. A provisional claim
                               nobody confirms within 90 seconds is released: the
                               box goes back to the FRONT of its lane's queue and
                               the card falls back to the queued grey, exactly
                               like an unpicked card, never yellow. That clock is
                               swept wherever the 15 minute steal-back is swept
                               and on every /state, which the board polls about
                               once a second, so it runs even with no /wait open.
                               A loop that claims and never acks gets the same
                               card handed back every 90 seconds
  GET  /unread?owner=O      -> {"queued": N, "claimed": M} for that lane: messages
                               still waiting to be handed over, and messages in
                               the claim that lane's agent holds right now. Read
                               only, it claims nothing and releases nothing; for
                               a Stop hook checking whether anything is waiting
                               before the agent goes idle, and for humans
  POST /reply?box=ID[&ctx=S][&quiet=1] -> body = the agent's reply text (plain
                               text); ctx is an OPTIONAL urlencoded summary
                               strip, 50 words max, stored as the box's
                               context when passed. The summary box was taken
                               off the card 20260821 and nothing displays it;
                               an overlong strip is still refused (400), never
                               silently truncated.
                               When the newest message the claim covers came
                               from the small card (via=mini), a reply over 100
                               whitespace separated words is refused the same
                               way (400, nothing stored): that card is only a
                               few lines tall. A big card message has no cap.
                               A normal reply hands the ball to you only when
                               no working flag beats on the box. While one
                               does, nothing awaits you yet: the card goes to
                               the deferred state and the turn is handed over
                               when that flag drops or expires, so a mid-work
                               reply cannot turn a green card yellow.
                               quiet=1 stores the reply, summary, count and
                               stamp the same way and changes nothing else:
                               the ball stays untouched, so the card's color
                               keeps coming from the work itself (green while
                               claimed or registered, grey while queued,
                               yellow only when a real answer awaits a read).
                               For interim notes while the card's work is in
                               flight.
  POST /note?box=ID&ctx=S   -> the named interim-note action: stores the body
                               and ctx summary like /reply (reply, count,
                               agent_ts, ts, context) and moves the card to
                               working (the flag's heartbeat), never handing
                               the ball to "you". So the state stays a green
                               working, never a yellow "yours": a progress
                               note structurally cannot float a card to the
                               top. A normal /reply stays the answer action
                               that hands the ball to you.

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
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

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
# uploaded images now save outside the repo, in the sibling internal folder
# (not a git repo, never pushed); reads still fall back to the old in-repo
# uploads/ so the images saved there before this change keep resolving
INTERNAL_UPLOADS = HERE.parent / "facilitator-internal" / "uploads"
INTERNAL_UPLOADS.mkdir(parents=True, exist_ok=True)
# everything an image route will hand back, written down once so /uploads/ and
# /laneimg/ can never drift apart on what counts as a picture
IMG_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
PORT = 8877
BG_STALE = 75.0   # seconds without a /ping before a registered job stops counting as green
# seconds a claim may sit unconfirmed before it goes back to the queue. Short on
# purpose: the whole point is that a hand-off lost on the wire comes back while
# the message still matters, not fifteen minutes later
ACK_GRACE = 90.0
OWNERS = ("facilitator", "triage", "qchat")  # qchat: the quick chat panel's lane, dormant in the current board
# the built-in three above are the floor; project lanes stored in state.json
# extend OWNERS at load and at creation, via _register_owner below

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


def _register_owner(ow: str) -> None:
    """A stored or just-created project lane joins the runtime owner set and
    the listener-presence structures; idempotent, so _migrate can re-run it."""
    global OWNERS
    if ow not in OWNERS:
        OWNERS = OWNERS + (ow,)
    _waiters.setdefault(ow, 0)
    _last_wait.setdefault(ow, 0.0)
    _agent_names.setdefault(ow, None)


def _lane_pwds() -> dict:
    """Every lane's folder in one map: the built-in owners sit in this folder,
    run.config.json overrides them, project lanes carry their own stored dir.
    The page reads this as /state's pwds and /laneimg resolves against it, so
    the two can never disagree about where a lane lives."""
    return {**{ow: str(HERE) for ow in OWNERS}, **_LANE_DIRS,
            **{p["id"]: p["dir"] for p in _state.get("projects", [])}}


def _lane_internal(lane: str) -> Path | None:
    """A lane's own internal folder, <lane dir>/<lane id>-internal: where that
    project keeps the files that belong to it and never get pushed. This repo's
    own facilitator-internal/ is already exactly that, one folder up from here.
    None for a lane nobody has heard of."""
    d = _lane_pwds().get(lane)
    return Path(d) / (lane + "-internal") if d else None


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
        # confirmed delivery bookkeeping, one slot per owner beside the claim
        # itself: {box, token, ts, confirmed} for the claim in play, None when
        # the lane holds nothing
        "ack": {ow: None for ow in OWNERS},
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
    # project lanes (2026-08-13): stored lanes merge with the built-in three
    # first, so every per-owner loop below covers them too
    for p in _state.setdefault("projects", []):
        _register_owner(p["id"])
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
    # confirmed delivery (2026-08-25): state written before it existed has no
    # ack map at all, and an empty one reads exactly like no claim in play
    _state.setdefault("ack", {})
    # a third owner appearing in OWNERS gets its claim slots on upgrade
    for slot in ("busy", "claimed", "busy_ts", "ack"):
        if isinstance(_state.get(slot), dict):
            for ow in OWNERS:
                _state[slot].setdefault(ow, [] if slot == "claimed" else (0.0 if slot == "busy_ts" else None))
    if _box("q") is None:  # the quick-chat thread, served by the qchat lane
        _state["boxes"].append({
            "id": "q", "bucket": "meta", "title": "quick chat",
            "reply": "", "pending": [], "done": False, "parked": False, "replies": 0,
            "ball": "you", "ts": time.time(), "owner": "qchat",
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
    # the card state machine (2026-08-26): boxes written before it carry the
    # old scattered flags. bg and bg_ts collapse into hb; a fresh heartbeat
    # keeps its green (deferred if a turn was recorded under the flag), a dead
    # flag hands a recorded turn over now, and everything else lands where it
    # rests. ball_due dies here; ball stays as the machine's turn register
    for b in _state["boxes"]:
        b.setdefault("ball", "you")
        if "state" not in b:
            b["hb"] = b.get("bg_ts", 0) if b.get("bg") else 0
            if _hb_live(b):
                b["state"] = "deferred" if b.get("ball_due") else "working"
            else:
                if b.get("ball_due"):
                    b["ball"] = "you"
                b["state"] = _rest(b)
        b.setdefault("hb", 0)
        for k in ("ball_due", "bg", "bg_ts"):
            b.pop(k, None)
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


# ---- the card's state machine ---------------------------------------------
# One explicit state per box, box["state"], moved only by events; the color is
# a pure read of it (_shown). Three things sit outside the machine and only
# mask that read, each already state of its own: the owner's done and parked
# shelf bits, and the lane's claim slot (busy), all of which show their color
# while the flow keeps moving beneath, so lifting any of them shows exactly
# the card that went in. ball survives as the machine's turn register ("me" =
# the agent owes him, "you" = a reply awaits him): the page reads whose-turn
# off it, so it ships as written, but no color is ever computed from it.
#
# state (color)   new       untouched card (grey; yellow when born his, ball
#                           "you": a seeded or standing card)
#                 queued    a message of his waits on the agent (grey)
#                 working   the flag's heartbeat is beating (green)
#                 deferred  working, plus a reply that becomes his turn the
#                           moment the work ends (green)
#                 yours     an unanswered reply awaits him (yellow)
#                 rest      nothing pending either way (grey)
# event           /send                    -> queued; a beating flag keeps its
#                                          green, and a deferred turn dies:
#                                          he has answered
#                 /reply                   -> yours; flag still beating ->
#                                          deferred; leftover msgs -> queued
#                 /reply quiet=1, /note, /progress   no turn handed over: the
#                                          ball untouched, green stays green
#                 /working v=1, /note, /ping        -> working (deferred stays)
#                 flag drop or 75s expiry  -> deferred hands its turn over and
#                                          lands yours; working lands at _rest
#                 /dismiss                 -> _rest, a beating flag excepted
# _rest, the landing rule: pending -> queued, never touched -> new, ball
# "you" -> yours, else rest. Expiry is swept lazily at /state and /wait,
# beside the unacked-claim clock, and by /working itself.

GREEN = ("working", "deferred")


def _hb_live(b: dict) -> bool:
    """The flag's heartbeat is fresh: hb (0 = no flag registered) was beaten
    within BG_STALE. A registered flag gone quiet greys out but stays
    registered, so a late /ping turns the card green again; only /working
    v=0 unregisters."""
    return (time.time() - b.get("hb", 0)) < BG_STALE


def _green(b: dict) -> None:
    """A beating flag turns the card green; already-green (deferred included)
    stays exactly what it was."""
    if b["state"] not in GREEN:
        b["state"] = "working"


def _rest(b: dict) -> str:
    """Where a card lands when no work holds it green."""
    if b["pending"]:
        return "queued"
    if not b.get("agent_ts", 0) and not b["replies"]:
        return "new"
    return "yours" if b.get("ball", "you") == "you" else "rest"


def _shown(b: dict) -> str:
    """The one value a card's color and sort come from: the masks first (the
    owner's shelf, then the lane's held claim), then the machine state, with
    deferred wearing working's green and rest the queued grey."""
    s = ("done" if b["done"] else "parked" if b.get("parked", False)
         else "working" if _state["busy"].get(b.get("owner", "triage")) == b["id"]
         else b["state"])
    return {"deferred": "working", "rest": "queued"}.get(s, s)


def _handover(b: dict) -> None:
    """A deferred card leaving green: the reply recorded under the flag is
    finally waiting on him, so the turn register flips as the state moves."""
    if b["state"] == "deferred":
        b["ball"] = "you"
        _log("handover", b["id"], "working flag down, deferred turn handed over")


def _release_unacked() -> None:
    """The short clock behind confirmed delivery: a claim whose token never came
    back through /ack went into a dead connection, so after ACK_GRACE the box
    goes back to the FRONT of its lane's queue, the same move the 15 minute
    steal-back makes. The card falls back to the queued grey the moment the
    claim mask lifts: beneath a claim the state is the "queued" his message
    put it in, never yellow.

    Only the claim a token was minted for can be released by it: a record left
    behind by a claim that already ended is stale bookkeeping, not a release.
    Callers hold _lock; this both saves and notifies when it moves anything."""
    now = time.time()
    moved = False
    for ow, rec in list(_state.get("ack", {}).items()):
        if not rec or rec.get("confirmed"):
            continue
        if _state["busy"].get(ow) != rec.get("box") or now - rec.get("ts", 0) <= ACK_GRACE:
            continue
        bid = rec["box"]
        _state["busy"][ow] = None
        _state["claimed"][ow] = []
        _state["ack"][ow] = None
        box = _box(bid)
        if box and box["pending"] and bid not in _state["inbox"]:
            _state["inbox"].insert(0, bid)
        _log("unacked", bid, f"{ow} hand-off unconfirmed after {ACK_GRACE:.0f}s, box re-queued")
        moved = True
    if moved:
        _save()
        _lock.notify_all()


def _sweep() -> None:
    """The lazy clock behind green: a card whose flag heartbeat has gone stale
    leaves the green states, deferred handing its turn over on the way out (a
    claim still held keeps showing green through _shown's mask regardless).
    Runs at /state and /wait, exactly where the ack clock is swept, and inside
    /working itself, so a drop or an expiry lands within about a second.
    Callers hold _lock; this both saves and notifies when it moves anything."""
    moved = False
    for b in _state["boxes"]:
        if b["state"] in GREEN and not _hb_live(b):
            _handover(b)
            b["state"] = _rest(b)
            moved = True
    if moved:
        _save()
        _lock.notify_all()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict | bytes, ctype: str = "application/json") -> bool:
        """True when the response reached the socket, False when the client was
        already gone. Everything that just answers a page ignores the result;
        the /wait hand-off reads it, because a claim written into a dead
        connection has to be rolled back rather than counted as delivered.
        Swallowing the failure here silently was what made that rollback
        unreachable."""
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            # the client hung up mid-response (a timed-out poll, a killed curl):
            # routine here and never a traceback, but the caller has to be able
            # to find out, so it is reported instead of hidden
            return False
        return True

    def _read_body(self) -> str:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n).decode("utf-8", "replace") if n else ""

    # -- GET ------------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/":
            self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif url.path == "/page":
            # the second UI: the same lanes and the same cards drawn as one typed
            # page, in its own file so editing it can never touch the card board
            self._send(200, (HERE / "page.html").read_bytes(), "text/html; charset=utf-8")
        elif url.path == "/state":
            with _lock:
                # the board polls this about once a second, so the 90 second ack
                # clock gets swept even when no /wait is running to sweep it,
                # and an expired working flag drops out of green (handing over
                # a deferred turn) within about that same second
                _release_unacked()
                _sweep()
                self._send(200, self._ui_state())
        elif url.path == "/unread":
            # a lane's unread count in one line, for a Stop hook deciding
            # whether the agent may go idle and for a human checking a lane
            # without reading the whole board. Read only: it claims nothing,
            # releases nothing and sweeps nothing
            q = parse_qs(url.query)
            owner = (q.get("owner") or ["triage"])[0]
            if owner not in OWNERS:
                self._send(400, {"error": "unknown owner"})
                return
            with _lock:
                held = set(_state["claimed"].get(owner) or [])
                # anything not already in the claim is still waiting, including
                # messages that landed on a held card after it was claimed
                queued = sum(1 for b in _state["boxes"]
                             if b.get("owner", "triage") == owner
                             for m in b["pending"] if m["mid"] not in held)
                self._send(200, {"queued": queued, "claimed": len(held)})
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
            # every claim is confirmed delivery, so there is no flag to read; an
            # ack=1 riding along in the query is accepted and ignored, never
            # refused, so a loop that carries the flag keeps working
            self._wait(timeout, owner)
        elif url.path == "/fresh":
            # mid-work delivery: while an agent holds a card, hand over anything
            # that landed on that card after the claim and fold it into the
            # claim, so the one reply covers it and nothing arrives twice
            q = parse_qs(url.query)
            owner = (q.get("owner") or ["triage"])[0]
            if owner not in OWNERS:
                self._send(400, {"error": "unknown owner"})
                return
            with _lock:
                fbid = _state["busy"].get(owner)
                fbox = _box(fbid) if fbid else None
                if fbox is None:
                    self._send(200, {"messages": [], "message_via": []})
                    return
                have = set(_state["claimed"][owner])
                fresh = [m for m in fbox["pending"] if m["mid"] not in have]
                if fresh:
                    _state["claimed"][owner].extend(m["mid"] for m in fresh)
                    _log("fresh", fbid, f"{len(fresh)} mid-work message(s) handed over")
                    _save()
                # the same marker /wait hands over, in the same shape and order:
                # "mini" for the small card, null for the big one. A mini
                # message that lands mid-work becomes the newest claimed one
                # and brings /reply's 100 word cap with it, so an agent that
                # never sees the marker gets its reply refused out of nowhere
                self._send(200, {"box": fbid, "messages": [m["text"] for m in fresh],
                                 "message_via": [m.get("via") for m in fresh]})
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
        elif url.path == "/dirs":
            # the page's folder chooser: one folder's subdirectories, rooted at
            # and fenced to the user's home; hidden folders stay out of sight
            q = parse_qs(url.query)
            home = Path.home()
            raw = (q.get("path") or [""])[0].strip()
            try:
                p = (Path(raw).expanduser() if raw else home).resolve()
            except OSError:
                self._send(400, {"error": "bad path"})
                return
            if p != home and home not in p.parents:
                self._send(400, {"error": "outside the home directory"})
                return
            if not p.is_dir():
                self._send(400, {"error": "not a directory"})
                return
            try:
                subs = sorted((c for c in p.iterdir()
                               if c.is_dir() and not c.name.startswith(".")),
                              key=lambda c: c.name.lower())
            except OSError:
                self._send(400, {"error": "unreadable directory"})
                return
            self._send(200, {"path": str(p),
                             "parent": str(p.parent) if p != home else None,
                             "dirs": [{"name": c.name, "path": str(c)} for c in subs]})
        elif url.path == "/pickdir":
            # tests must never open the dialog: FACILITATOR_PICKDIR_STUB set on
            # the server process answers with its value instead of the chooser
            stub = os.environ.get("FACILITATOR_PICKDIR_STUB")
            if stub:
                self._send(200, {"path": stub})
                return
            try:
                # activate the chooser first so it opens frontmost and its
                # sidebar and search take clicks; restore the prior front app
                # after. (osascript dialogs open unfocused otherwise.)
                r = subprocess.run(
                    ["osascript",
                     "-e", 'tell application "System Events"',
                     "-e", 'set prior to first process whose frontmost is true',
                     "-e", 'activate',
                     "-e", 'set picked to POSIX path of (choose folder with prompt "Open a new folder")',
                     "-e", 'set frontmost of prior to true',
                     "-e", 'return picked',
                     "-e", 'end tell'],
                    capture_output=True, text=True, timeout=300)
            except subprocess.TimeoutExpired:
                # a chooser left unanswered closes with the subprocess; to the
                # page that is the same quiet non-choice as a cancel
                self._send(200, {"cancelled": True})
                return
            except OSError as e:
                self._send(200, {"error": str(e)})
                return
            if r.returncode != 0:
                # the chooser exits nonzero on cancel (-128); anything else
                # nonzero is a real failure and says so
                err = (r.stderr or "").strip()
                if not err or "-128" in err:
                    self._send(200, {"cancelled": True})
                else:
                    self._send(200, {"error": err})
                return
            self._send(200, {"path": r.stdout.strip()})
        elif url.path.startswith("/uploads/"):
            fn = Path(url.path).name  # .name strips any traversal on both paths below
            p = INTERNAL_UPLOADS / fn
            if not p.is_file():
                p = HERE / "uploads" / fn  # fall back to images saved before the move
            if p.is_file() and p.suffix.lower() in IMG_TYPES:
                self._send(200, p.read_bytes(), IMG_TYPES[p.suffix.lower()])
            else:
                self._send(404, {"error": "not found"})
        elif url.path.startswith("/laneimg/"):
            # a picture out of the lane's own internal folder, so an agent
            # working in another project writes next to its own code instead of
            # reaching into this repo. one lane, one plain file name, images only
            lane, _, fn = unquote(url.path[len("/laneimg/"):]).partition("/")
            base = _lane_internal(lane) if lane else None
            # a name with a separator in it is never a file in this folder, and
            # refusing it here kills nested and absolute paths before pathlib
            # gets a chance to be clever about them
            if base is None or not fn or "/" in fn or fn in (".", ".."):
                self._send(404, {"error": "not found"})
                return
            try:
                # resolve both sides and check containment before reading a
                # byte: .. segments and symlinks pointing out of the folder
                # land somewhere that is not under base, and stop right here
                base = base.resolve()
                p = (base / fn).resolve()
                inside = p != base and base in p.parents
            except OSError:
                inside = False   # unreadable or a symlink loop: same as missing
            if inside and p.is_file() and p.suffix.lower() in IMG_TYPES:
                self._send(200, p.read_bytes(), IMG_TYPES[p.suffix.lower()])
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
                    # send times matching pendingTexts one to one; 0 for
                    # entries queued before times were recorded, which the
                    # page shows unstamped
                    "pendingStamps": [m.get("ts", 0) for m in b["pending"]],
                    "ws": b.get("ws"), "task": b.get("task"),
                    "agentTs": b.get("agent_ts", 0),
                    "engine": b.get("engine", "claude"),
                    "writing": st["busy"][b.get("owner", "triage")] == b["id"],
                    # green only while the job's heartbeat is fresh: a job
                    # that stopped pinging cannot keep a card green
                    "bg": _hb_live(b),
                    # the single source of truth for color and sort: the
                    # machine's state through the shelf mask, beside the raw
                    # flags above so the page never has to reconcile them
                    "state": _shown(b),
                    "queuePos": qpos.get(b["id"], 0),
                }
                for b in st["boxes"]
            ],
            "pwd": str(HERE),
            "pwds": _lane_pwds(),
            "projects": st.get("projects", []),
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
                # alive but absent from the listening call for over a minute,
                # holding nothing and with no live job registered: the agent is
                # working off the record and the bar says so
                "offrecord": _waiters[ow] == 0 and st["busy"][ow] is None
                             and 60 < (time.time() - _last_wait[ow]) < 900
                             and not any(
                                 _hb_live(b)
                                 for b in st["boxes"] if b.get("owner", "triage") == ow),
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
                # the short clock first: a hand-off nobody confirmed comes back
                # after 90 seconds, long before the steal-back below notices
                _release_unacked()
                # and a working flag that stopped pinging drops its card out of
                # green, handing over a turn deferred under it
                _sweep()
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
                        # every claim is provisional: the token below is what
                        # POST /ack has to name, and until it does this claim is
                        # on the 90 second clock. A lane holds one claim, so one
                        # record per lane says everything about it
                        token = secrets.token_hex(6)
                        _state["ack"][owner] = {"box": bid, "token": token,
                                                "ts": time.time(), "confirmed": False}
                        _save()
                        payload = {
                            "box": bid, "title": box["title"],
                            "messages": [m["text"] for m in box["pending"]],
                            # where each message was typed, one entry per
                            # message in the same order: "mini" for the small
                            # card, null for the big one. It rides beside
                            # messages instead of inside it because agent
                            # loops elsewhere read messages as plain strings
                            "message_via": [m.get("via") for m in box["pending"]],
                            "queued_after": sum(1 for i in _state["inbox"]
                                                if (_box(i) or {}).get("owner", "triage") == owner),
                            # the receipt this hand-off has to come back with
                            "ack": token,
                        }
                        if not self._send(200, payload):
                            # listener died mid-handoff: roll the claim back so
                            # the message is never stranded on a dead connection.
                            # It fires now that _send reports the failure
                            _state["busy"][owner] = None
                            _state["claimed"][owner] = []
                            _state["ack"][owner] = None
                            if bid not in _state["inbox"]:
                                _state["inbox"].insert(0, bid)
                            _log("dropped", bid, f"{owner} hand-off died on the wire, box re-queued")
                            _save()
                            _lock.notify_all()
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
            up = INTERNAL_UPLOADS  # new uploads land outside the repo
            up.mkdir(parents=True, exist_ok=True)
            fname = f"{int(time.time() * 1000)}-{safe}"
            (up / fname).write_bytes(raw)
            self._send(200, {"url": "/uploads/" + fname})  # URL unchanged; page needs no change
            return

        text = self._read_body().strip()

        with _lock:
            if url.path == "/send":
                box = _box(bid)
                if box is None or not text:
                    self._send(400, {"error": "bad box or empty text"})
                    return
                msg = {"mid": _state["next_mid"], "text": text, "ts": time.time()}
                # where he typed it: via=mini means the small card in the corner.
                # Only that literal is kept, so a caller that passes nothing (the
                # big card, any older sender) stores exactly what it always did
                if (q.get("via") or [""])[0] == "mini":
                    msg["via"] = "mini"
                box["pending"].append(msg)
                box["ball"] = "me"  # his message sent: the ball is in the agent's court
                # his message queues the card; a beating flag keeps its green,
                # and a deferred turn dies here, since he has read and
                # answered: it must not resurface when the flag goes down
                box["state"] = "working" if _hb_live(box) else "queued"
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

            elif url.path == "/ack":
                # the other half of the hand-off: the token /wait handed out
                # comes back here and the provisional claim becomes a real one.
                # Nothing else about the claim changes, so a confirmed claim is
                # exactly what /fresh, /reply and the steal-back always saw
                ow = (q.get("owner") or ["triage"])[0]
                if ow not in OWNERS:
                    self._send(400, {"error": "unknown owner"})
                    return
                token = (q.get("token") or [""])[0]
                rec = _state.get("ack", {}).get(ow)
                if not token or not rec or rec.get("token") != token:
                    self._send(409, {"error": "unknown or stale token"})
                    return
                if rec.get("confirmed"):
                    # idempotent: a resent ack is the same ack, never a 409
                    self._send(200, {"ok": True, "box": rec["box"]})
                    return
                if _state["busy"].get(ow) != rec.get("box"):
                    # the claim this token names is already over: released by
                    # the 90 second clock, stolen back, replied to or dismissed
                    self._send(409, {"error": "claim no longer held"})
                    return
                rec["confirmed"] = True
                _log("ack", rec["box"], f"{ow} confirmed delivery")
                _save()
                self._send(200, {"ok": True, "box": rec["box"]})

            elif url.path == "/reply":
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                # the summary strip is optional as of 20260821: the owner had
                # the summary box taken off the card, so nothing displays it and
                # the agent no longer writes one. a ctx that is passed is still
                # stored and still size checked, so older callers keep working
                ctx = (q.get("ctx") or [""])[0].strip()
                if ctx and len(ctx.split()) > 50:
                    # refused outright, never silently chopped
                    self._send(400, {"error": "context strip over 50 words"})
                    return
                ow = box.get("owner", "triage")
                # a message typed in the small card gets a small answer back:
                # that card is a few lines tall and a long reply is unreadable
                # in it. The newest message the claim covers is the one being
                # answered, so that one decides. Refused outright like the
                # context strip above, never silently chopped
                held = _state["claimed"][ow] if _state["busy"][ow] == bid else []
                answering = next((m for m in box["pending"] if m["mid"] == held[-1]), None) if held else None
                if answering is not None and answering.get("via") == "mini":
                    words = len(text.split())
                    if words > 100:
                        self._send(400, {"error": f"small card reply over 100 words: {words} words"})
                        return
                _last_wait[ow] = time.time()  # a reply proves that agent is alive too
                box["reply"] = text
                box["replies"] += 1
                # the machine's answer move, taken once the claim is let go
                # below: a quiet reply stores everything and moves nothing, so
                # the color keeps coming from the work itself. A normal reply
                # hands the turn over, but only when no working flag beats on
                # the box: while one does, nothing awaits him yet, so the card
                # goes deferred and the turn is handed over when that flag
                # drops or its heartbeat expires.
                quiet = (q.get("quiet") or ["0"])[0] == "1"
                box["agent_ts"] = time.time()  # when the agent last replied
                box["ts"] = time.time()
                claimed = set(_state["claimed"][ow]) if _state["busy"][ow] == bid else set()
                box["pending"] = [m for m in box["pending"] if m["mid"] not in claimed]
                if ctx:
                    box["context"] = ctx
                if _state["busy"][ow] == bid:
                    _state["busy"][ow] = None
                    _state["claimed"][ow] = []
                if _hb_live(box):
                    if not quiet:
                        box["state"] = "deferred"
                else:
                    if not quiet:
                        box["ball"] = "you"
                    box["state"] = _rest(box)
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

            elif url.path == "/note":
                # the formalized interim-note action. Stores the body and the
                # ctx summary exactly like /reply (reply, replies, agent_ts,
                # ts, context) AND moves the card to working (the flag's
                # heartbeat), never setting ball="you". So the state is a green
                # "working", never a yellow "yours": a progress note
                # structurally cannot turn a card yellow or float it to the top.
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                ctx = (q.get("ctx") or [""])[0].strip()
                if ctx and len(ctx.split()) > 50:
                    self._send(400, {"error": "context strip over 50 words"})
                    return
                ow = box.get("owner", "triage")
                _last_wait[ow] = time.time()  # a note proves that agent is alive too
                box["reply"] = text
                box["replies"] += 1
                box["agent_ts"] = time.time()
                box["ts"] = time.time()
                if ctx:
                    box["context"] = ctx
                box["hb"] = time.time()  # green via the heartbeat path: no
                _green(box)              # claim taken, and the ball untouched
                _log("note", bid, text)
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
                # a job runs behind this card: green without a claim, so the
                # lane stays free. Registration starts a heartbeat clock; the
                # job (or agent) must /ping while it runs, or green expires.
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                box["hb"] = time.time() if (q.get("v") or ["1"])[0] == "1" else 0
                if box["hb"]:
                    _green(box)
                # v=0 is one of the two ways out of green, so the sweep runs
                # right here and a deferred turn is handed over at once. v=1
                # re-registers and the flag beats again, so a deferred card
                # just keeps waiting, which is what re-registering should mean
                _sweep()
                _log("working" if box["hb"] else "workdone", bid, "")
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/ping":
                # heartbeat for a registered job; keeps the card's green alive
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                if box.get("hb"):
                    box["hb"] = time.time()
                    _green(box)  # a registered job beating again takes back its green
                self._send(200, {"ok": True, "bg": bool(box.get("hb"))})

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
                if len(text.split()) > 50:
                    self._send(400, {"error": "context strip over 50 words"})
                    return
                box["context"] = text  # agent-maintained; refused over 50 words
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
                    "state": "new", "hb": 0,
                    "ball": "me", "ts": time.time(), "owner": owner,
                    "ws": ws0, "task": None, "agent_ts": 0,
                })
                _log("create", bid_new, title)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "id": bid_new})

            elif url.path == "/project":
                # a new project lane from the page's plus tab: slug the name,
                # store {id, name, dir} so restarts keep it, give the lane its
                # per-owner slots; the tab appears with an empty board
                name = (q.get("name") or [""])[0].strip()
                slug = "".join(c if c.isalnum() else "-" for c in name.lower())
                while "--" in slug:
                    slug = slug.replace("--", "-")
                slug = slug.strip("-")
                if not name or not slug:
                    self._send(400, {"error": "empty name"})
                    return
                # a taken id walks numbered suffixes until free; built-in owner
                # ids (hidden internal lanes included) and stored project ids
                # both count as taken, so no folder name is ever refused for
                # colliding with a lane the page never shows
                taken = set(OWNERS) | {p["id"] for p in _state.get("projects", [])}
                if slug in taken:
                    n = 2
                    while f"{slug}-{n}" in taken:
                        n += 1
                    slug = f"{slug}-{n}"
                home = Path.home()
                try:
                    d = Path(text).expanduser().resolve() if text else None
                except OSError:
                    d = None
                if d is None or not d.is_dir() or (d != home and home not in d.parents):
                    self._send(400, {"error": "body must be a folder under home"})
                    return
                _state.setdefault("projects", []).append({"id": slug, "name": name, "dir": str(d)})
                _register_owner(slug)
                _state["busy"].setdefault(slug, None)
                _state["claimed"].setdefault(slug, [])
                _state["busy_ts"].setdefault(slug, 0.0)
                _state.setdefault("ack", {}).setdefault(slug, None)
                _state.setdefault("workspaces", {})[slug] = [{
                    "id": "w1", "name": "main", "started": time.time(),
                    "goal": "", "tasks": [], "current": None}]
                # no card is created with the lane: a fresh folder opens onto
                # an empty board and cards come only from the owner's hand
                _log("project", slug, f"{name} -> {d}")
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "id": slug, "name": name, "dir": str(d)})

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
                if bid in _state["inbox"]:
                    _state["inbox"].remove(bid)
                ow = box.get("owner", "triage")
                if _state["busy"].get(ow) == bid:
                    _state["busy"][ow] = None
                    _state["claimed"][ow] = []
                # a beating flag keeps its green through a dismissal; anything
                # else lands where the card rests, an unanswered reply beneath
                # the dropped queue showing again
                if not _hb_live(box):
                    _handover(box)
                    box["state"] = _rest(box)
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
        _state["ack"] = {ow: None for ow in OWNERS}   # and no token outlives it
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
