"""The feedback box's server side: POST /feedback and the one event it sends.

  event     one "feedback sent" message under the install id, holding the words,
            the app version, and the profile's name and email as $set person
            properties; it goes whether or not the daily counts switch is on
  route     the message must be text, not blank, at most 5000 characters; the
            name and the email come from the profile and both must be there;
            a Mac page that names its own origin and the signed-in phone may
            ask, nothing else; a send that did not get through answers 502
  logs      no line holds a word of the message, the name or the email
  stub      FACILITATOR_POSTHOG_ENDPOINT moves every send to a stub on this
            Mac, and to nowhere else

Nothing reaches PostHog or any other machine: the sender gets a fake opener and
every real connection fails the test. The server is loaded as a module by
test_profile.py, which this reuses.

    python3 -m unittest tests/test_feedback.py
"""

import json
import os
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import usage_counts as uc  # noqa: E402
import test_profile as tp  # noqa: E402

S = tp.S
PEOPLE = {"name": "Ada Lovelace", "email": tp.EMAIL}
WORDS = "The settings page is lovely, but the bin should say how old a card is.\nSecond line, with a tab\tand 'quotes'."


class Feedback(tp.Case):
    def setUp(self):
        super().setUp()
        self.sender()
        self.profile(PEOPLE)

    def profile(self, person):
        (self.app / "profile.json").write_text(json.dumps(person))

    def post(self, message=WORDS, **kw):
        return self.call("POST", "/feedback", {"message": message}, **kw)

    def only_event(self):
        self.assertEqual(len(self.net.bodies), 1)
        return self.net.bodies[0]


class Event(Feedback):
    def test_one_feedback_sent_event_with_the_words_the_version_and_the_person(self):
        self.assertEqual(self.post(), (200, {"ok": True}))
        body = self.only_event()
        install = json.loads((self.dir / "usage-install.json").read_text())["install_id"]
        self.assertEqual(body["event"], "feedback sent")
        self.assertEqual(body["api_key"], uc.TOKEN)
        self.assertEqual(body["distinct_id"], install)
        self.assertEqual(body["properties"], {
            "$set": {"name": "Ada Lovelace", "email": tp.EMAIL},
            "$geoip_disable": True,
            "message": WORDS,
            "facilitator_version": uc.app_version(ROOT / "index.html"),
        })
        self.assertRegex(body["properties"]["facilitator_version"], r"^v\d+\.\d+\.\d+$")
        # an identified event: PostHog is not told to make no profile
        self.assertNotIn("$process_person_profile", body["properties"])

    def test_the_id_is_the_one_the_daily_counts_use(self):
        self.post()
        self.post()
        first, second = self.net.bodies
        self.assertEqual(first["distinct_id"], second["distinct_id"])
        self.assertEqual(first["distinct_id"], S._usage_sender.install.get()["install_id"])

    def test_it_goes_with_the_daily_counts_switch_off(self):
        self.sender(sharing=lambda: False)
        self.assertEqual(self.post()[0], 200)
        self.assertEqual(self.only_event()["event"], "feedback sent")

    def test_the_name_and_email_come_from_the_profile_not_the_page(self):
        self.profile({"name": "Grace Hopper", "email": "grace@example.org"})
        self.post()
        self.assertEqual(self.only_event()["properties"]["$set"], {"name": "Grace Hopper", "email": "grace@example.org"})
        for extra in ({"message": "x", "name": "Mallory"}, {"message": "x", "email": "m@example.org"}):
            with self.subTest(extra=extra):
                self.assertEqual(self.call("POST", "/feedback", extra), (400, {"error": "bad request"}))
        self.assertEqual(len(self.net.bodies), 1)

    def test_the_words_are_trimmed_and_stray_control_characters_dropped(self):
        self.post("  line one\r\nline two\x00\x07  ")
        self.assertEqual(self.only_event()["properties"]["message"], "line one\nline two")

    def test_nothing_else_rides_on_it(self):
        self.post()
        self.assertEqual(set(self.only_event()), {"api_key", "event", "distinct_id", "properties"})


class Refusals(Feedback):
    def test_an_empty_or_blank_message_is_refused_and_nothing_is_sent(self):
        for message in ("", "   ", "\n\t \n", "\x00\x07"):
            with self.subTest(message=message):
                self.assertEqual(self.post(message), (400, {"error": "nothing to send"}))
        self.assertEqual(self.call("POST", "/feedback", {"message": 5}), (400, {"error": "bad request"}))
        self.assertEqual(self.call("POST", "/feedback", {}), (400, {"error": "bad request"}))
        self.assertEqual(self.call("POST", "/feedback", b"not json"), (400, {"error": "bad request"}))
        self.assertEqual(self.net.bodies, [])

    def test_five_thousand_characters_go_and_one_more_does_not(self):
        self.assertEqual(uc.FEEDBACK_MAX, 5000)
        self.assertEqual(self.post("é" * 5000)[0], 200)
        self.assertEqual(self.post("é" * 5001), (400, {"error": "too long"}))
        self.assertEqual(len(self.net.bodies), 1)

    def test_a_profile_without_a_name_or_an_email_sends_nothing(self):
        for person in ({"name": "Ada"}, {"email": tp.EMAIL}, {"name": "Ada", "email": "not an address"}, {}):
            with self.subTest(person=person):
                self.profile(person)
                self.assertEqual(self.post(), (400, {"error": "fill in your name and email in Profile"}))
        self.assertEqual(self.net.bodies, [])

    def test_only_the_macs_own_page_and_the_signed_in_phone_may_ask(self):
        self.assertEqual(self.post(headers={"origin": None})[0], 403)                       # no origin named
        self.assertEqual(self.post(headers={"origin": "http://evil.example"})[0], 403)      # another site's
        self.assertEqual(self.post(headers={"sec-fetch-site": "cross-site"})[0], 403)       # set off by another site
        self.assertEqual(self.net.bodies, [])
        # the phone's door is another port, behind the bridge gate
        self.assertEqual(self.post(headers={"origin": None, "host": "mac.tail.ts.net"}, port=S.PORT + 1)[0], 200)
        self.assertEqual(self.post(headers={"origin": None, "x-forwarded-for": "100.1.2.3"})[0], 200)
        self.assertEqual(len(self.net.bodies), 2)

    def test_a_board_without_the_usage_sender_answers_not_found(self):
        S._usage_sender = None
        self.assertEqual(self.post(), (404, {"error": "not found"}))

    def test_a_request_on_the_boards_own_port_that_is_not_a_local_page_is_refused(self):
        # not local (a name that is not loopback) and not through the phone's door
        self.assertEqual(self.post(headers={"host": "mac.example"})[0], 403)


class Failures(Feedback):
    def test_a_send_that_did_not_get_through_answers_502_and_keeps_nothing(self):
        def offline(req, timeout=None):
            raise urllib.error.URLError("offline")

        S._usage_sender.opener = offline
        self.assertEqual(self.post(), (502, {"error": "did not send"}))
        self.assertEqual(self.post(), (502, {"error": "did not send"}))   # nothing was queued for later
        S._usage_sender.opener = self.net
        self.assertEqual(self.post()[0], 200)
        self.assertEqual(len(self.net.bodies), 1)

    def test_a_refusal_from_posthog_answers_502_too(self):
        def turned_down(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 401, "no", {}, None)

        S._usage_sender.opener = turned_down
        self.assertEqual(self.post()[0], 502)


class Logs(Feedback):
    def test_no_line_holds_a_word_of_it(self):
        secret = "my-private-wording-zx81"
        self.post(secret + " " + WORDS)
        self.post("")
        self.profile({})
        self.post(secret)
        S._usage_sender.log = lambda kind, **f: self.lines.append((kind, f))
        self.profile(PEOPLE)
        self.post(secret)
        flat = json.dumps(self.lines)
        for hidden in (secret, "Ada", tp.EMAIL, "lovely"):
            self.assertNotIn(hidden, flat)
        kinds = [kind for kind, _ in self.lines]
        self.assertIn("feedback", kinds)
        self.assertEqual([f for k, f in self.lines if k == "feedback"][0],
                         {"outcome": "sent", "chars": len(secret + " " + WORDS)})


class Stub(unittest.TestCase):
    def test_the_variable_moves_the_endpoint_to_a_stub_on_this_mac_and_nowhere_else(self):
        real = uc.POSTHOG_ENDPOINT
        for value, expected in (("http://127.0.0.1:9999/i/v0/e/", "http://127.0.0.1:9999/i/v0/e/"),
                                ("http://localhost:9999/", "http://localhost:9999/"),
                                ("https://example.org/i/v0/e/", real), ("http://127.0.0.1.evil.org/", real),
                                ("http://evil.org:9999/", real), ("http://127.0.0.1:80@evil.org/", real),
                                ("http://127.0.0.1/", real), ("", real)):
            with self.subTest(value=value), mock.patch.dict(os.environ, {uc.ENDPOINT_ENV: value}):
                self.assertEqual(uc.endpoint(), expected)
        with mock.patch.dict(os.environ):
            os.environ.pop(uc.ENDPOINT_ENV, None)
            self.assertEqual(uc.endpoint(), real)


if __name__ == "__main__":
    unittest.main()
