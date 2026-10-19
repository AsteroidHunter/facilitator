"""The server's link (scripts/link.py in the skill), with HOME a scratch
folder for the server's account and a stand-in for the board's agent door.

  questions the three questions in the folder picker's shape and with its
            refusals: home fenced, no link followed out of it, hidden folders
            left out, another account's ~name never looked up; a new folder by
            the picker's name rules; a folder's repository found without
            running git, a worktree's included
  only      a question that is not one of the three, or not in its shape, is
            refused, and nothing it carries is run
  link      it connects out, answers the board's questions on the next poll,
            keeps trying while the board is away and connects again when it is
            back; it stops when the board refuses its key; a proxy in the
            account's settings is never used; its log holds no key
  one       start runs one link in the background, a second start finds it,
            status says so and stop ends it

    python3 -B -m unittest tests/test_server_link.py
"""

import http.server
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLONE = HERE.parent.parent
LINK = CLONE / ".agents" / "skills" / "facilitator" / "scripts" / "link.py"
SERVER_KEY = "s-" + "z" * 40


def load_link():
    spec = importlib.util.spec_from_file_location("server_link_under_test", LINK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def until(check, seconds=20.0):
    ends = time.monotonic() + seconds
    while time.monotonic() < ends:
        found = check()
        if found:
            return found
        time.sleep(0.1)
    return None


class Questions(unittest.TestCase):
    """The answers, from link.py loaded here, with HOME the scratch home."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="sl-q-", dir="/tmp")).resolve()
        for name in ("alpha", "beta", "run-10", "run-9", ".secret", "beta/inner", "beta/two"):
            (self.home / name).mkdir(parents=True)
        (self.home / "afile").write_text("x")
        (self.home / "beta" / "note.txt").write_text("x")
        os.symlink("/", self.home / "outward")
        os.symlink(self.home / "alpha", self.home / "alias")
        self.saved = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        self.link = load_link()

    def tearDown(self):
        os.environ["HOME"] = self.saved
        shutil.rmtree(self.home, ignore_errors=True)

    def ask(self, op, *args):
        out = self.link.answer({"id": "q1", "op": op, "args": list(args)})
        self.assertEqual(out.pop("id"), "q1")
        return out

    def test_the_home_listing_is_the_pickers_shape(self):
        out = self.ask("dirs", "", "")["answer"]
        self.assertEqual(set(out), {"path", "name", "short", "top", "parent", "trail", "dirs", "more", "cut", "unreadable"})
        self.assertFalse(out["cut"])
        self.assertEqual((out["path"], out["short"], out["parent"]), (str(self.home), "~", None))
        # a link that stays at home is listed, one out of it is not
        self.assertEqual([d["name"] for d in out["dirs"]], ["alias", "alpha", "beta", "run-9", "run-10"])
        beta = next(d for d in out["dirs"] if d["name"] == "beta")
        self.assertEqual(set(beta), {"name", "path", "modified", "items"})
        self.assertEqual(beta["items"], 3)

    def test_a_folder_below_has_its_trail(self):
        out = self.ask("dirs", "inner", str(self.home / "beta"))["answer"]
        self.assertEqual(out["short"], "~/beta/inner")
        self.assertEqual([t["name"] for t in out["trail"]], [self.home.name, "beta", "inner"])
        self.assertEqual(out["parent"], str(self.home / "beta"))

    def test_the_pickers_refusals_in_its_words(self):
        for path, said in (("/", "outside the home folder"), ("outward", "outside the home folder"),
                           ("/etc", "outside the home folder"), ("..", "outside the home folder"),
                           (".secret", "that folder is hidden"), ("nothing", "no folder there"),
                           ("afile", "that is a file, not a folder"),
                           # another account's home is never looked up
                           ("~root", "outside the home folder"), ("~nobody/x", "outside the home folder"),
                           ("a" * 5000, "that path is too long")):
            with self.subTest(path=path):
                self.assertEqual(self.ask("dirs", path, ""), {"error": said})

    def test_a_new_folder(self):
        out = self.ask("mkdir", str(self.home / "alpha"), "made")["answer"]
        self.assertEqual(out["path"], str(self.home / "alpha" / "made"))
        self.assertTrue((self.home / "alpha" / "made").is_dir())
        self.assertEqual(self.ask("mkdir", str(self.home / "alpha"), "made"),
                         {"error": "a folder by that name is already here"})
        for name, said in ((".dot", "a folder name cannot start with a dot"),
                           ("a/b", "a folder name cannot hold a slash"),
                           ("a‮b", "a folder name cannot hold an invisible character"),
                           ("", "a folder needs a name")):
            with self.subTest(name=name):
                self.assertEqual(self.ask("mkdir", str(self.home), name), {"error": said})
        self.assertEqual(self.ask("mkdir", "/tmp", "x"), {"error": "outside the home folder"})
        self.assertTrue(self.ask("mkdir", str(self.home), "a‍b")["answer"]["ok"])   # a joiner may stand

    def test_a_folders_repository_without_running_git(self):
        if shutil.which("git") is None:
            self.skipTest("no git here to make the repositories")
        repo = self.home / "alpha"
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / "src").mkdir()
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
                        "--allow-empty", "-m", "x"], check=True)
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(self.home / "beta" / "wt")], check=True)
        saved = os.environ.get("PATH", "")
        os.environ["PATH"] = ""   # no git to run, and none is
        try:
            self.assertEqual(self.ask("describe", str(repo))["answer"],
                             {"path": str(repo), "name": "alpha", "git": str(repo / ".git")})
            self.assertEqual(self.ask("describe", str(repo / "src"))["answer"]["git"], str(repo / ".git"))
            self.assertEqual(self.ask("describe", str(self.home / "beta" / "wt"))["answer"]["git"], str(repo / ".git"))
            self.assertIsNone(self.ask("describe", str(self.home / "run-9"))["answer"]["git"])
        finally:
            os.environ["PATH"] = saved
        self.assertEqual(self.ask("describe", "/"), {"error": "outside the home folder"})

    def test_only_the_three_questions_in_their_shape(self):
        for ask in ({"id": "q1", "op": "run", "args": ["touch /tmp/x"]}, {"id": "q1", "op": "dirs", "args": [""]},
                    {"id": "q1", "op": "dirs", "args": ["", 3]}, {"id": "q1", "op": "describe"},
                    {"id": "q1", "op": "__import__", "args": ["os"]}):
            with self.subTest(ask=ask):
                self.assertEqual(self.link.answer(ask), {"id": "q1", "error": "the server does not answer that"})
        self.assertIsNone(self.link.answer({"op": "dirs", "args": ["", ""]}))
        self.assertIsNone(self.link.answer("dirs"))


class Door(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class DoorHandler(http.server.BaseHTTPRequestHandler):
    """The board's door, as far as a link sees it: each poll takes the next
    question off the queue and leaves its answers here."""
    asks = []
    answers = []
    polls = 0
    refuse = False

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.split("?", 1)[0] != "/remote/link" or self.headers.get("authorization") != "Bearer " + SERVER_KEY \
                or DoorHandler.refuse:
            status, payload = 401, {"error": "this server's key is not known: pair it again"}
        else:
            DoorHandler.polls += 1
            DoorHandler.answers += body.get("answers") or []
            asks = DoorHandler.asks[:1]
            del DoorHandler.asks[:1]
            if not asks:
                time.sleep(0.2)
            status, payload = 200, {"asks": asks}
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class Running(unittest.TestCase):
    """link.py run as its own process, as the setup program starts it."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="sl-run-", dir="/tmp")).resolve()
        (self.home / "work").mkdir()
        self.top = self.home / ".facilitator"
        scripts = self.top / "skill" / ".agents" / "skills" / "facilitator" / "scripts"
        scripts.mkdir(parents=True)
        shutil.copy(LINK, scripts / "link.py")
        self.script = scripts / "link.py"
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        (self.top / "skill" / "remote.json").write_text(json.dumps({
            "server": "lab", "name": "lab", "home": str(self.top), "board": f"http://127.0.0.1:{self.port}"}))
        (self.top / "server.key").write_text(SERVER_KEY + "\n")
        DoorHandler.asks, DoorHandler.answers, DoorHandler.polls, DoorHandler.refuse = [], [], 0, False
        self.door = None
        self.env = {**os.environ, "HOME": str(self.home), "http_proxy": "http://127.0.0.1:9",
                    "HTTP_PROXY": "http://127.0.0.1:9", "PYTHONDONTWRITEBYTECODE": "1"}

    def tearDown(self):
        subprocess.run([sys.executable, "-B", str(self.script), "stop"], env=self.env, capture_output=True, timeout=30)
        if self.door is not None:
            self.door.shutdown()
            self.door.server_close()
        shutil.rmtree(self.home, ignore_errors=True)

    def open_door(self):
        self.door = Door(("127.0.0.1", self.port), DoorHandler)
        threading.Thread(target=self.door.serve_forever, daemon=True).start()

    def close_door(self):
        self.door.shutdown()
        self.door.server_close()
        self.door = None

    def link(self, *words):
        return subprocess.run([sys.executable, "-B", str(self.script), *words], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def state(self):
        try:
            return json.loads((self.top / "link.state").read_text())
        except (OSError, ValueError):
            return {}

    def test_it_answers_through_a_drop_and_stops_when_refused(self):
        self.open_door()
        self.assertEqual(self.link("start").returncode, 0)
        self.assertTrue(until(lambda: self.state().get("connected")), "the link did not connect")
        DoorHandler.asks.append({"id": "a1", "op": "dirs", "args": ["", ""]})
        self.assertTrue(until(lambda: DoorHandler.answers), "the answer did not come back")
        got = DoorHandler.answers[0]
        self.assertEqual(got["id"], "a1")
        self.assertEqual(got["answer"]["path"], str(self.home))
        self.assertEqual([d["name"] for d in got["answer"]["dirs"]], ["work"])
        # the board goes away, and comes back
        self.close_door()
        self.assertTrue(until(lambda: self.state().get("connected") is False, 30), "the link did not notice")
        self.assertIn("but the board cannot be reached now", self.link("status").stdout)
        time.sleep(3)
        self.open_door()
        self.assertTrue(until(lambda: self.state().get("connected"), 30), "the link did not connect again")
        self.assertIn("is connected to the board", self.link("status").stdout)
        # the board forgets this server
        DoorHandler.refuse = True
        self.assertTrue(until(lambda: self.state().get("refused"), 30), "the link did not stop when refused")
        self.assertTrue(until(lambda: "not running" in self.link("status").stdout, 10))
        log = (self.top / "link.log").read_text()
        self.assertIn("connected to the board", log)
        self.assertIn("pair this server again", log)
        self.assertNotIn(SERVER_KEY, log)
        self.assertNotIn(str(self.port), log)

    def test_one_link_per_account(self):
        self.open_door()
        first = self.link("start")
        self.assertIn("The link runs in the background", first.stdout)
        self.assertIn("The link already runs", self.link("start").stdout)
        held = self.link("status").stdout
        self.assertIn("The link runs", held)
        pid = int((self.top / "link.lock").read_text())
        self.assertIn("The link is stopped.", self.link("stop").stdout)
        self.assertTrue(until(lambda: subprocess.run(["kill", "-0", str(pid)], capture_output=True).returncode != 0, 5))
        self.assertIn("not running", self.link("status").stdout)
        # what the link writes; the key is the setup program's (test_remote_board)
        for name in ("link.lock", "link.state", "link.log"):
            self.assertEqual(os.stat(self.top / name).st_mode & 0o077, 0, name)

    def test_without_a_record_it_says_so(self):
        (self.top / "skill" / "remote.json").unlink()
        r = self.link("start")
        self.assertEqual(r.returncode, 1)
        self.assertIn("not set up on a server", r.stdout)


if __name__ == "__main__":
    unittest.main()
