"""The owner's own servers: the agent door they connect out to, the keys that
let an agent on one reach its own lane, and the board's side of each
server's link.

Nothing here logs in to a server, and nothing here runs anything on one. A
server is paired from the server itself: the owner, logged in there by hand,
runs the line `facilitator remote pair` prints on the Mac. It fetches the
setup program from the door (GET /remote/setup), asks for the pairing code at
the terminal and trades it for the server's own key (POST /remote/pair),
which also hands it the skill, the runbook and the docs. From then on the
server's link (scripts/link.py in the skill, a process of the owner's account
there) connects out to the door and holds a short poll (POST /remote/link):
the board hands it the folder picker's questions about that server on one
poll and takes the answers on the next. The link answers three questions and
no others: a folder's subfolders, a new folder, and a folder's real path with
its repository, all fenced to the account's home. Agents there join their
project with the server's key (POST /remote/join), which gives each one a key
of its own for its lane, and then work that lane's cards through the door.

The door is a listener bound only to this Mac's own Tailscale addresses
(tailnet_addresses, listen_door), so only machines on the owner's tailnet can
reach it, never the open internet, and the tailnet's own access rules can
narrow that to the servers. BoardProtocol marks every connection on it with
SERVER_MARK, an address no request on the board's own ports can carry, so a
server's request is never taken for a page or an agent on this Mac, and
RemoteGate decides every one of them. The Mac keeps the keys' SHA-256 and
never the keys, and a pairing code only while it lasts, as its SHA-256 too;
nothing here writes a key, a code or an address to a log, a card, a URL or a
command line.

Standard library only, and Python 3.9, since the facilitator command imports
it on the python3 macOS ships."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs

FADE_AFTER = 30.0              # seconds a server goes unheard before its projects fade
HOLD = 10.0                    # seconds the board holds one poll of a server's link
GRACE = 5.0                    # seconds from one poll's end to the next's start
ASK_TIMEOUT = 10.0             # seconds the board waits for a server's answer
ASKS_MAX = 8                   # questions one poll takes away
WAITING_MAX = 32               # questions one server may have waiting at once
DOOR_PORT = 8870               # the agent door's port, unless run.config.json says agent_port
DOOR_LOOK = 30.0               # seconds between looks at this Mac's tailnet addresses
FORGOT_OPEN = 120.0            # seconds the door stays open after the last server is forgotten
CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"   # no 0, 1, I or O to misread
CODE_LENGTH = 12
CODE_LIFE = 600.0              # seconds a pairing code lasts
CODES_HELD = 8                 # pairing codes waiting at once; the oldest goes first
PAIR_TRIES = 10                # wrong codes in a minute before pairing shuts for the rest of it
JOIN_BODY_MAX = 4096           # bytes of a join's body
PAIR_BODY_MAX = 4096           # bytes of a pairing's body
POLL_BODY_MAX = 4 * 1024 * 1024   # bytes of a poll's answers
PLACE_MAX = 1024               # characters in a server's home as its record keeps it
PATH_MAX = 4096                # characters in a path a server answers
NAME_MAX = 64                  # characters in a server's name
ROWS_MAX = 2000                # folders one listing from a server may name
LANE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,99}")
HEX64 = re.compile(r"[0-9a-f]{64}")
# Tailscale gives each machine one address from each of these and no others
TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")
TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")
# the address a request on the door carries in place of the board's own: it
# came from a machine on the tailnet, and from nowhere else
SERVER_MARK = ("facilitator-remote", 0)
# the setup program the door hands out, and what goes on a server with the key
SETUP = ".agents/skills/facilitator/scripts/pair.py"
BUNDLE = (".agents/skills/facilitator/SKILL.md", ".agents/skills/facilitator/scripts/onboard.py",
          ".agents/skills/facilitator/scripts/link.py", SETUP, "app/RUNBOOK.md")
# the three questions a server's link answers
OPS = frozenset({"dirs", "mkdir", "describe"})

# what an agent on a server may ask with its lane's key, and how the lane it
# names is read: from owner=, from the card box= names, or the key's own lane.
# /note and /progress only answer that they were removed and change nothing;
# they are still let through so a stale agent on a server reads that answer,
# which says what to do instead, rather than this door's bare refusal. The
# magic box is filled, closed, reopened and read back on the lane's own cards
# as on the Mac; its body goes to its route unread here, so the route's own
# limits and refusals answer it, and what the page reads (/magic/body,
# /magic/img) stays the Mac's
AGENT_ROUTES = {
    ("GET", "/wait"): "owner", ("POST", "/ack"): "owner", ("GET", "/fresh"): "owner",
    ("GET", "/unread"): "owner", ("POST", "/create"): "owner",
    ("POST", "/reply"): "box", ("POST", "/note"): "box", ("POST", "/working"): "box",
    ("POST", "/ping"): "box", ("POST", "/title"): "box", ("POST", "/testing"): "box",
    ("POST", "/park"): "box", ("POST", "/progress"): "box", ("POST", "/context"): "box",
    ("POST", "/magic"): "box", ("POST", "/magic/close"): "box", ("POST", "/magic/reopen"): "box",
    ("GET", "/magic"): "box",
    ("GET", "/remote/lane"): "lane",
}
# the door's own routes, which the gate answers itself
DOOR_ROUTES = frozenset({"/remote/setup", "/remote/pair", "/remote/link", "/remote/join"})
KNOWN_ROUTES = frozenset(route for _, route in AGENT_ROUTES) | DOOR_ROUTES


# ---- names and keys ---------------------------------------------------------------

def slug(text: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in text.lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def new_key() -> str:
    return secrets.token_urlsafe(32)


def digest(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8", "replace")).hexdigest()


def short(text: str) -> str:
    """A server's id as a log line may carry it: a short hash, so lines about
    one server can be told apart without a machine's name in the file."""
    return hashlib.sha256(text.encode()).hexdigest()[:6]


def new_code() -> str:
    """A pairing code as the owner reads it, in groups of four."""
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    return "-".join(raw[i:i + 4] for i in range(0, CODE_LENGTH, 4))


def code_digest(typed: str) -> str:
    """The same code however it was typed: dashes, spaces and case aside."""
    return digest("".join(c for c in (typed or "").upper() if c.isalnum()))


def _place(text) -> bool:
    return (isinstance(text, str) and text.startswith("/") and len(text) <= PLACE_MAX
            and not any(ord(c) < 32 for c in text))


# ---- the door's addresses -------------------------------------------------------------

def on_tailnet(text) -> bool:
    """Whether an address is one Tailscale hands out, IPv4 or IPv6."""
    try:
        a = ipaddress.ip_address(str(text).split("%", 1)[0])
    except ValueError:
        return False
    if a.version == 6 and a.ipv4_mapped is not None:
        a = a.ipv4_mapped
    return a in TAILNET_V4 if a.version == 4 else a in TAILNET_V6


def is_loopback(text) -> bool:
    try:
        a = ipaddress.ip_address(str(text).split("%", 1)[0])
    except ValueError:
        return False
    if a.version == 6 and a.ipv4_mapped is not None:
        a = a.ipv4_mapped
    return a.is_loopback


def tailnet_addresses(status) -> list:
    """This Mac's own tailnet addresses from `tailscale status --json`, while
    Tailscale runs, and nothing else: an address outside Tailscale's ranges
    is left out whatever the status says."""
    if not isinstance(status, dict) or status.get("BackendState") != "Running":
        return []
    me = status.get("Self")
    found = me.get("TailscaleIPs") if isinstance(me, dict) else None
    if not isinstance(found, list):
        found = status.get("TailscaleIPs")
    out = set()
    for text in found if isinstance(found, list) else ():
        if isinstance(text, str) and on_tailnet(text):
            out.add(str(ipaddress.ip_address(text)))
    return sorted(out)


def door_peer_ok(peer, loopback: bool = False) -> bool:
    """Whether a connection on the door may be read at all: a machine on the
    tailnet, or this Mac itself when the door is on loopback for a test."""
    if peer is None:
        return False
    return on_tailnet(peer) or (loopback and is_loopback(peer))


def listen_door(address: str, port: int, loopback: bool = False) -> socket.socket:
    """One of the door's listening sockets, on exactly this address. Refuses
    every address that is not this Mac's on the tailnet: the wildcard, a
    network the Mac is on, anything a mistake could put here. Loopback only
    for a test board."""
    if not (on_tailnet(address) or (loopback and is_loopback(address))):
        raise ValueError("the agent door listens on tailnet addresses only")
    a = ipaddress.ip_address(address)
    sock = socket.socket(socket.AF_INET6 if a.version == 6 else socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if a.version == 6:
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        sock.bind((str(a), port))
        sock.listen(128)
    except OSError:
        sock.close()
        raise
    return sock


class Door:
    """Where the door listens: this Mac's tailnet addresses as Tailscale says
    them now, or loopback alone for a test board, and only while it is needed,
    which is while a server is paired or a pairing code waits: a board that
    keeps no servers listens on no tailnet address at all. server.py keeps the
    sockets on its loop and asks wanted() off it every DOOR_LOOK seconds, or
    at once after poke(), so Tailscale coming up after the board, a new
    address or a first pairing needs no restart. None from wanted() means the
    status could not be read, and what is open stays."""

    def __init__(self, port: int, read_status=None, loopback: bool = False, needed=None):
        self.port = port
        self.read_status = read_status or (lambda: None)
        self.loopback = loopback
        self.needed = needed or (lambda: True)
        self.open: list = []          # the addresses held now, for /remote/servers
        self._wake = None             # (loop, event) of the task keeping the sockets

    def wanted(self):
        if not self.needed():
            return []
        if self.loopback:
            return ["127.0.0.1"]
        status = self.read_status()
        if status is None:
            return None
        return tailnet_addresses(status)

    def poke(self) -> None:
        """Look again now, from any thread."""
        held = self._wake
        if held is not None:
            loop, event = held
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:
                pass

    def wait_open(self, seconds: float) -> list:
        """The addresses open, once there are some or the time is up."""
        ends = time.monotonic() + seconds
        while not self.open and time.monotonic() < ends:
            time.sleep(0.1)
        return list(self.open)


# ---- files on this Mac --------------------------------------------------------------

def _write_private(path: Path, text: str) -> None:
    """Written whole or not at all, for the owner alone."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.stat().st_mode & 0o077:
        os.chmod(path.parent, 0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Store:
    """data/remote/: servers.json, the servers paired with this board, each
    {id, name, home, top, key, added, paired}, with home the account's home
    there as the server named it, top the same with its links followed, and
    key the SHA-256 of the server's own key; and keys.json, {lanes: {lane:
    {hash, server, ts}}}, the one agent key each server lane has, by its
    SHA-256. Both for the owner alone."""

    def __init__(self, data: Path):
        self.dir = Path(data) / "remote"
        self.servers_file = self.dir / "servers.json"
        self.keys_file = self.dir / "keys.json"

    def servers(self) -> list:
        try:
            raw = json.loads(self.servers_file.read_text())
        except (OSError, ValueError):
            return []
        out = []
        for rec in raw.get("servers", []) if isinstance(raw, dict) else []:
            if (isinstance(rec, dict) and isinstance(rec.get("id"), str) and LANE_ID.fullmatch(rec["id"])
                    and isinstance(rec.get("name"), str) and 0 < len(rec["name"]) <= NAME_MAX
                    and _place(rec.get("home")) and _place(rec.get("top"))
                    and isinstance(rec.get("key"), str) and HEX64.fullmatch(rec["key"])):
                out.append(rec)
        return out

    def save_servers(self, servers: list) -> None:
        _write_private(self.servers_file, json.dumps({"servers": servers}, indent=1) + "\n")

    def keys(self) -> dict:
        try:
            raw = json.loads(self.keys_file.read_text())
        except (OSError, ValueError):
            return {}
        lanes = raw.get("lanes") if isinstance(raw, dict) else None
        return {k: v for k, v in (lanes or {}).items()
                if isinstance(v, dict) and isinstance(v.get("hash"), str) and isinstance(v.get("server"), str)}

    def save_keys(self, lanes: dict) -> None:
        _write_private(self.keys_file, json.dumps({"lanes": lanes}, indent=1) + "\n")


def bundle(clone: Path) -> dict:
    """The skill's files as the setup program writes them on a server,
    {path in the checkout: [text, mode]}, with the docs."""
    files = {}
    names = list(BUNDLE) + sorted("docs/" + p.name for p in (Path(clone) / "docs").glob("*.md"))
    for rel in names:
        text = (Path(clone) / rel).read_text(encoding="utf-8")
        files[rel] = [text, 0o700 if rel.endswith(".py") else 0o600]
    return files


# ---- what a server answers, checked before the picker sees it -------------------------

def _text(value, cap=PATH_MAX) -> bool:
    return isinstance(value, str) and len(value) <= cap and "\x00" not in value


def _count(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10 ** 9


def clean_listing(answer):
    """A server's folder listing in exactly the picker's shape, or None. A
    server may say only names and paths, times and counts, so nothing else
    it sends reaches a page."""
    if not isinstance(answer, dict):
        return None
    out = {}
    for key in ("path", "name", "short", "top"):
        if not _text(answer.get(key)):
            return None
        out[key] = answer[key]
    parent = answer.get("parent")
    if parent is not None and not _text(parent):
        return None
    out["parent"] = parent
    trail, dirs = answer.get("trail"), answer.get("dirs")
    if not isinstance(trail, list) or len(trail) > 512 or not isinstance(dirs, list) or len(dirs) > ROWS_MAX:
        return None
    out["trail"] = []
    for step in trail:
        if not isinstance(step, dict) or not _text(step.get("name")) or not _text(step.get("path")):
            return None
        out["trail"].append({"name": step["name"], "path": step["path"]})
    out["dirs"] = []
    for row in dirs:
        if not isinstance(row, dict) or not _text(row.get("name")) or not _text(row.get("path")):
            return None
        modified, items = row.get("modified"), row.get("items")
        if not isinstance(modified, (int, float)) or isinstance(modified, bool):
            return None
        if items is not None and not _count(items):
            return None
        kept = {"name": row["name"], "path": row["path"], "modified": modified, "items": items}
        if row.get("itemsCut") is True:
            kept["itemsCut"] = True
        out["dirs"].append(kept)
    more = answer.get("more", 0)
    if not _count(more):
        return None
    out["more"] = more
    out["cut"] = answer.get("cut") is True
    out["unreadable"] = answer.get("unreadable") is True
    return out


def clean_made(answer):
    if not isinstance(answer, dict) or answer.get("ok") is not True:
        return None
    if not _text(answer.get("name"), 1024) or not _text(answer.get("path")):
        return None
    return {"ok": True, "name": answer["name"], "path": answer["path"]}


def clean_described(answer):
    if not isinstance(answer, dict) or not _text(answer.get("path")) or not answer["path"].startswith("/"):
        return None
    if not _text(answer.get("name"), 1024):
        return None
    git = answer.get("git")
    if git is not None and (not _text(git) or not git.startswith("/")):
        return None
    return {"path": answer["path"], "name": answer["name"], "git": git}


# ---- one server, as the board sees it ---------------------------------------------------

class Channel:
    """One server's link as the board sees it: the polls it holds open now,
    when it was last heard from, the questions waiting for it, and the
    answers awaited. Up while a poll is held or one ended under GRACE
    seconds ago; faded once it has gone unheard FADE_AFTER seconds. Its
    fields are Remote's, under Remote's lock."""

    def __init__(self, rec: dict, since: float):
        self.rec = rec
        self.held = 0
        self.seen = since      # last heard from, or the board's start before that
        self.heard = False
        self.shown = None      # up as last written to the log
        self.asks: list = []
        self.waiting: dict = {}
        self.wakers: set = set()
        self.count = 0

    def up(self, now: float) -> bool:
        return self.held > 0 or (self.heard and now - self.seen < GRACE)

    def state(self, now: float) -> dict:
        up = self.up(now)
        return {"name": self.rec["name"], "up": up, "faded": (not up) and now - self.seen >= FADE_AFTER}


class Remote:
    """The board's servers: their records, their channels, the pairing codes
    waiting, the agents' keys, and the questions the board asks a server's
    link. One per board, made at its start; the gate and the routes ask it."""

    def __init__(self, data: Path, clone: Path | None = None, note=None):
        self.data = Path(data)
        self.clone = Path(clone) if clone is not None else self.data.parent
        self.store = Store(self.data)
        self.note = note or (lambda *a, **k: None)
        self.started = time.time()
        self.records: dict = {}
        self.channels: dict = {}
        self._codes: dict = {}         # code digest -> {name, ends}
        self._wrong: list = []         # when each wrong code of the last minute came
        self._forgot_until = 0.0       # the door stays open for a forgotten server's link till then
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self._keys = self.store.keys()

    # -- the servers
    def reload(self) -> list:
        """Read servers.json again: a new server gets its channel, a removed
        one's goes with its lanes' keys. Answers the server ids known."""
        records = {rec["id"]: rec for rec in self.store.servers()}
        with self._lock:
            self.records = records
            for sid in [sid for sid in self.channels if sid not in records]:
                self._end(self.channels.pop(sid), "this server was removed")
            for sid, rec in records.items():
                if sid in self.channels:
                    self.channels[sid].rec = rec
                else:
                    self.channels[sid] = Channel(rec, self.started)
            stale = [lane for lane, v in self._keys.items() if v["server"] not in records]
            for lane in stale:
                del self._keys[lane]
            if stale:
                self.store.save_keys(self._keys)
        return sorted(records)

    def stop(self) -> None:
        """The board is stopping: every poll goes home and every question
        waiting is answered."""
        self._stopping.set()
        with self._lock:
            for ch in self.channels.values():
                self._end(ch, "the board is stopping")

    def _end(self, ch: Channel, why: str) -> None:
        """Callers hold the lock."""
        for slot in ch.waiting.values():
            slot["answer"] = (400, {"error": why})
            slot["done"].set()
        ch.waiting.clear()
        ch.asks.clear()
        self._wake(ch)

    @staticmethod
    def _wake(ch: Channel) -> None:
        for loop, ev in list(ch.wakers):
            try:
                loop.call_soon_threadsafe(ev.set)
            except RuntimeError:
                pass   # that loop has closed: nobody there to wake

    def server(self, sid: str):
        with self._lock:
            return self.records.get(sid)

    def is_up(self, sid: str) -> bool:
        with self._lock:
            ch = self.channels.get(sid)
            return bool(ch and ch.up(time.time()))

    def status(self, now: float | None = None) -> dict:
        """{id: {name, up, faded}} for every server, what the pages draw. A
        change of up is written to the log here, where it is first seen."""
        now = time.time() if now is None else now
        flips = []
        with self._lock:
            out = {}
            for sid, ch in self.channels.items():
                out[sid] = ch.state(now)
                if ch.shown is not None and ch.shown != out[sid]["up"]:
                    flips.append((sid, out[sid]["up"]))
                ch.shown = out[sid]["up"]
        for sid, up in flips:
            self.note("remotelink", server=short(sid), up=up)
        return out

    def listing(self, now: float | None = None) -> list:
        """The servers for `facilitator remote list`: never a key or its hash."""
        now = time.time() if now is None else now
        shown = self.status(now)
        with self._lock:
            return [{"id": sid, "name": ch.rec["name"], "up": shown[sid]["up"], "faded": shown[sid]["faded"],
                     "heard": round(ch.seen) if ch.heard else None, "paired": ch.rec.get("paired")}
                    for sid, ch in sorted(self.channels.items())]

    def machines(self) -> list:
        """Each server as the folder picker's /machines lists a machine."""
        now = time.time()
        with self._lock:
            channels = sorted(self.channels.items())
            out = []
            for sid, ch in channels:
                # the real home, as the link names its paths
                home = ch.rec.get("top") or ch.rec["home"]
                out.append({"id": sid, "name": ch.rec["name"], "kind": "server", "online": ch.up(now),
                            "top": home, "home": home, "sep": "/",
                            "places": [{"id": "home", "name": home.rstrip("/").rsplit("/", 1)[-1] or home,
                                        "path": home}]})
        return out

    def forget_server(self, sid: str) -> bool:
        """The server off this board: its record, its lanes' keys and its
        channel. Its own files on the server stay for the owner to remove."""
        servers = self.store.servers()
        if not any(s["id"] == sid for s in servers):
            return False
        self.store.save_servers([s for s in servers if s["id"] != sid])
        with self._lock:
            self._forgot_until = time.monotonic() + FORGOT_OPEN
        self.reload()
        self.note("remoteforgot", server=short(sid))
        return True

    def needs_door(self) -> bool:
        """Whether the agent door should listen: a server is paired, a
        pairing code is waiting for one, or a server was forgotten under
        FORGOT_OPEN seconds ago, so its link hears it is refused and stops."""
        now = time.monotonic()
        with self._lock:
            return (bool(self.records) or any(c["ends"] > now for c in self._codes.values())
                    or now < self._forgot_until)

    # -- pairing
    def new_code(self, name: str | None = None) -> str:
        """A pairing code for one server, good once for CODE_LIFE seconds,
        named for the server it will pair when the owner chose a name."""
        code = new_code()
        name = "".join(c for c in (name or "") if c.isprintable()).strip()[:NAME_MAX] or None
        now = time.monotonic()
        with self._lock:
            self._codes = {h: c for h, c in self._codes.items() if c["ends"] > now}
            while len(self._codes) >= CODES_HELD:
                del self._codes[min(self._codes, key=lambda h: self._codes[h]["ends"])]
            self._codes[code_digest(code)] = {"name": name, "ends": now + CODE_LIFE}
        return code

    def pair(self, typed: str, asked) -> tuple:
        """A server trading a pairing code for its own key: (200, {server,
        name, key, files}), or a refusal in plain words. The code goes with
        its first right use; a wrong one counts towards PAIR_TRIES."""
        if not isinstance(asked, dict):
            return 400, {"error": "a pairing names the server's home"}
        home, top = asked.get("home"), asked.get("top")
        host = asked.get("host") if isinstance(asked.get("host"), str) else ""
        if not _place(home) or not _place(top):
            return 400, {"error": "a pairing names the server's home"}
        now = time.monotonic()
        with self._lock:
            self._wrong = [t for t in self._wrong if now - t < 60]
            if len(self._wrong) >= PAIR_TRIES:
                return 429, {"error": "too many wrong codes: wait a minute, then try again"}
            self._codes = {h: c for h, c in self._codes.items() if c["ends"] > now}
            entry = self._codes.pop(code_digest(typed), None) if typed else None
            if entry is None:
                self._wrong.append(now)
                return 401, {"error": "that code is not known or has run out: "
                                      "run facilitator remote pair on the Mac for a new one"}
        name = (entry["name"] or "".join(c for c in host if c.isprintable()).strip() or "server")[:NAME_MAX]
        key = new_key()
        with self._lock:
            servers = self.store.servers()
            same = next((s for s in servers if s["name"].casefold() == name.casefold()), None)
            if same is not None:
                sid = same["id"]
            else:
                base, taken = slug(name) or "server", {s["id"] for s in servers}
                sid, n = base[:90], 2
                while sid in taken:
                    sid, n = f"{base[:90]}-{n}", n + 1
            rec = {"id": sid, "name": name, "home": home.rstrip("/") or "/", "top": top.rstrip("/") or "/",
                   "key": digest(key), "added": (same or {}).get("added") or round(time.time()),
                   "paired": round(time.time())}
            self.store.save_servers([s for s in servers if s["id"] != sid] + [rec])
        self.reload()
        self.note("remotepaired", server=short(sid), again=same is not None)
        return 200, {"server": sid, "name": name, "key": key, "files": bundle(self.clone)}

    def setup_program(self) -> bytes:
        return (self.clone / SETUP).read_bytes()

    # -- the link
    def server_of_key(self, key: str):
        """The server whose own key this is, or None."""
        if not key:
            return None
        h = digest(key)
        with self._lock:
            records = list(self.records.values())
        for rec in records:
            if hmac.compare_digest(rec["key"], h):
                return rec
        return None

    @staticmethod
    def _deliver(ch: Channel, answers) -> None:
        """A poll's answers to the questions they name, which must be this
        server's own. Callers hold the lock."""
        for item in answers[:WAITING_MAX] if isinstance(answers, list) else ():
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            slot = ch.waiting.get(item["id"])
            if slot is None or slot["done"].is_set():
                continue
            if isinstance(item.get("error"), str):
                slot["answer"] = (400, {"error": item["error"][:200]})
            else:
                slot["answer"] = (200, item.get("answer"))
            slot["done"].set()

    async def poll(self, sid: str, answers, gone: asyncio.Event, hold: float = HOLD):
        """One poll of a server's link, on the board's loop: its answers are
        handed in, then it waits up to hold seconds for questions and takes
        away up to ASKS_MAX of them. Answers the questions, [] when none
        came, or None for a server the board does not know."""
        loop = asyncio.get_running_loop()
        ev = asyncio.Event()
        with self._lock:
            ch = self.channels.get(sid)
            if ch is None:
                return None
            self._deliver(ch, answers)
            ch.held += 1
            ch.seen = time.time()
            ch.heard = True
            ch.wakers.add((loop, ev))
        try:
            ends = loop.time() + max(0.0, min(hold, HOLD))
            while True:
                with self._lock:
                    # cleared under the lock, before the look: a question that
                    # lands after the look wakes this, one before it is seen
                    ev.clear()
                    if ch.asks:
                        taken, ch.asks = ch.asks[:ASKS_MAX], ch.asks[ASKS_MAX:]
                        return taken
                left = ends - loop.time()
                if left <= 0 or gone.is_set() or self._stopping.is_set():
                    return []
                waits = [asyncio.ensure_future(ev.wait()), asyncio.ensure_future(gone.wait())]
                try:
                    await asyncio.wait(waits, timeout=left, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for w in waits:
                        w.cancel()
        finally:
            with self._lock:
                ch.held -= 1
                ch.seen = time.time()
                ch.wakers.discard((loop, ev))

    def ask(self, sid: str, op: str, *args, timeout: float = ASK_TIMEOUT) -> tuple:
        """One question for a server's link, from a worker thread: (200,
        answer) or (400, {error}) in plain words. Never anything but OPS, and
        its words only as text."""
        if op not in OPS:
            return 400, {"error": "a server is never asked that"}
        with self._lock:
            ch = self.channels.get(sid)
            if ch is None:
                return 400, {"error": "no such machine"}
            name = ch.rec["name"]
            if not ch.up(time.time()):
                return 400, {"error": name + " is not connected"}
            if len(ch.waiting) >= WAITING_MAX:
                return 429, {"error": name + " has too many questions waiting, try again shortly"}
            ch.count += 1
            qid = f"{ch.count}-{secrets.token_hex(4)}"
            slot = {"done": threading.Event(), "answer": None}
            ch.waiting[qid] = slot
            ch.asks.append({"id": qid, "op": op, "args": [str(a) for a in args]})
            self._wake(ch)
        got = slot["done"].wait(timeout)
        with self._lock:
            ch.waiting.pop(qid, None)
            ch.asks = [a for a in ch.asks if a["id"] != qid]
        if not got or slot["answer"] is None:
            return 400, {"error": name + " took too long to answer"}
        return slot["answer"]

    def list_dirs(self, sid: str, path: str, base: str) -> tuple:
        status, answer = self.ask(sid, "dirs", path, base)
        if status != 200:
            return status, answer
        kept = clean_listing(answer)
        if kept is None:
            return 400, {"error": "the server's answer could not be read"}
        return 200, {"machine": sid, **kept}

    def make_dir(self, sid: str, path: str, name: str) -> tuple:
        status, answer = self.ask(sid, "mkdir", path, name)
        if status != 200:
            return status, answer
        kept = clean_made(answer)
        return (200, kept) if kept is not None else (400, {"error": "the server's answer could not be read"})

    def describe(self, sid: str, path: str) -> tuple:
        status, answer = self.ask(sid, "describe", path)
        if status != 200:
            return status, answer
        kept = clean_described(answer)
        return (200, kept) if kept is not None else (400, {"error": "the server's answer could not be read"})

    # -- the agents' keys
    def mint(self, lane: str, sid: str) -> str:
        """A new key for the lane, which ends the lane's earlier one."""
        key = new_key()
        with self._lock:
            self._keys[lane] = {"hash": digest(key), "server": sid, "ts": round(time.time())}
            self.store.save_keys(self._keys)
        return key

    def lane_of(self, key: str):
        """(lane, server id) for an agent key, or None."""
        if not key:
            return None
        h = digest(key)
        with self._lock:
            items = list(self._keys.items())
            known = set(self.records)
        for lane, v in items:
            if hmac.compare_digest(v["hash"], h) and v["server"] in known:
                return lane, v["server"]
        return None

    def forget(self, lane: str) -> None:
        with self._lock:
            if self._keys.pop(lane, None) is not None:
                self.store.save_keys(self._keys)


# ---- which lane a join asks for -------------------------------------------------------------

def _within(path: str, root: str) -> bool:
    root = root.rstrip("/") or "/"
    return path == root or path.startswith(root + "/") or root == "/"


def resolve_lane(projects: list, path=None, name=None, git=None) -> tuple:
    """The lanes of one server a join can mean, as the helper on the Mac picks
    a lane: by id or name when one is named, else the project folder holding
    the path (the deepest), else a project of the same git repository.
    Answers (matches, the status for none)."""
    if name is not None:
        exact = [p["id"] for p in projects if p["id"] == name]
        if exact:
            return exact, "project_unknown"
        folded = name.casefold()
        return sorted({p["id"] for p in projects
                       if p["id"].casefold() == folded or str(p.get("name", "")).casefold() == folded}), "project_unknown"
    if not path:
        return [], "path_missing"
    holding = [p for p in projects if isinstance(p.get("dir"), str) and _within(path, p["dir"])]
    if holding:
        depth = max(len(p["dir"].rstrip("/")) for p in holding)
        return sorted(p["id"] for p in holding if len(p["dir"].rstrip("/")) == depth), "project_unknown"
    if git:
        same = sorted(p["id"] for p in projects if p.get("git") and p["git"] == git)
        if same:
            return same, "project_unknown"
    return [], "project_unknown"


def presence_status(presence: dict) -> str:
    """ready, or why a second listener should keep away, by the same rules the
    helper on the Mac reads off /state."""
    if presence.get("busy"):
        return "claim_held"
    if presence.get("listening") or presence.get("gap", 1e9) < 60:
        return "listener_present"
    return "ready"


# ---- the gate -----------------------------------------------------------------------------------

def _bearer(scope) -> str:
    for name, value in scope.get("headers") or ():
        if name.lower() == b"authorization":
            text = value.decode("latin-1").strip()
            if text[:7].lower() == "bearer ":
                return text[7:].strip()
            return ""
    return ""


async def _reply(send, status: int, payload, ctype: bytes = b"application/json") -> None:
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", ctype), (b"cache-control", b"no-store"),
                            (b"x-content-type-options", b"nosniff"),
                            (b"content-length", str(len(body)).encode()), (b"connection", b"close")]})
    await send({"type": "http.response.body", "body": body})


async def _read_body(receive, cap: int, wait: float = 10.0):
    body = bytearray()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    while True:
        try:
            event = await asyncio.wait_for(receive(), timeout=max(0.0, deadline - loop.time()))
        except asyncio.TimeoutError:
            return None
        if event["type"] != "http.request":
            return None
        body.extend(event.get("body", b""))
        if len(body) > cap:
            return None
        if not event.get("more_body"):
            return bytes(body)


async def _watch_gone(receive, gone: asyncio.Event) -> None:
    """Reads the request channel, its body already taken, until the peer
    goes away."""
    try:
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                gone.set()
                return
    except asyncio.CancelledError:
        raise
    except Exception:
        gone.set()


def _json(raw):
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


REFUSAL_WINDOW = 5.0     # seconds: one refusal line per reason and route per window


class RemoteGate:
    """Every request that came through the agent door, decided here before
    any route sees it. A request on the board's own ports passes to app
    untouched; one from the door that is let through goes to routes, the
    board's bare routes, never through the phone's gate or the Mac's.

    board is the server's side of it: board.remote (the Remote, or None when
    the board keeps no servers), board.projects(server id), board.presence
    (lane) and board.box_lane(box), each taking the board's lock itself, and
    board.log(kind, **fields). A line names a route and a reason, never a
    key, a code or an address."""

    def __init__(self, app, board, routes=None):
        self.app = app
        self.routes = routes if routes is not None else app
        self.board = board
        self._noted: dict = {}

    def _refuse_note(self, route: str, reason: str) -> None:
        try:
            now = time.monotonic()
            # a route outside the door's own is named as other, so nothing the
            # request made up reaches the file
            route = route if route in KNOWN_ROUTES else "other"
            name = reason + " " + route
            window = self._noted.get(name)
            if window is not None and now - window[0] < REFUSAL_WINDOW:
                window[1] += 1
                return
            if len(self._noted) > 64:
                self._noted.clear()
            self._noted[name] = [now, 0]
            self.board.log("remoterefused", route=route, reason=reason,
                           folded=(window[1] if window else 0) or None)
        except Exception:
            pass

    async def _in_thread(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or tuple(scope.get("server") or ()) != SERVER_MARK:
            await self.app(scope, receive, send)
            return
        path, method = scope.get("path", ""), scope.get("method", "")
        remote = self.board.remote
        if remote is None:
            await _reply(send, 503, {"error": "this board keeps no servers"})
            return
        key = _bearer(scope)
        if (method, path) == ("GET", "/remote/setup"):
            # the setup program alone needs no key: it is the skill's own
            # code, the same for everyone, and holds nothing of the board's
            try:
                text = await self._in_thread(remote.setup_program)
            except OSError:
                await _reply(send, 503, {"error": "the setup program is missing from the board"})
                return
            await _reply(send, 200, text, b"text/x-python; charset=utf-8")
            return
        if (method, path) == ("POST", "/remote/pair"):
            await self._pair(receive, send, remote, key)
            return
        if (method, path) in (("POST", "/remote/link"), ("POST", "/remote/join")):
            rec = remote.server_of_key(key)
            if rec is None:
                self._refuse_note(path, "key")
                await _reply(send, 401, {"error": "this server's key is not known: pair it again"})
                return
            if path == "/remote/link":
                await self._link(scope, receive, send, remote, rec)
            else:
                await self._join(receive, send, remote, rec)
            return
        held = remote.lane_of(key)
        if held is None:
            self._refuse_note(path, "key")
            await _reply(send, 401, {"error": "this key is not known: join again"})
            return
        lane, sid = held
        rule = AGENT_ROUTES.get((method, path))
        if rule is None:
            self._refuse_note(path, "route")
            await _reply(send, 403, {"error": "an agent on a server may not use this"})
            return
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
        if rule == "lane":
            presence = await self._in_thread(self.board.presence, lane)
            await _reply(send, 200, {"owner": lane, "server": sid, **presence})
            return
        if rule == "owner":
            ok = query.get("owner") == [lane]
        else:
            boxes = query.get("box") or []
            ok = len(boxes) == 1 and await self._in_thread(self.board.box_lane, boxes[0]) == lane
        if not ok:
            self._refuse_note(path, "lane")
            await _reply(send, 403, {"error": "this key is for another project"})
            return
        await self.routes({**scope, "facilitator.remote": {"lane": lane, "server": sid}}, receive, send)

    async def _pair(self, receive, send, remote, typed):
        raw = await _read_body(receive, PAIR_BODY_MAX)
        status, answer = await self._in_thread(remote.pair, typed, _json(raw))
        if status != 200:
            self._refuse_note("/remote/pair", "code" if status in (401, 429) else "body")
        await _reply(send, status, answer)

    async def _link(self, scope, receive, send, remote, rec):
        raw = await _read_body(receive, POLL_BODY_MAX, wait=30.0)
        said = _json(raw)
        if raw is None or not isinstance(said, dict):
            await _reply(send, 400, {"error": "a poll carries its answers as JSON"})
            return
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        try:
            hold = float((query.get("hold") or [HOLD])[0])
        except ValueError:
            hold = HOLD
        if not math.isfinite(hold):
            hold = HOLD
        gone = asyncio.Event()
        watcher = asyncio.ensure_future(_watch_gone(receive, gone))
        try:
            asks = await remote.poll(rec["id"], said.get("answers"), gone, hold)
        finally:
            watcher.cancel()
        if asks is None:
            await _reply(send, 401, {"error": "this server's key is not known: pair it again"})
            return
        await _reply(send, 200, {"asks": asks})

    async def _join(self, receive, send, remote, rec):
        raw = await _read_body(receive, JOIN_BODY_MAX)
        asked = _json(raw)
        if not isinstance(asked, dict):
            await _reply(send, 400, {"error": "a join names a path or a board"})
            return
        path, name, git = (asked.get(k) if isinstance(asked.get(k), str) else None for k in ("path", "board", "git"))
        projects = await self._in_thread(self.board.projects, rec["id"])
        matches, problem = resolve_lane(projects, path, name, git)
        if len(matches) != 1:
            status = "ambiguous" if matches else problem
            self.board.log("remotejoin", server=short(rec["id"]), status=status)
            await _reply(send, 200, {"status": status, "matches": matches,
                                     "available": sorted(p["id"] for p in projects)})
            return
        lane = matches[0]
        presence = await self._in_thread(self.board.presence, lane)
        status = presence_status(presence)
        self.board.log("remotejoin", server=short(rec["id"]), status=status)
        answer = {"status": status, "owner": lane, "server": rec["name"]}
        if status == "claim_held":
            answer["box"] = presence.get("busy")
        if status == "ready":
            answer["key"] = remote.mint(lane, rec["id"])
        await _reply(send, 200, answer)
