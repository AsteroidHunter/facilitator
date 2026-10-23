"""A new project's Omni Ticket #1 starts with the steps to connect an agent as
its reply (server.py: FIRST_OMNI_REPLY, _post_project, _create_box_record),
driven through the board's own application.

  first     the card added with a project holds the steps as its reply, full
            and small, on the board's reading and the phone's, and nothing
            else in the lane holds them
  starting  the reply is a starting one, as a seeded card's context is: no
            reply counted, no agent stamp or name, the card still new, nothing
            queued, and the lane's listener is handed nothing
  later     an Omni card made later in the project starts empty
  old       a project added before the steps existed gains nothing, across a
            restart and another project being added

The server is loaded as a module, every file it writes moved into a temporary
folder, and its home is a temporary folder too.

    python3 -m unittest tests/test_new_project_reply.py
"""

import asyncio
import copy
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
LOGS = Path(tempfile.mkdtemp(prefix="new-project-reply-logs-"))

STEPS = (
    "To start working on this project, connect an agent to it. The agent runs in your "
    "terminal and answers every card in this project.\n\n"
    "1. Open the project's folder in the terminal\n"
    "2. Start Claude Code or Codex\n"
    "3. Type `/facilitator onboard` in Claude Code, or `$facilitator onboard` in Codex\n\n"
    "Once done, start interacting with the agent via the Facilitator!")


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = str(LOGS)
    spec = importlib.util.spec_from_file_location("facilitator_server_new_project_reply", ROOT / "server.py")
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


class NewProjectReply(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="new-project-reply-run-")).resolve()
        self.home = self.dir / "home"
        for name in ("older", "newer", "newer-still"):
            (self.home / name).mkdir(parents=True)
        self.paths = mock.patch.multiple(
            S, STATE_PATH=self.dir / "state.json", TRANSCRIPT_PATH=self.dir / "transcript.jsonl",
            SEED_PATH=self.dir / "seed.json", MAGIC_DIR=self.dir / "magic-boxes",
            UPLOADS=self.dir / "uploads", OLD_UPLOADS=self.dir / "uploads-old",
            SETTINGS_PATH=self.dir / "settings.json", PROFILE_PATH=self.dir / "profile.json")
        self.paths.start()
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        self.env.start()
        S._load()
        S._save()
        self.app = S.build_app()

    def tearDown(self):
        self.env.stop()
        self.paths.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    # -- helpers
    def page(self, method, path, query="", body=b""):
        return asyncio.run(ask(self.app, method, path, query, body,
                               PAGE_READ if method == "GET" else PAGE_WRITE))

    def add_project(self, name):
        status, answer = self.page("POST", "/project", f"name={name}", str(self.home / name).encode())
        self.assertEqual(status, 200, answer)
        return answer["id"]

    def board_lane(self, owner):
        status, board = self.page("GET", "/state")
        self.assertEqual(status, 200)
        return [b for b in board["boxes"] if b["owner"] == owner]

    def saved_lane(self, owner):
        return [b for b in json.loads(S.STATE_PATH.read_text())["boxes"] if b.get("owner") == owner]

    def restart(self):
        S._load()
        self.app = S.build_app()

    # -- cases
    def test_the_first_card_holds_the_steps_as_a_starting_reply(self):
        lane = self.add_project("newer")
        cards = self.board_lane(lane)
        self.assertEqual([b["title"] for b in cards], ["Omni Ticket #1"])
        card = cards[0]
        self.assertEqual(S.FIRST_OMNI_REPLY, STEPS)
        self.assertEqual((card["reply"], card["replyFull"], card["replyShort"]), (STEPS, STEPS, STEPS))
        # a starting reply, which no agent wrote
        self.assertEqual((card["replies"], card["olderReplies"], card["agentTs"], card["agent"]), (0, 0, 0, ""))
        self.assertEqual((card["replyKind"], card["state"], card["pending"]), ("", "new", 0))
        saved = self.saved_lane(lane)[0]
        self.assertEqual((saved["reply"], saved["reply_full"], saved["reply_short"]), (STEPS, STEPS, STEPS))
        self.assertEqual((saved["full_replies"], saved["seen"], saved["ball"]), (0, 0, "me"))
        # the phone reads the same reply
        with S._lock:
            self.assertEqual(S._phone_box(S._box(card["id"]))["replyFull"], STEPS)
        # the lane's listener has nothing to take and nothing unread
        self.assertNotIn(card["id"], S._state["inbox"])
        self.assertEqual(S._wait_poll(lane), (None, None))
        self.assertEqual(self.page("GET", "/unread", f"owner={lane}"), (200, {"queued": 0, "claimed": 0}))
        # and a restart keeps it as it is
        self.restart()
        self.assertEqual(self.board_lane(lane)[0]["replyFull"], STEPS)

    def test_a_later_omni_card_starts_empty(self):
        lane = self.add_project("newer")
        status, made = self.page("POST", "/create", f"owner={lane}", b"omni")
        self.assertEqual(status, 200, made)
        cards = {b["id"]: b for b in self.board_lane(lane)}
        self.assertEqual(len(cards), 2)
        later = cards[made["id"]]
        self.assertIsNotNone(S._omni_number(later["title"]), "the later card is not an Omni card")
        self.assertEqual(later["replyFull"], "")
        self.assertEqual([b["replyFull"] for b in cards.values() if b["id"] != made["id"]], [STEPS])
        status, made = self.page("POST", "/create", "owner=facilitator", b"omni")
        self.assertEqual(status, 200, made)
        self.assertEqual([b["replyFull"] for b in self.board_lane("facilitator")], [""])

    def test_a_project_added_before_gains_nothing(self):
        # the project as it was added before the steps existed: the same route
        # with an empty starting reply, and a card of its own made later
        with mock.patch.object(S, "FIRST_OMNI_REPLY", ""):
            older = self.add_project("older")
        status, made = self.page("POST", "/create", f"owner={older}", b"omni")
        self.assertEqual(status, 200, made)
        # taken after a restart, once the board's own migrations have run on it
        self.restart()
        before = copy.deepcopy([b for b in S._state["boxes"] if b.get("owner") == older])
        self.assertEqual([b["reply_full"] for b in before], ["", ""])
        newer = self.add_project("newer")
        self.restart()
        self.add_project("newer-still")
        self.assertEqual(self.saved_lane(older), before)
        self.assertEqual([b["replyFull"] for b in self.board_lane(older)], ["", ""])
        self.assertEqual(self.board_lane(newer)[0]["replyFull"], STEPS)


def tearDownModule():
    shutil.rmtree(LOGS, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
