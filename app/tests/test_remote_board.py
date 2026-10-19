"""A server, end to end, with the tailnet stood in for: a board running from
a scratch copy of the checkout with its agent door on loopback (test mode),
a "server" that is a scratch home, and a relay between the two that can drop
every connection, as a tailnet that goes away does. Nothing logs in
anywhere: the server side connects out to the door, as on a real server.

  pair      `facilitator remote pair` prints the line to run on the server and
            a code; the setup program, fetched from the door with no key,
            trades the code for the server's key, puts the skill, the runbook
            and the docs in ~/.facilitator/skill for the account alone, links
            the skill and starts the link, which connects; the Mac keeps the
            key's hash and never the key; the code works once
  listing   the picker's /machines names the server online after this Mac, and
            /dirs and /mkdir with its id list and make its folders there,
            through the link, in the picker's shape and by this Mac's rules
  project   a project on the server keeps its server, and its folder is the
            server's
  agent     inspect joins and keeps the lane's key and a curl config for the
            account alone; wait claims and confirms; curl -K answers the card
            through the door without the board's address in the command; the
            key opens no other lane, and no key opens nothing
  drop      the relay drops everything: the server shows offline, a wait keeps
            trying, and when the relay is back the link reconnects by itself
            and the wait gets the message sent meanwhile
  remove    the server forgotten, its lane's key is refused and its link stops
  logs      no key and no code in the board's log

    python3 -B -m unittest tests/test_remote_board.py
"""

import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
CLONE = APP.parent
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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


def free_port(*avoid):
    """A free port that is none of avoid: this system may hand out the next
    port along, which is the board's own phone port."""
    while True:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in avoid:
            return port


def until(check, seconds=20.0):
    ends = time.monotonic() + seconds
    while time.monotonic() < ends:
        found = check()
        if found:
            return found
        time.sleep(0.2)
    return None


class Relay:
    """A stand-in tailnet between the server side and the door: forwards
    every connection while up; while down, drops what it holds and every new
    connection at once, as a tailnet that has gone does once the peers see
    it."""

    def __init__(self, target_port):
        self.target = target_port
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(64)
        self.port = self.listener.getsockname()[1]
        self.up = True
        self.held = []
        self.lock = threading.Lock()
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                near, _ = self.listener.accept()
            except OSError:
                return
            if not self.up:
                near.close()
                continue
            try:
                far = socket.create_connection(("127.0.0.1", self.target), timeout=5)
                far.settimeout(None)
            except OSError:
                near.close()
                continue
            with self.lock:
                self.held += [near, far]
            for a, b in ((near, far), (far, near)):
                threading.Thread(target=self._pump, args=(a, b), daemon=True).start()

    def _pump(self, a, b):
        try:
            while True:
                data = a.recv(65536)
                if not data:
                    break
                b.sendall(data)
        except OSError:
            pass
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def drop(self):
        self.up = False
        with self.lock:
            held, self.held = self.held, []
        for s in held:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            s.close()

    def restore(self):
        self.up = True

    def close(self):
        self.drop()
        self.listener.close()


class ServerEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="rb-", dir="/tmp")).resolve()
        cls.outer = cls.root / "board"
        shutil.copytree(APP, cls.outer / "app",
                        ignore=shutil.ignore_patterns("tests", "__pycache__", "node_modules"))
        shutil.copytree(CLONE / ".agents", cls.outer / ".agents", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(CLONE / "docs", cls.outer / "docs")
        cls.data = cls.outer / "data"
        cls.data.mkdir(mode=0o700)
        cls.port = free_pair()
        cls.door = free_port(cls.port, cls.port + 1)
        (cls.data / "run.config.json").write_text(json.dumps({"port": cls.port, "lanes": []}))
        (cls.data / "seed.json").write_text(json.dumps({"title": "remote fixture", "items": []}))
        cls.mac_home = cls.root / "mac-home"
        cls.mac_home.mkdir()
        cls.home = cls.root / "server"
        cls.home.mkdir()
        for name in ("demo", "other", ".hidden"):
            (cls.home / name).mkdir()
        cls.logs = cls.root / "logs"
        cls.env = {**os.environ, "HOME": str(cls.mac_home), "FACILITATOR_TEST_PORT": str(cls.port),
                   "FACILITATOR_TEST_AGENT_PORT": str(cls.door), "FACILITATOR_LOG_DIR": str(cls.logs),
                   "PYTHONDONTWRITEBYTECODE": "1"}
        cls.board = subprocess.Popen([sys.executable, "-B", str(cls.outer / "app" / "server.py")],
                                     cwd=cls.outer / "app", env=cls.env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if not until(lambda: cls.get("/state")[0] == 200, 15):
            cls.board.kill()
            raise AssertionError("the board did not start: " + cls.board.stderr.read().decode()[-2000:])
        cls.relay = Relay(cls.door)

    @classmethod
    def tearDownClass(cls):
        pid = cls.link_pid()
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        cls.relay.close()
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
            with NO_PROXY.open(request, timeout=30) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as refused:
            with refused:
                return refused.code, json.load(refused)
        except (OSError, ValueError):
            return None, None

    @classmethod
    def link_pid(cls):
        try:
            return int((cls.home / ".facilitator" / "link.lock").read_text().strip() or 0)
        except (OSError, ValueError):
            return 0

    def board_log(self):
        """The board's log, for a failure's message."""
        return "\n" + "".join(p.read_text(errors="replace")[-3000:] for p in self.logs.glob("*") if p.is_file())

    def cli(self, *words):
        return subprocess.run([sys.executable, "-B", str(self.outer / "app" / "facilitator"), *words],
                              env=self.env, capture_output=True, text=True, timeout=90)

    def on_server(self, argv, stdin="", wait=True):
        """A program run as the owner's account on the server: its own home,
        no terminal, and the board only through the relay."""
        env = {**self.env, "HOME": str(self.home)}
        for name in ("FACILITATOR_TEST_PORT", "FACILITATOR_TEST_AGENT_PORT", "FACILITATOR_LOG_DIR"):
            env.pop(name, None)
        if not wait:
            return subprocess.Popen(argv, cwd=self.home / "demo", env=env, stdout=subprocess.PIPE, text=True,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
        return subprocess.run(argv, cwd=self.home / "demo", env=env, input=stdin, capture_output=True, text=True,
                              timeout=120, start_new_session=True)

    def helper(self, *words, wait=True):
        script = self.home / ".agents" / "skills" / "facilitator" / "scripts" / "onboard.py"
        argv = [sys.executable, "-B", str(script), *words]
        if not wait:
            return self.on_server(argv, wait=False)
        r = self.on_server(argv)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def curl(self, config, method, route, body=None, key_file=True):
        argv = ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "-X", method, "http://board" + route]
        if key_file:
            argv[1:1] = ["-K", str(config)]
        else:
            argv[1:1] = ["--noproxy", "*", "--connect-to", f"::127.0.0.1:{self.relay.port}"]
        if body is not None:
            argv[1:1] = ["--data-binary", body]
        return int(self.on_server(argv).stdout or 0)

    def online(self, want=True, seconds=30):
        def check():
            _, said = self.get("/remote/servers")
            hit = [s for s in (said or {}).get("servers", []) if s["id"] == "lab"]
            return hit and hit[0]["up"] == want
        return until(check, seconds)

    def card(self, owner):
        _, st = self.get("/state")
        return next(b for b in st["boxes"] if b["owner"] == owner)

    def mode(self, path):
        return stat.S_IMODE(os.lstat(path).st_mode)

    # -- the whole run, in order
    def test_a_server_end_to_end(self):
        # pair: the line and the code, printed on the Mac
        paired = self.cli("remote", "pair", "--name", "lab")
        self.assertEqual(paired.returncode, 0, paired.stdout + paired.stderr + self.board_log())
        line = re.search(r"curl -fsS --noproxy '\*' (http://\S+)/remote/setup \| python3 - (http://\S+)", paired.stdout)
        code = re.search(r"Pairing code: (\S+)", paired.stdout).group(1)
        self.assertEqual(line.group(1), f"http://127.0.0.1:{self.door}")
        self.assertEqual(line.group(1), line.group(2))
        # the server reaches the door through the relay, as over the tailnet
        door = f"http://127.0.0.1:{self.relay.port}"
        with NO_PROXY.open(door + "/remote/setup", timeout=10) as r:
            setup = r.read()
        self.assertEqual(setup, (CLONE / ".agents/skills/facilitator/scripts/pair.py").read_bytes())
        (self.root / "setup.py").write_bytes(setup)
        ran = self.on_server([sys.executable, "-B", str(self.root / "setup.py"), door], stdin=code + "\n")
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        self.assertIn("Paired with the board as lab.", ran.stdout)
        self.assertIn("The link is connected.", ran.stdout)
        top = self.home / ".facilitator"
        server_key = (top / "server.key").read_text().strip()
        self.assertNotIn(server_key, ran.stdout + ran.stderr + paired.stdout)
        self.assertEqual((self.mode(top), self.mode(top / "server.key"), self.mode(top / "agents")),
                         (0o700, 0o600, 0o700))
        for rel in ("skill/.agents/skills/facilitator/SKILL.md", "skill/.agents/skills/facilitator/scripts/onboard.py",
                    "skill/.agents/skills/facilitator/scripts/link.py", "skill/app/RUNBOOK.md",
                    "skill/docs/README.md", "skill/docs/servers.md", "skill/remote.json"):
            self.assertTrue((top / rel).is_file(), rel)
        self.assertEqual(json.loads((top / "skill" / "remote.json").read_text())["board"], door)
        for link in (self.home / ".agents" / "skills" / "facilitator", self.home / ".claude" / "skills" / "facilitator"):
            self.assertEqual(os.readlink(link), str(top / "skill" / ".agents" / "skills" / "facilitator"))
        saved = (self.data / "remote" / "servers.json").read_text()
        self.assertNotIn(server_key, saved)
        self.assertEqual(json.loads(saved)["servers"][0]["id"], "lab")
        self.assertEqual(self.mode(self.data / "remote" / "servers.json"), 0o600)
        self.assertTrue(self.online(True, 10))
        # the code worked once
        again = self.on_server([sys.executable, "-B", str(self.root / "setup.py"), door], stdin=code + "\n")
        self.assertEqual(again.returncode, 1)
        self.assertIn("that code is not known or has run out", again.stdout)

        # listing, through the folder picker's own routes: this Mac first, then
        # the server, its folders listed and made there by its link
        _, picker = self.get("/machines")
        self.assertEqual([(m["id"], m["kind"], m["online"]) for m in picker["machines"]],
                         [("this", "computer", True), ("lab", "server", True)])
        self.assertEqual(picker["machines"][1]["top"], str(self.home))
        status, listed = self.get("/dirs?machine=lab&path=")
        self.assertEqual(status, 200, listed)
        self.assertEqual((listed["machine"], listed["path"], listed["cut"]), ("lab", str(self.home), False))
        self.assertEqual([d["name"] for d in listed["dirs"]], ["demo", "other"])
        status, made = self.call("POST", f"/mkdir?machine=lab&path={self.home / 'other'}&name=fresh")
        self.assertEqual((status, made["path"]), (200, str(self.home / "other" / "fresh")))
        self.assertTrue((self.home / "other" / "fresh").is_dir())
        self.assertEqual(self.get("/dirs?machine=nowhere&path=")[1], {"error": "no such machine"})
        self.assertEqual(self.get("/dirs?machine=lab&path=" + "a" * 5000), (400, {"error": "that path is too long"}))
        self.assertEqual(self.get("/dirs?machine=lab&path=~root"), (400, {"error": "outside the home folder"}))
        self.assertEqual(self.get("/dirs?machine=lab&path=.hidden"), (400, {"error": "that folder is hidden"}))
        status, refused = self.call("POST", f"/mkdir?machine=lab&path={self.home}&name=a%E2%80%AEb")
        self.assertEqual((status, refused["error"]), (400, "a folder name cannot hold an invisible character"))

        # projects
        status, made = self.call("POST", "/project?name=demo&machine=lab", str(self.home / "demo"))
        self.assertEqual(status, 200, made)
        self.assertEqual(made["machine"], "lab")
        self.call("POST", "/project?name=other&machine=lab", str(self.home / "other"))
        status, refused = self.call("POST", "/project?name=x&machine=lab", "/")
        self.assertEqual((status, refused["error"]), (400, "outside the home folder"))
        _, st = self.get("/state")
        demo = next(p for p in st["projects"] if p["id"] == "demo")
        self.assertEqual((demo["server"], demo["dir"]), ("lab", str(self.home / "demo")))
        self.assertEqual(st["remote"]["servers"]["lab"], {"name": "lab", "up": True, "faded": False})
        box = self.card("demo")["id"]

        # agent
        joined = self.helper("inspect")
        self.assertEqual((joined["status"], joined["owner"], joined["remote"]), ("ready", "demo", True))
        self.assertEqual(joined["base"], "http://board")
        key_file = top / "agents" / "demo.key"
        config = top / "agents" / "demo.curl"
        self.assertEqual(joined["curl"], f"-K {config}")
        self.assertEqual((self.mode(key_file), self.mode(config)), (0o600, 0o600))
        agent_key = key_file.read_text().strip()
        self.assertNotIn(agent_key, json.dumps(joined))
        self.assertIn('noproxy = "*"', config.read_text())
        self.assertEqual(self.call("POST", f"/send?box={box}", "hello from the board")[0], 200)
        claim = self.helper("wait", "--owner", "demo", "--agent", "claude", "--timeout", "20")
        self.assertEqual((claim["status"], claim["box"], claim["messages"]), ("claim", box, ["hello from the board"]))
        # a second agent joining now finds the card held and takes no key
        held = self.helper("inspect")
        self.assertEqual((held["status"], held["box"]), ("claim_held", box))
        self.assertEqual(key_file.read_text().strip(), agent_key)
        self.assertEqual(self.curl(config, "POST", f"/reply?box={box}", "the answer from the server"), 200)
        self.assertEqual(self.card("demo")["reply"], "the answer from the server")
        self.assertEqual(self.curl(config, "GET", "/wait?owner=other&timeout=1"), 403)
        self.assertEqual(self.curl(config, "POST", f"/reply?box={self.card('other')['id']}", "no"), 403)
        self.assertEqual(self.curl(config, "GET", "/state"), 403)
        self.assertEqual(self.curl(config, "GET", "/remote/lane", key_file=False), 401)

        # drop: the stand-in tailnet goes away
        self.relay.drop()
        self.assertTrue(self.online(False, 15), "the server did not go offline with the tailnet")
        _, st = self.get("/state")
        self.assertEqual(st["remote"]["servers"]["lab"]["faded"], False)   # not yet: 30 seconds
        self.assertEqual(self.get("/dirs?machine=lab&path=")[1], {"error": "lab is not connected"})
        self.assertEqual(self.call("POST", f"/send?box={box}", "sent while it was down")[0], 200)
        waiting = self.helper("wait", "--owner", "demo", "--agent", "claude", "--timeout", "90", wait=False)
        time.sleep(4)
        self.assertIsNone(waiting.poll(), "the wait gave up while the tailnet was down")
        self.relay.restore()
        self.assertTrue(self.online(True, 40), "the link did not come back by itself")
        out, _ = waiting.communicate(timeout=90)
        got = json.loads(out.strip().splitlines()[-1])
        self.assertEqual((got["status"], got["messages"]), ("claim", ["sent while it was down"]))
        self.assertEqual(self.curl(config, "POST", f"/reply?box={box}", "got it"), 200)

        # remove
        removed = self.cli("remote", "remove", "lab")
        self.assertEqual(removed.returncode, 0, removed.stdout + removed.stderr)
        self.assertEqual(self.get("/remote/servers")[1]["servers"], [])
        self.assertEqual(self.curl(config, "GET", "/remote/lane"), 401)
        self.assertNotIn(agent_key, (self.data / "remote" / "keys.json").read_text())
        state = top / "link.state"
        self.assertTrue(until(lambda: json.loads(state.read_text()).get("refused"), 30),
                        "the link did not stop when the board forgot its key")

        # logs
        text = "".join(p.read_text(errors="replace") for p in self.logs.glob("*") if p.is_file())
        self.assertIn("remotepaired", text)
        self.assertIn("remotelink", text)
        for secret in (server_key, agent_key, code, code.replace("-", "")):
            self.assertNotIn(secret, text)
        link_log = (top / "link.log").read_text()
        for secret in (server_key, agent_key, str(self.relay.port)):
            self.assertNotIn(secret, link_log)


if __name__ == "__main__":
    unittest.main()
