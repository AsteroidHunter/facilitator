"""remote_link.py on its own: the records and keys it keeps, where the agent
door may listen, the fade's timing, pairing codes, and the questions the
board asks a server's link and the answers it takes back.

  records   servers.json and keys.json are the owner's alone, hold hashes and
            never a key, and a record without a server key (as the ssh link
            kept them) is not read
  addresses the door takes this Mac's tailnet addresses from Tailscale's
            status and nothing else: no wildcard, no network the Mac is on,
            loopback only for a test board, and a peer only from the tailnet
  fade      unheard for 29.9 seconds is not faded, 30 is; a poll held is up,
            one that ended is up for GRACE more; before any poll the count
            starts with the board
  pairing   a code works once, runs out, is refused when wrong, and ten wrong
            codes in a minute shut pairing for the rest of it; a refused body
            leaves the code alone; pairing a name again keeps its record and
            replaces its key
  link      a question reaches a poll and its answer comes back; a server that
            is not connected, a question past its time and a question that is
            not one of the three are refused; an answer not in the picker's
            shape never reaches it
  keys      a minted key names its lane and server, a new key ends the lane's
            old one, a removed server's keys go
  lanes     which lane a join means

    python3 -B -m unittest tests/test_remote_link.py
"""

import asyncio
import json
import os
import shutil
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLONE = HERE.parent.parent
sys.path.insert(0, str(HERE.parent))
import remote_link  # noqa: E402


def scratch(prefix):
    return Path(tempfile.mkdtemp(prefix=prefix, dir="/tmp")).resolve()


def record(sid="lab", key="k", name=None, home="/home/you"):
    return {"id": sid, "name": name or sid, "home": home, "top": home, "key": remote_link.digest(key),
            "added": 1, "paired": 1}


STATUS = {"BackendState": "Running",
          "Self": {"TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1234", "192.168.1.20", "0.0.0.0", "::"]},
          "TailscaleIPs": ["100.1.1.1"]}


class Records(unittest.TestCase):
    def setUp(self):
        self.data = scratch("rl-data-")
        self.store = remote_link.Store(self.data)

    def tearDown(self):
        shutil.rmtree(self.data, ignore_errors=True)

    def test_servers_are_kept_for_the_owner_alone_and_checked_on_read(self):
        good = record()
        ssh_era = {"id": "old", "name": "old", "dest": "you@old", "home": "/home/you", "python": "/usr/bin/python3",
                   "join": "ab" * 32}
        self.store.save_servers([good, {"id": "Bad Id", "name": "x"}, {**good, "id": "rel", "home": "home/you"},
                                 {**good, "id": "nokey", "key": "not-a-hash"}, ssh_era])
        self.assertEqual([s["id"] for s in self.store.servers()], ["lab"])
        self.assertEqual(stat.S_IMODE(os.stat(self.store.servers_file).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.store.dir).st_mode), 0o700)

    def test_the_bundle_is_the_skill_the_runbook_and_the_docs(self):
        files = remote_link.bundle(CLONE)
        for rel in remote_link.BUNDLE:
            self.assertIn(rel, files)
        self.assertIn("docs/servers.md", files)
        self.assertEqual(files[".agents/skills/facilitator/scripts/link.py"][1], 0o700)
        self.assertEqual(files["app/RUNBOOK.md"][1], 0o600)
        self.assertFalse([rel for rel in files if rel.startswith("data") or "/data/" in rel])


class Addresses(unittest.TestCase):
    def test_tailscales_ranges_and_nothing_else(self):
        for good in ("100.64.0.0", "100.101.102.103", "100.127.255.255", "fd7a:115c:a1e0::1",
                     "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240", "::ffff:100.64.0.1"):
            with self.subTest(address=good):
                self.assertTrue(remote_link.on_tailnet(good))
        for bad in ("100.63.255.255", "100.128.0.0", "0.0.0.0", "::", "127.0.0.1", "::1", "192.168.1.20",
                    "10.0.0.4", "172.16.0.1", "8.8.8.8", "fd7a:115c:a1e1::1", "fe80::1", "", "lab", None):
            with self.subTest(address=bad):
                self.assertFalse(remote_link.on_tailnet(bad))

    def test_the_door_takes_only_the_macs_own_tailnet_addresses_while_tailscale_runs(self):
        self.assertEqual(remote_link.tailnet_addresses(STATUS), ["100.101.102.103", "fd7a:115c:a1e0::1234"])
        self.assertEqual(remote_link.tailnet_addresses({**STATUS, "BackendState": "Stopped"}), [])
        self.assertEqual(remote_link.tailnet_addresses({"BackendState": "Running", "TailscaleIPs": ["100.100.1.1"]}),
                         ["100.100.1.1"])
        self.assertEqual(remote_link.tailnet_addresses({"BackendState": "Running",
                                                        "Self": {"TailscaleIPs": ["192.168.1.2", "0.0.0.0"]}}), [])
        for junk in (None, [], "Running", {"BackendState": "Running", "Self": {"TailscaleIPs": "100.64.0.1"}}):
            with self.subTest(status=junk):
                self.assertEqual(remote_link.tailnet_addresses(junk), [])

    def test_the_door_never_listens_on_anything_but_the_tailnet(self):
        for bad in ("0.0.0.0", "::", "192.168.1.20", "10.0.0.4", "127.0.0.1", "::1", "100.128.0.1"):
            with self.subTest(address=bad):
                with self.assertRaises(ValueError):
                    remote_link.listen_door(bad, 0)
        # loopback, for a test board alone, and then exactly loopback
        sock = remote_link.listen_door("127.0.0.1", 0, loopback=True)
        try:
            self.assertEqual(sock.getsockname()[0], "127.0.0.1")
        finally:
            sock.close()
        with self.assertRaises(ValueError):
            remote_link.listen_door("0.0.0.0", 0, loopback=True)

    def test_where_the_door_wants_to_be(self):
        self.assertEqual(remote_link.Door(8870, loopback=True).wanted(), ["127.0.0.1"])
        self.assertEqual(remote_link.Door(8870, read_status=lambda: STATUS).wanted(),
                         ["100.101.102.103", "fd7a:115c:a1e0::1234"])
        self.assertIsNone(remote_link.Door(8870, read_status=lambda: None).wanted())   # keep what is open
        self.assertEqual(remote_link.Door(8870, read_status=lambda: {}).wanted(), [])  # no Tailscale here
        # with nothing to pair and nothing paired, nowhere at all
        asked = []
        idle = remote_link.Door(8870, read_status=lambda: asked.append(1) or STATUS, needed=lambda: False)
        self.assertEqual(idle.wanted(), [])
        self.assertEqual(asked, [])
        self.assertEqual(remote_link.Door(8870, loopback=True, needed=lambda: False).wanted(), [])

    def test_the_door_is_needed_while_a_server_is_paired_or_a_code_waits(self):
        data = scratch("rl-door-")
        try:
            remote = remote_link.Remote(data, CLONE)
            remote.reload()
            self.assertFalse(remote.needs_door())
            remote.new_code()
            self.assertTrue(remote.needs_door())
            for entry in remote._codes.values():
                entry["ends"] = time.monotonic() - 1
            self.assertFalse(remote.needs_door())
            remote_link.Store(data).save_servers([record()])
            remote.reload()
            self.assertTrue(remote.needs_door())
            remote.forget_server("lab")
            self.assertTrue(remote.needs_door())    # a while yet, for that server's link to hear it
            remote._forgot_until = time.monotonic() - 1
            self.assertFalse(remote.needs_door())
        finally:
            shutil.rmtree(data, ignore_errors=True)

    def test_a_peer_is_read_only_from_the_tailnet(self):
        self.assertTrue(remote_link.door_peer_ok("100.64.3.4"))
        self.assertTrue(remote_link.door_peer_ok("fd7a:115c:a1e0::9"))
        for bad in ("192.168.1.30", "10.1.2.3", "8.8.8.8", "127.0.0.1", None, ""):
            with self.subTest(peer=bad):
                self.assertFalse(remote_link.door_peer_ok(bad))
        self.assertTrue(remote_link.door_peer_ok("127.0.0.1", loopback=True))
        self.assertFalse(remote_link.door_peer_ok("192.168.1.30", loopback=True))


class Fade(unittest.TestCase):
    def test_a_server_fades_thirty_seconds_after_it_was_last_heard(self):
        ch = remote_link.Channel(record(), 1000.0)
        # before any poll, counted from the board's start, and never up
        self.assertEqual(ch.state(1001.0), {"name": "lab", "up": False, "faded": False})
        self.assertFalse(ch.state(1029.9)["faded"])
        self.assertTrue(ch.state(1030.0)["faded"])
        # a poll held is up, however long
        ch.heard, ch.held, ch.seen = True, 1, 2000.0
        self.assertEqual(ch.state(2100.0), {"name": "lab", "up": True, "faded": False})
        # one that ended is up for GRACE more, then down, then faded at 30
        ch.held, ch.seen = 0, 3000.0
        self.assertTrue(ch.state(3000.0 + remote_link.GRACE - 0.1)["up"])
        self.assertEqual(ch.state(3000.0 + remote_link.GRACE), {"name": "lab", "up": False, "faded": False})
        self.assertFalse(ch.state(3029.9)["faded"])
        self.assertTrue(ch.state(3030.0)["faded"])


class Loop:
    """An asyncio loop on a thread of its own, as the board's is, for polls."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def close(self):
        async def drain():
            # every poll still out ends with the Remote's stop; it is let finish
            others = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
            await asyncio.wait(others, timeout=5) if others else None
        self.run(drain()).result(timeout=10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
        self.loop.close()


class Board(unittest.TestCase):
    """A Remote with one server, as a board keeps it."""

    def setUp(self):
        self.data = scratch("rl-board-")
        remote_link.Store(self.data).save_servers([record("lab", "server-key")])
        self.remote = remote_link.Remote(self.data, CLONE)
        self.remote.reload()
        self.loop = Loop()

    def tearDown(self):
        self.remote.stop()
        self.loop.close()
        shutil.rmtree(self.data, ignore_errors=True)

    def poll(self, answers=None, hold=remote_link.HOLD, gone=None):
        async def one():
            return await self.remote.poll("lab", answers or [], gone or asyncio.Event(), hold)
        return self.loop.run(one())


class Pairing(Board):
    ASKED = {"host": "bob.example.org", "home": "/home/you", "top": "/data/home/you"}

    def test_a_code_works_once(self):
        code = self.remote.new_code()
        self.assertRegex(code, r"^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$")
        status, said = self.remote.pair(code.lower().replace("-", " "), self.ASKED)   # however it is typed
        self.assertEqual(status, 200, said)
        self.assertEqual((said["server"], said["name"]), ("bob-example-org", "bob.example.org"))
        self.assertEqual(self.remote.server_of_key(said["key"])["id"], "bob-example-org")
        self.assertIn(".agents/skills/facilitator/scripts/link.py", said["files"])
        saved = self.remote.store.servers_file.read_text()
        self.assertNotIn(said["key"], saved)
        rec = next(s for s in self.remote.store.servers() if s["id"] == "bob-example-org")
        self.assertEqual((rec["home"], rec["top"]), ("/home/you", "/data/home/you"))
        self.assertEqual(self.remote.pair(code, self.ASKED)[0], 401)

    def test_a_wrong_or_spent_code_is_refused(self):
        self.assertEqual(self.remote.pair("", self.ASKED)[0], 401)
        self.assertEqual(self.remote.pair("AAAA-BBBB-CCCC", self.ASKED)[0], 401)
        code = self.remote.new_code()
        for entry in self.remote._codes.values():
            entry["ends"] = time.monotonic() - 1   # its ten minutes are over
        self.assertEqual(self.remote.pair(code, self.ASKED)[0], 401)

    def test_ten_wrong_codes_shut_pairing_for_the_minute(self):
        code = self.remote.new_code()
        for _ in range(remote_link.PAIR_TRIES):
            self.assertEqual(self.remote.pair("WRONG-CODE-HERE", self.ASKED)[0], 401)
        status, said = self.remote.pair(code, self.ASKED)
        self.assertEqual(status, 429)
        self.assertIn("wait a minute", said["error"])
        self.remote._wrong = [t - 61 for t in self.remote._wrong]
        self.assertEqual(self.remote.pair(code, self.ASKED)[0], 200)   # the code was never spent

    def test_a_refused_body_leaves_the_code(self):
        code = self.remote.new_code()
        for bad in (None, [], {"home": "home/you", "top": "/x"}, {"home": "/h"}, {"home": "/h\n", "top": "/h"}):
            with self.subTest(body=bad):
                self.assertEqual(self.remote.pair(code, bad)[0], 400)
        self.assertEqual(self.remote.pair(code, self.ASKED)[0], 200)

    def test_a_name_given_on_the_mac_and_pairing_it_again(self):
        first = self.remote.pair(self.remote.new_code("Lab box"), self.ASKED)[1]
        self.assertEqual((first["server"], first["name"]), ("lab-box", "Lab box"))
        again = self.remote.pair(self.remote.new_code("lab BOX"), {**self.ASKED, "host": "elsewhere"})[1]
        self.assertEqual(again["server"], "lab-box")
        self.assertIsNone(self.remote.server_of_key(first["key"]))   # the old key is over
        self.assertEqual(self.remote.server_of_key(again["key"])["id"], "lab-box")
        self.assertEqual([s["id"] for s in self.remote.store.servers()].count("lab-box"), 1)
        # with no name given, the host name is the name, and a server already
        # known by it is that server, paired afresh
        other = self.remote.pair(self.remote.new_code(), {**self.ASKED, "host": "lab"})[1]
        self.assertEqual((other["server"], other["name"]), ("lab", "lab"))
        self.assertIsNone(self.remote.server_of_key("server-key"))

    def test_only_a_few_codes_wait_at_once(self):
        codes = [self.remote.new_code() for _ in range(remote_link.CODES_HELD + 3)]
        self.assertEqual(len(self.remote._codes), remote_link.CODES_HELD)
        self.assertEqual(self.remote.pair(codes[0], self.ASKED)[0], 401)   # the oldest went first
        self.assertEqual(self.remote.pair(codes[-1], self.ASKED)[0], 200)


LISTING = {"path": "/home/you", "name": "you", "short": "~", "top": "/home/you", "parent": None,
           "trail": [{"name": "you", "path": "/home/you"}],
           "dirs": [{"name": "app", "path": "/home/you/app", "modified": 1.5, "items": 3}],
           "more": 0, "cut": False, "unreadable": False}


class Questions(Board):
    def test_a_question_reaches_a_poll_and_its_answer_comes_back(self):
        held = self.poll()
        time.sleep(0.2)   # the poll is waiting now
        got = {}
        asker = threading.Thread(target=lambda: got.update(r=self.remote.list_dirs("lab", "", "")))
        asker.start()
        asks = held.result(timeout=5)
        self.assertEqual([(a["op"], a["args"]) for a in asks], [("dirs", ["", ""])])
        # the next poll carries the answer, with a field no page should see
        nxt = self.poll([{"id": asks[0]["id"], "answer": {**LISTING, "html": "<b>x</b>"}}], hold=0)
        asker.join(timeout=5)
        self.assertEqual(nxt.result(timeout=5), [])
        status, answer = got["r"]
        self.assertEqual(status, 200)
        self.assertEqual(answer["machine"], "lab")
        self.assertEqual(answer["dirs"], LISTING["dirs"])
        self.assertNotIn("html", answer)

    def test_a_server_that_is_not_connected_is_not_asked(self):
        self.assertEqual(self.remote.list_dirs("lab", "", ""), (400, {"error": "lab is not connected"}))
        self.assertEqual(self.remote.list_dirs("nope", "", ""), (400, {"error": "no such machine"}))
        self.assertFalse(self.remote.machines()[0]["online"])

    def test_a_question_past_its_time(self):
        held = self.poll(hold=3)
        time.sleep(0.2)
        status, said = self.remote.ask("lab", "dirs", "", "", timeout=0.5)
        self.assertEqual((status, said), (400, {"error": "lab took too long to answer"}))
        held.result(timeout=5)

    def test_only_the_three_questions(self):
        self.poll(hold=2)
        time.sleep(0.2)
        self.assertEqual(self.remote.ask("lab", "run", "rm -rf ~")[0], 400)

    def test_an_error_from_the_server_and_an_answer_out_of_shape(self):
        for answer, want in (({"id": None, "error": "outside the home folder"}, (400, {"error": "outside the home folder"})),
                             ({"id": None, "answer": {"path": 3}}, (400, {"error": "the server's answer could not be read"}))):
            with self.subTest(answer=answer):
                held = self.poll()
                time.sleep(0.2)
                got = {}
                asker = threading.Thread(target=lambda: got.update(r=self.remote.list_dirs("lab", "/", "")))
                asker.start()
                asks = held.result(timeout=5)
                self.poll([{**answer, "id": asks[0]["id"]}], hold=0).result(timeout=5)
                asker.join(timeout=5)
                self.assertEqual(got["r"], want)

    def test_one_servers_poll_cannot_answer_anothers_question(self):
        remote_link.Store(self.data).save_servers([record("lab", "server-key"), record("farm", "farm-key")])
        self.remote.reload()
        held = self.poll()
        time.sleep(0.2)
        got = {}
        asker = threading.Thread(target=lambda: got.update(r=self.remote.describe("lab", "/home/you/app")))
        asker.start()
        asks = held.result(timeout=5)

        async def farm():
            return await self.remote.poll("farm", [{"id": asks[0]["id"], "answer": {"path": "/x", "name": "x"}}],
                                          asyncio.Event(), 0)
        self.loop.run(farm()).result(timeout=5)
        self.assertNotIn("r", got)
        self.poll([{"id": asks[0]["id"], "answer": {"path": "/home/you/app", "name": "app", "git": None}}],
                  hold=0).result(timeout=5)
        asker.join(timeout=5)
        self.assertEqual(got["r"], (200, {"path": "/home/you/app", "name": "app", "git": None}))

    def test_a_poll_goes_home_when_its_peer_does_or_the_board_stops(self):
        gone = asyncio.Event()
        held = self.poll(gone=gone)
        time.sleep(0.2)
        self.assertTrue(self.remote.is_up("lab"))
        self.loop.loop.call_soon_threadsafe(gone.set)
        self.assertEqual(held.result(timeout=3), [])
        held = self.poll()
        time.sleep(0.2)
        began = time.monotonic()
        self.remote.stop()
        self.assertEqual(held.result(timeout=3), [])
        self.assertLess(time.monotonic() - began, 2)


class Shapes(unittest.TestCase):
    def test_the_pickers_shape_only(self):
        self.assertEqual(remote_link.clean_listing(LISTING), LISTING)
        for bad in (None, [], {**LISTING, "path": 3}, {**LISTING, "dirs": "x"},
                    {**LISTING, "dirs": [{"name": "a", "path": "/a", "modified": "x", "items": 1}]},
                    {**LISTING, "dirs": [{"name": "a", "path": "/a", "modified": 1, "items": -1}]},
                    {**LISTING, "trail": [{"name": 1, "path": "/"}]}, {**LISTING, "more": True},
                    {**LISTING, "dirs": [{**LISTING["dirs"][0]}] * (remote_link.ROWS_MAX + 1)}):
            with self.subTest(answer=str(bad)[:60]):
                self.assertIsNone(remote_link.clean_listing(bad))
        self.assertEqual(remote_link.clean_made({"ok": True, "name": "n", "path": "/p", "x": 1}),
                         {"ok": True, "name": "n", "path": "/p"})
        self.assertIsNone(remote_link.clean_described({"path": "rel", "name": "x"}))
        self.assertIsNone(remote_link.clean_described({"path": "/p", "name": "x", "git": "rel"}))


class Keys(unittest.TestCase):
    def setUp(self):
        self.data = scratch("rl-keys-")
        remote_link.Store(self.data).save_servers([record("lab", "server-key", home="/home/you")])
        self.remote = remote_link.Remote(self.data, CLONE)
        self.remote.reload()

    def tearDown(self):
        shutil.rmtree(self.data, ignore_errors=True)

    def test_a_server_key_names_its_server(self):
        self.assertEqual(self.remote.server_of_key("server-key")["id"], "lab")
        self.assertIsNone(self.remote.server_of_key("not it"))
        self.assertIsNone(self.remote.server_of_key(""))

    def test_a_minted_key_names_its_lane_and_the_file_holds_only_its_hash(self):
        key = self.remote.mint("demo", "lab")
        self.assertEqual(self.remote.lane_of(key), ("demo", "lab"))
        self.assertIsNone(self.remote.lane_of(key + "x"))
        self.assertIsNone(self.remote.lane_of("server-key"))
        held = self.remote.store.keys_file.read_text()
        self.assertNotIn(key, held)
        self.assertIn(remote_link.digest(key), held)
        self.assertEqual(stat.S_IMODE(os.stat(self.remote.store.keys_file).st_mode), 0o600)

    def test_a_new_key_ends_the_lanes_old_one(self):
        first = self.remote.mint("demo", "lab")
        second = self.remote.mint("demo", "lab")
        self.assertIsNone(self.remote.lane_of(first))
        self.assertEqual(self.remote.lane_of(second), ("demo", "lab"))

    def test_a_server_is_listed_for_the_picker_at_its_real_home(self):
        recs = self.remote.store.servers()
        self.remote.store.save_servers([{**recs[0], "home": "/home/you", "top": "/data/home/you"}])
        self.remote.reload()
        machine = self.remote.machines()[0]
        self.assertEqual((machine["id"], machine["kind"], machine["online"]), ("lab", "server", False))
        self.assertEqual((machine["top"], machine["home"]), ("/data/home/you", "/data/home/you"))
        self.assertEqual(machine["places"], [{"id": "home", "name": "you", "path": "/data/home/you"}])

    def test_a_forgotten_servers_keys_go(self):
        key = self.remote.mint("demo", "lab")
        self.assertTrue(self.remote.forget_server("lab"))
        self.assertFalse(self.remote.forget_server("lab"))
        self.assertIsNone(self.remote.lane_of(key))
        self.assertIsNone(self.remote.server_of_key("server-key"))
        self.assertEqual(self.remote.store.keys(), {})
        self.assertEqual(self.remote.status(), {})


class Lanes(unittest.TestCase):
    PROJECTS = [{"id": "app", "name": "App", "dir": "/home/you/app", "git": "/home/you/app/.git"},
                {"id": "app-web", "name": "Web", "dir": "/home/you/app/web"},
                {"id": "notes", "name": "Notes", "dir": "/home/you/notes"}]

    def test_the_deepest_folder_holding_the_path_wins(self):
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, "/home/you/app/web/src")[0], ["app-web"])
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, "/home/you/app/api")[0], ["app"])
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, "/home/you/application")[0], [])

    def test_a_worktree_finds_its_project_by_repository(self):
        found, _ = remote_link.resolve_lane(self.PROJECTS, "/home/you/wt/app-fix", git="/home/you/app/.git")
        self.assertEqual(found, ["app"])

    def test_a_named_board_by_id_or_name(self):
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, name="notes")[0], ["notes"])
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, name="web")[0], ["app-web"])
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, name="nope"), ([], "project_unknown"))

    def test_presence_reads_as_the_helper_reads_it(self):
        self.assertEqual(remote_link.presence_status({"busy": "m3"}), "claim_held")
        self.assertEqual(remote_link.presence_status({"busy": None, "listening": True}), "listener_present")
        self.assertEqual(remote_link.presence_status({"busy": None, "listening": False, "gap": 12}), "listener_present")
        self.assertEqual(remote_link.presence_status({"busy": None, "listening": False, "gap": 300}), "ready")


if __name__ == "__main__":
    unittest.main()
