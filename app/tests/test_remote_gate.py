"""The gate in front of every request that comes through a server's link
(remote_link.RemoteGate), with server.py's own answers to what it asks and a
stand-in for the routes behind it, so each case reads as let through or
refused.

  keys      an agent key works only for its own lane: on the routes that name
            a lane by owner=, on the routes that name a card by box=, and for
            its own lane's state; a missing, wrong or replaced key is 401
  routes    anything outside the agent's routes is 403, the board's reading,
            the files, the magic box and the folder routes among them
  join      the server's join key gives the lane its path names a fresh key,
            a wrong one is 401, a lane with a listener or a held card gets no
            key, and a join sees only its own server's lanes
  marks     a request on the socket is never local and never the phone's; a
            request over TCP passes the gate untouched
  logs      no key, join key or hash of one appears in the log, at debug

server.py is loaded, never run, with its log in a temporary folder.

    python3 -B -m unittest tests/test_remote_gate.py
"""

import asyncio
import importlib.util
import json
import logging
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


def setUpModule():
    global server, remote_link, _logs
    _logs = tempfile.mkdtemp(prefix="facil-remote-log-")
    os.environ["FACILITATOR_LOG_DIR"] = _logs
    os.environ["FACILITATOR_LOG_LEVEL"] = "debug"
    spec = importlib.util.spec_from_file_location("facilitator_server_remote_gate", HERE.parent / "server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    remote_link = server.remote_link
    assert remote_link is not None, "server.py did not find remote_link.py beside it"


def tearDownModule():
    for name in ("facilitator", "facilitator.client"):
        for handler in list(logging.getLogger(name).handlers):
            handler.close()
            logging.getLogger(name).removeHandler(handler)
    for name in ("FACILITATOR_LOG_DIR", "FACILITATOR_LOG_LEVEL"):
        os.environ.pop(name, None)
    shutil.rmtree(_logs, ignore_errors=True)


class Seen:
    """The routes behind the gate: whatever reaches them is answered 200 and
    kept."""

    def __init__(self):
        self.scopes = []

    async def __call__(self, scope, receive, send):
        self.scopes.append(scope)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b'{"reached": true}'})


def call(app, method, path, query="", key=None, body=b"", on_socket=True):
    headers = [(b"host", b"localhost")]
    if key is not None:
        headers.append((b"authorization", b"Bearer " + key.encode()))
    scope = {"type": "http", "method": method, "path": path, "query_string": query.encode(),
             "headers": headers,
             "server": remote_link.SERVER_MARK if on_socket else ("127.0.0.1", server.PORT)}
    sent = []

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    status = sent[0]["status"]
    raw = b"".join(m.get("body", b"") for m in sent[1:])
    return status, json.loads(raw) if raw else None


class Gate(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp(prefix="rg-", dir="/tmp"))
        self.join_key = remote_link.new_key()
        self.other_join = remote_link.new_key()
        remote_link.Store(self.data).save_servers([
            {"id": "lab", "name": "lab", "dest": "you@lab", "home": "/home/you",
             "python": "/usr/bin/python3", "join": remote_link.digest(self.join_key)},
            {"id": "farm", "name": "farm", "dest": "you@farm", "home": "/home/you",
             "python": "/usr/bin/python3", "join": remote_link.digest(self.other_join)}])
        server._remote = remote_link.Remote(self.data, links=False)
        server._remote.reload()
        server._state = {
            "projects": [
                {"id": "demo", "name": "demo", "dir": "/home/you/demo", "server": "lab"},
                {"id": "notes", "name": "notes", "dir": "/home/you/notes", "server": "lab",
                 "git": "/home/you/notes/.git"},
                {"id": "crops", "name": "crops", "dir": "/home/you/demo", "server": "farm"},
                {"id": "mine", "name": "mine", "dir": "/Users/you/mine"}],
            "boxes": [{"id": "m1", "owner": "demo"}, {"id": "m2", "owner": "notes"},
                      {"id": "m3", "owner": "mine"}, {"id": "m4", "owner": "facilitator"}],
            "busy": {"demo": None, "notes": None, "crops": None, "mine": None, "facilitator": None},
            "ack": {},
        }
        for lane in ("demo", "notes", "crops", "mine"):
            server._register_owner(lane)
            server._waiters[lane] = 0
            server._last_wait[lane] = 0.0
        self.seen = Seen()
        self.gate = remote_link.RemoteGate(self.seen, server._RemoteBoard())
        self.demo = server._remote.mint("demo", "lab")
        self.notes = server._remote.mint("notes", "lab")

    def tearDown(self):
        server._remote = None
        shutil.rmtree(self.data, ignore_errors=True)

    def reached(self, *args, **kw):
        before = len(self.seen.scopes)
        status, _ = call(self.gate, *args, **kw)
        return status == 200 and len(self.seen.scopes) == before + 1

    # -- keys
    def test_a_key_works_its_own_lane_by_owner(self):
        for method, path in (("GET", "/wait"), ("POST", "/ack"), ("GET", "/fresh"),
                             ("GET", "/unread"), ("POST", "/create")):
            with self.subTest(route=path):
                self.assertTrue(self.reached(method, path, "owner=demo&timeout=1", key=self.demo))
                self.assertEqual(call(self.gate, method, path, "owner=notes", key=self.demo)[0], 403)
                self.assertEqual(call(self.gate, method, path, "owner=mine", key=self.demo)[0], 403)
                self.assertEqual(call(self.gate, method, path, "owner=facilitator", key=self.demo)[0], 403)
                # no owner would be the facilitator lane's, and two would be read as the first
                self.assertEqual(call(self.gate, method, path, "", key=self.demo)[0], 403)
                self.assertEqual(call(self.gate, method, path, "owner=demo&owner=notes", key=self.demo)[0], 403)

    def test_a_key_works_its_own_lanes_cards_by_box(self):
        for path in ("/reply", "/note", "/working", "/ping", "/title", "/testing", "/park",
                     "/progress", "/context"):
            with self.subTest(route=path):
                self.assertTrue(self.reached("POST", path, "box=m1", key=self.demo))
                for box in ("m2", "m3", "m4", "nope"):
                    self.assertEqual(call(self.gate, "POST", path, "box=" + box, key=self.demo)[0], 403)
                self.assertEqual(call(self.gate, "POST", path, "box=m1&box=m2", key=self.demo)[0], 403)
        self.assertTrue(self.reached("POST", "/reply", "box=m2", key=self.notes))

    def test_what_reaches_the_routes_names_the_lane(self):
        self.assertTrue(self.reached("GET", "/wait", "owner=demo", key=self.demo))
        self.assertEqual(self.seen.scopes[-1]["facilitator.remote"], {"lane": "demo", "server": "lab"})

    def test_a_missing_wrong_or_replaced_key_is_refused(self):
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo")[0], 401)
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key="wrong")[0], 401)
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key=self.join_key)[0], 401)
        fresh = server._remote.mint("demo", "lab")
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key=self.demo)[0], 401)
        self.assertTrue(self.reached("GET", "/wait", "owner=demo", key=fresh))
        self.assertEqual(len(self.seen.scopes), 1)

    def test_the_lanes_own_state(self):
        server._state["busy"]["demo"] = "m1"
        server._state["ack"]["demo"] = {"box": "m1", "token": "t", "confirmed": True}
        status, said = call(self.gate, "GET", "/remote/lane", key=self.demo)
        self.assertEqual(status, 200)
        self.assertEqual(said["owner"], "demo")
        self.assertEqual(said["busy"], "m1")
        self.assertTrue(said["confirmed"])
        self.assertFalse(said["listening"])
        self.assertEqual(self.seen.scopes, [])   # answered by the gate itself

    # -- routes
    def test_nothing_outside_the_agents_routes(self):
        for method, path in (("GET", "/state"), ("GET", "/m/state"), ("GET", "/navfile"),
                             ("GET", "/navfiles"), ("GET", "/laneimg/demo/a.png"), ("POST", "/magic"),
                             ("GET", "/dirs"), ("GET", "/machines"), ("POST", "/mkdir"), ("POST", "/project"),
                             ("POST", "/remote/reload"), ("POST", "/send"), ("POST", "/done"),
                             ("POST", "/close"), ("GET", "/uploads/x.png"), ("GET", "/"), ("GET", "/m"),
                             ("POST", "/settings"), ("GET", "/log"), ("GET", "/thread")):
            with self.subTest(route=path):
                self.assertEqual(call(self.gate, method, path, "owner=demo&box=m1", key=self.demo)[0], 403)
        self.assertEqual(self.seen.scopes, [])

    # -- join
    def join(self, body, key=None):
        return call(self.gate, "POST", "/remote/join", key=self.join_key if key is None else key,
                    body=json.dumps(body).encode())

    def test_a_join_gives_the_lane_its_path_names_a_new_key(self):
        status, said = self.join({"path": "/home/you/demo/src"})
        self.assertEqual(status, 200)
        self.assertEqual((said["status"], said["owner"], said["server"]), ("ready", "demo", "lab"))
        self.assertEqual(server._remote.lane_of(said["key"]), ("demo", "lab"))
        self.assertIsNone(server._remote.lane_of(self.demo))   # the lane's old key is over

    def test_a_join_by_repository_and_by_name(self):
        self.assertEqual(self.join({"path": "/home/you/wt/x", "git": "/home/you/notes/.git"})[1]["owner"], "notes")
        self.assertEqual(self.join({"board": "notes"})[1]["owner"], "notes")

    def test_a_join_sees_only_its_own_servers_lanes(self):
        said = self.join({"path": "/home/you/demo"}, key=self.other_join)[1]
        self.assertEqual(said["owner"], "crops")
        said = self.join({"board": "mine"})[1]
        self.assertEqual(said["status"], "project_unknown")
        self.assertNotIn("key", said)
        self.assertEqual(sorted(said["available"]), ["demo", "notes"])

    def test_a_wrong_join_key_is_refused(self):
        self.assertEqual(self.join({"path": "/home/you/demo"}, key="wrong")[0], 401)
        self.assertEqual(self.join({"path": "/home/you/demo"}, key=self.demo)[0], 401)
        self.assertEqual(call(self.gate, "POST", "/remote/join", body=b"{}")[0], 401)

    def test_a_lane_in_use_gets_no_key(self):
        server._waiters["demo"] = 1
        said = self.join({"path": "/home/you/demo"})[1]
        self.assertEqual(said["status"], "listener_present")
        self.assertNotIn("key", said)
        self.assertEqual(server._remote.lane_of(self.demo), ("demo", "lab"))   # the live agent keeps its key
        server._waiters["demo"] = 0
        server._state["busy"]["demo"] = "m1"
        said = self.join({"path": "/home/you/demo"})[1]
        self.assertEqual((said["status"], said["box"]), ("claim_held", "m1"))
        self.assertNotIn("key", said)

    # -- marks
    def test_a_socket_request_is_never_local_or_the_phones(self):
        scope = {"server": remote_link.SERVER_MARK,
                 "headers": [(b"host", b"127.0.0.1:%d" % server.PORT)]}
        self.assertEqual(server._local_request(scope), (False, False))
        self.assertFalse(server._via_gate(scope))

    def test_a_request_over_tcp_passes_untouched(self):
        self.assertTrue(self.reached("GET", "/state", on_socket=False))
        self.assertNotIn("facilitator.remote", self.seen.scopes[-1])

    def test_a_board_running_no_links_refuses_the_socket(self):
        server._remote = None
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key=self.demo)[0], 503)

    # -- logs
    def test_no_key_reaches_the_log(self):
        # the lines as the board's own formatter writes them, caught here: the
        # logger is shared by every test file loaded in one run, and another's
        # teardown may take the board's file handler away
        import io
        caught = io.StringIO()
        handler = logging.StreamHandler(caught)
        handler.setFormatter(server.JsonLineFormatter())
        log = logging.getLogger("facilitator")
        was = log.level
        log.addHandler(handler)
        log.setLevel(logging.DEBUG)
        try:
            said = self.join({"path": "/home/you/demo"})[1]
            call(self.gate, "GET", "/wait", "owner=notes", key=said["key"])
            call(self.gate, "GET", "/state", key=said["key"])
            call(self.gate, "GET", "/wait", "owner=demo", key="made-up-key")
            self.join({"path": "/x"}, key="made-up-join")
        finally:
            log.removeHandler(handler)
            log.setLevel(was)
        for handler in logging.getLogger("facilitator").handlers:
            handler.flush()
        text = caught.getvalue() + "".join(p.read_text() for p in Path(_logs).glob("*") if p.is_file())
        self.assertIn("remoterefused", text)
        self.assertIn("remotejoin", text)
        for secret in (self.join_key, self.other_join, self.demo, self.notes, said["key"], "made-up-key", "made-up-join"):
            self.assertNotIn(secret, text)
            self.assertNotIn(remote_link.digest(secret), text)


if __name__ == "__main__":
    unittest.main()
