"""The daily usage counts (usage_counts.py) and the server's side of them.

  payload   the exact message: its fields, the two privacy flags, the install
            id, the day as noon UTC, and nothing of what the board holds in
            words (texts, titles, project names, paths)
  install   one random id, made the first time a message needs it, saved
            beside the marker, the same on every message and after a restart;
            a missing or broken file makes a new one; an id that cannot be
            saved sends nothing
  counts    what each field is worked out from: transcript rows by kind, the
            reply's agent_kind, the phone's openings, the rough minutes
  once      a day goes once: marked before it is sent, never again after a
            restart, and a board that never sent starts counting on its first day
  email     a yes and an address are saved and told to PostHog once, as the one
            $identify payload below; after it the daily messages are identified;
            without a yes, or without an address, nothing is kept or sent
  person    under the same yes the profile's answers go with the email, once,
            then only what changes ($set, and $unset for one cleared); never on
            a daily message; taking the yes back sends nothing and forgets them
  off       nothing is sent while the switch is off (no day, no identify), nor
            later for a day that ended while it was off; a saved email waits
  offline   a send that cannot get through is quiet, leaves the day unmarked,
            and goes on a later look; a backlog is capped; a refusal is final
  logs      no email address, install id or token in any log line
  tokens    a day's tokens from invented Claude Code and Codex logs, by tool
            and kind and by board share (a lane session that ran the wait
            helper and its subagent, sessions that did not, and a log
            counted before the board kept that answer); days since install;
            a day of tokens alone is sent; no command text kept or sent
  baseline  the weeks before the first day, exactly, once per install and
            never again; it waits for the switch and for a first day, a
            failed send goes later and a refusal is final
  server    the reply row's agent_kind, the usagecounts setting, the thread
            the board starts at boot, and POST /usage/email

Nothing here reaches PostHog or any other machine: every send goes to a fake
opener handed to the sender, and the real urlopen and every HTTPS connection
are replaced with ones that fail the test if they are ever called. The server
is loaded as a module with its log folder in a temporary directory; its own
state is seeded by hand and never written. Every agent log is invented, in a
temporary folder, and no real one is ever read.

    python3 -m unittest tests/test_usage_counts.py
"""

import asyncio
import datetime as dt
import http.client
import importlib.util
import json
import logging
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import tokens  # noqa: E402
import usage_counts as uc  # noqa: E402

DAY = dt.date(2026, 10, 4)           # the day the fixture board was used
BEFORE = DAY - dt.timedelta(days=1)  # one owner message on this day too
AFTER = DAY + dt.timedelta(days=1)   # nothing happened on this day
SECRETS = ("SECRET", "Falcon", "/Users/", "alex", "Untitled plan", "hello agent")
INSTALL = "11111111-1111-4111-8111-111111111111"   # an install id, for the tests that hand one in
EMAIL = "ada.lovelace@example.org"                 # the address the tests give with a yes


def at(day: dt.date, hour: int, minute: int, second: int = 0) -> float:
    return dt.datetime(day.year, day.month, day.day, hour, minute, second).timestamp()


def fixture_rows():
    """A day of the board as transcript.jsonl keeps it, words and paths and
    all, in the order the board writes it."""
    return [
        {"ts": at(BEFORE, 22, 10), "kind": "user", "box": "3", "text": "SECRET late note"},
        {"ts": at(DAY, 10, 0, 30), "kind": "user", "box": "7", "text": "SECRET message about Falcon in /Users/alex/falcon"},
        {"ts": at(DAY, 10, 1), "kind": "create", "box": "7", "text": "Untitled plan for Falcon"},
        {"ts": at(DAY, 10, 2), "kind": "user", "box": "7", "text": "hello agent"},
        {"ts": at(DAY, 10, 2, 30), "kind": "ack", "box": "7", "text": "facilitator confirmed delivery"},
        {"ts": at(DAY, 10, 3), "kind": "agent", "box": "7", "text": "a reply", "agent_kind": "claude"},
        {"ts": at(DAY, 10, 6), "kind": "project", "box": "falcon", "text": "Falcon -> /Users/alex/falcon"},
        {"ts": at(DAY, 10, 7), "kind": "title", "box": "7", "text": "SECRET title the agent set"},
        {"ts": at(DAY, 10, 20), "kind": "note", "box": "7", "text": "progress, not a reply"},
        {"ts": at(DAY, 10, 21), "kind": "agent", "box": "7", "text": "a reply", "agent_kind": "claude"},
        {"ts": at(DAY, 10, 22), "kind": "agent", "box": "8", "text": "a reply", "agent_kind": "codex"},
        {"ts": at(DAY, 10, 23), "kind": "agent", "box": "8", "text": "an older row with no agent_kind"},
        {"ts": at(DAY, 10, 31), "kind": "user", "box": "8", "text": "SECRET again"},
        {"ts": at(DAY, 10, 41), "kind": "create", "box": "8", "text": ""},
        {"ts": at(DAY, 11, 1), "kind": "done", "box": "7", "text": ""},
        {"ts": at(DAY, 11, 2), "kind": "undone", "box": "7", "text": ""},
        {"ts": at(DAY, 11, 3), "kind": "done", "box": "7", "text": ""},
    ]


def phone_record():
    """usage-phone.json as the server keeps it: the phone app opened at 20:01,
    kept as the start of its five-minute stretch, and once the day before
    the first transcript day, which no day asked for here counts."""
    return {"opened": [int(at(DAY, 20, 1) // 300 * 300), int(at(BEFORE - dt.timedelta(days=1), 9, 0))]}


EXPECTED = {
    # 10:00, 10:05 (project), 10:30, 10:40, 11:00 and the phone at 20:00
    "minutes_used": 30,
    "cards_created": 2,
    "cards_closed": 1,
    "projects_created": 1,
    "messages_sent": 3,
    "replies_claude": 2,
    "replies_codex": 1,
    "replies_other": 1,
    "phone_used": True,
}


class Answer:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeNet:
    """Stands in for urlopen: keeps every request and answers as told."""

    def __init__(self, marker=None):
        self.requests, self.marked_during = [], []
        self.fail, self.status, self.marker = None, 200, marker

    def __call__(self, req, timeout=None):
        self.requests.append({"url": req.full_url, "method": req.get_method(), "timeout": timeout,
                              "headers": dict(req.header_items()), "body": json.loads(req.data)})
        if self.marker is not None and self.requests[-1]["body"]["event"] == "daily_usage":
            self.marked_during.append(json.loads(self.marker.read_text())["through"])
        if self.fail is not None:
            raise self.fail
        if self.status >= 400:
            raise urllib.error.HTTPError(req.full_url, self.status, "refused", {}, None)
        return Answer(self.status)

    @property
    def days(self):
        return [r["body"]["timestamp"][:10] for r in self.requests if r["body"]["event"] == "daily_usage"]

    @property
    def events(self):
        return [r["body"]["event"] for r in self.requests]


def no_network(*args, **kwargs):
    raise AssertionError("the test tried to reach the network")


# ---- invented agent logs ----------------------------------------------------
WAIT = 'python3 "$HOME/.agents/skills/facilitator/scripts/onboard.py" wait --owner SECRET-falcon --agent claude'
FIRST = DAY - dt.timedelta(days=10)   # the board's first day, for the tests that hand one in
COMMAND_WORDS = ("onboard", "--owner", "grep", "toolu_", "call_1", "SECRET", "Falcon")


def stamp(day: dt.date, hour: int = 12) -> str:
    """A log line's time: this hour of this local day, in UTC as the agents write it."""
    return dt.datetime(day.year, day.month, day.day, hour).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def claude_line(mid, day, counts, command=None):
    """A Claude Code assistant line, with a Bash call when there is a command."""
    content = [{"type": "text", "text": "SECRET reply about Falcon"}]
    if command is not None:
        content.append({"type": "tool_use", "id": "toolu_" + mid, "name": "Bash", "input": {"command": command}})
    inp, cw, cr, out = counts
    return {"type": "assistant", "timestamp": stamp(day), "cwd": "/Users/alex/falcon",
            "message": {"id": mid, "role": "assistant", "content": content,
                        "usage": {"input_tokens": inp, "cache_creation_input_tokens": cw,
                                  "cache_read_input_tokens": cr, "output_tokens": out}}}


def codex_record(rid, day, inp, cached, out):
    return {"timestamp": stamp(day), "type": "token_usage_record",
            "payload": {"response_id": rid, "usage": {"input_tokens": inp, "cached_input_tokens": cached,
                                                      "output_tokens": out}}}


def codex_call(day, command):
    return {"timestamp": stamp(day), "type": "response_item",
            "payload": {"type": "function_call", "name": "shell", "call_id": "call_1",
                        "arguments": json.dumps({"command": ["bash", "-lc", command], "workdir": "/Users/alex/falcon"})}}


# DAY's tokens in TokenBoard's logs: the lane session [10, 200, 3000, 40] and
# its subagent [5, 100, 1000, 20], the other Claude session [7, 50, 500, 9],
# the log counted before [1, 2, 30, 4]; the Codex lane thread 1000 in, 800 of
# it cached, 30 out, and the other one 400 in, 100 cached, 10 out
EXPECTED_TOKENS = {
    "tokens_claude": 4978,
    "tokens_claude_input": 23,
    "tokens_claude_cache_write": 352,
    "tokens_claude_cache_read": 4530,
    "tokens_claude_output": 73,
    "tokens_codex": 1440,
    "tokens_codex_input": 500,
    "tokens_codex_cache_write": 0,
    "tokens_codex_cache_read": 900,
    "tokens_codex_output": 40,
    "tokens_board": 5405,
    "tokens_board_new": 605,
    "tokens_off_board": 976,
    "tokens_off_board_new": 376,
    "tokens_board_unknown": 37,
    "tokens_board_unknown_new": 7,
}


class Board(unittest.TestCase):
    """A folder with a transcript, a phone record, an index.html and nothing sent."""

    def setUp(self):
        self.guards = [mock.patch("urllib.request.urlopen", no_network),
                       mock.patch.object(http.client.HTTPSConnection, "connect", no_network),
                       mock.patch.object(http.client.HTTPConnection, "connect", no_network)]
        for guard in self.guards:
            guard.start()
        self.dir = Path(tempfile.mkdtemp(prefix="usage-counts-test-"))
        self.transcript = self.dir / "transcript.jsonl"
        self.marker = self.dir / "usage-counts.json"
        self.install = self.dir / "usage-install.json"
        self.made = []   # every install id the sender made, in order
        self.index = self.dir / "index.html"
        self.index.write_text('<span id="npversion">v0.2.259</span>')
        self.write_rows(fixture_rows())
        self.phone = self.dir / "usage-phone.json"
        self.phone.write_text(json.dumps(phone_record()))
        self.today = DAY
        self.on = True
        self.lines = []
        self.net = FakeNet(self.marker)

    def tearDown(self):
        for guard in self.guards:
            guard.stop()

    def write_rows(self, rows, mode="w"):
        with open(self.transcript, mode) as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")

    def new_id(self):
        made = uuid.uuid4()
        self.made.append(str(made))
        return made

    @staticmethod
    def never():
        raise AssertionError("a second id was made")

    def sender(self, **over):
        args = dict(transcript=self.transcript, phone_file=self.phone, marker=self.marker, index_html=self.index,
                    sharing=lambda: self.on, log=lambda kind, **fields: self.lines.append((kind, fields)),
                    opener=self.net, today=lambda: self.today, new_id=self.new_id, install_file=self.install)
        args.update(over)
        return uc.Sender(**args)

    def through(self):
        return json.loads(self.marker.read_text())["through"]

    def saved(self):
        return json.loads(self.install.read_text())

    @staticmethod
    def refuse_writing(path):
        """A stand-in for os.replace that refuses to replace this one file."""
        replace = os.replace

        def refuse(src, dst, *args, **kwargs):
            if str(dst) == str(path):
                raise PermissionError(13, "Permission denied")
            return replace(src, dst, *args, **kwargs)
        return refuse

    def two_used_days(self):
        """DAY and the day after it were used; the marker stands before DAY, and
        it is two days later, so one look sends both."""
        self.write_rows(fixture_rows() + [{"ts": at(AFTER, 9, 0), "kind": "user", "box": "7", "text": "next day"}])
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER + dt.timedelta(days=1)

    def sent_ids(self):
        return [r["body"]["distinct_id"] for r in self.net.requests]


class Payload(Board):
    def test_the_message_is_exactly_these_fields_and_flags(self):
        counts = uc.day_counts([DAY], self.transcript, self.phone)[DAY]
        body = uc.payload(DAY, counts, "v0.2.259", {"os": "macOS", "os_version": "26"}, INSTALL)
        self.assertEqual(body, {
            "api_key": "phc_pmdWA3oMUgUWGLyLkXvDFSzYQgvTotFQyA93BWXTdJ9K",
            "event": "daily_usage",
            "distinct_id": INSTALL,
            "timestamp": "2026-10-04T12:00:00Z",
            "properties": {
                "$process_person_profile": False,
                "$geoip_disable": True,
                **EXPECTED,
                "facilitator_version": "v0.2.259",
                "os": "macOS",
                "os_version": "26",
            },
        })

    def test_after_a_yes_the_message_is_the_same_without_the_no_profile_flag(self):
        counts = uc.day_counts([DAY], self.transcript, self.phone)[DAY]
        system = {"os": "macOS", "os_version": "26"}
        plain = uc.payload(DAY, counts, "v0.2.259", system, INSTALL)
        identified = uc.payload(DAY, counts, "v0.2.259", system, INSTALL, identified=True)
        self.assertNotIn("$process_person_profile", identified["properties"])
        self.assertIs(identified["properties"]["$geoip_disable"], True)
        del plain["properties"]["$process_person_profile"]
        self.assertEqual(identified, plain, "a yes changed something besides the profile flag")

    def test_the_identify_is_exactly_this_and_carries_only_the_email(self):
        self.assertEqual(uc.identify_payload(INSTALL, EMAIL), {
            "api_key": "phc_pmdWA3oMUgUWGLyLkXvDFSzYQgvTotFQyA93BWXTdJ9K",
            "event": "$identify",
            "distinct_id": INSTALL,
            "properties": {
                "$geoip_disable": True,
                "$set": {"email": EMAIL},
            },
        })

    def test_it_goes_to_posthog_us_as_json_with_a_short_timeout(self):
        self.assertEqual(uc.ENDPOINT, "https://us.i.posthog.com/i/v0/e/")
        self.today = DAY
        self.sender().look()
        self.today = AFTER
        self.sender().look()
        [sent] = self.net.requests
        self.assertEqual(sent["url"], "https://us.i.posthog.com/i/v0/e/")
        self.assertEqual(sent["method"], "POST")
        self.assertEqual(sent["headers"].get("Content-type"), "application/json")
        self.assertLessEqual(sent["timeout"], 10)
        self.assertNotIn("Cookie", sent["headers"])

    def test_making_a_payload_keeps_nothing(self):
        counts = uc.day_counts([DAY], self.transcript, self.phone)[DAY]
        uc.payload(DAY, counts, "v0.2.259", uc.os_fields(), INSTALL)
        uc.identify_payload(INSTALL, EMAIL)
        self.assertFalse(self.marker.exists() or self.install.exists(), "a payload kept an id or anything else")

    def test_nothing_the_board_holds_in_words_is_sent(self):
        self.sender().look()
        self.today = AFTER
        self.sender().look()
        [sent] = self.net.requests
        text = json.dumps(sent["body"])
        for word in SECRETS:
            self.assertNotIn(word, text)
        props = sent["body"]["properties"]
        for name in ("$set", "$set_once", "$identify", "$ip", "$anon_distinct_id", "$current_url",
                     "$os", "$os_version", "$lib", "$device_id", "$session_id"):
            self.assertNotIn(name, props)
            self.assertNotIn(name, sent["body"])
        self.assertEqual(set(sent["body"]), {"api_key", "event", "distinct_id", "timestamp", "properties"})
        for name, value in props.items():
            if name in ("facilitator_version", "os", "os_version"):
                self.assertRegex(value, r"^(v\d+\.\d+\.\d+|macOS|\d+|unknown|[A-Za-z]+|)$", name)
            else:
                self.assertIsInstance(value, (bool, int), name)

    def test_the_os_is_its_family_and_major_version_only(self):
        with mock.patch("platform.mac_ver", return_value=("26.0.1", ("", "", ""), "arm64")):
            self.assertEqual(uc.os_fields(), {"os": "macOS", "os_version": "26"})
        self.assertEqual(uc.app_version(self.index), "v0.2.259")
        self.assertEqual(uc.app_version(self.dir / "missing.html"), "unknown")


class Counts(Board):
    def test_each_count_comes_from_the_rows_of_its_own_kind(self):
        counts = uc.day_counts([BEFORE, DAY, AFTER], self.transcript, self.phone)
        self.assertEqual(counts[DAY], EXPECTED)
        self.assertEqual(counts[BEFORE], {**{k: 0 for k in EXPECTED}, "minutes_used": 5, "messages_sent": 1,
                                          "phone_used": False})
        self.assertNotIn(AFTER, counts, "a day nobody used counted as used")

    def test_a_damaged_or_half_written_line_is_passed_over(self):
        with open(self.transcript, "a") as f:
            f.write("not json at all\n")
            f.write('{"ts": "a string", "kind": "user"}\n')
            f.write('{"ts": ' + str(at(DAY, 23, 1)) + ', "kind": "user", "box": "9", "te')
        counts = uc.day_counts([DAY], self.transcript, self.phone)
        self.assertEqual(counts[DAY]["messages_sent"], 3)

    def test_a_long_history_is_read_from_its_end(self):
        old = [{"ts": at(DAY - dt.timedelta(days=400), 9, 0), "kind": "user", "box": "1", "text": "x" * 500}] * 3000
        self.write_rows(old + fixture_rows())
        with mock.patch.object(uc, "READ_CHUNK", 4096):
            seen = []
            real = uc._row
            with mock.patch.object(uc, "_row", lambda line: seen.append(1) or real(line)):
                counts = uc.day_counts([DAY], self.transcript, self.phone)
        self.assertEqual(counts[DAY], EXPECTED)
        self.assertLess(len(seen), 100, "the whole history was read for one day")

    def test_agent_names_become_one_of_three_words(self):
        self.assertEqual(uc.agent_kind("claude"), "claude")
        self.assertEqual(uc.agent_kind("Claude Code"), "claude")
        self.assertEqual(uc.agent_kind("codex-cli"), "codex")
        self.assertEqual(uc.agent_kind("agent"), "other")
        self.assertEqual(uc.agent_kind(None), "other")

    def test_model_names_count_as_their_agent(self):
        for name in ("opus", "Claude-Opus-4", "sonnet 5", "Haiku", "fable"):
            self.assertEqual(uc.agent_kind(name), "claude", name)
        for name in ("gpt-5", "GPT", "astra"):
            self.assertEqual(uc.agent_kind(name), "codex", name)
        self.assertEqual(uc.agent_kind("gemini"), "other")
        self.assertEqual(uc.agent_kind(""), "other")

    def test_a_name_matching_both_lists_is_claude(self):
        self.assertEqual(uc.agent_kind("codex on opus"), "claude")
        self.assertEqual(uc.agent_kind("claude gpt"), "claude")

    def test_a_phone_opening_alone_is_a_used_day(self):
        self.write_rows([])
        counts = uc.day_counts([DAY], self.transcript, self.phone)
        self.assertEqual(counts[DAY], {**{k: 0 for k in EXPECTED}, "minutes_used": 5, "phone_used": True})

    def test_the_phone_record_holds_each_stretch_once_owner_only_and_only_a_week_or_so(self):
        self.phone.unlink()
        board = self.sender()
        board.phone_opened(at(DAY, 20, 1))
        board.phone_opened(at(DAY, 20, 4))                             # the same stretch
        board.phone_opened(at(DAY, 20, 6))
        self.assertEqual(json.loads(self.phone.read_text()),
                         {"opened": [int(at(DAY, 20, 0)), int(at(DAY, 20, 5))]})
        self.assertEqual(self.phone.stat().st_mode & 0o777, 0o600)
        board.phone_opened(at(DAY + dt.timedelta(days=uc.BACKLOG_DAYS + 3), 9, 0))
        self.assertEqual(json.loads(self.phone.read_text()),
                         {"opened": [int(at(DAY + dt.timedelta(days=uc.BACKLOG_DAYS + 3), 9, 0))]},
                         "openings older than any day a look can send were kept")
        counts = uc.day_counts([DAY], self.transcript, self.phone)
        self.assertFalse(counts[DAY]["phone_used"])

    def test_a_broken_or_missing_phone_record_is_no_openings(self):
        self.write_rows([])
        for body in ("not json", '{"opened": "x"}', '{"opened": ["9", true, 1.5]}', "[]"):
            self.phone.write_text(body)
            self.assertEqual(uc.day_counts([DAY], self.transcript, self.phone), {}, body)
        self.phone.unlink()
        self.assertEqual(uc.day_counts([DAY], self.transcript, self.phone), {})

    def test_a_phone_record_that_cannot_be_written_is_said_and_the_opening_goes_uncounted(self):
        board = self.sender()
        with mock.patch("os.replace", self.refuse_writing(self.phone)):
            board.phone_opened(at(DAY, 23, 1))
        self.assertEqual(json.loads(self.phone.read_text()), phone_record())
        self.assertEqual(self.lines, [("usage", {"what": "phone", "outcome": "unsaved", "reason": "Permission denied"})])
        self.assertFalse(self.phone.with_name("usage-phone.json.tmp").exists())


class OncePerDay(Board):
    def test_a_board_that_never_sent_starts_counting_on_its_first_day(self):
        self.today = AFTER
        self.sender().look()
        self.assertEqual(self.net.requests, [], "days from before the counts existed were sent")
        self.assertEqual(self.through(), DAY.isoformat())

    def test_a_used_day_is_sent_once_after_it_ends_and_never_again(self):
        self.sender().look()                       # the first look, on the day itself
        self.assertEqual(self.net.requests, [])
        self.assertEqual(self.through(), BEFORE.isoformat())
        board = self.sender()
        board.look()
        self.assertEqual(self.net.requests, [], "a day was sent before it ended")
        self.today = AFTER
        board.look()
        board.look()
        self.assertEqual(self.net.days, [DAY.isoformat()])
        self.sender().look()                       # the board restarted
        self.assertEqual(self.net.days, [DAY.isoformat()], "a restart sent the day again")
        self.today = AFTER + dt.timedelta(days=1)  # the day after: nobody used AFTER
        self.sender().look()
        self.assertEqual(self.net.days, [DAY.isoformat()])
        self.assertEqual(self.through(), AFTER.isoformat())
        self.assertEqual([fields["outcome"] for kind, fields in self.lines if kind == "usage"], ["sent"])

    def test_the_day_is_marked_before_it_is_sent(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        self.sender().look()
        self.assertEqual(self.net.marked_during, [DAY.isoformat()],
                         "a board stopped mid-send would send this day again")

    def test_the_marker_holds_one_day_and_only_its_owner_reads_it(self):
        self.sender().look()
        self.assertEqual(json.loads(self.marker.read_text()), {"through": BEFORE.isoformat()})
        self.assertEqual(self.marker.stat().st_mode & 0o777, 0o600)

    def test_a_marker_that_cannot_be_written_sends_nothing(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        board = self.sender()
        with mock.patch("os.replace", self.refuse_writing(self.marker)):
            self.assertFalse(board.look())
        self.assertEqual(self.net.requests, [], "a day was sent that could not be marked")


class SwitchedOff(Board):
    def test_nothing_is_sent_while_the_switch_is_off(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        self.on = False
        self.sender().look()
        self.assertEqual(self.net.requests, [])
        self.assertEqual(self.through(), DAY.isoformat())

    def test_a_day_that_ended_while_off_is_never_sent_later(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        self.on = False
        self.sender().look()
        self.on = True
        self.sender().look()
        self.today = AFTER + dt.timedelta(days=3)
        self.sender().look()
        self.assertEqual(self.net.requests, [])

    def test_turning_it_off_between_two_sends_stops_the_second(self):
        rows = fixture_rows() + [{"ts": at(AFTER, 9, 0), "kind": "user", "box": "7", "text": "next day"}]
        self.write_rows(rows)
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER + dt.timedelta(days=1)
        asked = []

        def sharing():
            asked.append(1)
            return len(asked) <= 2       # on for the first look and the first send, then off

        self.sender(sharing=sharing).look()
        self.assertEqual(self.net.days, [DAY.isoformat()])
        self.assertEqual(self.through(), AFTER.isoformat())

    def test_no_identify_leaves_while_the_switch_is_off_and_the_yes_waits(self):
        self.on = False
        board = self.sender()
        self.assertEqual(board.link_email(EMAIL, True), "off")
        self.assertEqual(self.net.requests, [])
        self.assertEqual(self.saved()["email"], EMAIL, "the yes was not kept while the switch was off")
        self.assertFalse(self.saved()["identify_done"])
        self.assertTrue(board.look())
        self.assertTrue(board.look())
        self.assertEqual(self.net.requests, [], "something left with the switch off")
        self.assertEqual(self.lines, [])

    def test_turned_back_on_the_waiting_identify_goes_first_and_the_days_are_identified(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        self.on = False
        board = self.sender()
        board.link_email(EMAIL, True)
        board.look()                          # DAY ended while it was off: never sent
        self.assertEqual(self.net.requests, [])
        self.on = True
        self.write_rows([{"ts": at(AFTER, 9, 0), "kind": "user", "box": "7", "text": "next day"}], "a")
        self.today = AFTER + dt.timedelta(days=1)
        board.look()
        self.assertEqual(self.net.events, ["$identify", "daily_usage"])
        self.assertEqual(self.net.days, [AFTER.isoformat()])
        self.assertEqual(len(set(self.sent_ids())), 1, "the identify and the day were under different ids")
        self.assertNotIn("$process_person_profile", self.net.requests[1]["body"]["properties"])

    def test_a_link_already_told_stays_when_the_switch_goes_off_and_on(self):
        board = self.sender()
        self.assertEqual(board.link_email(EMAIL, True), "sent")
        self.on = False
        self.two_used_days()
        board.look()
        self.assertEqual(self.net.events, ["$identify"], "something left with the switch off")
        self.assertEqual(self.saved()["email"], EMAIL)
        self.on = True
        self.write_rows([{"ts": at(AFTER + dt.timedelta(days=1), 9, 0), "kind": "user", "box": "7", "text": "x"}], "a")
        self.today = AFTER + dt.timedelta(days=2)
        board.look()
        self.assertEqual(self.net.events, ["$identify", "daily_usage"], "the email was told again, or not kept")
        self.assertEqual(len(set(self.sent_ids())), 1)
        self.assertNotIn("$process_person_profile", self.net.requests[1]["body"]["properties"])


class InstallId(Board):
    def test_it_is_made_when_a_message_first_needs_it_and_not_before(self):
        self.sender().look()                   # a board's first look sends nothing
        self.assertFalse(self.install.exists())
        self.assertEqual(self.made, [])
        self.today = AFTER
        self.sender().look()
        self.assertEqual(len(self.made), 1)
        self.assertTrue(self.install.exists())

    def test_every_daily_message_has_the_same_id_even_after_a_restart(self):
        self.two_used_days()
        self.sender().look()
        self.assertEqual(self.net.days, [DAY.isoformat(), AFTER.isoformat()])
        first, second = self.sent_ids()
        self.assertEqual(first, second, "two messages had different ids")
        self.assertEqual(uuid.UUID(first).version, 4)
        self.write_rows([{"ts": at(AFTER + dt.timedelta(days=1), 9, 0), "kind": "user", "box": "7", "text": "x"}], "a")
        self.today = AFTER + dt.timedelta(days=2)
        self.sender().look()                   # the board restarted
        self.assertEqual(self.sent_ids(), [first] * 3)
        self.assertEqual(self.made, [first], "a second id was made")

    def test_it_is_saved_where_only_its_owner_reads_it_and_loaded_again(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        board = self.sender()
        board.look()
        [sent] = self.sent_ids()
        self.assertEqual(self.saved(), {"install_id": sent, "feedback_yes": False, "email": None,
                                        "answers": {}, "told": {}, "identify_done": False})
        self.assertEqual(self.install.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.install.parent, self.marker.parent)
        self.assertEqual(board.install.path, self.install)
        self.assertEqual(uc.Install(self.install, self.never).get()["install_id"], sent)

    def test_by_default_it_sits_beside_the_marker(self):
        board = uc.Sender(transcript=self.transcript, marker=self.marker,
                          index_html=self.index, sharing=lambda: True)
        self.assertEqual(board.install.path, self.marker.with_name("usage-install.json"))
        self.assertEqual(board.phone.path, self.marker.with_name("usage-phone.json"))

    def test_a_good_file_is_used_as_it_is(self):
        old = "22222222-2222-4222-8222-222222222222"
        self.install.write_text(json.dumps({"install_id": old}))
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        self.sender().look()
        self.assertEqual(self.sent_ids(), [old])
        self.assertEqual(self.made, [])

    def test_a_missing_or_broken_file_makes_a_new_id_and_saves_it(self):
        old = "abcdefab-cdef-4abc-8def-abcdefabcdef"
        broken = {
            "missing": None,
            "empty": "",
            "not json": "not json at all",
            "a list": "[]",
            "a string": '"x"',
            "no id": "{}",
            "a number": '{"install_id": 5}',
            "a blocked word": '{"install_id": "null"}',
            "not a uuid": '{"install_id": "abc"}',
            "a uuid of another kind": json.dumps({"install_id": str(uuid.uuid1())}),
            "capitals": json.dumps({"install_id": old.upper()}),
            "not text": b"\xff\xfe\x00",
        }
        for name, content in broken.items():
            with self.subTest(name):
                self.install.unlink(missing_ok=True)
                if isinstance(content, bytes):
                    self.install.write_bytes(content)
                elif content is not None:
                    self.install.write_text(content)
                self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
                self.today, self.made, self.net = AFTER, [], FakeNet(self.marker)
                self.sender().look()
                [sent] = self.sent_ids()
                self.assertEqual(self.made, [sent])
                self.assertNotEqual(sent, old)
                self.assertEqual(self.saved()["install_id"], sent)
                self.assertEqual(uc.Install(self.install, self.never).get()["install_id"], sent,
                                 "the new id was not kept")

    def test_a_file_that_cannot_be_read_makes_a_new_id_and_saves_it(self):
        if os.geteuid() == 0:
            self.skipTest("root reads everything")
        old = "22222222-2222-4222-8222-222222222222"
        self.install.write_text(json.dumps({"install_id": old}))
        self.install.chmod(0)
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        self.sender().look()
        [sent] = self.sent_ids()
        self.assertNotEqual(sent, old)
        self.assertEqual(self.saved()["install_id"], sent)

    def test_an_id_that_cannot_be_saved_sends_nothing_and_marks_nothing(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        board = self.sender()
        with mock.patch("os.replace", self.refuse_writing(self.install)):
            self.assertFalse(board.look(), "a day with no id to send under did not ask to be tried again")
        self.assertEqual(self.net.requests, [])
        self.assertEqual(self.through(), BEFORE.isoformat())
        self.assertEqual(self.lines, [("usage", {"outcome": "unsaved", "reason": "Permission denied"})])
        self.assertFalse(self.install.exists() or self.install.with_name(self.install.name + ".tmp").exists())
        self.assertTrue(board.look())
        self.assertEqual(self.net.days, [DAY.isoformat()])


class EmailLink(Board):
    def test_a_yes_keeps_the_email_beside_the_id_and_tells_posthog_once(self):
        board = self.sender()
        self.assertEqual(board.link_email(EMAIL, True), "sent")
        [sent] = self.net.requests
        [made] = self.made
        self.assertEqual(sent["url"], "https://us.i.posthog.com/i/v0/e/")
        self.assertEqual(sent["method"], "POST")
        self.assertEqual(sent["headers"].get("Content-type"), "application/json")
        self.assertLessEqual(sent["timeout"], 10)
        self.assertEqual(sent["body"], {
            "api_key": "phc_pmdWA3oMUgUWGLyLkXvDFSzYQgvTotFQyA93BWXTdJ9K",
            "event": "$identify",
            "distinct_id": made,
            "properties": {"$geoip_disable": True, "$set": {"email": EMAIL}},
        })
        self.assertEqual(self.saved(), {"install_id": made, "feedback_yes": True, "email": EMAIL,
                                        "answers": {}, "told": {"email": EMAIL}, "identify_done": True})
        self.assertEqual(self.install.stat().st_mode & 0o777, 0o600)
        self.assertEqual(board.link_email(EMAIL, True), "sent")
        self.assertEqual(self.sender().link_email(f"  {EMAIL}  ", True), "sent")
        self.assertEqual(len(self.net.requests), 1, "the same address was told twice")
        self.assertEqual(self.made, [made])

    def test_only_the_email_is_sent_and_never_a_name_or_a_location(self):
        self.sender().link_email(EMAIL, True)
        [sent] = self.net.requests
        self.assertEqual(set(sent["body"]), {"api_key", "event", "distinct_id", "properties"})
        self.assertEqual(set(sent["body"]["properties"]), {"$geoip_disable", "$set"})
        self.assertEqual(sent["body"]["properties"]["$set"], {"email": EMAIL})
        self.assertNotIn("$set_once", sent["body"]["properties"])

    def test_without_an_explicit_yes_nothing_is_kept_or_sent(self):
        board = self.sender()
        for yes in (False, None, "yes", "true", "True", 1, 0, "", [], {}):
            with self.subTest(yes=yes):
                self.assertEqual(board.link_email(EMAIL, yes), "no")
        self.assertEqual(self.net.requests, [])
        self.assertFalse(self.install.exists(), "a no left something on the Mac")

    def test_something_that_is_not_an_address_is_refused(self):
        board = self.sender()
        for email in (None, 5, "", "   ", "ada", "ada@", "@example.org", "ada@example", "a b@example.org",
                      "a@b@example.org", "ada@exam\nple.org", "ada\x00@example.org", ["a@b.co"],
                      {"email": "a@b.co"}, "a" * 250 + "@example.org"):
            with self.subTest(email=email):
                self.assertEqual(board.link_email(email, True), "bad")
        self.assertEqual(self.net.requests, [])
        self.assertFalse(self.install.exists())

    def test_after_a_yes_the_daily_messages_are_identified_under_the_same_id(self):
        self.two_used_days()
        board = self.sender()
        board.link_email(EMAIL, True)
        board.look()
        self.assertEqual(self.net.events, ["$identify", "daily_usage", "daily_usage"])
        self.assertEqual(self.sent_ids(), [self.made[0]] * 3)
        for sent in self.net.requests[1:]:
            props = sent["body"]["properties"]
            self.assertNotIn("$process_person_profile", props)
            self.assertIs(props["$geoip_disable"], True)
            self.assertNotIn("$set", props)
            self.assertNotIn(EMAIL, json.dumps(sent["body"]), "the daily message carries the email")

    def test_without_a_yes_the_daily_messages_stay_anonymous(self):
        self.two_used_days()
        self.sender().look()
        self.assertEqual(self.net.events, ["daily_usage", "daily_usage"])
        for sent in self.net.requests:
            self.assertIs(sent["body"]["properties"]["$process_person_profile"], False)
            self.assertIs(sent["body"]["properties"]["$geoip_disable"], True)

    def test_the_yes_outlives_a_restart(self):
        self.sender().link_email(EMAIL, True)
        self.two_used_days()
        self.sender().look()                   # a new sender, reading the file
        self.assertEqual(self.net.events, ["$identify", "daily_usage", "daily_usage"])
        self.assertEqual(self.made, self.sent_ids()[:1])
        for sent in self.net.requests[1:]:
            self.assertNotIn("$process_person_profile", sent["body"]["properties"])

    def test_another_address_is_told_again_and_replaces_the_first(self):
        board = self.sender()
        board.link_email(EMAIL, True)
        board.link_email("grace@example.com", True)
        self.assertEqual(self.net.events, ["$identify", "$identify"])
        self.assertEqual(self.net.requests[1]["body"]["properties"]["$set"], {"email": "grace@example.com"})
        self.assertEqual(self.saved()["email"], "grace@example.com")
        self.assertEqual(self.sent_ids(), [self.made[0]] * 2)

    def test_an_identify_that_cannot_get_through_is_kept_and_goes_on_a_later_look(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))   # no day is due
        board = self.sender()
        self.net.fail = urllib.error.URLError(OSError(8, "nodename nor servname provided"))
        self.assertEqual(board.link_email(EMAIL, True), "failed")
        self.assertEqual(self.saved()["email"], EMAIL)
        self.assertFalse(self.saved()["identify_done"])
        self.assertFalse(board.look(), "a failed identify did not ask to be tried again")
        self.assertEqual(self.lines, [("usage", {"what": "identify", "outcome": "failed", "reason": "URLError"})] * 2)
        self.net.fail = None
        self.assertTrue(board.look())
        self.assertEqual(self.net.events, ["$identify"] * 3)
        self.assertTrue(self.saved()["identify_done"])
        self.assertTrue(board.look())
        self.assertEqual(len(self.net.requests), 3, "the address was told again once it had got through")

    def test_a_failed_identify_does_not_hold_back_the_days(self):
        self.two_used_days()
        board = self.sender()
        net = self.net

        def identify_down(req, timeout=None):
            if json.loads(req.data)["event"] == "$identify":
                raise TimeoutError("timed out")
            return net(req, timeout)

        board.opener = identify_down
        self.assertEqual(board.link_email(EMAIL, True), "failed")
        self.assertFalse(board.look(), "the failed identify was not asked to be tried again")
        self.assertEqual(net.days, [DAY.isoformat(), AFTER.isoformat()])
        for sent in net.requests:
            if sent["body"]["event"] == "daily_usage":
                self.assertNotIn("$process_person_profile", sent["body"]["properties"])

    def test_a_refusal_is_final(self):
        self.net.status = 401
        board = self.sender()
        self.assertEqual(board.link_email(EMAIL, True), "refused")
        self.assertTrue(self.saved()["identify_done"])
        self.assertTrue(board.look())
        self.assertEqual(len(self.net.requests), 1)
        self.assertEqual(self.lines, [("usage", {"what": "identify", "outcome": "refused", "reason": "401"})])

    def test_a_server_error_is_not_final(self):
        self.net.status = 503
        board = self.sender()
        self.assertEqual(board.link_email(EMAIL, True), "failed")
        self.assertFalse(self.saved()["identify_done"])

    def test_an_email_that_cannot_be_saved_is_not_sent(self):
        board = self.sender()
        board.link_email(EMAIL, True)
        self.net.requests.clear()
        with mock.patch("os.replace", self.refuse_writing(self.install)):
            self.assertEqual(board.link_email("grace@example.com", True), "unsaved")
        self.assertEqual(self.net.requests, [])
        self.assertEqual(self.saved()["email"], EMAIL, "the old file was lost")


PERSON = {"email": EMAIL, "name": "Ada Lovelace", "work": "Notes on the analytical engine, in my words",
          "time_zone": "Europe/London"}


class PersonLink(Board):
    """The profile's answers under the email's yes: told once with it, then only
    what changes, never on a daily message, and nothing after the yes is gone."""

    def sets(self):
        return [r["body"]["properties"] for r in self.net.requests if r["body"]["event"] == "$identify"]

    def test_the_yes_sends_the_email_and_every_answer_once_as_the_persons_properties(self):
        board = self.sender()
        self.assertEqual(board.link_person(PERSON, True), "sent")
        [sent] = self.net.requests
        self.assertEqual(sent["body"], {
            "api_key": uc.TOKEN, "event": "$identify", "distinct_id": self.made[0],
            "properties": {"$geoip_disable": True, "$set": PERSON},
        })
        saved = self.saved()
        self.assertEqual((saved["feedback_yes"], saved["email"], saved["identify_done"]), (True, EMAIL, True))
        self.assertEqual(saved["answers"], {k: v for k, v in PERSON.items() if k != "email"})
        self.assertEqual(saved["told"], PERSON)
        self.assertEqual(board.link_person(dict(PERSON), True), "sent")
        self.assertEqual(self.sender().link_person(PERSON, True), "sent")
        self.assertEqual(len(self.net.requests), 1, "the same person was told twice")

    def test_only_an_answer_that_changed_is_sent_again_and_a_cleared_one_is_unset(self):
        board = self.sender()
        board.link_person(PERSON, True)
        board.link_person({**PERSON, "work": "Teaching"}, True)
        self.assertEqual(self.sets()[1], {"$geoip_disable": True, "$set": {"work": "Teaching"}})
        changed = {k: v for k, v in PERSON.items() if k != "time_zone"}
        board.link_person({**changed, "work": "Teaching"}, True)
        self.assertEqual(self.sets()[2], {"$geoip_disable": True, "$unset": ["time_zone"]})
        board.link_person({**PERSON, "email": "grace@example.com"}, True)
        self.assertEqual(self.sets()[3]["$set"], {"email": "grace@example.com", "work": PERSON["work"],
                                                  "time_zone": "Europe/London"})
        self.assertEqual(self.sent_ids(), [self.made[0]] * 4)

    def test_answers_that_are_not_text_or_too_long_are_left_out_and_unknown_names_never_go(self):
        self.sender().link_person({**PERSON, "name": "", "work": "x" * 2001, "main_agent": "Claude Code",
                                   "time_zone": "Mars\x00Base", "phone": "555 0100"}, True)
        self.assertEqual(self.sets()[0]["$set"], {"email": EMAIL})

    def test_without_the_yes_or_an_address_nothing_is_kept_or_sent(self):
        board = self.sender()
        for yes in (False, None, "yes", 1):
            self.assertEqual(board.link_person(PERSON, yes), "no")
        for person in ({**PERSON, "email": "not an address"}, {k: v for k, v in PERSON.items() if k != "email"},
                       "ada@example.org", None):
            self.assertEqual(board.link_person(person, True), "bad")
        self.assertEqual(self.net.requests, [])
        self.assertFalse(self.install.exists())

    def test_taking_the_yes_back_sends_nothing_and_forgets_the_person_here(self):
        self.two_used_days()
        board = self.sender()
        board.link_person(PERSON, True)
        self.assertEqual(board.unlink_email(), "forgotten")
        self.assertEqual(self.net.events, ["$identify"], "taking the yes back sent something")
        saved = self.saved()
        self.assertEqual((saved["feedback_yes"], saved["email"], saved["answers"], saved["told"]),
                         (False, None, {}, {}))
        self.assertEqual(saved["install_id"], self.made[0], "the id went with the yes")
        board.look()
        self.assertEqual(self.net.events, ["$identify", "daily_usage", "daily_usage"])
        for sent in self.net.requests[1:]:
            self.assertIs(sent["body"]["properties"]["$process_person_profile"], False)
        self.assertEqual(board.unlink_email(), "none")
        self.assertEqual(board.link_person(PERSON, True), "sent")
        self.assertEqual(self.sets()[-1]["$set"], PERSON, "a new yes did not tell it all again")

    def test_the_answers_never_ride_on_a_daily_message_or_in_a_log_line(self):
        self.two_used_days()
        board = self.sender()
        board.link_person(PERSON, True)
        board.look()
        for sent in self.net.requests[1:]:
            body = json.dumps(sent["body"])
            self.assertNotIn("$set", sent["body"]["properties"])
            for value in PERSON.values():
                self.assertNotIn(value, body, "a daily message carries " + value)
        logged = json.dumps(self.lines)
        for value in (*PERSON.values(), self.made[0]):
            self.assertNotIn(value, logged)

    def test_the_switch_off_holds_the_answers_and_a_failure_keeps_them_for_a_later_look(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))   # no day is due
        self.on = False
        board = self.sender()
        self.assertEqual(board.link_person(PERSON, True), "off")
        self.assertEqual(self.net.requests, [])
        self.on = True
        self.net.fail = TimeoutError("timed out")
        self.assertFalse(board.look())
        self.net.fail = None
        self.assertTrue(board.look())
        self.assertEqual(self.sets()[-1]["$set"], PERSON)
        self.assertTrue(self.saved()["identify_done"])

    def test_a_record_from_before_the_answers_counts_its_email_as_told(self):
        self.install.write_text(json.dumps({"install_id": INSTALL, "feedback_yes": True, "email": EMAIL,
                                            "identify_done": True}))
        board = self.sender()
        self.assertEqual(board.identify(), "sent")
        self.assertEqual(self.net.requests, [], "an email already told went again")
        board.link_person(PERSON, True)
        self.assertEqual(self.sets()[0]["$set"], {k: v for k, v in PERSON.items() if k != "email"})

    def test_a_main_agent_kept_from_before_is_neither_sent_nor_unset_nor_kept(self):
        self.install.write_text(json.dumps({
            "install_id": INSTALL, "feedback_yes": True, "email": EMAIL, "identify_done": True,
            "answers": {"name": "Ada Lovelace", "main_agent": "Claude Code"},
            "told": {"email": EMAIL, "name": "Ada Lovelace", "main_agent": "Claude Code"}}))
        board = self.sender()
        self.assertEqual(board.identify(), "sent")
        self.assertEqual(self.net.requests, [], "the old main agent went to PostHog again or was unset")
        self.assertEqual(board.link_person({"email": EMAIL, "name": "Ada Lovelace"}, True), "sent")
        self.assertEqual(self.net.requests, [])
        board.link_person({"email": EMAIL, "name": "Ada Lovelace", "work": "Teaching"}, True)
        self.assertEqual(self.sets(), [{"$geoip_disable": True, "$set": {"work": "Teaching"}}])
        self.assertNotIn("main_agent", json.dumps(self.saved()))


class Logs(Board):
    def test_no_log_line_holds_an_email_an_install_id_or_the_token(self):
        board = self.sender()
        emails = [EMAIL, "b@example.org", "c@example.org", "d@example.org", "e@example.org"]
        board.link_email(emails[0], True)                                    # sent
        self.net.fail = RuntimeError(f"cannot reach {emails[1]} as {INSTALL}")
        board.link_email(emails[1], True)                                    # failed
        self.net.fail, self.net.status = None, 401
        board.link_email(emails[2], True)                                    # refused
        self.net.status, self.on = 200, False
        board.link_email(emails[3], True)                                    # off
        self.on = True
        with mock.patch("os.replace", self.refuse_writing(self.install)):
            board.link_email(emails[4], True)                                # unsaved
        self.two_used_days()
        board.look()                                                         # two days sent
        self.net.status = 503
        self.write_rows([{"ts": at(AFTER + dt.timedelta(days=1), 9, 0), "kind": "user", "box": "7", "text": "x"}], "a")
        self.today = AFTER + dt.timedelta(days=2)
        board.look()                                                         # a day failed
        said = json.dumps(self.lines)
        outcomes = {fields["outcome"] for kind, fields in self.lines if kind == "usage"}
        self.assertTrue({"sent", "failed", "refused", "unsaved"} <= outcomes, outcomes)
        for secret in (*emails, *self.made, INSTALL, uc.TOKEN, "phc_", "@example"):
            self.assertNotIn(secret, said)


class Offline(Board):
    def test_a_send_that_cannot_get_through_is_quiet_and_goes_later(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        self.net.fail = urllib.error.URLError(OSError(8, "nodename nor servname provided"))
        board = self.sender()
        self.assertFalse(board.look(), "a failed send did not ask to be tried again")
        self.assertEqual(self.through(), BEFORE.isoformat(), "a day that never went out was marked as sent")
        self.assertEqual(self.lines, [("usage", {"outcome": "failed", "day": DAY.isoformat(), "reason": "URLError"})])
        self.net.fail = TimeoutError("timed out")
        self.assertFalse(board.look())
        self.net.fail = None
        self.assertTrue(board.look())
        self.assertEqual(self.net.days, [DAY.isoformat()] * 3)
        self.assertEqual(len([r for r in self.net.requests]), 3)
        board.look()
        self.assertEqual(len(self.net.requests), 3, "the day went out twice once it got through")
        self.assertEqual(self.through(), DAY.isoformat())

    def test_a_server_error_is_tried_again_and_a_refusal_is_final(self):
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER
        self.net.status = 503
        self.assertFalse(self.sender().look())
        self.assertEqual(self.through(), BEFORE.isoformat())
        self.net.status = 401
        self.assertTrue(self.sender().look())
        self.assertEqual(self.through(), DAY.isoformat())
        self.sender().look()
        self.assertEqual(len(self.net.requests), 2)
        self.assertEqual(self.lines[-1], ("usage", {"outcome": "refused", "day": DAY.isoformat(), "reason": "401"}))

    def test_a_long_time_offline_sends_at_most_the_last_week(self):
        start = DAY - dt.timedelta(days=29)
        rows = [{"ts": at(start + dt.timedelta(days=n), 9, 0), "kind": "user", "box": "1", "text": "SECRET"}
                for n in range(30)]
        self.write_rows(rows)
        self.marker.write_text(json.dumps({"through": (start - dt.timedelta(days=1)).isoformat()}))
        self.today = AFTER
        self.sender().look()
        self.assertEqual(self.net.days, [(DAY - dt.timedelta(days=n)).isoformat() for n in range(6, -1, -1)])
        self.sender().look()
        self.assertEqual(len(self.net.requests), 7)

    def test_the_thread_survives_a_look_that_throws_and_stops_with_the_board(self):
        stopping = threading.Event()
        board = self.sender()
        looks = []

        def look():
            looks.append(1)
            if len(looks) == 1:
                raise RuntimeError("something unexpected")
            stopping.set()
            return True

        board.look = look
        with mock.patch.multiple(uc, FIRST_LOOK=0, LOOK_EVERY=0, RETRY_AFTER=0):
            runner = threading.Thread(target=board.run, args=(stopping,), daemon=True)
            runner.start()
            runner.join(5)
        self.assertFalse(runner.is_alive())
        self.assertEqual(len(looks), 2)
        self.assertIn(("usage", {"outcome": "error", "reason": "RuntimeError"}), self.lines)


class TokenBoard(Board):
    """The fixture board, and the agents' logs of its day under a home folder
    of its own: a Claude Code lane session that ran the wait helper with one
    subagent, a Claude session that did not, a Codex thread of each kind, and
    a Claude log counted by a board from before the answer was kept and since
    cleared away. The sender gets the token counter's tally over them and the
    board's first day, FIRST."""

    def setUp(self):
        super().setUp()
        self.home = self.dir / "home"
        self.projects = self.home / ".claude" / "projects" / "p"
        self.sessions = self.home / ".codex" / "sessions" / "2026" / "10" / "04"
        self.cache = self.dir / "tokens-cache.json"
        self.baseline = self.dir / "usage-baseline.json"
        self.first_day, self.reads = FIRST.isoformat(), 0
        gone = self.log(self.projects / "gone.jsonl", [claude_line("m0", DAY, [1, 2, 30, 4])])
        self.ledger().tally()
        old = json.loads(self.cache.read_text())
        for rec in old["files"].values():
            del rec["board"]
        self.cache.write_text(json.dumps({**old, "version": 2}))
        gone.unlink()
        self.log(self.projects / "lane.jsonl", [claude_line("m1", DAY, [10, 200, 3000, 40], WAIT)])
        self.log(self.projects / "lane" / "subagents" / "agent-a1.jsonl", [claude_line("m2", DAY, [5, 100, 1000, 20])])
        self.log(self.projects / "solo.jsonl", [claude_line("m3", DAY, [7, 50, 500, 9], "grep -rn SECRET /Users/alex")])
        self.log(self.sessions / "rollout-lane.jsonl", [codex_call(DAY, WAIT.replace("claude", "codex")),
                                                        codex_record("r1", DAY, 1000, 800, 30)])
        self.log(self.sessions / "rollout-solo.jsonl", [codex_record("r2", DAY, 400, 100, 10)])
        self.counter = self.ledger()

    @staticmethod
    def log(path, rows):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
        return path

    def ledger(self):
        return tokens.TokenLedger(tokens.roots(home=self.home, env={}), self.cache)

    def tally(self):
        self.reads += 1
        return self.counter.tally()

    def sender(self, **over):
        over.setdefault("tokens", self.tally)
        over.setdefault("installed", lambda: self.first_day)
        over.setdefault("baseline_file", self.baseline)
        return super().sender(**over)

    def sent(self, event):
        return [r["body"] for r in self.net.requests if r["body"]["event"] == event]

    def after_day(self):
        """The marker before DAY and the day after it: DAY is due."""
        self.marker.write_text(json.dumps({"through": BEFORE.isoformat()}))
        self.today = AFTER

    def no_day_due(self):
        self.marker.write_text(json.dumps({"through": (self.today - dt.timedelta(days=1)).isoformat()}))


class Tokens(TokenBoard):
    def test_the_days_message_carries_its_tokens_by_tool_kind_and_board_share(self):
        self.after_day()
        self.assertTrue(self.sender().look())
        [day] = self.sent("daily_usage")
        self.assertEqual(day["timestamp"], "2026-10-04T12:00:00Z")
        self.assertEqual(day["properties"], {
            "$process_person_profile": False,
            "$geoip_disable": True,
            **EXPECTED,
            **EXPECTED_TOKENS,
            "days_since_install": 10,
            "facilitator_version": "v0.2.259",
            **uc.os_fields(),
        })
        for name, value in day["properties"].items():
            if name.startswith(("tokens_", "days_")):
                self.assertIs(type(value), int, name)
        props = day["properties"]
        self.assertEqual(props["tokens_board"] + props["tokens_off_board"] + props["tokens_board_unknown"],
                         props["tokens_claude"] + props["tokens_codex"], "the shares do not split the same tokens")

    def test_a_day_of_tokens_alone_is_sent_with_zeros_for_the_board_and_a_day_of_neither_is_not(self):
        self.assertEqual(set(uc.NOT_USED), set(EXPECTED))
        self.log(self.projects / "solo.jsonl", [claude_line("m4", AFTER, [3, 0, 60, 7])])
        self.marker.write_text(json.dumps({"through": DAY.isoformat()}))
        self.today = AFTER + dt.timedelta(days=2)
        self.assertTrue(self.sender().look())
        self.assertEqual(self.net.days, [AFTER.isoformat()], "a day nobody and no agent used was sent")
        props = self.sent("daily_usage")[0]["properties"]
        self.assertEqual({k: props[k] for k in EXPECTED}, uc.NOT_USED)
        self.assertEqual((props["tokens_claude"], props["tokens_claude_cache_read"], props["tokens_off_board"],
                          props["tokens_off_board_new"], props["tokens_codex"], props["days_since_install"]),
                         (70, 60, 70, 10, 0, 11))
        self.assertEqual(self.through(), (AFTER + dt.timedelta(days=1)).isoformat())

    def test_a_long_time_away_sends_at_most_the_last_week_of_token_days(self):
        start = AFTER
        self.log(self.projects / "solo.jsonl",
                 [claude_line(f"d{n}", start + dt.timedelta(days=n), [1, 0, 0, 1]) for n in range(12)])
        self.marker.write_text(json.dumps({"through": DAY.isoformat()}))
        self.today = start + dt.timedelta(days=12)
        self.sender().look()
        self.assertEqual(self.net.days, [(start + dt.timedelta(days=n)).isoformat() for n in range(5, 12)])
        self.sender().look()
        self.assertEqual(len(self.sent("daily_usage")), 7)

    def test_with_the_switch_off_nothing_is_sent_and_no_log_is_read(self):
        self.after_day()
        self.on = False
        board = self.sender()
        self.assertTrue(board.look())
        self.assertTrue(board.look())
        self.assertEqual(self.net.requests, [])
        self.assertEqual(self.reads, 0, "the token counter was read with the switch off")
        self.assertFalse(self.baseline.exists())
        self.assertEqual(self.through(), DAY.isoformat())

    def test_no_command_text_or_log_words_are_kept_or_sent(self):
        self.after_day()
        self.sender().look()
        self.assertEqual(self.net.events, ["daily_usage", "token_baseline"])
        said = json.dumps([r["body"] for r in self.net.requests]) + json.dumps(self.lines)
        for word in (*SECRETS, *COMMAND_WORDS, "wait", "/Users/", "m1", "r1"):
            self.assertNotIn(word, said)
        kept = self.cache.read_text()   # its keys are the logs' own paths, by design
        for word in COMMAND_WORDS:
            self.assertNotIn(word, kept)
        self.assertEqual(json.loads(kept)["version"], 3)
        self.assertEqual({rec["board"] for rec in json.loads(kept)["files"].values()}, {True, False, None})

    def test_without_the_counter_no_token_numbers_and_no_baseline_go(self):
        self.after_day()
        Board.sender(self).look()   # a board without tokens.py: no counter, no first day
        self.assertEqual(self.net.events, ["daily_usage"])
        props = self.sent("daily_usage")[0]["properties"]
        self.assertEqual([k for k in props if k.startswith("tokens_") or k == "days_since_install"], [])
        self.assertFalse(self.baseline.exists())

    def test_a_counter_that_cannot_be_read_costs_the_token_numbers_never_the_day(self):
        def broken():
            raise RuntimeError("SECRET /Users/alex/falcon")
        self.after_day()
        self.assertTrue(self.sender(tokens=broken).look())
        self.assertEqual(self.net.events, ["daily_usage"])
        props = self.sent("daily_usage")[0]["properties"]
        self.assertEqual({k: v for k, v in props.items() if k in EXPECTED or k.startswith(("tokens_", "days_"))},
                         {**EXPECTED, "days_since_install": 10})
        self.assertIn(("usage", {"what": "tokens", "outcome": "unread", "reason": "RuntimeError"}), self.lines)
        self.assertNotIn("SECRET", json.dumps(self.lines))
        self.assertFalse(self.baseline.exists(), "a baseline was marked without the counter")
        self.sender().look()
        self.assertEqual(self.net.events, ["daily_usage", "token_baseline"])

    def test_without_a_first_day_the_days_leave_it_out_and_the_baseline_waits(self):
        self.first_day = None
        self.after_day()
        board = self.sender()
        self.assertTrue(board.look())
        self.assertEqual(self.net.events, ["daily_usage"])
        props = self.sent("daily_usage")[0]["properties"]
        self.assertNotIn("days_since_install", props)
        self.assertEqual({k: props[k] for k in EXPECTED_TOKENS}, EXPECTED_TOKENS)
        self.assertFalse(self.baseline.exists())
        self.first_day = FIRST.isoformat()
        self.assertTrue(board.look())
        self.assertEqual(self.net.events, ["daily_usage", "token_baseline"])


class Baseline(TokenBoard):
    def before_first_day(self):
        """Claude Code on each of the 17 days before the first day, Codex on two
        of them, and both on the first day itself, which no week holds."""
        self.log(self.projects / "old.jsonl",
                 [claude_line(f"b{n}", FIRST - dt.timedelta(days=n), [1, 10, 100, 2]) for n in range(0, 18)])
        self.log(self.sessions / "rollout-old.jsonl",
                 [codex_record(f"c{n}", FIRST - dt.timedelta(days=n), 100, 50, 5) for n in (0, 3, 5)])

    def test_the_baseline_is_exactly_this_and_goes_once_per_install(self):
        self.before_first_day()
        self.no_day_due()
        board = self.sender()
        self.assertTrue(board.look())
        [sent] = self.net.requests
        self.assertEqual(sent["body"], {
            "api_key": "phc_pmdWA3oMUgUWGLyLkXvDFSzYQgvTotFQyA93BWXTdJ9K",
            "event": "token_baseline",
            "distinct_id": self.made[0],
            "timestamp": "2026-09-24T12:00:00Z",
            "properties": {
                "$process_person_profile": False,
                "$geoip_disable": True,
                "weeks_before_install": 2,
                "days_of_logs_claude": 17,
                "days_of_logs_codex": 5,
                "tokens_new_week_1": 7 * 13 + 2 * 55,   # all but the cache re-reads
                "active_days_week_1": 7,
                "tokens_new_week_2": 7 * 13,
                "active_days_week_2": 7,
                "facilitator_version": "v0.2.259",
                **uc.os_fields(),
            },
        })
        self.assertEqual(json.loads(self.baseline.read_text()), {"sent": True})
        self.assertEqual(self.baseline.stat().st_mode & 0o777, 0o600)
        self.assertIn(("usage", {"what": "baseline", "outcome": "sent"}), self.lines)
        board.look()
        self.sender().look()                     # the board restarted
        self.after_day()
        self.sender().look()                     # and a day went
        self.assertEqual(self.net.events, ["token_baseline", "daily_usage"], "the baseline went twice")
        self.assertEqual(self.sent_ids(), [self.made[0]] * 2)

    def test_the_baseline_holds_eight_weeks_at_most(self):
        self.log(self.projects / "old.jsonl",
                 [claude_line(f"b{n}", FIRST - dt.timedelta(days=n), [0, 0, 100, 1]) for n in range(1, 100)])
        self.no_day_due()
        self.sender().look()
        props = self.sent("token_baseline")[0]["properties"]
        self.assertEqual((props["weeks_before_install"], props["days_of_logs_claude"], props["days_of_logs_codex"]),
                         (8, 56, 0))
        for week in range(1, 9):
            self.assertEqual((props[f"tokens_new_week_{week}"], props[f"active_days_week_{week}"]), (7, 7))
        self.assertNotIn("tokens_new_week_9", props)

    def test_with_no_logs_before_the_first_day_the_baseline_holds_no_weeks(self):
        self.no_day_due()
        self.sender().look()
        props = self.sent("token_baseline")[0]["properties"]
        self.assertEqual({k: v for k, v in props.items() if not k.startswith(("$", "facilitator", "os"))},
                         {"weeks_before_install": 0, "days_of_logs_claude": 0, "days_of_logs_codex": 0})

    def test_the_baseline_waits_for_the_switch_and_a_failed_send_goes_later(self):
        self.before_first_day()
        self.no_day_due()
        board = self.sender()
        self.on = False
        self.assertTrue(board.look())
        self.assertEqual((self.net.requests, self.reads), ([], 0))
        self.assertFalse(self.baseline.exists())
        self.on = True
        self.net.fail = TimeoutError("timed out")
        self.assertFalse(board.look(), "a failed baseline did not ask to be tried again")
        self.assertFalse(self.baseline.exists(), "a baseline that never went out was marked as sent")
        self.assertIn(("usage", {"what": "baseline", "outcome": "failed", "reason": "TimeoutError"}), self.lines)
        self.net.fail = None
        self.assertTrue(board.look())
        self.assertTrue(board.look())
        self.assertEqual(self.net.events, ["token_baseline"] * 2)
        self.assertEqual(self.net.requests[0]["body"], self.net.requests[1]["body"])

    def test_a_refused_baseline_is_never_sent_again(self):
        self.no_day_due()
        self.net.status = 400
        board = self.sender()
        self.assertTrue(board.look())
        self.assertTrue(board.look())
        self.assertEqual(self.net.events, ["token_baseline"])
        self.assertTrue(self.baseline.exists())
        self.assertIn(("usage", {"what": "baseline", "outcome": "refused", "reason": "400"}), self.lines)

    def test_a_baseline_that_cannot_be_marked_is_not_sent(self):
        self.no_day_due()
        board = self.sender()
        with mock.patch("os.replace", self.refuse_writing(self.baseline)):
            self.assertFalse(board.look())
        self.assertEqual(self.net.requests, [])
        self.assertIn(("usage", {"what": "baseline", "outcome": "unmarked", "reason": "Permission denied"}),
                      self.lines)
        self.assertFalse(self.baseline.with_name("usage-baseline.json.tmp").exists())

    def test_after_a_yes_the_baseline_is_identified_like_the_days(self):
        self.no_day_due()
        board = self.sender()
        board.link_email(EMAIL, True)
        board.look()
        self.assertEqual(self.net.events, ["$identify", "token_baseline"])
        body = self.sent("token_baseline")[0]
        self.assertNotIn("$process_person_profile", body["properties"])
        self.assertNotIn(EMAIL, json.dumps(body))
        self.assertEqual(self.sent_ids(), [self.made[0]] * 2)


def _load_server(log_dir: str):
    os.environ["FACILITATOR_LOG_DIR"] = log_dir
    spec = importlib.util.spec_from_file_location("facilitator_server_usage_test", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._save = lambda: module._state.__setitem__("rev", int(module._state.get("rev", 0)) + 1)
    module._notify = lambda *a, **k: None
    return module


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logs = tempfile.mkdtemp(prefix="usage-counts-server-logs-")
        cls.server = _load_server(cls.logs)

    def setUp(self):
        s = self.server
        self.guards = [mock.patch("urllib.request.urlopen", no_network),
                       mock.patch.object(http.client.HTTPSConnection, "connect", no_network),
                       mock.patch.object(http.client.HTTPConnection, "connect", no_network)]
        for guard in self.guards:
            guard.start()
        self.dir = Path(tempfile.mkdtemp(prefix="usage-counts-route-test-"))
        self.rows = []
        s._log = lambda kind, box, text, log_fields=None, **fields: self.rows.append({"kind": kind, "box": box, **fields})
        s._state.clear()
        s._state.update({"rev": 1, "boxes": [{
            "id": "7", "bucket": "meta", "title": "a card", "owner": "facilitator", "done": False, "docked": False,
            "parked": False, "replies": 0, "seen": 0, "pending": [], "ball": "me", "ts": 1.0, "state": "queued"}],
            "busy": {"facilitator": None}, "claimed": {"facilitator": []}, "inbox": [], "next_reply_id": 1})
        s._settings = {"rev": 0, "values": {}, "spotify": {}}

    def tearDown(self):
        self.server._usage_sender = None
        for guard in self.guards:
            guard.stop()

    def reply_as(self, name):
        self.server._agent_names["facilitator"] = name
        status, _ = self.server._post_reply(self.server._query({"query_string": b"box=7"}), "an answer")
        self.assertEqual(status, 200)
        return self.rows[-1]

    def test_a_reply_row_says_which_agent_wrote_it_in_one_word(self):
        self.assertEqual(self.reply_as("claude")["agent_kind"], "claude")
        self.assertEqual(self.reply_as("codex")["agent_kind"], "codex")
        self.assertEqual(self.reply_as("my-own-agent")["agent_kind"], "other")
        self.assertEqual(self.reply_as(None)["agent_kind"], "other")

    def test_a_reply_by_a_model_name_is_stored_as_its_agent(self):
        self.assertEqual(self.reply_as("opus")["agent_kind"], "claude")
        self.assertEqual(self.reply_as("sonnet")["agent_kind"], "claude")
        self.assertEqual(self.reply_as("gpt")["agent_kind"], "codex")
        self.assertEqual(self.reply_as("astra")["agent_kind"], "codex")

    def test_the_server_and_the_counts_share_one_rule(self):
        for name in ("opus", "Claude Code", "gpt-5", "astra", "codex on opus", "gemini", "", None):
            self.server._agent_names["facilitator"] = name
            self.assertEqual(self.server._agent_kind("facilitator"), uc.agent_kind(name), name)

    def test_the_server_stores_other_when_agent_names_is_missing(self):
        self.server._agent_names["facilitator"] = "opus"
        with mock.patch.dict(sys.modules, {"agent_names": None}):
            self.assertEqual(self.server._agent_kind("facilitator"), "other")

    def test_the_switch_is_a_board_setting_that_is_on_until_set_to_0(self):
        s = self.server
        self.assertTrue(s.SETTINGS_KEY.fullmatch("usagecounts"))
        self.assertTrue(s._usage_sharing())
        s._settings["values"]["usagecounts"] = "0"
        self.assertFalse(s._usage_sharing())
        s._settings["values"]["usagecounts"] = "1"
        self.assertTrue(s._usage_sharing())

    def test_the_board_starts_the_sender_on_a_thread_of_its_own_at_boot(self):
        s = self.server
        started = []

        class Thread:
            def __init__(self, target=None, args=(), name=None, daemon=None):
                started.append({"target": target, "args": args, "name": name, "daemon": daemon})

            def start(self):
                started[-1]["started"] = True

        with mock.patch.object(s.threading, "Thread", Thread):
            s._start_usage_counts()
        [thread] = started
        self.assertTrue(thread["started"] and thread["daemon"])
        self.assertEqual(thread["args"], (s._STOPPING,))
        sender = thread["target"].__self__
        self.assertEqual(sender.marker, s.DATA / "usage-counts.json")
        self.assertEqual(s.DATA, ROOT.parent / "data")
        self.assertEqual(sender.transcript, s.TRANSCRIPT_PATH)
        self.assertEqual(sender.phone.path, s.DATA / "usage-phone.json")
        self.assertIs(sender.sharing, s._usage_sharing)
        self.assertIsNone(sender.opener, "the board's own sender is not on the standard urlopen")
        self.assertIn("_start_usage_counts()", Path(ROOT / "server.py").read_text().split("def main()")[1])
        self.assertIn("usage-counts.json", s.PRIVATE_FILES)
        self.assertIn("/data/", (ROOT.parent / ".gitignore").read_text().split("\n"))
        self.assertIn("/usage-counts.json", (ROOT.parent / ".gitignore").read_text().split("\n"))
        self.assertEqual(sender.install.path, s.DATA / "usage-install.json")
        self.assertIs(s._usage_sender, sender, "the route would not reach the board's own sender")
        for name in ("usage-install.json", "usage-install.json.tmp", "usage-phone.json", "usage-phone.json.tmp"):
            self.assertIn(name, s.PRIVATE_FILES)
            self.assertIn("/" + name, (ROOT.parent / ".gitignore").read_text().split("\n"))
        # the baseline's mark is new, so it has only ever lived in data/
        self.assertEqual(sender.baseline, s.DATA / "usage-baseline.json")
        for name in ("usage-baseline.json", "usage-baseline.json.tmp"):
            self.assertIn(name, s.PRIVATE_FILES)
        # the token numbers are the board's own counter's, and the first day the chart's
        self.assertIs(sender.installed, s._installed_day)
        with mock.patch.object(s, "_ledger") as ledger:
            ledger.return_value.tally.return_value = {"claude": {"2026-10-04": [1, 2, 3, 4]}}
            self.assertEqual(sender.tokens(), {"claude": {"2026-10-04": [1, 2, 3, 4]}})

    def phone_reports(self, reports, client="phone"):
        """One batch to POST /clientlog the way m.html sends it (card-report.js
        reportNotice): the phone page, its kind of window, and the reports."""
        batch = {"page": "phone", "client": client, "window": "0123456789abcdef", "reports": reports}
        return self.server._post_clientlog(self.server._query({"query_string": b""}), json.dumps(batch).encode())

    def board_of_its_own(self, level):
        """The board's own sender, made the way the board makes it at boot, with
        its files in a temporary folder and the log at this level."""
        s, folder = self.server, Path(tempfile.mkdtemp(prefix=f"usage-counts-phone-{level}-"))
        # the token counter over empty folders of its own, never the home folder's logs
        counter = tokens.TokenLedger({"claude": [folder / "claude"], "codex": [folder / "codex"]})
        for name, path in (("TRANSCRIPT_PATH", folder / "transcript.jsonl"),
                           ("USAGE_MARKER", folder / "usage-counts.json"),
                           ("USAGE_INSTALL", folder / "usage-install.json"),
                           ("USAGE_PHONE", folder / "usage-phone.json"),
                           ("USAGE_BASELINE", folder / "usage-baseline.json"),
                           ("_ledger", lambda: counter), ("LOG_LEVEL", level)):
            patch = mock.patch.object(s, name, path, create=True)
            patch.start()
            self.addCleanup(patch.stop)
        with mock.patch.object(s.threading, "Thread", mock.MagicMock()):
            s._start_usage_counts()
        return folder, s._usage_sender

    def test_a_phone_opening_is_counted_at_every_log_level(self):
        # a new install logs errors only (run.config.example.json), and there the
        # client file never gets a notifycheck line; the phone opening must be
        # counted all the same, and a day used only on the phone sent
        for level in ("error", "info"):
            with self.subTest(level=level):
                folder, sender = self.board_of_its_own(level)
                day = dt.date.today()
                status, _ = self.phone_reports([{"kind": "notifycheck", "source": "start", "perm": "granted",
                                                 "reg": True, "sub": "yes"}])
                self.assertEqual(status, 200)
                (folder / "usage-counts.json").write_text(json.dumps({"through": (day - dt.timedelta(days=1)).isoformat()}))
                net = FakeNet()
                sender.opener, sender.today = net, lambda: day + dt.timedelta(days=1)
                self.assertTrue(sender.look())
                self.assertEqual(net.days, [day.isoformat()], "a day used only on the phone was not sent")
                props = net.requests[0]["body"]["properties"]
                self.assertEqual({k: props[k] for k in EXPECTED},
                                 {**{k: 0 for k in EXPECTED}, "minutes_used": 5, "phone_used": True})

    def test_only_a_phone_opening_is_noted_and_nothing_but_its_time(self):
        folder, _ = self.board_of_its_own("error")
        record = folder / "usage-phone.json"
        check = {"kind": "notifycheck", "source": "start", "perm": "default", "reg": True, "sub": "no"}
        self.assertEqual(self.phone_reports([check], client="chrome")[0], 200)   # /m opened in a desktop browser
        self.assertEqual(self.phone_reports([{"kind": "notifylost", "source": "return", "reg": True}])[0], 200)
        self.assertEqual(self.phone_reports([{**check, "perm": "nope"}])[0], 400)  # a batch refused
        self.assertFalse(record.exists(), "something other than the phone app opening was noted")
        self.assertEqual(self.phone_reports([check])[0], 200)
        kept = json.loads(record.read_text())
        self.assertEqual(list(kept), ["opened"])
        [when] = kept["opened"]
        self.assertIs(type(when), int)
        self.assertEqual(when % 300, 0)
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)

    def sender_in_temp(self, net=None, sharing=None):
        """The board's sender, as the route will find it, kept in a temporary folder."""
        s = self.server
        net = net or FakeNet()
        s._usage_sender = uc.Sender(transcript=self.dir / "transcript.jsonl",
                                    marker=self.dir / "usage-counts.json", index_html=self.dir / "index.html",
                                    sharing=sharing or s._usage_sharing, log=s._info, opener=net)
        return net

    def call(self, body, headers=None, port=None):
        """One request to POST /usage/email through the route's own wrapper:
        the body read, the origin judged, the refusal logged."""
        s = self.server
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        head = {"host": f"127.0.0.1:{s.PORT}", "origin": f"http://127.0.0.1:{s.PORT}",
                "content-type": "application/json"}
        head.update(headers or {})
        scope = {"type": "http", "method": "POST", "path": "/usage/email", "query_string": b"",
                 "http_version": "1.1", "scheme": "http", "client": ("127.0.0.1", 50000),
                 "server": ("127.0.0.1", port or s.PORT),
                 "headers": [(k.encode(), v.encode()) for k, v in head.items() if v is not None]}
        sent = []

        async def receive():
            if sent:
                return {"type": "http.disconnect"}
            sent.append(1)
            return {"type": "http.request", "body": raw, "more_body": False}

        [route] = [r for r in s.ROUTES if r.path == "/usage/email"]
        response = asyncio.run(route.endpoint(s.Request(scope, receive)))
        return response.status_code, json.loads(response.body)

    def test_the_email_route_keeps_the_yes_and_tells_posthog(self):
        net = self.sender_in_temp()
        status, answer = self.call({"email": EMAIL, "yes": True})
        self.assertEqual((status, answer), (200, {"ok": True, "sent": True}))
        [sent] = net.requests
        saved = json.loads((self.dir / "usage-install.json").read_text())
        self.assertEqual(sent["body"], uc.identify_payload(saved["install_id"], EMAIL))
        self.assertEqual((saved["feedback_yes"], saved["email"], saved["identify_done"]), (True, EMAIL, True))

    def test_the_email_route_with_the_switch_off_keeps_it_and_sends_nothing(self):
        net = self.sender_in_temp()
        self.server._settings["values"]["usagecounts"] = "0"
        self.assertEqual(self.call({"email": EMAIL, "yes": True}), (200, {"ok": True, "sent": False}))
        self.assertEqual(net.requests, [])
        saved = json.loads((self.dir / "usage-install.json").read_text())
        self.assertEqual((saved["email"], saved["identify_done"]), (EMAIL, False))

    def test_the_email_route_answers_sent_false_when_posthog_cannot_be_reached(self):
        net = self.sender_in_temp()
        net.fail = TimeoutError("timed out")
        self.assertEqual(self.call({"email": EMAIL, "yes": True}), (200, {"ok": True, "sent": False}))

    def test_the_email_route_refuses_what_is_not_a_clear_yes_with_an_address(self):
        net = self.sender_in_temp()
        for body in ({"email": EMAIL, "yes": False}, {"email": EMAIL, "yes": "true"}, {"email": EMAIL, "yes": 1},
                     {"email": EMAIL}, {"yes": True}, {"email": EMAIL, "yes": True, "name": "Ada Lovelace"},
                     {"email": "not an address", "yes": True}, {"email": None, "yes": True}, [EMAIL], EMAIL,
                     b"not json", b""):
            with self.subTest(body=body):
                status, answer = self.call(body)
                self.assertEqual(status, 400)
                self.assertNotIn(EMAIL, json.dumps(answer))
        self.assertEqual(net.requests, [])
        self.assertFalse((self.dir / "usage-install.json").exists())

    def test_the_email_route_answers_a_page_on_this_mac_and_nobody_else(self):
        net = self.sender_in_temp()
        s = self.server
        ask = {"email": EMAIL, "yes": True}
        self.assertEqual(self.call(ask, {"origin": None})[0], 403, "a caller with no origin was let in")
        self.assertEqual(self.call(ask, {"origin": "https://example.com"})[0], 403)
        self.assertEqual(self.call(ask, port=s.BRIDGE_PORT)[0], 404, "the phone's socket was answered")
        self.assertEqual(self.call(ask, {"x-forwarded-for": "100.64.0.9"})[0], 404, "Tailscale Serve was answered")
        self.assertEqual(self.call(ask, {"host": "example.com"})[0], 404)
        self.assertEqual(self.call(ask, {"sec-fetch-site": "cross-site"})[0], 404)
        s._usage_sender = None
        self.assertEqual(self.call(ask)[0], 404, "a board with no sender answered")
        self.assertEqual(net.requests, [])
        self.assertFalse((self.dir / "usage-install.json").exists())

    def test_the_email_route_is_one_capped_post_route_the_phone_gate_refuses(self):
        import bridge_gate
        s = self.server
        routes = [r for r in s.ROUTES if r.path == "/usage/email"]
        self.assertEqual([r.methods for r in routes], [{"POST"}])
        self.assertEqual(s.USAGE_EMAIL_BODY_MAX, 2048)
        self.sender_in_temp()
        self.assertEqual(self.call(b"x" * 3000)[0], 413)
        self.assertIn("/usage/email", bridge_gate.LOCAL_ONLY)
        self.assertIn("POST /usage/email", s.__doc__)

    def test_the_email_is_in_no_server_log_line_or_answer(self):
        s = self.server
        seen, answers = [], []

        class Collect(logging.Handler):
            def emit(self, record):
                seen.append(json.dumps([record.getMessage(), getattr(record, "box", ""),
                                        getattr(record, "fields", None)], default=str))

        collect, level = Collect(), s.LOGGER.level
        s.LOGGER.addHandler(collect)
        s.LOGGER.setLevel(logging.DEBUG)
        try:
            net = self.sender_in_temp()
            answers.append(self.call({"email": EMAIL, "yes": True}))                      # sent
            net.fail = TimeoutError(f"cannot reach {EMAIL}")
            answers.append(self.call({"email": "b@example.org", "yes": True}))            # not reached
            net.fail, net.status = None, 401
            answers.append(self.call({"email": "c@example.org", "yes": True}))            # refused by PostHog
            net.status = 200
            answers.append(self.call({"email": "d@example.org", "yes": False}))           # no yes: a 400 refusal
            answers.append(self.call({"email": "d@example@org", "yes": True}))            # no address: a 400 refusal
            answers.append(self.call({"email": EMAIL, "yes": True}, {"origin": None}))    # no origin: a 403 refusal
            s._settings["values"]["usagecounts"] = "0"
            answers.append(self.call({"email": "e@example.org", "yes": True}))            # switch off
        finally:
            s.LOGGER.removeHandler(collect)
            s.LOGGER.setLevel(level)
        for handler in s.LOGGER.handlers:
            handler.flush()
        written = "".join(p.read_text() for p in Path(self.logs).iterdir() if p.is_file())
        saved = json.loads((self.dir / "usage-install.json").read_text())["install_id"]
        said = json.dumps(seen) + written + json.dumps(answers)
        self.assertTrue(any('"refusal"' in line for line in seen), "no refusal line was logged to look in")
        self.assertTrue(any('"usage"' in line for line in seen), "no usage line was logged to look in")
        for secret in (EMAIL, "b@example.org", "c@example.org", "d@example", "e@example.org", "@example",
                       saved, uc.TOKEN):
            self.assertNotIn(secret, said)


if __name__ == "__main__":
    unittest.main()
