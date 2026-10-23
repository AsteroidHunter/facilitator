"""The onboarding's sample project is kept on the board and marked sample, so
no list of projects shows it (server.py: _sample_lane, _post_onboarding_sample,
_migrate; card-logic.js: sampleLane), driven through the board's own
application.

  route     POST /onboarding/sample makes the sample's lane with its folder,
            once, marked sample on its record, with its Omni Ticket #1 and
            the steps to connect an agent, and a second run answers the same
            lane; the board's reading and the phone's carry the mark
  ordinary  POST /project never marks a project, a folder opened by hand on
            the sample's folder included
  older     a lane an older board made on the sample's folder is marked on
            the first load after the mark, once: a lane opened on that folder
            by hand afterwards, an ordinary project and a server's lane on the
            same path stay unmarked

The server is loaded as a module, every file it writes moved into a temporary
folder, and its home is a temporary folder too.

    python3 -m unittest tests/test_sample_project.py
"""

import asyncio
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
LOGS = Path(tempfile.mkdtemp(prefix="sample-project-logs-"))


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = str(LOGS)
    spec = importlib.util.spec_from_file_location("facilitator_server_sample_project", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = _load_server()

PAGE_READ = {"sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
             "user-agent": "Mozilla/5.0 (Macintosh) Chrome/141"}
PAGE_WRITE = {**PAGE_READ, "origin": f"http://127.0.0.1:{S.PORT}"}


def scope_of(method, path, query="", headers=None):
    head = {"host": f"127.0.0.1:{S.PORT}", **(headers or {})}
    return {"type": "http", "method": method, "path": path, "query_string": query.encode(),
            "http_version": "1.1", "scheme": "http", "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", S.PORT), "root_path": "",
            "headers": [(k.encode(), v.encode()) for k, v in head.items()]}


async def ask(app, method, path, query="", body=b"", headers=None):
    sent = []
    given = [False]

    async def receive():
        if not given[0]:
            given[0] = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    await app(scope_of(method, path, query, headers), receive, send)
    status = next((m["status"] for m in sent if m["type"] == "http.response.start"), None)
    data = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, json.loads(data) if data else None


class SampleProject(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="sample-project-run-")).resolve()
        self.home = self.dir / "home"
        (self.home / "orchard").mkdir(parents=True)
        self.folder = self.home / "facilitator-sample"
        self.paths = mock.patch.multiple(
            S, STATE_PATH=self.dir / "state.json", TRANSCRIPT_PATH=self.dir / "transcript.jsonl",
            SEED_PATH=self.dir / "seed.json", MAGIC_DIR=self.dir / "magic-boxes",
            UPLOADS=self.dir / "uploads", OLD_UPLOADS=self.dir / "uploads-old",
            SETTINGS_PATH=self.dir / "settings.json", PROFILE_PATH=self.dir / "profile.json")
        self.paths.start()
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        self.env.start()
        self.restart()
        S._save()

    def tearDown(self):
        self.env.stop()
        self.paths.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    # -- helpers
    def page(self, method, path, query="", body=b""):
        return asyncio.run(ask(self.app, method, path, query, body,
                               PAGE_READ if method == "GET" else PAGE_WRITE))

    def sample(self):
        status, answer = self.page("POST", "/onboarding/sample")
        self.assertEqual(status, 200, answer)
        return answer

    def add_project(self, name, folder):
        status, answer = self.page("POST", "/project", f"name={name}", str(folder).encode())
        self.assertEqual(status, 200, answer)
        return answer["id"]

    def projects(self):
        status, board = self.page("GET", "/state")
        self.assertEqual(status, 200)
        return {p["id"]: p for p in board["projects"]}, board

    def saved(self):
        return json.loads(S.STATE_PATH.read_text())

    def restart(self):
        """The board loaded as a new run would load it: the lanes an earlier
        test registered in this process are forgotten, so ids are a new
        board's."""
        S._load()
        with S._lock:
            S._sync_owner_registries()
        self.app = S.build_app()

    # -- cases
    def test_the_route_makes_one_lane_marked_sample_with_its_first_ticket(self):
        made = self.sample()
        self.assertEqual(made, {"ok": True, "path": str(self.folder), "made": True, "id": "facilitator-sample"})
        projects, board = self.projects()
        self.assertEqual(projects, {"facilitator-sample": {"id": "facilitator-sample", "name": "facilitator-sample",
                                                           "dir": str(self.folder), "sample": True}})
        self.assertEqual(board["pwds"]["facilitator-sample"], str(self.folder))
        cards = [b for b in board["boxes"] if b["owner"] == "facilitator-sample"]
        self.assertEqual([(b["title"], b["replyFull"]) for b in cards], [("Omni Ticket #1", S.FIRST_OMNI_REPLY)])
        self.assertEqual([p.get("sample") for p in self.saved()["projects"]], [True])
        # a second run, and one after a restart, answer the same lane and make none
        self.assertEqual(self.sample(), {**made, "made": False})
        self.restart()
        self.assertEqual(self.sample(), {**made, "made": False})
        self.assertEqual(list(self.projects()[0]), ["facilitator-sample"])
        self.assertEqual(len([b for b in self.saved()["boxes"] if b["owner"] == "facilitator-sample"]), 1)
        # the phone reads the mark the same way
        with S._lock:
            phone = json.loads(S._phone_state(None, []))
        self.assertEqual([p.get("sample") for p in phone["projects"]], [True])

    def test_an_ordinary_project_is_never_marked(self):
        orchard = self.add_project("orchard", self.home / "orchard")
        self.sample()
        # the sample's folder opened by hand after the run is a project of its own
        by_hand = self.add_project("facilitator-sample", self.folder)
        self.assertEqual(by_hand, "facilitator-sample-2")
        for _ in range(2):
            projects, _board = self.projects()
            self.assertEqual({ow: p.get("sample", False) for ow, p in projects.items()},
                             {orchard: False, "facilitator-sample": True, by_hand: False})
            self.assertNotIn("sample", self.saved()["projects"][0])
            self.restart()
        self.assertEqual(self.sample()["id"], "facilitator-sample")

    def test_a_lane_an_older_board_made_on_the_sample_folder_is_marked_once(self):
        # the board as an older onboarding left it: the sample's folder, its
        # lane made as POST /project makes any, an ordinary project beside it,
        # and a server's lane on the same path, with no mark on any of them
        self.folder.mkdir()
        lane = self.add_project("facilitator-sample", self.folder)
        orchard = self.add_project("orchard", self.home / "orchard")
        older = self.saved()
        older.pop("sample_flag_version")
        older["projects"].append({"id": "uplands", "name": "facilitator-sample", "dir": str(self.folder),
                                  "server": "s1"})
        self.assertFalse(any("sample" in p for p in older["projects"]))
        S.STATE_PATH.write_text(json.dumps(older))
        self.restart()
        projects, _board = self.projects()
        self.assertEqual({ow: p.get("sample", False) for ow, p in projects.items()},
                         {lane: True, orchard: False, "uplands": False})
        self.assertEqual(self.saved()["sample_flag_version"], S.SAMPLE_FLAG_VERSION)
        # the onboarding run again finds that lane rather than making another
        self.assertEqual(self.sample(), {"ok": True, "path": str(self.folder), "made": False, "id": lane})
        # and the mark is found once: the same folder opened by hand since stays a project
        by_hand = self.add_project("facilitator-sample", self.folder)
        self.restart()
        projects, _board = self.projects()
        self.assertEqual(projects[by_hand].get("sample", False), False)
        self.assertEqual(projects[lane]["sample"], True)


def tearDownModule():
    shutil.rmtree(LOGS, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
