"""No user data in the board's log files, at debug, in any kind of line that
could once carry some.

  client    a page's error message keeps its plain words and loses anything
            quoted, any web address and any path but a route's, and the whole
            of a message holding an email; file and route are route names
  refusal   the sentence keeps its plain words, its path is a route name
  routes    request, refusal and crash lines name a file route by its prefix
            and a path nobody serves as "other"
  push      a signing failure is written as its exception's type
  lanes     a project's line holds neither its name nor its folder, and a
            project lane is "project" wherever an owner is written
  magic     a website box's line has no host

Each case plants an email, a path under /Users/, a message and a title, has the
code that writes the line write it at debug, and reads every file in the log
folder back for any of them. The server is loaded as a module, its log folder
and every file it writes moved into a temporary directory.

    python3 -m unittest tests/test_logs_no_user_data.py
"""

import asyncio
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent

EMAIL = "planted.person@example.org"
HOME_PATH = "/Users/plantedperson/Documents/thesis-draft.md"
MESSAGE = "meet me at the clinic on tuesday"
TITLE = "Planted card title"
PROJECT = "Plantedproject Lane"
ATTACHMENT = "20261017-plantedscan.pdf"
SITE = "plantedclinic.example"
ENDPOINT = "https://web.push.apple.com/plantedtoken0123456789"
PLANTED = (EMAIL, "@example", "/Users/", "plantedperson", MESSAGE, "clinic", "tuesday", TITLE,
           "Planted card", "plantedproject", "plantedscan", SITE, "plantedtoken")

LOGS = Path(tempfile.mkdtemp(prefix="logs-no-user-data-"))


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = str(LOGS)
    os.environ["FACILITATOR_LOG_LEVEL"] = "debug"
    try:
        spec = importlib.util.spec_from_file_location("facilitator_server_logs_test", ROOT / "server.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        os.environ.pop("FACILITATOR_LOG_LEVEL", None)
    module._notify = lambda *a, **k: None
    return module


S = _load_server()


def written() -> list:
    """Every line of every file in the log folder, as parsed JSON."""
    for handler in S.LOGGER.handlers + S.CLIENT_LOGGER.handlers:
        handler.flush()
    lines = []
    for name in sorted(os.listdir(LOGS)):
        for line in (LOGS / name).read_text().splitlines():
            if line:
                lines.append(line)
    return lines


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="logs-no-user-data-run-")).resolve()
        self.home = self.dir / "plantedperson"
        self.home.mkdir()
        self.paths = mock.patch.multiple(S, STATE_PATH=self.dir / "state.json",
                                         TRANSCRIPT_PATH=self.dir / "transcript.jsonl",
                                         MAGIC_DIR=self.dir / "magic-boxes", UPLOADS=self.dir / "uploads",
                                         OLD_UPLOADS=self.dir / "uploads-old")
        self.paths.start()
        S._state.clear()
        S._state.update({
            "rev": 1, "next_bid": 2, "next_pgid": 2, "inbox": [], "projects": [], "push_subs": [],
            "boxes": [{"id": "m1", "bucket": "meta", "title": TITLE, "owner": "facilitator", "done": False,
                       "docked": False, "parked": False, "replies": 0, "seen": 0, "pending": [],
                       "ball": "me", "ts": 1.0, "state": "new", "reply": "", "hb": 0}],
            "busy": {"facilitator": None}, "claimed": {"facilitator": []},
            "busy_ts": {"facilitator": 0.0}, "ack": {"facilitator": None},
            "workspaces": {"facilitator": [{"id": "w1", "name": "main", "goal": "", "tasks": [], "current": None}]},
            "pages": {"facilitator": []}})
        self.before = len(written())

    def tearDown(self):
        self.paths.stop()

    def fresh(self) -> list:
        """The lines this test wrote, after checking that none of them holds a
        planted word."""
        lines = written()[self.before:]
        self.assertTrue(lines, "nothing was written, so this proves nothing")
        for line in lines:
            for secret in PLANTED:
                self.assertNotIn(secret.lower(), line.lower(), f"planted data reached the log: {line}")
        return [json.loads(line) for line in lines]

    def call(self, method, path, query="", body=b"", headers=None):
        """One request through the board's own application, as the board's
        page on this Mac makes it."""
        head = {"host": f"127.0.0.1:{S.PORT}", "origin": f"http://127.0.0.1:{S.PORT}", **(headers or {})}
        scope = {"type": "http", "method": method, "path": path, "query_string": query.encode(),
                 "http_version": "1.1", "scheme": "http", "client": ("127.0.0.1", 50000),
                 "server": ("127.0.0.1", S.PORT), "root_path": "",
                 "headers": [(k.encode(), v.encode()) for k, v in head.items()]}
        sent, answer = [], {}

        async def receive():
            if sent:
                return {"type": "http.disconnect"}
            sent.append(1)
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message):
            if message["type"] == "http.response.start":
                answer["status"] = message["status"]

        asyncio.run(S.build_app()(scope, receive, send))
        return answer.get("status")


class Client(Case):
    def test_page_reports_keep_their_plain_words_and_route_names_and_nothing_else(self):
        looping = {"kind": "error", "message": f'Unexpected token "{MESSAGE}"', "file": "", "line": 5, "count": 1}
        reports = [
            {"kind": "error", "message": f"Unexpected token 'm', \"{MESSAGE}\" is not valid JSON",
             "file": f"https://plantedperson-mac.tail0.ts.net/m?draft={TITLE}", "line": 10, "col": 2,
             "count": 1, "box": "m1"},
            {"kind": "rejection", "message": f"Cannot read properties of null (reading '{TITLE}')",
             "file": "http://127.0.0.1:8877/card-logic.js?v=1", "line": 20, "col": 4, "count": 1},
            {"kind": "fetch", "message": "Load failed", "route": f"/uploads/{ATTACHMENT}", "file": "", "line": 0},
            {"kind": "error", "message": f"could not save the profile for {EMAIL}", "file": "", "line": 30},
            {"kind": "error", "message": f"Invalid regular expression: {HOME_PATH} at https://{SITE}/x?who=me",
             "file": "", "line": 40},
            {"kind": "slow", "message": f'the page stopped while on screen: window abc, card m1; last error '
                                        f'"{MESSAGE}" at /card-logic.js:12, 3 s before',
             "file": "", "line": 0, "late": 3000, "doing": "render"},
            *[looping] * (S.CLIENT_PER_MINUTE + 1),
        ]
        batch = json.dumps({"page": "phone", "client": "phone", "window": "0123456789abcdef", "reports": reports})
        self.assertEqual(self.call("POST", "/clientlog", body=batch.encode()), 200)
        lines = self.fresh()
        kinds = [line["kind"] for line in lines if line.get("page") == "phone"]
        self.assertEqual(kinds.count("error"), 3 + S.CLIENT_PER_MINUTE, lines)
        self.assertIn("dropped", kinds)
        by_line = {line.get("line"): line for line in lines if line["kind"] != "dropped"}
        self.assertEqual(by_line[10]["file"], "/m")
        self.assertEqual(by_line[10]["message"], "Unexpected token (quoted), (quoted) is not valid JSON")
        self.assertEqual(by_line[20]["file"], "/card-logic.js")
        self.assertEqual(by_line[20]["message"], "Cannot read properties of null (reading (quoted))")
        fetched = next(line for line in lines if line["kind"] == "fetch")
        self.assertEqual(fetched["route"], "/uploads/*")
        self.assertEqual(fetched["message"], "Load failed")
        self.assertNotIn("message", by_line[30], "an unquoted email was kept in part")
        self.assertEqual(by_line[40]["message"], "Invalid regular expression: (path) at (address)")
        slow = next(line for line in lines if line["kind"] == "slow")
        self.assertIn("last error (quoted) at /card-logic.js:12", slow["message"])
        self.assertEqual(slow["late"], 3000)
        dropped = next(line for line in lines if line["kind"] == "dropped")
        self.assertEqual(dropped["message"], "Unexpected token (quoted)")


class Routes(Case):
    def test_a_file_route_is_named_by_its_prefix_and_an_unserved_path_by_one_word(self):
        self.assertEqual(self.call("GET", f"/uploads/{ATTACHMENT}", "box=m1"), 404)
        self.assertEqual(self.call("GET", HOME_PATH), 404)
        S.SiteGuard(None)._note({"path": f"/laneimg/{ATTACHMENT}"}, "cross-site")
        lines = self.fresh()
        refused = [line for line in lines if line["kind"] == "refusal"]
        self.assertEqual([line["route"] for line in refused], ["/uploads/*", "other", "/laneimg/*"])
        self.assertEqual(refused[0]["reason"], "not found")
        requests = [line for line in lines if line["kind"] == "request"]
        self.assertEqual([line["route"] for line in requests], ["/uploads/*", "other"])
        self.assertEqual(requests[0]["box"], "m1")

    def test_a_crash_names_its_route_and_the_type_of_what_it_hit(self):
        scope = {"type": "http", "method": "GET", "path": f"/uploads/{ATTACHMENT}", "query_string": b"box=m1",
                 "headers": [], "server": ("127.0.0.1", S.PORT)}
        for error in (OSError(13, "Permission denied", HOME_PATH), KeyError(TITLE), ValueError(EMAIL)):
            asyncio.run(S._crashed(S.Request(scope), error))
        crashes = [line for line in self.fresh() if line["kind"] == "crash"]
        self.assertEqual([line["error"] for line in crashes], ["PermissionError", "KeyError", "ValueError"])
        self.assertEqual({line["route"] for line in crashes}, {"/uploads/*"})

    def test_a_refusal_keeps_its_sentence_without_the_path_an_exception_put_in_it(self):
        failing = mock.patch.object(S, "_push_public_key", side_effect=RuntimeError(
            f"Could not open file or uri for loading private key from {HOME_PATH}"))
        with failing:
            self.assertEqual(self.call("GET", "/push/key"), 500)
        S._answer(400, {"error": str(OSError(13, "Permission denied", HOME_PATH))}, route="/navsave")
        refused = [line for line in self.fresh() if line["kind"] == "refusal"]
        self.assertEqual(refused[0]["route"], "/push/key")
        self.assertEqual(refused[0]["reason"],
                         "push key unavailable: Could not open file or uri for loading private key from (path)")
        self.assertEqual(refused[1]["route"], "/navsave")
        self.assertEqual(refused[1]["code"], 400)
        self.assertNotIn("reason", refused[1])


class Push(Case):
    def test_a_signing_failure_is_written_as_its_type(self):
        S._state["push_subs"] = [{"endpoint": ENDPOINT, "keys": {}, "session": "s"}]
        auth = mock.Mock(has_session_digest=lambda digest: True)
        with mock.patch.object(S, "_BRIDGE_AUTH", auth), \
             mock.patch.object(S, "_push_bridge_available", return_value=(True, "")), \
             mock.patch.object(S, "_push_one", side_effect=RuntimeError(
                 f"Could not open file or uri for loading private key from {HOME_PATH}")):
            S._push_turn("m1")
        [failed] = [line for line in self.fresh() if line["kind"] == "pushfail"]
        self.assertEqual(failed["reason"], "RuntimeError")
        self.assertEqual(failed["host"], "web.push.apple.com")
        self.assertEqual(failed["box"], "m1")


class Lanes(Case):
    def test_a_project_and_its_pages_are_written_without_its_name_or_folder(self):
        with mock.patch.object(S.Path, "home", return_value=self.home):
            self.assertEqual(self.call("POST", "/project", "name=" + PROJECT.replace(" ", "+"),
                                       body=str(self.home).encode()), 200)
        slug = S._state["projects"][0]["id"]
        self.assertEqual(self.call("POST", "/pages/new", "owner=" + slug), 200)
        lines = self.fresh()
        [made] = [line for line in lines if line["kind"] == "project"]
        self.assertEqual(made["projects"], 1)
        self.assertNotIn("box", made)
        self.assertNotIn("folder", made)
        [page] = [line for line in lines if line["kind"] == "page+"]
        self.assertEqual(page["owner"], "project")
        rows = [json.loads(row) for row in S.TRANSCRIPT_PATH.read_text().splitlines()]
        self.assertEqual(rows[0]["box"], slug, "the transcript row lost the lane it belongs to")
        self.assertEqual(rows[1]["owner"], slug)
        self.assertEqual(S._owner_word("facilitator"), "facilitator")


class Magic(Case):
    def test_a_website_box_is_written_without_its_host(self):
        address = f"https://{SITE}/visit?who={EMAIL}"
        with mock.patch.object(S, "_magic_website", return_value=({"url": address, "shown": "inline"}, SITE)):
            status = self.call("POST", "/magic", "box=m1&kind=url&title=" + TITLE.replace(" ", "+"),
                               body=address.encode())
        self.assertEqual(status, 200)
        [opened] = [line for line in self.fresh() if line["kind"] == "magic"]
        self.assertEqual((opened["box"], opened["magic"], opened["action"]), ("m1", "url", "open"))
        self.assertEqual(opened["title_chars"], len(TITLE))
        self.assertNotIn("host", opened)
        row = json.loads(S.TRANSCRIPT_PATH.read_text().splitlines()[-1])
        self.assertEqual(row["host"], SITE, "the transcript row lost the site")


if __name__ == "__main__":
    unittest.main()
