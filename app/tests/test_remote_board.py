"""A server, end to end, with ssh stood in for (tests/fixtures/fake-ssh.py):
a board running from a scratch copy of the checkout, `facilitator remote add`
against a "server" that is a scratch folder, the server's folders listed for
the picker, a project in one of them, and the skill's helper on the server
joining it, claiming a message and answering it through the link; then the
server going away and coming back, with a message sent meanwhile delivered.

  add       the skill, the runbook and the docs land in ~/.facilitator/skill,
            the join key beside them for the account alone, the skill's links
            are made, and the Mac keeps the key's hash, never the key; nothing
            secret is printed; the link comes up
  listing   /remote/dirs lists the server's home in the picker's shape, hidden
            folders left out; /remote/machines names the server online
  project   a project on the server keeps its server, and its folder is the
            server's
  agent     inspect joins and keeps the lane's key and curl config for the
            account alone; wait claims and confirms; curl -K answers the card;
            the key opens no other lane
  drop      the link goes down with the server and comes back by itself, and
            a wait that was trying through the drop gets the message sent
            while it was down
  remove    the server forgotten, its lane's key is refused
  logs      no key and no join key in the board's log

    python3 -B -m unittest tests/test_remote_board.py
"""

import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
CLONE = APP.parent
FAKE_SSH = HERE / "fixtures" / "fake-ssh.py"


def free_pair():
    while True:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port >= 65534:
            continue
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port + 1))
            except OSError:
                continue
        return port


def until(check, seconds=20.0):
    ends = time.monotonic() + seconds
    while time.monotonic() < ends:
        found = check()
        if found:
            return found
        time.sleep(0.2)
    return None


class ServerEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="rb-", dir="/tmp")).resolve()
        cls.outer = cls.root / "board"
        shutil.copytree(APP, cls.outer / "app",
                        ignore=shutil.ignore_patterns("tests", "__pycache__", "node_modules"))
        shutil.copytree(CLONE / ".agents", cls.outer / ".agents")
        shutil.copytree(CLONE / "docs", cls.outer / "docs")
        cls.data = cls.outer / "data"
        cls.data.mkdir(mode=0o700)
        cls.port = free_pair()
        (cls.data / "run.config.json").write_text(json.dumps({"port": cls.port, "lanes": []}))
        (cls.data / "seed.json").write_text(json.dumps({"title": "remote fixture", "items": []}))
        cls.mac_home = cls.root / "mac-home"
        cls.mac_home.mkdir()
        cls.home = cls.root / "server"
        cls.home.mkdir()
        for name in ("demo", "other", ".hidden"):
            (cls.home / name).mkdir()
        cls.down = cls.root / "down"
        cls.logs = cls.root / "logs"
        bin_dir = cls.root / "bin"
        bin_dir.mkdir()
        tool = bin_dir / "ssh"
        tool.write_text(f'#!/bin/sh\nexec "{sys.executable}" -B "{FAKE_SSH}" "$@"\n')
        tool.chmod(0o755)
        cls.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(cls.mac_home),
                   "FAKE_SSH_HOME": str(cls.home), "FAKE_SSH_DOWN": str(cls.down),
                   "FACILITATOR_TEST_PORT": str(cls.port), "FACILITATOR_LOG_DIR": str(cls.logs),
                   "PYTHONDONTWRITEBYTECODE": "1"}
        cls.env.pop("FACILITATOR_SSH_CONFIG", None)
        cls.board = subprocess.Popen([sys.executable, "-B", str(cls.outer / "app" / "server.py")],
                                     cwd=cls.outer / "app", env=cls.env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if not until(lambda: cls.get("/state")[0] == 200, 15):
            cls.board.kill()
            raise AssertionError("the board did not start: " + cls.board.stderr.read().decode()[-2000:])

    @classmethod
    def tearDownClass(cls):
        cls.down.write_text("")   # any fake master still up ends itself
        cls.board.terminate()
        try:
            cls.board.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.board.kill()
        cls.board.stderr.close()
        time.sleep(0.5)
        shutil.rmtree(cls.root, ignore_errors=True)

    # -- calls
    @classmethod
    def get(cls, route):
        return cls.call("GET", route)

    @classmethod
    def call(cls, method, route, body=None):
        request = urllib.request.Request(f"http://127.0.0.1:{cls.port}{route}", method=method,
                                         data=body.encode() if isinstance(body, str) else body)
        try:
            with urllib.request.urlopen(request, timeout=30) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as refused:
            with refused:
                return refused.code, json.load(refused)
        except (OSError, ValueError):
            return None, None

    def cli(self, *words):
        return subprocess.run([sys.executable, "-B", str(self.outer / "app" / "facilitator"), *words],
                              env=self.env, capture_output=True, text=True, timeout=90)

    def helper(self, *words, cwd=None, wait=True):
        script = self.home / ".agents" / "skills" / "facilitator" / "scripts" / "onboard.py"
        env = {**self.env, "HOME": str(self.home)}
        argv = [sys.executable, "-B", str(script), *words]
        if not wait:
            return subprocess.Popen(argv, cwd=cwd or self.home, env=env, stdout=subprocess.PIPE, text=True)
        r = subprocess.run(argv, cwd=cwd or self.home, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def curl(self, config, method, route, body=None):
        argv = ["curl", "-sS", "-K", str(config), "-o", "/dev/null", "-w", "%{http_code}", "-X", method,
                "http://localhost" + route]
        if body is not None:
            argv[1:1] = ["--data-binary", body]
        return int(subprocess.run(argv, capture_output=True, text=True, timeout=30).stdout or 0)

    def link_up(self, want=True):
        def check():
            status, said = self.get("/remote/servers")
            hit = [s for s in (said or {}).get("servers", []) if s["id"] == "fake"]
            return hit and hit[0]["up"] == want
        return until(check, 30)

    def card(self, owner):
        _, st = self.get("/state")
        return next(b for b in st["boxes"] if b["owner"] == owner)

    def mode(self, path):
        return stat.S_IMODE(os.lstat(path).st_mode)

    # -- the whole run, in order
    def test_a_server_end_to_end(self):
        # add
        added = self.cli("remote", "add", "you@fake")
        self.assertEqual(added.returncode, 0, added.stdout + added.stderr)
        self.assertIn("The link to fake is up.", added.stdout)
        top = self.home / ".facilitator"
        join_key = (top / "join.key").read_text().strip()
        self.assertNotIn(join_key, added.stdout + added.stderr)
        self.assertEqual(self.mode(top), 0o700)
        self.assertEqual(self.mode(top / "join.key"), 0o600)
        for rel in ("skill/.agents/skills/facilitator/SKILL.md", "skill/.agents/skills/facilitator/scripts/onboard.py",
                    "skill/app/RUNBOOK.md", "skill/docs/README.md", "skill/remote.json"):
            self.assertTrue((top / rel).is_file(), rel)
        for link in (self.home / ".agents" / "skills" / "facilitator", self.home / ".claude" / "skills" / "facilitator"):
            self.assertEqual(os.readlink(link), str(top / "skill" / ".agents" / "skills" / "facilitator"))
        saved = (self.data / "remote" / "servers.json").read_text()
        self.assertNotIn(join_key, saved)
        self.assertEqual(json.loads(saved)["servers"][0]["id"], "fake")
        self.assertEqual(self.mode(self.data / "remote" / "servers.json"), 0o600)
        self.assertEqual(self.mode(top / "board.sock"), 0o600)

        # listing
        status, listed = self.get("/remote/dirs?machine=fake&path=")
        self.assertEqual(status, 200, listed)
        self.assertEqual(listed["machine"], "fake")
        self.assertEqual(listed["path"], str(self.home))
        self.assertEqual([d["name"] for d in listed["dirs"]], ["demo", "other"])
        _, machines = self.get("/remote/machines")
        self.assertEqual([(m["id"], m["kind"], m["online"]) for m in machines["machines"]], [("fake", "server", True)])
        # the folder picker's own routes: this Mac first, then the server, its
        # folders listed and made there
        _, picker = self.get("/machines")
        self.assertEqual([(m["id"], m["kind"]) for m in picker["machines"]], [("this", "computer"), ("fake", "server")])
        self.assertEqual(picker["machines"][1]["top"], str(self.home))
        status, through = self.get("/dirs?machine=fake&path=")
        self.assertEqual((status, through["machine"], [d["name"] for d in through["dirs"]]),
                         (200, "fake", ["demo", "other"]))
        status, made = self.call("POST", f"/mkdir?machine=fake&path={self.home / 'other'}&name=fresh")
        self.assertEqual((status, made["path"]), (200, str(self.home / "other" / "fresh")))
        self.assertTrue((self.home / "other" / "fresh").is_dir())
        self.assertEqual(self.get("/dirs?machine=nowhere&path=")[1], {"error": "no such machine"})

        # projects
        status, made = self.call("POST", "/project?name=demo&machine=fake", str(self.home / "demo"))
        self.assertEqual(status, 200, made)
        self.assertEqual(made["machine"], "fake")
        self.call("POST", "/project?name=other&machine=fake", str(self.home / "other"))
        status, refused = self.call("POST", "/project?name=x&machine=fake", "/")
        self.assertEqual((status, refused["error"]), (400, "outside the home folder"))
        _, st = self.get("/state")
        demo = next(p for p in st["projects"] if p["id"] == "demo")
        self.assertEqual((demo["server"], demo["dir"]), ("fake", str(self.home / "demo")))
        self.assertEqual(st["remote"]["servers"]["fake"], {"name": "fake", "up": True, "faded": False})
        box = self.card("demo")["id"]

        # agent
        joined = self.helper("inspect", cwd=self.home / "demo")
        self.assertEqual((joined["status"], joined["owner"], joined["remote"]), ("ready", "demo", True))
        key_file = top / "agents" / "demo.key"
        config = top / "agents" / "demo.curl"
        self.assertEqual(joined["curl"], f"-K {config}")
        self.assertEqual((self.mode(key_file), self.mode(config), self.mode(top / "agents")), (0o600, 0o600, 0o700))
        agent_key = key_file.read_text().strip()
        self.assertNotIn(agent_key, json.dumps(joined))
        self.assertEqual(self.call("POST", f"/send?box={box}", "hello from the board")[0], 200)
        claim = self.helper("wait", "--owner", "demo", "--agent", "claude", "--timeout", "20")
        self.assertEqual((claim["status"], claim["box"], claim["messages"]), ("claim", box, ["hello from the board"]))
        # a second agent joining now finds the card held and takes no key
        held = self.helper("inspect", cwd=self.home / "demo")
        self.assertEqual((held["status"], held["box"]), ("claim_held", box))
        self.assertEqual(key_file.read_text().strip(), agent_key)
        self.assertEqual(self.curl(config, "POST", f"/reply?box={box}", "the answer from the server"), 200)
        self.assertEqual(self.card("demo")["reply"], "the answer from the server")
        self.assertEqual(self.curl(config, "GET", "/wait?owner=other&timeout=1"), 403)
        self.assertEqual(self.curl(config, "POST", f"/reply?box={self.card('other')['id']}", "no"), 403)
        self.assertEqual(self.curl(config, "GET", "/state"), 403)

        # drop
        self.down.write_text("")
        self.assertTrue(self.link_up(False), "the link did not go down with the server")
        _, st = self.get("/state")
        self.assertEqual(st["remote"]["servers"]["fake"]["faded"], False)   # not yet: 30 seconds
        self.assertEqual(self.call("POST", f"/send?box={box}", "sent while it was down")[0], 200)
        waiting = self.helper("wait", "--owner", "demo", "--agent", "claude", "--timeout", "60", wait=False)
        time.sleep(3)
        self.assertIsNone(waiting.poll(), "the wait gave up while the link was down")
        self.down.unlink()
        self.assertTrue(self.link_up(True), "the link did not come back by itself")
        out, _ = waiting.communicate(timeout=60)
        got = json.loads(out.strip().splitlines()[-1])
        self.assertEqual((got["status"], got["messages"]), ("claim", ["sent while it was down"]))
        self.assertEqual(self.curl(config, "POST", f"/reply?box={box}", "got it"), 200)

        # remove
        removed = self.cli("remote", "remove", "fake")
        self.assertEqual(removed.returncode, 0, removed.stdout + removed.stderr)
        self.assertEqual(self.get("/remote/servers")[1]["servers"], [])
        self.assertEqual(self.curl(config, "GET", "/remote/lane"), 0)   # nothing at the server's end now
        self.assertNotIn(agent_key, (self.data / "remote" / "keys.json").read_text())

        # logs
        text = "".join(p.read_text(errors="replace") for p in self.logs.glob("*") if p.is_file())
        self.assertIn("remotelink", text)
        for secret in (join_key, agent_key):
            self.assertNotIn(secret, text)


if __name__ == "__main__":
    unittest.main()
