"""Tokens the local coding agents have spent, per day, read from the logs the
agents already keep on this machine. Nothing here sends anything anywhere, and
only counts leave this module: never a line, a message or a path. The daily
usage counts (usage_counts.py) take a day's counts from here and send them,
and only while the board's "Share daily usage counts" switch is on.

Two tools write the logs read here, one JSON object per line:

  Claude Code  every *.jsonl under ~/.claude/projects, one file per session
               and per subagent. An assistant line carries message.usage and a
               timestamp. One message can be written on several lines, the
               early ones of a subagent's reply with a placeholder output
               count, and a resumed session copies earlier turns into its new
               file, so each message id is counted once, at the largest usage
               any of its lines carries, on the day of the line counted first.
  Codex        every *.jsonl under ~/.codex/sessions and
               ~/.codex/archived_sessions. A token_usage_record line carries
               one model response's usage and is counted once per response id.
               A file with no such records, from an older Codex, is read from
               its token_count events instead: an event's last_token_usage is
               counted when the thread's running total has moved since the
               event before it, so a snapshot repeated while nothing ran is not
               counted twice, and once per running total across all files, so
               a forked thread's file replaying its parent's events adds
               nothing.

Which tokens count. Every model response is split four ways:

  input        fresh input, read at the full price
  cache_write  input written into the prompt cache (Claude Code reports it;
               Codex does not, so it is zero there)
  cache_read   input served from the prompt cache
  output       what the model wrote, its reasoning included

and a day's total is the four added up: every token a response read or wrote.
It is the figure Codex itself calls total_tokens and the one earlier usage
audits on this board reported. The split travels beside it because cache reads
are most of it: each turn reads the whole conversation so far again, so a long
session pays for the same context over and over, and a cost weighted figure
can be made from the four kinds by whoever wants one.

A day is the local calendar day a response was logged on, in this machine's
zone. A day without logs is zero, never a gap, and a folder that does not
exist is only nothing to count.

Board share. Each log file also gets one yes or no: whether its session ran
the board's wait helper, which makes it a session working a board lane. A
Claude Code file says yes when one of its assistant lines runs a command (a
tool_use's command) holding scripts/onboard.py wait, or the older curl call
to /wait?owner=, and a subagent's file under <session>/subagents/ counts with
its session's own file. A Codex file says yes when one of its function calls
runs such a command. Only the yes or no is kept, never the command. Workers a
lane starts as separate command-line runs, not as subagents, never run the
helper and count as no. Each day's tokens are split by it three ways: board
(yes), off_board (no) and board_unknown, the files counted before the board
kept the answer.

The counts are kept in a cache file (tokens-cache.json beside state.json) so a
request never reads gigabytes twice. Per log file it holds the size and stamp
last seen, how far the file has been read, a fingerprint of its first bytes,
what it added to each day, the yes or no above, and short hashes of the ids it
counted, a Claude message's with the day and four counts counted for it, kept
by the one file that carries the most of it. A request stats every file and
reads only what was appended since; a file that shrank or whose first bytes
changed is read again from the start. A file that has gone keeps its counts,
since Claude Code clears old transcripts away on its own and the year would
otherwise lose its early months. The cache holds no log text.

A cache from before the yes or no was kept (version 2) is taken over as it
is, every count in it kept and every file's answer unknown, since starting
over would lose the counts of logs that have since gone. Such a file says yes
as soon as a line read later runs the helper, and gets a full answer when it
is read again from the start; until then its tokens stay board_unknown, never
guessed. A cache of any other version is started over.

Beside the counts the ledger keeps one more thing: the newest plan limits
Codex wrote down. Each token_count event can carry the percent of the 5-hour
and weekly windows used and when they reset; the event with the latest stamp
is kept as a few numbers, and it is what the home page's limits box falls back
on when Codex itself cannot be asked. It is a latest value, not a count.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path

KINDS = ("input", "cache_write", "cache_read", "output")
TOOLS = ("claude", "codex")
SHARES = ("board", "off_board", "board_unknown")
CACHE_VERSION = 3
TAKEN_OVER = (2,)    # older caches kept as they are, their files' board answers unknown
HEAD_BYTES = 512     # the first bytes of a file, fingerprinted to tell a rewrite from an append
TAIL_FILES = 6       # newest Codex files whose ends are searched for limits when none are known
TAIL_BYTES = 1 << 20 # how much of a file's end is searched
# the cheap test a line has to pass before it is parsed: most lines are not
# usage at all, and the tool results in them can be large
WANTED = {
    "claude": (b'"usage"',),
    "codex": (b"token_usage_record", b"token_count"),
}
# the same for a line that may run the board's wait helper, and the command it
# has to hold: the skill's helper (scripts/onboard.py wait, its path quoted or
# not) or the older curl call to the board's /wait route
HELPER_BYTES = (b"onboard.py", b"/wait?owner=")
HELPER = re.compile(r"""onboard\.py["']?\s+wait(?![\w-])|\bcurl\b.*?/wait\?owner=""", re.S)


# ---- where the logs are -----------------------------------------------------

def roots(config: dict | None = None, home: Path | None = None, env=None) -> dict:
    """The folders each tool's logs are read from: the standard places under
    the home folder, moved by CLAUDE_CONFIG_DIR and CODEX_HOME the way the tools
    themselves move them, or run.config.json's token_logs where it names a tool
    ({"claude": path or [paths], "codex": ...}, ~ allowed). An empty list there
    turns that tool off."""
    home = Path(home) if home else Path.home()
    env = os.environ if env is None else env
    if env.get("CLAUDE_CONFIG_DIR"):
        claude = [Path(env["CLAUDE_CONFIG_DIR"]).expanduser() / "projects"]
    else:
        claude = [home / ".claude" / "projects", home / ".config" / "claude" / "projects"]
    codex_home = Path(env["CODEX_HOME"]).expanduser() if env.get("CODEX_HOME") else home / ".codex"
    found = {"claude": claude, "codex": [codex_home / "sessions", codex_home / "archived_sessions"]}
    named = (config or {}).get("token_logs") if isinstance(config, dict) else None
    if isinstance(named, dict):
        for tool in TOOLS:
            paths = named.get(tool)
            if isinstance(paths, str):
                paths = [paths]
            if isinstance(paths, list):
                found[tool] = [Path(os.path.expanduser(p)) for p in paths
                               if isinstance(p, str) and p.strip()]
    return {tool: tuple(Path(os.path.abspath(p)) for p in found[tool]) for tool in TOOLS}


def _log_files(folders) -> list:
    """Every *.jsonl under the folders, deepest included, as (path, stat).
    Symlinked folders are not followed, and a folder that cannot be read is
    skipped rather than failing the rest."""
    out = []
    for top in folders:
        if not top.is_dir():
            continue
        for here, dirs, names in os.walk(top, onerror=lambda error: None):
            dirs.sort()
            for name in sorted(names):
                if not name.endswith(".jsonl"):
                    continue
                path = os.path.join(here, name)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                out.append((path, st))
    return out


# ---- one line at a time -----------------------------------------------------

def _n(value) -> int:
    return int(value) if isinstance(value, (int, float)) and value > 0 else 0


def _fingerprint(tool: str, raw) -> str:
    return hashlib.blake2b(f"{tool}:{raw}".encode(), digest_size=8).hexdigest()


def zone_key() -> str:
    """This machine's zone as the day buckets depend on it: the names and both
    offsets. Counts made under another zone are made again."""
    return f"{time.tzname[0]}|{time.tzname[1]}|{time.timezone}|{time.altzone}"


class _Days:
    """Timestamps to local calendar days. Every zone offset is a whole number of
    minutes, so a UTC stamp's day is remembered by its minute."""

    def __init__(self):
        self.memo = {}

    def __call__(self, stamp) -> str | None:
        if not isinstance(stamp, str):
            return None
        key = stamp[:16] if stamp.endswith("Z") else None
        if key and key in self.memo:
            return self.memo[key]
        try:
            moment = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=datetime.timezone.utc)
        day = moment.astimezone().date().isoformat()
        if key:
            self.memo[key] = day
        return day


def _claude_usage(obj):
    """(id, stamp, counts) for a line carrying one message's usage, else None."""
    message = obj.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    counts = (_n(usage.get("input_tokens")), _n(usage.get("cache_creation_input_tokens")),
              _n(usage.get("cache_read_input_tokens")), _n(usage.get("output_tokens")))
    return message.get("id"), obj.get("timestamp"), counts


def _epoch(stamp) -> float | None:
    if not isinstance(stamp, str):
        return None
    try:
        moment = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment.timestamp()


def _num(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _codex_counts(usage) -> tuple:
    """Codex reports cached input inside input and reasoning inside output, so
    fresh input is what is left of input once the cached part is taken out."""
    whole, cached = _n(usage.get("input_tokens")), _n(usage.get("cached_input_tokens"))
    return (max(whole - cached, 0), 0, cached, _n(usage.get("output_tokens")))


def _commands(call) -> list:
    """The command text a tool call runs: its command or cmd, a list of words
    joined. Codex hands its arguments over as JSON text, read here first."""
    if isinstance(call, str):
        try:
            call = json.loads(call)
        except ValueError:
            return []
    if not isinstance(call, dict):
        return []
    out = []
    for key in ("command", "cmd"):
        got = call.get(key)
        if isinstance(got, list):
            got = " ".join(word for word in got if isinstance(word, str))
        if isinstance(got, str):
            out.append(got)
    return out


def _runs_helper(tool: str, obj: dict) -> bool:
    """Whether the line is the agent running the board's wait helper: a
    tool_use on a Claude Code assistant line, or a Codex function call, whose
    command matches HELPER. Words the agent only wrote or read never count,
    and nothing of the command is kept."""
    if tool == "claude":
        message = obj.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if obj.get("type") != "assistant" or not isinstance(content, list):
            return False
        calls = [part.get("input") for part in content
                 if isinstance(part, dict) and part.get("type") == "tool_use"]
    else:
        payload = obj.get("payload")
        if obj.get("type") != "response_item" or not isinstance(payload, dict):
            return False
        if payload.get("type") == "function_call":
            calls = [payload.get("arguments")]
        elif payload.get("type") == "local_shell_call":
            calls = [payload.get("action")]
        else:
            return False
    return any(HELPER.search(text) for call in calls for text in _commands(call))


def _session_file(path: str) -> str | None:
    """The session's own log for a Claude Code subagent's log, which sits in
    <session>/subagents/ beside <session>.jsonl; None for any other file."""
    folder = os.path.dirname(path)
    if os.path.basename(folder) != "subagents":
        return None
    return os.path.dirname(folder) + ".jsonl"


# ---- the ledger -------------------------------------------------------------

class TokenLedger:
    """Per day token counts over the given folders, kept in cache_path between
    runs (None keeps them in memory only). Safe to call from several threads:
    one refresh runs at a time and the others wait for its answer."""

    def __init__(self, folders: dict, cache_path: Path | None = None):
        self.roots = {tool: tuple(folders.get(tool, ())) for tool in TOOLS}
        self.cache_path = Path(cache_path) if cache_path else None
        self.lock = threading.Lock()
        self.limits = None
        self.searched = False
        self.files = self._load()
        # Codex ids already counted, and for each Claude message id the record
        # of the file that holds what is counted for it (see _message)
        self.seen = set()
        self.claude = {}
        for rec in self.files.values():
            if rec.get("tool") == "claude":
                self.claude.update(dict.fromkeys(rec.get("ids", ()), rec))
            else:
                self.seen.update(rec.get("ids", ()))

    def _load(self) -> dict:
        if not self.cache_path:
            return {}
        try:
            data = json.loads(self.cache_path.read_text())
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict) or data.get("version") not in (CACHE_VERSION, *TAKEN_OVER):
            return {}
        limits = data.get("limits")
        if isinstance(limits, dict) and _num(limits.get("at")) is not None:
            self.limits = limits
        files = data.get("files")
        if not isinstance(files, dict):
            return {}
        if data["version"] != CACHE_VERSION:
            # taken over in place: every count stays, and what was read before
            # the answer was kept cannot say whether it ran the helper
            for rec in files.values():
                if isinstance(rec, dict):
                    rec["board"] = None
        return files

    def _save(self) -> None:
        if not self.cache_path:
            return
        tmp = self.cache_path.with_name(self.cache_path.name + ".tmp")
        try:
            body = {"version": CACHE_VERSION, "files": self.files}
            if self.limits:
                body["limits"] = self.limits
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as out:
                os.fchmod(fd, 0o600)
                out.write(json.dumps(body, separators=(",", ":")))
            os.replace(tmp, self.cache_path)
        except OSError:
            # a cache that cannot be written only costs the next run a rescan
            try:
                tmp.unlink()
            except OSError:
                pass

    def _under(self, path: str, tool: str) -> bool:
        return any(path == str(top) or path.startswith(str(top) + os.sep) for top in self.roots[tool])

    def refresh(self) -> None:
        """Read what each log file has gained since the last refresh."""
        zone = zone_key()
        changed = False
        known = self.limits
        for tool in TOOLS:
            for path, st in _log_files(self.roots[tool]):
                rec = self.files.get(path)
                if (rec and rec.get("tool") == tool and rec.get("size") == st.st_size
                        and rec.get("mtime") == st.st_mtime and rec.get("zone") == zone):
                    continue
                if self._read(path, tool, st, rec, zone):
                    changed = True
        if self.limits is None and not self.searched:
            # a cache made before limits were kept has read every file whole and
            # will not read them again, so the newest files' ends are searched once
            self.searched = True
            self._search_tails()
        if changed or self.limits != known:
            self._save()

    def _search_tails(self) -> None:
        newest = sorted(_log_files(self.roots["codex"]), key=lambda found: found[1].st_mtime)
        for path, st in newest[-TAIL_FILES:]:
            try:
                with open(path, "rb") as f:
                    start = max(st.st_size - TAIL_BYTES, 0)
                    f.seek(start)
                    chunk = f.read(TAIL_BYTES)
            except OSError:
                continue
            lines = chunk.split(b"\n")
            for line in lines[1:] if start else lines:
                if b"token_count" not in line or b"rate_limits" not in line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                payload = obj.get("payload") if isinstance(obj, dict) else None
                if isinstance(payload, dict) and payload.get("type") == "token_count":
                    self._note_limits(obj, payload)

    def _note_limits(self, obj: dict, payload: dict) -> None:
        """Keep the plan limits of the newest token_count event: only numbers,
        and only the account's own bucket, never a model's."""
        got = payload.get("rate_limits")
        if not isinstance(got, dict) or got.get("limit_id") not in (None, "codex"):
            return
        stamp = _epoch(obj.get("timestamp"))
        if stamp is None or (self.limits and stamp < self.limits["at"]):
            return
        record = {"at": stamp}
        for name in ("primary", "secondary"):
            window = got.get(name)
            used = _num(window.get("used_percent")) if isinstance(window, dict) else None
            if used is not None:
                record[name] = {"used_percent": used, "window_minutes": _num(window.get("window_minutes")),
                                "resets_at": _num(window.get("resets_at"))}
        if len(record) > 1:
            self.limits = record

    def _fresh(self, tool: str, zone: str) -> dict:
        rec = {"tool": tool, "size": 0, "mtime": 0, "offset": 0, "head": "", "head_len": 0,
               "zone": zone, "board": False, "days": {}, "ids": {} if tool == "claude" else []}
        if tool == "codex":
            rec.update(records=0, meter_days={}, last=None)
        return rec

    def _forget(self, rec: dict) -> None:
        """Free the ids a record holds, for the file to count them again when
        it is read from the start."""
        if rec.get("tool") == "claude":
            for fp in rec.get("ids", ()):
                self.claude.pop(fp, None)
        else:
            self.seen.difference_update(rec.get("ids", ()))

    def _read(self, path: str, tool: str, st, rec, zone: str) -> bool:
        """Bring one file's record up to date. False when the file could not be
        opened. A read that fails partway keeps what it counted along with the
        place it reached, and leaves the stamp behind so the next refresh
        carries on from there."""
        try:
            with open(path, "rb") as f:
                rec = self._start(f, tool, rec, zone, st.st_size)
                try:
                    f.seek(rec["offset"])
                    self._lines(f, tool, rec)
                    if rec["head_len"] < HEAD_BYTES:
                        f.seek(0)
                        self._head(rec, f.read(HEAD_BYTES))
                finally:
                    self.files[path] = rec
        except OSError:
            return False
        rec["size"], rec["mtime"] = st.st_size, st.st_mtime
        return True

    @staticmethod
    def _head(rec: dict, head: bytes) -> None:
        rec["head_len"] = len(head)
        rec["head"] = hashlib.blake2b(head, digest_size=8).hexdigest()

    def _start(self, f, tool: str, rec, zone: str, size: int) -> dict:
        """The record to carry on from: the one there is, or a fresh one when the
        file is new, was counted under another zone, shrank, or no longer begins
        with the bytes it began with. The bytes are read before anything is let
        go, so a failed read changes nothing."""
        again = (rec is None or rec.get("tool") != tool or rec.get("zone") != zone
                 or size < rec.get("offset", 0))
        if not again and rec.get("head_len"):
            head = f.read(rec["head_len"])
            again = hashlib.blake2b(head, digest_size=8).hexdigest() != rec.get("head")
        if not again:
            return rec
        f.seek(0)
        head = f.read(HEAD_BYTES)
        if rec:
            self._forget(rec)
        rec = self._fresh(tool, zone)
        self._head(rec, head)
        return rec

    def _lines(self, f, tool: str, rec: dict) -> None:
        """Count every whole line from the file's current place, and note a
        yes once a line runs the board's wait helper. A last line with no
        newline yet is still being written and is left for next time."""
        days_of = _Days()
        wanted = WANTED[tool]
        offset = rec["offset"]
        try:
            for line in f:
                if not line.endswith(b"\n"):
                    break
                offset += len(line)
                helper = rec.get("board") is not True and any(w in line for w in HELPER_BYTES)
                if not helper and not any(w in line for w in wanted):
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                if helper and _runs_helper(tool, obj):
                    rec["board"] = True
                if tool == "claude":
                    self._claude(obj, rec, days_of)
                else:
                    self._codex(obj, rec, days_of)
        finally:
            rec["offset"] = offset

    def _add(self, rec: dict, key: str, tool: str, raw_id, day, counts) -> None:
        if day is None or not any(counts):
            return
        if raw_id is not None:
            fp = _fingerprint(tool, raw_id)
            if fp in self.seen:
                return
            self.seen.add(fp)
            rec["ids"].append(fp)
        row = rec[key].setdefault(day, [0, 0, 0, 0])
        for i, value in enumerate(counts):
            row[i] += value

    def _claude(self, obj: dict, rec: dict, days_of) -> None:
        got = _claude_usage(obj)
        if not got:
            return
        mid, stamp, counts = got
        if mid is None:
            self._add(rec, "days", "claude", None, days_of(stamp), counts)
        else:
            self._message(rec, mid, days_of(stamp), counts)

    def _message(self, rec: dict, raw_id, day, counts) -> None:
        """Count a message at the largest of each kind any of its lines carries,
        on the day it was first counted on. A streamed reply repeats its usage
        on every line, the early ones of a subagent's with a placeholder output.
        The counted usage sits in one file's ids and days: a line that carries
        more of any kind than is counted moves the message to its own file's
        record with the larger counts, so a file read again from the start gets
        back what it carried, whichever other files carry the message too."""
        if not any(counts):
            return
        fp = _fingerprint("claude", raw_id)
        owner = self.claude.get(fp)
        if owner is None:
            if day is None:
                return
            counted = [day, *counts]
        else:
            have = owner["ids"][fp]
            counted = [have[0]] + [max(a, b) for a, b in zip(have[1:], counts)]
            if counted == have:
                return
            del owner["ids"][fp]
            row = owner["days"][have[0]]
            for i, value in enumerate(have[1:]):
                row[i] -= value
            if not any(row):
                del owner["days"][have[0]]
        rec["ids"][fp] = counted
        self.claude[fp] = rec
        row = rec["days"].setdefault(counted[0], [0, 0, 0, 0])
        for i, value in enumerate(counted[1:]):
            row[i] += value

    def _codex(self, obj: dict, rec: dict, days_of) -> None:
        kind = obj.get("type")
        payload = obj.get("payload")
        if not isinstance(payload, dict):
            return
        if kind == "token_usage_record":
            usage = payload.get("usage")
            if isinstance(usage, dict):
                rec["records"] += 1
                self._add(rec, "days", "codex", payload.get("response_id"),
                          days_of(obj.get("timestamp")), _codex_counts(usage))
        elif kind == "event_msg" and payload.get("type") == "token_count":
            self._note_limits(obj, payload)
            info = payload.get("info")
            if not isinstance(info, dict):
                return
            last, total = info.get("last_token_usage"), info.get("total_token_usage")
            if not isinstance(last, dict) or not isinstance(total, dict):
                return
            running = json.dumps([_n(total.get(k)) for k in
                                  ("input_tokens", "cached_input_tokens", "output_tokens")])
            if running == rec.get("last"):
                return
            rec["last"] = running
            # a running total names one step of a thread whichever file holds
            # it, so a file moved into the archive, or a forked thread's file
            # replaying its parent's events, is not counted a second time
            self._add(rec, "meter_days", "codex", running,
                      days_of(obj.get("timestamp")), _codex_counts(last))

    def _share(self, path: str, rec: dict) -> str:
        """Which of SHARES a file's tokens go in: board when it, or for a
        Claude subagent its session's own file, ran the helper; board_unknown
        when that cannot be told; off_board otherwise."""
        answers = [rec.get("board")]
        main = _session_file(path) if rec.get("tool") == "claude" else None
        if main is not None and isinstance(self.files.get(main), dict):
            answers.append(self.files[main].get("board"))
        if any(answer is True for answer in answers):
            return "board"
        if any(answer is not False for answer in answers):
            return "board_unknown"
        return "off_board"

    def _tally(self) -> dict:
        """{name: {day: [four kinds]}} for each tool and each of SHARES over
        every file under the current folders, the ones that have since gone
        included. The shares split the same tokens the tools do."""
        out = {name: {} for name in (*TOOLS, *SHARES)}
        for path, rec in self.files.items():
            tool = rec.get("tool")
            if tool not in TOOLS or not self._under(path, tool):
                continue
            days = rec.get("days", {})
            if tool == "codex" and not rec.get("records"):
                days = rec.get("meter_days", {})
            share = self._share(path, rec)
            for day, counts in days.items():
                for name in (tool, share):
                    row = out[name].setdefault(day, [0, 0, 0, 0])
                    for i, value in enumerate(counts[:4]):
                        row[i] += _n(value)
        return out

    def tally(self) -> dict:
        """Every day with a count, by tool and by board share: {"claude": {day:
        [four kinds]}, "codex": ..., "board": ..., "off_board": ...,
        "board_unknown": ...}, days as YYYY-MM-DD and kinds in KINDS order.
        Only counts; what the daily usage counts read."""
        with self.lock:
            self.refresh()
            return self._tally()

    def latest_limits(self) -> dict | None:
        """The plan limits on the newest Codex token_count event seen, as
        {"at": epoch seconds, "primary": {"used_percent", "window_minutes",
        "resets_at"}, "secondary": {...}}, or None when no event carried any."""
        with self.lock:
            self.refresh()
            return self.limits

    def daily(self, days: int = 365, today: datetime.date | None = None) -> dict:
        """The last `days` days ending today, oldest first, every one present.
        Each day carries its total, the four kinds and each tool's share."""
        with self.lock:
            self.refresh()
            tally = self._tally()
        today = today or datetime.date.today()
        rows = []
        kinds = dict.fromkeys(KINDS, 0)
        tools = dict.fromkeys(TOOLS, 0)
        for back in range(days - 1, -1, -1):
            day = (today - datetime.timedelta(days=back)).isoformat()
            row = {"date": day, "total": 0, **dict.fromkeys(KINDS, 0), **dict.fromkeys(TOOLS, 0)}
            for tool in TOOLS:
                counts = tally[tool].get(day)
                if not counts:
                    continue
                for kind, value in zip(KINDS, counts):
                    row[kind] += value
                    kinds[kind] += value
                row[tool] = sum(counts)
                tools[tool] += row[tool]
            row["total"] = row["claude"] + row["codex"]
            rows.append(row)
        return {
            "days": rows,
            "total": sum(tools.values()),
            "kinds": kinds,
            "tools": tools,
            "found": {tool: any(top.is_dir() for top in self.roots[tool]) for tool in TOOLS},
        }
