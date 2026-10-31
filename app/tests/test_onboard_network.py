"""Local onboarding failures must describe access, never imply a claim.

These tests inject transport failures without calling the live board or
depending on either host's sandbox implementation.
"""

import argparse
import contextlib
import errno
import importlib.util
import io
import json
import socket
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch


HELPER = Path(__file__).resolve().parents[2] / ".agents/skills/facilitator/scripts/onboard.py"
spec = importlib.util.spec_from_file_location("onboard_network", HELPER)
onboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(onboard)


class LocalNetworkErrors(unittest.TestCase):
    def setUp(self):
        self.state = {"pwd": str(onboard.REPO), "pwds": {}, "busy": {"demo": None},
                      "listening": {}, "listenerGap": {}}
        self.args = argparse.Namespace(board="demo", path=None, owner="demo", agent="sol", timeout=1)

    def invoke(self, command, request):
        with patch.object(onboard, "remote_record", return_value=None), \
                patch.object(onboard, "port", return_value=8877), \
                patch.object(onboard, "request", side_effect=request) as called, \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            command(self.args)
        lines = printed.getvalue().splitlines()
        self.assertEqual(len(lines), 1, lines)
        return json.loads(lines[0]), called

    def failures(self):
        for wrap in (lambda exc: exc, urllib.error.URLError,
                     lambda exc: urllib.error.URLError(urllib.error.URLError(exc))):
            for number in (errno.EPERM, errno.EACCES):
                yield wrap(OSError(number, "denied")), "permission_denied"
            yield wrap(PermissionError("denied without errno")), "permission_denied"
            yield wrap(ConnectionRefusedError(errno.ECONNREFUSED, "refused")), "down"
            yield wrap(socket.timeout("timed out")), "connection_error"
            yield wrap(OSError(errno.ETIMEDOUT, "timed out")), "connection_error"
            yield wrap(OSError(errno.ENETUNREACH, "unreachable")), "connection_error"
            yield wrap(socket.gaierror(socket.EAI_NONAME, "unknown host")), "connection_error"
        # A string that resembles a permission error is not reliable evidence.
        yield urllib.error.URLError("Operation not permitted"), "connection_error"

    def test_inspect_and_wait_prechecks_classify_the_underlying_error(self):
        for failure, expected in self.failures():
            for command in (onboard.inspect, onboard.wait):
                with self.subTest(command=command.__name__, failure=repr(failure), expected=expected):
                    said, called = self.invoke(command, failure)
                    self.assertEqual(said["status"], expected)
                    self.assertEqual(said["port"], 8877)
                    if expected in ("permission_denied", "connection_error"):
                        self.assertTrue(said["detail"])
                    self.assertNotIn("box", said)
                    self.assertNotIn("ack", said)
                    called.assert_called_once_with("GET", "/state")

    def test_http_invalid_json_and_other_board_responses_keep_their_statuses(self):
        for response, expected in (
                (urllib.error.HTTPError("http://127.0.0.1/state", 403, "Forbidden", {}, None), "different_server"),
                (ValueError("invalid JSON"), "different_server"),
                ([], "different_server"),
                ({**self.state, "pwd": str(onboard.REPO.parent)}, "different_board")):
            for command in (onboard.inspect, onboard.wait):
                with self.subTest(command=command.__name__, response=response):
                    said, called = self.invoke(command, [response])
                    self.assertEqual(said, {"status": expected, "port": 8877})
                    self.assertEqual(called.call_count, 1)

    def test_a_refused_key_is_said_and_claims_nothing(self):
        refused = urllib.error.HTTPError("http://127.0.0.1/state", 401, "Unauthorized", {}, None)
        for command in (onboard.inspect, onboard.wait):
            with self.subTest(command=command.__name__):
                said, called = self.invoke(command, [refused])
                self.assertEqual(said["status"], "key_refused")
                self.assertEqual(said["port"], 8877)
                self.assertIn("did not take this folder's agent key", said["detail"])
                self.assertNotIn("box", said)
                self.assertEqual(called.call_count, 1)

    def test_inspect_names_the_key_file_only_once_the_board_made_it(self):
        # a board older than the key, still running after an update, made no
        # key file, and the runbook's curl lines go without -K
        with tempfile.TemporaryDirectory() as folder:
            curl = Path(folder) / "agent.curl"
            with patch.object(onboard, "AGENT_CURL", curl), patch.object(onboard, "profile_name", return_value=None):
                said, _ = self.invoke(onboard.inspect, [self.state])
                self.assertEqual(said, {"status": "ready", "owner": "demo", "port": 8877,
                                        "runbook": str(onboard.RUNBOOK)})
                curl.write_text('header = "Authorization: Bearer ' + "k" * 43 + '"\n')
                said, _ = self.invoke(onboard.inspect, [self.state])
        self.assertEqual(said["curl"], f"-K {curl}")
        self.assertTrue(Path(said["curl"][len("-K "):]).is_absolute())
        self.assertEqual(said["base"], "http://127.0.0.1:8877")
        self.assertEqual(list(said), ["status", "owner", "port", "runbook", "curl", "base"])

    def test_every_local_call_carries_the_key_and_no_proxy(self):
        sent = []

        class Answer(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *rest):
                return False

        def opened(request, timeout):
            sent.append(request)
            return Answer(b"{}")

        key = "k" * 43
        with tempfile.TemporaryDirectory() as folder:
            held = Path(folder) / "agent.key"
            held.write_text(key + "\n")
            with patch.object(onboard, "AGENT_KEY", held), patch.object(onboard, "port", return_value=8877), \
                    patch.object(onboard.OPENER, "open", side_effect=opened):
                onboard.request("GET", "/state")
                held.write_text("not a key\n")
                onboard.request("POST", "/ack?owner=demo&token=t")
        self.assertEqual(sent[0].full_url, "http://127.0.0.1:8877/state")
        self.assertEqual(sent[0].get_header("Authorization"), "Bearer " + key)
        self.assertIsNone(sent[1].get_header("Authorization"))
        self.assertFalse(any(isinstance(h, urllib.request.ProxyHandler) and h.proxies
                             for h in onboard.OPENER.handlers))

    def test_wait_and_ack_failures_never_print_or_retry_a_claim(self):
        claim = {"ack": "receipt-secret", "box": "m1", "messages": ["hi"]}
        for failure, precheck_status in self.failures():
            for during_ack in (False, True):
                with self.subTest(failure=repr(failure), during_ack=during_ack):
                    responses = [self.state, dict(claim), failure] if during_ack else [self.state, failure]
                    said, called = self.invoke(onboard.wait, responses)
                    expected = "permission_denied" if precheck_status == "permission_denied" else "connection_error"
                    self.assertEqual(said["status"], expected)
                    self.assertNotIn("box", said)
                    self.assertNotIn("ack", said)
                    self.assertNotIn("receipt-secret", json.dumps(said))
                    self.assertEqual(called.call_count, 3 if during_ack else 2)
                    self.assertTrue(called.call_args_list[1].args[1].startswith("/wait?"))
                    if during_ack:
                        self.assertEqual(called.call_args_list[2].args[:2],
                                         ("POST", "/ack?owner=demo&token=receipt-secret"))

    def test_only_a_successful_ack_outputs_a_claim(self):
        for ack, expected in (({"ok": False}, "ack_failed"), (None, "ack_failed"), ({"ok": True}, "claim")):
            with self.subTest(ack=ack):
                said, called = self.invoke(onboard.wait,
                    [self.state, {"ack": "receipt-secret", "box": "m1", "messages": ["hi"]}, ack])
                self.assertEqual(said["status"], expected)
                self.assertNotIn("ack", said)
                self.assertEqual(called.call_count, 3)
                if expected == "claim":
                    self.assertEqual(said["messages"], ["hi"])


def piped(data):
    """Standard input carrying data, as a pipe or a heredoc gives it."""
    return io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")


class ReplyThenListen(unittest.TestCase):
    """wait --reply on the Mac, with the board's answers given in order: the
    check that comes first, what stops the reply, what a refused reply
    leaves, and the listen after a reply that went."""

    NOTHING = {"box": "m1", "messages": [], "message_via": [], "message_by": [], "message_agent": []}
    CLAIM = {"box": "m2", "title": "t", "messages": ["next"], "message_via": [None], "queued_after": 0, "ack": "tok"}

    def setUp(self):
        self.state = {"pwd": str(onboard.REPO), "pwds": {}, "busy": {"demo": "m1"},
                      "listening": {}, "listenerGap": {}}
        self.free = {**self.state, "busy": {"demo": None}}
        self.args = argparse.Namespace(owner="demo", agent="opus", timeout=1, reply="m1")

    def invoke(self, request, stdin=b"The answer.\n"):
        with patch.object(onboard, "remote_record", return_value=None), \
                patch.object(onboard, "port", return_value=8877), \
                patch.object(onboard.sys, "stdin", piped(stdin) if isinstance(stdin, bytes) else stdin), \
                patch.object(onboard, "request", side_effect=request) as called, \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            onboard.wait(self.args)
        lines = printed.getvalue().splitlines()
        self.assertEqual(len(lines), 1, lines)
        return json.loads(lines[0]), [c.args[:2] for c in called.call_args_list], called

    def test_an_empty_reply_is_refused_before_any_call(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True
        for stdin in (b"", b"  \n\t\n", Terminal("typed")):
            with self.subTest(stdin=stdin):
                with patch.object(onboard, "remote_record") as looked:
                    said, calls, _ = self.invoke([], stdin)
                self.assertEqual(said["status"], "empty_reply")
                self.assertEqual(said["box"], "m1")
                self.assertEqual(calls, [])
                looked.assert_not_called()

    def test_nothing_new_posts_the_raw_reply_then_listens_as_wait(self):
        body = "Line one.\n\n  **Two**, as typed: é\n".encode()
        said, calls, called = self.invoke([self.state, self.NOTHING, {"ok": True}, self.free, dict(self.CLAIM),
                                           {"ok": True}], body)
        self.assertEqual(calls, [("GET", "/state"), ("GET", "/fresh?owner=demo"), ("POST", "/reply?box=m1"),
                                 ("GET", "/state"), ("GET", "/wait?owner=demo&timeout=1&agent=opus"),
                                 ("POST", "/ack?owner=demo&token=tok")])
        self.assertEqual(called.call_args_list[2].kwargs["data"], body)
        claim = {k: v for k, v in self.CLAIM.items() if k != "ack"}
        self.assertEqual(said, {"status": "replied", "box": "m1", "reply": {"ok": True},
                                "next": {"status": "claim", "owner": "demo", **claim}})

    def test_the_listen_after_a_reply_keeps_waits_own_answers(self):
        for answers, expected in (
                ([{"idle": True}], {"status": "idle", "owner": "demo"}),
                ([dict(self.CLAIM), {"ok": False}], {"status": "ack_failed", "owner": "demo", "box": "m2"})):
            with self.subTest(expected=expected["status"]):
                said, _, _ = self.invoke([self.state, self.NOTHING, {"ok": True}, self.free, *answers])
                self.assertEqual((said["status"], said["next"]), ("replied", expected))
        # the card the reply answered still held when the listen looks: wait's own word for it
        said, _, _ = self.invoke([self.state, self.NOTHING, {"ok": True}, self.state])
        self.assertEqual(said["next"], {"status": "claim_held", "owner": "demo", "box": "m1"})

    def test_anything_new_posts_nothing_and_is_given_back(self):
        widget = [{"from": "widget", "widget": "issues", "about": "t1", "text": "and this?", "ts": 1.0}]
        for fresh in ({**self.NOTHING, "messages": ["a follow-up"], "message_via": [None], "message_by": [None],
                       "message_agent": [None]},
                      {**self.NOTHING, "box": "m7"},
                      {**self.NOTHING, "widget_messages": widget}):
            with self.subTest(fresh=fresh):
                said, calls, _ = self.invoke([self.state, fresh])
                self.assertEqual(said, {"status": "fresh", **fresh})
                self.assertEqual(calls, [("GET", "/state"), ("GET", "/fresh?owner=demo")])

    def test_with_no_card_held_a_reply_goes(self):
        nothing = {"messages": [], "message_via": [], "message_by": [], "message_agent": []}
        said, calls, _ = self.invoke([self.free, nothing, {"ok": True}, self.free, {"idle": True}])
        self.assertEqual(said["status"], "replied")
        self.assertEqual(calls[2], ("POST", "/reply?box=m1"))

    def test_a_refused_reply_says_the_boards_words_and_listens_for_nothing(self):
        refusal = urllib.error.HTTPError("http://127.0.0.1/reply", 400, "Bad Request", {},
                                         io.BytesIO(b'{"error": "small card reply over 100 words: 140 words"}'))
        said, calls, _ = self.invoke([self.state, self.NOTHING, refusal])
        self.assertEqual(said, {"status": "reply_failed", "box": "m1", "code": 400,
                                "reply": {"error": "small card reply over 100 words: 140 words"}})
        self.assertEqual(len(calls), 3)

    def test_a_cut_reply_call_says_so_and_listens_for_nothing(self):
        said, calls, _ = self.invoke([self.state, self.NOTHING, socket.timeout("timed out")])
        self.assertEqual(said["status"], "reply_failed")
        self.assertIn("may or may not have the reply", said["detail"])
        self.assertEqual(len(calls), 3)

    def test_a_failed_check_posts_nothing(self):
        for failure, expected in ((ConnectionRefusedError(errno.ECONNREFUSED, "refused"), "connection_error"),
                                  (PermissionError("denied"), "permission_denied"),
                                  (ValueError("not JSON"), "connection_error"),
                                  (["not", "an", "object"], "protocol_error"),
                                  (urllib.error.HTTPError("http://127.0.0.1/fresh", 403, "Forbidden", {},
                                                          io.BytesIO(b'{"error": "only the lane\'s agent"}')),
                                   "protocol_error"),
                                  (urllib.error.HTTPError("http://127.0.0.1/fresh", 401, "Unauthorized", {},
                                                          io.BytesIO(b'{"error": "no key"}')),
                                   "key_refused")):
            with self.subTest(failure=repr(failure)):
                said, calls, _ = self.invoke([self.state, failure])
                self.assertEqual(said["status"], expected)
                self.assertEqual(len(calls), 2)
        # and the board itself not this folder's, or not taking its key: no /fresh at all
        refused = urllib.error.HTTPError("http://127.0.0.1/state", 401, "Unauthorized", {}, None)
        for answer, expected in ((refused, "key_refused"), ({**self.state, "pwd": "/elsewhere"}, "different_board"),
                                 ({**self.state, "busy": {"other": None}}, "project_unknown")):
            with self.subTest(expected=expected):
                said, calls, _ = self.invoke([answer])
                self.assertEqual(said["status"], expected)
                self.assertEqual(calls, [("GET", "/state")])
        refused.close()


if __name__ == "__main__":
    unittest.main()
