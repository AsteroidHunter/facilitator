"""The search on a whole board: a copy of the server started in a sandbox of
its own, with a home folder, a log folder and a fake tailscale of its own, a
made-up seed and ports the operating system hands out, never the real board's.

What is proved:

  starting   a board with no index file starts, makes the file private and
             builds it, and searches; one without card_search.py starts and
             works as before, and answers /search with a 503.
  current    a card made, a message sent, a card renamed, binned and restored
             are each found as the board now has them, through its routes.
  no model   a model named in run.config.json whose packages are missing
             leaves the board searching by keyword, saying why.
  meaning    with the fake model named, the board searches by both and finds
             by meaning what the words miss (needs numpy in this Python).
  the log    no word of a card, a message or a query reaches it.

    python3 -m unittest tests/test_card_search_board.py

The sandbox runs the Python running this test, which needs the board's own
packages (requirements.txt).
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
import urllib.parse
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
FILES = ("server.py", "bridge_auth.py", "bridge_gate.py", "m-gate.html", "m-splash.js", "index.html",
         "home-widgets.css", "home-widgets.js", "board-settings.js", "mac-phone-view.js", "magic-box.js",
         "data_folder.py")
REAL_PORTS = (8877, 8878)
SECRET = "wombatfeather"   # a word that must never reach the log
try:
    import numpy  # noqa: F401
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


def _free_pair() -> int:
    for _ in range(50):
        with socket.socket() as first:
            first.bind(("127.0.0.1", 0))
            port = first.getsockname()[1]
            if port + 1 > 65535 or port in REAL_PORTS or port + 1 in REAL_PORTS:
                continue
            with socket.socket() as second:
                try:
                    second.bind(("127.0.0.1", port + 1))
                except OSError:
                    continue
        return port
    raise AssertionError("no free pair of ports")


class Sandbox:
    def __init__(self, test, search: bool = True, config: dict | None = None):
        self.outer = Path(tempfile.mkdtemp(prefix="facilitator-search-"))
        test.addCleanup(shutil.rmtree, self.outer, True)
        self.app, self.data = self.outer / "app", self.outer / "data"
        self.home, self.logs, self.bin, self.fake = (self.outer / name for name in ("home", "logs", "bin", "fake"))
        for folder in (self.app, self.home, self.logs, self.bin, self.fake):
            folder.mkdir()
        self.data.mkdir(mode=0o700)
        for name in FILES + (("card_search.py",) if search else ()):
            shutil.copy2(APP / name, self.app / name)
        shutil.copy2(APP / "tests" / "fixtures" / "fake-tailscale.py", self.bin / "tailscale")
        os.chmod(self.bin / "tailscale", 0o755)
        for name, value in (("status.json", {"BackendState": "Stopped"}), ("serve.json", {}),
                            ("control.json", {})):
            (self.fake / name).write_text(json.dumps(value))
        self.config = config
        (self.data / "profile.json").write_text(json.dumps(
            {"name": "Sandbox Owner", "email": None, "email_yes": False, "work": None, "time_zone": None}))
        (self.data / "seed.json").write_text(json.dumps({"title": "sandbox board", "items": [
            {"id": "1", "bucket": "meta", "title": "Seeded fence card", "owner": "facilitator"}]}))
        self.child = None
        test.addCleanup(self.stop)

    def start(self) -> None:
        # a pair free a moment ago can be taken before the board binds it, by
        # anything else on this Mac: the board then stays down, and another pair is tried
        for _ in range(5):
            if self._start_once():
                return
            self.stop()
        raise AssertionError("the sandbox board found no free pair of ports")

    def _start_once(self) -> bool:
        self.port = _free_pair()
        assert self.port not in REAL_PORTS
        (self.data / "run.config.json").write_text(json.dumps(
            {"port": self.port, "lanes": [], **({"search": self.config} if self.config is not None else {})}))
        env = {**os.environ, "HOME": str(self.home), "FACILITATOR_LOG_DIR": str(self.logs),
               "FACILITATOR_TEST_PORT": str(self.port), "TS_FAKE_DIR": str(self.fake),
               "PYTHONDONTWRITEBYTECODE": "1",
               "PATH": os.pathsep.join([str(self.bin), str(Path(sys.executable).parent), os.environ.get("PATH", "")])}
        env.pop("FACILITATOR_LOG_LEVEL", None)
        self.output = open(self.outer / "server-output.txt", "w")
        self.child = subprocess.Popen([sys.executable, str(self.app / "server.py")], cwd=self.app, env=env,
                                      stdout=self.output, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.child.poll() is not None:
                # what it said: its output, and its log, where a refused start is written
                said = "\n".join([(self.outer / "server-output.txt").read_text()] +
                                 [p.read_text(errors="replace")[-2000:] for p in sorted(self.logs.iterdir())])
                if '"bindfail"' in said:
                    return False
                raise AssertionError(f"the sandbox board exited ({self.child.returncode}):\n{said}")
            try:
                # this board's own answer: the lock it took names its pid
                lock = json.loads((self.data / "server.lock").read_text() or "{}")
                if lock.get("pid") == self.child.pid and self.get("/state")[0] == 200:
                    return True
            except (OSError, ValueError):
                pass
            time.sleep(0.05)
        raise AssertionError("the sandbox board did not answer")

    def stop(self) -> None:
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(10)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        if self.child is not None:
            self.output.close()
            self.child = None

    def _ask(self, method: str, path: str, body: str | None = None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                         data=None if body is None else body.encode())
        try:
            with urllib.request.urlopen(request, timeout=10) as answer:
                return answer.status, json.loads(answer.read() or b"null")
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b"null")

    def get(self, path: str):
        return self._ask("GET", path)

    def post(self, path: str, body: str = ""):
        status, answer = self._ask("POST", path, body)
        assert status == 200, (path, status, answer)
        return answer

    def search(self, **params):
        status, answer = self.get("/search?" + urllib.parse.urlencode(params))
        assert status == 200, answer
        return answer

    def until(self, check, seconds: float = 20.0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            found = check()
            if found:
                return found
            time.sleep(0.1)
        raise AssertionError("the board's search did not catch up")

    def ids(self, **params):
        return [r["card"] for r in self.search(**params)["results"]]


class Board(unittest.TestCase):
    def test_a_board_with_no_index_file_starts_builds_it_and_follows_changes(self):
        box = Sandbox(self)
        index = box.data / "search-index.sqlite"
        self.assertFalse(index.exists())
        box.start()
        status = box.until(lambda: (lambda s: s if s[1].get("ready") else None)(box.get("/search/status")))
        self.assertEqual(status[0], 200)
        self.assertEqual((status[1]["cards"], status[1]["semantic"]["state"]), (1, "off"))
        self.assertEqual(stat.S_IMODE(index.stat().st_mode), 0o600)
        self.assertEqual(box.ids(q="fence"), ["1"])

        made = box.post("/create?owner=facilitator", "Gutter repair")["id"]
        box.post(f"/send?box={made}", f"the downpipe leaks near the {SECRET}")
        box.until(lambda: box.ids(q="downpipe") == [made])
        hit = box.search(q=SECRET)["results"][0]
        self.assertEqual((hit["card"], hit["title"], hit["lane"], hit["section"], hit["match"]["kind"]),
                         (made, "Gutter repair", "facilitator", "doing", "user"))
        self.assertIn(SECRET, hit["match"]["snippet"])

        box.post(f"/title?box={made}", "Roof drainage")
        box.until(lambda: box.ids(q="drainage") == [made])
        self.assertEqual(box.ids(q="gutter"), [])
        self.assertEqual(box.ids(q="drainage downpipe"), [made])

        box.post(f"/bin?box={made}")
        box.until(lambda: box.ids(q="downpipe") == [])
        self.assertEqual(box.ids(q="downpipe", section="bin"), [made])
        box.post(f"/bin/restore?box={made}")
        box.until(lambda: box.ids(q="downpipe") == [made])

        today = time.strftime("%Y-%m-%d")
        self.assertEqual(sorted(box.ids(**{"from": today, "to": today})), sorted(["1", made]))
        self.assertEqual(box.ids(**{"to": "2000-01-01"}), [])
        status, refused = box.get("/search?section=" + SECRET)
        self.assertEqual(status, 400)
        self.assertNotIn(SECRET, refused["error"])

        box.stop()
        logged = "".join(p.read_text(errors="replace") for p in box.logs.iterdir() if p.is_file())
        self.assertIn('"searchindex"', logged)
        self.assertNotIn(SECRET, logged)
        self.assertNotIn("downpipe", logged)

    def test_a_board_without_card_search_runs_as_before(self):
        box = Sandbox(self, search=False)
        box.start()
        status, answer = box.get("/search?q=fence")
        self.assertEqual((status, answer["error"]), (503, "search is not running on this board"))
        self.assertEqual(box.get("/search/status")[0], 503)
        box.post("/send?box=1", "still works")
        self.assertEqual(box.get("/state")[0], 200)
        self.assertFalse((box.data / "search-index.sqlite").exists())

    def test_a_named_model_whose_packages_are_missing_leaves_keyword_search(self):
        box = Sandbox(self, config={"embedder": "sentence-transformers", "model": "google/embeddinggemma-2"})
        box.start()

        def settled():
            status = box.get("/search/status")[1]
            return status if status["ready"] and status["semantic"]["state"] == "unavailable" else None

        status = box.until(settled)
        self.assertIn("not installed (see docs/search.md)", status["semantic"]["reason"])
        answer = box.search(q="fence", mode="semantic")
        self.assertEqual((answer["mode"], answer["fallback"]), ("keyword", status["semantic"]["reason"]))
        self.assertEqual([r["card"] for r in answer["results"]], ["1"])
        self.assertEqual(box.search(q="fence")["mode"], "keyword")

    @unittest.skipUnless(HAS_NUMPY, "numpy is not installed in this Python")
    def test_the_fake_model_searches_by_meaning_through_the_route(self):
        box = Sandbox(self, config={"embedder": "fake", "dims": 512})
        box.start()
        made = box.post("/create?owner=facilitator", "Weekend errands")["id"]
        box.post(f"/send?box={made}", "my car broke down on the motorway")

        def embedded():
            status = box.get("/search/status")[1]
            semantic = status["semantic"]
            done = semantic["state"] == "ready" and semantic["waiting"] == 0 and semantic["embedded"] >= 3
            return status if done else None

        box.until(embedded)
        self.assertEqual(box.ids(q="automobile", mode="keyword"), [])
        answer = box.search(q="automobile")
        self.assertEqual(answer["mode"], "hybrid")
        self.assertEqual(answer["results"][0]["card"], made)
        self.assertEqual(answer["results"][0]["mode"], "semantic")


if __name__ == "__main__":
    unittest.main()
