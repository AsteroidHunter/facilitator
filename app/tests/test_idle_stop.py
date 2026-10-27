"""The idle stop (server.py: _active, _idle_tick, _idle_stop, _idle_stop_ended,
_idle_rearm, IDLE_STOP_AFTER, IDLE_STOP_MARK), driven through the board's
own routes with every file in a temporary folder and the stop's process
stood in for, so nothing here starts or stops anything.

TEMPORARY: the three-day timer is a temporary fix for the Chrome-window
version and will not be in the native Mac app; these tests go with it.

  activity  a message, a reply, a card change, an agent taking a card, a
            page reading (the Mac board's and the phone's) and a page's live
            line, opening and staying open, each start the three days again
  quiet     an agent that only listens (its own /state reading and a /wait
            that comes back idle) and the Bin's own daily save do not
  stop      three days with none starts `facilitator stop` once, with the
            from-board mark, after one log line and the marker; a stop that
            fails takes the marker back and starts the three days again; a
            copy of the file that main never ran never stops
  marks     the constant is three days, and the code, the docs and the
            README say what the timer is and that it is temporary

The real stop, on a real board of its own, is idle-stop.test.cjs.

    python3 -m unittest tests/test_idle_stop.py
"""

import asyncio
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
LOGS = Path(tempfile.mkdtemp(prefix="idle-stop-logs-"))
sys.path.insert(0, str(ROOT))


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = str(LOGS)
    spec = importlib.util.spec_from_file_location("facilitator_server_idle", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = _load_server()


def tearDownModule():
    shutil.rmtree(LOGS, True)


PAGE_READ = {"sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
             "user-agent": "Mozilla/5.0 (Macintosh) Chrome/141"}
PAGE_WRITE = {**PAGE_READ, "origin": f"http://127.0.0.1:{S.PORT}"}
CURL = {"user-agent": "curl/8.7.1", "accept": "*/*"}
EVENTS = {**PAGE_READ, "accept": "text/event-stream"}
PHONE = ("127.0.0.1", S.BRIDGE_PORT)
LONG_AGO = 1000.0   # seconds before now the last activity is put, for each test to move


def scope_of(method, path, query="", headers=None, server=None):
    head = {"host": f"127.0.0.1:{S.PORT}", **(headers or {})}
    return {"type": "http", "method": method, "path": path, "query_string": query.encode(),
            "http_version": "1.1", "scheme": "http", "client": ("127.0.0.1", 50000),
            "server": server or ("127.0.0.1", S.PORT), "root_path": "",
            "headers": [(k.encode(), v.encode()) for k, v in head.items()]}


async def ask(app, method, path, query="", body=b"", headers=None, server=None):
    """One request through app: (status, answer)."""
    sent = []
    given = [False]

    async def receive():
        if not given[0]:
            given[0] = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.Event().wait()

    async def send(message):
        sent.append(message)

    await app(scope_of(method, path, query, headers, server), receive, send)
    status = next((m["status"] for m in sent if m["type"] == "http.response.start"), None)
    data = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    try:
        return status, json.loads(data) if data else None
    except ValueError:
        return status, data


class Line:
    """One GET /events held open through app until close()."""

    def __init__(self, app):
        self.lines = []
        self._arrived = asyncio.Event()
        self._gone = asyncio.Event()
        self._given = False
        self.task = asyncio.ensure_future(app(scope_of("GET", "/events", "", EVENTS), self._receive, self._send))

    async def _receive(self):
        if not self._given:
            self._given = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self._gone.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message):
        if message["type"] == "http.response.body" and b"data: " in message.get("body", b""):
            self.lines.append(message["body"])
        self._arrived.set()

    async def first(self):
        await asyncio.wait_for(self._arrived.wait(), 2)
        while not self.lines:
            self._arrived.clear()
            await asyncio.wait_for(self._arrived.wait(), 2)

    async def close(self):
        self._gone.set()
        try:
            await asyncio.wait_for(self.task, 2)
        except asyncio.TimeoutError:
            self.task.cancel()


class FakeProc:
    """The stop's process as the board sees it: wait() answers once let go."""

    def __init__(self, code):
        self.code = code
        self.release = threading.Event()

    def wait(self):
        self.release.wait(5)
        return self.code


class Idle(unittest.TestCase):
    """A board of three cards in a temporary folder, its routes built as the
    board builds them, its idle timer started LONG_AGO, and every process the
    board might start stood in for."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="idle-stop-run-")).resolve()
        self.addCleanup(shutil.rmtree, self.dir, True)
        (self.dir / "seed.json").write_text(json.dumps({"title": "idle", "items": [
            {"id": "m1", "bucket": "meta", "title": "First card", "owner": "facilitator"},
            {"id": "m2", "bucket": "meta", "title": "Second card", "owner": "facilitator"},
            {"id": "m3", "bucket": "meta", "title": "Third card", "owner": "facilitator"},
        ]}))
        self.started = []
        self.proc = FakeProc(1)
        self.addCleanup(self.proc.release.set)

        def popen(argv, **kw):
            self.started.append((list(argv), kw))
            return self.proc

        fake = types.SimpleNamespace(Popen=popen, DEVNULL=subprocess.DEVNULL, PIPE=subprocess.PIPE,
                                     STDOUT=subprocess.STDOUT, run=subprocess.run,
                                     TimeoutExpired=subprocess.TimeoutExpired,
                                     CalledProcessError=subprocess.CalledProcessError)
        self.lines = []
        patches = mock.patch.multiple(
            S, STATE_PATH=self.dir / "state.json", TRANSCRIPT_PATH=self.dir / "transcript.jsonl",
            SEED_PATH=self.dir / "seed.json", MAGIC_DIR=self.dir / "magic-boxes",
            UPLOADS=self.dir / "uploads", OLD_UPLOADS=self.dir / "uploads-old",
            SETTINGS_PATH=self.dir / "settings.json", PROFILE_PATH=self.dir / "profile.json",
            IDLE_STOP_MARK=self.dir / "idle-stop.json", TYPING_HOLD=0.0, subprocess=fake,
            _STOPPING=threading.Event(), _idle_stopping=False,
            _info=lambda kind, *a, **f: self.lines.append(("info", kind, f)),
            _error=lambda kind, *a, **f: self.lines.append(("error", kind, f)))
        patches.start()
        self.addCleanup(patches.stop)
        S._load()
        for ow in S.OWNERS:
            S._waiters[ow] = 0
            S._last_wait[ow] = 0.0
        # this lane's agent has listened before, so a listen saves nothing
        S._state.setdefault("ever_listened", {})["facilitator"] = True
        S._save()
        self.app = S.build_app()
        self.addCleanup(setattr, S, "_LOOP", None)
        self.addCleanup(setattr, S, "_last_active", None)
        self.put_back()

    def put_back(self):
        """The last activity LONG_AGO, and when that was."""
        S._last_active = time.time() - LONG_AGO
        return S._last_active

    def moved(self, before):
        """Whether the three days started again since before was put."""
        return S._last_active is not None and S._last_active > before + LONG_AGO / 2

    def run_(self, coro):
        async def on_the_loop():
            S._LOOP = asyncio.get_running_loop()
            try:
                return await coro
            finally:
                S._LOOP = None
        return asyncio.run(on_the_loop())

    async def page(self, method, path, query="", body=b""):
        return await ask(self.app, method, path, query, body, PAGE_READ if method == "GET" else PAGE_WRITE)

    async def agent(self, method, path, query="", body=b""):
        return await ask(self.app, method, path, query, body, CURL)

    def idle_lines(self):
        return [(level, f) for level, kind, f in self.lines if kind == "idlestop"]


class Activity(Idle):
    def test_a_message_starts_the_three_days_again(self):
        before = self.put_back()
        status, _ = self.run_(self.page("POST", "/send", "box=m1", b"A message for the agent"))
        self.assertEqual(status, 200)
        self.assertTrue(self.moved(before), "a message was not activity")

    def test_an_agent_taking_a_card_starts_the_three_days_again(self):
        self.assertEqual(self.run_(self.page("POST", "/send", "box=m1", b"A message"))[0], 200)
        before = self.put_back()
        status, got = self.run_(self.agent("GET", "/wait", "owner=facilitator&timeout=2&agent=claude"))
        self.assertEqual((status, got.get("box")), (200, "m1"))
        self.assertTrue(self.moved(before), "a claim was not activity")

    def test_a_reply_starts_the_three_days_again(self):
        self.assertEqual(self.run_(self.page("POST", "/send", "box=m1", b"A message"))[0], 200)
        status, got = self.run_(self.agent("GET", "/wait", "owner=facilitator&timeout=2&agent=claude"))
        self.assertEqual(got.get("box"), "m1")
        before = self.put_back()
        status, got = self.run_(self.agent("POST", "/reply", "box=m1", b"Here is the answer"))
        self.assertEqual(status, 200, got)
        self.assertTrue(self.moved(before), "a reply was not activity")

    def test_a_card_change_starts_the_three_days_again(self):
        before = self.put_back()
        status, got = self.run_(self.page("POST", "/title", "box=m2", b"A new name"))
        self.assertEqual(status, 200, got)
        self.assertTrue(self.moved(before), "a card change was not activity")

    def test_the_mac_board_reading_starts_the_three_days_again(self):
        before = self.put_back()
        status, _ = self.run_(self.page("GET", "/state"))
        self.assertEqual(status, 200)
        self.assertTrue(self.moved(before), "the Mac board's reading was not activity")

    def test_the_phone_reading_starts_the_three_days_again(self):
        before = self.put_back()
        status, _ = self.run_(ask(self.app, "GET", "/m/state", "", headers=PAGE_READ, server=PHONE))
        self.assertEqual(status, 200)
        self.assertTrue(self.moved(before), "the phone's reading was not activity")

    def test_a_live_line_opening_and_staying_open_starts_the_three_days_again(self):
        async def go():
            before = self.put_back()
            line = Line(self.app)
            await line.first()
            opened = self.moved(before)
            # with the line still open, three days and more go by: the board
            # clock's look counts the open line and starts no stop
            S._last_active = time.time() - S.IDLE_STOP_AFTER - 60
            S._idle_tick()
            held = S._last_active > time.time() - 60
            await line.close()
            return opened, held
        opened, held = self.run_(go())
        self.assertTrue(opened, "a line opening was not activity")
        self.assertTrue(held, "a line held open was not activity")
        self.assertEqual(self.started, [], "a stop was started with a page's line open")


class Quiet(Idle):
    def test_an_agent_that_only_listens_is_not_activity(self):
        before = self.put_back()
        async def listen():
            # what the agents' listen does, each round: the board's reading
            # with the agent key, then a /wait that comes back with nothing
            reading = await self.agent("GET", "/state")
            waited = await self.agent("GET", "/wait", "owner=facilitator&timeout=0.2&agent=claude")
            unread = await self.agent("GET", "/unread")
            return reading, waited, unread
        for _ in range(3):
            (reading, _), (status, waited), (unread, _) = self.run_(listen())
            self.assertEqual((reading, status, unread), (200, 200, 200))
            self.assertTrue(waited.get("idle"), waited)
        self.assertEqual(S._last_active, before, "an agent only listening was activity")

    def test_the_bins_own_daily_save_is_not_activity(self):
        self.assertEqual(self.run_(self.page("POST", "/bin", "box=m3"))[0], 200)
        with S._lock:
            for entry in S._bin_entries():
                entry["ts"] -= S.BIN_KEEP + 60   # its 30 days are up
            S._save(active=False)
        before = self.put_back()
        stop = threading.Event()
        with mock.patch.object(S, "BIN_CHECK_EVERY", 0.02), mock.patch.object(S, "_STOPPING", stop):
            clock = threading.Thread(target=S._bin_clock, daemon=True)
            clock.start()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and S._bin_entries():
                time.sleep(0.02)
            stop.set()
            clock.join(2)
        self.assertEqual(S._bin_entries(), [], "the Bin's check did not run")
        self.assertEqual(S._last_active, before, "the Bin's own save was activity")


class Stop(Idle):
    def test_a_copy_that_main_never_ran_never_stops(self):
        S._last_active = None
        S._active()
        self.assertIsNone(S._last_active, "activity started a timer main never started")
        S._idle_tick()
        self.assertEqual(self.started, [])
        self.assertFalse(S.IDLE_STOP_MARK.exists())

    def test_less_than_three_days_starts_nothing(self):
        S._last_active = time.time() - S.IDLE_STOP_AFTER + 60
        S._idle_tick()
        self.assertEqual(self.started, [])
        self.assertEqual(self.idle_lines(), [])
        self.assertFalse(S.IDLE_STOP_MARK.exists())

    def test_three_days_unused_starts_facilitator_stop_once_with_the_from_board_mark(self):
        S._last_active = time.time() - S.IDLE_STOP_AFTER - 1
        S._idle_tick()
        S._idle_tick()   # the next pass, while the stop is under way, starts no second one
        self.assertEqual(len(self.started), 1, self.started)
        argv, kw = self.started[0]
        self.assertEqual(argv[1:], [str(S.HERE / "facilitator"), "stop"])
        self.assertEqual(kw["cwd"], str(S.CLONE))
        self.assertEqual(kw["env"].get("FACILITATOR_UPDATE_FROM_BOARD"), "1")
        self.assertTrue(kw["start_new_session"], "the stop would end with the board it stops")
        for stream in ("stdin", "stdout", "stderr"):
            self.assertEqual(kw[stream], subprocess.DEVNULL)
        self.assertEqual(self.idle_lines(), [("info", {"days": 3})])
        mark = json.loads(S.IDLE_STOP_MARK.read_text())
        self.assertEqual(mark["days"], 3)
        self.assertLessEqual(abs(mark["ts"] - time.time()), 5)
        self.assertEqual(S.IDLE_STOP_MARK.stat().st_mode & 0o777, 0o600)
        # the stop reached the board: nothing is put back
        S._STOPPING.set()
        self.proc.release.set()
        time.sleep(0.2)
        self.assertTrue(S.IDLE_STOP_MARK.exists())
        self.assertEqual([level for level, _ in self.idle_lines()], ["info"])

    def test_a_stop_that_fails_takes_the_marker_back_and_starts_the_three_days_again(self):
        S._last_active = time.time() - S.IDLE_STOP_AFTER - 1
        S._idle_tick()
        self.assertTrue(S.IDLE_STOP_MARK.exists())
        self.proc.release.set()   # the stop ends with code 1 and the board still running
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and S._idle_stopping:
            time.sleep(0.02)
        self.assertFalse(S._idle_stopping, "the failed stop was never noticed")
        self.assertFalse(S.IDLE_STOP_MARK.exists(), "a failed stop left its marker for the next run")
        self.assertGreater(S._last_active, time.time() - 60, "the three days did not start again")
        self.assertEqual(self.idle_lines()[-1], ("error", {"outcome": "failed", "code": 1}))
        S._idle_tick()
        self.assertEqual(len(self.started), 1, "the stop was tried again at once")

    def test_a_stop_that_cannot_start_is_written_down_and_the_three_days_start_again(self):
        def refused(argv, **kw):
            raise OSError(1, "Operation not permitted")
        S.subprocess.Popen = refused
        S._last_active = time.time() - S.IDLE_STOP_AFTER - 1
        S._idle_tick()
        self.assertFalse(S._idle_stopping)
        self.assertFalse(S.IDLE_STOP_MARK.exists())
        self.assertGreater(S._last_active, time.time() - 60)
        self.assertEqual(self.idle_lines()[-1],
                         ("error", {"outcome": "notstarted", "reason": "Operation not permitted"}))

    def test_the_board_clock_runs_the_idle_stop(self):
        S._last_active = time.time() - S.IDLE_STOP_AFTER - 1
        stop = threading.Event()
        with mock.patch.object(S, "BOARD_TICK", 0.02), mock.patch.object(S, "_STOPPING", stop):
            clock = threading.Thread(target=S._board_clock, daemon=True)
            clock.start()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not self.started:
                time.sleep(0.02)
            stop.set()
            clock.join(2)
        self.assertEqual(len(self.started), 1, "the board clock did not start the stop")

    def test_a_failing_board_pass_does_not_keep_a_forgotten_board_up(self):
        S._last_active = time.time() - S.IDLE_STOP_AFTER - 1
        stop = threading.Event()

        def broken():
            raise RuntimeError("the sweep broke")

        with mock.patch.object(S, "BOARD_TICK", 0.02), mock.patch.object(S, "_STOPPING", stop), \
                mock.patch.object(S, "_sweep_clocks", broken):
            clock = threading.Thread(target=S._board_clock, daemon=True)
            clock.start()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not self.started:
                time.sleep(0.02)
            stop.set()
            clock.join(2)
        self.assertEqual(len(self.started), 1, "a failing board pass kept the board up")


class Marks(unittest.TestCase):
    SENTENCE = ("The three-day timer is a temporary fix for the Chrome-window version and will not be "
                "in the native Mac app")

    def test_the_timer_is_three_days(self):
        self.assertEqual(S.IDLE_STOP_AFTER, 3 * 86400)
        self.assertEqual(S.IDLE_STOP_MARK, S.DATA / "idle-stop.json")

    def test_the_code_marks_the_timer_as_temporary_and_not_for_the_native_app(self):
        source = (ROOT / "server.py").read_text()
        at = source.index("\nIDLE_STOP_AFTER = ")
        block = source[source.rindex("# ---- the idle stop", 0, at):at].splitlines()[1:]
        words = " ".join(line.removeprefix("#").strip() for line in block)
        self.assertTrue(words.startswith("TEMPORARY. " + self.SENTENCE + "."), words[:200])
        self.assertIn("Do not carry it into the native Mac app (the feat/mac-app-electron branch): there, "
                      "quitting the app is how the board stops", words)

    def test_the_docs_say_the_same_under_stopping_the_board(self):
        install = (ROOT.parent / "docs" / "install.md").read_text()
        section = install.split("## Stopping the board", 1)[1].split("\n## ", 1)[0]
        self.assertIn(self.SENTENCE, section)
        self.assertIn("`The board stopped itself after three days unused.`", section)
        readme = (ROOT.parent / "README.md").read_text()
        run_line = readme.index("`facilitator run`")
        self.assertIn("(to stop the board, run `facilitator stop`; a board left unused for three days "
                      "stops itself)", readme[run_line:run_line + 200])


if __name__ == "__main__":
    unittest.main()
