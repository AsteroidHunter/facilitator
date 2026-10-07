"""The daily usage counts: once a day the board sends one small message of
counts about the day before to the Facilitator project in PostHog, unless the
board's "Share daily usage counts" setting (Settings, Improvements) is off.
README.md, "Usage counts", lists every field, and a field added here goes into
that list in the same change.

What is counted comes out of what the board already keeps, and nothing else:

  transcript.jsonl   the board's own record of what happened, one row per
                     event with its time. Rows are counted by kind and never
                     read for their words: messages sent ("user"), cards made
                     ("create"), cards closed ("done"), projects added
                     ("project") and completed agent replies ("agent"), each
                     reply split by the agent_kind the board writes on it
                     (claude, codex or other).
  client-<day>.jsonl the pages' log. A "notifycheck" line from a phone is the
                     phone app opening or coming back, which is phone use.

A day is sent only when it was used: one of the owner's own actions is in the
transcript that day, or the phone app was opened. Minutes used are rough: every
five-minute stretch of the day holding one of those actions or phone openings
counts as five minutes, so reading on the Mac without doing anything is not
seen.

The message carries no install id. Each one has a fresh random distinct_id
that is never stored, it tells PostHog to make no person profile and to work
out no location, and it holds only numbers, yes or no, the version and the
macOS major version: never a word anybody typed, a name, a title, a folder or a
path. The token is PostHog's public project token, which can only send.

Each day goes at most once. usage-counts.json beside state.json holds the last
day already dealt with, and nothing else; a day is marked there before its
message goes and unmarked only when the send fails, so a board stopped halfway
through a send can lose that day but never send it twice. A day that ends while
sharing is off is marked without being sent, so turning it back on never sends
it later. A board that has been offline sends at most BACKLOG_DAYS of the days
it missed, oldest first, and stops at the first failure to try again later.

Nothing here runs on a request: the server starts Sender.run on a thread of its
own once the board is up, and every failure is caught and written down."""
from __future__ import annotations

import datetime as dt
import json
import os
import platform
import re
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Callable

ENDPOINT = "https://us.i.posthog.com/i/v0/e/"   # PostHog Cloud, US region
# the project token: public by design, it can send events and read nothing
TOKEN = "phc_pmdWA3oMUgUWGLyLkXvDFSzYQgvTotFQyA93BWXTdJ9K"
EVENT = "daily_usage"
SETTING = "usagecounts"   # the board setting: "0" is off; missing or anything else is on
TIMEOUT = 10.0            # seconds one send may take
FIRST_LOOK = 300          # seconds after the board starts before the first look
LOOK_EVERY = 900          # seconds between looks, so a day goes out within this of midnight
RETRY_AFTER = 3600        # seconds before trying again after a send that failed
BACKLOG_DAYS = 7          # the most missed days sent at once; older ones are dropped
BLOCK = 300               # seconds in one stretch of minutes used
SLACK = 3600              # seconds of transcript read past the oldest day, for rows a little out of order
READ_CHUNK = 65536        # bytes the transcript is read backwards in

# the transcript kinds that are the owner's own doing: a message sent, a card
# made, closed, reopened or removed, a project or a page added or taken away
OWNER_KINDS = frozenset(("user", "create", "done", "undone", "delete", "project", "page+", "page-"))
AGENTS = ("claude", "codex")
VERSION = re.compile(rb'id="npversion">(v[0-9]+\.[0-9]+\.[0-9]+)<')


def agent_kind(name) -> str:
    """claude, codex or other, from the name a lane's agent gave on /wait."""
    said = str(name or "").lower()
    for agent in AGENTS:
        if agent in said:
            return agent
    return "other"


def _day_bounds(day: dt.date) -> tuple[float, float]:
    """The day's start and end on this Mac's clock, as epoch seconds."""
    start = dt.datetime.combine(day, dt.time.min).timestamp()
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time.min).timestamp()
    return start, end


def _rows_back_to(path: Path, since: float):
    """The transcript's rows from the newest back to the first one older than
    since, read from the end of the file so a long history costs nothing. A
    line that is not a row (a half-written last line, a damaged one) is
    passed over."""
    try:
        f = open(path, "rb")
    except OSError:
        return
    with f:
        f.seek(0, os.SEEK_END)
        at = f.tell()
        rest = b""
        while at > 0:
            step = min(READ_CHUNK, at)
            at -= step
            f.seek(at)
            lines = (f.read(step) + rest).split(b"\n")
            rest = lines.pop(0)   # may be cut in two; it joins the next chunk back
            for line in reversed(lines):
                row = _row(line)
                if row is None:
                    continue
                if row["ts"] < since:
                    return
                yield row
        row = _row(rest)
        if row is not None and row["ts"] >= since:
            yield row


def _row(line: bytes):
    if not line.strip():
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    if not isinstance(row, dict) or isinstance(row.get("ts"), bool) or not isinstance(row.get("ts"), (int, float)):
        return None
    return row


def _phone_opens(log_dir: Path, day: dt.date) -> list[float]:
    """When the phone app opened or came back on that day: the notifycheck
    lines a phone wrote into that day's client files."""
    start, end = _day_bounds(day)
    times = []
    try:
        files = sorted(log_dir.glob(f"client-{day:%Y%m%d}*.jsonl"))
    except OSError:
        return times
    for path in files:
        try:
            with open(path, "rb") as f:
                for line in f:
                    if b'"notifycheck"' not in line or b'"phone"' not in line:
                        continue
                    try:
                        rec = json.loads(line)
                        when = dt.datetime.strptime(rec["ts"], "%Y-%m-%dT%H:%M:%S.%fZ")
                    except (ValueError, KeyError, TypeError):
                        continue
                    if rec.get("kind") != "notifycheck" or rec.get("client") != "phone":
                        continue
                    t = when.replace(tzinfo=dt.timezone.utc).timestamp()
                    if start <= t < end:
                        times.append(t)
        except OSError:
            continue
    return times


def day_counts(days: list[dt.date], transcript: Path, log_dir: Path) -> dict:
    """{day: counts} for each of these days that was used; a day nobody used
    is left out. One pass over the transcript serves every day asked for."""
    if not days:
        return {}
    tally = {day: {"owner": [], "user": 0, "create": set(), "done": set(), "project": 0,
                   "claude": 0, "codex": 0, "other": 0} for day in days}
    since = _day_bounds(min(days))[0] - SLACK
    for row in _rows_back_to(transcript, since):
        try:
            day = dt.date.fromtimestamp(row["ts"])
        except (OverflowError, OSError, ValueError):
            continue
        t = tally.get(day)
        if t is None:
            continue
        kind = row.get("kind")
        if kind in OWNER_KINDS:
            t["owner"].append(row["ts"])
        if kind == "user":
            t["user"] += 1
        elif kind == "create":
            t["create"].add(row.get("box"))
        elif kind == "done":
            t["done"].add(row.get("box"))
        elif kind == "project":
            t["project"] += 1
        elif kind == "agent":
            t[agent_kind(row.get("agent_kind"))] += 1
    out = {}
    for day, t in tally.items():
        phone = _phone_opens(log_dir, day)
        used = t["owner"] + phone
        if not used:
            continue
        out[day] = {
            "minutes_used": len({int(when // BLOCK) for when in used}) * BLOCK // 60,
            "cards_created": len(t["create"]),
            "cards_closed": len(t["done"]),
            "projects_created": t["project"],
            "messages_sent": t["user"],
            "replies_claude": t["claude"],
            "replies_codex": t["codex"],
            "replies_other": t["other"],
            "phone_used": bool(phone),
        }
    return out


def app_version(index_html: Path) -> str:
    """The version the board shows (#npversion in index.html), or unknown."""
    try:
        found = VERSION.search(index_html.read_bytes())
    except OSError:
        found = None
    return found.group(1).decode() if found else "unknown"


def os_fields() -> dict:
    """The operating system's family and major version, never more."""
    release = platform.mac_ver()[0]
    if release:
        return {"os": "macOS", "os_version": release.split(".")[0]}
    return {"os": platform.system() or "unknown", "os_version": ""}


def payload(day: dt.date, counts: dict, version: str, system: dict,
            new_id: Callable[[], uuid.UUID] = uuid.uuid4) -> dict:
    """The whole message for one day. distinct_id is new for every message,
    so no two messages can be tied together; the timestamp is noon UTC on the
    day counted, which says the day and nothing about the time zone."""
    return {
        "api_key": TOKEN,
        "event": EVENT,
        "distinct_id": str(new_id()),
        "timestamp": f"{day.isoformat()}T12:00:00Z",
        "properties": {
            "$process_person_profile": False,
            "$geoip_disable": True,
            **counts,
            "facilitator_version": version,
            "os": system["os"],
            "os_version": system["os_version"],
        },
    }


def post(body: dict, opener=None, timeout: float = TIMEOUT) -> tuple[str, str]:
    """One message to PostHog: ("sent", ""), ("refused", status) when PostHog
    turned it down for good, or ("failed", why) when it could not get there
    or PostHog could not take it now, which is tried again later."""
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "Facilitator"})
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as answer:
            status = getattr(answer, "status", 200)
    except urllib.error.HTTPError as e:
        status = e.code
        e.close()
    except Exception as e:   # offline, refused, timed out, a broken answer: all later
        return "failed", type(e).__name__
    if 200 <= status < 300:
        return "sent", ""
    if 400 <= status < 500 and status not in (408, 429):
        return "refused", str(status)
    return "failed", str(status)


class Sender:
    """Looks once in a while for days that have ended and not been dealt with,
    and sends each used one, once. sharing() is read before every send.
    log(kind, **fields) is the board's own INFO line; every outside call
    (the clock, the network, a fresh id) can be handed in for the tests."""

    def __init__(self, *, transcript: Path, log_dir: Path, marker: Path, index_html: Path,
                 sharing: Callable[[], bool], log: Callable = lambda *a, **k: None,
                 opener=None, today: Callable[[], dt.date] = dt.date.today,
                 new_id: Callable[[], uuid.UUID] = uuid.uuid4) -> None:
        self.transcript, self.log_dir, self.marker, self.index_html = transcript, log_dir, marker, index_html
        self.sharing, self.log, self.opener, self.today, self.new_id = sharing, log, opener, today, new_id
        self.through: dt.date | None = None   # every day up to this one is dealt with

    def _read_marker(self) -> dt.date | None:
        try:
            return dt.date.fromisoformat(json.loads(self.marker.read_text())["through"])
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _write_marker(self, day: dt.date) -> bool:
        tmp = self.marker.with_name(self.marker.name + ".tmp")
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps({"through": day.isoformat()}) + "\n")
            os.replace(tmp, self.marker)
        except OSError as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            self.log("usage", outcome="unmarked", reason=e.strerror or type(e).__name__)
            return False
        self.through = day
        return True

    def look(self) -> bool:
        """One look. False when a send failed and is to be tried again later."""
        yesterday = self.today() - dt.timedelta(days=1)
        if self.through is None:
            self.through = self._read_marker()
        if self.through is None:
            # a board that has never sent starts counting today: nothing from
            # before the counts existed is ever sent, and nothing is sent now
            self._write_marker(yesterday)
            return True
        if self.through >= yesterday:
            return True
        if not self.sharing():
            self._write_marker(yesterday)
            return True
        first = max(self.through + dt.timedelta(days=1), yesterday - dt.timedelta(days=BACKLOG_DAYS - 1))
        days = [first + dt.timedelta(days=n) for n in range((yesterday - first).days + 1)]
        counts = day_counts(days, self.transcript, self.log_dir)
        version, system = app_version(self.index_html), os_fields()
        for day in days:
            if day not in counts:
                continue   # not used: nothing to send, and marked with the days after it
            if not self.sharing():
                break
            before = self.through
            # marked first, so a board stopped mid-send never sends this day again
            if not self._write_marker(day):
                return False
            outcome, why = post(payload(day, counts[day], version, system, self.new_id), self.opener)
            if outcome == "failed":
                self._write_marker(before)
                self.log("usage", outcome="failed", day=day.isoformat(), reason=why)
                return False
            self.log("usage", outcome=outcome, day=day.isoformat(), **({"reason": why} if why else {}))
        self._write_marker(yesterday)
        return True

    def run(self, stopping: threading.Event) -> None:
        """Look now and then until the board stops. A look that throws is
        written down and the next one goes ahead; nothing here can stop the
        board, and the thread is a daemon, so it never holds the board open."""
        wait = FIRST_LOOK
        while not stopping.wait(wait):
            try:
                wait = LOOK_EVERY if self.look() else RETRY_AFTER
            except Exception as e:
                self.log("usage", outcome="error", reason=type(e).__name__)
                wait = RETRY_AFTER
