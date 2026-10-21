"""The board's update, on the server: the look for a newer version and what it offers.

  versions  v0.2.513 is compared number by number with main's label, and an
            offer is made only when main's is higher and both can be read
  look      main's index.html is read in its new place, then its old one, only
            as far as the version label; a look that fails waits an hour,
            twice as long after each failure in a row, never longer than a day
  checkout  only a checkout that `facilitator update` would bring up to main is
            looked for: on a branch that follows main, with no uncommitted
            changes and no commits of its own on top
  offer     /state carries update while a newer version waits for a yes, and
            not while the setting is off, the checkout cannot update or the
            person put it off until the next day's look
  progress  GET /update reads the stage lines the update writes, and its own
            one-line message when it stopped
  routes    the three routes answer only a page on this Mac

Nothing reaches GitHub or any other machine: every look here reads a fake, and
every real connection fails the test. The server is loaded as a module, its log
folder and every file it writes moved into a temporary directory.

    python3 -m unittest tests/test_update_check.py
"""

import asyncio
import http.client
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = tempfile.mkdtemp(prefix="update-test-logs-")
    os.environ.pop("FACILITATOR_UPDATE_SOURCE", None)
    os.environ.pop("FACILITATOR_UPDATE_EVERY", None)
    spec = importlib.util.spec_from_file_location("facilitator_server_update_test", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._save = lambda: None
    module._notify = lambda *a, **k: None
    return module


S = _load_server()
BASE = "https://raw.githubusercontent.com/AsteroidHunter/facilitator/main"


def no_network(*args, **kwargs):
    raise AssertionError("the test tried to reach the network")


class Page:
    """One answer of the fake GitHub: its body in pieces, counting the pieces read."""

    def __init__(self, pieces):
        self.pieces = list(pieces)
        self.read_count = 0

    def read(self, n=-1):
        if not self.pieces:
            return b""
        self.read_count += 1
        return self.pieces.pop(0)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Main:
    """GitHub's main, faked: rel path -> Page, or an HTTP status to refuse with."""

    def __init__(self, files):
        self.files = files
        self.asked = []

    def __call__(self, req, timeout=None):
        url = req.full_url
        self.asked.append(url)
        rel = url[len(BASE) + 1:]
        found = self.files.get(rel, 404)
        if isinstance(found, int):
            raise urllib.error.HTTPError(url, found, "refused", {}, io.BytesIO(b""))
        return found


def git(cwd, *args):
    done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if done.returncode != 0:
        raise AssertionError(f"git {' '.join(args)}: {done.stderr}")
    return done.stdout.strip()


class Case(unittest.TestCase):
    def setUp(self):
        self.guards = [mock.patch("urllib.request.urlopen", no_network),
                       mock.patch.object(http.client.HTTPSConnection, "connect", no_network),
                       mock.patch.object(http.client.HTTPConnection, "connect", no_network)]
        for guard in self.guards:
            guard.start()
        self.dir = Path(tempfile.mkdtemp(prefix="update-test-"))
        self.lines = []
        self.patches = [
            mock.patch.multiple(S, UPDATE_RECORD=self.dir / "update-check.json",
                                UPDATE_OUTPUT=self.dir / "update-output.txt",
                                UPDATE_SOURCE=BASE, UPDATE_EVERY=S.UPDATE_DAY,
                                _update_kept=None, _update_due=0.0, _update_fit="unknown",
                                _update_proc=None),
            mock.patch.object(S, "_info", lambda kind, box="", **f: self.lines.append((kind, f))),
        ]
        for p in self.patches:
            p.start()
        self.version = "v0.2.513"
        self.board = mock.patch.object(S, "_board_version", lambda: self.version)
        self.board.start()
        self.wanted = True
        self.setting = mock.patch.object(S, "_update_wanted", lambda: self.wanted)
        self.setting.start()

    def tearDown(self):
        for p in [self.setting, self.board, *self.patches, *self.guards]:
            p.stop()

    def kept(self):
        return json.loads(S.UPDATE_RECORD.read_text())


class Versions(Case):
    def test_a_higher_version_is_newer_number_by_number(self):
        self.assertTrue(S._newer("v0.2.514", "v0.2.513"))
        self.assertTrue(S._newer("v0.2.100", "v0.2.99"), "compared as text, not as numbers")
        self.assertTrue(S._newer("v0.3.0", "v0.2.999"))
        self.assertTrue(S._newer("v1.0.0", "v0.99.99"))

    def test_the_same_or_an_older_version_is_not_newer(self):
        self.assertFalse(S._newer("v0.2.513", "v0.2.513"))
        self.assertFalse(S._newer("v0.2.512", "v0.2.513"))
        self.assertFalse(S._newer("v0.2.99", "v0.2.100"))

    def test_a_label_that_cannot_be_read_never_makes_an_offer(self):
        for latest, current in [(None, "v0.2.513"), ("v0.2.514", None), ("0.2.514", "v0.2.513"),
                                ("v0.2.514", "unknown"), ("v0.2", "v0.1.0"), ("v0.2.514-rc", "v0.2.513"),
                                (514, "v0.2.513")]:
            self.assertFalse(S._newer(latest, current), (latest, current))
        self.assertEqual(S._version_key(" v0.2.513 "), (0, 2, 513))


class Look(Case):
    def test_main_is_read_in_the_old_place_when_the_new_one_has_nothing_and_only_to_the_label(self):
        page = Page([b"<html>" + b"x" * 100 + b'<span id="npver', b'sion">v0.2.516</span>', b"never read"])
        main = Main({"app/index.html": 404, "index.html": page})
        self.assertEqual(S._update_fetch(BASE, opener=main), "v0.2.516", "a label cut in two was not found")
        self.assertEqual(main.asked, [f"{BASE}/app/index.html", f"{BASE}/index.html"])
        self.assertEqual(page.read_count, 2, "it read on past the label")
        self.assertEqual(page.pieces, [b"never read"])

    def test_the_new_place_is_read_first_and_the_old_one_not_at_all(self):
        main = Main({"app/index.html": Page([b'<span id="npversion">v0.2.520</span>']), "index.html": 500})
        self.assertEqual(S._update_fetch(BASE, opener=main), "v0.2.520")
        self.assertEqual(main.asked, [f"{BASE}/app/index.html"])

    def test_a_refusal_other_than_not_found_and_a_main_with_no_label_are_failures(self):
        with self.assertRaises(OSError):
            S._update_fetch(BASE, opener=Main({"app/index.html": 429}))
        with self.assertRaises(ValueError):
            S._update_fetch(BASE, opener=Main({}))
        with self.assertRaises(ValueError):
            S._update_fetch(BASE, opener=Main({"app/index.html": Page([b"<html>no label</html>"])}))

    def test_a_failed_look_waits_an_hour_doubled_each_time_and_never_more_than_a_day(self):
        def refuse(base):
            raise urllib.error.URLError("no route")
        waits = []
        with mock.patch.object(S, "_update_checkout", lambda: None), mock.patch.object(S, "_update_fetch", refuse):
            for _ in range(7):
                before = time.time()
                S._update_look()
                waits.append(round((self.kept()["retry"] - before) / 3600))
                self.assertEqual(S._update_due, self.kept()["retry"])
        self.assertEqual(waits, [1, 2, 4, 8, 16, 24, 24])
        self.assertEqual(self.kept()["failures"], 7)
        with mock.patch.object(S, "_update_checkout", lambda: None), \
                mock.patch.object(S, "_update_fetch", lambda base: "v0.2.516"):
            S._update_look()
        kept = self.kept()
        self.assertEqual((kept["failures"], kept["retry"], kept["latest"]), (0, None, "v0.2.516"))
        self.assertAlmostEqual(S._update_due - kept["checked"], S.UPDATE_DAY, delta=1)

    def test_a_checkout_that_cannot_update_asks_nothing(self):
        with mock.patch.object(S, "_update_checkout", lambda: "notmain"), \
                mock.patch.object(S, "_update_fetch", lambda base: self.fail("asked GitHub")):
            S._update_look()
        self.assertEqual(S._update_fit, "notmain")
        self.assertFalse(S.UPDATE_RECORD.exists())
        self.assertGreater(S._update_due, time.time() + S.UPDATE_DAY - 5)

    def test_the_stand_in_for_github_is_honoured_only_on_this_mac(self):
        for stub, every, want in [
            ("http://127.0.0.1:9100/o/r/main", "20", ("http://127.0.0.1:9100/o/r/main", 20.0)),
            ("http://localhost:9100/", "", ("http://localhost:9100", S.UPDATE_DAY)),
            ("https://example.com/o/r/main", "20", (S.UPDATE_MAIN, S.UPDATE_DAY)),
            ("http://10.0.0.2:9100/", "20", (S.UPDATE_MAIN, S.UPDATE_DAY)),
            ("", "20", (S.UPDATE_MAIN, S.UPDATE_DAY)),
        ]:
            with mock.patch.dict(os.environ, {"FACILITATOR_UPDATE_SOURCE": stub, "FACILITATOR_UPDATE_EVERY": every}):
                self.assertEqual(S._update_source(), want, stub)


class Checkout(Case):
    """Real repositories in the test's own folder: a bare one for GitHub, and the clone."""

    def setUp(self):
        super().setUp()
        env = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
               "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com"}
        self.env = mock.patch.dict(os.environ, env)
        self.env.start()
        self.origin = self.dir / "origin.git"
        git(self.dir, "init", "--bare", "-b", "main", str(self.origin))
        seed = self.dir / "seed"
        git(self.dir, "clone", str(self.origin), str(seed))
        git(seed, "checkout", "-b", "main")
        (seed / "app").mkdir()
        (seed / "app" / "index.html").write_text('<span id="npversion">v0.2.513</span>\n')
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "Seed")
        git(seed, "push", "origin", "main")
        git(seed, "push", "origin", "main:premain")
        self.clone = self.dir / "user" / "facilitator"
        git(self.dir, "clone", str(self.origin), str(self.clone))
        self.where = mock.patch.object(S, "CLONE", self.clone)
        self.where.start()

    def tearDown(self):
        self.where.stop()
        self.env.stop()
        super().tearDown()

    def test_a_clean_checkout_following_main_can_update(self):
        self.assertIsNone(S._update_checkout())
        (self.clone / "notes.txt").write_text("mine\n")
        self.assertIsNone(S._update_checkout(), "an untracked file stops nothing")

    def test_uncommitted_changes_another_branch_own_commits_and_no_branch_cannot(self):
        (self.clone / "app" / "index.html").write_text("edited\n")
        self.assertEqual(S._update_checkout(), "changed")
        git(self.clone, "checkout", "--", "app/index.html")

        git(self.clone, "checkout", "-b", "premain", "--track", "origin/premain")
        self.assertEqual(S._update_checkout(), "notmain", "a developer's branch")
        git(self.clone, "checkout", "main")

        (self.clone / "local.txt").write_text("local\n")
        git(self.clone, "add", "local.txt")
        git(self.clone, "commit", "-m", "Local work")
        self.assertEqual(S._update_checkout(), "ahead", "a checkout with commits of its own")
        git(self.clone, "reset", "--hard", "origin/main")
        self.assertIsNone(S._update_checkout())

        git(self.clone, "checkout", "--detach")
        self.assertEqual(S._update_checkout(), "nobranch")
        git(self.clone, "checkout", "main")
        git(self.clone, "branch", "--unset-upstream")
        self.assertEqual(S._update_checkout(), "notmain")

    def test_a_folder_inside_another_checkout_is_not_one_of_its_own(self):
        inner = self.clone / "app"
        with mock.patch.object(S, "CLONE", inner):
            self.assertEqual(S._update_checkout(), "notcheckout")
        with mock.patch.object(S, "CLONE", self.dir / "loose"):
            (self.dir / "loose").mkdir()
            self.assertEqual(S._update_checkout(), "notcheckout")


class Offer(Case):
    def seen(self, latest="v0.2.516", **more):
        with S._update_lock:
            S._update_write(checked=time.time(), latest=latest, failures=0, retry=None, **more)

    def test_a_newer_version_is_offered_with_the_boards_own(self):
        S._update_fit = None
        self.seen()
        self.assertEqual(S._update_reading(), {"offer": "v0.2.516", "version": "v0.2.513"})

    def test_nothing_is_offered_before_a_look_while_off_on_a_checkout_that_cannot_update_or_when_current(self):
        self.seen()
        self.assertIsNone(S._update_reading(), "offered before any look read the checkout")
        S._update_fit = None
        self.wanted = False
        self.assertIsNone(S._update_reading(), "offered with the setting off")
        self.wanted = True
        S._update_fit = "notmain"
        self.assertIsNone(S._update_reading(), "offered on a developer's checkout")
        S._update_fit = None
        self.version = "v0.2.516"
        self.assertIsNone(S._update_reading(), "offered the version the board already shows")
        self.version = "v0.2.517"
        self.assertIsNone(S._update_reading(), "offered an older version")

    def test_remind_me_later_keeps_it_down_until_the_next_days_look(self):
        S._update_fit = None
        self.seen()
        now = time.time()
        S._update_due = now + S.UPDATE_DAY - 60   # the next look, as the clock set it
        with S._update_lock:
            until = S._update_put_off()
        self.assertEqual(until, S._update_due)
        self.assertIsNone(S._update_reading())
        with mock.patch.object(S.time, "time", lambda: until + 1):
            self.assertEqual(S._update_reading()["offer"], "v0.2.516", "it did not come back at the next look")
        # put off just before a look, it waits for the look after that one
        S._update_due = now + 600
        with S._update_lock:
            self.assertEqual(S._update_put_off(), S._update_due + S.UPDATE_DAY)

    def test_an_update_running_is_said_instead(self):
        S._update_fit = "changed"
        S._update_proc = mock.Mock(poll=lambda: None)
        self.assertEqual(S._update_reading(), {"running": True})
        S._update_proc = mock.Mock(poll=lambda: 0)
        self.assertIsNone(S._update_reading())


class Progress(Case):
    def ran(self, text, code):
        S.UPDATE_OUTPUT.write_text(text)
        S._update_proc = mock.Mock(poll=lambda: code)
        return S._update_progress()

    def test_the_stage_is_the_last_stage_line_and_the_epoch_this_runs(self):
        self.assertEqual(S._update_progress()["state"], "idle")
        out = self.ran("updater\n@stage downloading\n1. Checkout\n@stage setting-up\n", None)
        self.assertEqual((out["state"], out["stage"], out["epoch"]), ("running", "setting-up", S.PHONE_EPOCH))
        out = self.ran("@stage downloading\n@stage setting-up\n@stage restarting\n", None)
        self.assertEqual(out["stage"], "restarting")
        self.assertEqual(self.ran("@stage downloading\n@stage nonsense\n", None)["stage"], "downloading")

    def test_an_update_that_ended_well_is_done_and_one_that_did_not_says_its_own_line(self):
        self.assertEqual(self.ran("@stage setting-up\nFacilitator updated.\n", 0)["state"], "done")
        out = self.ran("@stage downloading\n1. Checkout\n\n⚠ This checkout has uncommitted changes.\n"
                       "  M app/index.html\n  Nothing was changed.\n", 1)
        self.assertEqual((out["state"], out["message"]), ("failed", "This checkout has uncommitted changes."))
        self.assertEqual(self.ran("@stage downloading\n", 1)["message"], "The update did not finish.")


class Routes(Case):
    def call(self, method, path, port=None, origin=True):
        head = {"host": f"127.0.0.1:{S.PORT}"}
        if origin:
            head["origin"] = f"http://127.0.0.1:{S.PORT}"
        scope = {"type": "http", "method": method, "path": path, "query_string": b"",
                 "http_version": "1.1", "scheme": "http", "client": ("127.0.0.1", 50000),
                 "server": ("127.0.0.1", port or S.PORT),
                 "headers": [(k.encode(), v.encode()) for k, v in head.items()]}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        [route] = [r for r in S.ROUTES if r.path == path and method in r.methods]
        response = asyncio.run(route.endpoint(S.Request(scope, receive)))
        return response.status_code, json.loads(response.body)

    def test_only_a_page_on_this_mac_is_answered(self):
        import bridge_gate
        self.assertTrue({"/update", "/update/later"} <= bridge_gate.LOCAL_ONLY)
        self.assertEqual(self.call("GET", "/update", port=S.BRIDGE_PORT)[0], 404)
        self.assertEqual(self.call("POST", "/update", port=S.BRIDGE_PORT)[0], 404)
        self.assertEqual(self.call("POST", "/update", origin=False)[0], 403)
        self.assertEqual(self.call("POST", "/update/later", origin=False)[0], 403)
        status, answer = self.call("GET", "/update")
        self.assertEqual((status, answer["state"], answer["epoch"]), (200, "idle", S.PHONE_EPOCH))

    def test_remind_me_later_is_kept(self):
        status, answer = self.call("POST", "/update/later")
        self.assertEqual(status, 200)
        self.assertEqual(self.kept()["later"], answer["until"])
        self.assertIn(("update", {"outcome": "later"}), self.lines)

    def test_yes_starts_the_command_on_its_own_and_a_second_yes_is_refused_while_it_runs(self):
        started = []

        class Child:
            def __init__(self, argv, **kw):
                started.append((argv, kw))

            def poll(self):
                return None

            def wait(self):
                return 0

        with mock.patch.object(S.subprocess, "Popen", Child), mock.patch.object(S, "_update_ended", lambda proc: None):
            status, answer = self.call("POST", "/update")
            self.assertEqual((status, answer["epoch"]), (200, S.PHONE_EPOCH))
            self.assertEqual(self.call("POST", "/update")[0], 409)
        [(argv, kw)] = started
        self.assertEqual(argv[1:], [str(S.CLONE / "facilitator"), "update"])
        self.assertNotIn(".venv", argv[0], "the update ran on the .venv it may rebuild")
        self.assertTrue(kw["start_new_session"], "a restart would take the update down with the board")
        self.assertEqual(kw["env"]["FACILITATOR_UPDATE_FROM_BOARD"], "1")
        self.assertEqual(kw["stderr"], subprocess.STDOUT)
        self.assertNotEqual(kw["stdout"], subprocess.PIPE, "its output goes to a file, never a pipe back")
        self.assertEqual(self.call("GET", "/update")[1]["state"], "running")


if __name__ == "__main__":
    unittest.main()
