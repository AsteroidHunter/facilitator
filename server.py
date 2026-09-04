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
                               and any older caller land exactly as before.
                               Sending to a parked card also brings it back to
                               Doing in the same saved update
  POST /done?box=ID&v=1|0   -> mark a box done / not done
  POST /close?box=ID        -> atomically close from the authoritative card:
                               a card with a reply, reply count, or pending
                               message is marked done; only a truly empty meta
                               card is removed
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
  POST /delete?box=ID       -> legacy empty-meta removal route. A stale caller
                               that sends a nonempty meta card here closes it to
                               done instead, so old tabs cannot erase a thread
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
  GET  /cm-markdown.js      -> the vendored CodeMirror 6 bundle beside index.html,
                               fetched the first time the markdown panel opens
  GET  /card-markdown.js    -> the shared, finite card-prose renderer used by
                               the board, page view and small card
  GET  /card-tokens.css     -> the card's shared sheet: the colour and font
                               tokens, the card's constants, the card prose
                               rules and the sent box's arrival dress, loaded
                               by the board and the phone page
  GET  /card-logic.js       -> the card's shared logic: the card state rules,
                               the lanes, the sent box's rows and the helpers
                               the board and the phone page carry in common
  GET  /m                   -> m.html, the phone page: the project tabs, one
                               card filling the screen, the card list in a
                               drawer off the left edge, nothing else
  GET  /m-manifest.json, /m-sw.js, /m-icon-<size>.png
                            -> what makes the phone page installable: its web
                               app manifest, its service worker (network
                               first, shows the push notifications) and its
                               home screen icons, cut from the board's own mark.
                               The manifest's name and short_name are answered
                               from the saved board title, so the install
                               prompt offers the one name the board goes by;
                               every other field is served as the file has it,
                               and a blank title leaves the file's own name
  GET  /push/key            -> {"key": ...}: the VAPID public key, base64url,
                               that the phone subscribes with. The key pair
                               lives in vapid-key.pem beside state.json,
                               gitignored and made by openssl on first need
  POST /push/subscribe      -> body = the browser's push subscription as JSON
                               ({endpoint, keys, ...}); kept in state.json under
                               push_subs, one per endpoint. Each time a card
                               turns to the owner's turn (a plain reply with no
                               live working flag, or a working flag dropped or
                               expired while a reply waited in deferred) one
                               payload-less push goes to every subscription,
                               signed with a VAPID token openssl produces; the
                               phone's worker then reads /state for the card.
                               Progress notes never push. A subscription the
                               push service reports gone (404, 410) is dropped
  GET  /mdfiles?lane=L      -> every .md file under the two folders lane L's own
                               markdown panel may touch (that lane's internal
                               folder and its wiki, both named after the lane's
                               own directory), grouped by folder, each with its
                               path relative to that folder and its stamp, and
                               each folder with the kind it answers to. A folder
                               that is missing or empty comes back present and
                               empty rather than not at all. A lane the panel is
                               not mounted on has no folders here at all
  GET  /mdfile?lane=L&root=R&rel=P -> one markdown file's whole text plus the
                               stamp the save guard wants back, and crlf saying
                               which line endings it arrived in. R has to be one
                               of lane L's own two folder names, so one lane
                               asking for another lane's folder is refused, and P
                               is a path under it. The joined path is resolved
                               and has to land inside that folder, so .. segments,
                               absolute paths and symlinks pointing out are all
                               refused (400), as is anything that is not a .md
                               file or not utf-8 text
  POST /mdsave?lane=L&root=R&rel=P&mtime=S -> body = the file's whole new text,
                               raw and unstripped. Same lane and path rules as
                               /mdfile. S is the stamp handed out on read: if the
                               file's stamp has moved since, somebody else wrote
                               it and the save is refused with 409 and the current
                               stamp, never merged and never clobbered. Written
                               temp-file-then-rename like state.json, and answers
                               the new stamp
  POST /tabs                -> body = the project tab bar's whole record as
                               JSON, {"order": [owner ids], "closed": [owner
                               ids]}: which tabs the bar shows and in what
                               order. Kept here rather than in one browser, so
                               the board and the phone show the same tabs in
                               the same order and either can reorder them.
                               Every id has to be a known owner (400
                               otherwise, nothing stored) and a repeated id is
                               dropped. Answers the stored record
  POST /seen                -> body = {"<box id>": <replies read>, ...}: how
                               many of each card's replies the owner has read,
                               so a card read on the phone counts as read on
                               the board too. Counts are whole numbers, never
                               below zero; an unknown box or a bad count is a
                               400 with nothing stored at all. Answers the
                               stored counts for the ids it was given
  GET  /thread?box=ID&n=N   -> last N user/agent/note messages of a box from the
                               transcript (read by the reply history stepper
                               and the quick chat panel)
  GET  /log?lines=N         -> tail of the day's server log file, the dated one
                               under the sibling internal folder's logs/;
                               $FACILITATOR_LOG names another file instead
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
                               queued box owned by O (facilitator|pastureland; defaults
                               to pastureland, the pre-routing loop's role) + its pending
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
  POST /reply?box=ID[&ctx=S][&short=S] -> body = the agent's full final reply
                               text (plain text). short is an OPTIONAL,
                               separately stored small-card version. When it
                               is absent, the full text is used in both places.
                               Authored punctuation, including a line containing
                               only ---, always remains part of the reply.
                               ctx is an OPTIONAL urlencoded summary
                               strip, 50 words max, stored as the box's
                               context when passed. The summary box was taken
                               off the card 20260821 and nothing displays it;
                               an overlong strip is still refused (400), never
                               silently truncated.
                               When the newest message the claim covers came
                               from the small card (via=mini), its displayed
                               variant over 100 whitespace separated words is
                               refused (400, nothing stored). With no short
                               value that means the full body. A big card
                               message has no cap.
                               A normal reply hands the ball to you only when
                               no working flag beats on the box. While one
                               does, nothing awaits you yet: the card goes to
                               the deferred state and the turn is handed over
                               when that flag drops or expires, so a mid-work
                               reply cannot turn a green card yellow.
                               The removed quiet query is rejected so a stale
                               agent contract cannot turn progress into an
                               accidental final handover.
  POST /note?box=ID&ctx=S   -> the named interim-note action: stores the body
                               and ctx summary like /reply (reply, count,
                               agent_ts, ts, context), consumes and releases
                               any held claim, and enters the explicit note
                               state with a fresh heartbeat. note is green
                               while the work lives and rests grey if it dies;
                               it never hands the ball to "you". A normal
                               /reply is the sole final handover action.

Owner routing (2026-08-05): every box carries an owner tag, facilitator (tool
discussion, this repo's agent) or pastureland (the project under discussion, its
own agent). Each owner has its own busy/claim slot and listener-presence
tracking, so the two agents drain the same board without blocking each other.

State persists to state.json next to this file; every send/reply also appends
to transcript.jsonl so the discussion survives anything. A first-ever start
(no state.json) seeds the board title and boxes from seed.json if present;
see seed.example.json. Real discussion content never ships in this code.
"""

from __future__ import annotations

import base64
import json
import logging
import logging.handlers
import os
import random
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
RETIRED_OWNERS = frozenset({"triage"})

# ---- the log ----------------------------------------------------------------
# One event per line, as JSON, in a dated file; the same event in a short human
# form on standard output, because the terminal is where the owner already
# watches it. Three levels and no more: INFO is what happened and is on by
# default, DEBUG is the noise switched on while hunting, ERROR is something that
# failed and was not meant to.
#
# Five things never appear in any line: message text, keys, whole push
# endpoints, file paths and addresses. The rule is kept HERE, where the line is
# written, by not passing those things in. A filter over a formatted line can be
# fooled; not passing the text cannot.
LOG_LEVELS = {"info": logging.INFO, "debug": logging.DEBUG, "error": logging.ERROR}
LOG_MAX_BYTES = 5 * 1024 * 1024   # one file's cap
LOG_KEEP = 30                     # files of one kind kept; older ones are deleted
# The folder is worked out from this file's own place, the way INTERNAL_UPLOADS
# below is, so no machine's home directory gets into tracked source and every
# test's copy of this file writes into its own sandbox. The variable points one
# run somewhere else, which is what a rotation test needs.
LOG_DIR = Path(os.environ.get("FACILITATOR_LOG_DIR")
               or (HERE.parent / "facilitator-internal" / "logs"))


def _configured_level() -> str:
    """The level in force: the environment variable wins over run.config.json's
    log_level, which wins over info. Never raises, and a value that names no
    level falls back to info rather than stopping the board.

    Its own small read rather than a field on the lane config's read, because
    the level has to be known before the socket is bound (a refused bind is
    itself worth writing down) and that read deliberately refuses some files."""
    named = os.environ.get("FACILITATOR_LOG_LEVEL")
    if not named:
        try:
            named = json.loads((HERE / "run.config.json").read_text()).get("log_level")
        except Exception:
            named = None
    named = str(named or "").strip().lower()
    return named if named in LOG_LEVELS else "info"


class DatedRotatingHandler(logging.handlers.RotatingFileHandler):
    """A file per day per kind, capped by size and pruned by count.

    Neither handler in the standard library does both. RotatingFileHandler takes
    its name once, so a process running past midnight keeps writing yesterday's
    date forever; TimedRotatingFileHandler rolls at midnight and has no size cap
    at all, and the thing most likely to write a lot is exactly the thing going
    wrong. This rolls on either, and prunes by listing the folder rather than
    shuffling numbered backups, which also clears files left by earlier runs."""

    def __init__(self, folder: Path, stem: str, suffix: str) -> None:
        self.folder, self.stem, self.suffix = folder, stem, suffix
        self.day, self.roll = time.strftime("%Y%m%d"), 0
        folder.mkdir(parents=True, exist_ok=True)
        super().__init__(str(self._file()), maxBytes=LOG_MAX_BYTES,
                         backupCount=0, encoding="utf-8")

    def _file(self) -> Path:
        """<stem>-<day><suffix>, and <stem>-<day>.1<suffix> for a second roll
        on the same day."""
        return self.folder / (f"{self.stem}-{self.day}"
                              + (f".{self.roll}" if self.roll else "") + self.suffix)

    def _age(self, p: Path) -> tuple:
        """Oldest first, read out of the name rather than off a modification
        time, so files carried over from earlier runs still sort truthfully."""
        day, _, roll = p.name[len(self.stem) + 1:-len(self.suffix)].partition(".")
        return (day, int(roll) if roll.isdigit() else 0)

    def shouldRollover(self, record: logging.LogRecord) -> int:  # noqa: N802
        if time.strftime("%Y%m%d") != self.day:
            return 1
        return super().shouldRollover(record)

    def doRollover(self) -> None:  # noqa: N802
        if self.stream:
            self.stream.close()
            self.stream = None
        today = time.strftime("%Y%m%d")
        if today != self.day:
            self.day, self.roll = today, 0
        else:
            self.roll += 1
        while self._file().exists():   # never reopen a file this run already filled
            self.roll += 1
        self.baseFilename = str(self._file())
        self.stream = self._open()
        self._prune()

    def _prune(self) -> None:
        """Thirty of this kind kept, the oldest deleted. A folder that cannot be
        listed is left alone: pruning must never be the thing that stops a
        line from being written."""
        try:
            kept = sorted(self.folder.glob(f"{self.stem}-*{self.suffix}"), key=self._age)
        except OSError:
            return
        for old in kept[:-LOG_KEEP]:
            try:
                old.unlink()
            except OSError:
                pass


class JsonLineFormatter(logging.Formatter):
    """One event, one line: a UTC timestamp with the date in it, the level, the
    kind, the box when the event belongs to a card, then that kind's own fields.
    A traceback travels as an ordinary string field, whose newlines json.dumps
    escapes, so one event never becomes several lines."""

    def format(self, record: logging.LogRecord) -> str:
        line = {
            "ts": (time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
                   + f".{int(record.msecs):03d}Z"),
            "level": record.levelname.lower(),
            "kind": record.getMessage(),
        }
        if getattr(record, "box", ""):
            line["box"] = record.box
        for name, value in (getattr(record, "fields", None) or {}).items():
            if value is not None:
                line[name] = value
        return json.dumps(line, default=str)


class HumanLineFormatter(logging.Formatter):
    """The terminal's copy of the same event, in local time and without the
    braces. The gap after the kind is never eaten however long the kind is,
    which the padded print this replaces could not promise. A traceback is not
    mirrored here; the file has it whole."""

    def format(self, record: logging.LogRecord) -> str:
        tag = f"[{record.box}]" if getattr(record, "box", "") else ""
        fields = getattr(record, "fields", None) or {}
        bits = " ".join(f"{name}={value}" for name, value in fields.items()
                        if name != "trace" and value is not None and value != "")
        return (f"{time.strftime('%H:%M:%S', time.localtime(record.created))}  "
                f"{record.getMessage():<9} {tag:<7} {bits}").rstrip()


LOG_LEVEL = _configured_level()
LOGGER = logging.getLogger("facilitator")
LOGGER.setLevel(LOG_LEVELS[LOG_LEVEL])
LOGGER.propagate = False
if not LOGGER.handlers:
    _to_file = DatedRotatingHandler(LOG_DIR, "server", ".log")
    _to_file.setFormatter(JsonLineFormatter())
    LOGGER.addHandler(_to_file)
    # the terminal sees INFO and above, in human form: JSON in a terminal is
    # unreadable, and making the terminal readable by making the file
    # unstructured would give up reading the file back with json.loads
    _to_terminal = logging.StreamHandler(sys.stdout)
    _to_terminal.setLevel(logging.INFO)
    _to_terminal.setFormatter(HumanLineFormatter())
    LOGGER.addHandler(_to_terminal)


def _event(level: int, kind: str, box: str = "", /, **fields) -> None:
    """One structured event: kind names it, box is the card it belongs to (empty
    when it belongs to none), and the rest are that kind's own fields. The three
    named parts are positional only, so an event may carry a field called level
    or kind without colliding with the call itself."""
    if LOGGER.isEnabledFor(level):
        LOGGER.log(level, kind, extra={"box": box, "fields": fields})


def _info(kind: str, box: str = "", /, **fields) -> None:
    _event(logging.INFO, kind, box, **fields)


def _debug(kind: str, box: str = "", /, **fields) -> None:
    _event(logging.DEBUG, kind, box, **fields)


def _error(kind: str, box: str = "", /, **fields) -> None:
    _event(logging.ERROR, kind, box, **fields)


def _log_file() -> Path:
    """What GET /log tails: the day's server file, unless FACILITATOR_LOG names
    another one, which is the override that route has always had."""
    named = os.environ.get("FACILITATOR_LOG")
    return Path(named) if named else LOG_DIR / f"server-{time.strftime('%Y%m%d')}.log"


class OwnerMigrationRequired(ValueError):
    """Persisted configuration or state still names a retired owner id."""


def _lane_dirs() -> dict:
    """Per-owner project directory from run.config.json (machine-local, gitignored);
    served to the page for the pwd line, never part of tracked content."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        return {}
    lanes = cfg.get("lanes", [])
    retired = sorted({ln.get("owner") for ln in lanes
                      if isinstance(ln, dict) and ln.get("owner") in RETIRED_OWNERS})
    if retired:
        names = ", ".join(repr(ow) for ow in retired)
        raise OwnerMigrationRequired(
            f"run.config.json requires owner migration: retired owner {names} is not allowed")
    return {ln["owner"]: str(Path(ln["dir"]).expanduser())
            for ln in lanes if ln.get("owner") and ln.get("dir")}
STATE_PATH = HERE / "state.json"
TRANSCRIPT_PATH = HERE / "transcript.jsonl"
# uploaded images now save outside the repo, in the sibling internal folder
# (not a git repo, never pushed); reads still fall back to the old in-repo
# uploads/ so the images saved there before this change keep resolving
INTERNAL_UPLOADS = HERE.parent / "facilitator-internal" / "uploads"
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
# Version 1 removes the old convention that treated a line containing only ---
# as a hidden short/full delimiter. Existing state is split once in _migrate;
# every new reply has explicit fields and the Markdown renderer is never asked
# to infer application state from authored punctuation.
REPLY_VARIANTS_VERSION = 1
# Transcript rows written before this physical marker used the retired ---
# convention. Rows after it do not. File order, rather than event timestamps,
# is the durable boundary because transcript timestamps are authored data and
# may be missing, malformed, duplicated, or in the future.
TRANSCRIPT_REPLY_SCHEMA = "reply_variants"
OWNERS = ("facilitator", "pastureland", "qchat")  # qchat: the quick chat panel's lane, dormant in the current board
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
_LANE_DIRS = {}

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
    if ow in RETIRED_OWNERS:
        raise OwnerMigrationRequired(
            f"owner registration refused retired owner {ow!r}; persisted data requires migration")
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


# the lanes the markdown editor is mounted on, and the two folders each of them
# may read and write: that lane's own internal folder and its wiki beside it.
# The folder names come off the lane's own directory and not its owner id,
# because a lane can be named for its work while its folder is named for its
# project: the pastureland lane lives in pastureland/ and keeps pastureland-internal
# and pastureland-wiki. Worked out per lane rather than written down as paths,
# the way _lane_internal already does it, so no one machine's home directory
# gets into tracked source and a lane moved on disk carries its folders with it.
# The lane list is what makes this a fence: a lane not on it has no folders at
# all here, and every route below then refuses it.
MD_LANES = ("website", "pastureland")
MD_KINDS = ("internal", "wiki")


def _md_roots(lane: str) -> list[tuple]:
    """One lane's allowed folders as (kind, folder) pairs, fully resolved, in the
    order the page's head offers them. Resolved once here so every path check
    downstream compares real paths against real paths: a root that is itself
    reached through a symlink still matches the files inside it. Each folder
    carries its kind rather than the caller counting on the order, so a folder
    that could not be resolved at all takes only its own place out of the list.
    A lane the panel is not mounted on, and a lane nobody has heard of, yield
    nothing, and every route then refuses."""
    d = _lane_pwds().get(lane) if lane in MD_LANES else None
    if not d:
        return []
    out = []
    for kind in MD_KINDS:
        try:
            out.append((kind, (Path(d) / (Path(d).name + "-" + kind)).resolve()))
        except OSError:
            pass   # unreadable or a symlink loop: the folder simply is not offered
    return out


def _md_path(lane: str, root: str, rel: str) -> Path | None:
    """The file a markdown request names, or None when it is not genuinely one
    of that lane's. root is a folder name and rel is a path under it, and the
    root has to be one of the two this lane itself owns: one lane asking for
    another lane's folder by name gets nothing, since that name is not among
    these. resolve() is what does the rest: it eats .. segments and follows
    every symlink, so the containment test below sees where the path really
    lands and not what it was spelled as. An absolute rel replaces the root
    outright under pathlib's join, which is exactly why the same test catches
    it. Markdown only, and never the folder itself."""
    bases = {p.name: p for _, p in _md_roots(lane)}
    base = bases.get(root)
    if base is None or not rel:
        return None
    try:
        p = (base / rel).resolve()
    except OSError:
        return None
    if p.suffix.lower() != ".md":
        return None
    return p if p != base and base in p.parents else None


def _md_stamp(p: Path) -> str:
    """A file's modification time as the stale-write guard carries it: whole
    nanoseconds, as a decimal string. A string because the number is around
    1.8e18 and a browser would round it away as a double, and the guard has to
    compare exactly. Agents edit these files too, so this is the whole reason a
    save can be refused."""
    return str(p.stat().st_mtime_ns)


# the worktree names a lane can offer, cached per lane for a few seconds. the
# card's top bar asks for these, and it asks on every tab switch and every
# opening of the list, so a bare shell-out on each call would put a git process
# on the board's own thread several times a second. git itself is the only
# source: a worktree name has to point at a worktree that exists, and the page
# offers no way to type one in, so a stale or invented name cannot get in.
_WT_CACHE: dict = {}
_WT_TTL = 15.0


def _wt_list(d: Path) -> dict | None:
    """git's own worktree listing for one folder, parsed, or None when that
    folder is not a checkout at all. Read only: it runs git's list and writes
    nothing. None and not an empty answer, because the caller has to tell "no
    repository here, try the next folder" apart from "a repository with nothing
    to offer", and only the first of those is worth another look."""
    if not d.is_dir():
        return None
    try:
        # --porcelain is the stable form: one paragraph per worktree, the path
        # on a "worktree " line and the ref on a "branch " line. a detached head
        # carries no branch line at all and is skipped, since it names nothing a
        # card could be moved onto
        raw = subprocess.run(["git", "worktree", "list", "--porcelain"],
                             cwd=str(d), capture_output=True, text=True, timeout=5)
    except Exception:
        return None       # no git on this machine, or the folder went away under us
    if raw.returncode != 0:
        return None       # exit 128, "not a git repository": nothing here to list
    out = {"current": "", "names": []}
    here, path = d.resolve(), None
    for line in raw.stdout.splitlines():
        if line.startswith("worktree "):
            path = Path(line[9:]).resolve()
        elif line.startswith("branch "):
            name = line[7:].removeprefix("refs/heads/")
            if name not in out["names"]:
                out["names"].append(name)
            if path == here:
                out["current"] = name
    return out


def _lane_worktrees(lane: str) -> dict:
    """The lane folder's own checked-out branch and the branches of every
    worktree of the same repository, newest listing first. Read only, and it
    never raises: a lane with no repository under it, or a machine with no git,
    hands back nothing at all, so the bar shows no name and offers no list.

    Two folders are tried, in this order. A lane's dir is often a wrapper rather
    than the checkout itself, with the repository one level in, in a child named
    after the wrapper: projects/facilitator holds facilitator/, and the
    pastureland lane's projects/pastureland holds pastureland/. So the lane's
    own folder is asked first, and the same-name child only if that folder is
    not a checkout. Only ever the same-name child and never an arbitrary one:
    journal holds upstream-ref, a reference checkout that is not that
    lane's project, and offering its branches as the lane's own would be a
    quiet lie. A wrapper with no same-name checkout under it simply has no
    repository, which is the true answer for it."""
    d = _lane_pwds().get(lane)
    if not d:
        return {"current": "", "names": []}
    hit = _WT_CACHE.get(lane)
    if hit and time.time() - hit[0] < _WT_TTL:
        return hit[1]
    out = None
    try:
        here = Path(d)
        for cand in (here, here / here.name):
            out = _wt_list(cand)
            if out is not None:
                break
    except Exception:
        out = None        # an unusable path: the lane simply offers nothing
    if out is None:
        out = {"current": "", "names": []}
    _WT_CACHE[lane] = (time.time(), out)
    return out


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
                "reply_full": it.get("context", ""),
                "reply_short": it.get("context", ""),
                "pending": [], "done": False, "replies": 0,
                "owner": it.get("owner", "pastureland"),
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


OWNER_KEYED_STATE = ("busy", "claimed", "busy_ts", "ack", "workspaces", "ever_listened")


def _validate_persisted_owners(st: dict, source: str) -> None:
    """Refuse retired ids before migration can register, default, or save them.

    This is deliberately a validator, not a converter. The one-time live state
    rewrite is an external cutover step, and a process must not decide how two
    old and new values should be merged.
    """
    hits = []
    boxes = st.get("boxes", []) if isinstance(st, dict) else []
    if isinstance(boxes, list):
        for i, box in enumerate(boxes):
            if isinstance(box, dict) and box.get("owner") in RETIRED_OWNERS:
                hits.append(f"boxes[{i}].owner={box['owner']!r}")
    projects = st.get("projects", []) if isinstance(st, dict) else []
    if isinstance(projects, list):
        for i, project in enumerate(projects):
            if isinstance(project, dict) and project.get("id") in RETIRED_OWNERS:
                hits.append(f"projects[{i}].id={project['id']!r}")
    if isinstance(st, dict):
        for field in OWNER_KEYED_STATE:
            value = st.get(field)
            if isinstance(value, dict):
                for owner in sorted(RETIRED_OWNERS.intersection(value)):
                    hits.append(f"{field}[{owner!r}]")
    if hits:
        raise OwnerMigrationRequired(
            f"{source} requires owner migration; retired owner data found at " + ", ".join(hits))


def _load() -> None:
    global _state, _LANE_DIRS
    _LANE_DIRS = _lane_dirs()
    if STATE_PATH.exists():
        _state = json.loads(STATE_PATH.read_text())
        source = "state.json"
    else:
        _state = _seed_state()
        source = "seed.json" if SEED_PATH.exists() else "new state"
    _validate_persisted_owners(_state, source)
    for b in _state["boxes"]:  # ages start counting from first sight
        b.setdefault("ts", time.time())
    _migrate()


def _legacy_reply_variants(value: str) -> tuple[str, str]:
    """Reproduce the retired browser split for pre-version-1 saved data only.

    This is deliberately a migration helper, not part of card formatting or a
    fallback for new writes. A --- inside a column-zero backtick fence remains
    content, and only the first outside fence was ever a delimiter.
    """
    text = value or ""
    lines = text.split("\n")

    def clipped(part: list[str]) -> str:
        while part and not part[0].strip():
            part.pop(0)
        while part and not part[-1].strip():
            part.pop()
        return "\n".join(part)

    in_code = False
    for index, line in enumerate(lines):
        if line.startswith("```"):
            in_code = not in_code
            continue
        if not in_code and line.strip() == "---":
            return clipped(lines[:index]), clipped(lines[index + 1:])
    return text, text


def _set_reply_variants(box: dict, full: str, short: str | None = None) -> None:
    """Store explicit full and small-card text; reply stays as a full-text shim."""
    box["reply_full"] = full
    box["reply_short"] = full if short is None else short
    box["reply"] = full


def _is_reply_schema_boundary(event: dict) -> bool:
    """True only for our durable transcript schema marker."""
    try:
        version = int(event.get("version", 0))
    except (TypeError, ValueError):
        return False
    return (event.get("kind") == "schema" and
            event.get("schema") == TRANSCRIPT_REPLY_SCHEMA and
            version >= REPLY_VARIANTS_VERSION)


def _ensure_reply_schema_boundary() -> None:
    """Append the v1 transcript boundary exactly once.

    The transcript is append-only. Scanning for the marker makes this safe when
    a process stops between appending it and saving state: the next start sees
    the already-durable marker instead of appending another. The state version
    records that the migration ran, but readers deliberately trust file order.
    """
    found = False
    needs_separator = False
    try:
        with TRANSCRIPT_PATH.open(errors="replace") as transcript:
            for line in transcript:
                try:
                    event = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if isinstance(event, dict) and _is_reply_schema_boundary(event):
                    found = True
                    break
    except FileNotFoundError:
        pass
    try:
        with TRANSCRIPT_PATH.open("rb") as transcript:
            transcript.seek(0, os.SEEK_END)
            if transcript.tell():
                transcript.seek(-1, os.SEEK_END)
                needs_separator = transcript.read(1) != b"\n"
    except FileNotFoundError:
        pass
    if not found or needs_separator:
        marker = {
            "kind": "schema",
            "schema": TRANSCRIPT_REPLY_SCHEMA,
            "version": REPLY_VARIANTS_VERSION,
        }
        with TRANSCRIPT_PATH.open("a") as transcript:
            # A crash or manual repair may have left a truncated final JSON
            # object with no newline. Separate it before the schema event so
            # the durable boundary is independently parseable and all later
            # appends start on their own records.
            if needs_separator:
                transcript.write("\n")
            if not found:
                transcript.write(json.dumps(marker) + "\n")
            transcript.flush()
            os.fsync(transcript.fileno())
    _state["transcript_reply_variants_version"] = REPLY_VARIANTS_VERSION


def _migrate() -> None:
    """Apply each versioned, idempotent upgrade to saved board state."""
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
        b.setdefault("owner", "facilitator" if b["id"] == "0" or b["id"].startswith("m") else "pastureland")
    if not isinstance(_state.get("busy"), dict):  # scalar claim slots -> per-owner maps
        _state["busy"] = {ow: None for ow in OWNERS}
        _state["claimed"] = {ow: [] for ow in OWNERS}
        _state["busy_ts"] = {ow: 0.0 for ow in OWNERS}
    if _box("t0") is None:  # box 0 is the facilitator agent's; pastureland-meta gets its own pin
        _state["boxes"].insert(_state["boxes"].index(_box("0")) + 1 if _box("0") else 0, {
            "id": "t0", "bucket": "meta", "title": "Release pastureland: drop meta thoughts here",
            "reply": "", "pending": [], "done": False, "parked": False, "replies": 0,
            "ball": "you", "ts": time.time(), "owner": "pastureland",
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
    # the last push that actually worked (2026-09-03): null, like an absent
    # field, means none ever has, which is the truthful reading of older state
    _state.setdefault("push_last_ok", None)
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
    # the project tab bar (2026-09-02): which tabs are shown and in what order
    # is one board-wide record, not one browser's own. An empty order is a
    # board that has never had one written, and every page then falls back to
    # the natural lane order it always used
    if not isinstance(_state.get("tabs"), dict):
        _state["tabs"] = {}
    for field in ("order", "closed"):
        if not isinstance(_state["tabs"].get(field), list):
            _state["tabs"][field] = []
    for b in _state["boxes"]:
        b.setdefault("ws", ws[b.get("owner", "pastureland")][0]["id"])
        b.setdefault("task", None)
        b.setdefault("agent_ts", 0)
        # how many of this card's replies he has read (2026-09-02): a board
        # record, so opening a card on the phone marks it read on the board
        b.setdefault("seen", 0)
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
    # Reply variants (2026-09-01) are a one-time data representation migration.
    # A box that already has either explicit field is new-schema data even when
    # a top-level marker is absent, as happens for a fresh seed or a partially
    # migrated state. Only a genuine legacy box with neither field is split.
    if _state.get("reply_variants_version", 0) < REPLY_VARIANTS_VERSION:
        for b in _state["boxes"]:
            if "reply_full" in b or "reply_short" in b:
                full = b.get("reply_full", b.get("reply", ""))
                short = b.get("reply_short", full)
            else:
                short, full = _legacy_reply_variants(b.get("reply", ""))
            _set_reply_variants(b, full, short)
        _state["reply_variants_version"] = REPLY_VARIANTS_VERSION
    else:
        # Versioned state should already have both fields. Defaults make a box
        # manually added by an older helper safe without reviving the delimiter.
        for b in _state["boxes"]:
            full = b.get("reply_full", b.get("reply", ""))
            _set_reply_variants(b, full, b.get("reply_short", full))
    # The old first-pass timestamp cutoff was not a stable schema boundary.
    # Drop it and append a file-order marker after every pre-v1 transcript row.
    _state.pop("reply_variants_migrated_at", None)
    _ensure_reply_schema_boundary()
    _save()


def _save() -> None:
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(_state, indent=1))
    os.replace(tmp, STATE_PATH)


def _log(kind: str, box: str, text: str, log_fields: dict | None = None, **fields) -> None:
    """One board event: the transcript keeps it whole, text and all, because the
    transcript is the discussion's durable record. The log gets the same event
    without the text, only its length, since GET /log hands the log to any
    caller on this machine and what was said is not its business. log_fields
    carries what is safe to write down beside it and never reaches the
    transcript row."""
    event = {"ts": time.time(), "kind": kind, "box": box, "text": text}
    event.update(fields)
    with TRANSCRIPT_PATH.open("a") as f:
        f.write(json.dumps(event) + "\n")
    _info(kind, box, chars=len(str(text or "")), **(log_fields or {}))


def _box(bid: str) -> dict | None:
    return next((b for b in _state["boxes"] if b["id"] == bid), None)


def _box_has_content(box: dict) -> bool:
    """The persisted conversation test used by every destructive close path."""
    return (box.get("replies", 0) > 0 or
            bool((box.get("reply") or "").strip()) or
            bool(box.get("pending")))


def _mark_box_done(box: dict) -> str:
    box["done"] = True
    box["parked"] = False
    _log("done", box["id"], "")
    return "done"


def _remove_empty_meta_box(box: dict) -> str:
    """Remove one already-validated empty meta card. Caller holds _lock."""
    bid = box["id"]
    _state["boxes"].remove(box)
    if bid in _state["inbox"]:
        _state["inbox"].remove(bid)
    ow = box.get("owner", "pastureland")
    if _state["busy"][ow] == bid:
        _state["busy"][ow] = None
        _state["claimed"][ow] = []
    _log("delete", bid, box["title"])
    return "deleted"


def _close_box(box: dict) -> str:
    """Close from current state; only an empty meta card may be destroyed."""
    if box["bucket"] != "meta" or _box_has_content(box):
        return _mark_box_done(box)
    return _remove_empty_meta_box(box)


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
#                 note      an interim progress note while its heartbeat is
#                           beating (green; no turn waits on him)
#                 deferred  working, plus a reply that becomes his turn the
#                           moment the work ends (green)
#                 yours     an unanswered reply awaits him (yellow)
#                 rest      nothing pending either way (grey)
# event           /send                    -> clears parked, then queued; a
#                                          beating flag keeps its
#                                          green, and a deferred turn dies:
#                                          he has answered
#                 /reply                   -> yours; flag still beating ->
#                                          deferred; leftover msgs -> queued
#                 /note                    -> note, starts heartbeat, consumes
#                                          and releases a claim, ball stays me
#                 /progress                no turn handed over; claim stays held
#                 /working v=1, /ping      -> working (note/deferred stay)
#                 flag drop or 75s expiry  -> deferred hands its turn over and
#                                          lands yours; working/note land at _rest
#                 /dismiss                 -> _rest, a beating flag excepted
# _rest, the landing rule: pending -> queued, never touched -> new, ball
# "you" -> yours, else rest. Expiry is swept lazily at /state and /wait,
# beside the unacked-claim clock, and by /working itself.

GREEN = ("working", "note", "deferred")


def _hb_live(b: dict) -> bool:
    """The flag's heartbeat is fresh: hb (0 = no flag registered) was beaten
    within BG_STALE. A registered flag gone quiet greys out but stays
    registered, so a late /ping turns the card green again; only /working
    v=0 unregisters."""
    return (time.time() - b.get("hb", 0)) < BG_STALE


def _green(b: dict) -> None:
    """A beating flag turns the card green; semantic green states such as note
    and deferred stay exactly what they were."""
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
    owner's shelf, then the lane's held claim), then the machine state. deferred
    wears working's green, rest wears queued grey, and note stays explicit for
    the page to paint with working's green."""
    s = ("done" if b["done"] else "parked" if b.get("parked", False)
         else "working" if _state["busy"].get(b.get("owner", "pastureland")) == b["id"]
         else b["state"])
    return {"deferred": "working", "rest": "queued"}.get(s, s)


def _turn_to_you(b: dict) -> None:
    """The one move that makes a card the owner's turn. The turn register
    flips, the moment is kept so the phone can tell which card turned last,
    and one push goes to every phone subscribed. Callers hold _lock and save
    right after; the push itself runs on its own thread, so no request waits
    on a push service. Exactly two events lead here: a plain reply with no
    live working flag, and a deferred turn handed over when its flag drops
    or expires. A progress note never does."""
    b["ball"] = "you"
    b["turn_ts"] = time.time()
    if _state.get("push_subs"):
        threading.Thread(target=_push_turn, args=(b["id"],), daemon=True).start()


def _handover(b: dict) -> None:
    """A deferred card leaving green: the reply recorded under the flag is
    finally waiting on him, so the turn register flips as the state moves."""
    if b["state"] == "deferred":
        _turn_to_you(b)
        _log("handover", b["id"], "working flag down, deferred turn handed over")


def _release_claim(b: dict) -> str:
    """Consume this box's handed-over messages and free its lane. Messages sent
    while the agent was composing were not in the claim, so they stay pending
    and return to the queue exactly once. Callers hold _lock."""
    ow = b.get("owner", "pastureland")
    claimed = set(_state["claimed"][ow]) if _state["busy"][ow] == b["id"] else set()
    b["pending"] = [m for m in b["pending"] if m["mid"] not in claimed]
    if _state["busy"][ow] == b["id"]:
        _state["busy"][ow] = None
        _state["claimed"][ow] = []
    if b["pending"] and b["id"] not in _state["inbox"]:
        _state["inbox"].append(b["id"])
    if not b["pending"] and b["id"] in _state["inbox"]:
        _state["inbox"].remove(b["id"])
    return ow


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


# ---- the phone page and its push notifications ------------------------------
# GET /m is the board for a phone: one card at a time, the project tabs across
# the top, the card list in a drawer off the left edge. The files below are
# what make it installable and let it be told when a card turns to his turn.
PHONE_FILES = {
    "/m": (HERE / "m.html", "text/html; charset=utf-8"),
    "/m-sw.js": (HERE / "m-sw.js", "application/javascript; charset=utf-8"),
    "/m-manifest.json": (HERE / "m-manifest.json", "application/manifest+json; charset=utf-8"),
    "/m-icon-180.png": (HERE / "assets" / "m-icon-180.png", "image/png"),
    "/m-icon-192.png": (HERE / "assets" / "m-icon-192.png", "image/png"),
    "/m-icon-512.png": (HERE / "assets" / "m-icon-512.png", "image/png"),
}
# Web push without a payload: the push service only has to be told "wake the
# phone's worker", and the worker reads /state itself, so nothing here is
# encrypted and the one piece of cryptography left is the VAPID signature, an
# ES256 JWT. The openssl command line does that, so this file stays standard
# library only: openssl makes the key pair once, into a gitignored file beside
# state.json, and signs each token. The DER signature it prints is turned into
# the raw r||s form the JWT wants, which is plain byte handling.
PUSH_KEY_PATH = HERE / "vapid-key.pem"
PUSH_CONTACT = "mailto:facilitator@localhost"   # the token's sub claim, a contact push services may use
PUSH_TTL = 86400                                # seconds a push may wait for a phone that is off
PUSH_REASON_CHARS = 200                         # of a refusing service's own words, the first this many
_push_lock = threading.Lock()
_push_public: bytes | None = None
_push_tokens: dict = {}                         # audience -> (expiry, token), one token serves an hour


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _openssl(args: list, data: bytes = b"") -> bytes:
    """One openssl command with data on its stdin; the bytes it printed.
    Its own words come back as the error when it fails."""
    r = subprocess.run(["openssl", *args], input=data, capture_output=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace").strip() or "openssl failed")
    return r.stdout


def _push_key_file() -> Path:
    """The P-256 key pair, made on first need and kept beside state.json."""
    with _push_lock:
        if not PUSH_KEY_PATH.is_file():
            pem = _openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout"])
            PUSH_KEY_PATH.write_bytes(pem)
            os.chmod(PUSH_KEY_PATH, 0o600)
    return PUSH_KEY_PATH


def _push_public_key() -> bytes:
    """The 65 byte uncompressed point: the last 65 bytes of the DER public
    key openssl prints, which is what the page hands the browser as the
    application server key and what the k= part of the push header carries."""
    global _push_public
    if _push_public is None:
        der = _openssl(["ec", "-in", str(_push_key_file()), "-pubout", "-outform", "DER"])
        point = der[-65:]
        if len(point) != 65 or point[0] != 4:
            raise RuntimeError("unexpected public key shape from openssl")
        _push_public = point
    return _push_public


def _der_to_raw(sig: bytes) -> bytes:
    """An ECDSA signature as openssl prints it (a DER SEQUENCE of two
    INTEGERs) as the 64 raw bytes a JWT carries: r then s, 32 bytes each."""
    if len(sig) < 8 or sig[0] != 0x30:
        raise ValueError("not a DER signature")
    at = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7F)
    out = b""
    for _ in range(2):
        if sig[at] != 0x02:
            raise ValueError("not a DER signature")
        n = sig[at + 1]
        value = sig[at + 2:at + 2 + n].lstrip(b"\x00")
        if len(value) > 32:
            raise ValueError("not a P-256 signature")
        out += value.rjust(32, b"\x00")
        at += 2 + n
    return out


def _vapid_token(aud: str) -> str:
    """The signed token for one push service origin, twelve hours long and
    reused for an hour so a burst of pushes does not spawn a burst of
    openssl processes."""
    now = int(time.time())
    hit = _push_tokens.get(aud)
    if hit and hit[0] > now:
        return hit[1]
    dumps = lambda obj: _b64url(json.dumps(obj, separators=(",", ":")).encode())
    signing = (dumps({"typ": "JWT", "alg": "ES256"}) + "." +
               dumps({"aud": aud, "exp": now + 12 * 3600, "sub": PUSH_CONTACT}))
    der = _openssl(["dgst", "-sha256", "-sign", str(_push_key_file())], signing.encode())
    token = signing + "." + _b64url(_der_to_raw(der))
    _push_tokens[aud] = (now + 3600, token)
    return token


def _push_one(sub: dict) -> tuple:
    """One payload-less push to one subscription: the status the service
    answered and whatever it said about it, or 0 and the reason it could not be
    reached at all. The body is where a push service explains a refusal, and
    throwing it away is why a whole day of 403s could not be explained."""
    endpoint = sub["endpoint"]
    u = urlparse(endpoint)
    aud = f"{u.scheme}://{u.netloc}"
    req = urllib.request.Request(endpoint, data=b"", method="POST", headers={
        "TTL": str(PUSH_TTL),
        "Authorization": f"vapid t={_vapid_token(aud)}, k={_b64url(_push_public_key())}",
        "Content-Length": "0",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        try:
            said = e.read().decode("utf-8", "replace")
        except OSError:
            said = ""
        return e.code, " ".join(said.split())   # one line, whatever it sent
    except (urllib.error.URLError, OSError) as e:
        return 0, " ".join(str(getattr(e, "reason", "") or e).split())


def _push_turn(bid: str) -> None:
    """Every subscribed phone is told once that a card turned to his turn.
    Runs on its own thread: it only reads the subscriptions under the lock,
    talks to the push services with it released, and takes it again only to
    drop subscriptions the services report gone."""
    with _lock:
        subs = list(_state.get("push_subs", []))
    gone = []
    worked = None
    for sub in subs:
        # the host, never the endpoint: the endpoint is the phone's own address
        # and identifies the device, so it is on the keep-out list
        host = urlparse(sub.get("endpoint", "")).netloc
        try:
            code, said = _push_one(sub)
        except Exception as e:   # a signing failure: reported, never fatal
            _error("pushfail", bid, host=host, reason=str(e))
            continue
        reason = said[:PUSH_REASON_CHARS] if code else ("unreachable " + said).strip()
        _info("push", bid, host=host, status=code or None, reason=reason or None)
        if 200 <= code < 300:
            worked = host
        if code in (404, 410):
            gone.append(sub["endpoint"])
    if gone or worked:
        with _lock:
            if worked:
                # what the next start line reads, so a board coming back up can
                # say when a phone was last actually reached
                _state["push_last_ok"] = {"ts": time.time(), "host": worked}
            if gone:
                _state["push_subs"] = [s for s in _state.get("push_subs", []) if s.get("endpoint") not in gone]
            _save()


class Handler(BaseHTTPRequestHandler):
    def _where(self) -> tuple:
        """This request's route and the card its query names: the two things
        every line about a request carries."""
        url = urlparse(self.path)
        return url.path, (parse_qs(url.query).get("box") or [""])[0]

    def _send(self, code: int, payload: dict | bytes, ctype: str = "application/json") -> bool:
        """True when the response reached the socket, False when the client was
        already gone. Everything that just answers a page ignores the result;
        the /wait hand-off reads it, because a claim written into a dead
        connection has to be rolled back rather than counted as delivered.
        Swallowing the failure here silently was what made that rollback
        unreachable."""
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        if code >= 400:
            # Every refusal in this file leaves through this one door, so one
            # added a year from now is written down without anybody remembering
            # to write it down. A refusal is the server working correctly and
            # saying no, so it is INFO and not an error, and the reason is the
            # sentence the caller already wrote for the page: the log and the
            # page agree by construction rather than by being kept in step.
            route, box = self._where()
            _info("refusal", box, route=route, code=code,
                  reason=payload.get("error") if isinstance(payload, dict) else None)
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
            route, box = self._where()
            _debug("hungup", box, route=route)
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
        elif url.path == "/worktrees":
            # the names the card's top bar offers, straight out of git. no lock:
            # nothing here reads or writes the board's state, it only asks the
            # lane's own folder what worktrees it has
            q = parse_qs(url.query)
            owner = (q.get("owner") or ["facilitator"])[0]
            if owner not in OWNERS:
                self._send(400, {"error": "unknown owner"})
                return
            self._send(200, _lane_worktrees(owner))
        elif url.path == "/unread":
            # a lane's unread count in one line, for a Stop hook deciding
            # whether the agent may go idle and for a human checking a lane
            # without reading the whole board. Read only: it claims nothing,
            # releases nothing and sweeps nothing
            q = parse_qs(url.query)
            owner = (q.get("owner") or ["pastureland"])[0]
            if owner not in OWNERS:
                self._send(400, {"error": "unknown owner"})
                return
            with _lock:
                held = set(_state["claimed"].get(owner) or [])
                # anything not already in the claim is still waiting, including
                # messages that landed on a held card after it was claimed
                queued = sum(1 for b in _state["boxes"]
                             if b.get("owner", "pastureland") == owner
                             for m in b["pending"] if m["mid"] not in held)
                self._send(200, {"queued": queued, "claimed": len(held)})
        elif url.path == "/wait":
            q = parse_qs(url.query)
            timeout = float(q.get("timeout", ["570"])[0])
            owner = (q.get("owner") or ["pastureland"])[0]  # default: the pre-routing loop's role
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
            owner = (q.get("owner") or ["pastureland"])[0]
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
            legacy_reply_rows = True
            try:
                with TRANSCRIPT_PATH.open() as f:
                    for line in f:
                        try:
                            e = json.loads(line)
                        except ValueError:
                            continue
                        if not isinstance(e, dict):
                            continue
                        if _is_reply_schema_boundary(e):
                            legacy_reply_rows = False
                            continue
                        if e.get("box") == tbid and e.get("kind") in ("user", "agent", "note"):
                            item = {"kind": e["kind"], "text": e.get("text", ""), "ts": e.get("ts", 0)}
                            if e.get("kind") in ("agent", "note"):
                                if "reply_full" in e or "reply_short" in e:
                                    full = e.get("reply_full", e.get("text", ""))
                                    short = e.get("reply_short", full)
                                elif legacy_reply_rows:
                                    # Only rows physically before the persisted
                                    # schema marker get legacy compatibility.
                                    # Timestamps never decide data representation.
                                    short, full = _legacy_reply_variants(e.get("text", ""))
                                else:
                                    full = short = e.get("text", "")
                                item.update({"text": full, "replyFull": full, "replyShort": short})
                            out.append(item)
            except FileNotFoundError:
                pass
            self._send(200, {"messages": out[-n:]})
        elif url.path == "/log":
            n = int((parse_qs(url.query).get("lines") or ["120"])[0])
            try:
                lines = _log_file().read_text(errors="replace").splitlines()[-n:]
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
        elif url.path == "/cm-markdown.js":
            # the vendored editor, one prebuilt file beside index.html. The page
            # asks for it the first time the markdown panel is opened and never
            # on boot, so a board nobody edits markdown on pays nothing for it
            p = HERE / "cm-markdown.js"
            if p.is_file():
                self._send(200, p.read_bytes(), "application/javascript; charset=utf-8")
            else:
                self._send(404, {"error": "not found"})
        elif url.path == "/card-markdown.js":
            p = HERE / "card-markdown.js"
            if p.is_file():
                self._send(200, p.read_bytes(), "application/javascript; charset=utf-8")
            else:
                self._send(404, {"error": "not found"})
        elif url.path == "/card-tokens.css":
            p = HERE / "card-tokens.css"
            if p.is_file():
                self._send(200, p.read_bytes(), "text/css; charset=utf-8")
            else:
                self._send(404, {"error": "not found"})
        elif url.path == "/card-logic.js":
            p = HERE / "card-logic.js"
            if p.is_file():
                self._send(200, p.read_bytes(), "application/javascript; charset=utf-8")
            else:
                self._send(404, {"error": "not found"})
        elif url.path == "/m-manifest.json":
            # the install prompt reads the app's name from here and the page
            # reads its own from the board title, so a name written into the
            # file could only ever disagree with it. That one field is answered
            # from the saved title; every other field is the file's own, and a
            # board with no title leaves even that alone
            p, ctype = PHONE_FILES[url.path]
            if not p.is_file():
                self._send(404, {"error": "not found"})
                return
            raw = p.read_bytes()
            try:
                manifest = json.loads(raw)
            except ValueError:
                manifest = None
            if isinstance(manifest, dict):
                with _lock:
                    title = (_state.get("title") or "").strip()
                if title:
                    manifest["name"] = title
                    manifest["short_name"] = title
                raw = json.dumps(manifest, indent=2).encode()
            self._send(200, raw, ctype)
        elif url.path in PHONE_FILES:
            # the phone page and the files that make it installable, each a
            # plain file beside this one (the icons under assets/). Served
            # with the no-store every answer carries, so a changed page or
            # worker is picked up on the next open rather than a cache later
            p, ctype = PHONE_FILES[url.path]
            if p.is_file():
                self._send(200, p.read_bytes(), ctype)
            else:
                self._send(404, {"error": "not found"})
        elif url.path == "/push/key":
            try:
                key = _b64url(_push_public_key())
            except Exception as e:
                self._send(500, {"error": f"push key unavailable: {e}"})
                return
            self._send(200, {"key": key})
        elif url.path == "/mdfiles":
            # what the markdown panel lists: every .md under the two folders the
            # lane in the query owns, each one re-checked for containment rather
            # than trusted because it came out of a walk. A folder that does not
            # exist yet, or holds nothing, comes back present and empty, so the
            # panel can say so instead of looking broken. The kind each folder
            # answers to goes back with it, since that is what the page labels
            # its two tabs with and it is the only part of the name a lane's
            # panel can know before it has asked
            lane = (parse_qs(url.query).get("lane") or [""])[0]
            roots = []
            for kind, base in _md_roots(lane):
                files = []
                try:
                    for p in sorted(base.rglob("*.md")):
                        if any(part.startswith(".") for part in p.relative_to(base).parts):
                            continue   # hidden files and hidden folders stay out of sight
                        real = _md_path(lane, base.name, str(p.relative_to(base)))
                        if real is None or not real.is_file():
                            continue   # a symlink pointing out of the folder ends here
                        st = real.stat()
                        files.append({"rel": str(p.relative_to(base)), "name": p.name,
                                      "mtime": str(st.st_mtime_ns), "size": st.st_size})
                except OSError:
                    pass
                roots.append({"root": base.name, "kind": kind,
                              "exists": base.is_dir(), "files": files})
            self._send(200, {"roots": roots})
        elif url.path == "/mdfile":
            # one markdown file's whole text, with the stamp the save guard will
            # want back. Not decoded loosely: a file that is not utf-8 is
            # reported as such rather than handed over with replacement
            # characters that a later save would then write back over the real
            # bytes
            q = parse_qs(url.query)
            p = _md_path((q.get("lane") or [""])[0], (q.get("root") or [""])[0],
                         (q.get("rel") or [""])[0])
            if p is None:
                self._send(400, {"error": "outside the markdown folders"})
                return
            if not p.is_file():
                self._send(404, {"error": "no such file"})
                return
            try:
                text = p.read_bytes().decode("utf-8")
            except UnicodeDecodeError:
                self._send(400, {"error": "not utf-8 text"})
                return
            except OSError:
                self._send(400, {"error": "unreadable file"})
                return
            # windows line endings are carried to the page rather than silently
            # flattened: the editor is told to keep them so a save writes the
            # file back in the endings it arrived in
            self._send(200, {"root": (q.get("root") or [""])[0],
                             "rel": (q.get("rel") or [""])[0],
                             "text": text, "mtime": _md_stamp(p),
                             "crlf": "\r\n" in text})
        else:
            self._send(404, {"error": "not found"})

    def _ui_state(self) -> dict:
        st = _state
        qpos, seen = {}, {ow: 0 for ow in OWNERS}  # queue position within each owner's lane
        for i in st["inbox"]:
            ow = (_box(i) or {}).get("owner", "pastureland")
            seen[ow] += 1
            qpos[i] = seen[ow]
        return {
            "boxes": [
                {
                    "id": b["id"], "bucket": b["bucket"], "title": b["title"],
                    # reply remains the full-text compatibility field for older
                    # clients. Current surfaces consume the explicit variants.
                    "reply": b.get("reply_full", b.get("reply", "")),
                    "replyFull": b.get("reply_full", b.get("reply", "")),
                    "replyShort": b.get("reply_short", b.get("reply_full", b.get("reply", ""))),
                    "done": b["done"], "replies": b["replies"],
                    "ball": b.get("ball", "you"),
                    "parked": b.get("parked", False),
                    "ts": b.get("ts", 0),
                    "context": b.get("context", ""),
                    "owner": b.get("owner", "pastureland"),
                    "pending": len(b["pending"]),
                    "pendingTexts": [m["text"] for m in b["pending"]],
                    # send times matching pendingTexts one to one; 0 for
                    # entries queued before times were recorded, which the
                    # page shows unstamped
                    "pendingStamps": [m.get("ts", 0) for m in b["pending"]],
                    "ws": b.get("ws"), "task": b.get("task"),
                    # the card's own worktree, empty for a card that has never
                    # been moved; the bar reads the lane's standing branch then
                    "worktree": b.get("worktree", ""),
                    "agentTs": b.get("agent_ts", 0),
                    # replies already read, the board's record rather than one
                    # browser's: the page bolds a card whose reply count has
                    # passed this, on whichever device is looking
                    "seen": b.get("seen", 0),
                    # when the card last turned to his turn: the phone's push
                    # handler reads /state and names the card that turned last
                    "turnTs": b.get("turn_ts", 0),
                    "engine": b.get("engine", "claude"),
                    "writing": st["busy"][b.get("owner", "pastureland")] == b["id"],
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
            # the one tab bar both pages draw: the lane order and the lanes he
            # has closed. An empty order means no arrangement has been saved
            "tabs": st.get("tabs", {"order": [], "closed": []}),
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
                                 for b in st["boxes"] if b.get("owner", "pastureland") == ow),
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
                                if (_box(i) or {}).get("owner", "pastureland") == owner), None)
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
                                                if (_box(i) or {}).get("owner", "pastureland") == owner),
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
                        (_box(i) or {}).get("owner", "pastureland") == owner for i in _state["inbox"]):
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

        if url.path == "/mdsave":
            # answered up here, above the shared body read, because that read
            # strips the text: a markdown file's trailing newline is content and
            # losing it would break the round trip on the very first save
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            p = _md_path((q.get("lane") or [""])[0], (q.get("root") or [""])[0],
                         (q.get("rel") or [""])[0])
            if p is None:
                self._send(400, {"error": "outside the markdown folders"})
                return
            if not p.is_file():
                self._send(404, {"error": "no such file"})
                return
            try:
                raw.decode("utf-8")
            except UnicodeDecodeError:
                self._send(400, {"error": "not utf-8 text"})
                return
            # the stale-write guard: the stamp the page was handed on read comes
            # back here, and a file whose stamp has moved since is one somebody
            # else has written. Refused with the current stamp so the page can
            # say plainly what happened; his text is never merged or dropped for
            # him, it stays in the editor where he can still see it
            try:
                now = _md_stamp(p)
            except OSError:
                self._send(400, {"error": "unreadable file"})
                return
            was = (q.get("mtime") or [""])[0]
            if was and was != now:
                self._send(409, {"error": "changed on disk", "mtime": now})
                return
            # written the way state.json is written: a temp file beside it, then
            # one rename, so a reader never sees a half-written file. The temp
            # name appends rather than replaces the suffix, so it can never
            # collide with a real neighbour of the same stem
            tmp = p.with_name(p.name + ".tmp")
            try:
                tmp.write_bytes(raw)
                os.replace(tmp, p)
            except OSError as e:
                tmp.unlink(missing_ok=True)
                self._send(400, {"error": str(e)})
                return
            self._send(200, {"ok": True, "mtime": _md_stamp(p)})
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
                box["parked"] = False
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
                if bid not in _state["inbox"] and _state["busy"][box.get("owner", "pastureland")] != bid:
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
                ow = (q.get("owner") or ["pastureland"])[0]
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
                if "quiet" in q:
                    self._send(400, {"error": "quiet replies were removed; use /note for progress"})
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
                ow = box.get("owner", "pastureland")
                # The compact version is data, not punctuation inside the full
                # prose. keep_blank_values distinguishes an intentionally empty
                # small card from an omitted version, which mirrors the full one.
                short_values = parse_qs(url.query, keep_blank_values=True).get("short")
                short = short_values[0].strip() if short_values is not None else None
                # a message typed in the small card gets a small answer back:
                # that card is a few lines tall and a long reply is unreadable
                # in it. The newest message the claim covers is the one being
                # answered, so that one decides. Refused outright like the
                # context strip above, never silently chopped
                held = _state["claimed"][ow] if _state["busy"][ow] == bid else []
                answering = next((m for m in box["pending"] if m["mid"] == held[-1]), None) if held else None
                if answering is not None and answering.get("via") == "mini":
                    words = len((text if short is None else short).split())
                    if words > 100:
                        self._send(400, {"error": f"small card reply over 100 words: {words} words"})
                        return
                _last_wait[ow] = time.time()  # a reply proves that agent is alive too
                _set_reply_variants(box, text, short)
                box["replies"] += 1
                # The machine's sole answer move, taken once the claim is let
                # go below. While a working flag beats, the final turn waits in
                # deferred and is handed over when that work ends.
                box["agent_ts"] = time.time()  # when the agent last replied
                box["ts"] = time.time()
                if ctx:
                    box["context"] = ctx
                _release_claim(box)
                if _hb_live(box):
                    box["state"] = "deferred"
                else:
                    _turn_to_you(box)
                    box["state"] = _rest(box)
                _log("agent", bid, text, reply_full=text,
                     reply_short=box["reply_short"],
                     reply_variants_version=REPLY_VARIANTS_VERSION)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True})

            elif url.path == "/note":
                # The sole background-progress action. It releases a held claim,
                # owns an explicit note state and keeps the turn with the agent,
                # so it can never turn yellow when its heartbeat ends.
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                ctx = (q.get("ctx") or [""])[0].strip()
                if ctx and len(ctx.split()) > 50:
                    self._send(400, {"error": "context strip over 50 words"})
                    return
                ow = box.get("owner", "pastureland")
                _last_wait[ow] = time.time()  # a note proves that agent is alive too
                _set_reply_variants(box, text)
                box["replies"] += 1
                box["agent_ts"] = time.time()
                box["ts"] = time.time()
                if ctx:
                    box["context"] = ctx
                _release_claim(box)
                box["ball"] = "me"
                box["hb"] = time.time()
                box["state"] = "note"
                _log("note", bid, text, reply_full=text, reply_short=text,
                     reply_variants_version=REPLY_VARIANTS_VERSION)
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

            elif url.path == "/worktree":
                # the card's own worktree, held on the card and not guessed from
                # a text convention. empty means the lane's standing branch,
                # which is what the bar falls back to, so a card that has never
                # been moved carries nothing and still shows a true name
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                name = (q.get("name") or [""])[0]
                if name and name not in _lane_worktrees(box.get("owner", "pastureland"))["names"]:
                    self._send(400, {"error": "unknown worktree"})
                    return
                box["worktree"] = name
                _log("worktree", bid, name)
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
                    "reply_full": "", "reply_short": "",
                    "pending": [], "done": False, "parked": False, "replies": 0,
                    "state": "new", "hb": 0,
                    "ball": "me", "ts": time.time(), "owner": owner,
                    "ws": ws0, "task": None, "agent_ts": 0, "seen": 0,
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
                if slug in RETIRED_OWNERS:
                    self._send(400, {"error": "reserved owner"})
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
                # the folder's own name is written down, never the path to it:
                # a lane's directory is one line away from a home directory
                _log("project", slug, f"{name} -> {d}", log_fields={"folder": d.name})
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "id": slug, "name": name, "dir": str(d)})

            elif url.path == "/close":
                box = _box(bid)
                if box is None:
                    self._send(400, {"error": "bad box"})
                    return
                action = _close_box(box)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "action": action})

            elif url.path == "/delete":
                box = _box(bid)
                if box is None or box["bucket"] != "meta":
                    self._send(400, {"error": "only meta boxes can be deleted"})
                    return
                # Compatibility for already-open pages and other old clients:
                # the current persisted record decides, never their stale copy.
                action = _close_box(box)
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "action": action})

            elif url.path == "/ws/goal":
                ow = (q.get("owner") or [""])[0]
                if ow not in OWNERS:
                    self._send(400, {"error": "unknown owner"})
                    return
                w = _ws(ow, (q.get("ws") or [""])[0])
                if w is None:
                    self._send(400, {"error": "unknown workspace"})
                    return
                w["goal"] = text
                _log("goal", w["id"], text)
                _save()
                self._send(200, {"ok": True})

            elif url.path == "/ws/task":
                ow = (q.get("owner") or [""])[0]
                if ow not in OWNERS:
                    self._send(400, {"error": "unknown owner"})
                    return
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
                ow = (q.get("owner") or [""])[0]
                if ow not in OWNERS:
                    self._send(400, {"error": "unknown owner"})
                    return
                w = _ws(ow, (q.get("ws") or [""])[0])
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
                ow = box.get("owner", "pastureland") if box else None  # heartbeats
                if box is None or _state["busy"].get(ow) != bid:
                    self._send(400, {"error": "not holding this box"})
                    return
                _set_reply_variants(box, text)
                box["ts"] = time.time()
                _state["busy_ts"][ow] = time.time()   # resets the 15-min steal
                _log("progress", bid, text, reply_full=text, reply_short=text,
                     reply_variants_version=REPLY_VARIANTS_VERSION)
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
                ow = box.get("owner", "pastureland")
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

            elif url.path == "/push/subscribe":
                # the phone's push subscription, kept whole so a push can be
                # addressed to it; one record per endpoint, the newest wins
                try:
                    sub = json.loads(text) if text else None
                except ValueError:
                    sub = None
                endpoint = sub.get("endpoint") if isinstance(sub, dict) else None
                if (not isinstance(endpoint, str) or len(endpoint) > 2048
                        or not endpoint.startswith(("https://", "http://"))):
                    self._send(400, {"error": "bad subscription"})
                    return
                keys = sub.get("keys") if isinstance(sub.get("keys"), dict) else {}
                rec = {"endpoint": endpoint,
                       "keys": {k: str(v) for k, v in keys.items() if k in ("p256dh", "auth")},
                       "ts": time.time()}
                subs = [s for s in _state.get("push_subs", []) if s.get("endpoint") != endpoint]
                subs.append(rec)
                _state["push_subs"] = subs
                _save()
                self._send(200, {"ok": True, "count": len(subs)})

            elif url.path == "/tabs":
                # the tab bar's whole record in one write, so a reorder can
                # never half land: the lane order and the lanes he has closed
                # arrive together and replace what was stored
                try:
                    rec = json.loads(text) if text else None
                except ValueError:
                    rec = None
                if (not isinstance(rec, dict) or not isinstance(rec.get("order"), list)
                        or not isinstance(rec.get("closed"), list)):
                    self._send(400, {"error": "bad tab record"})
                    return
                # every id is checked before anything is stored, so a record
                # naming a lane this board does not have changes nothing
                clean = {}
                for field in ("order", "closed"):
                    ids = []
                    for ow in rec[field]:
                        if not isinstance(ow, str) or ow not in OWNERS:
                            self._send(400, {"error": "unknown owner"})
                            return
                        if ow not in ids:   # a repeat is the same tab twice; keep the first
                            ids.append(ow)
                    clean[field] = ids
                _state["tabs"] = clean
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "tabs": clean})

            elif url.path == "/seen":
                # the read marks: for each card named, how many of its replies
                # he has read. One record per card on the board itself, so the
                # phone and the board can never disagree about what is unread
                try:
                    rec = json.loads(text) if text else None
                except ValueError:
                    rec = None
                if not isinstance(rec, dict) or not rec:
                    self._send(400, {"error": "bad seen record"})
                    return
                marks = []
                for bid_, n in rec.items():
                    box = _box(bid_)
                    if box is None:
                        self._send(400, {"error": "bad box"})
                        return
                    # a bool is an int in this language and is not a count
                    if isinstance(n, bool) or not isinstance(n, int) or n < 0:
                        self._send(400, {"error": "bad count"})
                        return
                    marks.append((box, n))
                out = {}
                for box, n in marks:
                    box["seen"] = n
                    out[box["id"]] = n
                _save()
                _lock.notify_all()
                self._send(200, {"ok": True, "seen": out})

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


# why this process is stopping, set by the signal handler in main and read by
# the stop line on the way out; None until something asks it to stop
_stop_reason: str | None = None


def main() -> None:
    class QuietServer(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            et = sys.exc_info()[0]
            if et in (BrokenPipeError, ConnectionResetError):
                return  # dropped connections are routine here, never worth a traceback
            super().handle_error(request, client_address)

    def stopping(signum, frame) -> None:
        """Ctrl-C, a kill, or the terminal closing: the reason is remembered and
        the ordinary shutdown below runs, so the file gets a stop line to match
        its start line. A start with no matching stop was all the file
        remembered about a restart, which is why one could not be explained."""
        global _stop_reason
        _stop_reason = signal.Signals(signum).name
        raise SystemExit(0)

    for stopper in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(stopper, stopping)

    # Own the listening socket before touching durable board data. In
    # particular, a replacement started while the old server still owns the
    # port must not migrate state or append the transcript schema boundary: the
    # old process can still append legacy rows until it has actually stopped.
    try:
        server = QuietServer(("127.0.0.1", PORT), Handler)
    except OSError as error:
        _error("bindfail", port=PORT,
               reason=f"facilitator could not listen on 127.0.0.1:{PORT}: {error}")
        raise SystemExit(1) from None

    try:
        INTERNAL_UPLOADS.mkdir(parents=True, exist_ok=True)
        try:
            _load()
        except OwnerMigrationRequired as e:
            _error("startuprefused", reason=str(e))
            sys.exit(f"startup refused: {e}")
        with _lock:
            _state["busy"] = {ow: None for ow in OWNERS}  # a restart never resumes mid-claim
            _state["claimed"] = {ow: [] for ow in OWNERS}
            _state["ack"] = {ow: None for ow in OWNERS}   # and no token outlives it
            # re-queue any box that still has unanswered messages
            for b in _state["boxes"]:
                if b["pending"] and b["id"] not in _state["inbox"]:
                    _state["inbox"].append(b["id"])
            _save()
        pushed = _state.get("push_last_ok") or {}
        _info("start", port=PORT, boxes=len(_state["boxes"]), log_level=LOG_LEVEL,
              push_ok=pushed.get("ts"), push_host=pushed.get("host"))
        server.serve_forever()
    finally:
        # one stop line for every start line, and it says why: a named signal,
        # the exception that ended it, or the loop simply returning
        ended = sys.exc_info()[0]
        _info("stop", reason=_stop_reason or (ended.__name__ if ended else "end of stream"))
        server.server_close()


if __name__ == "__main__":
    main()
