"""The daily usage counts (usage_counts.py) and the server's side of them.

  payload   the exact message: its fields, the two privacy flags, the install
            id, the day as noon UTC, and nothing of what the board holds in
            words (texts, titles, project names, paths)
  install   one random id, made the first time a message needs it, saved
            beside the marker, the same on every message and after a restart;
            a missing or broken file makes a new one; an id that cannot be
            saved sends nothing
  counts    what each field is worked out from: transcript rows by kind, the
            reply's agent_kind, the phone's notifycheck lines, the rough minutes
  once      a day goes once: marked before it is sent, never again after a
            restart, and a board that never sent starts counting on its first day
  email     a yes and an address are saved and told to PostHog once, as the one
            $identify payload below; after it the daily messages are identified;
            without a yes, or without an address, nothing is kept or sent
  off       nothing is sent while the switch is off (no day, no identify), nor
            later for a day that ended while it was off; a saved email waits
  offline   a send that cannot get through is quiet, leaves the day unmarked,
            and goes on a later look; a backlog is capped; a refusal is final
  logs      no email address, install id or token in any log line
  server    the reply row's agent_kind, the usagecounts setting, the thread
            the board starts at boot, and POST /usage/email

Nothing here reaches PostHog or any other machine: every send goes to a fake
opener handed to the sender, and the real urlopen and every HTTPS connection
are replaced with ones that fail the test if they are ever called. The server
is loaded as a module with its log folder in a temporary directory; its own
state is seeded by hand and never written.

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
import usage_counts as uc  # noqa: E402

DAY = dt.date(2026, 10, 4)           # the day the fixture board was used
BEFORE = DAY - dt.timedelta(days=1)  # one owner message on this day too
AFTER = DAY + dt.timedelta(days=1)   # nothing happened on this day
SECRETS = ("SECRET", "Falcon", "/Users/", "alex", "Untitled plan", "hello agent")
INSTALL = "11111111-1111-4111-8111-111111111111"   # an install id, for the tests that hand one in
EMAIL = "ada.lovelace@example.org"                 # the address the tests give with a yes


def at(day: dt.date, hour: int, minute: int, second: int = 0) -> float:
    return dt.datetime(day.year, day.month, day.day, hour, minute, second).timestamp()


def utc_line(t: float) -> str:
    when = dt.datetime.fromtimestamp(t, dt.timezone.utc)
    return when.strftime("%Y-%m-%dT%H:%M:%S.") + f"{when.microsecond // 1000:03d}Z"


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


def phone_lines():
    """The day's client log: one phone opening counts; a push the phone's
    worker took in the background and the Mac's own phone view do not."""
    return [
        {"ts": utc_line(at(DAY, 20, 1)), "level": "info", "kind": "notifycheck", "page": "phone",
         "client": "phone", "window": "0123456789abcdef", "source": "start", "perm": "granted", "reg": True, "sub": "yes"},
        {"ts": utc_line(at(DAY, 21, 1)), "level": "info", "kind": "pushreceived", "page": "phone",
         "client": "phone", "outcome": "shown"},
        {"ts": utc_line(at(DAY, 22, 1)), "level": "info", "kind": "notifycheck", "page": "phone",
         "client": "chrome", "source": "start", "perm": "default", "reg": True, "sub": "no"},
    ]


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


class Board(unittest.TestCase):
    """A folder with a transcript, a client log, an index.html and nothing sent."""

    def setUp(self):
        self.guards = [mock.patch("urllib.request.urlopen", no_network),
                       mock.patch.object(http.client.HTTPSConnection, "connect", no_network),
                       mock.patch.object(http.client.HTTPConnection, "connect", no_network)]
        for guard in self.guards:
            guard.start()
        self.dir = Path(tempfile.mkdtemp(prefix="usage-counts-test-"))
        self.logs = self.dir / "logs"
        self.logs.mkdir()
        self.transcript = self.dir / "transcript.jsonl"
        self.marker = self.dir / "usage-counts.json"
        self.install = self.dir / "usage-install.json"
        self.made = []   # every install id the sender made, in order
        self.index = self.dir / "index.html"
        self.index.write_text('<span id="npversion">v0.2.259</span>')
        self.write_rows(fixture_rows())
        with open(self.logs / f"client-{DAY:%Y%m%d}.jsonl", "w") as f:
            for line in phone_lines():
                f.write(json.dumps(line) + "\n")
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
        args = dict(transcript=self.transcript, log_dir=self.logs, marker=self.marker, index_html=self.index,
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
        counts = uc.day_counts([DAY], self.transcript, self.logs)[DAY]
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
        counts = uc.day_counts([DAY], self.transcript, self.logs)[DAY]
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
        counts = uc.day_counts([DAY], self.transcript, self.logs)[DAY]
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
        counts = uc.day_counts([BEFORE, DAY, AFTER], self.transcript, self.logs)
        self.assertEqual(counts[DAY], EXPECTED)
        self.assertEqual(counts[BEFORE], {**{k: 0 for k in EXPECTED}, "minutes_used": 5, "messages_sent": 1,
                                          "phone_used": False})
        self.assertNotIn(AFTER, counts, "a day nobody used counted as used")

    def test_a_damaged_or_half_written_line_is_passed_over(self):
        with open(self.transcript, "a") as f:
            f.write("not json at all\n")
            f.write('{"ts": "a string", "kind": "user"}\n')
            f.write('{"ts": ' + str(at(DAY, 23, 1)) + ', "kind": "user", "box": "9", "te')
        counts = uc.day_counts([DAY], self.transcript, self.logs)
        self.assertEqual(counts[DAY]["messages_sent"], 3)

    def test_a_long_history_is_read_from_its_end(self):
        old = [{"ts": at(DAY - dt.timedelta(days=400), 9, 0), "kind": "user", "box": "1", "text": "x" * 500}] * 3000
        self.write_rows(old + fixture_rows())
        with mock.patch.object(uc, "READ_CHUNK", 4096):
            seen = []
            real = uc._row
            with mock.patch.object(uc, "_row", lambda line: seen.append(1) or real(line)):
                counts = uc.day_counts([DAY], self.transcript, self.logs)
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
        counts = uc.day_counts([DAY], self.transcript, self.logs)
        self.assertEqual(counts[DAY], {**{k: 0 for k in EXPECTED}, "minutes_used": 5, "phone_used": True})


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
                                        "identify_done": False})
        self.assertEqual(self.install.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.install.parent, self.marker.parent)
        self.assertEqual(board.install.path, self.install)
        self.assertEqual(uc.Install(self.install, self.never).get()["install_id"], sent)

    def test_by_default_it_sits_beside_the_marker(self):
        board = uc.Sender(transcript=self.transcript, log_dir=self.logs, marker=self.marker,
                          index_html=self.index, sharing=lambda: True)
        self.assertEqual(board.install.path, self.marker.with_name("usage-install.json"))

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
                                        "identify_done": True})
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
        self.assertEqual(sender.marker, s.HERE / "usage-counts.json")
        self.assertEqual(sender.transcript, s.TRANSCRIPT_PATH)
        self.assertEqual(sender.log_dir, s.LOG_DIR)
        self.assertIs(sender.sharing, s._usage_sharing)
        self.assertIsNone(sender.opener, "the board's own sender is not on the standard urlopen")
        self.assertIn("_start_usage_counts()", Path(ROOT / "server.py").read_text().split("def main()")[1])
        self.assertIn("usage-counts.json", s.PRIVATE_FILES)
        self.assertIn("/usage-counts.json", (ROOT / ".gitignore").read_text().split("\n"))
        self.assertEqual(sender.install.path, s.HERE / "usage-install.json")
        self.assertIs(s._usage_sender, sender, "the route would not reach the board's own sender")
        for name in ("usage-install.json", "usage-install.json.tmp"):
            self.assertIn(name, s.PRIVATE_FILES)
            self.assertIn("/" + name, (ROOT / ".gitignore").read_text().split("\n"))

    def sender_in_temp(self, net=None, sharing=None):
        """The board's sender, as the route will find it, kept in a temporary folder."""
        s = self.server
        net = net or FakeNet()
        s._usage_sender = uc.Sender(transcript=self.dir / "transcript.jsonl", log_dir=self.dir,
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
