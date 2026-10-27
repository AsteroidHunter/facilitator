"""The skill's helper (scripts/onboard.py) on one of the owner's servers,
against a stand-in for the board's agent door over TCP, and on the Mac,
where it must never take a server lane's path for a folder there.

  join      inspect starts the server's link, joins the lane its folder names
            with the server's key and keeps the lane's key and a curl config
            (the key, the door, no proxy) for the account alone, and never
            prints the key; a join the board refuses, no server key, or no
            board says so; a ready join gives the first word of the name the
            board sent, and none for no name or a join that is not ready; a
            ready join whose key is not the shape of the board's keys keeps
            nothing and says so
  wait      a claim is confirmed before it is printed, without its receipt;
            each /wait call is at most WAIT_CYCLE seconds and the lane is
            looked at once, not before every call; a held card, a missing
            key, a refused key and a lane name that is a path each say so
  drop      with the board out of reach, a wait keeps trying until its own
            deadline and then says link_down; the board back within it
            delivers
  reply     wait --reply reads /fresh first and posts the reply as it came
            on standard input only when nothing came, then listens as wait
            does; a message on the card, another card held or a widget
            message posts nothing and is given back; a refused or cut reply
            listens for nothing; an empty reply calls nothing
  proxy     a proxy in the account's settings is never used
  mac       on the Mac the helper resolves only lanes whose folders are here

    python3 -B -m unittest tests/test_onboard_remote.py
"""

import http.server
import importlib.util
import json
import os
import secrets
import shutil
import socket
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
SERVER_KEY = "s-" + "y" * 40


class Board(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(http.server.BaseHTTPRequestHandler):
    answers = {}     # route without query -> (status, body); a status of None cuts the call
    seen = []

    def log_message(self, *args):
        pass

    def answer(self):
        route = self.path.split("?", 1)[0]
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        Handler.seen.append((self.command, self.path, self.headers.get("authorization"), body))
        status, payload = Handler.answers.get(route, (404, {"error": "not found"}))
        if status is None:
            return      # the call is cut: the connection closes with no answer
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = answer


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class OnAServer(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="ob-", dir="/tmp")).resolve()
        self.top = self.home / ".facilitator"
        skill = self.top / "skill"
        scripts = skill / ".agents" / "skills" / "facilitator" / "scripts"
        scripts.mkdir(parents=True)
        shutil.copy(HELPER, scripts / "onboard.py")
        # the link, stood in for: it notes how it was started and ends
        (scripts / "link.py").write_text(
            "import sys, pathlib\n"
            f"pathlib.Path({str(self.home / 'link-started')!r}).write_text(' '.join(sys.argv[1:]))\n")
        (skill / "app").mkdir()
        (skill / "app" / "RUNBOOK.md").write_text("runbook")
        self.port = free_port()
        (skill / "remote.json").write_text(json.dumps({"server": "lab", "name": "lab", "home": str(self.top),
                                                       "board": f"http://127.0.0.1:{self.port}"}))
        (self.top / "server.key").write_text(SERVER_KEY + "\n")
        self.script = scripts / "onboard.py"
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
        self.board = Board(("127.0.0.1", self.port), Handler)
        threading.Thread(target=self.board.serve_forever, daemon=True).start()

    def run_helper(self, *words, timeout=60, stdin=None, **env):
        r = subprocess.run([sys.executable, "-B", str(self.script), *words], cwd=self.project,
                           env={**os.environ, "HOME": str(self.home), **env}, capture_output=True, text=True,
                           timeout=timeout, input=stdin)
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
        self.assertEqual(said["base"], "http://board")
        self.assertNotIn(KEY, printed)
        self.assertNotIn(str(self.port), printed)   # the board's address stays in the config
        self.assertEqual((self.top / "agents" / "demo.key").read_text().strip(), KEY)
        text = config.read_text()
        self.assertIn(f'header = "Authorization: Bearer {KEY}"', text)
        self.assertIn(f'connect-to = "::127.0.0.1:{self.port}"', text)
        self.assertIn('noproxy = "*"', text)
        for path in (self.top / "agents" / "demo.key", config):
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        method, route, auth, body = Handler.seen[0]
        self.assertEqual((method, route, auth), ("POST", "/remote/join", "Bearer " + SERVER_KEY))
        self.assertEqual(json.loads(body)["path"], str(self.project))
        self.assertEqual((self.home / "link-started").read_text(), "start --quiet")

    def test_the_curl_config_reaches_the_board(self):
        if shutil.which("curl") is None:
            self.skipTest("no curl here")
        Handler.answers.update({"/remote/join": (200, {"status": "ready", "owner": "demo", "key": KEY}),
                                "/fresh": (200, {"box": None, "messages": []})})
        self.serve()
        self.run_helper("inspect")
        r = subprocess.run(["curl", "-sS", "-K", str(self.top / "agents" / "demo.curl"), "http://board/fresh?owner=demo"],
                           capture_output=True, text=True, timeout=30,
                           env={**os.environ, "http_proxy": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9"})
        self.assertEqual(json.loads(r.stdout), {"box": None, "messages": []})
        self.assertEqual(Handler.seen[-1][2], "Bearer " + KEY)

    def test_a_ready_join_with_a_key_this_server_cannot_use(self):
        # a quote and a line break would add curl options of the answer's
        # choosing to the config every agent command here uses
        written = self.home / "written-by-the-board-answer"
        injected = KEY + '"\noutput = "' + str(written) + '"\nheader = "X: y'
        self.serve()
        for kind, bad in (("a quote and a line break", injected), ("too short", "short-" + "q" * 13),
                          ("too long", "long-" + "q" * 96), ("a space", "spaced " + "q" * 30)):
            with self.subTest(key=kind):
                Handler.answers["/remote/join"] = (200, {"status": "ready", "owner": "demo", "server": "lab",
                                                         "key": bad, "name": "Ada"})
                printed, said = self.run_helper("inspect")
                self.assertEqual(said, {"status": "protocol_error", "detail": "join answered a key this server cannot use",
                                        "remote": True, "server": "lab"})
                self.assertNotIn(bad, printed)
                self.assertNotIn(json.dumps(bad)[1:-1], printed)
                self.assertFalse((self.top / "agents" / "demo.key").exists())
                self.assertFalse((self.top / "agents" / "demo.curl").exists())
        self.assertFalse(written.exists())
        # the shortest and longest the rule takes, and a key as the board makes them
        for good in ("g" * 20, "g" * 100, secrets.token_urlsafe(32)):
            with self.subTest(key=len(good)):
                Handler.answers["/remote/join"] = (200, {"status": "ready", "owner": "demo", "key": good})
                self.assertEqual(self.run_helper("inspect")[1]["status"], "ready")
                self.assertEqual((self.top / "agents" / "demo.key").read_text(), good + "\n")

    def test_save_key_refuses_a_key_this_server_cannot_use(self):
        spec = importlib.util.spec_from_file_location("onboard_helper_save_key", self.script)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        rec = {"home": str(self.top), "board": f"http://127.0.0.1:{self.port}"}
        for bad in (KEY + '"\nheader = "X: y', "q" * 19, "q" * 101, "q" * 20 + " ", None):
            with self.subTest(key=bad):
                with self.assertRaises(ValueError):
                    helper.save_key(rec, "demo", bad)
                self.assertFalse((self.top / "agents" / "demo.key").exists())
                self.assertFalse((self.top / "agents" / "demo.curl").exists())
        helper.save_key(rec, "demo", KEY)
        self.assertEqual((self.top / "agents" / "demo.key").read_text(), KEY + "\n")

    def test_a_join_the_board_refuses(self):
        Handler.answers["/remote/join"] = (401, {"error": "unknown"})
        self.serve()
        self.assertEqual(self.run_helper("inspect")[1]["status"], "key_refused")

    def test_a_server_with_no_key(self):
        (self.top / "server.key").unlink()
        self.serve()
        self.assertEqual(self.run_helper("inspect")[1]["status"], "key_refused")
        self.assertEqual(Handler.seen, [])

    def test_a_join_with_no_board(self):
        self.assertEqual(self.run_helper("inspect")[1]["status"], "link_down")

    def test_another_lanes_answer_is_passed_on_without_a_key(self):
        Handler.answers["/remote/join"] = (200, {"status": "listener_present", "owner": "demo", "server": "lab"})
        self.serve()
        said = self.run_helper("inspect")[1]
        self.assertEqual((said["status"], said["owner"]), ("listener_present", "demo"))
        self.assertFalse((self.top / "agents" / "demo.key").exists())

    def test_a_ready_join_gives_the_first_name_alone(self):
        self.serve()
        for given, first in (("Ada", "Ada"), ("Ada Lovelace", "Ada"), ("  ada  ", "ada"),
                             ("María José García", "María"), ("Ада Лавлейс", "Ада")):
            with self.subTest(name=given):
                Handler.answers["/remote/join"] = (200, {"status": "ready", "owner": "demo", "server": "lab",
                                                         "key": KEY, "name": given})
                said = self.run_helper("inspect")[1]
                self.assertEqual(said["name"], first)
                self.assertEqual(list(said), ["status", "owner", "curl", "base", "runbook", "name", "remote", "server"])
        for given in (None, "", "   ", 42, "A\x07da"):
            with self.subTest(name=given):
                Handler.answers["/remote/join"] = (200, {"status": "ready", "owner": "demo", "key": KEY, "name": given})
                said = self.run_helper("inspect")[1]
                self.assertEqual(said["status"], "ready")
                self.assertNotIn("name", said)
        # a board from before the name gives none
        Handler.answers["/remote/join"] = (200, {"status": "ready", "owner": "demo", "key": KEY})
        self.assertNotIn("name", self.run_helper("inspect")[1])

    def test_a_join_that_is_not_ready_passes_no_name_on(self):
        Handler.answers["/remote/join"] = (200, {"status": "listener_present", "owner": "demo", "server": "lab",
                                                 "name": "Ada"})
        self.serve()
        said = self.run_helper("inspect")[1]
        self.assertEqual(said["status"], "listener_present")
        self.assertNotIn("name", said)

    def test_a_proxy_in_the_accounts_settings_is_never_used(self):
        Handler.answers["/remote/join"] = (200, {"status": "ready", "owner": "demo", "key": KEY})
        self.serve()
        said = self.run_helper("inspect", http_proxy="http://127.0.0.1:9", HTTP_PROXY="http://127.0.0.1:9",
                               all_proxy="http://127.0.0.1:9")[1]
        self.assertEqual(said["status"], "ready")

    # -- wait
    LANE_FREE = (200, {"owner": "demo", "busy": None, "confirmed": False, "listening": False, "gap": 400})

    def test_a_claim_is_confirmed_before_it_is_printed(self):
        self.give_key()
        Handler.answers.update({
            "/remote/lane": self.LANE_FREE,
            "/wait": (200, {"box": "m4", "title": "t", "messages": ["hi"], "message_via": [None],
                            "queued_after": 0, "ack": "tok123"}),
            "/ack": (200, {"ok": True, "box": "m4"})})
        self.serve()
        printed, said = self.run_helper("wait", "--owner", "demo", "--agent", "claude", "--timeout", "300")
        self.assertEqual((said["status"], said["box"], said["messages"]), ("claim", "m4", ["hi"]))
        self.assertNotIn("ack", said)
        routes = [r for _, r, _, _ in Handler.seen]
        self.assertEqual(routes[0], "/remote/lane")
        self.assertTrue(routes[1].startswith("/wait?owner=demo&timeout=25&"), routes[1])
        self.assertEqual(routes[2], "/ack?owner=demo&token=tok123")
        self.assertTrue(all(auth == "Bearer " + KEY for _, _, auth, _ in Handler.seen))
        self.assertNotIn(KEY, printed)

    def test_a_listen_is_short_calls_with_one_look(self):
        self.give_key()
        Handler.answers.update({"/remote/lane": self.LANE_FREE, "/wait": (200, {"idle": True})})
        self.serve()
        said = self.run_helper("wait", "--owner", "demo", "--timeout", "3")[1]
        self.assertEqual(said["status"], "idle")
        routes = [r.split("?", 1)[0] for _, r, _, _ in Handler.seen]
        self.assertEqual(routes.count("/remote/lane"), 1)
        self.assertGreater(routes.count("/wait"), 1)

    def test_a_held_card_a_missing_key_a_refused_key_and_a_path_for_a_lane(self):
        self.assertEqual(self.run_helper("wait", "--owner", "demo")[1]["status"], "key_refused")
        self.assertEqual(self.run_helper("wait", "--owner", "../demo")[1]["status"], "project_unknown")
        self.give_key()
        Handler.answers["/remote/lane"] = (200, {"owner": "demo", "busy": "m4", "confirmed": True,
                                                 "listening": False, "gap": 1})
        self.serve()
        said = self.run_helper("wait", "--owner", "demo")[1]
        self.assertEqual((said["status"], said["box"]), ("claim_held", "m4"))
        Handler.answers["/remote/lane"] = (401, {"error": "this key is not known: join again"})
        self.assertEqual(self.run_helper("wait", "--owner", "demo")[1]["status"], "key_refused")

    def test_a_wait_tries_through_a_drop_until_its_deadline(self):
        self.give_key()
        began = time.monotonic()
        said = self.run_helper("wait", "--owner", "demo", "--timeout", "7")[1]
        took = time.monotonic() - began
        self.assertEqual(said["status"], "link_down")
        self.assertGreaterEqual(took, 5.5)
        self.assertLess(took, 12)

    def test_the_board_back_within_the_wait_delivers(self):
        self.give_key()
        Handler.answers.update({
            "/remote/lane": self.LANE_FREE,
            "/wait": (200, {"box": "m4", "title": "t", "messages": ["later"], "message_via": [None],
                            "queued_after": 0, "ack": "tok9"}),
            "/ack": (200, {"ok": True, "box": "m4"})})
        threading.Timer(4.0, self.serve).start()
        said = self.run_helper("wait", "--owner", "demo", "--timeout", "30")[1]
        self.assertEqual((said["status"], said["messages"]), ("claim", ["later"]))

    # -- reply
    NOTHING = (200, {"box": "m4", "messages": [], "message_via": [], "message_by": [], "message_agent": []})
    NEXT = (200, {"box": "m5", "title": "t", "messages": ["next one"], "message_via": [None],
                  "queued_after": 0, "ack": "tok5"})

    def reply(self, text, card="m4", timeout="20"):
        return self.run_helper("wait", "--reply", card, "--owner", "demo", "--agent", "opus", "--timeout", timeout,
                               stdin=text)

    def routes(self):
        return [r.split("?", 1)[0] for _, r, _, _ in Handler.seen]

    def test_a_reply_with_nothing_new_posts_and_the_next_claim_comes_back(self):
        self.give_key()
        Handler.answers.update({"/fresh": self.NOTHING, "/reply": (200, {"ok": True}),
                                "/remote/lane": self.LANE_FREE, "/wait": self.NEXT,
                                "/ack": (200, {"ok": True, "box": "m5"})})
        self.serve()
        text = "**Done.** The answer, as typed.\n\nSecond paragraph: é\n"
        printed, said = self.reply(text)
        self.assertEqual(said["status"], "replied")
        self.assertEqual((said["box"], said["reply"]), ("m4", {"ok": True}))
        self.assertEqual(said["next"], {"status": "claim", "owner": "demo", "box": "m5", "title": "t",
                                        "messages": ["next one"], "message_via": [None], "queued_after": 0})
        self.assertEqual(self.routes(), ["/fresh", "/reply", "/remote/lane", "/wait", "/ack"])
        method, route, auth, body = Handler.seen[1]
        self.assertEqual((method, route, body), ("POST", "/reply?box=m4", text.encode()))
        self.assertEqual(Handler.seen[0][1], "/fresh?owner=demo")
        self.assertTrue(all(a == "Bearer " + KEY for _, _, a, _ in Handler.seen))
        self.assertNotIn(KEY, printed)

    def test_the_listen_after_a_reply_answers_as_wait_does(self):
        self.give_key()
        Handler.answers.update({"/fresh": self.NOTHING, "/reply": (200, {"ok": True}),
                                "/remote/lane": self.LANE_FREE, "/wait": (200, {"idle": True})})
        self.serve()
        said = self.reply("The answer.", timeout="2")[1]
        plain = self.run_helper("wait", "--owner", "demo", "--timeout", "2")[1]
        self.assertEqual(said["next"], {"status": "idle", "owner": "demo"})
        self.assertEqual(said["next"], plain)

    def test_anything_new_posts_nothing_and_is_given_back(self):
        self.give_key()
        widget = [{"from": "widget", "widget": "issues", "about": "t1", "text": "and this?", "ts": 1.0}]
        self.serve()
        for fresh in ({**self.NOTHING[1], "messages": ["a follow-up"], "message_via": [None],
                       "message_by": [None], "message_agent": [None]},
                      {**self.NOTHING[1], "box": "m9"},
                      {**self.NOTHING[1], "widget_messages": widget}):
            with self.subTest(fresh=fresh):
                Handler.seen = []
                Handler.answers.update({"/fresh": (200, fresh), "/reply": (200, {"ok": True})})
                said = self.reply("A reply written before the news.")[1]
                self.assertEqual(said, {"status": "fresh", **fresh})
                self.assertEqual(self.routes(), ["/fresh"])

    def test_a_refused_or_cut_reply_listens_for_nothing(self):
        self.give_key()
        # no card held, so the reply goes, to a card that is not there
        none_held = (200, {"messages": [], "message_via": [], "message_by": [], "message_agent": []})
        Handler.answers.update({"/fresh": none_held, "/reply": (400, {"error": "bad box"}),
                                "/remote/lane": self.LANE_FREE, "/wait": self.NEXT})
        self.serve()
        said = self.reply("For a card that is not there.", card="m404")[1]
        self.assertEqual(said, {"status": "reply_failed", "box": "m404", "code": 400, "reply": {"error": "bad box"}})
        self.assertEqual(self.routes(), ["/fresh", "/reply"])
        Handler.seen = []
        Handler.answers["/reply"] = (401, {"error": "this key is not known: join again"})
        self.assertEqual(self.reply("Refused key.")[1]["code"], 401)
        self.assertEqual(self.routes(), ["/fresh", "/reply"])
        # the call cut with no answer: it may have reached the board, so it
        # is not tried again, and nothing listens
        Handler.seen = []
        Handler.answers["/reply"] = (None, None)
        said = self.reply("Cut on the way.")[1]
        self.assertEqual((said["status"], said["box"]), ("reply_failed", "m4"))
        self.assertIn("may or may not have the reply", said["detail"])
        self.assertEqual(self.routes(), ["/fresh", "/reply"])

    def test_an_empty_reply_calls_nothing(self):
        self.give_key()
        self.serve()
        for text in ("", " \n\t\n"):
            with self.subTest(text=text):
                said = self.reply(text)[1]
                self.assertEqual(said["status"], "empty_reply")
                self.assertEqual(Handler.seen, [])
        self.assertFalse((self.home / "link-started").exists())

    def test_a_reply_with_no_key_or_no_board_posts_nothing(self):
        self.assertEqual(self.reply("No key yet.")[1]["status"], "key_refused")
        self.give_key()
        said = self.reply("No board.")[1]
        self.assertEqual(said["status"], "link_down")
        self.serve()
        Handler.answers["/fresh"] = (401, {"error": "this key is not known: join again"})
        self.assertEqual(self.reply("Key gone.")[1]["status"], "key_refused")
        self.assertEqual(self.routes(), ["/fresh"])


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
