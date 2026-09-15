"""The two server rules this change adds to /park, and the one it keeps.

  order    a page names its own command stream and its place in it, and a place
           that stream has already passed on that card is refused. This is the
           rule a page cannot enforce for itself: abandoning an answer does not
           recall the request, so a snooze the page replaced can still arrive
           last. The place is remembered per card AND stream, so another page
           touching the same card cannot erase this page's own high water mark.
  message  the later-message protection: a snooze decided before one such
           message existed does not bury that message.
  as before an older caller that names neither is served exactly as it was.

The card, the messages, the stream names, the times and the revision below are
invented for the test. Nothing here touches the real board's state file: the
save is replaced with a stand-in that only moves the revision the way the real
one does, _notify and _log are replaced with nothing, and the board is seeded
by hand before every case.

    python3 -m unittest tests/test_park_basis.py

server.py is found by walking up from this file, or by FACILITATOR_SERVER
pointing straight at it. Apply changes.json before running this.
"""

import importlib.util
import os
import unittest
from pathlib import Path


def _find_server():
    named = os.environ.get("FACILITATOR_SERVER")
    if named:
        p = Path(named)
        return p if p.is_file() else None
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "server.py"
        if candidate.is_file():
            return candidate
    return None


def _load():
    """The module under test, with its writes to the world taken out."""
    path = _find_server()
    if path is None:
        raise AssertionError(
            "server.py was not found above this test. Point FACILITATOR_SERVER at it; "
            "these cases are a gate and are not meant to be skipped.")
    spec = importlib.util.spec_from_file_location("facilitator_server_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def save():
        # the one thing the real save does that this handler's answer reads: a
        # new revision for every saved change. Nothing is written to disk here
        module._state["rev"] = int(module._state.get("rev", 0)) + 1

    module._save = save
    module._notify = lambda *a, **k: None
    module._log = lambda *a, **k: None
    return module


class Q:
    """What _post_park reads of a query: one(name, default)."""

    def __init__(self, **values):
        self.values = {k: str(v) for k, v in values.items() if v is not None}

    def one(self, name, default=""):
        return self.values.get(name, default)


CARD = "fixture-card"
SEEDED_REV = 41


def _card(**over):
    card = {
        "id": CARD, "bucket": "meta", "title": "an invented card", "owner": "facilitator",
        "done": False, "parked": False, "replies": 0, "seen": 0, "pending": [],
        "ball": "you", "ts": 1000.0, "state": "yours",
    }
    card.update(over)
    return card


class ParkRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _load()
        for name in ("_post_park", "_park_order_read", "_park_order_keep", "_PARK_ORDER"):
            if not hasattr(cls.server, name):
                raise AssertionError(
                    "this server has no %s: apply changes.json to the source under test "
                    "before running these cases" % name)

    def setUp(self):
        self.box = _card()
        # the whole fixture board: the boxes the handler looks the card up in,
        # and the revision its answer names
        self.server._state["boxes"] = [self.box]
        self.server._state["rev"] = SEEDED_REV
        self.server._PARK_ORDER.clear()
        self.keys = set(self.box)
        if self.server._box(CARD) is not self.box:
            raise AssertionError(
                "_box did not return the seeded card, so it does not read _state['boxes'] "
                "directly in this source. Seed the board the way the repo's own server "
                "tests do and keep every case below.")

    def park(self, **q):
        return self.server._post_park(Q(box=CARD, **q), "")

    # ---- as before -----------------------------------------------------------
    def test_park_without_an_order_or_a_basis_is_what_it_always_was(self):
        status, answer = self.park(v=1)
        self.assertEqual(status, 200)
        self.assertTrue(answer["ok"])
        self.assertTrue(self.box["parked"])

    def test_park_clears_done_as_before(self):
        self.box["done"] = True
        self.park(v=1)
        self.assertTrue(self.box["parked"])
        self.assertFalse(self.box["done"], "parking a done card still takes the done off it")

    def test_the_answer_names_the_state_it_leaves_and_the_new_revision(self):
        status, answer = self.park(v=1)
        self.assertEqual(answer["rev"], SEEDED_REV + 1, "an applied park is a new revision")
        self.assertTrue(answer["parked"])
        self.assertFalse(answer["done"])

    # ---- the later message protection ---------------------------------------
    def test_a_message_older_than_the_tap_does_not_stop_a_snooze(self):
        self.box["pending"].append({"mid": 1, "text": "earlier", "ts": 900.0})
        status, answer = self.park(v=1, after=950.0)
        self.assertTrue(answer["ok"])
        self.assertTrue(self.box["parked"])

    def test_a_message_newer_than_the_tap_keeps_the_card_open(self):
        self.box["pending"].append({"mid": 1, "text": "one more thing", "ts": 1200.0})
        status, answer = self.park(v=1, after=1100.0)
        self.assertEqual(status, 200, "this is not an error: the board is fine and said no")
        self.assertFalse(answer["ok"])
        self.assertEqual(answer["stale"], "message")
        self.assertFalse(answer["parked"], "and the answer names the state the card is really in")
        self.assertEqual(answer["rev"], SEEDED_REV, "nothing was written, so nothing moved")
        self.assertEqual(self.server._state["rev"], SEEDED_REV)
        self.assertFalse(self.box["parked"], "the card just written to is not snoozed")
        self.assertEqual(len(self.box["pending"]), 1, "and that message is untouched")

    def test_an_unpark_is_never_judged_by_the_basis(self):
        self.box["parked"] = True
        self.box["pending"].append({"mid": 1, "text": "one more thing", "ts": 1200.0})
        status, answer = self.park(v=0, after=1100.0)
        self.assertTrue(answer["ok"])
        self.assertFalse(self.box["parked"])

    def test_a_basis_that_is_not_a_number_is_no_basis(self):
        self.box["pending"].append({"mid": 1, "text": "one more thing", "ts": 1200.0})
        status, answer = self.park(v=1, after="soon")
        self.assertTrue(answer["ok"], "a page that sends nonsense is treated as one that sends nothing")
        self.assertTrue(self.box["parked"])

    # ---- the order of one page's own commands --------------------------------
    def test_the_snooze_a_page_gave_up_on_cannot_undo_the_unsnooze_that_replaced_it(self):
        self.box["parked"] = True
        # place 2, the unsnooze that replaced the snooze, arrives first
        status, answer = self.park(v=0, sid="pageone", seq=2)
        self.assertTrue(answer["ok"])
        self.assertFalse(self.box["parked"])
        # place 1, the snooze the page gave up on, arrives last
        status, answer = self.park(v=1, sid="pageone", seq=1)
        self.assertEqual(status, 200)
        self.assertFalse(answer["ok"])
        self.assertEqual(answer["stale"], "superseded")
        self.assertFalse(answer["parked"])
        self.assertEqual(answer["rev"], SEEDED_REV + 1, "the refusal wrote nothing of its own")
        self.assertFalse(self.box["parked"], "the board finishes where the last tap asked")

    def test_the_same_place_twice_is_not_newer(self):
        self.park(v=1, sid="pageone", seq=5)
        status, answer = self.park(v=0, sid="pageone", seq=5)
        self.assertEqual(answer["stale"], "superseded")
        self.assertTrue(self.box["parked"])

    def test_a_rising_place_in_the_same_stream_applies(self):
        self.park(v=1, sid="pageone", seq=5)
        status, answer = self.park(v=0, sid="pageone", seq=6)
        self.assertTrue(answer["ok"])
        self.assertFalse(self.box["parked"])

    def test_another_page_is_not_ordered_against_this_one(self):
        self.park(v=0, sid="pageone", seq=9)
        status, answer = self.park(v=1, sid="pagetwo", seq=1)
        self.assertTrue(answer["ok"], "two devices stay last writer wins, exactly as they were")
        self.assertTrue(self.box["parked"])

    def test_another_page_does_not_erase_this_page_s_own_place(self):
        # the three commands that a single place per card gets wrong
        self.box["parked"] = True
        status, answer = self.park(v=0, sid="pagea", seq=2)   # A's newer intent
        self.assertTrue(answer["ok"])
        self.assertFalse(self.box["parked"])
        status, answer = self.park(v=0, sid="pageb", seq=1)   # B's first command
        self.assertTrue(answer["ok"], "B has replaced nothing of its own, so B is applied")
        self.assertFalse(self.box["parked"])
        status, answer = self.park(v=1, sid="pagea", seq=1)   # A's abandoned snooze, last
        self.assertEqual(status, 200)
        self.assertFalse(answer["ok"])
        self.assertEqual(answer["stale"], "superseded",
                         "A's own place 2 still stands, whatever B has done since")
        self.assertFalse(self.box["parked"], "and the card is left unsnoozed")

    def test_two_streams_on_one_card_are_both_remembered(self):
        self.park(v=1, sid="pagea", seq=5)
        self.park(v=0, sid="pageb", seq=1)
        self.assertEqual(self.server._PARK_ORDER[(CARD, "pagea")]["seq"], 5)
        self.assertEqual(self.server._PARK_ORDER[(CARD, "pageb")]["seq"], 1)
        self.assertEqual(self.park(v=1, sid="pagea", seq=4)[1]["stale"], "superseded")
        self.assertEqual(self.park(v=1, sid="pageb", seq=2)[1]["ok"], True)

    def test_a_place_is_remembered_per_card(self):
        self.server._state["boxes"].append(_card(id="second-card"))
        self.park(v=1, sid="pageone", seq=7)
        status, answer = self.server._post_park(
            Q(box="second-card", v="1", sid="pageone", seq="3"), "")
        self.assertTrue(answer["ok"], "one card's places say nothing about another's")

    def test_a_place_is_taken_even_by_a_command_the_message_rule_refuses(self):
        self.box["pending"].append({"mid": 1, "text": "one more thing", "ts": 1200.0})
        status, answer = self.park(v=1, sid="pageone", seq=4, after=1100.0)
        self.assertEqual(answer["stale"], "message")
        status, answer = self.park(v=1, sid="pageone", seq=4, after=1100.0)
        self.assertEqual(answer["stale"], "superseded",
                         "the stream reached the board, so its earlier places are old")

    def test_half_an_order_or_a_place_that_is_not_a_number_is_refused(self):
        self.assertEqual(self.park(v=1, sid="pageone")[0], 400)
        self.assertEqual(self.park(v=1, seq=3)[0], 400)
        self.assertEqual(self.park(v=1, sid="pageone", seq="later")[0], 400)
        self.assertEqual(self.park(v=1, sid="pageone", seq=-1)[0], 400)
        self.assertFalse(self.box["parked"], "and none of them changed the card")

    def test_a_stream_name_outside_the_limits_is_refused(self):
        self.assertEqual(self.park(v=1, sid="x" * (self.server._PARK_ID_MAX + 1), seq=1)[0], 400)
        self.assertEqual(self.park(v=1, sid="page one", seq=1)[0], 400)
        self.assertEqual(self.park(v=1, sid="page/one", seq=1)[0], 400)
        self.assertFalse(self.box["parked"])
        self.assertEqual(self.park(v=1, sid="x" * self.server._PARK_ID_MAX, seq=1)[0], 200,
                         "a name at the limit is still a name")

    def test_the_record_stays_off_the_board_and_out_of_the_card(self):
        self.park(v=1, sid="pageone", seq=1)
        self.assertEqual(set(self.box), self.keys, "no page's name is written onto a card")
        self.assertNotIn("park_order", self.server._state, "and none of it is saved with the board")
        self.assertEqual(self.server._PARK_ORDER[(CARD, "pageone")]["seq"], 1)

    def test_the_record_is_bounded_by_age_and_by_count(self):
        keep = self.server._park_order_keep
        now = 10_000.0
        keep("old-card", "pageone", 1, now - self.server._PARK_ORDER_TTL - 1)
        keep("new-card", "pageone", 1, now)
        self.assertNotIn(("old-card", "pageone"), self.server._PARK_ORDER,
                         "places are forgotten on age")
        for i in range(self.server._PARK_ORDER_MAX + 20):
            keep("card-%d" % i, "pageone", 1, now + i)
        self.assertLessEqual(len(self.server._PARK_ORDER), self.server._PARK_ORDER_MAX,
                             "and the record cannot grow without a limit")

    def test_a_forgotten_place_simply_orders_nothing(self):
        keep = self.server._park_order_keep
        now = 10_000.0
        keep(CARD, "pageone", 9, now - self.server._PARK_ORDER_TTL - 1)
        keep("other-card", "pageone", 1, now)   # any command at all sweeps the old pairs
        status, answer = self.park(v=1, sid="pageone", seq=1)
        self.assertTrue(answer["ok"], "a pair the board has forgotten judges nothing at all")
        self.assertTrue(self.box["parked"])

    def test_a_card_that_is_gone_is_still_a_bad_box(self):
        self.server._state["boxes"] = []
        status, answer = self.park(v=1, sid="pageone", seq=1, after=1100.0)
        self.assertEqual(status, 400)
        self.assertIn("error", answer)


if __name__ == "__main__":
    unittest.main()
