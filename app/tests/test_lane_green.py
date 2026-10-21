"""A working card's green rides on its lane's agent being in touch with the
board (server.py: LANE_QUIET, _lane_in_touch, _heard, _sweep), driven through
the board's own application with the lane's clock in the test's hands.

  silence   a card with its flag up and no /ping stays green while its lane's
            agent asks other things, each of the lane's routes on its own,
            and goes yellow LANE_QUIET after the lane's last request, its
            deferred turn handed over and its flag taken down with it
  wait      an open /wait keeps the lane in touch for as long as it is open,
            and the lane's quiet starts when it ends
  pages     what the board's pages ask (/state, the phone's reading, the
            person's moves, a page's /title, /park, /testing, /create and
            /magic/close) never keeps a lane in touch
  lanes     two lanes keep their own clocks
  door      a server's agent asking through the agent door keeps its lane in
            touch
  ping      /ping is still answered, counts as a request and changes nothing
            on the card; a late one does not bring a lapsed card back
  restart   a flag saved under the old heartbeat comes back on when its last
            ping was within 75 seconds and off when not, and a lane counts
            from the board's start
  marks     which requests are an agent's and which a page's

The server is loaded as a module, every file it writes moved into a temporary
folder.

    python3 -m unittest tests/test_lane_green.py
"""

import asyncio
import importlib.util
import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
LOGS = Path(tempfile.mkdtemp(prefix="lane-green-logs-"))


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = str(LOGS)
    spec = importlib.util.spec_from_file_location("facilitator_server_lane_green", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = _load_server()
remote_link = S.remote_link
MINUTE = 60.0

# what each kind of caller puts on a request. A page is a browser: Origin on a
# write, the fetch metadata on everything. curl and the skill's scripts send
# neither; node's own fetch, which the other suites use, sends only the mode
PAGE_READ = {"sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
             "user-agent": "Mozilla/5.0 (Macintosh) Chrome/141"}
PAGE_WRITE = {**PAGE_READ, "origin": f"http://127.0.0.1:{S.PORT}"}
CURL = {"user-agent": "curl/8.7.1", "accept": "*/*"}

# one request on each of an agent's lane routes, on card m1 of lane facilitator
LANE_ASKS = [
    ("GET", "/unread", "owner=facilitator", b""),
    ("GET", "/fresh", "owner=facilitator", b""),
    ("POST", "/ack", "owner=facilitator&token=none", b""),
    ("POST", "/create", "owner=facilitator", b"A finding for later"),
    ("POST", "/title", "box=m1", b"Lane green"),
    ("POST", "/context", "box=m1", b"two lines of context"),
    ("POST", "/props", "box=m1&status=building&agent=claude", b""),
    ("GET", "/props", "box=m1", b""),
    ("POST", "/link", "from=m1&to=m2&agent=claude", b""),
    ("POST", "/testing", "box=m1&v=0", b""),
    ("POST", "/park", "box=m1&v=0", b""),
    ("POST", "/magic", "box=m1&kind=text", b"plain words"),
    ("GET", "/magic", "box=m1", b""),
    ("POST", "/magic/close", "box=m1", b""),
    ("POST", "/magic/reopen", "box=m1", b""),
    ("POST", "/working", "box=m1&v=1", b""),
    ("POST", "/ping", "box=m1", b""),
    ("POST", "/reply", "box=m1", b"Still at it, here is where it stands"),
]


def scope_of(method, path, query="", headers=None, server=None):
    head = {"host": f"127.0.0.1:{S.PORT}", **(headers or {})}
    return {"type": "http", "method": method, "path": path, "query_string": query.encode(),
            "http_version": "1.1", "scheme": "http", "client": ("127.0.0.1", 50000),
            "server": server or ("127.0.0.1", S.PORT), "root_path": "",
            "headers": [(k.encode(), v.encode()) for k, v in head.items()]}


async def ask(app, method, path, query="", body=b"", headers=None, server=None, until=None):
    """One request through app: (status, answer). until, when given, holds the
    connection open until it is set, as a listener's long poll is held."""
    sent = []
    given = [False]

    async def receive():
        if not given[0]:
            given[0] = True
            return {"type": "http.request", "body": body, "more_body": False}
        if until is not None:
            await until.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    await app(scope_of(method, path, query, headers, server), receive, send)
    # a listener that hung up is answered nothing at all
    status = next((m["status"] for m in sent if m["type"] == "http.response.start"), None)
    data = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    try:
        return status, json.loads(data) if data else None
    except ValueError:
        return status, data


class Lane(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="lane-green-run-")).resolve()
        (self.dir / "seed.json").write_text(json.dumps({"title": "lane green", "items": [
            {"id": "m1", "bucket": "meta", "title": "Working card", "owner": "facilitator"},
            {"id": "m2", "bucket": "meta", "title": "Another card", "owner": "facilitator"},
            {"id": "m3", "bucket": "meta", "title": "Demo card", "owner": "demo"},
        ]}))
        self.paths = mock.patch.multiple(
            S, STATE_PATH=self.dir / "state.json", TRANSCRIPT_PATH=self.dir / "transcript.jsonl",
            SEED_PATH=self.dir / "seed.json", MAGIC_DIR=self.dir / "magic-boxes",
            UPLOADS=self.dir / "uploads", OLD_UPLOADS=self.dir / "uploads-old",
            SETTINGS_PATH=self.dir / "settings.json", PROFILE_PATH=self.dir / "profile.json")
        self.paths.start()
        # the lane's clock is the test's: it moves only when the test moves it
        self.now = 1_000_000.0
        self.clock = mock.patch.object(S, "_lane_now", lambda: self.now)
        self.clock.start()
        self.start = S._lane_start
        S._lane_start = self.now
        S._lane_heard.clear()
        S._load()
        S._state["projects"] = [{"id": "demo", "name": "demo", "dir": "/home/you/demo", "server": "lab"}]
        S._register_owner("demo")
        for field, empty in (("busy", None), ("claimed", []), ("busy_ts", 0.0), ("ack", None)):
            S._state[field].setdefault("demo", empty)
        for ow in S.OWNERS:
            S._waiters[ow] = 0
            S._last_wait[ow] = 0.0
        S._save()
        self.app = S.build_app()

    def tearDown(self):
        self.clock.stop()
        self.paths.stop()
        S._lane_start = self.start
        S._lane_heard.clear()
        if S._remote is not None:
            S._remote.stop()
            S._remote = None
        shutil.rmtree(self.dir, ignore_errors=True)

    # -- helpers
    def run_(self, coro):
        return asyncio.run(coro)

    def agent(self, method, path, query="", body=b""):
        return self.run_(ask(self.app, method, path, query, body, CURL))

    def page(self, method, path, query="", body=b""):
        return self.run_(ask(self.app, method, path, query, body, PAGE_READ if method == "GET" else PAGE_WRITE))

    def later(self, seconds):
        self.now += seconds

    def card(self, bid="m1"):
        """The card as the Mac board reads it, through the page's own /state."""
        status, board = self.page("GET", "/state")
        self.assertEqual(status, 200)
        return next(b for b in board["boxes"] if b["id"] == bid)

    def colour(self, bid="m1"):
        b = self.card(bid)
        return b["state"], b["bg"]

    def saved_flag(self, bid="m1"):
        return next(b for b in json.loads(S.STATE_PATH.read_text())["boxes"] if b["id"] == bid)["flag"]

    def working_with_reply(self, bid="m1", call=None):
        """The flag up and a reply under it: green in deferred, its turn
        waiting for the work to end."""
        call = call or self.agent
        self.assertEqual(call("POST", "/working", f"box={bid}&v=1")[0], 200)
        self.assertEqual(call("POST", "/reply", f"box={bid}", b"Halfway there")[0], 200)
        self.assertEqual(S._box(bid)["state"], "deferred")
        self.assertEqual(self.colour(bid), ("working", True))

    # -- silence
    def test_green_lasts_while_the_lane_asks_other_things_and_ends_ten_minutes_after_its_last(self):
        self.assertEqual(S.LANE_QUIET, 600.0)
        self.working_with_reply()
        # nine minutes, a request a minute and never a /ping
        for minute, (method, path, query, body) in enumerate(LANE_ASKS[:9], 1):
            self.later(MINUTE)
            self.agent(method, path, query, body)
            self.assertEqual(self.colour(), ("working", True), f"minute {minute}, after {path}")
        self.later(599)
        self.assertEqual(self.colour(), ("working", True), "green went before ten minutes of quiet")
        self.later(1)
        b = self.card()
        self.assertEqual((b["state"], b["bg"], b["ball"]), ("yours", False, "you"),
                         "ten minutes after the lane's last request the card did not go yellow")
        self.assertFalse(self.saved_flag(), "the flag outlived the lane going quiet")
        # the lane coming back does not bring a card back that its agent left
        self.agent("GET", "/unread", "owner=facilitator")
        self.assertEqual(self.colour(), ("yours", False))

    def test_each_lane_route_on_its_own_keeps_the_lane_in_touch(self):
        self.working_with_reply()
        for method, path, query, body in LANE_ASKS:
            # each request comes 9 minutes 50 seconds after the one before, so
            # one that did not count would leave the card yellow at the next look
            self.later(590)
            self.assertEqual(self.colour(), ("working", True), f"green lapsed before {path}")
            status, _ = self.agent(method, path, query, body)
            self.assertLess(status, 500, path)
        self.later(590)
        self.assertEqual(self.colour(), ("working", True))
        self.later(10)
        self.assertEqual(self.colour()[0], "yours")

    def test_a_quiet_lane_lapses_at_ten_minutes_even_when_nothing_read_the_board_meanwhile(self):
        self.working_with_reply()
        self.later(601)
        # no page looked; the lane's next request finds its card already out of green
        self.agent("POST", "/reply", "box=m1", b"Back again")
        b = self.card()
        self.assertEqual((b["state"], b["bg"]), ("yours", False))
        self.assertFalse(self.saved_flag())

    def test_dropping_the_flag_still_hands_the_turn_over_at_once(self):
        self.working_with_reply()
        self.later(MINUTE)
        self.assertEqual(self.agent("POST", "/working", "box=m1&v=0")[0], 200)
        self.assertEqual(self.colour(), ("yours", False))

    # -- wait
    def test_an_open_wait_keeps_the_lane_in_touch_for_as_long_as_it_is_open(self):
        self.working_with_reply()

        async def held():
            done = asyncio.Event()
            listen = asyncio.ensure_future(
                ask(self.app, "GET", "/wait", "owner=facilitator&timeout=60&agent=claude", headers=CURL, until=done))
            while S._waiters["facilitator"] == 0:
                await asyncio.sleep(0.01)
            seen = []
            for _ in range(5):
                self.later(10 * MINUTE)
                status, board = await ask(self.app, "GET", "/state", headers=PAGE_READ)
                seen.append(next(b["state"] for b in board["boxes"] if b["id"] == "m1"))
            done.set()   # the listener hangs up
            self.assertEqual(await listen, (None, None))
            return seen

        self.assertEqual(self.run_(held()), ["working"] * 5, "an open wait did not keep the lane in touch")
        self.assertEqual(S._waiters["facilitator"], 0)
        # the quiet starts when the wait ends, not when it began
        self.later(599)
        self.assertEqual(self.colour(), ("working", True))
        self.later(1)
        self.assertEqual(self.colour()[0], "yours")

    # -- pages
    def test_the_pages_never_keep_a_lane_in_touch(self):
        self.working_with_reply()
        phone = ("127.0.0.1", S.BRIDGE_PORT)
        page_asks = [
            ("POST", "/title", "box=m1", b"Renamed by the person"),
            ("POST", "/park", "box=m1&v=1", b""),
            ("POST", "/park", "box=m1&v=0", b""),
            ("POST", "/testing", "box=m1&v=0", b""),
            ("POST", "/magic/close", "box=m1", b""),
            ("POST", "/create", "owner=facilitator", b"A card the person made"),
            ("POST", "/typing", "box=m1", b""),
            ("POST", "/seen", "", json.dumps({"m1": 1}).encode()),
        ]
        for minute in range(1, 10):
            self.later(MINUTE)
            for method, path, query, body in page_asks:
                self.assertLess(self.page(method, path, query, body)[0], 500, path)
            # the phone's reading comes through its own port
            status, _ = self.run_(ask(self.app, "GET", "/m/state", "", b"", PAGE_READ, server=phone))
            self.assertEqual(status, 200)
        self.later(MINUTE)   # ten minutes since the agent's last request
        b = self.card()
        self.assertEqual((b["state"], b["bg"], b["ball"]), ("yours", False, "you"),
                         "the person's own requests kept a working card green")

    def test_a_page_asking_on_an_agents_route_is_still_a_page(self):
        self.working_with_reply()
        self.later(9 * MINUTE)
        # the routes an agent uses, asked with a browser's marks
        self.page("GET", "/unread", "owner=facilitator")
        self.page("POST", "/ping", "box=m1")
        self.page("POST", "/props", "box=m1&status=x")
        self.later(MINUTE)
        self.assertEqual(self.colour()[0], "yours")

    # -- lanes
    def test_two_lanes_keep_their_own_clocks(self):
        self.working_with_reply("m1")
        self.working_with_reply("m3")
        for _ in range(10):
            self.later(MINUTE)
            self.agent("GET", "/unread", "owner=facilitator")
        self.assertEqual(self.colour("m1"), ("working", True), "the busy lane lost its green")
        self.assertEqual(self.colour("m3")[0], "yours", "the quiet lane kept its green on the other's requests")
        # and the other way round
        self.agent("POST", "/working", "box=m3&v=1")
        for _ in range(10):
            self.later(MINUTE)
            self.agent("GET", "/unread", "owner=demo")
        self.assertEqual(self.colour("m3"), ("working", True))
        self.assertEqual(self.colour("m1")[0], "yours")

    # -- door
    def test_a_servers_agent_asking_through_the_door_keeps_its_lane_in_touch(self):
        remote_dir = self.dir / "remote"
        remote_dir.mkdir()
        server_key = remote_link.new_key()
        remote_link.Store(remote_dir).save_servers([
            {"id": "lab", "name": "lab", "home": "/home/you", "top": "/home/you",
             "key": remote_link.digest(server_key)}])
        S._remote = remote_link.Remote(remote_dir, ROOT.parent)
        S._remote.reload()
        key = S._remote.mint("demo", "lab")
        gate = remote_link.RemoteGate(self.app, S._RemoteBoard(), routes=self.app)

        def door(method, path, query="", body=b""):
            # what the server's curl -K file sends: its key, and no browser marks
            headers = {"host": "board", "authorization": "Bearer " + key, **CURL}
            return self.run_(ask(gate, method, path, query, body, headers, server=remote_link.SERVER_MARK))

        self.working_with_reply("m3", call=door)
        for _ in range(9):
            self.later(MINUTE)
            self.assertEqual(door("GET", "/unread", "owner=demo")[0], 200)
            self.assertEqual(self.colour("m3"), ("working", True))
        self.later(9 * MINUTE)
        self.assertEqual(door("GET", "/fresh", "owner=demo")[0], 200)
        self.later(9 * MINUTE)
        self.assertEqual(self.colour("m3"), ("working", True), "a request through the door did not count")
        self.later(MINUTE)
        self.assertEqual(self.colour("m3")[0], "yours")
        # the facilitator lane on the Mac was never heard from the door
        self.assertEqual(S._lane_heard.get("facilitator"), None)

    # -- ping
    def test_ping_is_still_answered_and_only_counts_as_a_request(self):
        self.working_with_reply()
        rev = json.loads(S.STATE_PATH.read_text())["rev"]
        for _ in range(15):
            self.later(MINUTE)
            self.assertEqual(self.agent("POST", "/ping", "box=m1"), (200, {"ok": True, "bg": True}))
        self.assertEqual(json.loads(S.STATE_PATH.read_text())["rev"], rev, "a ping saved the board")
        self.assertEqual(self.colour(), ("working", True), "pings no longer keep an old agent's card green")
        self.later(10 * MINUTE)
        self.assertEqual(self.colour()[0], "yours")
        # a late ping is a request like any other: it finds the flag gone
        self.assertEqual(self.agent("POST", "/ping", "box=m1"), (200, {"ok": True, "bg": False}))
        self.assertEqual(self.colour(), ("yours", False))
        self.assertEqual(self.agent("POST", "/ping", "box=nope")[0], 400)
        # raising the flag again is what turns it green
        self.agent("POST", "/working", "box=m1&v=1")
        self.assertEqual(self.colour(), ("working", True))

    # -- restart
    def test_a_flag_saved_under_the_old_heartbeat_and_a_lane_counted_from_the_start(self):
        saved = json.loads(S.STATE_PATH.read_text())
        wall = time.time()
        for b in saved["boxes"]:
            b.pop("flag", None)
            if b["id"] == "m1":      # pinged 10 seconds before the stop
                b.update(hb=wall - 10, state="deferred", ball="me", replies=1, agent_ts=wall)
            elif b["id"] == "m2":    # its pinger had stopped 10 minutes before
                b.update(hb=wall - 600, state="deferred", ball="me", replies=1, agent_ts=wall)
            else:
                b["hb"] = 0
        S.STATE_PATH.write_text(json.dumps(saved))
        # the board starts again: its lanes have not been heard yet
        S._lane_heard.clear()
        S._lane_start = self.now
        S._load()
        boxes = {b["id"]: b for b in S._state["boxes"]}
        self.assertEqual({bid: b["flag"] for bid, b in boxes.items()}, {"m1": True, "m2": False, "m3": False})
        self.assertFalse(any("hb" in b for b in boxes.values()), "the old heartbeat field was kept")
        # the quiet flag is out of green at the first reading, its turn handed
        # over as the old expiry did, and the live one keeps its green for a
        # whole LANE_QUIET while its agent comes back
        self.assertEqual(self.colour("m2"), ("yours", False))
        self.later(599)
        self.assertEqual(self.colour("m1"), ("working", True))
        self.later(1)
        self.assertEqual(self.colour("m1")[0], "yours")


class Marks(unittest.TestCase):
    def test_which_requests_are_an_agents(self):
        agent, door = S._agent_request, remote_link.SERVER_MARK
        self.assertTrue(agent(scope_of("GET", "/unread", headers=CURL)), "curl")
        self.assertTrue(agent(scope_of("POST", "/reply", headers={"user-agent": "Python-urllib/3.14"})), "onboard.py")
        self.assertTrue(agent(scope_of("POST", "/reply", headers={"sec-fetch-mode": "cors", "user-agent": "node"})),
                        "node's fetch, which sends the mode alone")
        self.assertFalse(agent(scope_of("POST", "/title", headers=PAGE_WRITE)), "the Mac board writing")
        self.assertFalse(agent(scope_of("GET", "/unread", headers=PAGE_READ)), "the Mac board reading")
        self.assertFalse(agent(scope_of("POST", "/title", headers={"origin": f"http://127.0.0.1:{S.PORT}"})),
                         "a write naming an origin")
        self.assertFalse(agent(scope_of("POST", "/title", headers=CURL, server=("127.0.0.1", S.BRIDGE_PORT))),
                         "the phone's port")
        self.assertFalse(agent(scope_of("POST", "/title", headers={**CURL, "x-forwarded-for": "100.64.0.9"})),
                         "forwarded by Tailscale Serve")
        through = scope_of("POST", "/reply", headers=CURL, server=door)
        through["facilitator.remote"] = {"lane": "demo", "server": "lab"}
        self.assertTrue(agent(through), "a server's agent through the door")


def tearDownModule():
    import logging
    for name in ("facilitator", "facilitator.client"):
        for handler in list(logging.getLogger(name).handlers):
            handler.close()
            logging.getLogger(name).removeHandler(handler)
    os.environ.pop("FACILITATOR_LOG_DIR", None)
    shutil.rmtree(LOGS, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
