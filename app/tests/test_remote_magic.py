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
  words     what the command cannot send is refused in the Mac command's
            own words

And the command against a stand-in door on a raw socket, which sees what it
puts on the wire:

  body      a body waits for the door's 100 Continue, so one the door
            refuses on sight is never sent and its answer is never cut off
  key       each key held is tried by reading the box first, and the body
            goes only with the key the door let through
  proxy     a proxy in the account's settings is never used
  setup     off a server, or with no lane key yet, it says so

    python3 -B -m unittest tests/test_remote_magic.py
"""

import json
import os
import re
import shutil
import signal
import socket
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

    def test_f_what_cannot_be_sent_in_the_macs_words(self):
        for words in (["0"], ["0", "text"], ["0", "text", "a", "b"], ["0", "text", "a", "--file", "x"],
                      ["0", "close", "extra"], ["0", "video", "x"], ["0", "text", "--title"],
                      ["0", "markdown", "--file", "/no/such/file.md"]):
            with self.subTest(words=words):
                mac = subprocess.run([sys.executable, "-B", str(self.outer / "app" / "facilitator"), "magic", *words],
                                     env=self.env, capture_output=True, text=True, timeout=60)
                here = self.magic(*words)
                self.assertEqual(here.returncode, mac.returncode)
                said = here.stderr.replace("magic.py CARD", "facilitator magic CARD")
                self.assertEqual(said.split("\n\n")[0], mac.stderr.split("\n\n")[0])


class Door:
    """A stand-in for the board's agent door on a raw socket, so what the
    command puts on the wire is seen as it is: each request's method, target
    and key, whether it waited for 100 Continue, and how many bytes of its
    body arrived. answer(method, target, key, length) gives (status, payload,
    take): take asks for the body with 100 Continue and reads it, and
    without it the door answers on sight, as the board does to a body past
    its limit, then counts what still comes."""

    def __init__(self, answer):
        self.answer = answer
        self._seen = []
        self._idle = threading.Event()
        self._idle.set()
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(8)
        self.port = self.listener.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    @property
    def seen(self):
        """What came, once the request in hand has been counted."""
        self._idle.wait(10)
        return self._seen

    def close(self):
        self.listener.close()

    def _serve(self):
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            self._idle.clear()
            with conn:
                conn.settimeout(10)
                try:
                    self._one(conn)
                except OSError:
                    pass
            self._idle.set()

    def _one(self, conn):
        head = b""
        while b"\r\n\r\n" not in head:
            got = conn.recv(1)
            if not got:
                return
            head += got
        lines = head.decode("latin-1").split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if line)}
        key = headers.get("authorization", "")[len("Bearer "):]
        length = int(headers.get("content-length") or 0)
        waited = headers.get("expect", "").lower() == "100-continue"
        status, payload, take = self.answer(method, target, key, length)
        got = 0
        if take and length:
            if waited:
                conn.sendall(b"HTTP/1.1 100 Continue\r\n\r\n")
            while got < length:
                piece = conn.recv(65536)
                if not piece:
                    break
                got += len(piece)
        raw = json.dumps(payload).encode()
        conn.sendall(b"HTTP/1.1 %d Answer\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
                     b"Connection: close\r\n\r\n" % (status, len(raw)) + raw)
        if not take:
            # whatever of the body was on its way while the answer went out
            time.sleep(0.3)
            conn.setblocking(False)
            try:
                while True:
                    piece = conn.recv(65536)
                    if not piece:
                        break
                    got += len(piece)
            except OSError:
                pass
        self._seen.append({"method": method, "target": target, "key": key, "waited": waited, "body": got})


class TheCommand(unittest.TestCase):
    """scripts/magic.py with a scratch server home and the stand-in door:
    two lanes' keys held, card m1 the other lane's."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="rmc-", dir="/tmp")).resolve()
        self.top = self.home / ".facilitator"
        scripts = self.top / "skill" / ".agents" / "skills" / "facilitator" / "scripts"
        scripts.mkdir(parents=True)
        self.script = scripts / "magic.py"
        shutil.copy(CLONE / ".agents" / "skills" / "facilitator" / "scripts" / "magic.py", self.script)
        (self.top / "agents").mkdir(mode=0o700)
        self.keys = {"demo": "k-demo-" + "x" * 32, "other": "k-other-" + "y" * 32}
        for lane, key in self.keys.items():
            (self.top / "agents" / (lane + ".key")).write_text(key + "\n")
        self.door = None

    def tearDown(self):
        if self.door is not None:
            self.door.close()
        shutil.rmtree(self.home, ignore_errors=True)

    def serve(self, limit=None):
        def answer(method, target, key, length):
            if key not in self.keys.values():
                return 401, {"error": "this key is not known: join again"}, False
            if key != self.keys["other"]:
                return 403, {"error": "this key is for another project"}, False
            if method == "GET":
                return 404, {"error": "this card has no magic box"}, False
            if limit is not None and length > limit:
                return 413, {"error": "pictures are limited"}, False
            return 200, {"ok": True, "box": "m1", "kind": "image", "rev": 1, "shown": "inline"}, True
        self.door = Door(answer)
        (self.top / "skill" / "remote.json").write_text(json.dumps(
            {"server": "lab", "name": "lab", "home": str(self.top), "board": f"http://127.0.0.1:{self.door.port}"}))

    def magic(self, *words, **env):
        r = subprocess.run([sys.executable, "-B", str(self.script), *words], cwd=self.home, capture_output=True,
                           text=True, timeout=60, env={**os.environ, "HOME": str(self.home), **env})
        for secret in [*self.keys.values(), "127.0.0.1", f":{self.door.port}" if self.door else "127.0.0.1"]:
            self.assertNotIn(secret, r.stdout + r.stderr)
        return r

    def test_a_refused_body_is_never_sent_and_its_answer_comes_back(self):
        self.serve(limit=MIB)
        big = self.home / "big.png"
        big.write_bytes(PNG + b"\x00" * (4 * MIB))
        r = self.magic("m1", "image", "--file", str(big))
        self.assertEqual((r.returncode, r.stdout, r.stderr.strip()), (1, "", "magic: pictures are limited"))
        posted = [s for s in self.door.seen if s["method"] == "POST"]
        self.assertEqual(len(posted), 1)
        self.assertEqual((posted[0]["waited"], posted[0]["body"]), (True, 0))

    def test_a_body_goes_after_100_continue_with_the_cards_own_key(self):
        self.serve()
        r = self.magic("m1", "text", "words for the box", "--title", "T")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["ok"], True)
        demo, other = self.keys["demo"], self.keys["other"]
        self.assertEqual([(s["method"], s["key"]) for s in self.door.seen],
                         [("GET", demo), ("GET", other), ("POST", other)])
        self.assertEqual(self.door.seen[0]["target"], "/magic?box=m1")
        self.assertEqual(self.door.seen[2]["target"], "/magic?box=m1&kind=text&title=T")
        self.assertEqual((self.door.seen[2]["waited"], self.door.seen[2]["body"]), (True, len("words for the box")))
        # close, reopen and show carry no body and wait for nothing
        for action in ("close", "reopen"):
            self.magic("m1", action)
            self.assertEqual((self.door.seen[-1]["method"], self.door.seen[-1]["target"],
                              self.door.seen[-1]["waited"]), ("POST", "/magic/" + action + "?box=m1", False))
        before = len(self.door.seen)
        r = self.magic("m1", "show")
        self.assertEqual((r.returncode, r.stderr.strip()), (1, "magic: this card has no magic box"))
        self.assertEqual(len(self.door.seen), before + 2)   # the reading is the show

    def test_no_proxy_is_used(self):
        self.serve()
        dead = "http://127.0.0.1:9"
        r = self.magic("m1", "text", "words", http_proxy=dead, HTTP_PROXY=dead, https_proxy=dead,
                       HTTPS_PROXY=dead, all_proxy=dead, ALL_PROXY=dead)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_off_a_server_or_with_no_key_it_says_so(self):
        r = self.magic("m1", "text", "words")
        self.assertEqual((r.returncode, r.stderr.strip()),
                         (1, "magic: this is not one of the owner's servers; on the Mac run facilitator magic"))
        self.serve()
        for held in (self.top / "agents").glob("*.key"):
            held.unlink()
        r = self.magic("m1", "text", "words")
        self.assertEqual((r.returncode, r.stderr.strip()), (1, "magic: no lane on this server has a key yet: onboard first"))
        self.assertEqual(self.door.seen, [])


if __name__ == "__main__":
    unittest.main()
