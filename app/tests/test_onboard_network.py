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


if __name__ == "__main__":
    unittest.main()
