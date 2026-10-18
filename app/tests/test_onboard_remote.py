"""The skill's helper (scripts/onboard.py) on one of the owner's servers,
against a stand-in board on the link's Unix socket, and on the Mac, where it
must never take a server lane's path for a folder there.

  join      inspect joins the lane its folder names and keeps the lane's key
            and a curl config for the account alone, and never prints the key;
            a join the board refuses, or no link, says so
  wait      a claim is confirmed before it is printed, without its receipt; a
            held card, a missing key and a refused key each say so
  drop      with the link down, a wait keeps trying until its own deadline
            and then says link_down
  mac       on the Mac the helper resolves only lanes whose folders are here

    python3 -B -m unittest tests/test_onboard_remote.py
"""

import http.server
import importlib.util
import json
import os
import shutil
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLONE = HERE.parent.parent
HELPER = CLONE / ".agents" / "skills" / "facilitator" / "scripts" / "onboard.py"
KEY = "k-" + "x" * 40


class Board(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    answers = {}     # route without query -> (status, body)
    seen = []

    def log_message(self, *args):
        pass

    def answer(self):
        route = self.path.split("?", 1)[0]
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        Handler.seen.append((self.command, self.path, self.headers.get("authorization"), body))
        status, payload = Handler.answers.get(route, (404, {"error": "not found"}))
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = answer


class OnAServer(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="ob-", dir="/tmp")).resolve()
        self.top = self.home / ".facilitator"
        skill = self.top / "skill"
        script = skill / ".agents" / "skills" / "facilitator" / "scripts" / "onboard.py"
        script.parent.mkdir(parents=True)
        shutil.copy(HELPER, script)
        (skill / "app").mkdir()
        (skill / "app" / "RUNBOOK.md").write_text("runbook")
        (skill / "remote.json").write_text(json.dumps({"server": "lab", "name": "lab", "home": str(self.top)}))
        (self.top / "join.key").write_text("join-" + "y" * 40 + "\n")
        self.script = script
        self.project = self.home / "demo"
        self.project.mkdir()
        self.board = None
        Handler.answers, Handler.seen = {}, []

    def tearDown(self):
        if self.board is not None:
            self.board.shutdown()
            self.board.server_close()
        shutil.rmtree(self.home, ignore_errors=True)

    def serve(self):
        self.board = Board(str(self.top / "board.sock"), Handler)
        threading.Thread(target=self.board.serve_forever, daemon=True).start()

    def run_helper(self, *words, timeout=60):
        r = subprocess.run([sys.executable, "-B", str(self.script), *words], cwd=self.project,
                           env={**os.environ, "HOME": str(self.home)}, capture_output=True, text=True,
                           timeout=timeout)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout, json.loads(r.stdout.strip().splitlines()[-1])

    def give_key(self):
        agents = self.top / "agents"
        agents.mkdir(mode=0o700, exist_ok=True)
        (agents / "demo.key").write_text(KEY + "\n")

    # -- join
    def test_inspect_joins_and_keeps_the_key_for_the_account_alone(self):
        Handler.answers["/remote/join"] = (200, {"status": "ready", "owner": "demo", "server": "lab", "key": KEY})
        self.serve()
        printed, said = self.run_helper("inspect")
        self.assertEqual((said["status"], said["owner"], said["remote"], said["server"]), ("ready", "demo", True, "lab"))
        config = self.top / "agents" / "demo.curl"
        self.assertEqual(said["curl"], f"-K {config}")
        self.assertEqual(said["base"], "http://localhost")
        self.assertNotIn(KEY, printed)
        self.assertEqual((self.top / "agents" / "demo.key").read_text().strip(), KEY)
        self.assertIn(f'header = "Authorization: Bearer {KEY}"', config.read_text())
        self.assertIn(f'unix-socket = "{self.top / "board.sock"}"', config.read_text())
        for path in (self.top / "agents" / "demo.key", config):
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        method, route, auth, body = Handler.seen[0]
        self.assertEqual((method, route, auth), ("POST", "/remote/join", "Bearer join-" + "y" * 40))
        self.assertEqual(json.loads(body)["path"], str(self.project))

    def test_a_join_the_board_refuses(self):
        Handler.answers["/remote/join"] = (401, {"error": "unknown"})
        self.serve()
        self.assertEqual(self.run_helper("inspect")[1]["status"], "key_refused")

    def test_a_join_with_no_link(self):
        self.assertEqual(self.run_helper("inspect")[1]["status"], "link_down")

    def test_another_lanes_answer_is_passed_on_without_a_key(self):
        Handler.answers["/remote/join"] = (200, {"status": "listener_present", "owner": "demo", "server": "lab"})
        self.serve()
        said = self.run_helper("inspect")[1]
        self.assertEqual((said["status"], said["owner"]), ("listener_present", "demo"))
        self.assertFalse((self.top / "agents" / "demo.key").exists())

    # -- wait
    def test_a_claim_is_confirmed_before_it_is_printed(self):
        self.give_key()
        Handler.answers.update({
            "/remote/lane": (200, {"owner": "demo", "busy": None, "confirmed": False, "listening": False, "gap": 400}),
            "/wait": (200, {"box": "m4", "title": "t", "messages": ["hi"], "message_via": [None],
                            "queued_after": 0, "ack": "tok123"}),
            "/ack": (200, {"ok": True, "box": "m4"})})
        self.serve()
        printed, said = self.run_helper("wait", "--owner", "demo", "--agent", "claude", "--timeout", "5")
        self.assertEqual((said["status"], said["box"], said["messages"]), ("claim", "m4", ["hi"]))
        self.assertNotIn("ack", said)
        routes = [r for _, r, _, _ in Handler.seen]
        self.assertEqual(routes[0], "/remote/lane")
        self.assertTrue(routes[1].startswith("/wait?owner=demo&timeout="))
        self.assertEqual(routes[2], "/ack?owner=demo&token=tok123")
        self.assertTrue(all(auth == "Bearer " + KEY for _, _, auth, _ in Handler.seen))
        self.assertNotIn(KEY, printed)

    def test_a_held_card_a_missing_key_and_a_refused_key(self):
        self.assertEqual(self.run_helper("wait", "--owner", "demo")[1]["status"], "key_refused")
        self.give_key()
        Handler.answers["/remote/lane"] = (200, {"owner": "demo", "busy": "m4", "confirmed": True,
                                                 "listening": False, "gap": 1})
        self.serve()
        said = self.run_helper("wait", "--owner", "demo")[1]
        self.assertEqual((said["status"], said["box"]), ("claim_held", "m4"))
        Handler.answers["/remote/lane"] = (401, {"error": "this key is not known: join again"})
        self.assertEqual(self.run_helper("wait", "--owner", "demo")[1]["status"], "key_refused")

    def test_a_wait_tries_through_a_dropped_link_until_its_deadline(self):
        self.give_key()
        began = time.monotonic()
        said = self.run_helper("wait", "--owner", "demo", "--timeout", "7")[1]
        took = time.monotonic() - began
        self.assertEqual(said["status"], "link_down")
        self.assertGreaterEqual(took, 5.5)
        self.assertLess(took, 12)

    def test_a_link_back_within_the_wait_delivers(self):
        self.give_key()
        Handler.answers.update({
            "/remote/lane": (200, {"owner": "demo", "busy": None, "confirmed": False, "listening": False, "gap": 400}),
            "/wait": (200, {"box": "m4", "title": "t", "messages": ["later"], "message_via": [None],
                            "queued_after": 0, "ack": "tok9"}),
            "/ack": (200, {"ok": True, "box": "m4"})})
        threading.Timer(4.0, self.serve).start()
        said = self.run_helper("wait", "--owner", "demo", "--timeout", "30")[1]
        self.assertEqual((said["status"], said["messages"]), ("claim", ["later"]))


class OnTheMac(unittest.TestCase):
    def test_a_server_lanes_path_is_never_a_folder_here(self):
        spec = importlib.util.spec_from_file_location("onboard_helper_mac", HELPER)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        here = Path(tempfile.mkdtemp(prefix="ob-mac-", dir="/tmp")).resolve()
        try:
            (here / "local").mkdir()
            state = {"pwds": {"far": str(here), "near": str(here / "local")},
                     "busy": {"far": None, "near": None},
                     "projects": [{"id": "far", "server": "lab", "dir": str(here)},
                                  {"id": "near", "dir": str(here / "local")}]}
            self.assertEqual(helper.resolve_path(state, str(here / "local")), (["near"], None))
            self.assertEqual(helper.resolve_path(state, str(here))[1], "project_unknown")
        finally:
            shutil.rmtree(here, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
