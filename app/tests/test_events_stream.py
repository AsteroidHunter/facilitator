"""The pages' live line (GET /events) and the board clock behind it
(server.py: _save's ring, _board_tick, _board_clock, _quiet_fields,
_quiet_mark, EventsRoute), driven through the board's own application, and
through the same layers a real board puts in front of it (_make_server:
ServeHold, SiteGuard, BoardLock, the phone's gate), with every file it writes
in a temporary folder.

  rings     a claim, an ack and a widget's save each ring: the version
            moves and an open line sends the new revision
  clock     the 90 second hand-off and the 10 minute green expiry happen
            with nothing reading the board, the mark rings with no save, and
            a pass that fails is written down once and the clock goes on
  fields    every key of the board's reading (/state) and the phone's
            (/m/state), and of each card in them, is listed as saved, swept,
            marked, clock, run or frame; a key nobody listed fails. The mark
            holds exactly the marked fields, as the readings carry them, and
            each of them moves it
  line      the first line, a ring within 100 ms, the beat (patched shorter),
            the end on the stop within 0.5 s, the end after its life, 503
            past its slots, HEAD
  locks     on the board's port, 401 without the key or the window cookie;
            through the phone's door, 401 without a sign-in on the phone's
            port and for a Serve-marked request; a signed-in line ends
            within one beat of the sign-out and never counts as a use of
            the sign-in; the agent door does not let it through

    python3 -m unittest tests/test_events_stream.py
"""

import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
LOGS = Path(tempfile.mkdtemp(prefix="events-stream-logs-"))
sys.path.insert(0, str(ROOT))
import bridge_auth  # noqa: E402
from bridge_gate import BridgeGate  # noqa: E402


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = str(LOGS)
    spec = importlib.util.spec_from_file_location("facilitator_server_events", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = _load_server()
PASS = "Fixture-Bridge-7"
PAGE_READ = {"sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
             "user-agent": "Mozilla/5.0 (Macintosh) Chrome/141"}
PAGE_WRITE = {**PAGE_READ, "origin": f"http://127.0.0.1:{S.PORT}"}
CURL = {"user-agent": "curl/8.7.1", "accept": "*/*"}
EVENTS = {**PAGE_READ, "accept": "text/event-stream"}
PHONE = ("127.0.0.1", S.BRIDGE_PORT)
WIDGET_PAGE = b"<!doctype html><p>a widget</p><script>facilitator.ready()</script>"

# every key the two readings carry, by why a page holding the line can never
# miss it moving:
#   saved   moves only with a save, which moves the revision and rings
#   swept   worked out from the time, and kept in step by the board clock's
#           own save within a tick (bg: a flag whose lane went quiet comes down)
#   marked  moves with no save; the board clock's mark holds it (_quiet_fields)
#   clock   moves every second; the page works it out from the time
#   run     fixed for the life of one run; a restart ends every line, and a
#           page reads on every open
#   frame   the lean reading's own framing, worked out from the revision the
#           page names
DESK = {
    "saved": {"boxes", "rev", "pwds", "projects", "busy", "queued", "title", "tabs", "everListened",
              "workspaces", "pages", "quicknotes"},
    "marked": {"settingsRev", "remote", "phoneOff", "listening", "agents", "onboarding", "update"},
    "clock": {"now", "listenerGap"},
    "run": {"pwd", "imagePanelLane", "spotifyClientId", "navigatorLanes"},
    "frame": {"epoch", "delta", "count", "gone", "after", "ids", "keys", "set"},
}
DESK_CARD = {
    "saved": {"id", "bucket", "title", "reply", "replyFull", "replyShort", "done", "replies", "olderReplies",
              "ball", "docked", "parked", "dockedTs", "parkedTs", "doneTs", "ts", "context", "owner", "pending",
              "pendingTexts", "pendingStamps", "pendingBy", "pendingStates", "notedTexts", "ws", "task",
              "worktree", "agentTs", "agent", "replyKind", "replyId", "replyTs", "answered", "seen", "turnTs",
              "engine", "writing", "state", "testing", "queuePos", "magic"},
    "swept": {"bg"},
}
PHONE_READING = {
    "saved": {"rev", "title", "tabs", "pwds", "projects", "boxes", "ops"},
    "marked": {"version", "live"},
    "clock": {"now"},
    "run": {"incidentSchema"},
    "frame": {"changed", "epoch", "delta", "count", "gone", "after", "ids"},
}
PHONE_LIVE = {"marked": {"listening", "agents", "remote"}, "clock": {"listenerGap"}}
PHONE_CARD = {
    "saved": {"id", "bucket", "title", "replyFull", "done", "replies", "olderReplies", "ball", "docked",
              "dockedTs", "parked", "ts", "owner", "parkedTs", "doneTs", "pending", "pendingTexts",
              "pendingStamps", "pendingOps", "pendingBy", "pendingStates", "notedTexts", "agentTs", "agent",
              "seen", "turnTs", "replyKind", "replyId", "replyTs", "answered", "writing", "state", "magic",
              "testing", "queuePos"},
    "swept": {"bg"},
}


def listed(table):
    return set().union(*table.values())


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
    """One GET /events held open through app: its status and headers, every
    data line as it arrives with the moment it arrived, and whether the board
    ended it. hang_up() is the peer going away."""

    def __init__(self, app, headers=None, server=None, method="GET"):
        self.status = self.headers = None
        self.raw = b""
        self.data = []            # (monotonic time, {rev, quiet})
        self.ended_at = None      # when the board sent the last of the body
        self._arrived = asyncio.Event()
        self._gone = asyncio.Event()
        self._given = False
        self.task = asyncio.ensure_future(
            app(scope_of(method, "/events", "", headers or EVENTS, server), self._receive, self._send))

    async def _receive(self):
        if not self._given:
            self._given = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self._gone.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message):
        now = time.monotonic()
        if message["type"] == "http.response.start":
            self.status = message["status"]
            self.headers = {k.decode().lower(): v.decode() for k, v in message.get("headers") or ()}
        elif message["type"] == "http.response.body":
            body = message.get("body", b"")
            self.raw += body
            for row in body.decode().split("\n"):
                if row.startswith("data: "):
                    self.data.append((now, json.loads(row[6:])))
            if not message.get("more_body"):
                self.ended_at = now
        self._arrived.set()

    async def until(self, test, seconds=2.0):
        """Waits until test() is true, at most seconds; answers it."""
        deadline = time.monotonic() + seconds
        while not test():
            left = deadline - time.monotonic()
            if left <= 0:
                return test()
            self._arrived.clear()
            try:
                await asyncio.wait_for(self._arrived.wait(), left)
            except asyncio.TimeoutError:
                pass
        return True

    async def first(self):
        assert await self.until(lambda: self.data or self.ended_at is not None), "the line sent nothing"
        return self.data[0][1]

    async def next_after(self, count, seconds=1.0):
        """The data line after the first count of them, or None."""
        await self.until(lambda: len(self.data) > count, seconds)
        return self.data[count] if len(self.data) > count else None

    async def close(self):
        self._gone.set()
        try:
            await asyncio.wait_for(self.task, 2)
        except asyncio.TimeoutError:
            self.task.cancel()


class Board(unittest.TestCase):
    """A board of three cards in a temporary folder, its routes built as the
    board builds them, the loop it runs on known to _notify."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="events-stream-run-")).resolve()
        self.addCleanup(shutil.rmtree, self.dir, True)
        (self.dir / "seed.json").write_text(json.dumps({"title": "events", "items": [
            {"id": "m1", "bucket": "meta", "title": "First card", "owner": "facilitator"},
            {"id": "m2", "bucket": "meta", "title": "Second card", "owner": "facilitator"},
            {"id": "m3", "bucket": "meta", "title": "Third card", "owner": "facilitator"},
        ]}))
        patches = mock.patch.multiple(
            S, STATE_PATH=self.dir / "state.json", TRANSCRIPT_PATH=self.dir / "transcript.jsonl",
            SEED_PATH=self.dir / "seed.json", MAGIC_DIR=self.dir / "magic-boxes",
            UPLOADS=self.dir / "uploads", OLD_UPLOADS=self.dir / "uploads-old",
            SETTINGS_PATH=self.dir / "settings.json", PROFILE_PATH=self.dir / "profile.json",
            TYPING_HOLD=0.0)
        patches.start()
        self.addCleanup(patches.stop)
        S._load()
        for ow in S.OWNERS:
            S._waiters[ow] = 0
            S._last_wait[ow] = 0.0
        S._save()
        with S._lock:
            S._board_tick()   # the mark as the board clock would have it
        self.app = S.build_app()
        self.addCleanup(setattr, S, "_LOOP", None)

    def run_(self, coro):
        async def on_the_loop():
            S._LOOP = asyncio.get_running_loop()
            try:
                return await coro
            finally:
                S._LOOP = None
        return asyncio.run(on_the_loop())

    def saved(self):
        return json.loads(S.STATE_PATH.read_text())

    async def agent(self, method, path, query="", body=b""):
        return await ask(self.app, method, path, query, body, CURL)

    async def page(self, method, path, query="", body=b""):
        return await ask(self.app, method, path, query, body, PAGE_READ if method == "GET" else PAGE_WRITE)

    async def claim(self):
        """A message on m1 and the lane's agent claiming it: the ack token."""
        status, _ = await self.page("POST", "/send", "box=m1", b"A message for the agent")
        self.assertEqual(status, 200)
        status, got = await self.agent("GET", "/wait", "owner=facilitator&timeout=2&agent=claude")
        self.assertEqual((status, got.get("box")), (200, "m1"))
        return got["ack"]

    async def rings(self, action):
        """Opens a line, runs action, and answers (the version moved, the
        revision the line last sent, the revision on disk)."""
        line = Line(self.app)
        before = (await line.first())["rev"]
        version = S._change_version
        await action()
        disk = self.saved()["rev"]
        self.assertGreater(disk, before, "the action saved nothing")
        await line.until(lambda: line.data[-1][1]["rev"] == disk, 0.5)
        await line.close()
        return S._change_version > version, line.data[-1][1]["rev"], disk


class Rings(Board):
    def test_a_claim_rings(self):
        async def go():
            await self.page("POST", "/send", "box=m1", b"A message for the agent")
            async def claim():
                status, got = await self.agent("GET", "/wait", "owner=facilitator&timeout=2&agent=claude")
                self.assertEqual(got.get("box"), "m1")
            return await self.rings(claim)
        moved, sent, disk = self.run_(go())
        self.assertTrue(moved, "the claim moved no version")
        self.assertEqual(sent, disk, "the line did not send the claim's revision")
        self.assertEqual(self.saved()["busy"]["facilitator"], "m1")

    def test_an_ack_rings(self):
        async def go():
            token = await self.claim()
            async def ack():
                self.assertEqual((await self.agent("POST", "/ack", f"owner=facilitator&token={token}"))[0], 200)
            return await self.rings(ack)
        moved, sent, disk = self.run_(go())
        self.assertTrue(moved, "the ack moved no version")
        self.assertEqual(sent, disk)
        self.assertTrue(self.saved()["ack"]["facilitator"]["confirmed"])

    def test_a_widget_save_rings(self):
        async def go():
            status, _ = await self.agent("POST", "/magic", "box=m1&kind=html&widget=issues", WIDGET_PAGE)
            self.assertEqual(status, 200)
            async def answer():
                status, got = await self.agent("POST", "/magic/answer", "box=m1&agent=claude",
                                               b"An answer in the widget")
                self.assertEqual(status, 200, got)
            return await self.rings(answer)
        moved, sent, disk = self.run_(go())
        self.assertTrue(moved, "the widget's save moved no version")
        self.assertEqual(sent, disk)

    def test_a_save_rings_and_names_only_a_revision_on_disk(self):
        with S._lock:
            version, rev = S._change_version, S._committed_rev
            S._save()
            self.assertEqual(S._change_version, version + 1, "a save did not ring")
            self.assertEqual(S._committed_rev, rev + 1)
            # a save whose write fails rings nothing and leaves the line's revision
            with mock.patch.object(S, "_durable_fsync", side_effect=OSError(28, "No space left on device")):
                with self.assertRaises(S.SaveFailed):
                    S._save()
            self.assertEqual(S._change_version, version + 1)
            self.assertEqual(S._committed_rev, rev + 1)
            self.assertEqual(S._state["rev"], rev + 1)


class Clock(Board):
    def run_clock(self, seconds, check=None):
        """The board clock's own thread for at most seconds, ticking every
        20 ms, with nothing else asking the board; stops early once check()."""
        stop = threading.Event()
        with mock.patch.object(S, "BOARD_TICK", 0.02), mock.patch.object(S, "_STOPPING", stop):
            clock = threading.Thread(target=S._board_clock, daemon=True)
            clock.start()
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline and not (check and check()):
                time.sleep(0.02)
            stop.set()
            clock.join(2)
        self.assertFalse(clock.is_alive(), "the board clock did not stop on the stop")

    def test_the_clock_constants(self):
        self.assertEqual((S.BOARD_TICK, S.ACK_GRACE, S.LANE_QUIET), (1.0, 90.0, 600.0))

    def test_an_unconfirmed_hand_off_goes_back_with_nothing_reading_the_board(self):
        self.run_(self.claim())
        self.assertEqual(self.saved()["busy"]["facilitator"], "m1")
        reads = mock.patch.object(S, "_get_state", side_effect=AssertionError("a reading ran"))
        with reads, mock.patch.object(S, "ACK_GRACE", 0.2):
            self.run_clock(3, lambda: self.saved()["busy"]["facilitator"] is None)
        board = self.saved()
        self.assertIsNone(board["busy"]["facilitator"], "the hand-off was not released by the clock")
        self.assertEqual(board["inbox"][0], "m1", "the card did not go back to the front of its queue")

    def test_green_ends_ten_minutes_after_the_lane_goes_quiet_with_nothing_reading_the_board(self):
        async def working():
            self.assertEqual((await self.agent("POST", "/working", "box=m1&v=1"))[0], 200)
            self.assertEqual((await self.agent("POST", "/reply", "box=m1", b"Halfway there"))[0], 200)
        with mock.patch.object(S, "LANE_QUIET", 0.3):
            self.run_(working())
            self.assertTrue(next(b for b in self.saved()["boxes"] if b["id"] == "m1")["flag"])
            card = lambda: next(b for b in self.saved()["boxes"] if b["id"] == "m1")
            with mock.patch.object(S, "_get_state", side_effect=AssertionError("a reading ran")):
                self.run_clock(3, lambda: not card()["flag"])
        self.assertFalse(card()["flag"], "the flag outlived the lane going quiet")
        self.assertEqual(card()["state"], "yours", "the card did not leave green with its turn handed over")

    def test_the_mark_rings_with_no_save(self):
        async def go():
            line = Line(self.app)
            first = await line.first()
            S._waiters["facilitator"] = 1   # a listener's /wait opened, which saves nothing
            stop = threading.Event()
            with mock.patch.object(S, "BOARD_TICK", 0.02), mock.patch.object(S, "_STOPPING", stop):
                clock = threading.Thread(target=S._board_clock, daemon=True)
                clock.start()
                try:
                    got = await line.next_after(1, 2)
                finally:
                    stop.set()
                    clock.join(2)
            S._waiters["facilitator"] = 0
            await line.close()
            return first, got
        first, got = self.run_(go())
        self.assertIsNotNone(got, "the mark moved and the line said nothing")
        self.assertEqual(got[1]["rev"], first["rev"], "a mark ring moved the revision")
        self.assertNotEqual(got[1]["quiet"], first["quiet"])

    def test_a_pass_that_fails_is_written_down_once_and_the_clock_goes_on(self):
        passes, lines = [0], []

        def broken():
            passes[0] += 1
            raise RuntimeError("the sweep broke")

        with mock.patch.object(S, "_sweep_clocks", broken), \
                mock.patch.object(S, "_error", lambda kind, *a, **f: lines.append((kind, f))):
            self.run_clock(0.4)
        self.assertGreater(passes[0], 5, "the clock stopped after a failing pass")
        self.assertEqual([kind for kind, _ in lines], ["boardclock"])
        self.assertEqual(lines[0][1]["error"], "RuntimeError")


class Fields(Board):
    def readings(self):
        """The board's reading whole and lean, and the phone's whole and lean,
        with every field that is sometimes left out put in."""
        async def go():
            self.assertEqual((await self.agent("POST", "/magic", "box=m2&kind=text", b"plain words"))[0], 200)
            _, whole = await self.page("GET", "/state")
            _, first = await self.page("GET", "/state", "since=")
            await self.page("POST", "/title", "box=m1", b"A new title")
            _, lean = await self.page("GET", "/state", f"since={first['rev']}&delta={first['epoch']}")
            _, phone = await ask(self.app, "GET", "/m/state", "ops=fieldop0001", headers=PAGE_READ, server=PHONE)
            await self.page("POST", "/title", "box=m1", b"Another title")
            _, phone_lean = await ask(self.app, "GET", "/m/state", f"since={phone['rev']}&delta={phone['epoch']}",
                                      headers=PAGE_READ, server=PHONE)
            return whole, lean, phone, phone_lean
        with mock.patch.object(S, "_profile_needed", lambda: True), \
                mock.patch.object(S, "_update_reading", lambda: {"offer": "v9.9.9", "version": "v0.3.37"}), \
                mock.patch.object(S, "_serve_hold", "The phone is off for now."), \
                mock.patch.object(S, "QUICK_NOTES_ON", True):
            readings = self.run_(go())
            with S._lock:
                quiet = S._quiet_fields()
        return (*readings, quiet)

    def test_every_key_of_both_readings_is_listed(self):
        whole, lean, phone, phone_lean, _ = self.readings()
        for name, keys, table in (("/state", set(whole) | set(lean), DESK),
                                  ("a /state card", set().union(*(b.keys() for b in whole["boxes"])), DESK_CARD),
                                  ("/m/state", set(phone) | set(phone_lean), PHONE_READING),
                                  ("/m/state live", set(phone["live"]), PHONE_LIVE),
                                  ("a /m/state card", set().union(*(b.keys() for b in phone["boxes"])), PHONE_CARD)):
            unlisted = keys - listed(table)
            self.assertFalse(unlisted, f"{name} carries {sorted(unlisted)}, which no list here names: say whether "
                                       "it moves with a save, is in the board clock's mark (_quiet_fields), "
                                       "or is worked out on the page")
            # and every list stays true: each key it names (the lean framing aside) is still carried
            missing = (listed(table) - table.get("frame", set())) - keys
            self.assertFalse(missing, f"{name} no longer carries {sorted(missing)}")

    def test_the_mark_holds_exactly_the_marked_fields_as_the_readings_carry_them(self):
        whole, _, phone, _, quiet = self.readings()
        self.assertEqual(set(quiet), DESK["marked"] | {"version"})
        for field in ("listening", "agents", "remote", "settingsRev", "phoneOff", "onboarding", "update"):
            self.assertEqual(whole[field], quiet[field], field)
        self.assertEqual(phone["version"], quiet["version"])
        self.assertEqual(phone["live"]["listening"], quiet["listening"])
        self.assertEqual(phone["live"]["remote"], quiet["remote"])
        for ow, agent in phone["live"]["agents"].items():
            self.assertEqual(agent, {k: quiet["agents"][ow][k] for k in agent}, ow)

    def test_each_marked_field_moves_the_mark(self):
        movers = {
            "listening": lambda: mock.patch.dict(S._waiters, {"facilitator": 1}),
            "agents": lambda: mock.patch.dict(S._agent_names, {"facilitator": "codex"}),
            "remote": lambda: mock.patch.object(S, "_remote_reading", lambda: {"servers": {"s1": {"up": True}}}),
            "phoneOff": lambda: mock.patch.object(S, "_serve_hold", "The phone is off for now."),
            "update": lambda: mock.patch.object(S, "_update_reading", lambda: {"running": True}),
            "onboarding": lambda: mock.patch.object(S, "_profile_needed", lambda: False),
            "settingsRev": lambda: mock.patch.object(S, "_settings_rev", lambda: 99),
            "version": lambda: mock.patch.object(S, "_reading_version", lambda: "v9.9.9"),
        }
        with S._lock:
            self.assertEqual(set(movers), set(S._quiet_fields()))
            base = S._quiet_mark()
            self.assertRegex(base, r"^[0-9a-f]{12}$")
            for field, mover in movers.items():
                with mover():
                    self.assertNotEqual(S._quiet_mark(), base, f"{field} moved and the mark did not")
            # an agent going off the record, a minute after its last /wait, moves it too
            with mock.patch.dict(S._last_wait, {"facilitator": time.time() - 120}):
                self.assertNotEqual(S._quiet_mark(), base)
            self.assertEqual(S._quiet_mark(), base)


class Stream(Board):
    def test_the_line_constants(self):
        self.assertEqual((S.STREAM_BEAT, S.STREAM_LIFE, S.STREAM_RETRY, S.STREAM_SLOTS),
                         (15.0, 600.0, 3000, 16))
        self.assertIn("/events", S.UNCOUNTED_GETS)
        [route] = [r for r in S.ROUTES if r.path == "/events"]
        self.assertEqual(route.methods, {"GET", "HEAD"})

    def test_the_first_line_says_the_retry_the_revision_and_the_mark(self):
        async def go():
            line = Line(self.app)
            first = await line.first()
            await line.close()
            return line, first
        line, first = self.run_(go())
        self.assertEqual(line.status, 200)
        self.assertEqual(line.headers["content-type"], "text/event-stream")
        self.assertEqual(line.headers["cache-control"], "no-store")
        self.assertNotIn("content-encoding", line.headers)
        self.assertTrue(line.raw.startswith(b"retry: 3000\n\ndata: {"), line.raw[:60])
        self.assertEqual(first, {"rev": self.saved()["rev"], "quiet": S._quiet})
        self.assertEqual(S._streams_open, 0, "a closed line kept its slot")

    def test_a_change_rings_within_100_ms(self):
        saved_at = []
        real = S._save

        def timed():
            real()
            saved_at.append(time.monotonic())

        async def go():
            line = Line(self.app)
            await line.first()
            took = []
            for n in range(5):
                status, _ = await self.page("POST", "/title", "box=m1", f"Title {n}".encode())
                self.assertEqual(status, 200)
                got = await line.next_after(1 + n)
                self.assertIsNotNone(got, f"change {n} never rang")
                self.assertEqual(got[1]["rev"], self.saved()["rev"])
                took.append(got[0] - saved_at[-1])
            await line.close()
            return took
        with mock.patch.object(S, "_save", timed):
            took = self.run_(go())
        self.assertLess(max(took), 0.1, f"rings took {took}")

    def test_the_beat_repeats_the_line_when_nothing_moved(self):
        async def go():
            line = Line(self.app)
            await line.first()
            await line.until(lambda: len(line.data) >= 4, 2)
            await line.close()
            return line.data
        with mock.patch.object(S, "STREAM_BEAT", 0.2):
            data = self.run_(go())
        self.assertGreaterEqual(len(data), 4)
        self.assertEqual(len({json.dumps(d) for _, d in data}), 1, "the beat said something else")
        gaps = [round(b[0] - a[0], 3) for a, b in zip(data, data[1:])]
        self.assertTrue(all(0.15 <= g <= 0.35 for g in gaps), gaps)

    def test_the_line_ends_on_the_stop_within_half_a_second(self):
        stop = threading.Event()

        async def go():
            line = Line(self.app)
            await line.first()
            at = time.monotonic()
            stop.set()
            with S._lock:
                S._notify()   # as the stop's own handler does
            await line.until(lambda: line.ended_at is not None, 2)
            await asyncio.wait_for(line.task, 1)
            return line.ended_at and line.ended_at - at
        with mock.patch.object(S, "_STOPPING", stop):
            took = self.run_(go())
        self.assertIsNotNone(took, "the line did not end on the stop")
        self.assertLess(took, 0.5)

    def test_the_line_ends_after_its_life(self):
        async def go():
            line = Line(self.app)
            at = time.monotonic()
            await line.first()
            await line.until(lambda: line.ended_at is not None, 3)
            await asyncio.wait_for(line.task, 1)
            return line.ended_at and line.ended_at - at
        with mock.patch.object(S, "STREAM_LIFE", 0.5):
            took = self.run_(go())
        self.assertIsNotNone(took, "the line outlived its life")
        self.assertGreaterEqual(took, 0.5)
        self.assertLess(took, 1.0)

    def test_past_its_slots_a_line_is_503_and_a_slot_comes_back(self):
        async def go():
            held = [Line(self.app), Line(self.app)]
            for line in held:
                await line.first()
            third = Line(self.app)
            await asyncio.wait_for(third.task, 2)
            await held[0].close()
            fourth = Line(self.app)
            await fourth.first()
            for line in (held[1], fourth):
                await line.close()
            return third, fourth
        with mock.patch.object(S, "STREAM_SLOTS", 2):
            third, fourth = self.run_(go())
        self.assertEqual(third.status, 503)
        self.assertEqual(third.headers.get("retry-after"), "5")
        self.assertEqual(json.loads(third.raw), {"error": "too many pages listening"})
        self.assertEqual(fourth.status, 200)
        self.assertEqual(S._streams_open, 0)

    def test_head_answers_the_headers_and_ends(self):
        async def go():
            line = Line(self.app, method="HEAD")
            await asyncio.wait_for(line.task, 2)
            return line
        line = self.run_(go())
        self.assertEqual((line.status, line.headers["content-type"], line.raw), (200, "text/event-stream", b""))


class Locks(Board):
    """Through the layers a real board puts in front of its routes."""

    def setUp(self):
        super().setUp()
        self.stack = S._make_server(BridgeGate).config.app
        auth_file = self.dir / "bridge-auth.json"
        for target, name, value in ((bridge_auth, "AUTH_FILE", auth_file),
                                    (bridge_auth, "LOCK_FILE", auth_file.with_suffix(".lock")),
                                    (S, "_BRIDGE_AUTH", bridge_auth), (S, "_board_lock", True),
                                    (S, "_agent_key", "k" * 43),
                                    (S, "_window_keys", [{"hash": S._key_digest("w" * 43), "made": 0}])):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        bridge_auth.set_password(PASS)
        verdict, self.token = bridge_auth.login(PASS)
        self.assertEqual(verdict, "ok")
        self.signed = {**EVENTS, "cookie": f"{bridge_auth.COOKIE}={self.token}"}

    def open_once(self, headers, server=None):
        async def go():
            line = Line(self.stack, headers, server)
            await line.until(lambda: line.data or line.ended_at is not None)
            await line.close()
            return line
        return self.run_(go())

    def test_the_boards_port_asks_for_the_key_or_the_window_cookie(self):
        refused = self.open_once(EVENTS)
        self.assertEqual(refused.status, 401)
        self.assertEqual(json.loads(refused.raw)["error"], S.LOCK_REFUSAL)
        keyed = self.open_once({**CURL, "authorization": "Bearer " + "k" * 43})
        self.assertEqual((keyed.status, len(keyed.data)), (200, 1))
        windowed = self.open_once({**EVENTS, "cookie": f"{S.WINDOW_COOKIE}={'w' * 43}"})
        self.assertEqual((windowed.status, len(windowed.data)), (200, 1))
        wrong = self.open_once({**EVENTS, "cookie": f"{S.WINDOW_COOKIE}={'x' * 43}"})
        self.assertEqual(wrong.status, 401)

    def test_the_phones_door_asks_for_a_sign_in(self):
        unsigned = self.open_once(EVENTS, PHONE)
        self.assertEqual((unsigned.status, json.loads(unsigned.raw)), (401, {"error": "sign in required"}))
        # a request Tailscale Serve forwarded to the board's own port goes to the gate too
        marked = self.open_once({**EVENTS, "x-forwarded-for": "100.64.0.9"})
        self.assertEqual(marked.status, 401)
        # the key opens nothing through the phone's door
        keyed = self.open_once({**EVENTS, "authorization": "Bearer " + "k" * 43}, PHONE)
        self.assertEqual(keyed.status, 401)
        signed = self.open_once(self.signed, PHONE)
        self.assertEqual((signed.status, len(signed.data)), (200, 1))
        marked_signed = self.open_once({**self.signed, "x-forwarded-for": "100.64.0.9"})
        self.assertEqual((marked_signed.status, len(marked_signed.data)), (200, 1))

    def test_a_signed_in_line_ends_within_one_beat_of_the_sign_out(self):
        async def go():
            line = Line(self.stack, self.signed, PHONE)
            await line.first()
            await line.until(lambda: len(line.data) >= 2, 2)   # a beat with the sign-in still good
            at = time.monotonic()
            await asyncio.get_running_loop().run_in_executor(None, bridge_auth.logout, self.token)
            await line.until(lambda: line.ended_at is not None, 2)
            await line.close()
            return line, line.ended_at and line.ended_at - at
        with mock.patch.object(S, "STREAM_BEAT", 0.2):
            line, took = self.run_(go())
        self.assertEqual(line.status, 200)
        self.assertGreaterEqual(len(line.data), 2)
        self.assertIsNotNone(took, "the line outlived the sign-out")
        self.assertLess(took, 0.2 + 0.15)

    def test_a_line_left_open_is_not_a_use_of_the_sign_in(self):
        digest = bridge_auth._session_digest(self.token)
        stamped = json.loads(bridge_auth.AUTH_FILE.read_text())["used"][digest]
        later = stamped + 2 * 60 * 60   # past the hour after which a use is stamped again

        async def go():
            line = Line(self.stack, self.signed, PHONE)
            await line.first()
            with mock.patch.object(bridge_auth, "_now", lambda: later):
                await line.until(lambda: len(line.data) >= 4, 2)
            await line.close()
            return line
        with mock.patch.object(S, "STREAM_BEAT", 0.1):
            line = self.run_(go())
        self.assertGreaterEqual(len(line.data), 4)
        self.assertEqual(json.loads(bridge_auth.AUTH_FILE.read_text())["used"][digest], stamped,
                         "the line's own checks stamped the sign-in as used")

    def test_the_agent_door_does_not_let_it_through(self):
        remote_link = S.remote_link
        if remote_link is None:
            self.skipTest("this copy of the board has no agent door")
        self.assertNotIn("/events", remote_link.KNOWN_ROUTES)
        self.assertNotIn(("GET", "/events"), remote_link.AGENT_ROUTES)


if __name__ == "__main__":
    unittest.main()
