"""The daily usage counts: once a day the board sends one small message of
counts about the day before to the Facilitator project in PostHog, unless the
board's "Share daily usage counts" setting (Settings, Improvements) is off.

What is counted comes out of these two files beside state.json and the
board's token counter, and nothing else:

  transcript.jsonl   the board's own record of what happened, one row per
                     event with its time. Rows are counted by kind and never
                     read for their words: messages sent ("user"), cards made
                     ("create"), cards closed ("done"), projects added
                     ("project") and completed agent replies ("agent"), each
                     reply split by the agent_kind the board writes on it
                     (claude, codex or other).
  usage-phone.json   when the phone app opened or came back, which is phone
                     use: the start of each five-minute stretch that held
                     one, kept by the server when it takes the phone's
                     notifycheck report (PhoneUse), at every log level.
  tokens.py          the tokens Claude Code and Codex spent each day, read
                     from their own logs on this Mac by the counter the home
                     page's token chart uses (TokenLedger.tally), which the
                     server hands in. Only counts come from it: each tool's
                     total and its four kinds (tokens_claude,
                     tokens_claude_input, tokens_claude_cache_write,
                     tokens_claude_cache_read, tokens_claude_output, and the
                     same for codex), and the day's tokens by board share,
                     all of them and without cache re-reads (tokens_board and
                     tokens_board_new for sessions that ran the board's wait
                     helper, tokens_off_board and tokens_off_board_new for the
                     rest, tokens_board_unknown and tokens_board_unknown_new
                     for logs counted before the counter kept that answer).

Each day's message also carries days_since_install: the days from the
board's first day, the day of the transcript's first stamped row (handed in by
the server too), to the day counted. It is left out while there is no such
row.

A day is sent when it was used or when an agent spent tokens in it: one of the
owner's own actions is in the transcript that day, the phone app was opened,
or Claude Code or Codex logged tokens that day, with the board open or not. A
day of tokens alone carries zeros for the board's own counts. Minutes used are
rough: every five-minute stretch of the day holding one of those actions or
phone openings counts as five minutes, so reading on the Mac without doing
anything is not seen.

Once per install one more message goes, token_baseline, stamped noon UTC on
the board's first day: how many days back before that day each tool's logs
reach (days_of_logs_claude, days_of_logs_codex, BASELINE_WEEKS weeks at most),
how many whole weeks that covers (weeks_before_install), and for each of those
weeks, week 1 being the seven days just before the first day, its tokens
without cache re-reads (tokens_new_week_1 and on) and its days with any tokens
(active_days_week_1 and on). It is the one message about days from before the
counts existed. It goes only while the switch is on, waiting while it is off,
and only once the first day is known. usage-baseline.json beside state.json
says it has gone: it is written before the message goes and taken away only
when the send fails, so the baseline never goes twice.

Every message carries the same distinct_id: a random install id (a uuid4)
made the first time one is needed and kept in usage-install.json beside
state.json, owner-only, never in the repo and never in a log line. A file that
is missing or unreadable is made again, with a new id. The message tells
PostHog to make no person profile and to work out no location, and it holds
only numbers, yes or no, the version and the macOS major version: never a word
anybody typed, a name, a title, a folder or a path. The token is PostHog's
public project token, which can only send.

A person is added only when they say yes to being emailed for feedback, in the
onboarding or in Settings, Profile (POST /profile in server.py). With that yes,
link_person(person, yes) saves the yes, the address and the profile's other
answers in usage-install.json and sends PostHog one $identify for the install
id, setting them as properties of that person ($set): email, name, work (what
they will mostly use Facilitator for, in their own words) and time_zone, each
only when given. An answer changed later while the yes holds is sent once
more, alone: the next identify carries only what differs from what PostHog
was last told, and an answer cleared is unset ($unset). None of it ever
rides on a daily message. Taking the yes back (unlink_email) forgets the
address and the answers here and sends nothing; what PostHog already holds stays
there. link_email(email, yes) is the same with the email alone.

From the yes on the daily messages leave $process_person_profile out (PostHog's
default, an identified event), so usage shows next to the person, and the days
already sent under the same id are attributed to them. An identify that could
not get through is kept and sent on a later look. Turning the switch off sends
nothing at all, no day and no identify; the saved yes and answers stay on the
Mac, and turning it back on picks up where it stopped: a pending identify goes
out and the daily messages are identified again, under the same id.

Each day goes at most once. usage-counts.json beside state.json holds the last
day already dealt with, and nothing else; a day is marked there before its
message goes and unmarked only when the send fails, so a board stopped halfway
through a send can lose that day but never send it twice. A day that ends while
sharing is off is marked without being sent, so turning it back on never sends
it later. A board that has been offline or not running sends at most
BACKLOG_DAYS of the days it missed, oldest first, and stops at the first
failure to try again later; the agents' logs keep a day's tokens while the
board is down, so a day of tokens alone in that time goes too, and anything
older is dropped. A day is not sent at all when the install id cannot be
saved, since a new one every time would make every message a stranger. When
the token counter cannot be read the days go without their token numbers, and
a log line says so.

The one thing sent with words is the feedback box in Settings, Improvements
(POST /feedback in server.py): when the person presses send and lets the three
seconds to cancel pass, send_feedback sends one "feedback sent" message under
the install id with the text they wrote, the version, and their name and email
as person properties ($set). It goes whether or not the daily counts switch is
on, since sending feedback is its own choice, and it needs a name and an email
in the profile. Text only, at most FEEDBACK_MAX characters, never an empty one,
and never anything the person did not press send on.

The server starts Sender.run on a thread of its own once the board is up, and
every failure is caught and written down. Only link_person, link_email,
unlink_email and send_feedback run on a request (POST /profile, POST
/usage/email and POST /feedback in server.py), and each sends at most one
message; POST /profile asks link_person not to wait, so its identify goes on
a thread of its own (identify_soon) and the save never waits on PostHog.
phone_opened runs on POST /clientlog and sends nothing. No log line ever holds
an email address, any other answer, a feedback message, an install id or the
token.

For tests, FACILITATOR_POSTHOG_ENDPOINT points every send at a local stub. It
is honoured only for an http address on this Mac (127.0.0.1 or localhost), so
no setting can send anything anywhere else."""
from __future__ import annotations

import datetime as dt
import json
import os
import platform
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Callable

import agent_names

POSTHOG_ENDPOINT = "https://us.i.posthog.com/i/v0/e/"   # PostHog Cloud, US region
ENDPOINT_ENV = "FACILITATOR_POSTHOG_ENDPOINT"          # tests: a stub on this Mac in its place
# the project token: public by design, it can send events and read nothing
TOKEN = "phc_pmdWA3oMUgUWGLyLkXvDFSzYQgvTotFQyA93BWXTdJ9K"
EVENT = "daily_usage"
BASELINE_EVENT = "token_baseline"
BASELINE_WEEKS = 8        # the most weeks before the board's first day the baseline holds
# the token counter's names (tokens.py): its tools, its board shares, and the
# four kinds each day's counts come in, in this order
TOKEN_TOOLS = ("claude", "codex")
TOKEN_SHARES = ("board", "off_board", "board_unknown")
TOKEN_KINDS = ("input", "cache_write", "cache_read", "output")
FEEDBACK_EVENT = "feedback sent"
FEEDBACK_MAX = 5000       # the most characters one feedback message may hold
SETTING = "usagecounts"   # the board setting: "0" is off; missing or anything else is on
TIMEOUT = 10.0            # seconds one send may take
FIRST_LOOK = 300          # seconds after the board starts before the first look
LOOK_EVERY = 900          # seconds between looks, so a day goes out within this of midnight
RETRY_AFTER = 3600        # seconds before trying again after a send that failed
BACKLOG_DAYS = 7          # the most missed days sent at once; older ones are dropped
BLOCK = 300               # seconds in one stretch of minutes used
SLACK = 3600              # seconds of transcript read past the oldest day, for rows a little out of order
PHONE_KEEP = (BACKLOG_DAYS + 2) * 86400   # seconds of phone openings kept: every day a look can still send
READ_CHUNK = 65536        # bytes the transcript is read backwards in

# the transcript kinds that are the owner's own doing: a message sent, a card
# made, closed, reopened or removed, a project or a page added or taken away
OWNER_KINDS = frozenset(("user", "create", "done", "undone", "delete", "project", "page+", "page-"))
VERSION = re.compile(rb'id="npversion">(v[0-9]+\.[0-9]+\.[0-9]+)<')
EMAIL_PART = r"[^@\s\x00-\x1f\x7f]+"
EMAIL = re.compile(f"{EMAIL_PART}@{EMAIL_PART}\\.{EMAIL_PART}")
EMAIL_MAX = 254           # the longest an address can be
# the answers that go with the email under its yes, as PostHog person
# properties, and the most characters each may hold (the profile's own caps)
PERSON_TEXT_MAX = {"name": 200, "work": 2000, "time_zone": 64}
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def endpoint() -> str:
    """Where messages go: PostHog, unless the test variable names a stub on this
    Mac. Anything else it holds is ignored."""
    stub = os.environ.get(ENDPOINT_ENV, "").strip()
    try:
        where = urllib.parse.urlsplit(stub)
        ours = where.scheme == "http" and where.hostname in ("127.0.0.1", "localhost") and where.port is not None
    except ValueError:
        ours = False
    return stub if ours else POSTHOG_ENDPOINT


ENDPOINT = endpoint()


def clean_email(value) -> str | None:
    """The address as it is kept and sent, or None when it is not one: text
    with one @, a dot after it, no spaces or control characters, 254 at most."""
    if not isinstance(value, str):
        return None
    address = value.strip()
    return address if len(address) <= EMAIL_MAX and EMAIL.fullmatch(address) else None


def clean_answers(value) -> dict:
    """The answers that go with the email, as they are kept and sent: each of
    PERSON_TEXT_MAX's names that holds text, trimmed, within its cap and with no
    control character but a tab or a new line. Anything else is left out."""
    out = {}
    if not isinstance(value, dict):
        return out
    for key, cap in PERSON_TEXT_MAX.items():
        text = value.get(key)
        if isinstance(text, str) and text.strip() and len(text.strip()) <= cap and not CONTROL.search(text):
            out[key] = text.strip()
    return out


def agent_kind(name) -> str:
    """claude, codex or other, from the name a lane's agent gave on /wait."""
    return agent_names.agent_kind(name)


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


class PhoneUse:
    """When the phone app opened or came back, for the counts alone, in one
    owner-only file: {"opened": [...]}, the start of each five-minute stretch
    (epoch seconds) that held an opening. The server notes one when it takes
    the phone's notifycheck report, whatever the log level, so a board logging
    errors only still counts phone use. Only the last PHONE_KEEP seconds are
    kept, and nothing else ever: no words, no card, no path, nobody's details.
    A file that is missing or unreadable reads as no openings."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()

    def read(self) -> list[int]:
        try:
            opened = json.loads(self.path.read_text())["opened"]
        except (OSError, ValueError, KeyError, TypeError):
            return []
        return [t for t in opened if type(t) is int] if isinstance(opened, list) else []

    def note(self, now: float) -> None:
        """Keeps the stretch now falls in, once. Raises OSError and leaves the
        file as it was when it cannot be written."""
        block = int(now // BLOCK) * BLOCK
        with self.lock:
            opened = self.read()
            if block in opened:
                return
            body = {"opened": sorted(t for t in {*opened, block} if t >= now - PHONE_KEEP)}
            tmp = self.path.with_name(self.path.name + ".tmp")
            try:
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(json.dumps(body) + "\n")
                os.replace(tmp, self.path)
            except OSError:
                try:
                    tmp.unlink()
                except OSError:
                    pass
                raise


# a day's counts when the board was not used that day
NOT_USED = {"minutes_used": 0, "cards_created": 0, "cards_closed": 0, "projects_created": 0,
            "messages_sent": 0, "replies_claude": 0, "replies_codex": 0, "replies_other": 0,
            "phone_used": False}


def day_counts(days: list[dt.date], transcript: Path, phone_file: Path) -> dict:
    """{day: counts} for each of these days that was used; a day nobody used
    is left out. One pass over the transcript serves every day asked for."""
    if not days:
        return {}
    opened = PhoneUse(phone_file).read()
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
        start, end = _day_bounds(day)
        phone = [when for when in opened if start <= when < end]
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


def _spent(tally, name: str, day: dt.date) -> list[int]:
    """One day's four kinds for one tool or share of the token counter's
    tally, as whole numbers; zeros for a day it has nothing for."""
    days = tally.get(name) if isinstance(tally, dict) else None
    row = days.get(day.isoformat()) if isinstance(days, dict) else None
    row = row[:4] if isinstance(row, list) else []
    return [int(n) if isinstance(n, (int, float)) and not isinstance(n, bool) and n > 0 else 0
            for n in row + [0] * (4 - len(row))]


def token_counts(days: list[dt.date], tally) -> dict:
    """{day: token numbers} for each of these days, out of the token counter's
    tally (tokens.TokenLedger.tally): each tool's total and four kinds, then
    the day's tokens by board share, all of them and the new ones (all but
    cache re-reads). A day the logs hold nothing for is zeros."""
    out = {}
    for day in days:
        fields = {}
        for tool in TOKEN_TOOLS:
            row = _spent(tally, tool, day)
            fields[f"tokens_{tool}"] = sum(row)
            fields.update({f"tokens_{tool}_{kind}": n for kind, n in zip(TOKEN_KINDS, row)})
        for share in TOKEN_SHARES:
            row = _spent(tally, share, day)
            fields[f"tokens_{share}"] = sum(row)
            fields[f"tokens_{share}_new"] = sum(row) - row[TOKEN_KINDS.index("cache_read")]
        out[day] = fields
    return out


def baseline_counts(first_day: dt.date, tally) -> dict:
    """The token_baseline numbers for a board first used on first_day: how many
    days back before it each tool's logs reach (BASELINE_WEEKS weeks at most),
    the whole weeks that covers, and for each of them, week 1 being the seven
    days just before first_day, its new tokens (all but cache re-reads) and
    its days with any tokens. A week the logs do not reach is left out, never
    sent as a week of zeros."""
    reach = {}
    for tool in TOKEN_TOOLS:
        days = tally.get(tool) if isinstance(tally, dict) else None
        earliest = None
        for key in days if isinstance(days, dict) else ():
            try:
                day = dt.date.fromisoformat(key)
            except (TypeError, ValueError):
                continue
            if day < first_day and any(_spent(tally, tool, day)) and (earliest is None or day < earliest):
                earliest = day
        reach[tool] = min((first_day - earliest).days, BASELINE_WEEKS * 7) if earliest else 0
    weeks = max(reach.values()) // 7
    out = {"weeks_before_install": weeks, **{f"days_of_logs_{tool}": reach[tool] for tool in TOKEN_TOOLS}}
    for week in range(1, weeks + 1):
        new = active = 0
        for back in range(7 * week, 7 * week - 7, -1):
            rows = [_spent(tally, tool, first_day - dt.timedelta(days=back)) for tool in TOKEN_TOOLS]
            new += sum(sum(row) - row[TOKEN_KINDS.index("cache_read")] for row in rows)
            active += 1 if any(any(row) for row in rows) else 0
        out[f"tokens_new_week_{week}"] = new
        out[f"active_days_week_{week}"] = active
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


def payload(day: dt.date, counts: dict, version: str, system: dict, install_id: str,
            identified: bool = False, event: str = EVENT) -> dict:
    """The whole message for one day, or with BASELINE_EVENT the baseline,
    whose day is the board's first. distinct_id is the install id, the same
    on every message. Without an email it says $process_person_profile false,
    so PostHog makes no profile; once the person has said yes to an email
    (identified) it leaves that out, which PostHog reads as an identified
    event. The timestamp is noon UTC on the day counted, which says the day
    and nothing about the time zone."""
    return {
        "api_key": TOKEN,
        "event": event,
        "distinct_id": install_id,
        "timestamp": f"{day.isoformat()}T12:00:00Z",
        "properties": {
            **({} if identified else {"$process_person_profile": False}),
            "$geoip_disable": True,
            **counts,
            "facilitator_version": version,
            "os": system["os"],
            "os_version": system["os_version"],
        },
    }


def identify_payload(install_id: str, changed, gone=()) -> dict:
    """PostHog's $identify for the install id: it sets person properties on the
    person the id already belongs to. changed is what to set, the person
    properties that differ from what PostHog was last told (or the email alone,
    given as text); gone names the ones taken away since, which are unset. No
    other field, no timestamp (PostHog stamps it on arrival), and no location."""
    props = {"email": changed} if isinstance(changed, str) else dict(changed)
    properties = {"$geoip_disable": True}
    if props:
        properties["$set"] = props
    if gone:
        properties["$unset"] = list(gone)
    return {
        "api_key": TOKEN,
        "event": "$identify",
        "distinct_id": install_id,
        "properties": properties,
    }


def clean_feedback(value) -> str | None:
    """The message as it is sent, or None when there is nothing to send: text
    with its ends trimmed, new lines kept as \\n and any other control
    character left out. Past FEEDBACK_MAX characters it is too long, and the
    caller says so (send_feedback) rather than cutting it."""
    if not isinstance(value, str):
        return None
    text = CONTROL.sub("", value.replace("\r\n", "\n").replace("\r", "\n")).strip()
    return text or None


def feedback_payload(install_id: str, message: str, version: str, person: dict) -> dict:
    """The "feedback sent" message: the install id, the words, the version, and
    the person's name and email as person properties ($set), so it shows next
    to them. No daily counts ride on it and no location is worked out."""
    return {
        "api_key": TOKEN,
        "event": FEEDBACK_EVENT,
        "distinct_id": install_id,
        "properties": {
            "$set": dict(person),
            "$geoip_disable": True,
            "message": message,
            "facilitator_version": version,
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


def person_of(rec: dict) -> dict:
    """The person properties a record says PostHog should hold: the email and
    the answers given with it, or nothing without a yes."""
    return {"email": rec["email"], **rec["answers"]} if rec["email"] is not None else {}


def pending(rec: dict) -> tuple[dict, list]:
    """What PostHog has not been told yet: the properties that differ from the
    ones last told, and the names of those told once and taken away since."""
    now = person_of(rec)
    changed = {key: value for key, value in now.items() if rec["told"].get(key) != value}
    gone = [key for key in rec["told"] if key not in now]
    return changed, gone


class Install:
    """The install id, and the email and the answers that go with it when the
    person said yes to being emailed for feedback, in one owner-only file:

      install_id     a uuid4, made the first time it is asked for
      feedback_yes   true only with a saved email: the yes
      email          the address, kept as the person gave it
      answers        what goes with it under the same yes: name, work
                     and time_zone, each only when given
      told           the person properties PostHog was last told, or turned
                     down for good, so only a change is ever sent again
      identify_done  nothing is left to tell PostHog

    A file that is missing, unreadable or without a proper id is made again
    with a new id, and any email and answers in it are gone with it. A file
    from before the answers went with the email has no told: its email counts
    as told when identify_done says so. Nothing here logs."""

    def __init__(self, path: Path, new_id: Callable[[], uuid.UUID] = uuid.uuid4) -> None:
        self.path, self.new_id = path, new_id
        self.lock = threading.RLock()

    def read(self) -> dict | None:
        """What the file holds, or None when there is no usable record."""
        try:
            rec = json.loads(self.path.read_text())
            made = uuid.UUID(rec["install_id"])
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return None
        if made.version != 4 or str(made) != rec["install_id"]:
            return None   # not an id this code made, so not one to send
        email = clean_email(rec.get("email")) if rec.get("feedback_yes") is True else None
        told = rec.get("told")
        if isinstance(told, dict):
            told = {key: value for key, value in told.items()
                    if key in ("email", *PERSON_TEXT_MAX) and isinstance(value, str)}
        else:
            told = {"email": email} if email is not None and rec.get("identify_done") is True else {}
        out = {"install_id": rec["install_id"], "email": email,
               "answers": clean_answers(rec.get("answers")) if email is not None else {}, "told": told}
        changed, gone = pending(out)
        out["identify_done"] = email is not None and not changed and not gone
        return out

    def write(self, rec: dict) -> None:
        """Replaces the file whole, or raises OSError and leaves it as it was."""
        tmp = self.path.with_name(self.path.name + ".tmp")
        changed, gone = pending(rec)
        body = {"install_id": rec["install_id"], "feedback_yes": rec["email"] is not None,
                "email": rec["email"], "answers": rec["answers"], "told": rec["told"],
                "identify_done": rec["email"] is not None and not changed and not gone}
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps(body) + "\n")
            os.replace(tmp, self.path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise

    def get(self) -> dict:
        """The record, made and saved first if there is none. Raises OSError
        when a new id cannot be saved: an id kept only in memory would be a
        new one after every restart."""
        with self.lock:
            rec = self.read()
            if rec is None:
                rec = {"install_id": str(self.new_id()), "email": None, "answers": {}, "told": {},
                       "identify_done": False}
                self.write(rec)
            return rec

    def link(self, email: str, answers: dict | None = None) -> None:
        """Keeps the yes, this address and, when given, these answers in place
        of the ones kept. The same again changes nothing; whatever differs from
        what PostHog was last told is what the next identify sends."""
        with self.lock:
            rec = self.get()
            answers = rec["answers"] if answers is None else answers
            if rec["email"] != email or rec["answers"] != answers:
                self.write({**rec, "email": email, "answers": answers})

    def mark_told(self, person: dict) -> None:
        """Marks these person properties as told, unless they changed meanwhile."""
        with self.lock:
            rec = self.read()
            if rec is not None and person_of(rec) == person and rec["told"] != person:
                self.write({**rec, "told": dict(person)})

    def unlink(self) -> bool:
        """Forgets the yes, the address, the answers and what PostHog was told
        of them, so a later yes tells it all again. The id stays. False when
        there was nothing to forget."""
        with self.lock:
            rec = self.read()
            if rec is None or (rec["email"] is None and not rec["told"]):
                return False
            self.write({**rec, "email": None, "answers": {}, "told": {}})
            return True


class Sender:
    """Looks once in a while for days that have ended and not been dealt with,
    and sends each used one, once, then the baseline, once per install.
    sharing() is read before every send. tokens() is the token counter's
    tally and installed() the board's first day (YYYY-MM-DD, or None while
    there is none); without tokens no token numbers and no baseline go.
    log(kind, **fields) is the board's own INFO line; every outside call
    (the clock, the network, a fresh id) can be handed in for the tests."""

    def __init__(self, *, transcript: Path, marker: Path, index_html: Path,
                 sharing: Callable[[], bool], log: Callable = lambda *a, **k: None,
                 opener=None, today: Callable[[], dt.date] = dt.date.today,
                 new_id: Callable[[], uuid.UUID] = uuid.uuid4, install_file: Path | None = None,
                 phone_file: Path | None = None, tokens: Callable[[], dict] | None = None,
                 installed: Callable[[], str | None] | None = None,
                 baseline_file: Path | None = None) -> None:
        self.transcript, self.marker, self.index_html = transcript, marker, index_html
        self.sharing, self.log, self.opener, self.today, self.new_id = sharing, log, opener, today, new_id
        self.tokens, self.installed = tokens, installed
        self.install = Install(install_file or marker.with_name("usage-install.json"), new_id)
        self.phone = PhoneUse(phone_file or marker.with_name("usage-phone.json"))
        self.baseline = baseline_file or marker.with_name("usage-baseline.json")
        self.identifying = threading.Lock()   # one identify at a time: a request's and a look's
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

    def _tally(self) -> dict | None:
        """The token counter's tally, or None without one or when it could not
        be read, which a log line says."""
        if self.tokens is None:
            return None
        try:
            tally = self.tokens()
        except Exception as e:   # a counter that fails costs the token numbers, never the day
            self.log("usage", what="tokens", outcome="unread", reason=type(e).__name__)
            return None
        return tally if isinstance(tally, dict) else None

    def _first_day(self) -> dt.date | None:
        """The board's first day, or None while it has none."""
        try:
            got = self.installed() if self.installed is not None else None
            return dt.date.fromisoformat(got) if isinstance(got, str) else None
        except Exception:
            return None

    def identify(self) -> str:
        """Tells PostHog what it has not been told of the saved person: the
        properties that changed since the last identify, in one message, and
        nothing when nothing changed. "sent" when it has been told (now or
        before), "refused" when PostHog turned it down for good, "failed" when
        it could not get through, "off" when the switch is off (nothing leaves),
        and "none" when no email is saved. A failed or switched-off identify is
        kept and goes on a later call. The log line says the outcome and never
        a value or the id."""
        with self.identifying:
            rec = self.install.read()
            if rec is None or rec["email"] is None:
                return "none"
            if rec["identify_done"]:
                return "sent"
            if not self.sharing():
                return "off"
            changed, gone = pending(rec)
            outcome, why = post(identify_payload(rec["install_id"], changed, gone), self.opener)
            if outcome != "failed":
                try:
                    self.install.mark_told(person_of(rec))
                except OSError as e:
                    self.log("usage", what="identify", outcome="unmarked", reason=e.strerror or type(e).__name__)
            self.log("usage", what="identify", outcome=outcome, **({"reason": why} if why else {}))
            return outcome

    def link_person(self, person, yes, wait=True) -> str:
        """The person said yes to being emailed for feedback: keeps the yes, the
        address and the answers that go with it (clean_answers: name, work,
        time_zone) next to the install id, in place of the ones kept, then
        tells PostHog whatever it has not been told. Called again
        with the same, it sends nothing; with an answer changed, only that.
        Without an explicit yes (True itself, nothing that merely counts as
        true) or without an email address, nothing is kept and nothing is
        sent. Returns "no", "bad" or "unsaved" for those and for a file that
        cannot be written, else what identify() answers: "sent", "off" (kept,
        goes when the switch is on), "failed" (kept, goes on a later look) or
        "refused". With wait=False the keeping is the same, PostHog is told
        on a thread of its own (identify_soon) and the answer is "kept"."""
        if yes is not True:
            return "no"
        address = clean_email(person.get("email") if isinstance(person, dict) else None)
        if address is None:
            return "bad"
        return self._link(address, clean_answers(person), wait)

    def link_email(self, email, yes) -> str:
        """link_person with the email alone: the answers already kept stay as
        they are."""
        if yes is not True:
            return "no"
        address = clean_email(email)
        if address is None:
            return "bad"
        return self._link(address, None)

    def _link(self, address: str, answers: dict | None, wait: bool = True) -> str:
        try:
            self.install.link(address, answers)
        except OSError as e:
            self.log("usage", what="identify", outcome="unsaved", reason=e.strerror or type(e).__name__)
            return "unsaved"
        if not wait:
            self.identify_soon()
            return "kept"
        return self.identify()

    def identify_soon(self) -> threading.Thread:
        """identify() on a thread of its own, for a request that must answer
        without waiting on PostHog. It reads the saved person when it runs,
        so it follows the rules identify() does; a throw is written down, as a
        look's is, and the thread is a daemon."""
        def tell():
            try:
                self.identify()
            except Exception as e:
                self.log("usage", what="identify", outcome="error", reason=type(e).__name__)
        thread = threading.Thread(target=tell, name="usage-identify", daemon=True)
        thread.start()
        return thread

    def unlink_email(self) -> str:
        """The person took the yes back: the address and the answers are
        forgotten here, and the daily messages go back to asking PostHog for
        no person profile. Nothing is sent, and what PostHog already holds stays
        there. "forgotten", "none" when nothing was kept, or "unsaved" when the
        file cannot be written."""
        with self.identifying:
            try:
                forgot = self.install.unlink()
            except OSError as e:
                self.log("usage", what="unlink", outcome="unsaved", reason=e.strerror or type(e).__name__)
                return "unsaved"
        if not forgot:
            return "none"
        self.log("usage", what="unlink", outcome="forgotten")
        return "forgotten"

    def send_feedback(self, message, person) -> str:
        """One "feedback sent" message, now, whether or not the daily counts
        switch is on: sending feedback is its own choice. person is the
        profile's name and email, both needed. "sent", "empty" (nothing but
        blanks), "long" (past FEEDBACK_MAX), "noperson" (no name or no email),
        "unsaved" (no install id could be kept), "refused" (PostHog turned it
        down for good) or "failed" (it could not get through; nothing is kept
        to send later, the person is told and presses send again). The log line
        says the outcome and never a word of the message, the name, the email
        or the id."""
        text = clean_feedback(message)
        if text is None:
            return "empty"
        if len(text) > FEEDBACK_MAX:
            return "long"
        name = clean_answers(person).get("name") if isinstance(person, dict) else None
        address = clean_email(person.get("email") if isinstance(person, dict) else None)
        if name is None or address is None:
            return "noperson"
        try:
            rec = self.install.get()
        except OSError as e:
            self.log("usage", what="feedback", outcome="unsaved", reason=e.strerror or type(e).__name__)
            return "unsaved"
        body = feedback_payload(rec["install_id"], text, app_version(self.index_html),
                                {"name": name, "email": address})
        outcome, why = post(body, self.opener)
        self.log("usage", what="feedback", outcome=outcome, **({"reason": why} if why else {}))
        return outcome

    def phone_opened(self, now: float | None = None) -> None:
        """The phone app opened or came back: kept in usage-phone.json for the
        day's counts. Sends nothing; a file that cannot be written is said in
        a log line and the opening goes uncounted."""
        try:
            self.phone.note(time.time() if now is None else now)
        except OSError as e:
            self.log("usage", what="phone", outcome="unsaved", reason=e.strerror or type(e).__name__)

    def look(self) -> bool:
        """One look: a saved email PostHog has not been told goes first, then
        the days, then the baseline. False when a send failed and is to be
        tried again later."""
        told = self.identify()
        days = self._days()
        baseline = self._baseline()
        return days and baseline and told != "failed"

    def _days(self) -> bool:
        yesterday = self.today() - dt.timedelta(days=1)
        if self.through is None:
            self.through = self._read_marker()
        if self.through is None:
            # a board that has never sent starts counting today: no day from
            # before the counts existed is ever sent (those weeks go once, in
            # the baseline), and nothing is sent now
            self._write_marker(yesterday)
            return True
        if self.through >= yesterday:
            return True
        if not self.sharing():
            self._write_marker(yesterday)
            return True
        first = max(self.through + dt.timedelta(days=1), yesterday - dt.timedelta(days=BACKLOG_DAYS - 1))
        days = [first + dt.timedelta(days=n) for n in range((yesterday - first).days + 1)]
        counts = day_counts(days, self.transcript, self.phone.path)
        tally = self._tally()
        spent = token_counts(days, tally) if tally is not None else {}
        first_day = self._first_day()
        version, system = app_version(self.index_html), os_fields()
        for day in days:
            day_tokens = spent.get(day, {})
            if day not in counts and not (day_tokens.get("tokens_claude") or day_tokens.get("tokens_codex")):
                continue   # neither the board nor an agent used: nothing to send, marked with the days after it
            if not self.sharing():
                break
            try:
                rec = self.install.get()
            except OSError as e:
                self.log("usage", outcome="unsaved", reason=e.strerror or type(e).__name__)
                return False   # no id to send under: nothing is sent or marked
            before = self.through
            # marked first, so a board stopped mid-send never sends this day again
            if not self._write_marker(day):
                return False
            fields = {**counts.get(day, NOT_USED), **day_tokens}
            if first_day is not None:
                fields["days_since_install"] = (day - first_day).days
            body = payload(day, fields, version, system, rec["install_id"], rec["email"] is not None)
            outcome, why = post(body, self.opener)
            if outcome == "failed":
                self._write_marker(before)
                self.log("usage", outcome="failed", day=day.isoformat(), reason=why)
                return False
            self.log("usage", outcome=outcome, day=day.isoformat(), **({"reason": why} if why else {}))
        self._write_marker(yesterday)
        return True

    def _mark_baseline(self) -> bool:
        tmp = self.baseline.with_name(self.baseline.name + ".tmp")
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps({"sent": True}) + "\n")
            os.replace(tmp, self.baseline)
        except OSError as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            self.log("usage", what="baseline", outcome="unmarked", reason=e.strerror or type(e).__name__)
            return False
        return True

    def _baseline(self) -> bool:
        """The token_baseline message, once per install: only with the token
        counter, while the switch is on and once the board's first day is
        known; until then it waits, unmarked. usage-baseline.json is written
        before it goes and taken away only when the send fails, so it never
        goes twice; once it is there nothing is read or sent again. False when
        it is to be tried again later."""
        if self.tokens is None or self.baseline.exists() or not self.sharing():
            return True
        first_day = self._first_day()
        tally = self._tally() if first_day is not None else None
        if tally is None or not self.sharing():
            return True
        try:
            rec = self.install.get()
        except OSError as e:
            self.log("usage", what="baseline", outcome="unsaved", reason=e.strerror or type(e).__name__)
            return False
        if not self._mark_baseline():
            return False
        body = payload(first_day, baseline_counts(first_day, tally), app_version(self.index_html), os_fields(),
                       rec["install_id"], rec["email"] is not None, event=BASELINE_EVENT)
        outcome, why = post(body, self.opener)
        if outcome == "failed":
            try:
                self.baseline.unlink()
            except OSError:
                pass
            self.log("usage", what="baseline", outcome="failed", reason=why)
            return False
        self.log("usage", what="baseline", outcome=outcome, **({"reason": why} if why else {}))
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
