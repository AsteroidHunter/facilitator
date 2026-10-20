"""The board starts when Tailscale cannot be asked about Serve: a copy of the
server started in a sandbox of its own, with a home folder, a log folder and a
stand-in tailscale whose answer to `serve status --json` each case sets, on
ports the operating system hands out, never the real board's.

What is proved:

  cannot ask    a tailscale that fails, or answers nothing readable, no longer
                keeps the board down: it starts, answers this Mac as before,
                holds everything that carries a mark of Tailscale Serve on
                either port with a 503 and the sentence saying why, says the
                same in its reading (phoneOff) and its log, and lifts the hold
                by itself once a later check finds no old rule.
  found later   a check that later finds an old rule on the board's own port
                keeps the hold and says the old rule's own sentence, until the
                rule is gone.
  old rule      found at the start, the board stays down with today's sentence,
                and its port never opens.
  clear         nothing held, no line, and a request through Serve meets the
                phone's password gate as before.
  the switch    every tailscale call carries TAILSCALE_BE_CLI=1, which the
                sandbox's own environment does not.

    python3 -m unittest tests/test_serve_hold.py

The sandbox runs the Python running this test, which needs the board's own
packages (requirements.txt). The real Tailscale is never asked: the stand-in
comes first on the sandbox's PATH.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
FILES = ("server.py", "bridge_auth.py", "bridge_gate.py", "m-gate.html", "m-splash.js", "index.html",
         "home-widgets.css", "home-widgets.js", "board-settings.js", "mac-phone-view.js", "magic-box.js",
         "data_folder.py")
REAL_PORTS = (8877, 8878)
# the sandbox's copy asks again after a second, and at most every two
FAST = (("SERVE_CHECK_FIRST = 30.0", "SERVE_CHECK_FIRST = 1.0"),
        ("SERVE_CHECK_MAX = 120.0", "SERVE_CHECK_MAX = 2.0"))
# the stand-in: serve status answers what serve.json holds and fails without
# it; status says Tailscale is stopped; each call notes TAILSCALE_BE_CLI
FAKE = """#!/bin/sh
echo "$1 $2 ${TAILSCALE_BE_CLI:-unset}" >> "$FAKE_DIR/calls.txt"
case "$1 $2" in
  "serve status") [ -f "$FAKE_DIR/serve.json" ] && exec cat "$FAKE_DIR/serve.json"; exit 1 ;;
  "status --json") echo '{"BackendState": "Stopped"}' ;;
  *) exit 1 ;;
esac
"""
UNKNOWN = ("The phone is off for now: Tailscale did not answer when the board asked whether an old Serve "
           "rule points at it, so nothing that comes through Tailscale is answered. The board asks again "
           "by itself; everything on this Mac works as usual.")
LEGACY = ("Old Tailscale Serve rule targets the unguarded board port. Run `facilitator bridge off`, "
          "then restart the board and run `facilitator bridge on`.")
# each mark alone, as Serve sets them (ipn/ipnlocal/serve.go)
MARKS = ({"X-Forwarded-For": "100.101.102.103"}, {"X-Forwarded-Host": "board.fixture.ts.net"},
         {"X-Forwarded-Proto": "https"}, {"Tailscale-User-Login": "owner@example.test"},
         {"Tailscale-Funnel-Request": "?1"})


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


def _legacy_rule(port: int) -> str:
    return json.dumps({"Web": {"board.fixture.ts.net:443": {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{port}"}}}}})


class Sandbox:
    def __init__(self, test):
        self.test = test
        self.outer = Path(tempfile.mkdtemp(prefix="facilitator-serve-hold-"))
        test.addCleanup(shutil.rmtree, self.outer, True)
        self.app, self.data = self.outer / "app", self.outer / "data"
        self.home, self.logs, self.bin, self.fake = (self.outer / name for name in ("home", "logs", "bin", "fake"))
        for folder in (self.app, self.home, self.logs, self.bin, self.fake):
            folder.mkdir()
        self.data.mkdir(mode=0o700)
        for name in FILES:
            shutil.copy2(APP / name, self.app / name)
        source = (self.app / "server.py").read_text()
        for old, new in FAST:
            test.assertEqual(source.count(old), 1, old)
            source = source.replace(old, new)
        (self.app / "server.py").write_text(source)
        (self.bin / "tailscale").write_text(FAKE)
        os.chmod(self.bin / "tailscale", 0o755)
        (self.data / "profile.json").write_text(json.dumps(
            {"name": "Sandbox Owner", "email": None, "email_yes": False, "work": None, "time_zone": None}))
        (self.data / "seed.json").write_text(json.dumps({"title": "sandbox board", "items": [
            {"id": "1", "bucket": "meta", "title": "Seeded card", "owner": "facilitator"}]}))
        self.port = _free_pair()
        (self.data / "run.config.json").write_text(json.dumps({"port": self.port, "lanes": []}))
        self.child = None
        test.addCleanup(self.stop)

    def serve(self, text: str | None) -> None:
        """What the stand-in's serve status answers; None makes it fail."""
        path = self.fake / "serve.json"
        if text is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(text)

    def env(self) -> dict:
        env = {**os.environ, "HOME": str(self.home), "FACILITATOR_LOG_DIR": str(self.logs),
               "FACILITATOR_TEST_PORT": str(self.port), "FAKE_DIR": str(self.fake),
               "PYTHONDONTWRITEBYTECODE": "1",
               "PATH": os.pathsep.join([str(self.bin), str(Path(sys.executable).parent), "/usr/bin", "/bin"])}
        for name in ("FACILITATOR_LOG_LEVEL", "TAILSCALE_BE_CLI"):
            env.pop(name, None)
        return env

    def launch(self) -> None:
        self.output = open(self.outer / "server-output.txt", "w")
        self.child = subprocess.Popen([sys.executable, str(self.app / "server.py")], cwd=self.app, env=self.env(),
                                      stdout=self.output, stderr=subprocess.STDOUT)

    def start(self) -> None:
        self.launch()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.child.poll() is not None:
                raise AssertionError(f"the sandbox board exited ({self.child.returncode}):\n{self.said()}")
            try:
                lock = json.loads((self.data / "server.lock").read_text() or "{}")
                if lock.get("pid") == self.child.pid and self.ask(self.port, "/state")[0] == 200:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(0.05)
        raise AssertionError("the sandbox board did not answer")

    def said(self) -> str:
        return "\n".join([(self.outer / "server-output.txt").read_text()] +
                         [p.read_text(errors="replace")[-2000:] for p in sorted(self.logs.iterdir())])

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

    def ask(self, port: int, path: str, headers: dict | None = None):
        """(status, body text, headers) for one GET."""
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=10) as answer:
                return answer.status, answer.read().decode(), answer.headers
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.read().decode(), error.headers

    def reading(self) -> dict:
        status, body, _ = self.ask(self.port, "/state")
        self.test.assertEqual(status, 200)
        return json.loads(body)

    def lines(self, kind: str) -> list[dict]:
        found = []
        for path in sorted(self.logs.glob("server-*.log")):
            found += [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        return [line for line in found if line.get("kind") == kind]

    def calls(self) -> list[str]:
        path = self.fake / "calls.txt"
        return path.read_text().splitlines() if path.exists() else []

    def until(self, check, seconds: float = 15.0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            found = check()
            if found:
                return found
            time.sleep(0.1)
        raise AssertionError("not within the time")


class ServeHold(unittest.TestCase):
    def held(self, box: Sandbox, words: str) -> None:
        """Everything Serve marks is held on both ports with these words; this
        Mac's own requests are answered as before."""
        self.assertEqual(box.reading()["phoneOff"], words)
        for marks in MARKS:
            for port, path in ((box.port, "/state"), (box.port + 1, "/auth/check"), (box.port + 1, "/m")):
                status, body, headers = box.ask(port, path, marks)
                self.assertEqual((status, body), (503, words), (port, path, marks))
                self.assertEqual(headers["Retry-After"], "1")
                self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(box.ask(box.port + 1, "/auth/check")[0], 200, "the local gate check is not held")

    def lifted(self, box: Sandbox) -> None:
        self.assertNotIn("phoneOff", box.reading())
        status, body, _ = box.ask(box.port, "/state", {"X-Forwarded-For": "100.101.102.103"})
        self.assertEqual(status, 401, "a request through Serve meets the phone's gate, as before")
        self.assertEqual(box.ask(box.port + 1, "/auth/check", {"X-Forwarded-For": "100.101.102.103"})[0], 200)

    def test_a_tailscale_that_fails_holds_serve_and_the_board_starts(self):
        box = Sandbox(self)
        box.serve(None)
        box.start()
        self.held(box, UNKNOWN)
        first = box.lines("servecheck")
        self.assertEqual([(l["level"], l["outcome"], l["held"], l["again_s"], l["reason"]) for l in first],
                         [("error", "unknown", True, 1, UNKNOWN)])
        refused = [l for l in box.lines("refusal") if l.get("reason") == "phone off"]
        self.assertTrue(refused and all(l["code"] == 503 for l in refused), refused)
        tries = len([c for c in box.calls() if c.startswith("serve status")])
        time.sleep(4)   # a second, then two, then two: the checks are calm, and a
        later = len([c for c in box.calls() if c.startswith("serve status")])   # failed one is not logged again
        self.assertTrue(2 <= later - tries <= 4, (tries, later))
        self.assertEqual(len(box.lines("servecheck")), 1)
        box.serve("{}")
        box.until(lambda: "phoneOff" not in box.reading())
        self.lifted(box)
        last = box.lines("servecheck")[-1]
        self.assertEqual((last["level"], last["outcome"], last["held"]), ("info", "clear", False))
        self.assertTrue(box.calls() and all(c.endswith(" 1") for c in box.calls()), box.calls())

    def test_an_unreadable_answer_holds_too_and_an_old_rule_found_later_keeps_the_hold(self):
        box = Sandbox(self)
        box.serve("not json")
        box.start()
        self.held(box, UNKNOWN)
        box.serve(_legacy_rule(box.port))
        words = "The phone is off: old Tailscale Serve rule targets the unguarded board port. Run `facilitator " \
                "bridge off`, then restart the board and run `facilitator bridge on`."
        box.until(lambda: box.reading().get("phoneOff") == words)
        self.held(box, words)
        found = box.lines("servecheck")[-1]
        self.assertEqual((found["level"], found["outcome"], found["held"], found["reason"]),
                         ("error", "legacy", True, words))
        self.assertEqual(box.child.poll(), None, "the board stopped under this Mac")
        box.serve("{}")
        box.until(lambda: "phoneOff" not in box.reading())
        self.lifted(box)

    def test_an_old_rule_at_the_start_keeps_the_board_down(self):
        box = Sandbox(self)
        box.serve(_legacy_rule(box.port))
        box.launch()
        self.assertNotEqual(box.child.wait(20), 0)
        self.assertIn(LEGACY, box.said())
        with self.assertRaises(OSError):
            box.ask(box.port, "/state")

    def test_a_clear_answer_holds_nothing(self):
        box = Sandbox(self)
        box.serve("{}")
        box.start()
        self.lifted(box)
        self.assertEqual(box.lines("servecheck"), [])
        self.assertEqual(box.calls()[0], "serve status 1")


if __name__ == "__main__":
    unittest.main()
