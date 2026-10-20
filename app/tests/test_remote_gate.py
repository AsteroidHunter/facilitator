"""The gate in front of every request that comes through the agent door
(remote_link.RemoteGate), with server.py's own answers to what it asks and
stand-ins for what lies behind it, so each case reads as let through,
answered by the gate, or refused.

  keys      an agent key works only for its own lane: on the routes that name
            a lane by owner=, on the routes that name a card by box=, and for
            its own lane's state; a missing, wrong or replaced key is 401, and
            so is the server's own key on an agent's route
  routes    anything outside the agent's routes is 403, the board's reading,
            the files, the magic box, the folder routes and the Mac's own
            remote routes among them
  door      the setup program needs no key and is the skill's own; a pairing
            code trades for a server key once and a wrong one is 401; the
            link's poll needs the server's key, and an agent's key or none is
            401
  join      the server's key gives the lane its path names a fresh key, a
            wrong one is 401, a lane with a listener or a held card gets no
            key, and a join sees only its own server's lanes
  marks     a request through the door is never local and never the phone's;
            one on the board's own ports passes to the board's guards
            untouched and never straight to the routes; a connection on the
            door from outside the tailnet is cut before it is read
  logs      no key, server key, code or hash of one appears in the log, at debug

server.py is loaded, never run, with its log in a temporary folder.

    python3 -B -m unittest tests/test_remote_gate.py
"""

import asyncio
import importlib.util
import json
import logging
import os
import shutil
import socket
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLONE = HERE.parent.parent
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
    """What lies behind the gate: whatever reaches it is answered 200 and
    kept, by name."""

    def __init__(self, name):
        self.name = name
        self.scopes = []

    async def __call__(self, scope, receive, send):
        self.scopes.append(scope)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": json.dumps({"reached": self.name}).encode()})


def call(app, method, path, query="", key=None, body=b"", door=True, raw=False):
    headers = [(b"host", b"100.101.102.103:8870")]
    if key is not None:
        headers.append((b"authorization", b"Bearer " + key.encode()))
    scope = {"type": "http", "method": method, "path": path, "query_string": query.encode(),
             "headers": headers,
             "server": remote_link.SERVER_MARK if door else ("127.0.0.1", server.PORT)}
    sent = []
    given = [False]

    async def receive():
        if not given[0]:
            given[0] = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.sleep(3600)

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    status = sent[0]["status"]
    data = b"".join(m.get("body", b"") for m in sent[1:])
    if raw:
        return status, data
    return status, json.loads(data) if data else None


class Gate(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp(prefix="rg-", dir="/tmp"))
        self.server_key = remote_link.new_key()
        self.other_key = remote_link.new_key()
        remote_link.Store(self.data).save_servers([
            {"id": "lab", "name": "lab", "home": "/home/you", "top": "/home/you",
             "key": remote_link.digest(self.server_key)},
            {"id": "farm", "name": "farm", "home": "/home/you", "top": "/home/you",
             "key": remote_link.digest(self.other_key)}])
        server._remote = remote_link.Remote(self.data, CLONE)
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
        self.outer = Seen("guards")
        self.routes = Seen("routes")
        self.gate = remote_link.RemoteGate(self.outer, server._RemoteBoard(), routes=self.routes)
        self.demo = server._remote.mint("demo", "lab")
        self.notes = server._remote.mint("notes", "lab")

    def tearDown(self):
        if server._remote is not None:
            server._remote.stop()
        server._remote = None
        shutil.rmtree(self.data, ignore_errors=True)

    def reached(self, *args, **kw):
        before = len(self.routes.scopes)
        status, said = call(self.gate, *args, **kw)
        return status == 200 and said == {"reached": "routes"} and len(self.routes.scopes) == before + 1

    def nothing_behind(self):
        self.assertEqual((self.routes.scopes, self.outer.scopes), ([], []))

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
        # /note and /progress go through only so the board itself can refuse
        # them in words that say to send progress as a normal /reply under /working
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
        self.assertEqual(self.routes.scopes[-1]["facilitator.remote"], {"lane": "demo", "server": "lab"})
        self.assertEqual(self.outer.scopes, [])   # never through the Mac's guard or the phone's gate

    def test_a_missing_wrong_or_replaced_key_is_refused(self):
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo")[0], 401)
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key="wrong")[0], 401)
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key=self.server_key)[0], 401)
        fresh = server._remote.mint("demo", "lab")
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key=self.demo)[0], 401)
        self.assertTrue(self.reached("GET", "/wait", "owner=demo", key=fresh))
        self.assertEqual(len(self.routes.scopes), 1)

    def test_the_lanes_own_state(self):
        server._state["busy"]["demo"] = "m1"
        server._state["ack"]["demo"] = {"box": "m1", "token": "t", "confirmed": True}
        status, said = call(self.gate, "GET", "/remote/lane", key=self.demo)
        self.assertEqual(status, 200)
        self.assertEqual(said["owner"], "demo")
        self.assertEqual(said["busy"], "m1")
        self.assertTrue(said["confirmed"])
        self.assertFalse(said["listening"])
        self.nothing_behind()   # answered by the gate itself

    # -- routes
    def test_nothing_outside_the_agents_routes(self):
        for method, path in (("GET", "/state"), ("GET", "/m/state"), ("GET", "/navfile"),
                             ("GET", "/navfiles"), ("GET", "/laneimg/demo/a.png"), ("POST", "/magic"),
                             ("GET", "/dirs"), ("GET", "/machines"), ("POST", "/mkdir"), ("POST", "/project"),
                             ("POST", "/remote/pair/new"), ("POST", "/remote/forget"), ("GET", "/remote/servers"),
                             ("POST", "/send"), ("POST", "/done"), ("POST", "/close"), ("GET", "/uploads/x.png"),
                             ("GET", "/"), ("GET", "/m"), ("POST", "/settings"), ("GET", "/log"),
                             ("GET", "/thread"), ("GET", "/remote/pair"), ("POST", "/remote/setup")):
            with self.subTest(route=path):
                self.assertEqual(call(self.gate, method, path, "owner=demo&box=m1", key=self.demo)[0], 403)
                self.assertEqual(call(self.gate, method, path, "owner=demo&box=m1")[0], 401)
        self.nothing_behind()

    # -- the door's own routes
    def test_the_setup_program_needs_no_key_and_is_the_skills_own(self):
        status, body = call(self.gate, "GET", "/remote/setup", raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(body, (CLONE / remote_link.SETUP).read_bytes())
        self.nothing_behind()

    def test_a_pairing_code_trades_for_a_server_key_once(self):
        code = server._remote.new_code("bench")
        body = json.dumps({"host": "x", "home": "/home/you", "top": "/home/you"}).encode()
        self.assertEqual(call(self.gate, "POST", "/remote/pair", key="WRONG-WRONG-WRNG", body=body)[0], 401)
        self.assertEqual(call(self.gate, "POST", "/remote/pair", body=body)[0], 401)
        status, said = call(self.gate, "POST", "/remote/pair", key=code, body=body)
        self.assertEqual(status, 200)
        self.assertEqual((said["server"], said["name"]), ("bench", "bench"))
        self.assertEqual(server._remote.server_of_key(said["key"])["id"], "bench")
        self.assertEqual(call(self.gate, "POST", "/remote/pair", key=code, body=body)[0], 401)
        self.nothing_behind()

    def test_the_links_poll_needs_the_servers_key(self):
        body = json.dumps({"answers": []}).encode()
        status, said = call(self.gate, "POST", "/remote/link", "hold=0", key=self.server_key, body=body)
        self.assertEqual((status, said), (200, {"asks": []}))
        self.assertTrue(server._remote.is_up("lab"))
        for key in (None, "wrong", self.demo):
            with self.subTest(key=key):
                self.assertEqual(call(self.gate, "POST", "/remote/link", "hold=0", key=key, body=body)[0], 401)
        self.assertEqual(call(self.gate, "POST", "/remote/link", "hold=0", key=self.server_key, body=b"[")[0], 400)
        self.nothing_behind()

    # -- join
    def join(self, body, key=None):
        return call(self.gate, "POST", "/remote/join", key=self.server_key if key is None else key,
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
        said = self.join({"path": "/home/you/demo"}, key=self.other_key)[1]
        self.assertEqual(said["owner"], "crops")
        said = self.join({"board": "mine"})[1]
        self.assertEqual(said["status"], "project_unknown")
        self.assertNotIn("key", said)
        self.assertEqual(sorted(said["available"]), ["demo", "notes"])

    def test_a_wrong_server_key_is_refused(self):
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
    def test_a_door_request_is_never_local_or_the_phones(self):
        scope = {"server": remote_link.SERVER_MARK,
                 "headers": [(b"host", b"127.0.0.1:%d" % server.PORT)]}
        self.assertEqual(server._local_request(scope), (False, False))
        self.assertFalse(server._via_gate(scope))

    def test_a_request_on_the_boards_own_ports_passes_to_its_guards(self):
        status, said = call(self.gate, "GET", "/state", door=False)
        self.assertEqual((status, said), (200, {"reached": "guards"}))
        self.assertEqual(self.routes.scopes, [])
        self.assertNotIn("facilitator.remote", self.outer.scopes[-1])
        # a key on the board's own port means nothing to the gate
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key=self.demo, door=False)[1],
                         {"reached": "guards"})

    def test_a_board_keeping_no_servers_refuses_the_door(self):
        server._remote.stop()
        server._remote = None
        self.assertEqual(call(self.gate, "GET", "/wait", "owner=demo", key=self.demo)[0], 503)

    # -- logs
    def test_no_key_or_code_reaches_the_log(self):
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
        server._remote.note = lambda kind, **fields: server._info(kind, **fields)
        code = server._remote.new_code()
        try:
            said = self.join({"path": "/home/you/demo"})[1]
            call(self.gate, "GET", "/wait", "owner=notes", key=said["key"])
            call(self.gate, "GET", "/state", key=said["key"])
            call(self.gate, "GET", "/wait", "owner=demo", key="made-up-key")
            self.join({"path": "/x"}, key="made-up-server-key")
            body = json.dumps({"host": "x", "home": "/home/you", "top": "/home/you"}).encode()
            call(self.gate, "POST", "/remote/pair", key="MADE-UPCO-DEXX", body=body)
            paired = call(self.gate, "POST", "/remote/pair", key=code, body=body)[1]
            call(self.gate, "POST", "/remote/link", "hold=0", key=paired["key"], body=b'{"answers": []}')
            server._remote.status()
        finally:
            log.removeHandler(handler)
            log.setLevel(was)
        for handler in logging.getLogger("facilitator").handlers:
            handler.flush()
        text = caught.getvalue() + "".join(p.read_text() for p in Path(_logs).glob("*") if p.is_file())
        self.assertIn("remoterefused", text)
        self.assertIn("remotejoin", text)
        self.assertIn("remotepaired", text)
        for secret in (self.server_key, self.other_key, self.demo, self.notes, said["key"], paired["key"],
                       "made-up-key", "made-up-server-key", code, code.replace("-", ""), "MADE-UPCO-DEXX"):
            self.assertNotIn(secret, text)
            self.assertNotIn(remote_link.digest(secret), text)


class FakeTransport:
    """Enough of a transport for the board's protocol to take a connection:
    its own end on a real socket, and a peer named here."""

    def __init__(self, sock, peer):
        self.sock, self.peer, self.aborted = sock, peer, False

    def get_extra_info(self, name, default=None):
        return {"socket": self.sock, "sockname": self.sock.getsockname(), "peername": self.peer}.get(name, default)

    def abort(self):
        self.aborted = True

    def close(self):
        self.aborted = True

    def is_closing(self):
        return self.aborted


class DoorConnections(unittest.TestCase):
    """BoardProtocol taking a connection on the door and on the board's own
    port, with the door's port set to a socket of this test's."""

    def setUp(self):
        import uvicorn
        from uvicorn.server import ServerState
        self.loop = asyncio.new_event_loop()
        config = uvicorn.Config(app=Seen("x"), http=server.BoardProtocol, lifespan="off")
        config.load()
        self.make = lambda: server.BoardProtocol(config=config, server_state=ServerState(), app_state={},
                                                 _loop=self.loop)
        self.door = socket.socket()
        self.door.bind(("127.0.0.1", 0))
        self.other = socket.socket()
        self.other.bind(("127.0.0.1", 0))
        self.saved = server.DOOR_PORT, server.DOOR_LOOPBACK
        server.DOOR_PORT, server.DOOR_LOOPBACK = self.door.getsockname()[1], False

    def tearDown(self):
        server.DOOR_PORT, server.DOOR_LOOPBACK = self.saved
        self.door.close()
        self.other.close()
        self.loop.close()

    def take(self, sock, peer):
        proto, transport = self.make(), FakeTransport(sock, peer)
        proto.connection_made(transport)
        if proto._first_timer is not None:
            proto._first_timer.cancel()
        return proto, transport

    def test_a_door_connection_from_the_tailnet_is_marked(self):
        proto, transport = self.take(self.door, ("100.64.1.2", 50000))
        self.assertFalse(transport.aborted)
        self.assertEqual(proto.server, remote_link.SERVER_MARK)

    def test_a_door_connection_from_outside_the_tailnet_is_cut_unread(self):
        for peer in ("192.168.1.30", "10.0.0.9", "8.8.8.8", "127.0.0.1"):
            with self.subTest(peer=peer):
                proto, transport = self.take(self.door, (peer, 50000))
                self.assertTrue(transport.aborted)
                self.assertNotEqual(proto.server, remote_link.SERVER_MARK)

    def test_a_loopback_door_is_for_a_test_board_alone(self):
        server.DOOR_LOOPBACK = True
        proto, transport = self.take(self.door, ("127.0.0.1", 50000))
        self.assertFalse(transport.aborted)
        self.assertEqual(proto.server, remote_link.SERVER_MARK)

    def test_a_connection_on_another_port_is_the_boards_own(self):
        proto, transport = self.take(self.other, ("127.0.0.1", 50000))
        self.assertFalse(transport.aborted)
        self.assertEqual(proto.server, ("127.0.0.1", self.other.getsockname()[1]))


class DoorPort(unittest.TestCase):
    """Where the door listens, read once at the board's start."""

    def test_a_test_board_has_a_door_only_when_named_and_only_on_loopback(self):
        saved = {k: os.environ.get(k) for k in ("FACILITATOR_TEST_PORT", "FACILITATOR_TEST_AGENT_PORT")}
        try:
            os.environ["FACILITATOR_TEST_PORT"] = str(server.PORT)
            os.environ.pop("FACILITATOR_TEST_AGENT_PORT", None)
            self.assertEqual(server._door_port(), (None, True))
            os.environ["FACILITATOR_TEST_AGENT_PORT"] = "40123"
            self.assertEqual(server._door_port(), (40123, True))
            # never one of the board's own pair, which the door is told apart from
            for taken in (server.PORT, server.BRIDGE_PORT):
                os.environ["FACILITATOR_TEST_AGENT_PORT"] = str(taken)
                self.assertEqual(server._door_port(), (None, False))
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


if __name__ == "__main__":
    unittest.main()
