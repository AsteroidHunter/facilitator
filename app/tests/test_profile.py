"""The profile, the onboarding's gate and its sample project, on the server.

  file      profile.json is read field by field, and one that is missing,
            broken or without a name is a board the onboarding has not been
            through; it is written whole, owner-only, beside state.json
  routes    GET /profile answers every field; POST /profile sets the fields it
            names and keeps the rest, checks every field before keeping any,
            needs a name, refuses a yes with no email and lets a cleared email
            take the yes with it, and answers only a page on this Mac
  gate      /board-settings.js ends with BOARD_ONBOARDING=true while the
            profile is not complete, and says nothing of the profile itself
  posthog   with the yes the email and the answers go to the usage sender's
            link_person, once, then only a change; without it nothing is sent,
            and taking it back sends nothing and forgets them there. The save
            answers before PostHog does, slow or refusing, and the identify
            goes afterwards on a thread of its own
  sample    POST /onboarding/sample makes ~/facilitator-sample with its
            internal folder and its wiki the first time, and never touches a
            folder, a file or a link already holding the name
  page      GET /onboarding serves onboarding.html with the board's version
            written in, to this Mac only, and it is the one page besides /m
            the board's origin may frame

Nothing reaches PostHog or any other machine: the sender gets a fake opener and
every real connection fails the test. The server is loaded as a module, its log
folder and every file it writes moved into a temporary directory.

    python3 -m unittest tests/test_profile.py
"""

import asyncio
import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import usage_counts as uc  # noqa: E402

EMAIL = "ada.lovelace@example.org"
ANSWERS = {"name": "Ada Lovelace", "email": EMAIL, "emailYes": True,
           "work": "Notes on the analytical engine, in my words", "timeZone": "Europe/London"}


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = tempfile.mkdtemp(prefix="profile-test-logs-")
    spec = importlib.util.spec_from_file_location("facilitator_server_profile_test", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._save = lambda: None
    module._notify = lambda *a, **k: None
    return module


S = _load_server()


def no_network(*args, **kwargs):
    raise AssertionError("the test tried to reach the network")


class Answer:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeNet:
    def __init__(self):
        self.bodies = []

    def __call__(self, req, timeout=None):
        assert req.full_url == uc.ENDPOINT
        self.bodies.append(json.loads(req.data))
        return Answer()


class Case(unittest.TestCase):
    def setUp(self):
        self.guards = [mock.patch("urllib.request.urlopen", no_network),
                       mock.patch.object(http.client.HTTPSConnection, "connect", no_network),
                       mock.patch.object(http.client.HTTPConnection, "connect", no_network)]
        for guard in self.guards:
            guard.start()
        self.dir = Path(tempfile.mkdtemp(prefix="profile-test-"))
        self.home = self.dir / "home"
        self.home.mkdir()
        self.app = self.dir / "app"
        self.app.mkdir()
        self.paths = mock.patch.multiple(S, PROFILE_PATH=self.app / "profile.json",
                                         ONBOARDING_PAGE=ROOT / "onboarding.html", HERE=ROOT)
        self.paths.start()
        self.lines = []
        self.info = mock.patch.object(S, "_info", lambda kind, box="", **f: self.lines.append((kind, f)))
        self.info.start()
        self.net = FakeNet()
        S._usage_sender = None
        S._settings = {"rev": 0, "values": {}, "spotify": {}}

    def tearDown(self):
        self.settle()
        S._usage_sender = None
        self.info.stop()
        self.paths.stop()
        for guard in self.guards:
            guard.stop()

    def sender(self, sharing=lambda: True):
        S._usage_sender = uc.Sender(transcript=self.dir / "transcript.jsonl",
                                    marker=self.dir / "usage-counts.json", index_html=ROOT / "index.html",
                                    sharing=sharing, opener=self.net, install_file=self.dir / "usage-install.json")
        return S._usage_sender

    @staticmethod
    def settle():
        """Waits for the identifies the saves handed to threads of their own."""
        for thread in threading.enumerate():
            if thread.name == "usage-identify":
                thread.join(5)

    def call(self, method, path, body=None, headers=None, port=None):
        """One request through the route's own wrapper, as the board's page
        on this Mac makes it unless the headers say otherwise."""
        raw = b"" if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        head = {"host": f"127.0.0.1:{S.PORT}", "origin": f"http://127.0.0.1:{S.PORT}"}
        if method == "GET":
            del head["origin"]
        head.update(headers or {})
        scope = {"type": "http", "method": method, "path": path, "query_string": b"",
                 "http_version": "1.1", "scheme": "http", "client": ("127.0.0.1", 50000),
                 "server": ("127.0.0.1", port or S.PORT),
                 "headers": [(k.encode(), v.encode()) for k, v in head.items() if v is not None]}
        sent = []

        async def receive():
            if sent:
                return {"type": "http.disconnect"}
            sent.append(1)
            return {"type": "http.request", "body": raw, "more_body": False}

        [route] = [r for r in S.ROUTES if r.path == path and method in r.methods]
        response = asyncio.run(route.endpoint(S.Request(scope, receive)))
        try:
            answer = json.loads(response.body)
        except ValueError:
            answer = response.body
        return response.status_code, answer

    def kept(self):
        return json.loads((self.app / "profile.json").read_text())

    def lead(self):
        """What the server writes in front of board-settings.js."""
        status, body, _ = S._get_board_settings_js(S.Query({}), None)
        self.assertEqual(status, 200)
        own = (ROOT / "board-settings.js").read_bytes()
        self.assertTrue(body.endswith(own))
        return body[:-len(own)].decode()


class File(Case):
    def test_a_missing_or_broken_file_is_a_board_the_onboarding_has_not_been_through(self):
        empty = {"name": None, "email": None, "emailYes": False, "work": None,
                 "timeZone": None, "picture": None, "complete": False}
        self.assertEqual(self.call("GET", "/profile"), (200, empty))
        for content in ("", "not json", "[]", '"x"', "{}", '{"name": ""}', '{"name": "   "}', '{"name": 5}',
                        json.dumps({"name": "x" * 201}), json.dumps({"name": "a\x00b"})):
            with self.subTest(content=content):
                (self.app / "profile.json").write_text(content)
                self.assertEqual(self.call("GET", "/profile"), (200, empty))
                self.assertIn("BOARD_ONBOARDING=true", self.lead())

    def test_a_field_that_does_not_pass_its_rule_reads_as_not_given(self):
        (self.app / "profile.json").write_text(json.dumps({
            "name": "Ada", "email": "not an address", "email_yes": True, "work": 5, "time_zone": "Mars Base"}))
        answer = self.call("GET", "/profile")[1]
        self.assertIn(answer.pop("picture"), S.PROFILE_PICTURES)
        self.assertEqual(answer, {
            "name": "Ada", "email": None, "emailYes": False, "work": None,
            "timeZone": None, "complete": True})

    def test_an_agent_kept_from_before_is_never_read_or_shown(self):
        (self.app / "profile.json").write_text(json.dumps({
            "name": "Ada", "work": "Notes", "agent": "Claude Code", "picture": 19}))
        status, answer = self.call("GET", "/profile")
        self.assertEqual(status, 200)
        self.assertNotIn("agent", answer)
        self.assertNotIn("Claude Code", json.dumps(answer))
        self.assertNotIn("agent", S._profile_read())
        self.assertNotIn("agent", S._profile_person(S._profile_read()))
        self.assertEqual(self.kept()["agent"], "Claude Code", "a read changed the file")

    def test_it_is_written_whole_owner_only_beside_the_state_and_kept_from_git(self):
        self.assertEqual(self.call("POST", "/profile", ANSWERS)[0], 200)
        self.assertEqual(self.kept(), {"name": "Ada Lovelace", "email": EMAIL, "email_yes": True,
                                       "work": ANSWERS["work"], "time_zone": "Europe/London", "picture": None})
        self.assertEqual((self.app / "profile.json").stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.app / "profile.json.tmp").exists())
        # beside state.json, in data/ at the top of the checkout, which git ignores
        self.assertEqual(S.DATA, ROOT.parent / "data")
        self.assertEqual(S.STATE_PATH.parent, S.DATA)
        self.assertIn("/data/", (ROOT.parent / ".gitignore").read_text().split("\n"))
        for name in ("profile.json", "profile.json.tmp"):
            self.assertIn(name, S.PRIVATE_FILES)
            self.assertIn("/" + name, (ROOT.parent / ".gitignore").read_text().split("\n"))


class Routes(Case):
    def test_a_post_sets_what_it_names_and_keeps_the_rest(self):
        self.call("POST", "/profile", {"name": "Ada", "work": "Notes", "timeZone": "America/Phoenix"})
        status, answer = self.call("POST", "/profile", {"name": "  Ada Lovelace  "})
        self.assertEqual(status, 200)
        self.assertEqual({k: answer[k] for k in ("name", "work", "timeZone", "complete", "ok")},
                         {"name": "Ada Lovelace", "work": "Notes",
                          "timeZone": "America/Phoenix", "complete": True, "ok": True})
        self.call("POST", "/profile", {"work": ""})
        self.assertEqual(self.kept()["work"], None)

    def test_a_write_that_still_carries_an_agent_is_taken_and_the_agent_dropped(self):
        (self.app / "profile.json").write_text(json.dumps({"name": "Ada", "agent": "Claude Code"}))
        for agent in ("Codex", None, "", 5, "x" * 101):
            with self.subTest(agent=agent):
                status, answer = self.call("POST", "/profile", {"work": "Notes", "agent": agent})
                self.assertEqual((status, answer["ok"], answer["work"]), (200, True, "Notes"))
                self.assertNotIn("agent", answer)
                self.assertNotIn("agent", self.kept())
        # an agent alone changes nothing the profile holds
        self.assertEqual(self.call("POST", "/profile", {"agent": "Codex"})[0], 200)
        self.assertEqual((self.kept()["name"], self.kept()["work"]), ("Ada", "Notes"))
        self.assertNotIn("agent", self.kept())

    def test_every_field_is_checked_before_anything_is_kept(self):
        self.call("POST", "/profile", {"name": "Ada", "work": "Notes"})
        before = self.kept()
        for body, why in (({}, "bad profile"), ([], "bad profile"), (b"not json", "bad profile"),
                          ({"name": "Ada", "phone": "1"}, "bad profile"), ({"complete": True}, "bad profile"),
                          ({"name": ""}, "a name is needed"), ({"name": None}, "a name is needed"),
                          ({"name": "x" * 201}, "bad name"), ({"name": "a\x07b"}, "bad name"),
                          ({"name": 5}, "bad name"), ({"work": "x" * 2001, "name": "Grace"}, "bad work"),
                          ({"email": "ada@"}, "not an email address"),
                          ({"email": 5}, "not an email address"), ({"emailYes": "true"}, "bad yes"),
                          ({"emailYes": 1}, "bad yes"), ({"emailYes": True}, "a yes needs an email"),
                          ({"timeZone": "Mars Base"}, "bad time zone"), ({"timeZone": 5}, "bad time zone")):
            with self.subTest(body=body):
                status, answer = self.call("POST", "/profile", body)
                self.assertEqual((status, answer), (400, {"error": why}))
                self.assertEqual(self.kept(), before)
        self.assertNotIn("x" * 101, json.dumps(self.lines))

    def test_a_new_board_needs_a_name_before_anything_is_kept(self):
        self.assertEqual(self.call("POST", "/profile", {"work": "Notes"}), (400, {"error": "a name is needed"}))
        self.assertFalse((self.app / "profile.json").exists())

    def test_clearing_the_email_takes_the_yes_with_it(self):
        self.call("POST", "/profile", ANSWERS)
        status, answer = self.call("POST", "/profile", {"email": ""})
        self.assertEqual((status, answer["email"], answer["emailYes"]), (200, None, False))
        self.assertEqual(self.call("POST", "/profile", {"email": EMAIL})[1]["emailYes"], False,
                         "an address given again brought the yes back by itself")

    def test_only_a_page_on_this_mac_may_write_and_a_signed_in_phone_may_read(self):
        ask = {"name": "Ada"}
        self.assertEqual(self.call("POST", "/profile", ask, {"origin": None})[0], 403)
        self.assertEqual(self.call("POST", "/profile", ask, {"origin": "https://example.com"})[0], 403)
        self.assertEqual(self.call("POST", "/profile", ask, port=S.BRIDGE_PORT)[0], 404)
        self.assertEqual(self.call("POST", "/profile", ask, {"x-forwarded-for": "100.64.0.9"})[0], 404)
        self.assertEqual(self.call("POST", "/profile", ask, {"sec-fetch-site": "cross-site"})[0], 404)
        self.assertFalse((self.app / "profile.json").exists())
        self.assertEqual(self.call("GET", "/profile", port=S.BRIDGE_PORT)[0], 200)
        import bridge_gate
        self.assertNotIn("/profile", bridge_gate.LOCAL_ONLY)
        self.assertTrue({"/onboarding", "/onboarding/sample", "/usage/email"} <= bridge_gate.LOCAL_ONLY)
        self.assertEqual(self.call("POST", "/profile", b"x" * (S.PROFILE_BODY_MAX + 1))[0], 413)

    def test_no_log_line_holds_a_value(self):
        self.sender()
        self.call("POST", "/profile", ANSWERS)
        self.call("POST", "/profile", {"work": "Something else entirely"})
        logged = json.dumps(self.lines)
        for value in (*[v for v in ANSWERS.values() if isinstance(v, str)], "Something else entirely"):
            self.assertNotIn(value, logged)
        self.assertIn(("profile", {"fields": "work", "yes": True}), self.lines)

    def test_the_endpoint_list_names_the_routes(self):
        for line in ("GET  /profile", "POST /profile", "GET  /onboarding", "POST /onboarding/sample"):
            self.assertIn(line, S.__doc__)


class Picture(Case):
    """The picture Settings, Profile shows on the Mac: one of twelve (19 to 30),
    drawn by chance the first time a page on this Mac asks, kept in profile.json."""

    TWELVE = tuple(range(19, 31))

    def test_one_of_the_twelve_is_drawn_once_and_kept_for_good(self):
        self.call("POST", "/profile", ANSWERS)
        self.assertIsNone(self.kept()["picture"], "drawn before any page needed it")
        first = self.call("GET", "/profile")[1]["picture"]
        self.assertIn(first, self.TWELVE)
        self.assertEqual(S.PROFILE_PICTURES, self.TWELVE)
        self.assertEqual(self.kept()["picture"], first)
        for _ in range(30):
            self.assertEqual(self.call("GET", "/profile")[1]["picture"], first)
        # a restart reads it back from the file, and a change to the profile keeps it
        self.assertEqual(S._profile_read()["picture"], first)
        self.call("POST", "/profile", {"name": "Ada Byron", "email": ""})
        self.assertEqual(self.kept()["picture"], first)
        self.assertEqual(self.call("GET", "/profile")[1]["picture"], first)

    def test_each_of_the_twelve_can_come_up_and_none_of_the_old_three_can(self):
        seen = set()
        for pick in self.TWELVE:
            (self.app / "profile.json").unlink(missing_ok=True)
            self.call("POST", "/profile", ANSWERS)
            with mock.patch.object(S.random, "choice", lambda seq, pick=pick: pick):
                seen.add(self.call("GET", "/profile")[1]["picture"])
        self.assertEqual(seen, set(self.TWELVE))
        for _ in range(200):   # the real draw, over many boards
            (self.app / "profile.json").unlink(missing_ok=True)
            self.call("POST", "/profile", ANSWERS)
            self.assertNotIn(self.call("GET", "/profile")[1]["picture"], (3, 4, 5))

    def test_a_profile_that_holds_one_of_the_old_three_is_drawn_afresh_once_and_then_keeps_it(self):
        for old in (3, 4, 5):
            self.call("POST", "/profile", ANSWERS)
            data = self.kept()
            data["picture"] = old
            (self.app / "profile.json").write_text(json.dumps(data))
            self.assertIsNone(S._profile_read()["picture"])
            fresh = self.call("GET", "/profile")[1]["picture"]
            self.assertIn(fresh, self.TWELVE)
            self.assertEqual(self.kept()["picture"], fresh)
            for _ in range(10):
                self.assertEqual(self.call("GET", "/profile")[1]["picture"], fresh)
            (self.app / "profile.json").unlink()

    def test_nothing_is_drawn_without_a_name_or_for_the_phone(self):
        self.assertIsNone(self.call("GET", "/profile")[1]["picture"])
        self.assertFalse((self.app / "profile.json").exists())
        self.call("POST", "/profile", ANSWERS)
        self.assertIsNone(self.call("GET", "/profile", port=S.BRIDGE_PORT)[1]["picture"])
        self.assertIsNone(self.kept()["picture"])

    def test_a_request_cannot_set_it_and_a_stored_one_that_is_not_one_of_the_twelve_is_ignored(self):
        self.call("POST", "/profile", ANSWERS)
        for value in (19, 3, 1, "19", None):
            self.assertEqual(self.call("POST", "/profile", {"picture": value}), (400, {"error": "bad profile"}))
        self.assertIsNone(self.kept()["picture"])
        for stored in (1, 3, 4, 5, 18, 31, True, "19", 20.0, None):
            (self.app / "profile.json").write_text(json.dumps({"name": "Ada", "picture": stored}))
            if stored is not None:
                self.assertIsNone(S._profile_read()["picture"], repr(stored))

    def test_it_is_not_part_of_what_goes_to_posthog(self):
        self.sender()
        self.call("POST", "/profile", ANSWERS)
        picture = self.call("GET", "/profile")[1]["picture"]
        self.assertIn(picture, self.TWELVE)
        self.call("POST", "/profile", {"work": "Something else"})
        self.settle()
        self.assertNotIn("picture", S._profile_person(S._profile_read()))
        self.assertTrue(self.net.bodies, "nothing was sent at all, so this proves nothing")
        self.assertNotIn("picture", json.dumps(self.net.bodies))


class Gate(Case):
    def test_the_board_is_told_to_put_the_onboarding_up_until_a_name_is_kept(self):
        self.assertTrue(self.lead().endswith("globalThis.BOARD_ONBOARDING=true;"))
        self.call("POST", "/profile", ANSWERS)
        lead = self.lead()
        self.assertNotIn("BOARD_ONBOARDING", lead)
        for value in ("Ada", EMAIL, "Notes", "Claude", "Europe"):
            self.assertNotIn(value, lead, "the store's lead carries the profile")
        (self.app / "profile.json").unlink()
        self.assertIn("BOARD_ONBOARDING=true", self.lead())

    def reading(self):
        S._state.clear()
        S._state.update({"rev": 1, "boxes": [], "busy": {"facilitator": None}, "claimed": {"facilitator": []},
                         "inbox": [], "next_reply_id": 1})
        status, body, _ = S._get_state(S.Query({}), None)
        self.assertEqual(status, 200)
        return json.loads(body)

    def test_every_reading_says_so_too_so_a_page_open_across_a_restart_puts_it_up(self):
        self.assertIs(self.reading().get("onboarding"), True)
        self.call("POST", "/profile", ANSWERS)
        self.assertNotIn("onboarding", self.reading(), "a board with a profile is still told to onboard")
        (self.app / "profile.json").unlink()
        self.assertIs(self.reading().get("onboarding"), True, "a profile gone missing was not noticed")
        (self.app / "profile.json").write_text(json.dumps({"name": ""}))
        self.assertIs(self.reading().get("onboarding"), True)

    def test_the_file_is_read_again_only_when_its_stamp_moves(self):
        self.call("POST", "/profile", ANSWERS)
        self.assertFalse(S._profile_needed())
        with mock.patch.object(S, "_profile_read", side_effect=AssertionError("read again")):
            for _ in range(5):
                self.assertFalse(S._profile_needed())
        self.call("POST", "/profile", {"name": "Grace"})
        self.assertFalse(S._profile_needed())


class PostHog(Case):
    def sets(self):
        return [b["properties"] for b in self.net.bodies]

    def test_the_yes_sends_the_email_and_the_answers_once_as_the_persons_properties(self):
        self.sender()
        status, answer = self.call("POST", "/profile", ANSWERS)
        self.assertEqual((status, answer["ok"]), (200, True))
        self.assertNotIn("sent", answer, "the save still says what PostHog did, so it waited on it")
        self.settle()
        [body] = self.net.bodies
        install = json.loads((self.dir / "usage-install.json").read_text())["install_id"]
        self.assertEqual(body, {"api_key": uc.TOKEN, "event": "$identify", "distinct_id": install,
                                "properties": {"$geoip_disable": True, "$set": {
                                    "email": EMAIL, "name": "Ada Lovelace", "work": ANSWERS["work"],
                                    "time_zone": "Europe/London"}}})
        self.call("POST", "/profile", {"name": "Ada Lovelace", "timeZone": "Europe/London"})
        self.settle()
        self.assertEqual(len(self.net.bodies), 1, "a save that changed nothing was sent")

    def test_an_answer_edited_while_the_yes_holds_is_sent_once_alone(self):
        self.sender()
        for change in (ANSWERS, {"work": "Teaching"}, {"work": None}):
            self.call("POST", "/profile", change)
            self.settle()
        self.assertEqual(self.sets()[1:], [{"$geoip_disable": True, "$set": {"work": "Teaching"}},
                                           {"$geoip_disable": True, "$unset": ["work"]}])

    def test_an_agent_a_page_from_before_sends_never_leaves(self):
        self.sender()
        for change in ({**ANSWERS, "agent": "Claude Code"}, {"agent": "Codex"}, {"agent": None}):
            self.call("POST", "/profile", change)
            self.settle()
        self.assertEqual(len(self.net.bodies), 1)
        self.assertNotIn("agent", json.dumps(self.net.bodies))

    def test_without_the_yes_nothing_leaves(self):
        self.sender()
        self.call("POST", "/profile", {**ANSWERS, "emailYes": False})
        self.call("POST", "/profile", {"work": "Teaching", "name": "Grace"})
        self.assertEqual(self.net.bodies, [])
        self.assertFalse((self.dir / "usage-install.json").exists())

    def test_taking_the_yes_back_sends_nothing_more_and_forgets_it_there(self):
        self.sender()
        for change in (ANSWERS, {"emailYes": False}, {"work": "Teaching"}):
            self.call("POST", "/profile", change)
            self.settle()
        self.assertEqual(len(self.net.bodies), 1)
        kept = json.loads((self.dir / "usage-install.json").read_text())
        self.assertEqual((kept["feedback_yes"], kept["email"], kept["answers"]), (False, None, {}))
        self.assertEqual(self.kept()["email"], EMAIL, "the address left the profile with the yes")
        self.call("POST", "/profile", {"emailYes": True})
        self.settle()
        self.assertEqual(self.sets()[-1]["$set"]["work"], "Teaching")
        self.assertEqual(len(self.net.bodies), 2)

    def test_the_switch_off_keeps_the_yes_and_sends_nothing(self):
        self.sender(sharing=lambda: False)
        status, answer = self.call("POST", "/profile", ANSWERS)
        self.assertEqual((status, answer["emailYes"]), (200, True))
        self.settle()
        self.assertEqual(self.net.bodies, [])
        self.assertFalse(json.loads((self.dir / "usage-install.json").read_text())["identify_done"])

    def test_a_board_without_the_usage_sender_keeps_the_profile_and_sends_nothing(self):
        self.assertEqual(self.call("POST", "/profile", ANSWERS)[0], 200)
        self.assertEqual(self.kept()["email_yes"], True)

    def test_the_save_answers_before_a_slow_posthog_does_and_the_identify_still_goes(self):
        # PostHog holds its answer until the test lets it go, as a slow one
        # would: the save, and the last card's same save after it, answer first
        sender = self.sender()
        release, answered = threading.Event(), []
        net = self.net

        def slow(req, timeout=None):
            net(req, timeout)
            release.wait(10)
            answered.append(time.monotonic())
            return Answer()

        sender.opener = slow
        took = []
        for _ in range(2):
            start = time.monotonic()
            status, answer = self.call("POST", "/profile", ANSWERS)
            took.append(time.monotonic() - start)
            self.assertEqual((status, answer["ok"], answer["complete"]), (200, True, True))
        self.assertEqual(answered, [], "the save waited for PostHog")
        self.assertLess(max(took), 2, "a save took past the two seconds the board waits before it takes the onboarding away")
        self.assertFalse(S._profile_needed(), "the profile was not kept before PostHog answered")
        release.set()
        self.settle()
        # the same one identify as before, once: the second save changed nothing it holds
        install = json.loads((self.dir / "usage-install.json").read_text())
        self.assertEqual(self.net.bodies, [{"api_key": uc.TOKEN, "event": "$identify", "distinct_id": install["install_id"],
                                            "properties": {"$geoip_disable": True, "$set": {
                                                "email": EMAIL, "name": "Ada Lovelace", "work": ANSWERS["work"],
                                                "time_zone": "Europe/London"}}}])
        self.assertTrue(install["identify_done"])

    def test_the_save_answers_while_posthog_refuses_and_the_identify_goes_on_a_later_look(self):
        sender = self.sender()
        net = self.net

        def refusing(req, timeout=None):
            net(req, timeout)
            raise urllib.error.URLError(ConnectionRefusedError(61, "Connection refused"))

        sender.opener = refusing
        self.assertEqual(self.call("POST", "/profile", ANSWERS)[0], 200)
        self.settle()
        self.assertEqual(len(self.net.bodies), 1)
        self.assertFalse(json.loads((self.dir / "usage-install.json").read_text())["identify_done"])
        sender.opener = self.net
        self.assertEqual(sender.identify(), "sent")
        self.assertEqual(self.net.bodies[1], self.net.bodies[0], "the identify that went later is not the same")
        self.assertTrue(json.loads((self.dir / "usage-install.json").read_text())["identify_done"])

    def test_the_two_email_rules_are_one(self):
        for value in ("ada@example.org", " ada@example.org ", "ada", "ada@", "a b@example.org", "ada@example",
                      "a" * 250 + "@example.org", None, 5):
            self.assertEqual(S._clean_email(value), uc.clean_email(value), value)


class Sample(Case):
    def make(self):
        with mock.patch.object(Path, "home", classmethod(lambda cls: self.home)):
            return self.call("POST", "/onboarding/sample", b"")

    def test_it_is_made_once_with_its_internal_folder_and_its_wiki(self):
        status, answer = self.make()
        root = self.home / "facilitator-sample"
        self.assertEqual((status, answer), (200, {"ok": True, "path": str(root.resolve()), "made": True}))
        self.assertEqual(sorted(p.name for p in root.iterdir()),
                         ["facilitator-sample-internal", "facilitator-sample-wiki"])
        note = root / "facilitator-sample-internal" / "example-note.md"
        page = root / "facilitator-sample-wiki" / "example-page.md"
        self.assertTrue(note.read_text().startswith("# Example note\n"))
        self.assertTrue(page.read_text().startswith("# Example page\n"))
        self.assertEqual([p.name for p in self.home.iterdir()], ["facilitator-sample"], "the build folder was left")
        note.write_text("mine now")
        self.assertEqual(self.make(), (200, {"ok": True, "path": str(root.resolve()), "made": False}))
        self.assertEqual(note.read_text(), "mine now", "an existing sample was written over")

    def test_a_folder_a_file_or_a_link_holding_the_name_is_never_touched(self):
        root = self.home / "facilitator-sample"
        root.mkdir()
        self.assertEqual(self.make()[1]["made"], False)
        self.assertEqual(list(root.iterdir()), [])
        root.rmdir()
        root.write_text("a file")
        self.assertEqual(self.make()[0], 409)
        self.assertEqual(root.read_text(), "a file")
        root.unlink()
        root.symlink_to(self.dir / "nowhere")
        self.assertEqual(self.make()[0], 409)
        self.assertTrue(root.is_symlink())
        self.assertFalse((self.dir / "nowhere").exists())

    def test_only_a_page_on_this_mac_may_ask(self):
        with mock.patch.object(Path, "home", classmethod(lambda cls: self.home)):
            self.assertEqual(self.call("POST", "/onboarding/sample", b"", {"origin": None})[0], 403)
            self.assertEqual(self.call("POST", "/onboarding/sample", b"", port=S.BRIDGE_PORT)[0], 404)
        self.assertFalse((self.home / "facilitator-sample").exists())

    def test_its_tab_is_found_again_by_the_folder_post_project_keeps(self):
        status, answer = self.make()
        with mock.patch.object(Path, "home", classmethod(lambda cls: self.home)):
            d = Path(answer["path"]).expanduser().resolve()
        self.assertEqual(str(d), answer["path"])


class Page(Case):
    def test_it_is_served_with_the_boards_version_written_in(self):
        status, body = self.call("GET", "/onboarding")
        self.assertEqual(status, 200)
        version = S.BOARD_VERSION.search((ROOT / "index.html").read_bytes()).group(1)
        self.assertIn(b'<meta name="facilitator-version" content="' + version + b'">', body)
        self.assertNotIn(S.ONBOARDING_VERSION_SLOT, body)

    def test_only_this_mac_gets_it_and_only_the_boards_own_origin_may_frame_it(self):
        self.assertEqual(self.call("GET", "/onboarding", port=S.BRIDGE_PORT)[0], 404)
        self.assertEqual(self.call("GET", "/onboarding", headers={"x-forwarded-for": "100.64.0.9"})[0], 404)
        self.assertEqual(S.SAME_ORIGIN_FRAMES, frozenset({"/m", "/onboarding"}))
        with mock.patch.object(S, "ONBOARDING_PAGE", self.dir / "gone.html"):
            self.assertEqual(self.call("GET", "/onboarding")[0], 404)


if __name__ == "__main__":
    unittest.main()
