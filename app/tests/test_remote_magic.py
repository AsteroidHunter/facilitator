"""The magic box from a server, end to end, as tests/test_remote_board.py
stands a server up: a board running from a scratch copy of the checkout with
its agent door on loopback (test mode), a "server" that is a scratch home
paired with it by the setup program the door hands out, and a relay between
the two in place of the tailnet. An agent there has joined its lane and runs
the skill's scripts/magic.py with the words `facilitator magic` takes.

  kinds     text, markdown, html (from a file and from standard input), a
            picture from a file: each fills the lane's own card's box, and
            the board holds exactly what was sent; show, close and reopen
            answer as on the Mac
  lanes     the lane's key fills no box of another lane's card or of a card
            on the Mac, and reads no /state or page's reading of a box: the
            door's own answers; no key or a wrong one is 401
  two keys  with two lanes joined here, each card's box is filled with its
            own lane's key, and a card on the Mac is still refused
  limits    a body at the box's limits goes through the door; one past them,
            and a website or web picture on this computer, the home network
            or the tailnet, get the board's own refusal, and the box is left
            as it was
  secrets   nothing the command prints holds a key or the board's address,
            the board cannot be reached included, and no key is in the
            board's log

    python3 -B -m unittest tests/test_remote_magic.py
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_remote_board import NO_PROXY, Relay, free_pair, free_port, until  # noqa: E402

APP = HERE.parent
CLONE = APP.parent
MIB = 1024 * 1024
PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + bytes(range(64))


class MagicFromAServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="rm-", dir="/tmp")).resolve()
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
        (cls.data / "seed.json").write_text(json.dumps({"title": "remote magic fixture", "items": []}))
        cls.mac_home = cls.root / "mac-home"
        cls.mac_home.mkdir()
        cls.home = cls.root / "server"
        for name in ("demo", "other", "files"):
            (cls.home / name).mkdir(parents=True)
        cls.logs = cls.root / "logs"
        cls.env = {**os.environ, "HOME": str(cls.mac_home), "FACILITATOR_TEST_PORT": str(cls.port),
                   "FACILITATOR_TEST_AGENT_PORT": str(cls.door), "FACILITATOR_LOG_DIR": str(cls.logs),
                   "PYTHONDONTWRITEBYTECODE": "1"}
        cls.board = subprocess.Popen([sys.executable, "-B", str(cls.outer / "app" / "server.py")],
                                     cwd=cls.outer / "app", env=cls.env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            if not until(lambda: cls.call("GET", "/state")[0] == 200, 15):
                raise AssertionError("the board did not start: " + cls.board.stderr.read().decode()[-2000:])
            cls.relay = Relay(cls.door)
            cls.pair()
            cls.demo_box = cls.project("demo")
            cls.other_box = cls.project("other")
            status, made = cls.call("POST", "/create?owner=facilitator", "a card on the Mac")
            assert status == 200, made
            cls.mac_box = made["id"]
            joined = cls.helper("inspect")
            assert (joined["status"], joined["owner"]) == ("ready", "demo"), joined
        except BaseException:
            cls.tearDownClass()
            raise
        cls.top = cls.home / ".facilitator"
        cls.config = cls.top / "agents" / "demo.curl"
        cls.agent_key = (cls.top / "agents" / "demo.key").read_text().strip()

    @classmethod
    def tearDownClass(cls):
        try:
            pid = int((cls.home / ".facilitator" / "link.lock").read_text().strip() or 0)
        except (OSError, ValueError):
            pid = 0
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if getattr(cls, "relay", None) is not None:
            cls.relay.close()
        cls.board.terminate()
        try:
            cls.board.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.board.kill()
        cls.board.stderr.close()
        time.sleep(0.5)
        shutil.rmtree(cls.root, ignore_errors=True)

    # -- the board, from the Mac
    @classmethod
    def call(cls, method, route, body=None):
        request = urllib.request.Request(f"http://127.0.0.1:{cls.port}{route}", method=method,
                                         data=body.encode() if isinstance(body, str) else body)
        try:
            with NO_PROXY.open(request, timeout=30) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if r.headers.get_content_type() == "application/json" else raw)
        except urllib.error.HTTPError as refused:
            with refused:
                return refused.code, json.load(refused)
        except (OSError, ValueError):
            return None, None

    @classmethod
    def on_server(cls, argv, stdin=""):
        """A program run as the owner's account on the server: its own home,
        no terminal, and the board only through the relay."""
        env = {**cls.env, "HOME": str(cls.home)}
        for name in ("FACILITATOR_TEST_PORT", "FACILITATOR_TEST_AGENT_PORT", "FACILITATOR_LOG_DIR"):
            env.pop(name, None)
        return subprocess.run(argv, cwd=cls.home / "demo", env=env, input=stdin, capture_output=True, text=True,
                              timeout=120, start_new_session=True)

    @classmethod
    def pair(cls):
        """`facilitator remote pair` on the Mac, then the setup program the
        door hands out, run on the server with the code; with no terminal it
        reads the code from standard input."""
        paired = subprocess.run([sys.executable, "-B", str(cls.outer / "app" / "facilitator"), "remote", "pair",
                                 "--name", "lab"], env=cls.env, capture_output=True, text=True, timeout=90)
        assert paired.returncode == 0, paired.stdout + paired.stderr
        code = re.search(r"Pairing code: (\S+)", paired.stdout).group(1)
        door = f"http://127.0.0.1:{cls.relay.port}"
        with NO_PROXY.open(door + "/remote/setup", timeout=10) as r:
            (cls.root / "pair.py").write_bytes(r.read())
        done = cls.on_server([sys.executable, "-B", str(cls.root / "pair.py"), door], stdin=code + "\n")
        assert done.returncode == 0 and "The link is connected." in done.stdout, done.stdout + done.stderr

    @classmethod
    def project(cls, name):
        status, made = cls.call("POST", f"/project?name={name}&machine=lab", str(cls.home / name))
        assert status == 200, made
        _, st = cls.call("GET", "/state")
        return next(b["id"] for b in st["boxes"] if b["owner"] == name)

    @classmethod
    def helper(cls, *words):
        script = cls.home / ".agents" / "skills" / "facilitator" / "scripts" / "onboard.py"
        r = cls.on_server([sys.executable, "-B", str(script), *words])
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout.strip().splitlines()[-1])

    # -- the agent on the server
    def secrets(self):
        keys = [p.read_text().strip() for p in (self.top / "agents").glob("*.key")]
        return keys + [(self.top / "server.key").read_text().strip(), "127.0.0.1", f":{self.relay.port}",
                       f":{self.door}", f":{self.port}"]

    def magic(self, *words, stdin=""):
        """scripts/magic.py on the server, as the skill names it there; what
        it prints never holds a key or the board's address."""
        script = self.home / ".agents" / "skills" / "facilitator" / "scripts" / "magic.py"
        r = self.on_server([sys.executable, "-B", str(script), *words], stdin=stdin)
        for secret in self.secrets():
            self.assertNotIn(secret, r.stdout + r.stderr)
        return r

    def filled(self, *words, stdin=""):
        r = self.magic(*words, stdin=stdin)
        self.assertEqual((r.returncode, r.stderr), (0, ""), r.stdout)
        lines = r.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, r.stdout)
        return json.loads(lines[0])

    def refused(self, words_said, *words, stdin=""):
        r = self.magic(*words, stdin=stdin)
        self.assertEqual((r.returncode, r.stdout, r.stderr.strip()), (1, "", "magic: " + words_said))

    def held(self, box):
        status, said = self.call("GET", f"/magic/body?box={box}")
        return said if status == 200 else None

    def curl(self, method, route, body=None, key="file"):
        """(status, answer) for a curl line on the server, as the runbook
        writes them, with the lane's file, no key or a made-up one."""
        argv = ["curl", "-sS", "-X", method, "http://board" + route]
        if key == "file":
            argv[1:1] = ["-K", str(self.config)]
        else:
            argv[1:1] = ["--noproxy", "*", "--connect-to", f"::127.0.0.1:{self.relay.port}"]
            if key:
                argv[1:1] = ["-H", "Authorization: Bearer " + key]
        if body is not None:
            argv[1:1] = ["--data-binary", body]
        argv[1:1] = ["-w", "\n%{http_code}"]
        out = self.on_server(argv).stdout
        said, _, status = out.rpartition("\n")
        return int(status or 0), json.loads(said) if said else None

    # -- the cases
    def test_a_each_kind_fills_the_lanes_own_card(self):
        box = self.demo_box
        made = self.filled(box, "text", "plain *words*, shown as typed", "--title", "Words")
        self.assertEqual((made["ok"], made["box"], made["kind"], made["shown"]), (True, box, "text", "inline"))
        self.assertEqual((self.held(box)["text"], self.held(box)["title"]), ("plain *words*, shown as typed", "Words"))

        notes = self.home / "files" / "sizes.md"
        notes.write_text("# Sizes\n\n| one | two |\n|---|---|\n| 1 | 2 |")
        self.assertEqual(self.filled(box, "markdown", "--file", str(notes), "--title", "Sizes")["kind"], "markdown")
        self.assertEqual((self.held(box)["kind"], self.held(box)["text"], self.held(box)["title"]),
                         ("markdown", notes.read_text(), "Sizes"))

        page = self.home / "files" / "page.html"
        page.write_text("<!doctype html><style>p{color:teal}</style><p>made on the server</p>"
                        "<script>document.body.dataset.ran = 1</script>")
        self.filled(box, "html", "--file", str(page))
        self.assertEqual((self.held(box)["kind"], self.held(box)["html"]), ("html", page.read_text()))
        self.filled(box, "html", "-", stdin="<!doctype html><p>from standard input</p>")
        self.assertEqual(self.held(box)["html"], "<!doctype html><p>from standard input</p>")

        picture = self.home / "files" / "plot.png"
        picture.write_bytes(PNG)
        self.assertEqual(self.filled(box, "image", "--file", str(picture))["kind"], "image")
        shown = self.held(box)
        self.assertEqual(shown["kind"], "image")
        self.assertEqual(self.call("GET", shown["src"]), (200, PNG))

        said = self.filled(box, "show")
        self.assertEqual((said["box"], said["open"], said["kind"], said["rev"]), (box, True, "image", shown["rev"]))
        self.assertEqual(self.filled(box, "close")["open"], False)
        self.assertEqual(self.filled(box, "show")["open"], False)
        self.assertEqual(self.held(box)["open"], False)
        self.assertEqual(self.filled(box, "reopen")["open"], True)
        _, st = self.call("GET", "/state")
        card = next(b for b in st["boxes"] if b["id"] == box)
        self.assertEqual((card["magic"]["open"], card["magic"]["kind"], card["magic"]["rev"]), (True, "image", shown["rev"]))

        # the Mac's own refusals for what the command cannot send
        self.refused("give the content once: as one argument, as --file PATH, or as - to read standard input",
                     box, "text")
        self.refused("close takes only the card", box, "close", "extra")
        self.assertEqual(self.magic("--help").returncode, 0)

    def test_b_another_lanes_card_and_the_rest_are_refused(self):
        for box in (self.other_box, self.mac_box):
            with self.subTest(box=box):
                self.refused("this key is for another project", box, "text", "not yours")
                self.refused("this key is for another project", box, "show")
                self.refused("this key is for another project", box, "close")
                self.assertIsNone(self.held(box))
                self.assertEqual(self.curl("POST", f"/magic?box={box}&kind=text", "not yours"),
                                 (403, {"error": "this key is for another project"}))
                self.assertEqual(self.curl("POST", f"/magic/reopen?box={box}"),
                                 (403, {"error": "this key is for another project"}))
        self.refused("this key is for another project", "no-such-card", "text", "x")
        for route in ("/state", f"/magic/body?box={self.demo_box}", f"/magic/img?box={self.demo_box}"):
            with self.subTest(route=route):
                self.assertEqual(self.curl("GET", route), (403, {"error": "an agent on a server may not use this"}))
        for key in ("", "made-up-key"):
            with self.subTest(key=key):
                self.assertEqual(self.curl("POST", f"/magic?box={self.demo_box}&kind=text", "x", key=key),
                                 (401, {"error": "this key is not known: join again"}))
                self.assertEqual(self.curl("GET", f"/magic?box={self.demo_box}", key=key),
                                 (401, {"error": "this key is not known: join again"}))
        before = self.held(self.demo_box)
        held = self.top / "agents" / "demo.key"
        held.write_text("made-up-key\n")
        try:
            self.refused("this key is not known: join again", self.demo_box, "text", "with a wrong key")
        finally:
            held.write_text(self.agent_key + "\n")
        self.assertEqual(self.held(self.demo_box), before)

    def test_c_two_lanes_here_each_with_its_own_key(self):
        joined = self.helper("inspect", "--board", "other")
        self.assertEqual((joined["status"], joined["owner"]), ("ready", "other"))
        try:
            self.assertEqual(self.filled(self.other_box, "text", "for the other lane")["box"], self.other_box)
            self.assertEqual(self.held(self.other_box)["text"], "for the other lane")
            self.assertEqual(self.filled(self.demo_box, "text", "for this lane")["box"], self.demo_box)
            self.assertEqual(self.held(self.demo_box)["text"], "for this lane")
            self.refused("this key is for another project", self.mac_box, "text", "still not yours")
            self.assertIsNone(self.held(self.mac_box))
        finally:
            for name in ("other.key", "other.curl"):
                (self.top / "agents" / name).unlink()

    def test_d_the_boards_own_limits_and_address_checks(self):
        box = self.demo_box
        files = self.home / "files"
        (files / "whole.txt").write_bytes(b"a" * MIB)
        self.filled(box, "text", "--file", str(files / "whole.txt"))
        self.assertEqual(len(self.held(box)["text"]), MIB)
        (files / "picture.png").write_bytes(PNG + b"\x00" * (10 * MIB - len(PNG)))
        self.filled(box, "image", "--file", str(files / "picture.png"))
        self.assertEqual(self.call("GET", self.held(box)["src"])[1], (files / "picture.png").read_bytes())
        rev = self.held(box)["rev"]

        (files / "over.txt").write_bytes(b"a" * (MIB + 1))
        for kind in ("text", "markdown", "html"):
            with self.subTest(kind=kind):
                self.refused("text and pages are limited to 1 MiB", box, kind, "--file", str(files / "over.txt"))
        (files / "over.png").write_bytes(PNG + b"\x00" * (10 * MIB + 1 - len(PNG)))
        self.refused("text and pages are limited to 1 MiB, pictures to 10 MiB",
                     box, "image", "--file", str(files / "over.png"))
        home = "addresses on this computer or the home network cannot be shown"
        for kind, address, words in (("url", "https://192.168.1.1/", home), ("url", "https://127.0.0.1/", home),
                                     ("url", "https://100.101.102.103/", home), ("url", "https://printer.local/", home),
                                     ("image", "https://10.0.0.2/plot.png", home),
                                     ("url", "http://example.org/", "only https addresses can be shown")):
            with self.subTest(address=address):
                self.refused(words, box, kind, address)
        self.assertEqual(self.held(box)["rev"], rev)
        self.assertEqual(self.held(box)["kind"], "image")

    def test_e_no_key_or_address_is_printed_or_logged(self):
        self.relay.drop()
        try:
            r = self.magic(self.demo_box, "text", "while the tailnet is away")
        finally:
            self.relay.restore()
        self.assertEqual((r.returncode, r.stdout), (1, ""))
        self.assertIn("magic: the board cannot be reached now", r.stderr)
        text = "".join(p.read_text(errors="replace") for p in self.logs.glob("*") if p.is_file())
        self.assertIn("magic", text)
        for secret in (self.agent_key, (self.top / "server.key").read_text().strip()):
            self.assertNotIn(secret, text)


if __name__ == "__main__":
    unittest.main()
