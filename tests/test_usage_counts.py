"""The daily usage counts (usage_counts.py) and the server's side of them.

  payload   the exact message: its fields, the two privacy flags, a fresh
            random id for every message, the day as noon UTC, and nothing of
            what the board holds in words (texts, titles, project names, paths)
  counts    what each field is worked out from: transcript rows by kind, the
            reply's agent_kind, the phone's notifycheck lines, the rough minutes
  once      a day goes once: marked before it is sent, never again after a
            restart, and a board that never sent starts counting on its first day
  off       nothing is sent while the switch is off, nor later for a day that
            ended while it was off
  offline   a send that cannot get through is quiet, leaves the day unmarked,
            and goes on a later look; a backlog is capped; a refusal is final
  server    the reply row's agent_kind, the usagecounts setting, and the thread
            the board starts at boot

Nothing here reaches PostHog or any other machine: every send goes to a fake
opener handed to the sender, and the real urlopen and every HTTPS connection
are replaced with ones that fail the test if they are ever called. The server
is loaded as a module with its log folder in a temporary directory; its own
state is seeded by hand and never written.

    python3 -m unittest tests/test_usage_counts.py
"""

import datetime as dt
import http.client
import importlib.util
import json
import os
import re
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
        if self.marker is not None:
            self.marked_during.append(json.loads(self.marker.read_text())["through"])
        if self.fail is not None:
            raise self.fail
        if self.status >= 400:
            raise urllib.error.HTTPError(req.full_url, self.status, "refused", {}, None)
        return Answer(self.status)

    @property
    def days(self):
        return [r["body"]["timestamp"][:10] for r in self.requests]


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

    def sender(self, **over):
        args = dict(transcript=self.transcript, log_dir=self.logs, marker=self.marker, index_html=self.index,
                    sharing=lambda: self.on, log=lambda kind, **fields: self.lines.append((kind, fields)),
                    opener=self.net, today=lambda: self.today)
        args.update(over)
        return uc.Sender(**args)

    def through(self):
        return json.loads(self.marker.read_text())["through"]


class Payload(Board):
    def test_the_message_is_exactly_these_fields_and_flags(self):
        ids = iter([uuid.UUID("11111111-1111-4111-8111-111111111111")])
        counts = uc.day_counts([DAY], self.transcript, self.logs)[DAY]
        body = uc.payload(DAY, counts, "v0.2.259", {"os": "macOS", "os_version": "26"}, lambda: next(ids))
        self.assertEqual(body, {
            "api_key": "phc_pmdWA3oMUgUWGLyLkXvDFSzYQgvTotFQyA93BWXTdJ9K",
            "event": "daily_usage",
            "distinct_id": "11111111-1111-4111-8111-111111111111",
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

    def test_every_message_has_a_fresh_random_id(self):
        counts = uc.day_counts([DAY], self.transcript, self.logs)[DAY]
        system = uc.os_fields()
        ids = {uc.payload(DAY, counts, "v0.2.259", system)["distinct_id"] for _ in range(50)}
        self.assertEqual(len(ids), 50, "two messages shared an id")
        for value in ids:
            self.assertEqual(uuid.UUID(value).version, 4)
        self.assertFalse(self.marker.exists(), "an id or anything else was kept to make a payload")

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
        with mock.patch("os.replace", side_effect=PermissionError(13, "Permission denied")):
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
        self.rows = []
        s._log = lambda kind, box, text, log_fields=None, **fields: self.rows.append({"kind": kind, "box": box, **fields})
        s._state.clear()
        s._state.update({"rev": 1, "boxes": [{
            "id": "7", "bucket": "meta", "title": "a card", "owner": "facilitator", "done": False, "docked": False,
            "parked": False, "replies": 0, "seen": 0, "pending": [], "ball": "me", "ts": 1.0, "state": "queued"}],
            "busy": {"facilitator": None}, "claimed": {"facilitator": []}, "inbox": [], "next_reply_id": 1})
        s._settings = {"rev": 0, "values": {}, "spotify": {}}

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


class Readme(unittest.TestCase):
    def test_the_readme_lists_every_field_sent(self):
        text = (ROOT / "README.md").read_text()
        section = text.split("## Usage counts", 1)[1].split("\n## ", 1)[0]
        listed = set(re.findall(r"^\| `([^`]+)` \|", section, re.M))
        body = uc.payload(DAY, EXPECTED, "v0.2.259", {"os": "macOS", "os_version": "26"})
        sent = (set(body) - {"properties"}) | set(body["properties"])
        self.assertEqual(listed, sent)
        for words in ("Share daily usage counts", "Improvements", "PostHog", "public", "send"):
            self.assertIn(words, section)


if __name__ == "__main__":
    unittest.main()
