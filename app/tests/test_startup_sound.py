"""The first run's startup sound, on the server.

  gate      /board-settings.js says the sound is still to come
            (BOARD_STARTUP_SOUND=true, before BOARD_ONBOARDING=true, which
            stays last) only while the onboarding is still to do and no note
            says the sound came
  route     POST /startup-sound with mac plays assets/startup-sound.wav with
            afplay, once; with page it plays nothing, the page having played
            it; either way the note is kept and the sound never comes again,
            on a board whose onboarding is done least of all. Only a page on
            this Mac may ask, and a sound that could not start leaves no note
  file      the sound kept for the Mac is in app/assets

No sound is played: afplay is replaced by a fake, and the server is loaded as
a module with every file it writes moved into a temporary directory.

    python3 -m unittest tests/test_startup_sound.py
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load_server():
    os.environ["FACILITATOR_LOG_DIR"] = tempfile.mkdtemp(prefix="startup-sound-test-logs-")
    import importlib.util
    spec = importlib.util.spec_from_file_location("facilitator_server_startup_sound_test", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._save = lambda: None
    module._notify = lambda *a, **k: None
    return module


S = _load_server()


class Player:
    """afplay as the route starts it: every start kept, nothing played."""

    def __init__(self, fails=False):
        self.calls, self.fails = [], fails

    def __call__(self, args, **kwargs):
        if self.fails:
            raise OSError(2, "No such file or directory")
        self.calls.append((args, kwargs))
        return mock.Mock(wait=lambda: 0)


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="startup-sound-test-"))
        self.paths = mock.patch.multiple(S, PROFILE_PATH=self.dir / "profile.json",
                                         STARTUP_SOUND_NOTE=self.dir / "startup-sound.json", HERE=ROOT)
        self.paths.start()
        self.lines = []
        self.info = mock.patch.object(S, "_info", lambda kind, box="", **f: self.lines.append((kind, f)))
        self.info.start()
        self.player = Player()
        self.popen = mock.patch.object(S.subprocess, "Popen", self.player)
        self.popen.start()
        self.mac = mock.patch.object(S.sys, "platform", "darwin")
        self.mac.start()
        S._settings = {"rev": 0, "values": {}, "spotify": {}}

    def tearDown(self):
        self.mac.stop()
        self.popen.stop()
        self.info.stop()
        self.paths.stop()

    def call(self, body, headers=None, port=None):
        """One POST /startup-sound as the board's page on this Mac makes it
        unless the headers say otherwise."""
        raw = body.encode()
        head = {"host": f"127.0.0.1:{S.PORT}", "origin": f"http://127.0.0.1:{S.PORT}"}
        head.update(headers or {})
        scope = {"type": "http", "method": "POST", "path": "/startup-sound", "query_string": b"",
                 "http_version": "1.1", "scheme": "http", "client": ("127.0.0.1", 50000),
                 "server": ("127.0.0.1", port or S.PORT),
                 "headers": [(k.encode(), v.encode()) for k, v in head.items() if v is not None]}
        sent = []

        async def receive():
            if sent:
                return {"type": "http.disconnect"}
            sent.append(1)
            return {"type": "http.request", "body": raw, "more_body": False}

        [route] = [r for r in S.ROUTES if r.path == "/startup-sound" and "POST" in r.methods]
        response = asyncio.run(route.endpoint(S.Request(scope, receive)))
        return response.status_code, json.loads(response.body)

    def lead(self):
        """What the server writes in front of board-settings.js, which comes
        as a whole answer (scripts are packed for the browsers that take gzip)."""
        answer = S._get_board_settings_js(S.Query({}), None)
        status, body = (answer[0], answer[1]) if isinstance(answer, tuple) else (answer.status_code, answer.body)
        self.assertEqual(status, 200)
        own = (ROOT / "board-settings.js").read_bytes()
        return body[:-len(own)].decode()

    def note(self):
        return json.loads((self.dir / "startup-sound.json").read_text())

    def onboarded(self):
        (self.dir / "profile.json").write_text(json.dumps({"name": "Ada"}))


class Gate(Case):
    def test_a_new_board_is_told_the_sound_is_to_come_and_the_onboarding_stays_last(self):
        lead = self.lead()
        self.assertTrue(lead.endswith("globalThis.BOARD_STARTUP_SOUND=true;globalThis.BOARD_ONBOARDING=true;"))

    def test_once_it_came_the_board_is_not_told_again(self):
        self.assertEqual(self.call("page")[0], 200)
        lead = self.lead()
        self.assertNotIn("BOARD_STARTUP_SOUND", lead)
        self.assertTrue(lead.endswith("globalThis.BOARD_ONBOARDING=true;"), "the onboarding is no longer put up")

    def test_a_board_somebody_has_been_through_the_onboarding_on_gets_no_word_of_it(self):
        self.onboarded()
        lead = self.lead()
        self.assertNotIn("BOARD_STARTUP_SOUND", lead)
        self.assertNotIn("BOARD_ONBOARDING", lead)


class Route(Case):
    def test_mac_plays_the_kept_sound_with_afplay_once_and_keeps_the_note(self):
        self.assertEqual(self.call("mac"), (200, {"ok": True, "played": True, "by": "mac"}))
        [(args, kwargs)] = self.player.calls
        self.assertEqual(args, ["/usr/bin/afplay", str(ROOT / "assets" / "startup-sound.wav")])
        self.assertEqual(args[0], S.AFPLAY)
        self.assertTrue(kwargs["start_new_session"])
        self.assertEqual((kwargs["stdin"], kwargs["stdout"], kwargs["stderr"]), (subprocess.DEVNULL,) * 3)
        self.assertEqual(self.note()["by"], "mac")
        self.assertEqual((self.dir / "startup-sound.json").stat().st_mode & 0o777, 0o600)
        self.assertIn(("startupsound", {"by": "mac"}), self.lines)
        # never again, whoever asks
        for by in ("mac", "page"):
            self.assertEqual(self.call(by), (200, {"ok": True, "played": False}))
        self.assertEqual(len(self.player.calls), 1, "the sound played twice")

    def test_page_plays_nothing_here_and_keeps_the_note_so_the_mac_never_plays_it_too(self):
        self.assertEqual(self.call("page"), (200, {"ok": True, "played": True, "by": "page"}))
        self.assertEqual(self.note()["by"], "page")
        self.assertEqual(self.call("mac"), (200, {"ok": True, "played": False}))
        self.assertEqual(self.player.calls, [], "both the page and the Mac played it")

    def test_never_on_a_board_whose_onboarding_is_done(self):
        self.onboarded()
        for by in ("mac", "page"):
            self.assertEqual(self.call(by), (200, {"ok": True, "played": False}))
        self.assertEqual(self.player.calls, [])
        self.assertFalse((self.dir / "startup-sound.json").exists())

    def test_only_a_page_on_this_mac_may_ask_and_only_page_or_mac(self):
        self.assertEqual(self.call("mac", {"origin": None})[0], 403)
        self.assertEqual(self.call("mac", {"origin": "https://example.com"})[0], 403)
        self.assertEqual(self.call("mac", port=S.BRIDGE_PORT)[0], 404)
        self.assertEqual(self.call("mac", {"x-forwarded-for": "100.64.0.9"})[0], 404)
        for body in ("", "both", "MAC", "afplay /etc/passwd"):
            self.assertEqual(self.call(body)[0], 400, body)
        self.assertEqual(self.player.calls, [])
        self.assertFalse((self.dir / "startup-sound.json").exists())
        import bridge_gate
        self.assertIn("/startup-sound", bridge_gate.LOCAL_ONLY)

    def test_a_sound_that_could_not_start_leaves_no_note_so_a_later_first_run_tries_again(self):
        with mock.patch.object(S.subprocess, "Popen", Player(fails=True)):
            self.assertEqual(self.call("mac")[0], 500)
        self.assertFalse((self.dir / "startup-sound.json").exists())
        with mock.patch.object(S.sys, "platform", "linux"):
            self.assertEqual(self.call("mac")[0], 501)
        with mock.patch.object(S, "STARTUP_SOUND", self.dir / "gone.wav"):
            self.assertEqual(self.call("mac")[0], 501)
        self.assertFalse((self.dir / "startup-sound.json").exists())
        self.assertIn("BOARD_STARTUP_SOUND", self.lead())
        self.assertEqual(self.call("mac")[1]["played"], True)

    def test_the_endpoint_list_names_it_and_the_sound_and_its_note_are_where_they_say(self):
        self.assertIn("POST /startup-sound", S.__doc__)
        self.assertIn("BOARD_STARTUP_SOUND", S.__doc__)
        self.paths.stop()
        try:
            self.assertEqual(S.STARTUP_SOUND, ROOT / "assets" / "startup-sound.wav")
            self.assertTrue(S.STARTUP_SOUND.is_file())
            self.assertEqual(S.STARTUP_SOUND_NOTE, S.DATA / "startup-sound.json")
        finally:
            self.paths.start()


if __name__ == "__main__":
    unittest.main()
