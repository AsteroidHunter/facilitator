"""The server's side of the Omni entry rule, held to the same table the page's
side is (tests/fixtures/omni-entry-cases.json, also read by
tests/omni-card-motion.test.cjs), so the two can never read a title two ways.

  entry      a typed title asks for an Omni ticket only when its first line,
             cut at 80 characters, is exactly one of the accepted word sets
  numbering  an accepted title becomes the lane's highest canonical number
             plus one, whatever number was typed with it
  identity   only the canonical "Omni Ticket #N" is an Omni ticket

server.py is loaded, never run: no socket, no state file. Its log handler is
pointed at a temporary folder for the length of the test.

    python3 -m unittest tests/test_omni_entry.py
"""

import importlib.util
import json
import logging
import os
import re
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = json.loads((HERE / "fixtures" / "omni-entry-cases.json").read_text())


def _decode(text):
    """<U+XXXX> is that character and <pad:N> is N spaces, as in the table."""
    text = re.sub(r"<U\+([0-9A-F]{4,6})>", lambda m: chr(int(m.group(1), 16)), text)
    return re.sub(r"<pad:(\d+)>", lambda m: " " * int(m.group(1)), text)


def setUpModule():
    global server, _logs
    _logs = tempfile.TemporaryDirectory()
    os.environ["FACILITATOR_LOG_DIR"] = _logs.name
    spec = importlib.util.spec_from_file_location("facilitator_server_omni", HERE.parent / "server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)


def tearDownModule():
    for name in ("facilitator", "facilitator.client"):
        for handler in list(logging.getLogger(name).handlers):
            handler.close()
            logging.getLogger(name).removeHandler(handler)
    os.environ.pop("FACILITATOR_LOG_DIR", None)
    _logs.cleanup()


class OmniEntry(unittest.TestCase):
    def test_every_accepted_form_asks(self):
        for raw in CASES["accept"]:
            with self.subTest(title=raw):
                self.assertTrue(server._omni_entry(_decode(raw)))

    def test_every_other_title_does_not(self):
        for raw in CASES["reject"]:
            with self.subTest(title=raw):
                self.assertFalse(server._omni_entry(_decode(raw)))

    def test_only_the_canonical_title_is_an_omni_ticket(self):
        for raw, number in CASES["canonical"]:
            with self.subTest(title=raw):
                self.assertEqual(server._omni_number(_decode(raw)), number)


class OmniNumbering(unittest.TestCase):
    def setUp(self):
        server._state = {"boxes": [
            {"id": "m1", "owner": "facilitator", "title": "Omni Ticket #1"},
            {"id": "m2", "owner": "facilitator", "title": "Omni Ticket #2"},
            {"id": "m3", "owner": "other", "title": "Omni Ticket #5"},
            {"id": "m4", "owner": "facilitator", "title": "ticket omni"},   # stored before the rule: not Omni
            {"id": "m5", "owner": "facilitator", "title": "Omni Ticket #01"},
        ]}

    def test_an_accepted_title_takes_the_lanes_next_number(self):
        for typed in ("omni", "ticket omni", "Omni Card", "omni card #3"):
            with self.subTest(typed=typed):
                self.assertEqual(server._entered_title("facilitator", typed), "Omni Ticket #3")
        self.assertEqual(server._entered_title("other", "omni ticket"), "Omni Ticket #6")
        self.assertEqual(server._entered_title("empty", "omni"), "Omni Ticket #1")

    def test_a_typed_number_is_not_honoured(self):
        for typed in ("omni ticket #9", "omni card 1", "Omni Ticket #2", "omni ticket #3"):
            with self.subTest(typed=typed):
                self.assertEqual(server._entered_title("facilitator", typed), "Omni Ticket #3")

    def test_anything_else_is_kept_as_typed(self):
        for typed in ("omni ticket please", "omni 3", "omnibus", "Omni Ticket #01", "Omni Card #3 notes"):
            with self.subTest(typed=typed):
                self.assertEqual(server._entered_title("facilitator", typed), typed)
        # the stored title is still the first line cut at 80, as it always was
        self.assertEqual(server._entered_title("facilitator", "Fix login\nmore"), "Fix login")
        self.assertEqual(server._entered_title("facilitator", "x" * 90), "x" * 80)


if __name__ == "__main__":
    unittest.main()
