"""Triage facilitator — thinnest possible local server.

One page, one state file. The human types into per-item boxes; messages queue
FIFO; the agent (Claude, in the terminal session that launched this) drains the
queue one box at a time via GET /wait (long-poll) and answers via POST /reply.

Endpoints:
  GET  /                    -> index.html, the card board
  GET  /page                -> page.html, the same lanes drawn as one typed page
  GET  /state               -> full UI state (page polls this), with rev, the
                               board's revision: every saved change moves it
  GET  /m/state[?since=R][&ops=A,B] -> what the phone reads: {rev, changed,
                               live, ...}. With since naming the revision the
                               phone already holds and nothing saved since,
                               only rev, changed:false and the live section
                               (who is listening) come back; otherwise the
                               cards with the fields the phone draws, the
                               title, the tabs and the lanes as well. ops
                               names up to 32 operation ids and each is
                               answered {status: applied|unknown, result} in
                               the same reading
  GET  /op?id=OP            -> one operation id's receipt: {status, kind, box,
                               result, rev}; status unknown for an id the board
                               holds no receipt of. A receipt is kept well past
                               the point a phone stops retrying (never let go
                               while younger than OP_EVICT_FLOOR, and at most
                               OP_RETENTION), so unknown for an id a client
                               could still be sending means it never landed; a
                               much later query cannot tell a never-landed id
                               from one whose receipt has since aged out
  POST /send?box=ID[&via=mini][&op=OP] -> body = the human's message text (plain text).
                               via states where he typed it: mini is the small
                               card in the corner, no via at all is the big card
                               in the middle. Only the literal "mini" is stored
                               (as the message's via field), so any other value
                               and any older caller land exactly as before.
                               Sending to a parked card also brings it back to
                               Doing in the same saved update. op is an
                               operation id the caller minted before its first
                               try, 8 to 64 letters, digits, - or _: the result
                               {ok, mid, box, rev} is committed beside the
                               message itself, the same id sent again answers
                               that result with replayed:true and stores
                               nothing, and the same id with other words is a
                               409. A receipt is never let go while a phone
                               could still be sending its id, so a retry always
                               finds it rather than landing twice. A send with
                               no op lands as it always did and is never
                               deduplicated
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
  POST /create?owner=O[&op=OP] -> body's first line titles a new meta box (empty =
                               "…", named later by its first message); ids m1, m2...;
                               owner defaults to facilitator. Answers {ok, id,
                               rev, card}, the card in the phone's shape. op
                               is an operation id, as on /send: the same id
                               again answers the first try's id and makes no
                               second card
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
  POST /upload?name=F       -> body = raw attachment bytes; saves to the sibling internal
                               folder ../facilitator-internal/uploads/ (outside the
                               repo, never pushed), returns {"url": "/uploads/..."}
                               unchanged; GET /uploads/<file> serves it back
  GET  /uploads/<file>      -> a previously uploaded attachment: served from the internal
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
                               types in IMG_TYPES are served; anything else,
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
  GET  /compose-format.js   -> the composer's typed formatting: the setting,
                               and the editor layer the card pages put over a
                               composer while it is on
  GET  /m                   -> m.html, the phone page: the project tabs, one
                               card filling the screen, the card list in a
                               drawer off the left edge, nothing else
  GET  /m-manifest.json, /m-sw.js, /m-icon-<size>.png, /m-splash-squid.png
                            -> what makes the phone page installable: its web
                               app manifest, its service worker (network
                               first, shows the push notifications), its
                               home screen icons, cut from the board's own mark,
                               and the mark on its own with no background, which
                               the page paints this phone's home screen launch
                               image from.
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
                               push with that event's encrypted card id and
                               title goes to every subscription
                               only while Tailscale is connected and its HTTPS
                               Serve proxy targets this board. The push is
                               signed with a VAPID token openssl produces; the
                               phone's worker uses that event identity directly.
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
  POST /clientlog           -> body = {"page": "board"|"phone"|"page",
                               "reports": [...]}: what a page noticed and has no
                               other way to say. One report per thrown error,
                               rejected promise, failed request, failed render
                               or timer that ran late, each carrying its kind,
                               its message, where it happened, the card that was
                               open and how many times it repeated. Never any
                               card text. The pages batch these and send them on
                               page hide through sendBeacon. Written to
                               client-DATE.jsonl beside the server's own log, at
                               most 10 writes per key per minute with the excess
                               dropped and counted, at most 20 reports per batch
                               and 500 characters per string field. A batch this
                               board cannot read is a 400 with nothing stored, a
                               body over 16 KB a 413. Phone incident histories
                               use a strict versioned schema, 40 events from
                               at most 60 seconds, and four writes per minute
                               across all incident reasons. Their confirmed
                               response follows a successful log write/flush
  GET  /thread?box=ID&n=N   -> last N user/agent/note messages of a box from the
                               transcript (read by the quick chat panel and the
                               page view's own stepper)
  GET  /history?box=ID      -> {"replies": [...]}: one card's older final
                               replies, oldest first, without the one the card
                               is showing and without its progress notes, at
                               most HISTORY_MAX of them. What the reply-history
                               arrows walk, and the same rule that decides the
                               olderReplies count sent with the card, so the
                               marks a page draws before it asks and the list
                               it gets when it does agree. The filter runs
                               before the cap, so a long run of notes since the
                               last answer cannot push the answers out of the
                               window, and the live page is left out by the
                               card's own record rather than by matching text
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
  POST /pages/new?owner=O   -> add a blank view page to O's page list and answer
                               {ok, id, pages}. A view page is one of the
                               environments a project can be looked at in: the
                               board page every project starts with, and blank
                               pages added since. It holds no cards and no
                               conversations of its own, so adding or removing
                               one moves no card, no workspace and no task. At
                               most PAGE_LIMIT per project; past that a 400
  POST /pages/del?owner=O&id=P -> remove one view page and answer {ok, pages}.
                               The project's cards, its conversations and its
                               internal workspaces are untouched; any page may
                               go, the board page included, and a project whose
                               pages have all been removed keeps an empty list
                               rather than being given a new one
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

import asyncio
import base64
import contextlib
import fcntl
import hashlib
import json
import logging
import logging.handlers
import os
import re
import random
import secrets
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlparse, quote, unquote

HERE = Path(__file__).resolve().parent
RETIRED_OWNERS = frozenset({"triage"})

# ---- the log ----------------------------------------------------------------
# One event per line, as JSON, in a dated file, and that file is the only place
# the server's output lands. A terminal gets the same event in a short human
# form as well, but only when there is a terminal on the other end of standard
# output: a server started by hand should say what it is doing, and a server
# started by the CLI has nobody reading and would only be writing everything
# twice. Three levels and no more: INFO is what happened and is on by default,
# DEBUG is the noise switched on while hunting, ERROR is something that failed
# and was not meant to.
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

    def __init__(self, folder: Path, stem: str, suffix: str, delay: bool = False) -> None:
        self.folder, self.stem, self.suffix = folder, stem, suffix
        self.day, self.roll = time.strftime("%Y%m%d"), 0
        folder.mkdir(parents=True, exist_ok=True)
        super().__init__(str(self._file()), maxBytes=LOG_MAX_BYTES,
                         backupCount=0, encoding="utf-8", delay=delay)

    def _file(self) -> Path:
        """<stem>-<day><suffix>, and <stem>-<day>.1<suffix> for a second roll
        on the same day."""
        return self.folder / (f"{self.stem}-{self.day}"
                              + (f".{self.roll}" if self.roll else "") + self.suffix)

    def emit_confirmed(self, record: logging.LogRecord) -> None:
        """The manual phone marker needs to know whether its file was written.
        Standard logging swallows write errors; this path uses the same file,
        formatter and rotation but lets its caller answer failure honestly."""
        self.acquire()
        try:
            if self.shouldRollover(record):
                self.doRollover()
            if self.stream is None:
                self.stream = self._open()
            self.stream.write(self.format(record) + self.terminator)
            self.flush()
        finally:
            self.release()

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
    # A watching terminal sees INFO and above, in human form: JSON in a terminal
    # is unreadable, and making the terminal readable by making the file
    # unstructured would give up reading the file back with json.loads. Only a
    # terminal, though. Started any other way there is nobody on the other end
    # of standard output, and a copy written there is the same events a second
    # time in a second place, which is what this stopped doing.
    if sys.stdout is not None and sys.stdout.isatty():
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


# ---- the transport's libraries -------------------------------------------------
# uvicorn speaks HTTP and Starlette routes the requests; both are installed
# into the .venv beside this file from requirements.txt. Imported here, after
# the logger exists, so a board started without them writes one line saying
# so and says one sentence on the terminal, instead of dying of an import
# nobody is there to read.
try:
    import anyio
    import h11
    import http_ece
    import uvicorn
    from cryptography.hazmat.primitives.asymmetric import ec
    from starlette.applications import Starlette
    from starlette.concurrency import run_in_threadpool
    from starlette.requests import ClientDisconnect, Request
    from starlette.responses import Response, FileResponse
    from starlette.routing import Route
    from uvicorn.protocols.http.h11_impl import H11Protocol
except ImportError:
    _error("startuprefused", reason="requirements are not installed")
    setup = ("uv pip sync --python .venv/bin/python requirements.txt"
             if (HERE / ".venv").is_dir()
             else "uv venv .venv, then uv pip sync --python .venv/bin/python requirements.txt")
    sys.exit("facilitator needs the packages in requirements.txt: beside server.py run " + setup + ", "
             "then start the board with .venv/bin/python3 server.py or facilitator run")


CRASH_FRAMES = 12           # frames a crash line walks back through, innermost last
CRASH_MESSAGE_CHARS = 200   # of an exception's own words, the first this many
# What an exception's message may be made of for a line to carry it at all:
# plain words and the punctuation a sentence needs. An interpreter phrases some
# messages by quoting the value it choked on, and that value can be text out of
# a request, so a message that is anything but plain words is dropped whole and
# the line names the type alone.
CRASH_PLAIN = frozenset("abcdefghijklmnopqrstuvwxyz"
                        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.:;()-")


def _crash_fields(error: BaseException) -> dict:
    """What a crash line says about an exception that got away, with nothing in
    it that is a path or could be something a caller sent.

    The type is always safe to write down and is what a line always carries.
    The message is checked before it is kept, by the rule above. The place is
    the innermost frame, named by the file's own name and never by where that
    file sits, and the frames behind it are the same three parts each: enough
    to walk back to the line without printing a machine's folders."""
    walked = [f"{os.path.basename(frame.filename)}:{frame.name}:{frame.lineno}"
              for frame in traceback.extract_tb(error.__traceback__)[-CRASH_FRAMES:]]
    words = str(error)
    return {"error": type(error).__name__,
            "message": words[:CRASH_MESSAGE_CHARS] if words and set(words) <= CRASH_PLAIN else None,
            "where": walked[-1] if walked else None,
            "frames": walked or None}


def _log_file() -> Path:
    """What GET /log tails: the day's server file, unless FACILITATOR_LOG names
    another one, which is the override that route has always had."""
    named = os.environ.get("FACILITATOR_LOG")
    return Path(named) if named else LOG_DIR / f"server-{time.strftime('%Y%m%d')}.log"


# ---- what the pages report ---------------------------------------------------
# The pages have no other way to say that something broke: 41 empty catch blocks
# and 61 swallowing .catch tails turn a failure into silence. A report is one
# thing a page noticed, and it goes in its own file beside the server's, never
# into the transcript. The caps below are what bound the disk: a page's own
# counters die on reload, so a page throwing during boot and reloading in a
# cycle has fresh counters every time and only the server's cap is a cap.
CLIENT_PAGES = ("board", "phone", "page")
CLIENT_KINDS = ("error", "rejection", "fetch", "render", "slow", "incident")
CLIENT_MAX_BODY = 16 * 1024   # bytes in one batch
CLIENT_MAX_REPORTS = 20       # reports in one batch
CLIENT_MAX_CHARS = 500        # characters of any one string a report carries
CLIENT_PER_MINUTE = 10        # writes per key per minute; the rest are dropped and counted
CLIENT_WINDOW = 60.0          # the minute that cap is measured over
CLIENT_KEYS_KEPT = 512        # keys the cap remembers before the stale ones are swept
# what a report may carry at all; anything else a page sends is dropped here
CLIENT_FIELDS = ("message", "file", "line", "col", "count", "late", "doing", "route")
INCIDENT_PER_MINUTE = 4      # one key, regardless of reason, card or operation
INCIDENT_EVENTS = frozenset(("create", "select", "focus", "send", "operation", "request",
                            "render", "drawer", "viewport", "lifecycle", "problem", "freeze", "mark"))
INCIDENT_REASONS = ("manual", "slow-ui", "slow-request", "invariant", "problem", "freeze")
INCIDENT_NUMBERS = {"ms": 600000, "seq": 1000000000, "status": 599, "serverMs": 600000,
                    "rev": 1000000000000, "boxes": 10000, "vh": 10000, "vt": 10000,
                    "late": 600000, "resume": 1000000000}
INCIDENT_FLAGS = frozenset(("present", "shown", "title", "titled", "emptyTitle", "editing", "known",
                            "kb", "lifting", "visible", "online"))
INCIDENT_CHOICES = {"phase": ("start", "end"), "route": ("/send", "/create", "/m/state"),
                    "side": ("left", "right"), "source": ("settings", "shortcut"),
                    "outcome": ("minted", "applied", "retry", "unsure", "failed"),
                    "lifecycle": ("start", "hidden", "visible", "pageshow", "online", "offline"),
                    "problem": ("error", "rejection", "render", "fetch"), "reason": INCIDENT_REASONS}
INCIDENT_BOX = re.compile(r"(?:[mt]?\d+(?:\.\d+)*|q)", re.ASCII)
INCIDENT_OP = re.compile(r"(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})")


def _incident_integer(value, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _incident_box(value) -> bool:
    return isinstance(value, str) and len(value) <= 32 and (not value or bool(INCIDENT_BOX.fullmatch(value)))


def _incident_valid(page: str, report: dict) -> bool:
    """No free text and no nested data except the bounded event list. Reject
    unknown fields and bad types before any part of a batch reaches a log."""
    if (page != "phone" or set(report) != {"kind", "v", "reason", "marked", "box", "lost", "suppressed", "events"}
            or type(report["v"]) is not int or report["v"] != 1
            or report["reason"] not in INCIDENT_REASONS or not _incident_box(report["box"])
            or not _incident_integer(report["marked"], 0, 10000000000000)
            or not _incident_integer(report["lost"], 0, 1000000000)
            or not _incident_integer(report["suppressed"], 0, 1000000000)):
        return False
    entries = report["events"]
    if not isinstance(entries, list) or not 1 <= len(entries) <= 40:
        return False
    previous = -60000
    for entry in entries:
        if (not isinstance(entry, dict) or not {"event", "at", "visible", "online", "resume"} <= entry.keys()
                or not isinstance(entry["event"], str) or entry["event"] not in INCIDENT_EVENTS
                or not _incident_integer(entry["at"], previous, 0)):
            return False
        previous = entry["at"]
        for name, value in entry.items():
            if name in ("event", "at"):
                continue
            if name in INCIDENT_FLAGS:
                if type(value) is not bool:
                    return False
            elif name in INCIDENT_NUMBERS:
                if not _incident_integer(value, 0, INCIDENT_NUMBERS[name]):
                    return False
            elif name in INCIDENT_CHOICES:
                if value not in INCIDENT_CHOICES[name]:
                    return False
            elif name in ("box", "selected"):
                if not _incident_box(value):
                    return False
            elif name == "op":
                if not isinstance(value, str) or not INCIDENT_OP.fullmatch(value):
                    return False
            else:
                return False
    return entries[-1]["event"] == "mark" and entries[-1].get("reason") == report["reason"]

CLIENT_LOGGER = logging.getLogger("facilitator.client")
CLIENT_LOGGER.setLevel(logging.INFO)
CLIENT_LOGGER.propagate = False
if not CLIENT_LOGGER.handlers:
    # delayed, so a board no page has ever reported from has no file at all
    _client_file = DatedRotatingHandler(LOG_DIR, "client", ".jsonl", delay=True)
    _client_file.setFormatter(JsonLineFormatter())
    CLIENT_LOGGER.addHandler(_client_file)

_client_lock = threading.Lock()
_client_seen: dict = {}   # key -> [when its minute started, written, dropped]


def _client_event(kind: str, box: str = "", /, **fields) -> None:
    """One line in the client file. Its own logger and its own file: page
    reports are not board events and must never be read as if they were."""
    CLIENT_LOGGER.info(kind, extra={"box": box, "fields": fields})


def _client_key(page: str, report: dict) -> str:
    """A report's identity: what it says and where it happened. Two throws from
    the same line are one key, however many times they happen."""
    if report["kind"] == "incident":
        return "incident|phone"
    return "|".join(str(report.get(part, "")) for part in
                    ("kind", "message", "file", "line")) + "|" + page


def _client_fields(report: dict) -> dict:
    """Only the fields a report is allowed to carry, each string cut to its cap.
    A page cannot write whatever it likes into a file on this machine."""
    if report["kind"] == "incident":
        return {k: report[k] for k in ("v", "reason", "marked", "lost", "suppressed", "events")}
    out = {}
    for name in CLIENT_FIELDS:
        value = report.get(name)
        if isinstance(value, str):
            out[name] = value[:CLIENT_MAX_CHARS]
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            out[name] = value
    return out


def _client_batch(page: str, reports: list) -> tuple:
    """One batch to the client file, under the per key per minute cap: how many
    were written and how many were dropped. What the cap drops is counted and
    said, so a file missing lines says how many are missing rather than quietly
    being short."""
    now = time.time()
    written = 0
    lost = {}
    with _client_lock:
        if len(_client_seen) > CLIENT_KEYS_KEPT:   # a page inventing keys cannot grow this forever
            for stale in [k for k, w in _client_seen.items() if now - w[0] >= CLIENT_WINDOW]:
                del _client_seen[stale]
        for report in reports:
            key = _client_key(page, report)
            window = _client_seen.get(key)
            if window is None or now - window[0] >= CLIENT_WINDOW:
                window = _client_seen[key] = [now, 0, 0]
            limit = INCIDENT_PER_MINUTE if report["kind"] == "incident" else CLIENT_PER_MINUTE
            if window[1] >= limit:
                window[2] += 1
                count, _ = lost.get(key, (0, None))
                lost[key] = (count + 1, report)
                continue
            fields = _client_fields(report)
            if report["kind"] == "incident":
                record = CLIENT_LOGGER.makeRecord(CLIENT_LOGGER.name, logging.INFO, "", 0, "incident", (), None,
                                                  extra={"box": report["box"], "fields": {"page": page, **fields}})
                _client_file.emit_confirmed(record)
            else:
                _client_event(report["kind"], str(report.get("box") or "")[:64], page=page, **fields)
            window[1] += 1
            written += 1
    for count, sample in lost.values():
        _client_event("dropped", str(sample.get("box") or "")[:64], page=page,
                      report=sample["kind"], message=str(sample.get("message") or "")[:CLIENT_MAX_CHARS],
                      line=sample.get("line") if isinstance(sample.get("line"), int) else None,
                      dropped=count)
    return written, sum(count for count, _ in lost.values())


class OwnerMigrationRequired(ValueError):
    """Persisted configuration or state still names a retired owner id."""


class SaveFailed(RuntimeError):
    """The board's state could not be written to disk. Its own exception rather
    than a bare OSError, so the POST dispatch can answer this one and nothing
    else, and no other failure is quietly turned into a 500."""


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
# Lane panels remain image-only. Uploads also accept media and documents.
IMG_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
UPLOAD_TYPES = {**IMG_TYPES,
                ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime",
                ".webm": "video/webm", ".ogv": "video/ogg",
                ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
                ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
                ".opus": "audio/ogg", ".weba": "audio/webm",
                ".pdf": "application/pdf", ".doc": "application/msword",
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
PORT = 8877
# ---- the transport's bounds ------------------------------------------------------
# What the board accepts at once and how long it lets a peer sit on the line.
# The numbers are for one Mac serving one desktop, one phone through the
# tunnel and a few agent loops, with room for a runaway; how they protect the
# commands is explained with the Transport class below.
LISTEN_BACKLOG = 128
CONNECTION_LIMIT = 200          # connections open at once before uvicorn answers 503
WAIT_SLOTS = 8                  # agent long polls held open at once
READ_SLOTS = 32                 # board readings in flight at once, their sending included
THREAD_POOL_SIZE = 64           # worker threads the routes' locked work may use
FIRST_REQUEST_TIMEOUT = 15.0    # seconds a new connection may sit before its request arrives
KEEP_ALIVE_TIMEOUT = 5          # seconds an idle kept-alive connection is held between requests
WRITE_STALL_TIMEOUT = 30.0      # seconds an answer may sit unread in a full socket before the connection is cut
BODY_READ_TIMEOUT = 30.0        # seconds a request body may take to arrive
GRACEFUL_STOP_TIMEOUT = 3       # seconds a stop waits for open requests before cutting them
MAX_TEXT_BODY = 1024 * 1024     # bytes of a plain text body: a message, a reply, a markdown file
MAX_UPLOAD_BODY = 100 * 1024 * 1024   # bytes of one attachment
# ---- operation receipts ----------------------------------------------------------
# A receipt lives at most OP_RETENTION and is never let go by the count cap
# while it is younger than OP_EVICT_FLOOR. The phone stops retrying an operation
# far sooner than the floor (see OP_GIVE_UP in m.html), so an id a phone could
# still be sending is never dropped, and a retry never finds its receipt gone
# and lands a second time. The cap only trims receipts already older than any
# live retry; under one person's use the store never approaches it.
OP_RETENTION = 7 * 86400        # seconds a receipt is kept at the very most
OP_EVICT_FLOOR = 2 * 86400      # a receipt younger than this is kept whatever the cap
OP_KEEP = 4000                  # the soft cap the count is trimmed toward, oldest-and-old first
OP_ASK_MAX = 32                 # receipts one reading of the board may ask after
OP_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
BG_STALE = 75.0   # seconds without a /ping before a registered job stops counting as green
# view pages a project may hold at once. A page is four short fields, so the cap
# is not about disk: it is what keeps the switcher at the foot of the workspace a
# row of dots a hand can hit rather than a strip nobody can aim at
PAGE_LIMIT = 24
# seconds a claim may sit unconfirmed before it goes back to the queue. Short on
# purpose: the whole point is that a hand-off lost on the wire comes back while
# the message still matters, not fifteen minutes later
ACK_GRACE = 90.0
# ---- the queue a lane reads and chooses from -------------------------------------
# A lane in select mode is not handed a card. It reads rows, picks one, and the
# selection reserves that card through the very same claim the auto path mints,
# so the colour machine, the 90 second lease and the 15 minute steal-back are
# untouched. The numbers below are the only new clocks, and each is tied to one
# that already exists rather than invented beside it.
HOLDER_IDLE = 180.0             # seconds without a call before a lane's holder record may be taken
STARVED_AFTER = 900.0           # the same window the steal-back uses, so a starved row and a steal agree
NOTIFY_REPEAT = 300.0           # a lane that still has work is told again at most this often
NOTICE_KEEP = 20                # notices kept per lane
DELIVERY_KEEP = 40              # deliveries kept per lane, prepared and finished together
QUEUE_LIMIT = 50                # rows one listing answers by default
QUEUE_LIMIT_MAX = 200
# One upgrade pass associates uploads referenced by older cards with those
# cards, in the same shape the reply-count scan uses: a version key in state
# says the pass ran, and the transcript is read once.
UPLOADS_INDEX_VERSION = 1
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
# Version 1 gives every card its own count of final replies, which is what the
# reply-history arrows walk. The aggregate "replies" count includes progress
# notes and so cannot answer whether a card has an older page. Cards written
# before this are counted once from the transcript, since only the transcript
# holds what a card was answered with before now.
HISTORY_COUNTS_VERSION = 1
# How many older replies one card's history offers, on both sides of the same
# answer: the count sent with the card and the list GET /history hands out are
# capped here together, so neither can promise a page the other cannot reach.
# This is a cap on final replies only, unlike /thread's n, which counts every
# row of the conversation.
HISTORY_MAX = 200
# Answered batches (2026-09-11): which of the owner's messages one completed
# reply was actually given. Only the board can state that, so it is recorded
# where a delivery happens (a claim, or a mid-work hand-over) and written down
# beside the reply that answers it. Version 1 is the boundary: a reply recorded
# before it carries no batch and never has one reconstructed for it, because
# nothing durable says what a reply of that age was handed. Unknown stays
# unknown, and is a different fact from a reply that was handed nothing.
ANSWERED_BATCH_VERSION = 1
# There is deliberately no cap on a batch, and no count, text or payload cap
# standing in for one. Every message a completed reply was handed belongs to
# it, with its own identity, its own words and its own send time, however many
# there are: the batch states an exact association, and a trimmed association
# is a false one. Nothing between the hand-over and the card, the history or
# the transcript row shortens it.
# HISTORY_MAX above is a different thing entirely: it caps how many PAGES of
# reply history one card offers, never what any one of those pages answered.
BUILTIN_OWNERS = ("facilitator", "pastureland", "qchat")  # qchat: the quick chat panel's lane, dormant in the current board
OWNERS = BUILTIN_OWNERS
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

# ---- waking the listeners --------------------------------------------------------
# The agents' long polls wait on the event loop, not on the condition above.
# Every change to the board comes through _notify: it moves a version number
# and asks the loop to wake every waiter, and a waiter that reads the version
# before sleeping and again on waking can never miss a change that landed in
# between. _LOOP is the running loop, set by the application's lifespan; a
# change made before it runs, or after it has gone, wakes nobody, and that is
# right, since nobody is waiting then.
_change_version = 0
_LOOP = None
_wakers: set = set()
_STOPPING = threading.Event()   # set by the stop signal: waiters go home at once


def _wake_all() -> None:
    for ev in list(_wakers):
        ev.set()


def _notify() -> None:
    """The board changed: whoever is waiting for that should look again.
    Callers hold _lock."""
    global _change_version
    _change_version += 1
    loop = _LOOP
    if loop is not None:
        try:
            loop.call_soon_threadsafe(_wake_all)
        except RuntimeError:
            pass   # the loop is closed: nobody is left to wake


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


def _sync_owner_registries() -> None:
    """Bring the runtime owner set and its presence maps back in step with the
    state: the built-in owners plus the projects the state holds, in that
    order, and nothing else. Run after the state is put back by a failed save,
    so a lane a route registered before that save is forgotten with it, while
    the live counts of every lane that stays are kept. Callers hold _lock."""
    global OWNERS
    kept = list(BUILTIN_OWNERS)
    for p in _state.get("projects", []):
        if isinstance(p, dict) and p.get("id") and p["id"] not in kept:
            kept.append(p["id"])
    OWNERS = tuple(kept)
    for registry in (_waiters, _last_wait, _agent_names):
        for ow in [ow for ow in registry if ow not in OWNERS]:
            del registry[ow]
    for ow in OWNERS:
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


OWNER_KEYED_STATE = ("busy", "claimed", "busy_ts", "ack", "workspaces", "pages", "ever_listened")


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


def _backup_state() -> None:
    """A copy of state.json beside it, taken once before the first save that
    adds the revision and the receipts: the way back to the server this file
    replaced is to stop the board and rename the copy over state.json. The
    name is the only thing written down about it; the folder is not."""
    stamp = time.strftime("%Y%m%dT%H%M%S")
    kept = STATE_PATH.with_name(f"state.json.bak-{stamp}")
    try:
        shutil.copy2(STATE_PATH, kept)
    except OSError as e:
        _error("backupfail", reason=e.strerror or type(e).__name__)
        return
    _info("backup", kept=kept.name)


def _load() -> None:
    global _state, _LANE_DIRS
    _LANE_DIRS = _lane_dirs()
    if STATE_PATH.exists():
        _state = json.loads(STATE_PATH.read_text())
        source = "state.json"
        if isinstance(_state, dict) and "rev" not in _state:
            _backup_state()
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


def _row_reply_full(event: dict, legacy: bool) -> str:
    """The full-text variant of one transcript reply row.

    legacy says the row stands before the durable schema marker, which is the
    only thing that may revive the retired --- delimiter. Every reader of a
    reply row goes through here, so /thread and the history count can never
    read the same row two different ways."""
    if "reply_full" in event or "reply_short" in event:
        return event.get("reply_full", event.get("text", ""))
    if legacy:
        return _legacy_reply_variants(event.get("text", ""))[1]
    return event.get("text", "")


def _answered_out(value) -> list | None:
    """One answered batch as a client reads it: the words and the send time of
    each message that reply was given, in the order they were sent.

    None is the honest answer for a reply the board recorded nothing for, and an
    empty list is a reply that was handed nothing. Those are different facts and
    a caller may act on either, so they are never folded together. A stored
    entry that is not a message record is dropped rather than guessed at."""
    if not isinstance(value, list):
        return None
    out = []
    for rec in value:
        if not isinstance(rec, dict):
            continue
        ts = rec.get("ts", 0)
        out.append({"text": rec.get("text", ""),
                    "ts": ts if isinstance(ts, (int, float)) else 0})
    return out


def _row_reply_meta(event: dict) -> dict:
    """One history page's own identity, completion time and answered batch.

    The identity is the board's name for that reply, so two replies with the
    same words, or two completed in the same second, are still two pages a
    client can tell apart and hold its own state for. The time is when that
    reply was completed, read off the row itself and never off a later note.

    A row written before this feature carries none of it. Its identity and its
    batch are then null, which says the association is unknown, and nothing is
    rebuilt from the rows around it: the transcript records what was said, not
    which messages any one reply was handed."""
    rid = event.get("reply_id")
    ts = event.get("reply_ts", event.get("ts", 0))
    return {
        "id": rid if isinstance(rid, str) and rid else None,
        "ts": ts if isinstance(ts, (int, float)) else 0,
        "answered": _answered_out(event.get("answered")),
    }


def _older_replies(box: dict) -> int:
    """How many older pages this card's reply history holds: every final reply
    except the one the card is showing, and never more than the history route
    hands out. A progress note is not a page of the history and never hides the
    reply it was written over.

    This is the count /state sends and GET /history is the list of the same
    thing. One rule decides both: which rows count (final replies only) and
    which one is the page you are on (the card's reply_kind, never a guess made
    by comparing text). So the marks a page draws before it asks and the list
    it walks when it does cannot say different things."""
    count = box.get("full_replies", 0)
    if box.get("reply_kind") == "agent":
        count -= 1     # the newest final reply is the one on the card
    return max(min(count, HISTORY_MAX), 0)


def _is_reply_schema_boundary(event: dict) -> bool:
    """True only for our durable transcript schema marker."""
    try:
        version = int(event.get("version", 0))
    except (TypeError, ValueError):
        return False
    return (event.get("kind") == "schema" and
            event.get("schema") == TRANSCRIPT_REPLY_SCHEMA and
            version >= REPLY_VARIANTS_VERSION)


def _scan_transcript_replies() -> dict:
    """Per card: how many final replies the transcript holds, and what wrote
    the words the card is showing. One pass over the whole file, for the
    one-time count of cards answered before the board kept this itself.

    What wrote the card is the kind of the last row that writes one, in file
    order. Never by matching that row's text against the card, because a
    progress note that repeats the answer under it word for word would then
    read as the answer itself and hide a page that is really there.

    Rows are read the way /thread reads them, so the count a page is told and
    the list it walks are made of the same rows: rows written twice under one
    operation id are one event."""
    found: dict = {}   # box id -> [final replies, kind of the last row that wrote the card]
    seen_ops: set = set()
    try:
        with TRANSCRIPT_PATH.open(errors="replace") as transcript:
            for line in transcript:
                try:
                    event = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if not isinstance(event, dict):
                    continue
                kind = event.get("kind")
                if kind not in ("agent", "note", "progress"):
                    continue
                bid = event.get("box")
                if not isinstance(bid, str):
                    continue
                op = event.get("op")
                if isinstance(op, str) and op:
                    if (kind, op) in seen_ops:
                        continue
                    seen_ops.add((kind, op))
                record = found.setdefault(bid, [0, ""])
                if kind == "agent":
                    record[0] += 1
                record[1] = kind
    except FileNotFoundError:
        pass
    return found


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
    # the revision and the receipts (2026-09-06): every saved change moves the
    # revision, so a phone can name the reading it holds and be told whether it
    # is current; the receipts are what a command sent again is answered from
    _state.setdefault("rev", 0)
    if not isinstance(_state.get("ops"), dict):
        _state["ops"] = {}
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
    # view pages (2026-09-10): each project's own ordered list of the
    # environments it can be looked at in. This is a view record and nothing
    # more: it holds no cards, no chats and no tasks, and it is deliberately
    # separate from the workspaces above, which carry a goal and a task list
    # and are what the cards are filed under.
    # Only a project with no key at all is given its opening board page. An
    # empty list is a project whose pages were all removed by hand, and it is
    # left empty, so a deleted page cannot come back on the next reading
    pages = _state.setdefault("pages", {})
    for ow in OWNERS:
        if ow not in pages:
            pages[ow] = [_page_record("pg1", "board")]
    # never reused, like the box counter: a page id that has been deleted does
    # not come back on a later page and take a stale selection with it
    _state.setdefault("next_pgid", 1 + max(
        [int(p["id"][2:]) for lst in pages.values() if isinstance(lst, list) for p in lst
         if isinstance(p, dict) and str(p.get("id", "")).startswith("pg")
         and str(p["id"])[2:].isdigit()] or [0]))
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
    # Older replies (2026-09-10): the card carries its own count of final
    # replies, so a page can draw the history arrows in the frame the card
    # appears in rather than after reading the transcript. reply_kind says what
    # wrote the text the card is showing, which is what decides whether the
    # newest final reply is the page you are on or a page behind you.
    # Cards answered before this are counted once, from the transcript, and
    # their reply_kind is the kind of the last row that wrote them, in file
    # order, which is the same thing the routes record from here on.
    if _state.get("history_counts_version", 0) < HISTORY_COUNTS_VERSION:
        counted = _scan_transcript_replies()
        for b in _state["boxes"]:
            count, kind = counted.get(b["id"], (0, ""))
            b["full_replies"] = count
            b["reply_kind"] = kind
        _state["history_counts_version"] = HISTORY_COUNTS_VERSION
    else:
        # a box added by an older helper or by hand carries neither field, and
        # no older page can be walked on a card the board knows no replies of
        for b in _state["boxes"]:
            b.setdefault("full_replies", 0)
            b.setdefault("reply_kind", "")
    # Answered batches (2026-09-11): the messages one completed reply was given,
    # kept beside the reply itself. None of it can be worked out after the fact,
    # so every card answered before now starts with the association unknown and
    # keeps it until that card is answered again. The box a card draws over its
    # answer is only ever filled from a batch the board itself recorded.
    #   handed     the messages the claim in force handed over, written whole by
    #              each claim and emptied when that claim is let go
    #   batch      what the progress notes on the way have already consumed
    #              toward the completed reply still to come
    #   batch_gap  a hand-over reached the agent that this board has no record
    #              of, so the batch cannot be stated and the reply that follows
    #              says unknown rather than offering a part of itself as the
    #              whole. It is cleared by that reply, and the card records
    #              exactly from there on
    #   answered   what the last completed reply was given: a list, or None for
    #              unknown. An empty list is a reply that was handed nothing,
    #              which is a different fact and stays one. It is never capped
    #              or trimmed, however many messages one answer covers
    #   reply_id   that reply's own name, unique for the life of the board, so
    #              repeated words and one second holding two replies still name
    #              two pages
    #   reply_ts   when it was completed. agent_ts moves on progress notes too,
    #              so it cannot mean this and is left alone
    if _state.get("answered_batches_version", 0) < ANSWERED_BATCH_VERSION:
        for b in _state["boxes"]:
            b["handed"] = []
            b["batch"] = []
            # a claim, or a note's worth of messages, may already stand behind
            # the answer this card is about to be given, and nothing durable
            # says which messages those were: the first completed reply from
            # here says unknown, and every one after it is exact
            b["batch_gap"] = True
            b["answered"] = None
            b["reply_id"] = ""
            b["reply_ts"] = 0
        _state["answered_batches_version"] = ANSWERED_BATCH_VERSION
    else:
        # a box added by an older helper or by hand starts recorded and empty:
        # nothing has ever been handed over on it, and no claim of its own can
        # have stood across the upgrade
        for b in _state["boxes"]:
            b.setdefault("handed", [])
            b.setdefault("batch", [])
            b.setdefault("batch_gap", False)
            if not isinstance(b.get("answered"), list):
                b["answered"] = None
            b.setdefault("reply_id", "")
            b.setdefault("reply_ts", 0)
    _state.setdefault("next_reply_id", 1)
    # ---- the queue a lane reads and chooses from -------------------------------
    # Every key here defaults, so a state file written before any of this loads
    # unchanged and a server rolled back to the previous version ignores them,
    # exactly as the revision and receipt keys were ignored before it.
    _state.setdefault("epoch", 0)
    _state.setdefault("lane_mode", {})          # lane -> "auto" or "select"; absent means auto
    _state.setdefault("holders", {})            # lane -> which connection is serving it
    _state.setdefault("reservations", {})       # lane -> the live reservation, beside the claim itself
    _state.setdefault("deliveries", {})         # delivery id -> one prepared body and what became of it
    _state.setdefault("notices", {})            # lane -> the last few notifications and their outcomes
    _state.setdefault("uploads", {})            # stored file name -> the card it belongs to
    for b in _state["boxes"]:
        b.setdefault("work", {})                # job id -> the registration behind this card's green
        b.setdefault("passed_over", 0)
        b.setdefault("delivery_attempts", 0)
    _scan_uploads_once()
    _save()


# the exact bytes of the last state.json this process durably wrote, kept so a
# save that fails can put memory back to what the disk holds. None until the
# first durable write of this run, which is the migration's own save
_last_durable: str | None = None
# ---- what waits for the commit ----------------------------------------------------
# A mutation is one held stretch of _lock: change the state, note the events,
# save. Two kinds of thing must not happen before the save has installed the
# new file, because a save can fail and the state then goes back: the
# transcript row and log line of each event, and the push that tells a phone
# a card turned to its owner. Both are queued here by the routes and helpers
# and written or started by _save once the rename has succeeded; a failed save
# drops them. So the transcript never presents a rolled-back message as
# history, the log never says a rolled-back event happened, and no phone is
# woken for a reply the board does not have.
_transcript_due: list = []   # (event row, kind, box, chars, log fields), under _lock
_push_due: list = []         # box ids whose turn is to be pushed once the save lands, under _lock


def _side_effect_failure(kind: str, box: str = "", **fields) -> None:
    """Record a post-commit failure when logging itself still works. Nothing
    after the state-file rename may raise back into the request and make an
    installed mutation look refused."""
    try:
        _error(kind, box, **fields)
    except Exception:
        pass


def _commit_side_effects() -> None:
    """After a successful rename: append the queued transcript rows in one
    open, write their log lines, and start the pushes. The state is already
    installed, so a transcript that cannot be appended is written down as its
    own failure and never fails the save; the state stays the source of truth
    and the transcript is the record that follows it."""
    global _transcript_due, _push_due
    due, _transcript_due = _transcript_due, []
    pushes, _push_due = _push_due, []
    if due:
        try:
            # Encode the batch before opening the file. A malformed internal
            # event then appends none of the batch instead of a prefix of it.
            encoded = "".join(json.dumps(event) + "\n"
                              for event, _kind, _box, _chars, _fields in due)
            with TRANSCRIPT_PATH.open("a") as f:
                f.write(encoded)
        except Exception as e:
            _side_effect_failure("transcriptfail", rows=len(due),
                                 reason=getattr(e, "strerror", None) or type(e).__name__)
        for _event, kind, box, chars, fields in due:
            try:
                _info(kind, box, chars=chars, **fields)
            except Exception as e:
                _side_effect_failure("logfail", box, event=kind,
                                     reason=type(e).__name__)
    for bid in pushes:
        try:
            threading.Thread(target=_push_turn, args=(bid,), daemon=True).start()
        except Exception as e:
            _side_effect_failure("pushfail", bid, reason=type(e).__name__)


def _discard_side_effects() -> None:
    """After a failed save: what was queued belongs to changes the board has
    just taken back, so none of it is written or sent."""
    _transcript_due.clear()
    _push_due.clear()


def _restore_last_durable() -> None:
    """Put _state back to the last bytes that reached the disk, and everything
    that lives beside the state back in step with it. Callers hold _lock.
    After this, memory and disk agree again, so a command whose save failed
    did not happen: its retry re-applies from scratch, its receipt is not there
    to answer from, its transcript row and push are dropped, and a lane it
    registered is forgotten. Before the first durable write there is nothing
    to go back to, and the failing start is left to stop."""
    _discard_side_effects()
    if _last_durable is not None:
        restored = json.loads(_last_durable)
        _state.clear()
        _state.update(restored)
        _sync_owner_registries()


def _durable_fsync(fd: int) -> None:
    """Push a file's bytes as far toward the platter as the platform allows.
    On macOS a plain fsync only hands the bytes to the drive, which may still
    reorder them across a power cut; F_FULLFSYNC is the call that waits for the
    drive to actually persist them. Where that control is missing this is an
    ordinary fsync, which is the honest most other platforms give."""
    full = getattr(fcntl, "F_FULLFSYNC", None)
    if full is not None:
        try:
            fcntl.fcntl(fd, full)
            return
        except OSError:
            pass   # not offered on this filesystem; fall back to the ordinary flush
    os.fsync(fd)


def _save() -> None:
    """The board to disk: a temp file beside it, then one rename, so a reader
    never sees half a state, and so a save that cannot finish leaves the last
    good file exactly as it was.

    A failure here used to leave the lock and the whole POST dispatch with no
    answer ever written, so the page's fetch hung until the socket closed. Now
    it says which step failed, puts memory back to what the disk holds, and
    raises itself, and the dispatch answers 500. Putting memory back is what
    keeps the board's memory from ever running ahead of its file: a command
    whose save failed did not happen, so its retry re-applies honestly and its
    receipt is not left behind to answer a repeat from. The reason is the
    operating system's own word for it and never the name of the file it could
    not write: a log line is not the place for a path.

    Every save is a new revision of the board, and the effect, the receipt of
    the command that made it and the revision number are one serialization, so
    a reader or a restart sees all three or none. The revision only advances
    once the rename has installed the new file; a save that fails puts it back.

    What a successful save proves, exactly: the new file's bytes were flushed
    (F_FULLFSYNC where the platform offers it, an ordinary fsync elsewhere) and
    the rename installed it, so a crash after the rename keeps the new state, a
    crash before it the old, and there is no half file either way. The folder
    entry is flushed afterwards on a best effort: a folder that cannot be
    flushed does not undo the commit, since the rename has already happened and
    going back to old memory then would lie about the file that is installed,
    but it is written down as a syncfail line rather than passed over. None of
    this certifies a hardware power cut; it is as far as the calls reach."""
    global _last_durable
    _state["rev"] = int(_state.get("rev", 0)) + 1
    payload = json.dumps(_state, indent=1)
    tmp = STATE_PATH.with_suffix(".tmp")
    try:
        with tmp.open("w") as f:
            f.write(payload)
            f.flush()
            _durable_fsync(f.fileno())
    except OSError as e:
        _restore_last_durable()   # nothing was installed; memory goes back to the file
        _error("savefail", step="write", reason=e.strerror or type(e).__name__)
        raise SaveFailed("write") from e
    try:
        os.replace(tmp, STATE_PATH)
    except OSError as e:
        tmp.unlink(missing_ok=True)
        _restore_last_durable()   # the rename did not happen; the old file still stands
        _error("savefail", step="replace", reason=e.strerror or type(e).__name__)
        raise SaveFailed("replace") from e
    # the new file is installed: this is the commit point, and nothing past it
    # may undo the save, so the folder sync that follows never fails it. It is
    # not silent either: a folder that cannot be flushed is a durability gap
    # worth a line, even though the commit stands
    _last_durable = payload
    try:
        fd = os.open(STATE_PATH.parent, os.O_RDONLY)
        try:
            _durable_fsync(fd)
        finally:
            os.close(fd)
    except OSError as e:
        _side_effect_failure("syncfail", step="folder",
                             reason=e.strerror or type(e).__name__)
    _commit_side_effects()


def _log(kind: str, box: str, text: str, log_fields: dict | None = None, **fields) -> None:
    """One board event: the transcript keeps it whole, text and all, because the
    transcript is the discussion's durable record. The log gets the same event
    without the text, only its length, since GET /log hands the log to any
    caller on this machine and what was said is not its business. log_fields
    carries what is safe to write down beside it and never reaches the
    transcript row.

    Nothing is written here. The row and the log line are held until the save
    that follows has installed the new state file, and are dropped if it does
    not, so neither the transcript nor the log can say that something happened
    which the board then rolled back. Every caller holds _lock and saves in the
    same held stretch; the save is what writes these out."""
    event = {"ts": time.time(), "kind": kind, "box": box, "text": text}
    event.update(fields)
    _transcript_due.append((event, kind, box, len(str(text or "")), dict(log_fields or {})))


# the window in which a page holds its own write on top of the server's answer,
# TAB_HOLD and SEEN_HOLD in card-logic.js. A second write landing inside it is
# one the losing page never sees, which is the whole reason it is invisible
OVERWRITE_HOLD = 3.0
_last_change: dict = {}   # (record, box, field) -> when that record last changed


def _overwrite(record: str, box: str, field: str, before, after) -> None:
    """A write that changed a record another write had only just changed.

    In memory and never in state.json, because this is diagnosis and must not
    add a write to the write it is diagnosing. Neither route carries any device
    identity, so the line cannot honestly say who lost: it says that a second
    write landed inside the hold window, what it changed, and how far apart the
    two were."""
    if before == after:
        return          # nothing was overwritten; the same record written twice
    now = time.time()
    was = _last_change.get((record, box, field))
    if was is not None and now - was < OVERWRITE_HOLD:
        _info("overwrite", box, record=record, field=field, ms=round((now - was) * 1000))
    _last_change[(record, box, field)] = now


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
        _drop_reservation(ow, "card deleted")
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


# ---- a project's view pages -------------------------------------------------
# The environments one project can be looked at in, in the order the switcher at
# the foot of the workspace draws them. kind is "board" for the page that shows
# the project's own board, the one every project opens with, and "blank" for a
# page added since, which shows an empty canvas in the same project. Nothing a
# project owns hangs off a page, so removing one never takes a card, a chat, a
# workspace or a task with it.
def _page_record(pid: str, kind: str) -> dict:
    return {"id": pid, "kind": kind, "created": time.time()}


def _pages(owner: str) -> list:
    return _state.setdefault("pages", {}).setdefault(owner, [])


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
    and a push is queued for every phone subscribed. Callers hold _lock and
    save right after: the push starts only once that save has installed the
    turn, so a phone is never woken for a reply the board then rolled back. The
    bridge check and the push run on their own thread, so no request waits on
    either. Exactly two events lead here: a plain reply with no live working
    flag, and a deferred turn handed over when its flag drops or expires. A
    progress note never does."""
    b["ball"] = "you"
    b["turn_ts"] = time.time()
    if _state.get("push_subs"):
        _push_due.append(b["id"])


def _handover(b: dict) -> None:
    """A deferred card leaving green: the reply recorded under the flag is
    finally waiting on him, so the turn register flips as the state moves."""
    if b["state"] == "deferred":
        _turn_to_you(b)
        _log("handover", b["id"], "working flag down, deferred turn handed over")


def _release_claim(b: dict, for_answer: bool = False) -> str:
    """Consume this box's handed-over messages and free its lane. Messages sent
    while the agent was composing were not in the claim, so they stay pending
    and return to the queue exactly once. Callers hold _lock.

    for_answer says what becomes of the messages that claim handed over. The
    agent writing about them passes it: a progress note keeps them for the
    completed reply still to come, and that reply takes them. Every other way of
    letting a claim go is discarding them unanswered, which is exactly what
    dismissing a card does -- drop what is queued and clear the claim -- so the
    default drops them from the answer as well as from the queue, and no later
    reply can inherit them.

    Nothing else here changes with it. The queue, the lane and the inbox are
    handled exactly as they always were either way, so a caller that knows
    nothing about answered batches keeps the behaviour it has always had and
    gets the safe reading of its own intent."""
    ow = b.get("owner", "pastureland")
    claimed = set(_state["claimed"][ow]) if _state["busy"][ow] == b["id"] else set()
    b["pending"] = [m for m in b["pending"] if m["mid"] not in claimed]
    _consume_claim(b, claimed, for_answer)
    if _state["busy"][ow] == b["id"]:
        _state["busy"][ow] = None
        _state["claimed"][ow] = []
        # a select lane's reservation is the same claim seen from the other
        # side, so it goes wherever the claim goes and never outlives it
        _drop_reservation(ow, "claim released")
    if b["pending"] and b["id"] not in _state["inbox"]:
        _state["inbox"].append(b["id"])
    if not b["pending"] and b["id"] in _state["inbox"]:
        _state["inbox"].remove(b["id"])
    return ow


def _handed_record(m: dict) -> dict:
    """One handed-over message, in the shape the answered box draws it."""
    rec = {"mid": m.get("mid"), "text": m.get("text", ""), "ts": m.get("ts", 0)}
    if m.get("via"):
        rec["via"] = m["via"]
    return rec


def _hand_over(b: dict, messages: list) -> None:
    """A claim: these messages, and only these, are what the agent is holding on
    this card now. Callers hold _lock and save in the same held stretch.

    A claim is minted whole, so this is written whole. Whatever an earlier claim
    left here goes with that claim, which is what keeps a claim cleared by any
    other path -- a card dismissed, a hand-off nobody confirmed, a steal-back --
    from leaving anything behind for a later reply to inherit.

    A hand-over is the only thing that writes here: the claim /wait makes, and
    the mid-work delivery /fresh makes. A message that merely landed on the card
    while the agent was composing was handed over by neither, so no reply covers
    it and it stays in the pending box until something actually delivers it."""
    b["handed"] = [_handed_record(m) for m in messages]


def _hand_over_more(b: dict, messages: list) -> None:
    """A mid-work delivery, folded into the claim in force. Callers hold _lock.

    A mid already handed over is never written twice, so a second delivery, a
    retry or a re-claim cannot put one message in a batch twice."""
    held = b.get("handed")
    if not isinstance(held, list):
        held = b["handed"] = []
    seen = {rec.get("mid") for rec in held}
    for m in messages:
        mid = m.get("mid")
        if mid in seen:
            continue
        seen.add(mid)
        held.append(_handed_record(m))


def _consume_claim(b: dict, claimed: set, for_answer: bool) -> None:
    """What becomes of the messages a claim handed over, at the moment that
    claim is let go. This is _release_claim's own step; callers hold _lock.

    Only the lane's actual claim identities are folded in, and only when the
    agent is writing about them. A progress note consumes a claim without
    finishing the answer, so what it consumed waits here for the completed reply
    still to come, and several notes may each consume their own claim toward
    that one reply. Anything else letting a claim go -- a card dismissed above
    all -- discards those messages unanswered, and they are dropped here so no
    later reply can inherit them.

    A record left behind by a claim that was cleared some other way cannot reach
    an answer either: nothing is folded in unless the lane still names the mid.
    So the batch is made of claim identities and never of an inference drawn
    from a message no longer being in the queue, which is a thing a progress
    note and a dismissal do alike and which therefore says nothing.

    A claim naming a mid this board has no record of is a hand-over it never
    saw, which is what a claim standing across the upgrade looks like. The batch
    cannot be stated then and says so, rather than offering a part of itself as
    the whole. What it can state it states entire: nothing here trims, caps or
    summarises a batch, however many messages one answer covers."""
    held = b.get("handed")
    b["handed"] = []
    if not for_answer or not claimed:
        return
    records = [rec for rec in held if rec.get("mid") in claimed] if isinstance(held, list) else []
    if len(records) != len(claimed):
        b["batch_gap"] = True     # handed over, and this board has no record of it
        return
    if b.get("batch_gap"):
        return                    # already unknown; a part of a batch is not the batch
    batch = b.get("batch")
    if not isinstance(batch, list):
        batch = b["batch"] = []
    seen = {rec.get("mid") for rec in batch}
    for rec in records:
        if rec.get("mid") in seen:
            continue
        seen.add(rec.get("mid"))
        batch.append(rec)


def _take_answered(b: dict) -> list | None:
    """The exact messages the reply being recorded answers, and the end of that
    association. Callers hold _lock and have let the claim go for_answer first,
    so the claim in force at the moment of the reply is already folded in.

    Every member is kept. Each message that was handed over stands here with its
    own identity, its own words and its own send time, however many there are,
    and nothing on the way to the card, to the history or to the transcript row
    trims, caps or summarises the list.

    None says the association is unknown: a hand-over reached the agent that
    this board has no record of, which is what a card carried across the upgrade
    looks like for its first answer. It is never the same fact as the empty
    list, which says this reply was handed nothing at all.

    The card starts from nothing again, so the next completed answer opens an
    association of its own and one message is answered exactly once."""
    batch = b.get("batch")
    gap = bool(b.get("batch_gap"))
    b["batch"] = []
    b["batch_gap"] = False
    if gap:
        return None
    return batch if isinstance(batch, list) else []


def _next_reply_id(bid: str) -> str:
    """A completed reply's own name. Callers hold _lock and save.

    Two replies with the same words, and two completed inside one second, are
    two pages of a card's history and every client has to be able to hold them
    apart: a page it is showing, a batch it is drawing and a fold he has chosen
    all hang off this name. The counter says what the words and the clock
    cannot."""
    n = int(_state.get("next_reply_id", 1))
    _state["next_reply_id"] = n + 1
    return f"{bid}:{n}"


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
        _drop_reservation(ow, "hand-off unconfirmed")
        box = _box(bid)
        if box and box["pending"] and bid not in _state["inbox"]:
            _state["inbox"].insert(0, bid)
        _debug("bounce", bid, owner=ow)
        _log("unacked", bid, f"{ow} hand-off unconfirmed after {ACK_GRACE:.0f}s, box re-queued")
        moved = True
    if moved:
        _save()
        _notify()


def _sweep(persist: bool = True) -> bool:
    """The lazy clock behind green: a card whose flag heartbeat has gone stale
    leaves the green states, deferred handing its turn over on the way out (a
    claim still held keeps showing green through _shown's mask regardless).
    Runs at /state and /wait, exactly where the ack clock is swept, and inside
    /working itself, so a drop or an expiry lands within about a second.
    Callers hold _lock. Ordinarily it saves and notifies when it moves anything;
    a route that is already building a larger mutation passes persist=False and
    includes the sweep in its one final save."""
    moved = False
    for b in _state["boxes"]:
        if b["state"] in GREEN and not _hb_live(b):
            _handover(b)
            b["state"] = _rest(b)
            moved = True
    if moved and persist:
        _save()
        _notify()
    return moved


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
    # the squid on its own, no background: the phone paints its own home-screen
    # launch image from it, sized to whichever iPhone is asking
    "/m-splash-squid.png": (HERE / "assets" / "m-splash-squid.png", "image/png"),
}
# Web push without a payload: the push service only has to be told "wake the
# phone's worker", and the worker reads /state itself, so nothing here is
# encrypted and the one piece of cryptography left is the VAPID signature, an
# ES256 JWT. The openssl command line does that, so this file stays standard
# library only: openssl makes the key pair once, into a gitignored file beside
# state.json, and signs each token. The DER signature it prints is turned into
# the raw r||s form the JWT wants, which is plain byte handling.
PUSH_KEY_PATH = HERE / "vapid-key.pem"
def _push_contact() -> str:
    """The signed push token's contact, a mailto: or https: address the push
    service may use to reach whoever runs this board. It is read from
    run.config.json (machine-local, gitignored) under "push_contact", so no
    personal address ever sits in the code; Apple's service refuses a token
    whose contact it cannot accept. The placeholder below is what a board with
    no configured contact sends."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
        contact = str(cfg.get("push_contact") or "").strip()
        if contact.startswith(("mailto:", "https:")):
            return contact
    except (OSError, ValueError):
        pass
    return "mailto:facilitator@localhost"


PUSH_CONTACT = _push_contact()   # the token's sub claim, a contact push services may use
PUSH_TTL = 86400                                # seconds a push may wait for a phone that is off
PUSH_REASON_CHARS = 200                         # of a refusing service's own words, the first this many
PUSH_BRIDGE_TIMEOUT = 3.0                       # one local Tailscale status command
TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
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


def _push_one(sub: dict, payload: bytes) -> tuple:
    """One encrypted push to one subscription: the status the service
    answered and whatever it said about it, or 0 and the reason it could not be
    reached at all. The body is where a push service explains a refusal, and
    throwing it away is why a whole day of 403s could not be explained."""
    endpoint = sub["endpoint"]
    u = urlparse(endpoint)
    aud = f"{u.scheme}://{u.netloc}"
    keys = sub["keys"]
    body = http_ece.encrypt(
        payload,
        private_key=ec.generate_private_key(ec.SECP256R1()),
        dh=base64.urlsafe_b64decode(keys["p256dh"] + "=" * (-len(keys["p256dh"]) % 4)),
        auth_secret=base64.urlsafe_b64decode(keys["auth"] + "=" * (-len(keys["auth"]) % 4)),
        version="aes128gcm",
    )
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "TTL": str(PUSH_TTL),
        "Authorization": f"vapid t={_vapid_token(aud)}, k={_b64url(_push_public_key())}",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Content-Length": str(len(body)),
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


def _tailscale_command() -> str | None:
    """The same Tailscale command the bridge uses: PATH first, then the Mac
    app. Finding it afresh means installing or removing it takes effect on the
    next turn without restarting the board."""
    found = shutil.which("tailscale")
    if found:
        return found
    if os.access(TAILSCALE_APP, os.X_OK):
        return TAILSCALE_APP
    return None


def _tailscale_json(ts: str, args: list[str]) -> dict | None:
    """One bounded, read-only Tailscale query. No command output or exception
    text escapes this helper because either may contain private machine data."""
    try:
        result = subprocess.run([ts, *args], capture_output=True, text=True,
                                encoding="utf-8",
                                timeout=PUSH_BRIDGE_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None
    if result.returncode != 0:
        return None
    try:
        answer = json.loads(result.stdout)
    except (TypeError, ValueError):
        return None
    return answer if isinstance(answer, dict) else None


def _proxy_targets_board(proxy) -> bool:
    """True only for the IPv4 loopback target used by facilitator bridge."""
    if not isinstance(proxy, str):
        return False
    try:
        target = urlparse(proxy)
        return (target.scheme == "http" and
                target.hostname == "127.0.0.1" and
                target.port == PORT and target.path in ("", "/") and
                not target.params and not target.query and not target.fragment and
                target.username is None and target.password is None)
    except ValueError:
        return False


def _serve_config_targets_board(config: dict) -> bool:
    """Whether a background or live foreground Serve config exposes this
    board at the root of HTTPS port 443."""
    configs = [config]
    foreground = config.get("Foreground")
    if isinstance(foreground, dict):
        configs.extend(c for c in foreground.values() if isinstance(c, dict))
    for candidate in configs:
        tcp = candidate.get("TCP")
        web = candidate.get("Web")
        if not isinstance(tcp, dict) or not isinstance(web, dict):
            continue
        https = tcp.get("443")
        if not isinstance(https, dict) or https.get("HTTPS") is not True:
            continue
        for host_port, server in web.items():
            if not isinstance(host_port, str) or not isinstance(server, dict):
                continue
            try:
                public = urlparse("//" + host_port)
                on_https = public.hostname is not None and public.port == 443
            except ValueError:
                on_https = False
            handlers = server.get("Handlers")
            root = handlers.get("/") if isinstance(handlers, dict) else None
            if (on_https and isinstance(root, dict) and
                    _proxy_targets_board(root.get("Proxy"))):
                return True
    return False


def _push_bridge_available() -> tuple[bool, str]:
    """A fresh, fail-closed check that this board's phone bridge is usable."""
    ts = _tailscale_command()
    if ts is None:
        return False, "tailscale unavailable"
    status = _tailscale_json(ts, ["status", "--json"])
    if status is None:
        return False, "tailscale status unavailable"
    if status.get("BackendState") != "Running":
        return False, "tailscale disconnected"
    serve = _tailscale_json(ts, ["serve", "status", "--json"])
    if serve is None:
        return False, "serve status unavailable"
    if not _serve_config_targets_board(serve):
        return False, "bridge not serving this board"
    return True, ""


def _push_turn(bid: str) -> None:
    """Every subscribed phone is told once that a card turned to his turn.
    Runs on its own thread: it reads the subscriptions under the lock, checks
    that Tailscale is connected and serving this board before each send, talks
    to push services with the lock released, and takes it again only to keep
    successes or drop subscriptions the services report gone."""
    with _lock:
        subs = list(_state.get("push_subs", []))
        box = _box(bid)
        payload = json.dumps({"box": bid, "title": (box or {}).get("title") or "facilitator"},
                             separators=(",", ":")).encode()
    gone = []
    worked = None
    for sub in subs:
        # Probe immediately before every service call. A bridge can go down
        # while an earlier phone's push service is answering, and that must
        # close the gate for every subscription still waiting in this turn.
        available, reason = _push_bridge_available()
        if not available:
            _info("pushskip", bid, reason=reason)
            break
        # the host, never the endpoint: the endpoint is the phone's own address
        # and identifies the device, so it is on the keep-out list
        host = urlparse(sub.get("endpoint", "")).netloc
        try:
            code, said = _push_one(sub, payload)
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


# ---- operations: a receipt kept beside the effect ----------------------------
# A phone a room and a radio away from this server can lose a reply after the
# server has already done what it asked. It cannot tell a lost reply from a
# lost request, so it sends its command again, and without a receipt the
# board would carry the same message twice. A command may therefore name an
# operation id, minted by the caller before the first try and reused on every
# retry. The first try's result is written into state.json in the same rename
# that writes the effect, so a reader can never see one without the other, and
# a retry answers with the stored result and changes nothing. A used id with a
# different payload is refused rather than quietly applied. Callers that send
# no id, the desktop and the agents, land exactly as they always did.
#
# What is promised: a retry within OP_RETENTION of an id the board has
# committed returns the committed result and applies nothing. What is not: an
# id older than that is forgotten and would apply again, so a client stops
# retrying long before the window closes; and the transcript row is written
# only after the state is installed, so a crash between the two loses the row
# rather than duplicating it, and a replay writes none. Every row still carries
# the id and /thread reads each id once, as a guard for rows written by older
# code or by hand.

def _op_id_ok(op: str) -> bool:
    return 8 <= len(op) <= 64 and set(op) <= OP_ID_CHARS


def _fingerprint(*parts: str) -> str:
    """What a payload looks like to the receipt, so a reused id carrying other
    words is caught. A digest and never the words: the receipt outlives the
    request by days and message text has no business in it twice."""
    return hashlib.sha256("\x1f".join(parts).encode("utf-8", "surrogatepass")).hexdigest()[:32]


def _op_record(op: str) -> dict | None:
    """The receipt for an id, or None once it has aged past OP_RETENTION: a
    receipt past the window is forgotten whether or not the prune has run,
    so the answer to a client never depends on what else the board did."""
    rec = _state.get("ops", {}).get(op)
    if rec is None or time.time() - rec.get("ts", 0) > OP_RETENTION:
        return None
    return rec


def _op_lookup(op: str, fp: str) -> tuple[str, dict | None]:
    """"none" for an id the board has not seen, "same" with the stored record
    for a genuine retry, "mismatch" for the same id under other words."""
    rec = _op_record(op)
    if rec is None:
        return "none", None
    return ("same" if rec.get("fp") == fp else "mismatch"), rec


def _op_commit(op: str, fp: str, kind: str, box: str, result: dict,
               extra: dict | None = None) -> None:
    """The receipt, written into the state the caller is about to save, and the
    old receipts let go here rather than on a clock of their own.

    Two rules, so an eviction can never turn a live retry into a fresh action.
    A receipt past the retention window is dropped, always. If the store is
    still over the soft cap, the oldest are dropped toward it, but only ones
    already older than the floor: a receipt young enough that a phone could
    still be sending its id is kept whatever the count, so a retry always finds
    it and answers from it instead of landing twice. Under one person's use the
    count never nears the cap, so in practice only the retention rule ever runs."""
    ops = _state.setdefault("ops", {})
    now = time.time()
    ops[op] = {"kind": kind, "box": box, "fp": fp, "result": result, "ts": now}
    # what a connection's receipt is revalidated against on replay: its lane,
    # its session, the generation and epoch it was committed under, and the
    # object the route minted. Absent for every caller that sends no session,
    # so an older receipt replays exactly as it always did
    if extra:
        ops[op].update(extra)
    for k in [k for k, r in ops.items() if now - r.get("ts", 0) > OP_RETENTION]:
        del ops[k]
    if len(ops) > OP_KEEP:
        evictable = sorted((r.get("ts", 0), k) for k, r in ops.items()
                           if now - r.get("ts", 0) > OP_EVICT_FLOOR)
        for _ts, k in evictable[:len(ops) - OP_KEEP]:
            del ops[k]


def _op_status(op: str) -> dict:
    """What a phone asks on waking: did this land. unknown means the board has
    no receipt within the window, which within the window means it did not."""
    rec = _op_record(op)
    if rec is None:
        return {"status": "unknown"}
    return {"status": "applied", "kind": rec["kind"], "box": rec.get("box"), "result": rec["result"]}


# ---- the queue a lane reads and chooses from -------------------------------------
# An auto lane is handed whichever card has waited longest, with every
# unanswered message on it. A select lane is handed nothing: it reads rows that
# carry no request text, picks a card, and that selection reserves the card
# through the very same claim the auto path mints, so the colour mask, the 90
# second lease and the 15 minute steal-back are untouched. Opening the
# reservation prepares a delivery and confirms nothing. The board records that
# the text reached the agent's client only once the client says the whole body
# arrived.
#
# Three facts are kept apart on purpose, because only three can be stated
# honestly. A notice outcome says what one adapter could observe. An access
# receipt says a client received a complete body, and names the route that
# carried it. A live work registration says a job registered against a card is
# still running. None of them says the model read or attended to anything, and
# no field below claims it did.
#
# What none of this is: a boundary between projects. The board routes by lane
# and refuses a card that is not in the lane a request names, and the holder
# record stops two connections serving one lane by accident. Those are
# correctness checks and they keep ordinary operation right. They do not stop an
# agent with arbitrary local access that names another lane on purpose, and
# nothing here should be read as saying they do.

UPLOAD_REF = re.compile(r"/uploads/([A-Za-z0-9._%+-]+)")


def _lane_mode(lane: str) -> str:
    """Auto unless the lane was explicitly moved, so state written before any of
    this reads as every lane behaving exactly as it always did."""
    return "select" if _state.get("lane_mode", {}).get(lane) == "select" else "auto"


def _new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def _generation(lane: str) -> int:
    return (_state.get("holders", {}).get(lane) or {}).get("generation", 0)


# ---- who is serving a lane ------------------------------------------------------
# One connection per lane, named by a session id it mints once. This is
# coordination and nothing more: the id is not a credential, the board does not
# authenticate it, and any caller can present another. What it buys is the one
# operational failure worth catching, two connections listening for one project
# by accident, and a generation number that voids a previous holder's
# reservations, deliveries and cached results when the lane genuinely changes
# hands.

def _holder(lane: str) -> dict | None:
    return _state.setdefault("holders", {}).get(lane)


def _holder_out(lane: str) -> dict | None:
    """The holder as a page or a connection sees it. Idle is a server-supplied
    age, never two clocks compared across machines."""
    rec = _holder(lane)
    if rec is None:
        return None
    return {"session": rec.get("session", ""), "agent": rec.get("agent", ""),
            "machine": rec.get("machine", ""), "generation": rec.get("generation", 0),
            "idle_s": round(max(0.0, time.time() - rec.get("last_seen", 0)), 1)}


def _holder_touch(lane: str, session: str, agent: str = "", machine: str = "",
                  override: bool = False) -> tuple:
    """Take or renew this lane's holder record. Answers (record, None) when the
    caller holds the lane after this call, and (None, refusal) when another
    connection does and the caller did not ask to override.

    A lane with no holder, or one whose holder has not called in HOLDER_IDLE
    seconds, is free. Taking it raises the generation, which is what voids the
    previous holder's reservation and prepared deliveries: the card goes back to
    the front of the queue exactly as the unconfirmed lease would have put it.
    Callers hold _lock and save."""
    holders = _state.setdefault("holders", {})
    rec, now = holders.get(lane), time.time()
    if rec and rec.get("session") == session:
        rec["last_seen"] = now
        if agent:
            rec["agent"] = agent[:24]
        if machine:
            rec["machine"] = machine[:48]
        return rec, None
    idle = now - rec.get("last_seen", 0) if rec else 0.0
    if rec and idle <= HOLDER_IDLE and not override:
        return None, {"error": "lane already held", "agent": rec.get("agent", ""),
                      "machine": rec.get("machine", ""), "idle_s": round(idle, 1)}
    fresh = {"session": session, "agent": agent[:24], "machine": machine[:48],
             "generation": (rec.get("generation", 0) if rec else 0) + 1,
             "since": now, "last_seen": now}
    holders[lane] = fresh
    _release_lane_claim(lane, "holder changed")
    if rec and idle <= HOLDER_IDLE:
        # a deliberate override, which is allowed and is always written down:
        # somebody decided a live holder was wrong, and that is worth a line
        _info("holdertaken", lane=lane, generation=fresh["generation"],
              previous=rec.get("agent", ""), idle_s=round(idle, 1))
    else:
        _info("holder", lane=lane, generation=fresh["generation"], agent=fresh["agent"])
    return fresh, None


def _holder_check(lane: str, session: str) -> dict | None:
    """None when this session is the lane's holder, and the record is renewed on
    the way past, which is how a busy connection stays current without a
    heartbeat of its own. A typed refusal otherwise."""
    rec = _holder(lane)
    if rec is None or rec.get("session") != session:
        return {"error": "generation changed", "generation": _generation(lane)}
    rec["last_seen"] = time.time()
    return None


# ---- reservations and deliveries ------------------------------------------------

def _reservation(lane: str) -> dict | None:
    return _state.setdefault("reservations", {}).get(lane)


def _abandon_deliveries(lane: str, why: str, reservation: str | None = None) -> None:
    """A prepared delivery nobody acknowledged is abandoned rather than
    forgotten. The difference matters at the receipt: a body that was prepared
    and then thrown away is refused and said so, while an id the board never
    prepared is simply unknown, and the caller needs to tell those apart."""
    for rec in _state.setdefault("deliveries", {}).values():
        if rec.get("lane") != lane or rec.get("state") != "prepared":
            continue
        if reservation is not None and rec.get("reservation") != reservation:
            continue
        rec["state"] = "abandoned"
        rec["why"] = why


def _drop_reservation(lane: str, why: str) -> None:
    """Let the lane's reservation record go, and abandon whatever it had
    prepared. The claim itself is the caller's business: every path that clears
    the busy slot calls this beside it, so the two never disagree about which
    card a lane is holding."""
    res = _state.setdefault("reservations", {}).pop(lane, None)
    if res is not None:
        _abandon_deliveries(lane, why, res.get("id"))


def _release_lane_claim(lane: str, why: str) -> str | None:
    """Give a lane's held card back to the FRONT of its queue and clear the
    reservation with it, which is the move the unconfirmed lease already makes.
    Answers the card id when there was one. Callers hold _lock and save."""
    _drop_reservation(lane, why)
    bid = _state["busy"].get(lane)
    if bid is None:
        return None
    _state["busy"][lane] = None
    _state["claimed"][lane] = []
    _state["ack"][lane] = None
    box = _box(bid)
    if box and box["pending"] and bid not in _state["inbox"]:
        _state["inbox"].insert(0, bid)
    return bid


def _prune_deliveries(lane: str) -> None:
    """Keep the last DELIVERY_KEEP per lane, prepared and finished together, so
    one lane's history cannot crowd out another's."""
    deliveries = _state.setdefault("deliveries", {})
    mine = sorted((r.get("prepared_ts", 0), k)
                  for k, r in deliveries.items() if r.get("lane") == lane)
    for _ts, key in mine[:max(0, len(mine) - DELIVERY_KEEP)]:
        del deliveries[key]


# ---- rows, and the tag a selection is checked against ---------------------------

def _card_files(b: dict) -> set:
    """Attachment names this card's own text refers to. The upload route answers
    a global URL, so the text a file was written into is the only place that says
    which card it belongs to."""
    parts = [m.get("text", "") for m in b["pending"]]
    parts += [b.get("reply_full", ""), b.get("reply_short", ""),
              b.get("reply", ""), b.get("context", "")]
    return {unquote(hit) for part in parts for hit in UPLOAD_REF.findall(part or "")}


def _row_tag(b: dict) -> str:
    """A digest over the values a selection is actually about, and over nothing
    else: the card id, its title, the ordered ids of the messages waiting on it,
    its stored state, the done and parked flags, whether a job registration is
    live, and how many of those waiting messages this lane has already been
    given. The current time is not in it, nor the wait, the starvation flag, the
    queue position, the board revision or any other card. So a choice is refused
    only when that card itself moved, and never because a minute passed or
    because another lane was busy."""
    waiting = b["pending"]
    return _fingerprint(
        b["id"], b["title"], ",".join(str(m.get("mid")) for m in waiting),
        str(b.get("state", "")), str(bool(b["done"])), str(bool(b.get("parked", False))),
        str(bool(_hb_live(b))), str(sum(1 for m in waiting if m.get("first_acked_ts"))),
    )[:12]


def _queue_row(b: dict, qpos: int, reserved: str | None, now: float) -> dict:
    """One line of the listing. It carries what changes what a good answer looks
    like and it carries no request text: seeing a row is not opening a card."""
    stamps = [m.get("ts", 0) for m in b["pending"]]
    oldest, newest = (min(stamps), max(stamps)) if stamps else (0, 0)
    return {
        "box": b["id"], "title": b["title"], "row": _row_tag(b),
        "waiting": len(b["pending"]), "oldest_ts": oldest, "newest_ts": newest,
        "wait_s": round(now - oldest, 1) if oldest else 0,
        "queue_pos": qpos, "state": b.get("state", ""), "colour": _shown(b),
        "reserved": b["id"] == reserved, "working": _hb_live(b),
        # a previous delivery of these messages was acknowledged, which happens
        # after a restart or a steal-back: an answer may repeat one already given
        "read_before": any(m.get("first_acked_ts") for m in b["pending"]),
        "delivery_attempts": b.get("delivery_attempts", 0),
        "passed_over": b.get("passed_over", 0),
        # where the waiting messages were typed. A message from the small card
        # caps the reply at 100 words, so a row that hides this would let an
        # agent write an answer the board then refuses
        "via": sorted({"mini" if m.get("via") == "mini" else "big" for m in b["pending"]}),
        "attachments": len(_card_files(b)), "task": b.get("task"),
        "worktree": b.get("worktree", ""),
        # advisory only, audited at selection, never refused: the same 15 minutes
        # the steal window already uses
        "starved": bool(oldest) and (now - oldest) > STARVED_AFTER,
    }


def _row_of(bid: str) -> dict | None:
    """The card's current row, for the conflict payloads that carry one."""
    box = _box(bid)
    return None if box is None else _queue_row(box, 0, None, time.time())


def _lane_rows(lane: str, include: set, now: float) -> list:
    """Every card of this lane the listing covers, oldest waiting first. The
    reserved card is not among them: it is reported once, under held."""
    reserved = _state["busy"].get(lane)
    qpos, seen = {}, 0
    for i in _state["inbox"]:
        if (_box(i) or {}).get("owner", "pastureland") != lane:
            continue
        seen += 1
        qpos[i] = seen
    rows = []
    for b in _state["boxes"]:
        if b.get("owner", "pastureland") != lane or b["id"] == reserved:
            continue
        if b["done"] and "done" not in include:
            continue
        if b.get("parked", False) and "parked" not in include:
            continue
        if not b["pending"] and not ("green" in include and _hb_live(b)):
            continue
        rows.append(_queue_row(b, qpos.get(b["id"], 0), reserved, now))
    rows.sort(key=lambda r: (r["oldest_ts"] or now, r["box"]))
    return rows


# ---- the one-time upload association --------------------------------------------

def _scan_uploads_once() -> None:
    """Associate uploads referenced by older cards with those cards, once.

    The upload route answers a global URL with no card association, so the only
    durable record of which card a file belongs to is the text it was written
    into. One pass over the transcript, guarded by a version key in state, in
    the same shape the reply-count scan already uses. An agent on another
    machine cannot read the board's uploads folder, and this is what lets the
    card-scoped attachment route answer it instead."""
    if _state.get("uploads_index_version", 0) >= UPLOADS_INDEX_VERSION:
        return
    index = _state.setdefault("uploads", {})
    lanes = {b["id"]: b.get("owner", "pastureland") for b in _state["boxes"]}
    for b in _state["boxes"]:
        for name in _card_files(b):
            index.setdefault(name, {"box": b["id"], "lane": lanes[b["id"]], "ts": b.get("ts", 0)})
    try:
        with TRANSCRIPT_PATH.open(errors="replace") as transcript:
            for line in transcript:
                try:
                    event = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if not isinstance(event, dict):
                    continue
                bid = event.get("box")
                if not isinstance(bid, str) or bid not in lanes:
                    continue
                for field in ("text", "reply_full", "reply_short"):
                    for hit in UPLOAD_REF.findall(str(event.get(field) or "")):
                        index.setdefault(unquote(hit), {"box": bid, "lane": lanes[bid],
                                                        "ts": event.get("ts", 0)})
    except FileNotFoundError:
        pass
    _state["uploads_index_version"] = UPLOADS_INDEX_VERSION


def _upload_card(lane: str, bid: str, fname: str) -> bool:
    """Whether this file belongs to this card, in this lane. Either the index
    says so, or the card's own current text refers to it."""
    rec = _state.get("uploads", {}).get(fname)
    if rec is not None and rec.get("box") == bid and rec.get("lane", lane) == lane:
        return True
    box = _box(bid)
    return box is not None and box.get("owner", "pastureland") == lane and fname in _card_files(box)


# ---- replaying a receipt --------------------------------------------------------
# Two classes, and the difference is what a restart is allowed to destroy.
#
# A position receipt, selection and opening, describes a place in the queue. A
# restart legitimately destroys that place, so it is replayed only while the
# epoch still matches and the route's live object is still the lane's own.
# Anything else is a typed conflict carrying the card's current row, which the
# caller answers with a fresh id for a fresh selection. That is why a replay
# cannot loop.
#
# An effect receipt, the access receipt, release, reply, note, progress, the
# notice outcome and the work calls, describes something the board already did.
# It returns its recorded outcome whatever the epoch and whatever transition the
# operation itself caused, and the effect never runs twice. A release replays its
# own success although the reservation it removed is gone, which is the point of
# the receipt rather than an exception to it. What is never answered that way is
# a retry after the lane changed hands: minting a new id for the same words is
# how a reply gets written twice, so the caller keeps its id, is told the
# generation moved, and leaves an unresolved receipt for a person.

def _op_extra(lane: str, session: str, obj: str = "") -> dict:
    """What a receipt from a connection is revalidated against later. Omitted
    entirely for the callers that send no session, so the desktop and the phone
    keep exactly the receipt they have always had."""
    return {"lane": lane, "session": session, "object": obj,
            "generation": _generation(lane), "epoch": _state.get("epoch", 0)}


def _replay_check(rec: dict, lane: str, session: str, bid: str) -> dict | None:
    """The checks every replay passes before a stored answer is handed back: the
    same connection, the same lane, the named card in that lane, and the caller
    still holding the generation the receipt was committed under."""
    if rec.get("session") and rec["session"] != session:
        return {"error": "generation changed", "generation": _generation(lane)}
    if rec.get("lane") and rec["lane"] != lane:
        return {"error": "not in this lane"}
    if bid and rec.get("box") and rec["box"] != bid:
        return {"error": "not in this lane"}
    if rec.get("generation") is not None and rec["generation"] != _generation(lane):
        return {"error": "generation changed", "generation": _generation(lane)}
    return None


# ---- what the phone reads ------------------------------------------------------
# The desktop reads the whole board every second and that is right for a page
# on the same machine. The phone reads through a tunnel, so it names the
# revision it has and gets a short answer when nothing has changed, and when
# something has, the cards with the fields the phone draws and none of the
# rest. The live section rides on every answer because it is not part of the
# saved state and so never moves the revision.

def _phone_box(b: dict) -> dict:
    ow = b.get("owner", "pastureland")
    return {
        "id": b["id"], "bucket": b["bucket"], "title": b["title"],
        "replyFull": b.get("reply_full", b.get("reply", "")),
        "done": b["done"], "replies": b["replies"], "olderReplies": _older_replies(b),
        "ball": b.get("ball", "you"),
        "parked": b.get("parked", False), "ts": b.get("ts", 0), "owner": ow,
        "pending": len(b["pending"]),
        "pendingTexts": [m["text"] for m in b["pending"]],
        "pendingStamps": [m.get("ts", 0) for m in b["pending"]],
        # the operation id each queued message was sent under, or null for a
        # message that came without one: the phone matches its own rows by it
        "pendingOps": [m.get("op") for m in b["pending"]],
        "agentTs": b.get("agent_ts", 0), "seen": b.get("seen", 0), "turnTs": b.get("turn_ts", 0),
        # the card's last COMPLETED reply: its own name, when it was completed,
        # and the messages it was given, which is what the box above the answer
        # is drawn from. replyKind says what wrote the words the card is
        # showing, so a page knows whether that reply is the text on the card or
        # a page standing behind a progress note. answered is null when the
        # board recorded no association, which is never a batch of none
        "replyKind": b.get("reply_kind", ""),
        "replyId": b.get("reply_id", ""),
        "replyTs": b.get("reply_ts", 0),
        "answered": _answered_out(b.get("answered")),
        "writing": _state["busy"].get(ow) == b["id"],
        "bg": _hb_live(b), "state": _shown(b),
    }


def _live_section() -> dict:
    now = time.time()
    return {
        "listening": {ow: _waiters.get(ow, 0) > 0 for ow in OWNERS},
        "listenerGap": {ow: round(now - _last_wait.get(ow, 0.0), 1) for ow in OWNERS},
        "agents": {ow: {
            "name": _agent_names.get(ow) or "claude",
            "alive": _waiters.get(ow, 0) > 0 or (now - _last_wait.get(ow, 0.0)) < 900 or bool(_state["busy"].get(ow)),
        } for ow in OWNERS},
    }


def _phone_state(since: int | None, ops: list[str]) -> dict:
    """Callers hold _lock and have swept the clocks."""
    rev = _state.get("rev", 0)
    out = {"rev": rev, "changed": since is None or since != rev, "now": time.time(),
           "live": _live_section()}
    if out["changed"]:
        qpos, seen = {}, {ow: 0 for ow in OWNERS}
        for i in _state["inbox"]:
            ow = (_box(i) or {}).get("owner", "pastureland")
            seen[ow] += 1
            qpos[i] = seen[ow]
        boxes = []
        for b in _state["boxes"]:
            one = _phone_box(b)
            one["queuePos"] = qpos.get(b["id"], 0)
            boxes.append(one)
        out.update({
            "title": _state.get("title", "facilitator"),
            "tabs": _state.get("tabs", {"order": [], "closed": []}),
            "pwds": _lane_pwds(), "projects": _state.get("projects", []),
            "paused": _state.get("paused", False), "boxes": boxes,
        })
    if ops:
        out["ops"] = {op: _op_status(op) for op in ops if _op_id_ok(op)}
    return out


def _ui_state() -> dict:
    """The whole board, for the desktop pages and any older caller. Callers hold _lock."""
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
                # how many older pages the card's reply history holds, the
                # live one excluded: exactly what the arrows in the card's top
                # bar walk. It rides in with the card so the marks are right in
                # the frame the card first draws in, rather than a thread
                # request later. replies above counts progress notes too and
                # is no answer to this
                "olderReplies": _older_replies(b),
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
                # which jobs are behind this card's green, so the board can say
                # what the colour stands for rather than only that it is on.
                # Additive: a page that has not been updated ignores it
                "work": sorted(b.get("work", {})),
                # the card's own worktree, empty for a card that has never
                # been moved; the bar reads the lane's standing branch then
                "worktree": b.get("worktree", ""),
                "agentTs": b.get("agent_ts", 0),
                # the card's last COMPLETED reply, which is what the box over
                # the answer is drawn from: the board's own name for it, when
                # it was completed, and the exact messages it was given. the
                # agent stamp above moves on a progress note as well and so
                # cannot mean any of this. replyKind says what wrote the words
                # the card is showing, so a page can tell a reply standing on
                # the card from one standing behind a note, and answered is
                # null when the board recorded no association at all, which is
                # never the same fact as a reply that was handed nothing
                "replyKind": b.get("reply_kind", ""),
                "replyId": b.get("reply_id", ""),
                "replyTs": b.get("reply_ts", 0),
                "answered": _answered_out(b.get("answered")),
                # replies already read, the board's record rather than one
                # browser's: the page bolds a card whose reply count has
                # passed this, on whichever device is looking
                "seen": b.get("seen", 0),
                # when the card last turned to his turn: the phone's push
                # handler reads the board and names the card that turned last
                "turnTs": b.get("turn_ts", 0),
                "engine": b.get("engine", "claude"),
                "writing": st["busy"].get(b.get("owner", "pastureland")) == b["id"],
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
        # the revision this snapshot is of: every saved change moves it, so a
        # reader holding one can tell whether a later answer is newer
        "rev": st.get("rev", 0),
        # the board's own clock when this reading was made, the way the phone's
        # readings already carry it: a page names the moment of a click by it,
        # so the times it sends back are the board's and not the browser's
        "now": time.time(),
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
        "listening": {ow: _waiters.get(ow, 0) > 0 for ow in OWNERS},
        "everListened": st.get("ever_listened", {}),
        "workspaces": st.get("workspaces", {}),
        # each project's view pages, in the order the foot of the workspace
        # draws them. A lane with an empty list has had all of its pages
        # removed; a lane absent from the map has never been migrated
        "pages": st.get("pages", {}),
        "listenerGap": {ow: round(time.time() - _last_wait.get(ow, 0.0), 1) for ow in OWNERS},
        # the row tag's truth: the lane's last stated agent name, and alive
        # meaning connected now, seen within the steal window, or holding a card
        "agents": {ow: {
            "name": _agent_names.get(ow) or "claude",
            "alive": _waiters.get(ow, 0) > 0
                     or (time.time() - _last_wait.get(ow, 0.0)) < 900
                     or bool(st["busy"].get(ow)),
            # alive but absent from the listening call for over a minute,
            # holding nothing and with no live job registered: the agent is
            # working off the record and the bar says so
            "offrecord": _waiters.get(ow, 0) == 0 and st["busy"].get(ow) is None
                         and 60 < (time.time() - _last_wait.get(ow, 0.0)) < 900
                         and not any(
                             _hb_live(b)
                             for b in st["boxes"] if b.get("owner", "pastureland") == ow),
        } for ow in OWNERS},
        # which connection is serving each lane, and how each lane is served.
        # Both additive, both ignorable, and neither is a claim about who may
        # call: the holder record is coordination between connections
        "holders": {ow: _holder_out(ow) for ow in OWNERS if _holder_out(ow)},
        "laneModes": {ow: _lane_mode(ow) for ow in OWNERS if _lane_mode(ow) != "auto"},
    }


# ---- the routes' locked work --------------------------------------------------
# Each function below is one route's whole answer: it takes the parsed query
# and the body, does its work under _lock where the board is touched, and hands
# back a status and a payload. A dict is answered as JSON; bytes come with
# their content type. None of them writes a socket, so none of them can be
# held up by one. The lines read as the old handler read, one route after
# another, because that is the order anyone looking for a route will use.

class Query(dict):
    """The query string parsed the way it always was, plus the raw string for
    the one route that has to tell a blank value from an absent one, and the
    request path for the routes that read a name out of it."""
    raw: str = ""
    path: str = ""

    def one(self, name: str, default: str = "") -> str:
        values = self.get(name)
        return values[0] if values else default


def _snapshot(payload: dict) -> tuple[bytes, str]:
    """A dict that points into the live state, made into bytes while the lock
    is still held, so the answer is one consistent reading of the board."""
    return json.dumps(payload).encode(), "application/json"


def _file(p: Path, ctype: str):
    if p.is_file():
        return 200, p.read_bytes(), ctype
    return 404, {"error": "not found"}


def _get_root(q: Query, _):
    return 200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8"


def _get_page(q: Query, _):
    # the second UI: the same lanes and the same cards drawn as one typed
    # page, in its own file so editing it can never touch the card board
    return 200, (HERE / "page.html").read_bytes(), "text/html; charset=utf-8"


def _sweep_clocks() -> None:
    """The two lazy clocks a reading runs before it answers: the unconfirmed
    hand-off clock and the working-flag heartbeat. Callers hold _lock. Either
    can move a card and save; if that save fails, the state has already been
    put back to the file and the failure written down, and the reading answers
    that restored board rather than failing too. A reader must not be blacked
    out by a disk the commands are already refusing; the clock runs again on
    the next reading and lands when the disk is back."""
    try:
        _release_unacked()
        _sweep()
    except SaveFailed:
        pass


def _get_state(q: Query, _):
    with _lock:
        # the board polls this about once a second, so the 90 second ack
        # clock gets swept even when no /wait is running to sweep it,
        # and an expired working flag drops out of green (handing over
        # a deferred turn) within about that same second
        _sweep_clocks()
        return 200, *_snapshot(_ui_state())


def _get_phone_state(q: Query, _):
    since_raw = q.one("since")
    try:
        since = int(since_raw) if since_raw else None
    except ValueError:
        return 400, {"error": "bad revision"}
    ops = [op for op in q.one("ops").split(",") if op][:OP_ASK_MAX]
    with _lock:
        _sweep_clocks()
        return 200, *_snapshot(_phone_state(since, ops))


def _get_op(q: Query, _):
    op = q.one("id")
    if not _op_id_ok(op):
        return 400, {"error": "bad operation id"}
    with _lock:
        return 200, {**_op_status(op), "rev": _state.get("rev", 0)}


def _get_worktrees(q: Query, _):
    # the names the card's top bar offers, straight out of git. no lock:
    # nothing here reads or writes the board's state, it only asks the
    # lane's own folder what worktrees it has
    owner = q.one("owner", "facilitator")
    if owner not in OWNERS:
        return 400, {"error": "unknown owner"}
    return 200, _lane_worktrees(owner)


def _get_unread(q: Query, _):
    # a lane's unread count in one line, for a Stop hook deciding
    # whether the agent may go idle and for a human checking a lane
    # without reading the whole board. Read only: it claims nothing,
    # releases nothing and sweeps nothing
    owner = q.one("owner", "pastureland")
    if owner not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        held = set(_state["claimed"].get(owner) or [])
        # anything not already in the claim is still waiting, including
        # messages that landed on a held card after it was claimed
        queued = sum(1 for b in _state["boxes"]
                     if b.get("owner", "pastureland") == owner
                     for m in b["pending"] if m["mid"] not in held)
        return 200, {"queued": queued, "claimed": len(held)}


def _get_fresh(q: Query, _):
    # mid-work delivery: while an agent holds a card, hand over anything
    # that landed on that card after the claim and fold it into the
    # claim, so the one reply covers it and nothing arrives twice
    owner = q.one("owner", "pastureland")
    if owner not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        if _lane_mode(owner) == "select":
            # same reason: mid-work messages on a select lane arrive as their
            # own delivery, with their own receipt, rather than folded into the
            # claim by a route that accounts for nothing
            return 409, {"error": "use open with fresh=1"}
        fbid = _state["busy"].get(owner)
        fbox = _box(fbid) if fbid else None
        if fbox is None:
            return 200, {"messages": [], "message_via": []}
        have = set(_state["claimed"][owner])
        fresh = [m for m in fbox["pending"] if m["mid"] not in have]
        if fresh:
            _state["claimed"][owner].extend(m["mid"] for m in fresh)
            # handed over, so the reply that follows covers them: folded into
            # the claim's own note in the same held stretch the claim itself is
            # extended in, and written durably by the save below
            _hand_over_more(fbox, fresh)
            _log("fresh", fbid, f"{len(fresh)} mid-work message(s) handed over")
            _save()
        # the same marker /wait hands over, in the same shape and order:
        # "mini" for the small card, null for the big one. A mini
        # message that lands mid-work becomes the newest claimed one
        # and brings /reply's 100 word cap with it, so an agent that
        # never sees the marker gets its reply refused out of nowhere
        return 200, *_snapshot({"box": fbid, "messages": [m["text"] for m in fresh],
                                "message_via": [m.get("via") for m in fresh]})


def _get_thread(q: Query, _):
    tbid = q.one("box")
    try:
        n = int(q.one("n", "60"))
    except ValueError:
        return 400, {"error": "bad count"}
    out = []
    legacy_reply_rows = True
    seen_ops: set = set()
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
                    # a row written twice under one operation id is one event
                    # that a crash between the append and the save made the
                    # retry append again; it is read once
                    op = e.get("op")
                    if isinstance(op, str) and op:
                        if (e["kind"], op) in seen_ops:
                            continue
                        seen_ops.add((e["kind"], op))
                    item = {"kind": e["kind"], "text": e.get("text", ""), "ts": e.get("ts", 0)}
                    if e.get("kind") in ("agent", "note"):
                        # Only rows physically before the persisted schema
                        # marker get legacy compatibility. Timestamps never
                        # decide data representation.
                        full = _row_reply_full(e, legacy_reply_rows)
                        if "reply_full" in e or "reply_short" in e:
                            short = e.get("reply_short", full)
                        elif legacy_reply_rows:
                            short = _legacy_reply_variants(e.get("text", ""))[0]
                        else:
                            short = full
                        item.update({"text": full, "replyFull": full, "replyShort": short})
                    out.append(item)
    except FileNotFoundError:
        pass
    return 200, {"messages": out[-n:]}


def _get_history(q: Query, _):
    """One card's older replies, oldest first: what the history arrows walk.

    Only final replies are pages of a card's history, and the one the card is
    showing is left out here rather than guessed at by the page. Both of those
    decisions are the ones _older_replies counts with, so the number sent with
    the card and the length of this list are the same fact stated twice.

    The two things a page cannot do for itself are exactly why this exists
    beside /thread. /thread answers the last n rows of the whole conversation,
    so a card with a long run of progress notes since its last answer can hand
    a page a window with no reply in it at all; the filter here runs before the
    cap, so the cap counts replies. And a page can only tell which reply is the
    live one by comparing text, which gets it wrong when a progress note
    repeats the answer under it word for word; the card's own reply_kind says
    it outright.

    Beside the replies, in the same order and at the same length, replyMeta
    names each page: its own reply id, when it was completed, and the exact
    messages it was given. replies stays a plain list of strings, so a caller
    that only walks the words is untouched by it, and the two lists are trimmed
    and capped together so neither can promise a page the other cannot reach. A
    page written before the board kept batches carries a null id and a null
    batch, which says unknown; nothing is rebuilt for it out of the rows that
    happen to stand near it in the file."""
    hbid = q.one("box")
    with _lock:
        box = _box(hbid)
        if box is None:
            return 400, {"error": "bad box"}
        # read under the lock, scan the file outside it: the transcript is the
        # one thing here big enough that reading it must not hold the board
        live_is_reply = box.get("reply_kind") == "agent"
    replies: list = []
    # one entry per reply above, written in the same step so the two lists can
    # never fall out of step with each other
    meta: list = []
    legacy_reply_rows = True
    seen_ops: set = set()
    try:
        with TRANSCRIPT_PATH.open(errors="replace") as transcript:
            for line in transcript:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(e, dict):
                    continue
                if _is_reply_schema_boundary(e):
                    legacy_reply_rows = False
                    continue
                if e.get("box") != hbid or e.get("kind") != "agent":
                    continue
                # a row written twice under one operation id is one event that
                # a crash between the append and the save made the retry append
                # again; it is read once, the way /thread reads it
                op = e.get("op")
                if isinstance(op, str) and op:
                    if op in seen_ops:
                        continue
                    seen_ops.add(op)
                replies.append(_row_reply_full(e, legacy_reply_rows))
                meta.append(_row_reply_meta(e))
                if len(replies) > HISTORY_MAX + 1:
                    del replies[0]
                    del meta[0]
    except FileNotFoundError:
        pass
    if live_is_reply and replies:
        replies.pop()   # the newest final reply is the page the card is on
        meta.pop()      # and its entry goes with it, or the two would be a page apart
    return 200, {"replies": replies[-HISTORY_MAX:] if replies else [],
                 "replyMeta": meta[-HISTORY_MAX:] if meta else []}


def _get_log(q: Query, _):
    try:
        n = int(q.one("lines", "120"))
    except ValueError:
        return 400, {"error": "bad count"}
    try:
        lines = _log_file().read_text(errors="replace").splitlines()[-n:]
    except OSError:
        lines = []
    return 200, {"lines": lines}


def _get_dirs(q: Query, _):
    # the page's folder chooser: one folder's subdirectories, rooted at
    # and fenced to the user's home; hidden folders stay out of sight
    home = Path.home()
    raw = q.one("path").strip()
    try:
        p = (Path(raw).expanduser() if raw else home).resolve()
    except OSError:
        return 400, {"error": "bad path"}
    if p != home and home not in p.parents:
        return 400, {"error": "outside the home directory"}
    if not p.is_dir():
        return 400, {"error": "not a directory"}
    try:
        subs = sorted((c for c in p.iterdir()
                       if c.is_dir() and not c.name.startswith(".")),
                      key=lambda c: c.name.lower())
    except OSError:
        return 400, {"error": "unreadable directory"}
    return 200, {"path": str(p),
                 "parent": str(p.parent) if p != home else None,
                 "dirs": [{"name": c.name, "path": str(c)} for c in subs]}


def _get_pickdir(q: Query, _):
    # tests must never open the dialog: FACILITATOR_PICKDIR_STUB set on
    # the server process answers with its value instead of the chooser
    stub = os.environ.get("FACILITATOR_PICKDIR_STUB")
    if stub:
        return 200, {"path": stub}
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
        return 200, {"cancelled": True}
    except OSError as e:
        return 200, {"error": str(e)}
    if r.returncode != 0:
        # the chooser exits nonzero on cancel (-128); anything else
        # nonzero is a real failure and says so
        err = (r.stderr or "").strip()
        if not err or "-128" in err:
            return 200, {"cancelled": True}
        return 200, {"error": err}
    return 200, {"path": r.stdout.strip()}


def _get_upload(q: Query, _):
    fn = q.path[len("/uploads/"):]
    if not fn or "/" in fn or "\\" in fn or fn in (".", ".."):
        return 404, {"error": "not found"}
    for base in (INTERNAL_UPLOADS, HERE / "uploads"):
        p = base / fn
        if p.is_file() and p.resolve().parent == base.resolve() and p.suffix.lower() in UPLOAD_TYPES:
            disposition = "attachment" if q.one("download") == "1" or p.suffix.lower() in (".doc", ".docx") else "inline"
            return FileResponse(p, media_type=UPLOAD_TYPES[p.suffix.lower()], filename=re.sub(r"^\d{13,19}-", "", fn),
                                content_disposition_type=disposition,
                                headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                         "Content-Security-Policy": "sandbox"})
    return 404, {"error": "not found"}


def _get_laneimg(q: Query, _):
    # a picture out of the lane's own internal folder, so an agent
    # working in another project writes next to its own code instead of
    # reaching into this repo. one lane, one plain file name, images only
    lane, _sep, fn = q.path[len("/laneimg/"):].partition("/")
    base = _lane_internal(lane) if lane else None
    # a name with a separator in it is never a file in this folder, and
    # refusing it here kills nested and absolute paths before pathlib
    # gets a chance to be clever about them
    if base is None or not fn or "/" in fn or fn in (".", ".."):
        return 404, {"error": "not found"}
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
        return 200, p.read_bytes(), IMG_TYPES[p.suffix.lower()]
    return 404, {"error": "not found"}


def _get_manifest(q: Query, _):
    # the install prompt reads the app's name from here and the page
    # reads its own from the board title, so a name written into the
    # file could only ever disagree with it. That one field is answered
    # from the saved title; every other field is the file's own, and a
    # board with no title leaves even that alone
    p, ctype = PHONE_FILES["/m-manifest.json"]
    if not p.is_file():
        return 404, {"error": "not found"}
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
    return 200, raw, ctype


def _get_push_key(q: Query, _):
    try:
        key = _b64url(_push_public_key())
    except Exception as e:
        return 500, {"error": f"push key unavailable: {e}"}
    return 200, {"key": key}


def _get_mdfiles(q: Query, _):
    # what the markdown panel lists: every .md under the two folders the
    # lane in the query owns, each one re-checked for containment rather
    # than trusted because it came out of a walk. A folder that does not
    # exist yet, or holds nothing, comes back present and empty, so the
    # panel can say so instead of looking broken. The kind each folder
    # answers to goes back with it, since that is what the page labels
    # its two tabs with and it is the only part of the name a lane's
    # panel can know before it has asked
    lane = q.one("lane")
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
    return 200, {"roots": roots}


def _get_mdfile(q: Query, _):
    # one markdown file's whole text, with the stamp the save guard will
    # want back. Not decoded loosely: a file that is not utf-8 is
    # reported as such rather than handed over with replacement
    # characters that a later save would then write back over the real
    # bytes
    p = _md_path(q.one("lane"), q.one("root"), q.one("rel"))
    if p is None:
        return 400, {"error": "outside the markdown folders"}
    if not p.is_file():
        return 404, {"error": "no such file"}
    try:
        text = p.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        return 400, {"error": "not utf-8 text"}
    except OSError:
        return 400, {"error": "unreadable file"}
    # windows line endings are carried to the page rather than silently
    # flattened: the editor is told to keep them so a save writes the
    # file back in the endings it arrived in
    return 200, {"root": q.one("root"), "rel": q.one("rel"),
                 "text": text, "mtime": _md_stamp(p), "crlf": "\r\n" in text}


# -- the agent's long poll, in three locked steps ------------------------------
# The waiting itself happens on the event loop (WaitRoute below), so a hundred
# agents waiting would cost a hundred coroutines and no threads at all. What
# needs the lock is short: entering, one attempt to claim, and leaving.

def _wait_enter(owner: str, agent: str | None) -> None:
    """Count one more listener on this lane. The first ever listen for an owner
    records ever_listened and saves it, and the count is bumped only once that
    save has gone through: a save that fails raises before the bump and rolls
    _state back, so a lane can never be left showing a listener that a failed
    first wait never really had. Callers reach _wait_leave only when this
    returned, so the bump and the later decrement stay balanced."""
    with _lock:
        if agent:
            _agent_names[owner] = agent[:24]
        ev = _state.setdefault("ever_listened", {})
        if not ev.get(owner):
            ev[owner] = True
            _save()   # raises SaveFailed on failure, before the count is touched
        _waiters[owner] += 1


def _wait_leave(owner: str) -> None:
    with _lock:
        _waiters[owner] -= 1
        _last_wait[owner] = time.time()


def _wait_poll(owner: str):
    """One pass over the lane: the clocks, the steal-back, then a claim if a
    box is waiting. Answers (kind, payload) with kind one of paused, end or
    claim, or None when there is nothing to say yet."""
    with _lock:
        if _state.get("paused"):  # laptop-close mode: send the listener home
            return "paused", {"paused": True}
        # the short clock first: a hand-off nobody confirmed comes back
        # after 90 seconds, long before the steal-back below notices
        _release_unacked()
        # and a working flag that stopped pinging drops its card out of
        # green, handing over a turn deferred under it
        _sweep()
        # a claim older than 15 min with no reply is a dead listener: steal it back
        for ow in OWNERS:
            stale = _state["busy"].get(ow)
            if stale is not None and time.time() - _state["busy_ts"].get(ow, 0) > 900:
                _state["busy"][ow] = None
                _state["claimed"][ow] = []
                _drop_reservation(ow, "claim stolen back")
                if _box(stale) and _box(stale)["pending"] and stale not in _state["inbox"]:
                    _state["inbox"].insert(0, stale)
                _save()
        if _lane_mode(owner) == "select":
            # a select lane is never handed a card here. The wait still blocks
            # and still registers the listener, and when work is waiting it
            # answers the same counts the notification route answers, so a loop
            # pointed at the old route learns there is something to look at
            # without being given anything it did not choose
            cards, queued, oldest = _notify_queued(owner)
            if cards:
                return "queued", {"queued": queued, "cards": cards,
                                  "oldest_wait_s": round(time.time() - oldest, 1) if oldest else 0,
                                  "select": True, "use": "GET /queue"}
        elif _state["busy"][owner] is None:
            bid = next((i for i in _state["inbox"]
                        if (_box(i) or {}).get("owner", "pastureland") == owner), None)
            if bid is not None:
                _state["inbox"].remove(bid)
                box = _box(bid)
                _state["busy"][owner] = bid
                _state["claimed"][owner] = [m["mid"] for m in box["pending"]]
                # the hand-over itself, which is the one moment that can say
                # what a reply was given: this claim's own messages are noted
                # right here where the delivery happens. the claim is minted
                # whole and the note is written whole with it, so nothing an
                # earlier claim left behind can reach a later answer. a message
                # landing on this card after this line was handed over by
                # nothing, and nothing covers it until /fresh or a later claim
                # delivers it
                _hand_over(box, box["pending"])
                _state["busy_ts"][owner] = time.time()
                # every claim is provisional: the token below is what
                # POST /ack has to name, and until it does this claim is
                # on the 90 second clock. A lane holds one claim, so one
                # record per lane says everything about it
                token = secrets.token_hex(6)
                _state["ack"][owner] = {"box": bid, "token": token,
                                        "ts": time.time(), "confirmed": False}
                # that a receipt was minted, never the receipt itself
                _debug("claim", bid, owner=owner, token=bool(token))
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
                return "claim", payload
        if _state["end"] and _state["busy"][owner] is None and not any(
                (_box(i) or {}).get("owner", "pastureland") == owner for i in _state["inbox"]):
            return "end", {"end": True}
        return None


def _rollback_claim(owner: str, bid: str, token: str) -> bool:
    """A hand-off that never reached its listener is undone: the box goes back
    to the FRONT of its lane's queue, exactly as a dead-socket write always
    did. Only the claim this token was minted for is touched. If the token has
    since been confirmed, the listener did get it and the claim stands; if the
    lane holds another claim or another token, that claim is somebody else's
    and stands too. True when something was rolled back."""
    with _lock:
        rec = _state.get("ack", {}).get(owner)
        if (not rec or rec.get("token") != token or rec.get("confirmed")
                or rec.get("box") != bid or _state["busy"].get(owner) != bid):
            return False
        _state["busy"][owner] = None
        _state["claimed"][owner] = []
        _state["ack"][owner] = None
        _drop_reservation(owner, "hand-off died on the wire")
        if bid not in _state["inbox"]:
            _state["inbox"].insert(0, bid)
        _log("dropped", bid, f"{owner} hand-off died on the wire, box re-queued")
        _save()
        _notify()
        return True


# -- POST -----------------------------------------------------------------------

def _post_upload(q: Query, raw: bytes):
    if not raw:
        return 400, {"error": "empty upload"}
    name = q.one("name", "file")
    safe = "".join(c for c in name if c.isalnum() or c in "._- ").strip()[-100:] or "file"
    if Path(safe).suffix.lower() not in UPLOAD_TYPES:
        return 415, {"error": "unsupported file type; choose an image, video, audio, PDF or Word file"}
    up = INTERNAL_UPLOADS
    up.mkdir(parents=True, exist_ok=True)
    # Exclusive creation keeps simultaneous uploads with the same name distinct.
    stamp = time.time_ns()
    fname = f"{stamp}-{safe}"
    with (up / fname).open("xb") as target:
        target.write(raw)
    bid = q.one("box")
    if bid:
        # which card this file belongs to, recorded where the association is
        # actually known. A caller that names no card changes nothing, which is
        # every caller that exists today, and those files are associated by the
        # text they are written into instead
        with _lock:
            box = _box(bid)
            if box is not None:
                _state.setdefault("uploads", {})[fname] = {
                    "box": bid, "lane": box.get("owner", "pastureland"), "ts": time.time()}
                _save()
    return 200, {"url": "/uploads/" + quote(fname)}


def _post_clientlog(q: Query, raw: bytes):
    # what a page noticed and has no other way to say: a thrown error, a
    # rejected promise, a fetch or a render that failed, a timer that ran
    # late. The size cap is applied to the body before it is read at all
    try:
        batch = json.loads(raw.decode("utf-8", "replace")) if raw else None
    except ValueError:
        batch = None
    page = batch.get("page") if isinstance(batch, dict) else None
    reports = batch.get("reports") if isinstance(batch, dict) else None
    if (page not in CLIENT_PAGES or not isinstance(reports, list) or not reports
            or not all(isinstance(r, dict) and r.get("kind") in CLIENT_KINDS
                       for r in reports)):
        # nothing of a batch this board cannot read is stored, the way
        # every other record-taking route on here already refuses
        return 400, {"error": "bad report batch"}
    if len(reports) > CLIENT_MAX_REPORTS:
        return 400, {"error": "too many reports in one batch"}
    if any(r["kind"] == "incident" and not _incident_valid(page, r) for r in reports):
        return 400, {"error": "bad incident history"}
    try:
        written, dropped = _client_batch(page, reports)
    except OSError:
        return 503, {"error": "the diagnostic log could not be written"}
    return 200, {"ok": True, "written": written, "dropped": dropped}


def _post_mdsave(q: Query, raw: bytes):
    # the body is taken raw because the shared text read strips it: a
    # markdown file's trailing newline is content and losing it would break
    # the round trip on the very first save
    p = _md_path(q.one("lane"), q.one("root"), q.one("rel"))
    if p is None:
        return 400, {"error": "outside the markdown folders"}
    if not p.is_file():
        return 404, {"error": "no such file"}
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return 400, {"error": "not utf-8 text"}
    # the stale-write guard: the stamp the page was handed on read comes
    # back here, and a file whose stamp has moved since is one somebody
    # else has written. Refused with the current stamp so the page can
    # say plainly what happened; his text is never merged or dropped for
    # him, it stays in the editor where he can still see it
    try:
        now = _md_stamp(p)
    except OSError:
        return 400, {"error": "unreadable file"}
    was = q.one("mtime")
    if was and was != now:
        return 409, {"error": "changed on disk", "mtime": now}
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
        return 400, {"error": str(e)}
    return 200, {"ok": True, "mtime": _md_stamp(p)}


def _post_send(q: Query, text: str):
    bid = q.one("box")
    via = "mini" if q.one("via") == "mini" else ""
    op = q.one("op")
    if op and not _op_id_ok(op):
        return 400, {"error": "bad operation id"}
    with _lock:
        fp = _fingerprint("send", bid, via, text) if op else ""
        if op:
            # the receipt is read before the box is even looked at: a message
            # that landed on a card since closed still landed
            found, rec = _op_lookup(op, fp)
            if found == "mismatch":
                return 409, {"error": "operation id reused with a different payload"}
            if found == "same":
                return 200, {**rec["result"], "rev": _state.get("rev", 0), "replayed": True}
        box = _box(bid)
        if box is None or not text:
            return 400, {"error": "bad box or empty text"}
        msg = {"mid": _state["next_mid"], "text": text, "ts": time.time()}
        # where he typed it: via=mini means the small card in the corner.
        # Only that literal is kept, so a caller that passes nothing (the
        # big card, any older sender) stores exactly what it always did
        if via:
            msg["via"] = "mini"
        if op:
            msg["op"] = op
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
        result = {"ok": True, "mid": msg["mid"], "box": bid}
        if op:
            _op_commit(op, fp, "send", bid, result)
        # the row is queued and written by the save once the new file is
        # installed, so a save that failed and rolled the message back leaves
        # no row for a message the board never durably had
        _log("user", bid, text, log_fields={"op": op} if INCIDENT_OP.fullmatch(op) else None,
             mid=msg["mid"], **({"op": op} if op else {}))
        _save()
        _notify()
        return 200, {**result, "rev": _state["rev"]}


def _post_ack(q: Query, text: str):
    # the other half of the hand-off: the token /wait handed out
    # comes back here and the provisional claim becomes a real one.
    # Nothing else about the claim changes, so a confirmed claim is
    # exactly what /fresh, /reply and the steal-back always saw
    ow = q.one("owner", "pastureland")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    token = q.one("token")
    with _lock:
        if _lane_mode(ow) == "select":
            # a select lane has one accounting path, and it is the one that
            # names the delivery it is acknowledging
            return 409, {"error": "use opened"}
        rec = _state.get("ack", {}).get(ow)
        if not token or not rec or rec.get("token") != token:
            return 409, {"error": "unknown or stale token"}
        if rec.get("confirmed"):
            # idempotent: a resent ack is the same ack, never a 409
            return 200, {"ok": True, "box": rec["box"]}
        if _state["busy"].get(ow) != rec.get("box"):
            # the claim this token names is already over: released by
            # the 90 second clock, stolen back, replied to or dismissed
            return 409, {"error": "claim no longer held"}
        rec["confirmed"] = True
        _debug("ackok", rec["box"], owner=ow, token=bool(token))
        _log("ack", rec["box"], f"{ow} confirmed delivery")
        _save()
        return 200, {"ok": True, "box": rec["box"]}



def _card_receipt(q: Query, kind: str, lane: str, bid: str, *parts: str):
    """The lookup half of a durable receipt on a route that answers a card, and
    the holder check that goes with it.

    Answers (outcome, fingerprint). An outcome that is not None is what the
    route must return instead of doing its work: a refusal, or the outcome this
    very operation already had. A caller that names no operation id gets
    (None, "") and behaves in every respect as it always did, which is what
    keeps the desktop, the phone and the existing agent loop unchanged.

    These are effect receipts. They describe something the board already did, so
    a retry returns the recorded outcome whatever the epoch, and the words are
    stored once. The one thing never answered from a receipt is a retry after
    the lane changed hands: minting a fresh id for the same words is how a reply
    gets written twice, so the caller keeps its id and is told the generation
    moved. Callers hold _lock."""
    session = q.one("session")
    if session:
        refusal = _holder_check(lane, session)
        if refusal:
            return (409, refusal), ""
    op = q.one("op")
    if not op:
        return None, ""
    if not _op_id_ok(op):
        return (400, {"error": "bad operation id"}), ""
    fp = _fingerprint(kind, bid, *parts)
    found, rec = _op_lookup(op, fp)
    if found == "mismatch":
        return (409, {"error": "operation id reused with a different payload"}), fp
    if found == "same":
        bad = _replay_check(rec, lane, session, bid)
        if bad:
            return (409, bad), fp
        return (200, {**rec["result"], "replayed": True}), fp
    return None, fp


def _card_commit(q: Query, fp: str, kind: str, lane: str, bid: str, result: dict) -> None:
    """The commit half, written into the state the caller is about to save."""
    if not fp:
        return
    session = q.one("session")
    _op_commit(q.one("op"), fp, kind, bid, result,
               _op_extra(lane, session) if session else None)


def _post_reply(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        if "quiet" in q:
            return 400, {"error": "quiet replies were removed; use /note for progress"}
        # the summary strip is optional as of 20260821: the owner had
        # the summary box taken off the card, so nothing displays it and
        # the agent no longer writes one. a ctx that is passed is still
        # stored and still size checked, so older callers keep working
        ctx = q.one("ctx").strip()
        if ctx and len(ctx.split()) > 50:
            # refused outright, never silently chopped
            return 400, {"error": "context strip over 50 words"}
        ow = box.get("owner", "pastureland")
        # The compact version is data, not punctuation inside the full
        # prose. keep_blank_values distinguishes an intentionally empty
        # small card from an omitted version, which mirrors the full one.
        short_values = parse_qs(q.raw, keep_blank_values=True).get("short")
        short = short_values[0].strip() if short_values is not None else None
        # a message typed in the small card gets a small answer back:
        # that card is a few lines tall and a long reply is unreadable
        # in it. The newest message the claim covers is the one being
        # answered, so that one decides. Refused outright like the
        # context strip above, never silently chopped
        outcome, fp = _card_receipt(q, "reply", ow, bid, ctx, "" if short is None else short, text)
        if outcome is not None:
            return outcome
        held = _state["claimed"][ow] if _state["busy"][ow] == bid else []
        answering = next((m for m in box["pending"] if m["mid"] == held[-1]), None) if held else None
        if answering is not None and answering.get("via") == "mini":
            words = len((text if short is None else short).split())
            if words > 100:
                return 400, {"error": f"small card reply over 100 words: {words} words"}
        _last_wait[ow] = time.time()  # a reply proves that agent is alive too
        _set_reply_variants(box, text, short)
        box["replies"] += 1
        # and the count the history arrows walk, which the aggregate above
        # cannot be: it counts progress notes too. The card is showing this
        # reply now, so it is the page you are on rather than one behind you
        box["full_replies"] = box.get("full_replies", 0) + 1
        box["reply_kind"] = "agent"
        # The machine's sole answer move, taken once the claim is let
        # go below. While a working flag beats, the final turn waits in
        # deferred and is handed over when that work ends.
        now = time.time()
        box["agent_ts"] = now  # when the agent last replied
        box["ts"] = now
        if ctx:
            box["context"] = ctx
        _release_claim(box, for_answer=True)
        # What this reply answers, recorded with the reply itself. It is made of
        # the board's own claim identities and of nothing else: what the
        # progress notes on the way consumed, and what the claim in force at
        # this moment handed over, which the release above has just folded in.
        # A claim that was dismissed unanswered is in neither, so this reply
        # cannot inherit it; a message that arrived after the claim was handed
        # over by nothing and waits in the queue for a reply that is given it.
        # Every member is kept, however many there are.
        # The card starts from nothing again, so the next completed answer opens
        # its own association and no message is ever answered twice. A hand-over
        # this board has no record of records null here, which says unknown and
        # is not the same as a reply that was handed nothing.
        box["answered"] = _take_answered(box)
        box["reply_id"] = _next_reply_id(bid)
        # when this reply was completed. agent_ts above cannot mean that: a
        # progress note moves that stamp and leaves this one standing, which is
        # what lets a card opened later age the box over its answer by the
        # answer's own clock
        box["reply_ts"] = now
        if _hb_live(box):
            box["state"] = "deferred"
        else:
            _turn_to_you(box)
            box["state"] = _rest(box)
        # the row carries the same three facts, so an older page of the history
        # states what it answered and when it was completed exactly as the card
        # states them for the live one. they ride on the transcript row and not
        # on the log line, like the words themselves, since what was said is not
        # the log's business
        _log("agent", bid, text, reply_full=text,
             reply_short=box["reply_short"],
             reply_variants_version=REPLY_VARIANTS_VERSION,
             reply_id=box["reply_id"], reply_ts=now,
             answered=box["answered"])
        _card_commit(q, fp, "reply", ow, bid, {"ok": True, "box": bid})
        _save()
        _notify()
        return 200, {"ok": True}


def _post_note(q: Query, text: str):
    # The sole background-progress action. It releases a held claim,
    # owns an explicit note state and keeps the turn with the agent,
    # so it can never turn yellow when its heartbeat ends.
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        ctx = q.one("ctx").strip()
        if ctx and len(ctx.split()) > 50:
            return 400, {"error": "context strip over 50 words"}
        ow = box.get("owner", "pastureland")
        outcome, fp = _card_receipt(q, "note", ow, bid, ctx, text)
        if outcome is not None:
            return outcome
        _last_wait[ow] = time.time()  # a note proves that agent is alive too
        _set_reply_variants(box, text)
        box["replies"] += 1
        # a note is not a page of the reply history: it adds none and hides
        # none, so the final reply it was written over becomes an older page
        box["reply_kind"] = "note"
        box["agent_ts"] = time.time()
        box["ts"] = time.time()
        if ctx:
            box["context"] = ctx
        # the claim goes, and the messages it covered leave the pending list
        # with it. but a note is not an answer, so the claim is let go FOR the
        # answer: what it consumed is kept for the completed reply still to
        # come, and several notes may each consume their own claim toward that
        # one reply. nothing here writes answered, reply_id or reply_ts either,
        # so the last completed reply keeps its own name, its own completion
        # time and its own batch while this note stands over it, and no page can
        # present this note as an answer to anything
        _release_claim(box, for_answer=True)
        box["ball"] = "me"
        box["hb"] = time.time()
        box["state"] = "note"
        _log("note", bid, text, reply_full=text, reply_short=text,
             reply_variants_version=REPLY_VARIANTS_VERSION)
        _card_commit(q, fp, "note", ow, bid, {"ok": True, "box": bid})
        _save()
        _notify()
        return 200, {"ok": True}


def _post_done(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        box["done"] = q.one("v", "1") == "1"
        if box["done"]:
            box["parked"] = False
        _log("done" if box["done"] else "undone", bid, "")
        _save()
        _notify()
        return 200, {"ok": True}


def _post_working(q: Query, text: str):
    # a job runs behind this card: green without a claim, so the
    # lane stays free. Registration starts a heartbeat clock; the
    # job (or agent) must /ping while it runs, or green expires.
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        box["hb"] = time.time() if q.one("v", "1") == "1" else 0
        if box["hb"]:
            _green(box)
        # v=0 is one of the two ways out of green, so the sweep runs
        # right here and a deferred turn is handed over at once. v=1
        # re-registers and the flag beats again, so a deferred card
        # just keeps waiting, which is what re-registering should mean. This
        # route saves once below, including anything this sweep moves.
        _sweep(persist=False)
        _log("working" if box["hb"] else "workdone", bid, "")
        _save()
        _notify()
        return 200, {"ok": True}


def _post_ping(q: Query, text: str):
    # heartbeat for a registered job; keeps the card's green alive
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        if box.get("hb"):
            box["hb"] = time.time()
            _green(box)  # a registered job beating again takes back its green
        return 200, {"ok": True, "bg": bool(box.get("hb"))}


# ---- the order of each page's own park commands -------------------------------
# A page can stop waiting for an answer; it cannot recall the request. An abort
# there drops the answer, not the bytes already on their way here. So a snooze
# the phone gave up on can still arrive after the unsnooze that replaced it,
# and absolute values applied in arrival order would leave the board holding
# the value he undid. Only this side sees the arrivals, so only this side can
# refuse them.
#
# The contract. A page names its own command stream (sid) and numbers every
# attempt in it (seq), rising and never reused. This remembers, for a card and
# a stream TOGETHER, the highest place already judged from that stream, and
# refuses anything from that same stream at or below it: a command the page
# that sent it has already replaced.
#
# One fact per stream, not one per card, and that distinction is the whole of
# it. A single fact per card fails this sequence: page A place 2 unsnoozes;
# page B place 1 unsnoozes, which is B's first command and so is applied; then
# A's abandoned place 1 snooze arrives. It is obsolete inside A's own stream,
# but B had taken the card's only slot, so it was applied and the card snoozed
# itself again behind him. Keeping A's fact beside B's answers that with no
# comparison of clocks or of tap times between devices: both newer commands
# agree, and the last one is simply behind A's own high water mark.
#
# Identity: sid names one page load. It is not a person, a device or a card, it
# is never logged and never saved, and nothing else reads it.
# Lifetime: this process only, and a finite time within it. A restart begins
# with no facts at all, so a command that crosses a restart is ordered against
# nothing. What becomes of requests already in transit across a restart is not
# something this code establishes, and nothing here relies on it.
# Limits: a name is at most _PARK_ID_MAX characters of letters, digits, dash
# and underscore; a place is a whole number in range. Accepting a newer ordered
# command prunes pairs older than _PARK_ORDER_TTL seconds and removes the oldest
# pairs once more than _PARK_ORDER_MAX are held. A pair that has been
# forgotten orders nothing, which is exactly where this route began.
# The record is read and written only under _lock, with the board it belongs to.
#
# What it is not. It is not a receipt: it answers "is this obsolete", not "has
# this been done before", and it keeps no results to replay. It orders nothing
# BETWEEN pages: a command that is not obsolete within its own stream is
# applied, so two devices stay last writer wins, exactly as they were.
_PARK_ORDER: dict[tuple[str, str], dict] = {}   # (card, stream) -> place, when
_PARK_ORDER_TTL = 900.0
_PARK_ORDER_MAX = 1024
_PARK_ID_MAX = 64
_PARK_ID_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def _park_order_read(q: Query):
    """The stream and place a park names itself by, or None from a caller that
    names none. A pair half given or malformed raises instead: that is a broken
    caller rather than an older one, and saying so is better than guessing."""
    sid, seq = q.one("sid", ""), q.one("seq", "")
    if not sid and not seq:
        return None
    if not sid or not seq:
        raise ValueError("half an order")
    if len(sid) > _PARK_ID_MAX or not set(sid) <= _PARK_ID_CHARS:
        raise ValueError("stream name")
    place = int(seq)   # anything that is not a whole number raises here
    if not 0 <= place <= 2 ** 53:
        raise ValueError("place out of range")
    return sid, place


def _park_order_keep(bid: str, sid: str, place: int, now: float) -> None:
    """This stream's place for this card, kept beside whatever other streams
    hold for the same card, and the record kept small: pairs go on age first,
    then the oldest go when there are more of them than the limit."""
    _PARK_ORDER[(bid, sid)] = {"seq": place, "at": now}
    for old in [k for k, v in _PARK_ORDER.items() if now - v["at"] > _PARK_ORDER_TTL]:
        del _PARK_ORDER[old]
    while len(_PARK_ORDER) > _PARK_ORDER_MAX:
        del _PARK_ORDER[min(_PARK_ORDER, key=lambda k: _PARK_ORDER[k]["at"])]


def _post_park(q: Query, text: str):
    bid = q.one("box")
    want = q.one("v", "1") == "1"
    try:
        order = _park_order_read(q)
    except ValueError:
        return 400, {"error": "bad park order"}
    # What a snooze was decided on: the board's own clock at the moment the moon
    # was tapped, which the page can name because every reading carries the
    # board's time. A snooze that crossed one of his messages on the way here
    # was decided before that message existed, and a card he has just written to
    # is not a card he is snoozing, so the board keeps what it has and says so
    # rather than burying the message under a defer.
    #
    # The guard is deliberately the narrowest one that answers that: only a
    # park, only against his own queued messages, and only when a basis is
    # given. An unpark, an older page that sends no basis, an agent's progress
    # note and a park of a done card all behave exactly as they always did, and
    # a basis that will not read as a number is no basis at all.
    try:
        basis = float(q.one("after", "") or 0)
    except ValueError:
        basis = 0.0
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        # the card as it stands, for any answer that keeps it that way
        kept = {"parked": box.get("parked", False), "done": box["done"],
                "rev": _state.get("rev", 0)}
        if order is not None:
            sid, place = order
            prior = _PARK_ORDER.get((bid, sid))
            if prior is not None and place <= prior["seq"]:
                # this same page has already sent a later command for this card
                # and that one has been judged: this is its own undone value
                # arriving late, and applying it would undo the undoing. Another
                # page's commands are not consulted and cannot rescue it
                return 200, {"ok": False, "stale": "superseded", **kept}
            # this stream has reached here, so everything it sent before this is
            # old, whether or not this one goes on to be applied
            _park_order_keep(bid, sid, place, time.time())
        if want and basis:
            newest = max((m.get("ts", 0) for m in box["pending"]), default=0)
            if newest > basis:
                # nothing was written and nothing is being retried: the page is
                # told plainly which state the card is actually in
                return 200, {"ok": False, "stale": "message", **kept}
        box["parked"] = want
        if box["parked"]:
            box["done"] = False
        _log("park" if box["parked"] else "unpark", bid, "")
        _save()
        _notify()
        return 200, {"ok": True, "parked": box["parked"], "done": box["done"],
                     "rev": _state["rev"]}


def _post_worktree(q: Query, text: str):
    # the card's own worktree, held on the card and not guessed from
    # a text convention. empty means the lane's standing branch,
    # which is what the bar falls back to, so a card that has never
    # been moved carries nothing and still shows a true name
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        name = q.one("name")
        if name and name not in _lane_worktrees(box.get("owner", "pastureland"))["names"]:
            return 400, {"error": "unknown worktree"}
        box["worktree"] = name
        _log("worktree", bid, name)
        _save()
        _notify()
        return 200, {"ok": True}


def _post_context(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        if len(text.split()) > 50:
            return 400, {"error": "context strip over 50 words"}
        box["context"] = text  # agent-maintained; refused over 50 words
        _save()
        _notify()
        return 200, {"ok": True}


def _post_title(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None or (not text and box["title"]):
            return 400, {"error": "bad box or empty title"}
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
        _notify()
        return 200, {"ok": True, "title": box["title"]}


def _post_create(q: Query, text: str):
    owner = q.one("owner", "facilitator")
    op = q.one("op")
    if op and not _op_id_ok(op):
        return 400, {"error": "bad operation id"}
    with _lock:
        fp = _fingerprint("create", owner, text) if op else ""
        if op:
            found, rec = _op_lookup(op, fp)
            if found == "mismatch":
                return 409, {"error": "operation id reused with a different payload"}
            if found == "same":
                made = _box(rec["result"].get("id", ""))
                return 200, {**rec["result"], "rev": _state.get("rev", 0), "replayed": True,
                             "card": _phone_box(made) if made else None}
        if owner not in OWNERS:
            return 400, {"error": "unknown owner"}
        # born nameless; a whimsical name lands only if naming is walked
        # away from (the empty-body /title call below)
        title = (text or "").splitlines()[0][:80] if text else ""
        bid_new = f"m{_state['next_bid']}"  # never reused, even after deletes
        _state["next_bid"] += 1
        # keep each meta section grouped: insert after its last same-owner meta box
        idx = max([i for i, b in enumerate(_state["boxes"])
                   if b["bucket"] == "meta" and b.get("owner") == owner] or [-1]) + 1
        ws0 = (_state.get("workspaces", {}).get(owner) or [{}])[0].get("id")
        made = {
            "id": bid_new, "bucket": "meta", "title": title, "reply": "",
            "reply_full": "", "reply_short": "",
            "pending": [], "done": False, "parked": False, "replies": 0,
            "full_replies": 0, "reply_kind": "",
            "state": "new", "hb": 0,
            "ball": "me", "ts": time.time(), "owner": owner,
            "ws": ws0, "task": None, "agent_ts": 0, "seen": 0,
        }
        _state["boxes"].insert(idx, made)
        result = {"ok": True, "id": bid_new}
        if op:
            _op_commit(op, fp, "create", bid_new, result)
        # the row is queued and written by the save once the card is
        # installed, so a rolled-back save leaves none
        _log("create", bid_new, title, log_fields={"op": op} if INCIDENT_OP.fullmatch(op) else None,
             **({"op": op} if op else {}))
        _save()
        _notify()
        # the card itself rides back, so a phone can draw it from this answer
        # instead of waiting for its next reading of the board
        return 200, {**result, "rev": _state["rev"], "card": _phone_box(made)}


def _post_project(q: Query, text: str):
    # a new project lane from the page's plus tab: slug the name,
    # store {id, name, dir} so restarts keep it, give the lane its
    # per-owner slots; the tab appears with an empty board
    name = q.one("name").strip()
    slug = "".join(c if c.isalnum() else "-" for c in name.lower())
    while "--" in slug:
        slug = slug.replace("--", "-")
    slug = slug.strip("-")
    if not name or not slug:
        return 400, {"error": "empty name"}
    if slug in RETIRED_OWNERS:
        return 400, {"error": "reserved owner"}
    with _lock:
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
            return 400, {"error": "body must be a folder under home"}
        _state.setdefault("projects", []).append({"id": slug, "name": name, "dir": str(d)})
        _state["busy"].setdefault(slug, None)
        _state["claimed"].setdefault(slug, [])
        _state["busy_ts"].setdefault(slug, 0.0)
        _state.setdefault("ack", {}).setdefault(slug, None)
        _state.setdefault("workspaces", {})[slug] = [{
            "id": "w1", "name": "main", "started": time.time(),
            "goal": "", "tasks": [], "current": None}]
        # the lane opens on its board page, the same one migration gives every
        # project that predates the switcher
        _state.setdefault("pages", {})[slug] = [_page_record("pg1", "board")]
        # no card is created with the lane: a fresh folder opens onto
        # an empty board and cards come only from the owner's hand
        # the folder's own name is written down, never the path to it:
        # a lane's directory is one line away from a home directory
        _log("project", slug, f"{name} -> {d}", log_fields={"folder": d.name})
        _save()
        # the lane joins the runtime owner set only once its save has landed:
        # everything the lane needs in the state was saved above, and a save
        # that failed has put the state back without it, so registering it
        # earlier would have left a lane the reads and waits index that the
        # state does not know, until a restart
        _register_owner(slug)
        _notify()
        return 200, {"ok": True, "id": slug, "name": name, "dir": str(d)}


def _post_close(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        action = _close_box(box)
        _save()
        _notify()
        return 200, {"ok": True, "action": action}


def _post_delete(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None or box["bucket"] != "meta":
            return 400, {"error": "only meta boxes can be deleted"}
        # Compatibility for already-open pages and other old clients:
        # the current persisted record decides, never their stale copy.
        action = _close_box(box)
        _save()
        _notify()
        return 200, {"ok": True, "action": action}


def _post_ws_goal(q: Query, text: str):
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        w = _ws(ow, q.one("ws"))
        if w is None:
            return 400, {"error": "unknown workspace"}
        w["goal"] = text
        _log("goal", w["id"], text)
        _save()
        return 200, {"ok": True}


def _post_ws_task(q: Query, text: str):
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        w = _ws(ow, q.one("ws"))
        if w is None:
            return 400, {"error": "unknown workspace"}
        tid = q.one("id")
        status = q.one("status")
        if not tid:  # create; body names it
            tid = f"t{_state['next_tid']}"
            _state["next_tid"] += 1
            w["tasks"].append({"id": tid, "text": text, "status": "pending"})
            _log("task+", tid, text)
        else:
            t = next((t for t in w["tasks"] if t["id"] == tid), None)
            if t is None:
                return 400, {"error": "unknown task"}
            if q.one("del") == "1":
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
        return 200, {"ok": True, "id": tid}


def _post_ws_current(q: Query, text: str):
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        w = _ws(ow, q.one("ws"))
        if w is None:
            return 400, {"error": "unknown workspace"}
        tid = q.one("id") or None
        w["current"] = tid
        _log("current", tid or "", "")
        _save()
        return 200, {"ok": True}


def _post_pages_new(q: Query, text: str):
    # one more environment for this project, blank: the switcher at the foot of
    # the workspace shows it as a new dot and opens it. No card, no chat and no
    # workspace is touched, here or anywhere this route leads
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        pages = _pages(ow)
        if len(pages) >= PAGE_LIMIT:
            return 400, {"error": "too many pages"}
        pid = f"pg{_state['next_pgid']}"
        _state["next_pgid"] += 1
        pages.append(_page_record(pid, "blank"))
        # the page has no words of its own, so the id and the lane are the whole
        # event and there is nothing in it to keep out of the file
        _log("page+", pid, "", log_fields={"owner": ow}, owner=ow)
        _save()
        _notify()
        return 200, {"ok": True, "id": pid, "pages": pages, "rev": _state["rev"]}


def _post_pages_del(q: Query, text: str):
    # any page may go, the board page included. What goes is the view record and
    # only that: the project's cards, their conversations, its internal
    # workspaces and their tasks are all somewhere else and stay exactly as they
    # were. A project left with no pages keeps an empty list, so nothing here
    # hands it a new page on the next reading
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        pages = _pages(ow)
        pid = q.one("id")
        page = next((p for p in pages if isinstance(p, dict) and p.get("id") == pid), None)
        if page is None:
            return 400, {"error": "unknown page"}
        pages.remove(page)
        _log("page-", pid, "", log_fields={"owner": ow}, owner=ow)
        _save()
        _notify()
        return 200, {"ok": True, "pages": pages, "rev": _state["rev"]}


def _post_assign(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "unknown box"}
        box["task"] = q.one("task") or None
        _log("assign", bid, box["task"] or "none")
        _save()
        return 200, {"ok": True}


def _post_progress(q: Query, text: str):  # interim note during a build: keeps
    bid = q.one("box")                     # the claim (card stays green) and
    with _lock:                            # heartbeats
        box = _box(bid)
        ow = box.get("owner", "pastureland") if box else None
        if box is None or _state["busy"].get(ow) != bid:
            return 400, {"error": "not holding this box"}
        outcome, fp = _card_receipt(q, "progress", ow, bid, text)
        if outcome is not None:
            return outcome
        _set_reply_variants(box, text)
        box["reply_kind"] = "progress"   # interim words, not a page of the history
        box["ts"] = time.time()
        _state["busy_ts"][ow] = time.time()   # resets the 15-min steal
        _log("progress", bid, text, reply_full=text, reply_short=text,
             reply_variants_version=REPLY_VARIANTS_VERSION)
        _card_commit(q, fp, "progress", ow, bid, {"ok": True, "box": bid})
        _save()
        _notify()
        return 200, {"ok": True}



# ---- the select-lane routes -----------------------------------------------------

def _post_mode(q: Query, text: str):
    # which way a lane is served. auto is today's behaviour, where the board
    # picks the oldest card and hands it over; select is the queue the agent
    # reads and chooses from. One flag, so a lane migrates on its own and a
    # rollback is the same flag the other way
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    mode = q.one("mode", "auto")
    if mode not in ("auto", "select"):
        return 400, {"error": "mode is auto or select"}
    with _lock:
        before = _lane_mode(lane)
        modes = _state.setdefault("lane_mode", {})
        if mode == "auto":
            modes.pop(lane, None)
        else:
            modes[lane] = "select"
        if before != mode:
            # whatever was half-done under the old mode is let go, and the card
            # goes back to the front of its queue untouched
            _release_lane_claim(lane, f"lane moved to {mode}")
            _info("lanemode", lane=lane, mode=mode, was=before)
            _save()
            _notify()
        return 200, {"ok": True, "lane": lane, "mode": mode}


def _get_queue(q: Query, _):
    # the listing the agent chooses from. Rows and counts, and no request text
    # on any path through here: seeing a row is not opening a card
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    session = q.one("session")
    include = {part for value in q.get("include", []) for part in value.split(",") if part}
    try:
        limit = int(q.one("limit", str(QUEUE_LIMIT)))
    except ValueError:
        return 400, {"error": "bad limit"}
    limit = max(1, min(limit, QUEUE_LIMIT_MAX))
    with _lock:
        if session:
            refusal = _holder_check(lane, session)
            if refusal:
                return 409, refusal
        # the same two lazy clocks the board reading sweeps, so a listing never
        # shows a card as held by a hand-off that has already come back
        _release_unacked()
        _sweep()
        now = time.time()
        rows = _lane_rows(lane, include, now)[:limit]
        held = None
        reserved = _state["busy"].get(lane)
        if reserved:
            res = _reservation(lane) or {}
            ack = (_state.get("ack") or {}).get(lane) or {}
            held = {"box": reserved, "reservation": res.get("id", ""),
                    "since_s": round(now - _state["busy_ts"].get(lane, now), 1),
                    "acknowledged": bool(ack.get("confirmed"))}
        green = [{"box": b["id"], "state": b.get("state", ""),
                  "job": next(iter(b.get("work", {})), ""), "task": b.get("task"),
                  "hb_age_s": round(now - b.get("hb", 0), 1)}
                 for b in _state["boxes"]
                 if b.get("owner", "pastureland") == lane and _hb_live(b)]
        return 200, *_snapshot({
            "lane": lane, "mode": _lane_mode(lane), "epoch": _state.get("epoch", 0),
            "generation": _generation(lane), "now": now,
            "paused": bool(_state.get("paused")), "end": bool(_state.get("end")),
            "holder": _holder_out(lane), "held": held, "cards": rows, "green": green,
        })


def _post_hold(q: Query, text: str):
    # a connection saying which lane it is serving. Coordination and not
    # protection: it catches two connections listening for one project by
    # accident, and it is not a credential and is not authenticated
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    session = q.one("session")
    if not session:
        return 400, {"error": "session required"}
    with _lock:
        rec, refusal = _holder_touch(lane, session, q.one("agent"), q.one("machine"),
                                     q.one("override") == "1")
        if refusal:
            return 409, refusal
        _save()
        return 200, {"ok": True, "lane": lane, "generation": rec["generation"],
                     "epoch": _state.get("epoch", 0), "mode": _lane_mode(lane)}


def _post_select(q: Query, text: str):
    # the choice itself. The card is reserved through the very same claim the
    # auto path mints, so the colour mask, the 90 second lease and the 15
    # minute steal-back all apply to it unchanged. No message text comes back
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    session, bid, op, row = q.one("session"), q.one("box"), q.one("op"), q.one("row")
    if not _op_id_ok(op):
        return 400, {"error": "operation id required"}
    if not row:
        return 400, {"error": "row tag required"}
    with _lock:
        refusal = _holder_check(lane, session)
        if refusal:
            return 409, refusal
        fp = _fingerprint("select", lane, bid, row)
        found, rec = _op_lookup(op, fp)
        if found == "mismatch":
            return 409, {"error": "operation id reused with a different payload"}
        if found == "same":
            bad = _replay_check(rec, lane, session, bid)
            if bad:
                return 409, bad
            live = _reservation(lane)
            if (rec.get("epoch") == _state.get("epoch", 0) and live
                    and live.get("id") == rec.get("object") and live.get("box") == bid):
                return 200, {**rec["result"], "replayed": True}
            # the place this receipt describes is gone. A fresh id for a fresh
            # selection is the answer, which is why a replay cannot loop here
            return 409, {"error": "reservation gone", "row": _row_of(bid)}
        _release_unacked()
        _sweep(persist=False)
        box = _box(bid)
        if box is None or box.get("owner", "pastureland") != lane:
            # a card in another lane and a card that does not exist answer the
            # same thing. This is routing validation, not protection
            return 404, {"error": "not in this lane"}
        if _state["busy"].get(lane) is not None:
            return 409, {"error": "already reserved", "box": _state["busy"][lane]}
        if not box["pending"]:
            return 410, {"error": "nothing waiting"}
        if row != _row_tag(box):
            return 409, {"error": "row moved", "row": _queue_row(box, 0, None, time.time())}
        now = time.time()
        # fairness is advisory and audited: a selection that steps over a card
        # which has waited longer than the steal window is written down, and
        # nothing is refused on account of it
        passed = [r["box"] for r in _lane_rows(lane, set(), now)
                  if r["starved"] and r["box"] != bid]
        if passed:
            _info("passedover", bid, lane=lane, over=len(passed))
            for other in passed:
                skipped = _box(other)
                if skipped is not None:
                    skipped["passed_over"] = skipped.get("passed_over", 0) + 1
        if bid in _state["inbox"]:
            _state["inbox"].remove(bid)
        _state["busy"][lane] = bid
        _state["claimed"][lane] = [m["mid"] for m in box["pending"]]
        # the hand-over is noted here, where the delivery is decided, exactly as
        # the claim path notes it: the claim is minted whole and the note is
        # written whole with it
        _hand_over(box, box["pending"])
        _state["busy_ts"][lane] = now
        # every reservation is provisional, like every claim: this token is what
        # the receipt has to name, and until it does the 90 second clock runs
        token = secrets.token_hex(6)
        _state["ack"][lane] = {"box": bid, "token": token, "ts": now, "confirmed": False}
        res_id = _new_id("r")
        _state.setdefault("reservations", {})[lane] = {
            "id": res_id, "box": bid, "hold": token, "epoch": _state.get("epoch", 0),
            "ts": now, "confirmed": False}
        result = {"box": bid, "title": box["title"], "waiting": len(box["pending"]),
                  "hold": token, "reservation": res_id, "epoch": _state.get("epoch", 0),
                  "generation": _generation(lane),
                  "queued_after": sum(1 for i in _state["inbox"]
                                      if (_box(i) or {}).get("owner", "pastureland") == lane)}
        _op_commit(op, fp, "select", bid, result, _op_extra(lane, session, res_id))
        _debug("select", bid, owner=lane, token=bool(token))
        _save()
        _notify()
        return 200, result


def _post_open(q: Query, text: str):
    # the messages, prepared as a delivery and recorded before they are sent.
    # This confirms nothing: the reservation stays provisional and the 90
    # second lease keeps running until the client says the body arrived
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    session, bid, op = q.one("session"), q.one("box"), q.one("op")
    fresh_only = q.one("fresh") == "1"
    if not _op_id_ok(op):
        return 400, {"error": "operation id required"}
    with _lock:
        refusal = _holder_check(lane, session)
        if refusal:
            return 409, refusal
        fp = _fingerprint("open", lane, bid, "1" if fresh_only else "0")
        found, rec = _op_lookup(op, fp)
        if found == "mismatch":
            return 409, {"error": "operation id reused with a different payload"}
        if found == "same":
            bad = _replay_check(rec, lane, session, bid)
            if bad:
                return 409, bad
            prepared = _state.get("deliveries", {}).get(rec.get("object") or "")
            live = _reservation(lane)
            body = _delivery_body(rec.get("object") or "")
            if (rec.get("epoch") == _state.get("epoch", 0) and prepared and body
                    and prepared.get("state") in ("prepared", "acked")
                    and live and prepared.get("reservation") == live.get("id")):
                return 200, *_snapshot({**body, "replayed": True})
            # no abandoned body is ever handed back
            return 409, {"error": "delivery gone", "row": _row_of(bid)}
        box = _box(bid)
        if box is None or box.get("owner", "pastureland") != lane:
            return 404, {"error": "not in this lane"}
        res = _reservation(lane)
        if res is None or res.get("box") != bid or _state["busy"].get(lane) != bid:
            return 409, {"error": "reservation gone", "row": _row_of(bid)}
        have = set(_state["claimed"][lane])
        if fresh_only:
            # mid-work messages: whatever landed after the reservation, folded
            # into the claim the way the legacy route folds them, so the one
            # reply covers them and nothing arrives twice
            messages = [m for m in box["pending"] if m["mid"] not in have]
            if messages:
                _state["claimed"][lane].extend(m["mid"] for m in messages)
                _hand_over_more(box, messages)
        else:
            # exactly what the reservation handed over, and never whatever has
            # landed since. Taking the whole pending list here would deliver a
            # later message in this batch and again in the next fresh one, which
            # is the same words twice under two deliveries and two receipts.
            # A message that arrived after the reservation was handed over by
            # nothing, and it waits for the fresh open that hands it over
            messages = [m for m in box["pending"] if m["mid"] in have]
        did = _new_id("d")
        now = time.time()
        _state.setdefault("deliveries", {})[did] = {
            "box": bid, "lane": lane, "session": session, "generation": _generation(lane),
            "epoch": _state.get("epoch", 0), "reservation": res.get("id"),
            "mids": [m["mid"] for m in messages], "prepared_ts": now,
            # what each message looked like when this body was prepared. The
            # receipt that follows sets first_acked_ts on the card, so reading
            # it live would make a replay of this very operation describe the
            # messages differently from the answer it is replaying
            "seen": {str(m["mid"]): m.get("first_acked_ts") or 0 for m in messages},
            "acked_ts": 0, "route": "", "state": "prepared",
        }
        _prune_deliveries(lane)
        box["delivery_attempts"] = box.get("delivery_attempts", 0) + 1
        # the receipt names the delivery and the body is rebuilt from it, so the
        # words are not written into a record that outlives the request by days
        _op_commit(op, fp, "open", bid, {"box": bid, "delivery": did}, _op_extra(lane, session, did))
        _debug("open", bid, owner=lane, messages=len(messages), fresh=fresh_only)
        _save()
        return 200, *_snapshot(_delivery_body(did))


def _open_message(bid: str, m: dict, first_acked: float = 0) -> dict:
    """One message of a delivery. role says who authored it on the board, which
    is what the page already knows and what the native-input proposal would
    need; it is not a claim about what role the text ends up carrying inside any
    conversation. Attachments are named by a card-scoped URL rather than the
    global one, because an agent on another machine cannot read the board's
    uploads folder.

    first_acked comes from the delivery record rather than from the card,
    because the receipt for this very body sets it: reading it live would make a
    replay describe the messages differently from the answer it replays."""
    return {
        "mid": m.get("mid"), "text": m.get("text", ""), "ts": m.get("ts", 0),
        "via": m.get("via"), "role": "human",
        "read_before": bool(first_acked),
        "first_acked_ts": first_acked or None,
        "attachments": [
            {"file": name,
             "url": f"/attachment?owner={quote((_box(bid) or {}).get('owner', 'pastureland'))}"
                    f"&box={quote(bid)}&file={quote(name)}"}
            for name in sorted(unquote(hit) for hit in UPLOAD_REF.findall(m.get("text", "") or ""))
        ],
    }



def _delivery_body(did: str) -> dict | None:
    """One prepared delivery, rebuilt from its record and the card it names.

    The body is assembled here rather than stored, so a replay of a lost open
    answers the same words without the operation receipt holding a second copy
    of them. That matters because a receipt outlives the request by days, the
    board already keeps what was said in the card and the transcript, and the
    module's own rule is that a receipt carries a digest and never the words.
    None when the delivery or its card is gone, which the caller reads as a
    conflict rather than as an empty delivery."""
    rec = _state.get("deliveries", {}).get(did)
    box = _box((rec or {}).get("box", "")) if rec else None
    if rec is None or box is None:
        return None
    by_mid = {m.get("mid"): m for m in box["pending"]}
    carried = list(rec.get("mids") or [])
    if any(mid not in by_mid for mid in carried):
        # one of the messages this delivery carried is no longer on the card, so
        # the body cannot be rebuilt whole. A short body is not the same answer
        # and must never quietly stand in for it: the caller is told the
        # delivery is gone and selects again
        return None
    seen = rec.get("seen") or {}
    return {
        "box": rec["box"], "delivery": did, "reservation": rec.get("reservation"),
        "epoch": rec.get("epoch"), "prepared_ts": rec.get("prepared_ts"),
        "messages": [_open_message(rec["box"], by_mid[mid], seen.get(str(mid), 0))
                     for mid in carried],
    }


def _post_opened(q: Query, text: str):
    # the one honest record of access: the client says a complete body arrived,
    # and names the route that carried it. tool means it came back as the result
    # of the agent's own command. user-input means a provider interface accepted
    # a submission into the conversation. Neither is evidence that the model
    # attended to it, and no field here says otherwise
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    session, did, op = q.one("session"), q.one("delivery"), q.one("op")
    route = q.one("route", "tool")
    if not _op_id_ok(op):
        return 400, {"error": "operation id required"}
    if route not in ("tool", "user-input"):
        return 400, {"error": "route is tool or user-input"}
    with _lock:
        refusal = _holder_check(lane, session)
        if refusal:
            return 409, refusal
        rec_d = _state.get("deliveries", {}).get(did)
        bid = (rec_d or {}).get("box", "")
        fp = _fingerprint("opened", lane, did, route)
        found, rec = _op_lookup(op, fp)
        if found == "mismatch":
            return 409, {"error": "operation id reused with a different payload"}
        if found == "same":
            bad = _replay_check(rec, lane, session, bid)
            if bad:
                return 409, bad
            return 200, {**rec["result"], "replayed": True}
        if rec_d is None or rec_d.get("lane") != lane:
            return 404, {"error": "not in this lane"}
        if rec_d.get("state") == "acked":
            # a repeat for a body already acknowledged answers the recorded
            # fact and creates no claim. The epoch is reported when it has
            # moved, because a card acknowledged before a restart is a
            # different situation from one acknowledged just now
            return 200, {"ok": True, "delivery": did, "acked_ts": rec_d.get("acked_ts", 0),
                         "route": rec_d.get("route", ""), "already": True,
                         "stale_epoch": rec_d.get("epoch") != _state.get("epoch", 0)}
        if rec_d.get("state") != "prepared":
            # prepared and then thrown away. The attempt is recorded and no
            # access fact is written, because none happened
            rec_d["late_receipts"] = rec_d.get("late_receipts", 0) + 1
            _save()
            return 409, {"error": "delivery is stale", "row": _row_of(bid)}
        live = _reservation(lane)
        if (live is None or live.get("id") != rec_d.get("reservation")
                or _state["busy"].get(lane) != bid):
            rec_d["state"] = "abandoned"
            rec_d["why"] = "reservation moved on"
            _save()
            return 409, {"error": "delivery is stale", "row": _row_of(bid)}
        now = time.time()
        rec_d["state"] = "acked"
        rec_d["acked_ts"] = now
        rec_d["route"] = route
        if q.one("evidence"):
            # whatever the provider said about accepting the submission, kept
            # short and kept as the client's word rather than as the board's
            rec_d["evidence"] = q.one("evidence")[:200]
        # the claim becomes real, exactly as the legacy receipt makes it real
        ack = (_state.get("ack") or {}).get(lane)
        if ack and ack.get("box") == bid:
            ack["confirmed"] = True
        live["confirmed"] = True
        box = _box(bid)
        carried = set(rec_d.get("mids") or [])
        for m in (box or {}).get("pending", []):
            if m.get("mid") in carried:
                m.setdefault("first_acked_ts", now)
                m["last_acked_ts"] = now
        result = {"ok": True, "delivery": did, "acked_ts": now, "route": route}
        _op_commit(op, fp, "opened", bid, result, _op_extra(lane, session, did))
        _info("opened", bid, lane=lane, route=route, messages=len(carried))
        _save()
        return 200, result


def _post_release(q: Query, text: str):
    # giving the card back. It returns to the FRONT of its lane's queue, which
    # is the move the unconfirmed lease already makes, and anything prepared
    # under it is abandoned
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    session, bid, op = q.one("session"), q.one("box"), q.one("op")
    if not _op_id_ok(op):
        return 400, {"error": "operation id required"}
    with _lock:
        refusal = _holder_check(lane, session)
        if refusal:
            return 409, refusal
        fp = _fingerprint("release", lane, bid, q.one("reason"))
        found, rec = _op_lookup(op, fp)
        if found == "mismatch":
            return 409, {"error": "operation id reused with a different payload"}
        if found == "same":
            bad = _replay_check(rec, lane, session, bid)
            if bad:
                return 409, bad
            # an effect receipt replays its own success although the
            # reservation it removed is gone. That is the point of the receipt,
            # not an exception to it
            return 200, {**rec["result"], "replayed": True}
        box = _box(bid)
        if box is None or box.get("owner", "pastureland") != lane:
            return 404, {"error": "not in this lane"}
        if _state["busy"].get(lane) != bid:
            return 409, {"error": "reservation gone", "row": _row_of(bid)}
        box["passed_over"] = box.get("passed_over", 0) + 1
        _release_lane_claim(lane, "released by the agent")
        result = {"ok": True, "box": bid}
        _op_commit(op, fp, "release", bid, result, _op_extra(lane, session, ""))
        _info("release", bid, lane=lane, reason=q.one("reason")[:64])
        _save()
        _notify()
        return 200, result



# ---- telling a lane that work is waiting ----------------------------------------
# One line with counts and no card text, handed to an adapter by the connection.
# The notice is created pending before any hand-off, the adapter runs, and only
# then is the outcome written down with the adapter's name and what that adapter
# could actually observe. No exactly-once claim is made about any provider path:
# a repeated notice may produce a repeated line, the id lets the agent see that
# it is a repeat, and the queue stays the source of truth, so a duplicate costs
# one redundant look.

def _notify_queued(lane: str) -> tuple:
    """What is waiting for this lane, not counting the card it already holds.
    Messages landing on a held card raise no notice: they are reachable by
    opening with fresh=1, and a notice for them would say work is waiting when
    the agent is already holding it."""
    held = _state["busy"].get(lane)
    cards = queued = 0
    oldest = 0.0
    for b in _state["boxes"]:
        if b.get("owner", "pastureland") != lane or b["id"] == held:
            continue
        if b["done"] or b.get("parked", False) or not b["pending"]:
            continue
        cards += 1
        queued += len(b["pending"])
        for m in b["pending"]:
            if not oldest or m.get("ts", 0) < oldest:
                oldest = m.get("ts", 0)
    return cards, queued, oldest


def _notice_for(lane: str, cards: int, queued: int, cursor: str) -> tuple:
    """The notice to answer with, or (None, False) when this lane has already
    been told and it is not yet time to tell it again. Callers hold _lock."""
    notices = _state.setdefault("notices", {}).setdefault(lane, [])
    last = notices[-1] if notices else None
    now = time.time()
    seen = int(cursor[2:]) if cursor.startswith("c-") and cursor[2:].isdigit() else 0
    if last and last.get("state") == "pending" and last.get("seq", 0) > seen:
        # minted while this connection was away and never closed. It gets the
        # same notice back rather than a second one for the same work. A notice
        # whose outcome is already recorded is not handed out again: that
        # outcome was observed once and a second one would write over it
        return last, False
    if last and last.get("queued") == queued and now - last.get("ts", 0) < NOTIFY_REPEAT:
        return None, False
    seq = _state.get("notice_seq", 0) + 1
    _state["notice_seq"] = seq
    notice = {"id": _new_id("n"), "seq": seq, "ts": now, "queued": queued, "cards": cards,
              "state": "pending", "adapter": "", "outcome": "", "outcome_ts": 0}
    notices.append(notice)
    del notices[:-NOTICE_KEEP]
    return notice, bool(last and last.get("queued") == queued)


def _notify_poll(lane: str, session: str, cursor: str):
    """One pass for a waiting connection: the clocks, then the counts. Answers
    (kind, payload) or None when there is nothing to say yet. It claims nothing
    and returns no text."""
    with _lock:
        if _state.get("paused"):
            return "paused", {"paused": True}
        _release_unacked()
        _sweep()
        if session:
            rec = _holder(lane)
            if rec is None or rec.get("session") != session:
                return "held", {"error": "lane already held",
                                "agent": (rec or {}).get("agent", ""),
                                "machine": (rec or {}).get("machine", ""),
                                "idle_s": round(max(0.0, time.time() - (rec or {}).get("last_seen", 0)), 1)}
            rec["last_seen"] = time.time()
        cards, queued, oldest = _notify_queued(lane)
        if cards:
            notice, repeat = _notice_for(lane, cards, queued, cursor)
            if notice is not None:
                _save()
                return "work", {"queued": queued, "cards": cards,
                                "oldest_wait_s": round(time.time() - oldest, 1) if oldest else 0,
                                "notice": notice["id"], "repeat": repeat,
                                "cursor": f"c-{notice['seq']}"}
        if _state["end"] and not cards and _state["busy"].get(lane) is None:
            return "end", {"end": True}
        return None


def _post_notified(q: Query, text: str):
    # what the adapter could observe, recorded after it returned. Never before,
    # and never as a claim that the conversation displayed anything
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    session, nid, op = q.one("session"), q.one("notice"), q.one("op")
    adapter, outcome = q.one("adapter")[:40], q.one("outcome")
    if not _op_id_ok(op):
        return 400, {"error": "operation id required"}
    if outcome not in ("accepted", "refused", "error"):
        return 400, {"error": "outcome is accepted, refused or error"}
    with _lock:
        refusal = _holder_check(lane, session)
        if refusal:
            return 409, refusal
        fp = _fingerprint("notified", lane, nid, adapter, outcome)
        found, rec = _op_lookup(op, fp)
        if found == "mismatch":
            return 409, {"error": "operation id reused with a different payload"}
        if found == "same":
            bad = _replay_check(rec, lane, session, "")
            if bad:
                return 409, bad
            return 200, {**rec["result"], "replayed": True}
        notice = next((n for n in _state.get("notices", {}).get(lane, []) if n.get("id") == nid), None)
        if notice is None:
            return 404, {"error": "unknown notice"}
        notice["state"] = "closed"
        notice["adapter"] = adapter
        notice["outcome"] = outcome
        notice["outcome_ts"] = time.time()
        if q.one("detail"):
            notice["detail"] = q.one("detail")[:120]
        result = {"ok": True, "notice": nid, "outcome": outcome}
        _op_commit(op, fp, "notified", "", result, _op_extra(lane, session, nid))
        _info("notified", lane=lane, adapter=adapter, outcome=outcome)
        _save()
        return 200, result


# ---- work registered against a card ---------------------------------------------
# The board already has the heartbeat and already expires green after 75
# seconds. This is a thin record over it rather than a new mechanism: which jobs
# are behind a card's green, so the connection can say which one it is watching
# and so ending one job cannot take another one's green away. The connection
# owns the heartbeat from the job's own lifetime; no path here asks the model to
# send one. An indicator means a registered job is alive. It is not evidence
# that the job is making useful progress, and nothing here says it is.

def _work_call(q: Query, ending: bool):
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    session, bid, op, job = q.one("session"), q.one("box"), q.one("op"), q.one("job")
    if not _op_id_ok(op):
        return 400, {"error": "operation id required"}
    if not job:
        return 400, {"error": "job required"}
    with _lock:
        refusal = _holder_check(lane, session)
        if refusal:
            return 409, refusal
        fp = _fingerprint("work-end" if ending else "work-start", lane, bid, job, q.one("task"))
        found, rec = _op_lookup(op, fp)
        if found == "mismatch":
            return 409, {"error": "operation id reused with a different payload"}
        if found == "same":
            bad = _replay_check(rec, lane, session, bid)
            if bad:
                return 409, bad
            return 200, {**rec["result"], "replayed": True}
        box = _box(bid)
        if box is None or box.get("owner", "pastureland") != lane:
            return 404, {"error": "not in this lane"}
        work = box.setdefault("work", {})
        if ending:
            work.pop(job, None)
            if not work:
                # the last job behind this card is over, so the flag goes down
                # and a turn deferred under it is handed over at once. The sweep
                # rides on this route's own save
                box["hb"] = 0
                _sweep(persist=False)
            _info("workend", bid, lane=lane, job=job, left=len(work))
        else:
            # a repeat start for the same job changes nothing about the record
            work.setdefault(job, {"task": q.one("task") or box.get("task"),
                                  "session": session, "started": time.time()})
            box["hb"] = time.time()
            _green(box)
            _info("workstart", bid, lane=lane, job=job, jobs=len(work))
        result = {"ok": True, "box": bid, "job": job, "jobs": sorted(work)}
        _op_commit(op, fp, "work-end" if ending else "work-start", bid, result,
                   _op_extra(lane, session, job))
        _save()
        _notify()
        return 200, result


def _post_work_start(q: Query, text: str):
    return _work_call(q, ending=False)


def _post_work_end(q: Query, text: str):
    return _work_call(q, ending=True)


def _get_attachment(q: Query, _):
    # an attachment named by the card it belongs to, under the current upload
    # type and size rules. An agent on another machine cannot read the board's
    # uploads folder, and the global uploads route has no card association at
    # all, so this is how a delivery's images and documents are actually fetched
    lane = q.one("owner", "pastureland")
    if lane not in OWNERS:
        return 400, {"error": "unknown owner"}
    bid, fname = q.one("box"), q.one("file")
    if not fname or "/" in fname or "\\" in fname or fname in (".", ".."):
        return 404, {"error": "not found"}
    with _lock:
        # a file that maps to no card, or to a card in another lane, is a 404,
        # the same answer a card that does not exist gets
        if not _upload_card(lane, bid, fname):
            return 404, {"error": "not found"}
    for base in (INTERNAL_UPLOADS, HERE / "uploads"):
        p = base / fname
        if p.is_file() and p.resolve().parent == base.resolve() and p.suffix.lower() in UPLOAD_TYPES:
            disposition = "attachment" if q.one("download") == "1" or p.suffix.lower() in (".doc", ".docx") else "inline"
            return FileResponse(p, media_type=UPLOAD_TYPES[p.suffix.lower()],
                                filename=re.sub(r"^\d{13,19}-", "", fname),
                                content_disposition_type=disposition,
                                headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                         "Content-Security-Policy": "sandbox"})
    return 404, {"error": "not found"}


def _post_dismiss(q: Query, text: str):  # drop a box's queued messages, unanswered
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "unknown box"}
        n = len(box["pending"])
        box["pending"] = []
        if bid in _state["inbox"]:
            _state["inbox"].remove(bid)
        ow = box.get("owner", "pastureland")
        if _state["busy"].get(ow) == bid:
            _state["busy"][ow] = None
            _state["claimed"][ow] = []
            _drop_reservation(ow, "card dismissed")
        # a beating flag keeps its green through a dismissal; anything
        # else lands where the card rests, an unanswered reply beneath
        # the dropped queue showing again
        if not _hb_live(box):
            _handover(box)
            box["state"] = _rest(box)
        _log("dismiss", bid, f"{n} queued dropped")
        _save()
        _notify()
        return 200, {"ok": True, "dropped": n}


def _post_push_subscribe(q: Query, text: str):
    # the phone's push subscription, kept whole so a push can be
    # addressed to it; one record per endpoint, the newest wins
    try:
        sub = json.loads(text) if text else None
    except ValueError:
        sub = None
    endpoint = sub.get("endpoint") if isinstance(sub, dict) else None
    if (not isinstance(endpoint, str) or len(endpoint) > 2048
            or not endpoint.startswith(("https://", "http://"))):
        return 400, {"error": "bad subscription"}
    keys = sub.get("keys") if isinstance(sub.get("keys"), dict) else {}
    rec = {"endpoint": endpoint,
           "keys": {k: str(v) for k, v in keys.items() if k in ("p256dh", "auth")},
           "ts": time.time()}
    with _lock:
        subs = [s for s in _state.get("push_subs", []) if s.get("endpoint") != endpoint]
        subs.append(rec)
        _state["push_subs"] = subs
        _save()
        return 200, {"ok": True, "count": len(subs)}


def _post_tabs(q: Query, text: str):
    # the tab bar's whole record in one write, so a reorder can
    # never half land: the lane order and the lanes he has closed
    # arrive together and replace what was stored
    try:
        rec = json.loads(text) if text else None
    except ValueError:
        rec = None
    if (not isinstance(rec, dict) or not isinstance(rec.get("order"), list)
            or not isinstance(rec.get("closed"), list)):
        return 400, {"error": "bad tab record"}
    with _lock:
        # every id is checked before anything is stored, so a record
        # naming a lane this board does not have changes nothing
        clean = {}
        for field in ("order", "closed"):
            ids = []
            for ow in rec[field]:
                if not isinstance(ow, str) or ow not in OWNERS:
                    return 400, {"error": "unknown owner"}
                if ow not in ids:   # a repeat is the same tab twice; keep the first
                    ids.append(ow)
            clean[field] = ids
        stored = _state.get("tabs") or {}
        for field in ("order", "closed"):
            _overwrite("tabs", "", field, stored.get(field), clean[field])
        _state["tabs"] = clean
        _save()
        _notify()
        return 200, {"ok": True, "tabs": clean}


def _post_seen(q: Query, text: str):
    # the read marks: for each card named, how many of its replies
    # he has read. One record per card on the board itself, so the
    # phone and the board can never disagree about what is unread
    try:
        rec = json.loads(text) if text else None
    except ValueError:
        rec = None
    if not isinstance(rec, dict) or not rec:
        return 400, {"error": "bad seen record"}
    with _lock:
        marks = []
        for bid_, n in rec.items():
            box = _box(bid_)
            if box is None:
                return 400, {"error": "bad box"}
            # a bool is an int in this language and is not a count
            if isinstance(n, bool) or not isinstance(n, int) or n < 0:
                return 400, {"error": "bad count"}
            marks.append((box, n))
        out = {}
        for box, n in marks:
            _overwrite("seen", box["id"], "count", box.get("seen", 0), n)
            box["seen"] = n
            out[box["id"]] = n
        _save()
        _notify()
        return 200, {"ok": True, "seen": out}


def _post_pause(q: Query, text: str):
    with _lock:
        _state["paused"] = q.one("v", "1") == "1"
        _log("pause" if _state["paused"] else "unpause", "", "")
        _save()
        _notify()  # in-flight waiters return {"paused":true} at once
        return 200, {"ok": True, "paused": _state["paused"]}


def _post_end(q: Query, text: str):
    with _lock:
        _state["end"] = True
        _log("end", "", "")
        _save()
        _notify()
        return 200, {"ok": True}


# ---- the transport --------------------------------------------------------------
# One process, one worker, one owner of the board's state: uvicorn accepts the
# connections and speaks HTTP, a small Starlette application routes them, and
# every answer is made in a worker thread and sent from the event loop after
# the lock is let go. The pieces below are the whole of the transport: how a
# request is read and bounded, how an answer is written down and sent, how
# long a peer may sit on the line, and what the board does when too many ask
# at once. Nothing here decides what the board says; that is the routes above.

class _TooLarge(Exception):
    """A body past the route's cap, caught before the bytes are kept."""


def _query(scope: dict) -> Query:
    raw = scope.get("query_string", b"").decode("latin-1")
    q = Query(parse_qs(raw))
    q.raw = raw
    q.path = scope.get("path", "")
    return q


def _answer(status: int, payload, ctype: str | None = None, *,
            route: str = "", box: str = "", close: bool = False,
            retry_after: int | None = None) -> Response:
    """The one door every answer leaves through. A dict is JSON; bytes carry
    the type they were handed with. A refusal is written down here, once, so
    one added a year from now is written down without anybody remembering to
    write it down: it is the server working correctly and saying no, so it is
    INFO and not an error, and the reason is the sentence the caller already
    wrote for the page."""
    if isinstance(payload, (dict, list)):
        body = json.dumps(payload).encode()
        ctype = "application/json"
    else:
        body = payload
    if status >= 400:
        _info("refusal", box, route=route, code=status,
              reason=payload.get("error") if isinstance(payload, dict) else None)
    headers = {"Cache-Control": "no-store"}
    if close:
        headers["Connection"] = "close"
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return Response(body, status_code=status, media_type=ctype, headers=headers)


async def _read_body(request: Request, cap: int) -> bytes:
    """The body, whole, or nothing: a body past the cap is refused before its
    bytes are kept, and one that stops arriving is given BODY_READ_TIMEOUT and
    no longer, so a peer that opens a request and goes quiet holds nothing."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > cap:
        raise _TooLarge()
    chunks: list[bytes] = []
    size = 0
    async with asyncio.timeout(BODY_READ_TIMEOUT):
        async for chunk in request.stream():
            size += len(chunk)
            if size > cap:
                raise _TooLarge()
            chunks.append(chunk)
    return b"".join(chunks)


def _run_state_request(fn, *args):
    """Run one state-touching request as one held-lock transaction.

    The route functions keep their own lock blocks, which are reentrant. This
    outer hold exists for the failure edge: if an unexpected exception escapes
    after a route changed memory or queued a transcript row but before its save,
    restore the latest installed snapshot before another worker can enter and
    commit the abandoned work. If a rename already succeeded, `_last_durable`
    already names that new snapshot, so cleanup never rolls an installed commit
    back. No response or unrelated file route passes through this hold."""
    with _lock:
        try:
            return fn(*args)
        except Exception:
            _restore_last_durable()
            raise


def _endpoint(fn, body: str = "none", cap: int = MAX_TEXT_BODY,
              too_large: str = "body too large", stateful: bool = False):
    """One route: read the request on the loop, do its work in a thread,
    answer from the loop. body is none for a GET, text for the plain text
    bodies most POSTs carry (utf-8, replacement characters for anything else,
    stripped, as always) and raw for the routes whose bytes are the content."""
    async def endpoint(request: Request) -> Response:
        q = _query(request.scope)
        route, box = q.path, q.one("box")
        payload = None
        if body != "none":
            try:
                raw = await _read_body(request, cap)
            except _TooLarge:
                return _answer(413, {"error": too_large}, route=route, box=box, close=True)
            except TimeoutError:
                return _answer(408, {"error": "the request body did not arrive in time"},
                               route=route, box=box, close=True)
            except ClientDisconnect:
                # the peer left mid-body: routine, never a crash, and there is
                # nobody to answer; the empty answer below goes nowhere
                _debug("hungup", box, route=route)
                return Response(status_code=400)
            payload = raw if body == "raw" else raw.decode("utf-8", "replace").strip()
        try:
            if stateful:
                outcome = await run_in_threadpool(_run_state_request, fn, q, payload)
            else:
                outcome = await run_in_threadpool(fn, q, payload)
        except SaveFailed:
            # The failed save already restored the board to its installed
            # snapshot. This answer is the difference between a page that can
            # say something went wrong and one that hangs on a socket.
            return _answer(500, {"error": "the board could not save its state"}, route=route, box=box)
        if isinstance(outcome, Response):
            return outcome
        return _answer(*outcome, route=route, box=box)
    return endpoint


def _state_endpoint(fn, body: str = "none", cap: int = MAX_TEXT_BODY,
                    too_large: str = "body too large"):
    """An endpoint whose route may change the board or its lazy clocks."""
    return _endpoint(fn, body, cap, too_large, stateful=True)


# -- the agent's long poll ----------------------------------------------------------
# The one route that waits. It waits on the loop, woken by every change to the
# board (_notify) and by the peer hanging up, and it sends its own answer so a
# hand-off can be undone when the listener is known to be gone. Two cases are
# covered for certain. A disconnect the loop has already seen sets the gone
# event, and the claim is rolled back before any bytes are sent (the claim
# suite proves this). A hand-off whose write itself fails is rolled back too,
# on the rare transport that reports the failure. What this cannot see is a
# disconnect that lands only after the bytes are handed over: with the pinned
# uvicorn a completed send never reports back, so that case is not caught here
# and instead rides the 90 second ack lease, which is exactly what the lease is
# for. Bytes handed to the network are not bytes read by the agent, and the ack
# is what finally confirms a delivery; the lease is the honest guarantee, and
# the mid-handoff rollback is a best effort on top of it, never a replacement.

async def _watch_disconnect(receive, gone: asyncio.Event) -> None:
    """Reads the request channel until the peer goes away. Started before the
    claim is attempted and stopped before the answer is sent, since once a
    response is complete the channel reports a disconnect that is not one."""
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


async def _changed(seen: int, timeout: float, gone: asyncio.Event) -> None:
    """Sleeps until the board changes, the peer leaves, or the time runs out,
    whichever is first. A change that landed between the caller's reading of
    the version and this call counts, so no wakeup can be lost."""
    if _change_version != seen or gone.is_set():
        return
    ev = asyncio.Event()
    _wakers.add(ev)
    try:
        if _change_version != seen:
            return
        waits = [asyncio.ensure_future(ev.wait()), asyncio.ensure_future(gone.wait())]
        try:
            await asyncio.wait(waits, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for w in waits:
                w.cancel()
    finally:
        _wakers.discard(ev)


async def _send_response(response: Response, scope, receive, send) -> bool:
    """True when every byte was handed to the network without the peer having
    gone; False when the send could not complete."""
    try:
        await response(scope, receive, send)
    except Exception:
        return False
    return True


class WaitRoute:
    async def __call__(self, scope, receive, send) -> None:
        global _waits_open
        q = _query(scope)
        route = q.path
        try:
            timeout = float(q.one("timeout", "570"))
        except ValueError:
            await _answer(400, {"error": "bad timeout"}, route=route)(scope, receive, send)
            return
        owner = q.one("owner", "pastureland")  # default: the pre-routing loop's role
        if owner not in OWNERS:
            await _answer(400, {"error": "unknown owner"}, route=route)(scope, receive, send)
            return
        # every claim is confirmed delivery, so there is no flag to read; an
        # ack=1 riding along in the query is accepted and ignored, never
        # refused, so a loop that carries the flag keeps working
        agent = q.one("agent") or None
        if _waits_open >= WAIT_SLOTS:
            # the listeners' seats are all taken: a loop that has lost its way
            # and opened many is told to come back, and the seats the real
            # lanes need are never eaten by it. Commands do not sit here at all
            _overload("waits", route)
            await _plain(503, {"error": "too many listeners waiting"}, retry_after=5)(scope, receive, send)
            return
        _waits_open += 1
        gone = asyncio.Event()
        watcher = asyncio.ensure_future(_watch_disconnect(receive, gone))
        try:
            try:
                await run_in_threadpool(_run_state_request, _wait_enter, owner, agent)
            except SaveFailed:
                # the first-ever listen for this owner could not record itself.
                # _wait_enter raised before it counted the listener, so nothing
                # leaks; this answers the same 500 the other routes give rather
                # than letting SaveFailed become a crash line, and _wait_leave
                # is not reached because entering never succeeded
                await _answer(500, {"error": "the board could not save its state"},
                              route=route)(scope, receive, send)
                return
            try:
                deadline = time.monotonic() + min(timeout, 590)
                while True:
                    if gone.is_set():
                        return   # nobody is listening any more: claim nothing, say nothing
                    seen = _change_version
                    try:
                        outcome = await run_in_threadpool(_run_state_request, _wait_poll, owner)
                    except SaveFailed:
                        # a claim, a bounce or a steal-back could not be saved
                        # and has been put back; the listener is told the same
                        # 500 every command gets and asks again
                        await _send_response(_answer(500, {"error": "the board could not save its state"},
                                                     route=route), scope, receive, send)
                        return
                    if outcome is not None:
                        kind, payload = outcome
                        if kind != "claim":
                            await _send_response(_answer(200, payload, route=route), scope, receive, send)
                            return
                        bid, token = payload["box"], payload["ack"]
                        if gone.is_set():
                            # the listener left while the claim was being made
                            await run_in_threadpool(_run_state_request,
                                                    _rollback_claim, owner, bid, token)
                            return
                        watcher.cancel()
                        delivered = await _send_response(
                            _answer(200, payload, route=route, box=bid), scope, receive, send)
                        if not delivered:
                            # the write itself failed, on a transport that says
                            # so: roll the claim back so the message is not
                            # stranded. The rollback checks the token, so an ack
                            # that beat it here, or a claim made since, is left
                            # alone. A disconnect that lands after the bytes are
                            # handed over is not seen here and rides the ack lease
                            await run_in_threadpool(_run_state_request,
                                                    _rollback_claim, owner, bid, token)
                        return
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or _STOPPING.is_set():
                        await _send_response(_answer(200, {"idle": True}, route=route), scope, receive, send)
                        return
                    await _changed(seen, min(remaining, 5), gone)
            finally:
                await run_in_threadpool(_wait_leave, owner)
        finally:
            watcher.cancel()
            _waits_open -= 1


def _notify_hold(lane: str, session: str, agent: str, machine: str, override: bool):
    """Take or renew this lane's holder record for a connection about to wait.
    None when the caller holds the lane afterwards, the refusal otherwise."""
    with _lock:
        _rec, refusal = _holder_touch(lane, session, agent, machine, override)
        if refusal:
            return refusal
        _save()
        return None


class NotifyRoute:
    """The connection's long poll. It waits the way the claim poll waits, on the
    loop, woken by every change to the board and by the peer hanging up, and it
    answers counts rather than a card. Nothing is claimed here and no card text
    is returned, so there is no hand-off to undo and none of the rollback the
    claim poll needs. It registers listener presence exactly as the claim poll
    does, which is what keeps the board rows and the status command telling the
    truth about which lanes have somebody listening."""

    async def __call__(self, scope, receive, send) -> None:
        global _waits_open
        q = _query(scope)
        route = q.path
        try:
            timeout = float(q.one("timeout", "570"))
        except ValueError:
            await _answer(400, {"error": "bad timeout"}, route=route)(scope, receive, send)
            return
        lane = q.one("owner", "pastureland")
        if lane not in OWNERS:
            await _answer(400, {"error": "unknown owner"}, route=route)(scope, receive, send)
            return
        session, cursor = q.one("session"), q.one("cursor")
        agent = q.one("agent") or None
        if _waits_open >= WAIT_SLOTS:
            _overload("waits", route)
            await _plain(503, {"error": "too many listeners waiting"}, retry_after=5)(scope, receive, send)
            return
        _waits_open += 1
        gone = asyncio.Event()
        watcher = asyncio.ensure_future(_watch_disconnect(receive, gone))
        try:
            if session:
                try:
                    held = await run_in_threadpool(_run_state_request, _notify_hold, lane, session,
                                                   agent or "", q.one("machine"),
                                                   q.one("override") == "1")
                except SaveFailed:
                    await _answer(500, {"error": "the board could not save its state"},
                                  route=route)(scope, receive, send)
                    return
                if held is not None:
                    # a second connection for one lane is told who holds it and
                    # how long since that one was heard from, and exits
                    await _answer(409, held, route=route)(scope, receive, send)
                    return
            try:
                await run_in_threadpool(_run_state_request, _wait_enter, lane, agent)
            except SaveFailed:
                await _answer(500, {"error": "the board could not save its state"},
                              route=route)(scope, receive, send)
                return
            try:
                deadline = time.monotonic() + min(timeout, 590)
                while True:
                    if gone.is_set():
                        return   # nobody is listening any more
                    seen = _change_version
                    try:
                        outcome = await run_in_threadpool(_run_state_request, _notify_poll,
                                                          lane, session, cursor)
                    except SaveFailed:
                        await _send_response(_answer(500, {"error": "the board could not save its state"},
                                                     route=route), scope, receive, send)
                        return
                    if outcome is not None:
                        kind, payload = outcome
                        await _send_response(
                            _answer(409 if kind == "held" else 200, payload, route=route),
                            scope, receive, send)
                        return
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or _STOPPING.is_set():
                        await _send_response(_answer(200, {"idle": True}, route=route), scope, receive, send)
                        return
                    await _changed(seen, min(remaining, 5), gone)
            finally:
                await run_in_threadpool(_wait_leave, lane)
        finally:
            watcher.cancel()
            _waits_open -= 1


# -- what the board does when too many ask at once ---------------------------------
# The fences, from the outside in, and what each one truly bounds.
#
# CONNECTION_LIMIT is uvicorn's own: past it every request, commands included,
# gets uvicorn's plain 503, which is what stops a runaway from taking the
# process down. It is a hard ceiling on open connections, not a reservation for
# any one kind of request.
#
# READ_SLOTS bounds how many board readings are being built at once, not how
# many peers are slowly reading. A reading holds its slot from admission until
# its answer has been handed to the transport, which is the serialization under
# the lock plus the handover; once the bytes are in the transport buffer the
# slot is released, so a peer that then stops reading holds no slot. That makes
# READ_SLOTS a bound on concurrent serialization work, the expensive part, and
# not a bound on stalled peers. Long polls have WAIT_SLOTS of their own above.
# Commands, the ack, the unread count and the operation lookups are counted
# against neither, so a phone that cannot read the board can still send and an
# agent can still answer.
#
# The bound on a stalled peer is therefore two other things: WRITE_STALL_TIMEOUT
# in the protocol below, which cuts a connection whose write has been stuck that
# long and frees its buffered answer, and CONNECTION_LIMIT, which caps how many
# such connections can exist at all. What none of this promises is a reading
# during a genuine flood: past the slots or the ceiling even polling is refused,
# which the phone shows as reconnecting rather than as a board that is fine, and
# a refused command is retried under its operation id.

_reads_open = 0
_waits_open = 0
_last_overload: dict = {}
# read routes, the ones that share READ_SLOTS: every GET except the small
# answers that a command loop or a waking phone depends on
UNCOUNTED_GETS = frozenset({"/unread", "/op", "/fresh", "/wait", "/push/key", "/worktrees",
                            "/dirs", "/pickdir", "/notify", "/queue"})


def _overload(which: str, route: str) -> None:
    """One line per kind per few seconds: a flood is worth knowing about and
    not worth a line per refused request."""
    now = time.monotonic()
    if now - _last_overload.get(which, 0) >= 5:
        _last_overload[which] = now
        _info("overload", slots=which, route=route)


DIAGNOSTIC_ROUTES = frozenset(("/send", "/create", "/m/state"))
SLOW_REQUEST_MS = 1000
_slow_requests: dict = {}   # three route keys, never a key from request text


def _slow_request(route: str, q: Query, status: int, ms: int) -> None:
    """Only unusually slow requests reach INFO. Operation ids already used by
    phone sends/creates join these lines to their client history and receipt.
    No arbitrary operation strings or query values are copied to the log."""
    if route not in DIAGNOSTIC_ROUTES or ms < SLOW_REQUEST_MS:
        return
    now = time.monotonic()
    window = _slow_requests.get(route)
    dropped = 0
    if window is None or now - window[0] >= CLIENT_WINDOW:
        dropped = window[2] if window else 0
        window = _slow_requests[route] = [now, 0, 0]
    if window[1] >= CLIENT_PER_MINUTE:
        window[2] += 1
        return
    window[1] += 1
    op = q.one("op")
    box = q.one("box")
    _info("slowrequest", box if _incident_box(box) else "", route=route, status=status, ms=ms,
          op=op if INCIDENT_OP.fullmatch(op) else None, dropped=dropped or None)


class Transport:
    """The outermost layer: the request line for the debug log, the read
    slots, the no-store every answer has always carried and the close that
    ends each connection with its answer. A crash inside is answered and
    written down by the application; this only makes sure the request is
    counted out again whatever happened."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        global _reads_open
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.monotonic()
        route = scope.get("path", "")
        q = _query(scope)
        status = 0
        counted = scope.get("method") in ("GET", "HEAD") and route not in UNCOUNTED_GETS

        async def bounded_send(message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = list(message.get("headers") or [])
                if route in DIAGNOSTIC_ROUTES:
                    # Time to response headers includes the server's queue and
                    # handler, not network transit or streaming the body.
                    ms = min(600000, max(0, round((time.monotonic() - started) * 1000)))
                    headers.append((b"x-facilitator-duration-ms", str(ms).encode("ascii")))
                if not any(name.lower() == b"cache-control" for name, _ in headers):
                    headers.append((b"cache-control", b"no-store"))
                # one request per connection, as the server this replaced
                # always answered. A connection kept open and then closed as
                # idle can be closed under a request the tunnel's proxy has
                # just reused it for, which the proxy answers with a 502 the
                # phone then has to retry; a connection closed with its
                # answer can never be reused at all
                if not any(name.lower() == b"connection" for name, _ in headers):
                    headers.append((b"connection", b"close"))
                message = {**message, "headers": headers}
            await send(message)

        if counted and _reads_open >= READ_SLOTS:
            _overload("reads", route)
            await _plain(503, {"error": "the board is busy answering other readers"},
                         retry_after=2)(scope, receive, bounded_send)
            return
        if counted:
            _reads_open += 1
        try:
            await self.app(scope, receive, bounded_send)
        except Exception:
            # answered and written down inside (_crashed); the exception is
            # re-raised by the application so a server may log it, and this
            # server already has
            pass
        finally:
            if counted:
                _reads_open -= 1
            if route in DIAGNOSTIC_ROUTES:
                try:
                    _slow_request(route, q, status, round((time.monotonic() - started) * 1000))
                except Exception:
                    pass   # diagnostics cannot turn a completed command into a failure
            if LOGGER.isEnabledFor(logging.DEBUG):
                # The request line is DEBUG and not INFO on purpose: the two
                # pages poll about 144,000 times a day between them, and a line
                # for each of those is 22 MB a day of mostly nothing. Switched
                # on, it is the line that says what the board was asked for,
                # what it answered and how long it took
                _debug("request", q.one("box"), method=scope.get("method"), route=route,
                       status=status, ms=round((time.monotonic() - started) * 1000))


def _plain(status: int, payload: dict, retry_after: int | None = None) -> Response:
    """An answer that is not a refusal of what was asked and so writes no
    refusal line: a crash, which has its own line, and a full house, which
    has its rate-limited one."""
    headers = {"Cache-Control": "no-store"}
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return Response(json.dumps(payload).encode(), status_code=status,
                    media_type="application/json", headers=headers)


async def _crashed(request: Request, error: Exception) -> Response:
    """A request that threw. The type, the words when they are safe words, and
    where it happened go in the file; the page gets an answer instead of a
    dropped connection."""
    q = _query(request.scope)
    _error("crash", q.one("box"), route=q.path, **_crash_fields(error))
    return _plain(500, {"error": "the board hit an error answering this request"})


async def _not_found(request: Request, error: Exception) -> Response:
    q = _query(request.scope)
    return _answer(404, {"error": "not found"}, route=q.path, box=q.one("box"))


@contextlib.asynccontextmanager
async def _lifespan(app):
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    # the routes' locked work is short, but a folder chooser or a git listing
    # can hold a thread for a while: room for those and the rest at once
    anyio.to_thread.current_default_thread_limiter().total_tokens = THREAD_POOL_SIZE
    try:
        yield
    finally:
        _LOOP = None


def _static(name: str, ctype: str):
    return _endpoint(lambda q, _: _file(HERE / name, ctype))


ROUTES = [
    Route("/", _endpoint(_get_root), methods=["GET"]),
    Route("/page", _endpoint(_get_page), methods=["GET"]),
    Route("/state", _state_endpoint(_get_state), methods=["GET"]),
    Route("/m/state", _state_endpoint(_get_phone_state), methods=["GET"]),
    Route("/op", _endpoint(_get_op), methods=["GET"]),
    Route("/worktrees", _endpoint(_get_worktrees), methods=["GET"]),
    Route("/unread", _endpoint(_get_unread), methods=["GET"]),
    Route("/wait", WaitRoute(), methods=["GET"]),
    # the queue a lane reads and chooses from. Additive throughout: an auto lane
    # never reaches any of them and behaves exactly as it always has
    Route("/notify", NotifyRoute(), methods=["GET"]),
    Route("/queue", _state_endpoint(_get_queue), methods=["GET"]),
    Route("/attachment", _endpoint(_get_attachment), methods=["GET"]),
    Route("/fresh", _state_endpoint(_get_fresh), methods=["GET"]),
    Route("/thread", _endpoint(_get_thread), methods=["GET"]),
    Route("/history", _endpoint(_get_history), methods=["GET"]),
    Route("/log", _endpoint(_get_log), methods=["GET"]),
    Route("/dirs", _endpoint(_get_dirs), methods=["GET"]),
    Route("/pickdir", _endpoint(_get_pickdir), methods=["GET"]),
    Route("/uploads/{rest:path}", _endpoint(_get_upload), methods=["GET"]),
    Route("/laneimg/{rest:path}", _endpoint(_get_laneimg), methods=["GET"]),
    # the vendored editor, one prebuilt file beside index.html. The page
    # asks for it the first time the markdown panel is opened and never
    # on boot, so a board nobody edits markdown on pays nothing for it
    Route("/cm-markdown.js", _static("cm-markdown.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/card-markdown.js", _static("card-markdown.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/card-tokens.css", _static("card-tokens.css", "text/css; charset=utf-8"), methods=["GET"]),
    Route("/card-logic.js", _static("card-logic.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/compose-format.js", _static("compose-format.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/card-report.js", _static("card-report.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/m-manifest.json", _endpoint(_get_manifest), methods=["GET"]),
    # the phone page and the files that make it installable, each a plain
    # file beside this one (the icons under assets/). Served with the
    # no-store every answer carries, so a changed page or worker is picked
    # up on the next open rather than a cache later
    *[Route(path, _endpoint(lambda q, _, p=p, c=c: _file(p, c)), methods=["GET"])
      for path, (p, c) in PHONE_FILES.items() if path != "/m-manifest.json"],
    Route("/push/key", _endpoint(_get_push_key), methods=["GET"]),
    Route("/mdfiles", _endpoint(_get_mdfiles), methods=["GET"]),
    Route("/mdfile", _endpoint(_get_mdfile), methods=["GET"]),
    Route("/upload", _endpoint(_post_upload, "raw", MAX_UPLOAD_BODY, "upload too large"), methods=["POST"]),
    Route("/clientlog", _endpoint(_post_clientlog, "raw", CLIENT_MAX_BODY, "report batch too large"), methods=["POST"]),
    Route("/mdsave", _endpoint(_post_mdsave, "raw", MAX_TEXT_BODY), methods=["POST"]),
    Route("/send", _state_endpoint(_post_send, "text"), methods=["POST"]),
    Route("/ack", _state_endpoint(_post_ack, "text"), methods=["POST"]),
    Route("/reply", _state_endpoint(_post_reply, "text"), methods=["POST"]),
    Route("/note", _state_endpoint(_post_note, "text"), methods=["POST"]),
    Route("/done", _state_endpoint(_post_done, "text"), methods=["POST"]),
    Route("/working", _state_endpoint(_post_working, "text"), methods=["POST"]),
    Route("/ping", _state_endpoint(_post_ping, "text"), methods=["POST"]),
    Route("/park", _state_endpoint(_post_park, "text"), methods=["POST"]),
    Route("/worktree", _state_endpoint(_post_worktree, "text"), methods=["POST"]),
    Route("/context", _state_endpoint(_post_context, "text"), methods=["POST"]),
    Route("/title", _state_endpoint(_post_title, "text"), methods=["POST"]),
    Route("/create", _state_endpoint(_post_create, "text"), methods=["POST"]),
    Route("/project", _state_endpoint(_post_project, "text"), methods=["POST"]),
    Route("/close", _state_endpoint(_post_close, "text"), methods=["POST"]),
    Route("/delete", _state_endpoint(_post_delete, "text"), methods=["POST"]),
    Route("/ws/goal", _state_endpoint(_post_ws_goal, "text"), methods=["POST"]),
    Route("/ws/task", _state_endpoint(_post_ws_task, "text"), methods=["POST"]),
    Route("/ws/current", _state_endpoint(_post_ws_current, "text"), methods=["POST"]),
    Route("/pages/new", _state_endpoint(_post_pages_new, "text"), methods=["POST"]),
    Route("/pages/del", _state_endpoint(_post_pages_del, "text"), methods=["POST"]),
    Route("/assign", _state_endpoint(_post_assign, "text"), methods=["POST"]),
    Route("/progress", _state_endpoint(_post_progress, "text"), methods=["POST"]),
    Route("/dismiss", _state_endpoint(_post_dismiss, "text"), methods=["POST"]),
    Route("/push/subscribe", _state_endpoint(_post_push_subscribe, "text"), methods=["POST"]),
    Route("/tabs", _state_endpoint(_post_tabs, "text"), methods=["POST"]),
    Route("/seen", _state_endpoint(_post_seen, "text"), methods=["POST"]),
    Route("/mode", _state_endpoint(_post_mode, "text"), methods=["POST"]),
    Route("/hold", _state_endpoint(_post_hold, "text"), methods=["POST"]),
    Route("/select", _state_endpoint(_post_select, "text"), methods=["POST"]),
    Route("/open", _state_endpoint(_post_open, "text"), methods=["POST"]),
    Route("/opened", _state_endpoint(_post_opened, "text"), methods=["POST"]),
    Route("/release", _state_endpoint(_post_release, "text"), methods=["POST"]),
    Route("/notified", _state_endpoint(_post_notified, "text"), methods=["POST"]),
    Route("/work/start", _state_endpoint(_post_work_start, "text"), methods=["POST"]),
    Route("/work/end", _state_endpoint(_post_work_end, "text"), methods=["POST"]),
    Route("/pause", _state_endpoint(_post_pause, "text"), methods=["POST"]),
    Route("/end", _state_endpoint(_post_end, "text"), methods=["POST"]),
]


def build_app():
    """The application: the routes above, a JSON 404 for a route nobody
    serves or the wrong method on one that is served (the answer the old
    dispatch gave both), and a JSON 500 for a crash."""
    app = Starlette(routes=ROUTES, lifespan=_lifespan,
                    exception_handlers={404: _not_found, 405: _not_found, Exception: _crashed})
    app.router.redirect_slashes = False   # /state/ is not /state, as it never was
    return Transport(app)


# -- the wire ---------------------------------------------------------------------------

class BoardProtocol(H11Protocol):
    """uvicorn's HTTP/1.1 protocol with two clocks it does not keep itself.
    A connection that has opened and not yet sent a request is cut after
    FIRST_REQUEST_TIMEOUT: uvicorn's own idle clock only starts after a first
    answer. And a connection whose peer has stopped reading is cut
    WRITE_STALL_TIMEOUT after the write paused: the answer was serialized under
    the lock and the lock let go long before the bytes went out, so the stall
    costs the board one connection and one buffered answer, and this bounds how
    long. The cut has to be forced. Every answer carries Connection: close, so
    uvicorn asks the transport to close the moment the body is handed over; with
    the peer silent that close never finishes, since it is waiting for the very
    bytes the peer will not take. So the deadline does not defer to the closing
    flag: while the write buffer still holds bytes it forces the connection
    down, with a zero linger so the kernel sends a reset rather than queue a
    goodbye behind the unread answer."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._first_timer = None
        self._stall_timer = None
        self._served_one = False

    def connection_made(self, transport) -> None:
        super().connection_made(transport)
        self._first_timer = self.loop.call_later(FIRST_REQUEST_TIMEOUT, self._first_request_late)

    def on_response_complete(self) -> None:
        self._served_one = True
        super().on_response_complete()

    def connection_lost(self, exc) -> None:
        for timer in (self._first_timer, self._stall_timer):
            if timer is not None:
                timer.cancel()
        self._first_timer = self._stall_timer = None
        super().connection_lost(exc)

    def pause_writing(self) -> None:
        super().pause_writing()
        if self._stall_timer is None:
            self._stall_timer = self.loop.call_later(WRITE_STALL_TIMEOUT, self._stalled)

    def resume_writing(self) -> None:
        super().resume_writing()
        if self._stall_timer is not None:
            self._stall_timer.cancel()
            self._stall_timer = None

    def _first_request_late(self) -> None:
        self._first_timer = None
        if not self._served_one and self.conn.their_state is h11.IDLE and not self.transport.is_closing():
            self.transport.close()

    def _stalled(self) -> None:
        self._stall_timer = None
        transport = self.transport
        # the timer only survives to here while the write is paused, since
        # resume_writing cancels it, so the buffer is what decides, not the
        # closing flag. Nothing left to send means the close (or the write)
        # will finish on its own; bytes still buffered mean a peer that stopped
        # reading, and the connection is forced down.
        try:
            buffered = transport.get_write_buffer_size()
        except Exception:
            buffered = 0
        if buffered == 0:
            return
        # a plain abort would leave a goodbye queued behind the unread bytes, so
        # the socket would linger until the peer finally read it. A zero linger
        # makes the kernel send a reset instead, freeing the connection at once
        # and telling the peer, or the tunnel's proxy, plainly that this answer
        # is gone. The option is standard; where a transport hides its socket or
        # refuses it, the abort below still runs.
        sock = transport.get_extra_info("socket")
        if sock is not None:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            except OSError:
                pass
        # the client stopped reading its answer (a phone that went to sleep
        # mid-page, a proxy connection left behind): routine here and never a
        # traceback, but the caller has to be able to find out, so it is
        # reported instead of hidden
        cycle = getattr(self, "cycle", None)
        scope = cycle.scope if cycle is not None else {}
        q = _query(scope)
        _debug("hungup", q.one("box"), route=scope.get("path", ""))
        transport.abort()


class BoardServer(uvicorn.Server):
    """uvicorn's server with its signal capture switched off: this file keeps
    its own handlers, so the stop line can say which signal it was, and so
    SIGHUP, which uvicorn does not watch, ends the run as cleanly as the other
    two rather than killing the process mid-write."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield


class TransportLogHandler(logging.Handler):
    """What uvicorn has to say, in the board's own file and its own shape.
    Its chatter about starting and stopping is dropped, since the board's
    start and stop lines already say that. A warning or an error is kept as
    its type and its plain words, never its traceback, which would carry
    paths. One message is dropped on purpose: the one about an answer that
    was not completed, which is what a connection cut for stalling looks like
    from inside, and which _stalled has already written down properly."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if record.levelno < logging.WARNING:
                return
            words = record.getMessage()
            if words.startswith("ASGI callable returned without completing response"):
                return
            error = record.exc_info[1] if record.exc_info and record.exc_info[1] else None
            fields = {"message": words[:CRASH_MESSAGE_CHARS] if set(words) <= CRASH_PLAIN else None,
                      "error": type(error).__name__ if error else None}
            _event(logging.ERROR if record.levelno >= logging.ERROR else logging.INFO,
                   "transport", **fields)
        except Exception:
            pass


def _quiet_uvicorn() -> None:
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "uvicorn.asgi"):
        log = logging.getLogger(name)
        log.handlers = [TransportLogHandler()]
        log.propagate = False
        log.setLevel(logging.INFO)


def _listen() -> socket.socket:
    """The listening socket, bound the way the old server bound it: loopback
    only, address reuse on, so a restart does not wait out a closed socket's
    linger and a second board on the same port is refused."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", PORT))
    sock.listen(LISTEN_BACKLOG)
    return sock


def _make_server() -> BoardServer:
    config = uvicorn.Config(
        build_app(), host="127.0.0.1", port=PORT,
        log_config=None, access_log=False, server_header=False,
        http=BoardProtocol, ws="none", lifespan="on", loop="asyncio",
        limit_concurrency=CONNECTION_LIMIT, backlog=LISTEN_BACKLOG,
        timeout_keep_alive=KEEP_ALIVE_TIMEOUT,
        timeout_graceful_shutdown=GRACEFUL_STOP_TIMEOUT,
    )
    return BoardServer(config)


# why this process is stopping, set by the signal handler in main and read by
# the stop line on the way out; None until something asks it to stop
_stop_reason: str | None = None


def main() -> None:
    _quiet_uvicorn()

    # Own the listening socket before touching durable board data. In
    # particular, a replacement started while the old server still owns the
    # port must not migrate state or append the transcript schema boundary: the
    # old process can still append legacy rows until it has actually stopped.
    try:
        sock = _listen()
    except OSError as error:
        _error("bindfail", port=PORT,
               reason=f"facilitator could not listen on 127.0.0.1:{PORT}: {error}")
        raise SystemExit(1) from None

    server = _make_server()

    def stopping(signum, frame) -> None:
        """Ctrl-C, a kill, or the terminal closing: the reason is remembered and
        the ordinary shutdown runs, so the file gets a stop line to match its
        start line. A start with no matching stop was all the file remembered
        about a restart, which is why one could not be explained. Open
        requests get GRACEFUL_STOP_TIMEOUT to finish; a listener waiting for a
        card is sent home at once."""
        global _stop_reason
        if _stop_reason is None:
            _stop_reason = signal.Signals(signum).name
        _STOPPING.set()
        server.should_exit = True
        _notify()

    for stopper in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(stopper, stopping)

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
            # the epoch rises at every start, and it is what separates the
            # things a restart legitimately destroys from the things it does
            # not. Reservations go with the claims they are the other half of,
            # and prepared deliveries are abandoned rather than forgotten, so a
            # receipt arriving for one afterwards is refused and told why. The
            # holder record is deliberately kept: who was serving a lane
            # survives a restart, and only the queue positions do not
            _state["epoch"] = _state.get("epoch", 0) + 1
            _state["reservations"] = {}
            for record in _state.setdefault("deliveries", {}).values():
                if record.get("state") == "prepared":
                    record["state"] = "abandoned"
                    record["why"] = "board restarted"
            # re-queue any box that still has unanswered messages
            for b in _state["boxes"]:
                if b["pending"] and b["id"] not in _state["inbox"]:
                    _state["inbox"].append(b["id"])
            _save()
        pushed = _state.get("push_last_ok") or {}
        _info("start", port=PORT, boxes=len(_state["boxes"]), log_level=LOG_LEVEL,
              push_ok=pushed.get("ts"), push_host=pushed.get("host"))
        server.run(sockets=[sock])
    except Exception as error:
        # the last word about a start that died of something rather than being
        # asked to stop: the stop line below says only which type ended it, and
        # the traceback that used to explain it now goes nowhere
        _error("crash", **_crash_fields(error))
        raise
    finally:
        # one stop line for every start line, and it says why: a named signal,
        # the exception that ended it, or the loop simply returning
        ended = sys.exc_info()[0]
        _info("stop", reason=_stop_reason or (ended.__name__ if ended else "end of stream"))
        sock.close()


if __name__ == "__main__":
    main()
