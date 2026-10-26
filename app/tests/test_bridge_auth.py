"""The phone's password and sign-ins, in bridge_auth.py, on a password file of
its own in a temporary folder and with its clocks moved by hand.

  devices   wrong passwords are counted per device: five in a minute lock out
            that device only, a right password clears only its own count, and
            all devices together are held to twenty a minute; a request with no
            X-Forwarded-For counts as "local"
  idle      a sign-in not used for 30 days is refused and removed; one used
            within them works and is moved to now, written at most once an hour;
            the push check says no once it has ended and never counts as a use
  older     a file from before stamps keeps its sign-ins, each with 30 days from
            the first time it is seen; the file stays version 1 with the same
            fields, so older code still finds the password and the sign-ins

    python3 -B -m unittest tests/test_bridge_auth.py
"""

import hashlib
import json
import secrets
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

APP = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP))
import bridge_auth as auth  # noqa: E402
import bridge_gate  # noqa: E402

PASS = "Fixture-Bridge-7"
WRONG = "Not-The-Password-8"
DAY = 24 * 60 * 60
HOUR = 60 * 60
START = 1_800_000_000


def digest_of(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


class Case(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="facilitator-bridge-auth-")
        self.addCleanup(folder.cleanup)
        data = Path(folder.name) / "data"
        self.file = data / "bridge-auth.json"
        self.clock = START       # wall clock seconds, for the sign-ins' last use
        self.tick = 1000.0       # the wrong passwords' window
        for name, value in (("AUTH_FILE", self.file), ("LOCK_FILE", self.file.with_suffix(".lock")),
                            ("_now", lambda: self.clock),
                            ("time", types.SimpleNamespace(monotonic=lambda: self.tick))):
            patcher = mock.patch.object(auth, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        auth._failures.clear()
        self.addCleanup(auth._failures.clear)
        auth.set_password(PASS)

    def saved(self):
        return json.loads(self.file.read_text())

    def rewrite(self, change):
        data = self.saved()
        change(data)
        self.file.write_text(json.dumps(data))

    def sign_in(self, device="local"):
        verdict, token = auth.login(PASS, device)
        self.assertEqual(verdict, "ok")
        return token


class WrongPasswords(Case):
    def test_five_wrong_lock_out_that_device_while_another_signs_in(self):
        for _ in range(5):
            self.assertEqual(auth.login(WRONG, "100.64.0.1"), ("wrong", None))
        self.assertEqual(auth.login(PASS, "100.64.0.1"), ("limited", None))
        self.assertEqual(auth.login(PASS, "100.64.0.2")[0], "ok")
        self.assertEqual(auth.login(PASS, "local")[0], "ok")

    def test_a_right_password_clears_only_its_own_device(self):
        for _ in range(5):
            auth.login(WRONG, "100.64.0.1")
        for _ in range(3):
            auth.login(WRONG, "100.64.0.2")
        self.sign_in("100.64.0.2")
        self.assertEqual(auth.login(PASS, "100.64.0.1"), ("limited", None), "another device's sign-in unlocked it")
        # the cleared device has five again: with its three still counted this would be limited
        for _ in range(4):
            self.assertEqual(auth.login(WRONG, "100.64.0.2")[0], "wrong")
        self.sign_in("100.64.0.2")

    def test_all_devices_together_are_held_to_twenty_a_minute(self):
        for n in range(4):
            for _ in range(5):
                self.assertEqual(auth.login(WRONG, f"100.64.1.{n}")[0], "wrong")
        for device in ("100.64.2.1", "local"):
            self.assertEqual(auth.login(PASS, device), ("limited", None), device)
        self.tick += 60
        self.sign_in("100.64.2.1")

    def test_twenty_devices_with_one_wrong_try_each_reach_the_ceiling(self):
        for n in range(20):
            self.assertEqual(auth.login(None, f"100.64.3.{n}")[0], "wrong")
        self.assertEqual(auth.login(PASS, "100.64.3.99"), ("limited", None))

    def test_a_lock_lifts_once_the_minute_has_passed(self):
        for _ in range(5):
            auth.login(WRONG, "100.64.0.1")
        self.tick += 59
        self.assertEqual(auth.login(PASS, "100.64.0.1"), ("limited", None))
        self.tick += 1
        self.sign_in("100.64.0.1")

    def test_no_header_counts_as_local(self):
        self.assertEqual(bridge_gate._device({}), "local")
        self.assertEqual(bridge_gate._device({b"x-forwarded-for": b"100.64.0.9"}), "100.64.0.9")
        self.assertEqual(bridge_gate._device({b"x-forwarded-for": b" 203.0.113.5 , 100.64.0.9 "}), "100.64.0.9",
                         "not the last entry, the one Serve gives")
        self.assertEqual(bridge_gate._device({b"x-forwarded-for": b"x" * 100}), "x" * 64)
        self.assertEqual(bridge_gate._device({b"x-forwarded-for": b" , "}), "local")
        for _ in range(3):
            auth.login(WRONG)
        for _ in range(2):
            auth.login(WRONG, "local")
        self.assertEqual(auth.login(PASS), ("limited", None), "no device and local were counted apart")
        self.sign_in("100.64.0.9")

    def test_the_table_keeps_at_most_256_devices_dropping_the_oldest(self):
        with mock.patch.object(auth, "MAX_ATTEMPTS_ALL", 10_000):
            for n in range(300):
                self.tick += 0.01
                auth.login(None, f"device-{n}")
        self.assertEqual(len(auth._failures), 256)
        self.assertNotIn("device-43", auth._failures)
        self.assertIn("device-44", auth._failures)
        self.assertIn("device-299", auth._failures)


class IdleSignIns(Case):
    def test_unused_for_thirty_days_and_a_second_ends_while_one_used_29_days_ago_works(self):
        old, kept = self.sign_in(), self.sign_in()
        self.clock = START + DAY + 1
        self.assertTrue(auth.has_session(kept))
        self.clock = START + 30 * DAY + 1
        self.assertFalse(auth.has_session(old))
        data = self.saved()
        self.assertNotIn(digest_of(old), data["sessions"])
        self.assertNotIn(digest_of(old), data["used"])
        self.assertTrue(auth.has_session(kept))
        self.assertEqual(self.saved()["used"][digest_of(kept)], self.clock, "a use 29 days old was not moved to now")
        self.assertFalse(auth.has_session(old), "an ended sign-in came back")

    def test_exactly_thirty_days_still_works(self):
        token = self.sign_in()
        self.clock = START + 30 * DAY
        self.assertTrue(auth.has_session(token))

    def test_a_use_is_written_at_most_once_an_hour(self):
        token = self.sign_in()
        with mock.patch.object(auth, "_write", wraps=auth._write) as written:
            for moment in (START + 10, START + HOUR - 1):
                self.clock = moment
                self.assertTrue(auth.has_session(token))
            self.assertEqual(written.call_count, 0)
            self.clock = START + HOUR
            self.assertTrue(auth.has_session(token))
            self.assertEqual(written.call_count, 1)
            self.assertEqual(self.saved()["used"][digest_of(token)], START + HOUR)
            for moment in (START + HOUR + 1, START + 2 * HOUR - 1):
                self.clock = moment
                self.assertTrue(auth.has_session(token))
            self.assertEqual(written.call_count, 1)

    def test_the_push_check_says_no_once_ended_and_is_not_a_use(self):
        token = self.sign_in()
        digest = digest_of(token)
        self.clock = START + 29 * DAY
        self.assertTrue(auth.has_session_digest(digest))
        self.assertEqual(self.saved()["used"][digest], START, "a push counted as the phone using its sign-in")
        self.clock = START + 30 * DAY + 1
        self.assertFalse(auth.has_session_digest(digest))
        self.assertNotIn(digest, self.saved()["sessions"])
        self.assertFalse(auth.has_session(token))

    def test_a_stamp_in_the_future_counts_as_now(self):
        token = self.sign_in()
        self.rewrite(lambda data: data["used"].update({digest_of(token): START + 365 * DAY}))
        self.assertTrue(auth.has_session(token))
        self.assertEqual(self.saved()["used"][digest_of(token)], START)
        self.clock = START + 30 * DAY + 1
        self.assertFalse(auth.has_session(token))

    def test_a_sign_in_removes_the_ones_that_have_ended(self):
        old = self.sign_in()
        self.clock = START + 31 * DAY
        new = self.sign_in()
        data = self.saved()
        self.assertEqual(data["sessions"], [digest_of(new)])
        self.assertEqual(data["used"], {digest_of(new): self.clock})
        self.assertFalse(auth.has_session(old))

    def test_sign_out_removes_the_session_and_its_stamp(self):
        token, other = self.sign_in(), self.sign_in()
        auth.logout(token)
        data = self.saved()
        self.assertEqual(data["sessions"], [digest_of(other)])
        self.assertEqual(list(data["used"]), [digest_of(other)])
        self.assertFalse(auth.has_session(token))
        self.assertTrue(auth.has_session(other))

    def test_a_new_password_empties_the_sessions_and_their_stamps(self):
        self.sign_in()
        auth.set_password("Another-Bridge-9")
        data = self.saved()
        self.assertEqual((data["sessions"], data["used"]), ([], {}))


class OlderFiles(Case):
    def test_a_file_from_before_stamps_keeps_its_sign_ins_for_30_days_from_first_sight(self):
        opened, idle = secrets.token_hex(32), secrets.token_hex(32)

        def older(data):
            data.pop("used")
            data["sessions"] = [digest_of(opened), digest_of(idle)]
        self.rewrite(older)
        self.clock = START + 400 * DAY
        self.assertTrue(auth.has_session(opened), "a phone signed in before stamps was signed out")
        first = self.clock
        self.assertEqual(self.saved()["used"], {digest_of(opened): first, digest_of(idle): first})
        self.clock = first + 29 * DAY
        self.assertTrue(auth.has_session(opened))
        self.clock = first + 30 * DAY + 1
        self.assertFalse(auth.has_session(idle), "a sign-in never used since the change did not end")
        self.assertTrue(auth.has_session(opened))
        self.assertEqual(self.saved()["sessions"], [digest_of(opened)])

    def test_a_sign_in_added_by_older_code_gets_its_30_days(self):
        self.sign_in()
        added = secrets.token_hex(32)
        self.rewrite(lambda data: data["sessions"].append(digest_of(added)))
        self.clock = START + 40 * DAY
        self.assertTrue(auth.has_session(added))
        self.assertEqual(self.saved()["used"][digest_of(added)], self.clock)

    def test_a_stamp_left_by_an_older_sign_out_is_dropped(self):
        token, gone = self.sign_in(), self.sign_in()
        self.rewrite(lambda data: data["sessions"].remove(digest_of(gone)))
        self.assertTrue(auth.has_session(token))
        self.assertEqual(list(self.saved()["used"]), [digest_of(token)])

    def test_older_code_still_finds_the_password_and_the_sign_ins(self):
        token = self.sign_in()
        self.clock = START + 2 * HOUR
        self.assertTrue(auth.has_session(token))
        data = self.saved()
        # what older code checks: version 1, a list of sign-ins with this one
        # in it, and the password's salt and scrypt hash
        self.assertEqual(data["version"], 1)
        self.assertIsInstance(data["sessions"], list)
        self.assertIn(digest_of(token), data["sessions"])
        candidate = hashlib.scrypt(PASS.encode("ascii"), salt=bytes.fromhex(data["salt"]), n=2**14, r=8, p=1)
        self.assertEqual(candidate.hex(), data["password"])
        self.assertEqual(set(data), {"version", "salt", "password", "sessions", "used"})


if __name__ == "__main__":
    unittest.main()
