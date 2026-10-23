"""The search index (card_search.py) on made-up boards: cards and transcript
rows written here, never a real board's.

What is proved:

  building   a first pass indexes every card's title and every message, each
             message read once even when its row was written twice, and
             only the rows the same reading of the board covers.
  current    a new message, a renamed card, a card moved to the Bin and back
             and a card deleted for good are each searched as the board now
             has them after the next pass; a half-written last row waits; a
             transcript replaced under the index is read again.
  keyword    words and phrases, all of them in one chunk with the title
             counting, else any; a prefix only when asked; snippets with
             their matched words marked; the plain scan where FTS5 is
             missing.
  filters    lane, section, the Bin only when named, and a date range on
             when cards were made, last changed, or on the messages' own
             times; a search with no words lists cards by the filters; a bad
             request is refused without repeating what it asked.
  semantic   the prefixes reach the model, vectors are cut and made unit
             length, a rename embeds again, a deletion drops the vectors,
             another model embeds everything again, and the hybrid merge
             finds by meaning what the words miss (with the fake model).
  no model   with the model or its packages missing, or a model that does not
             answer, search runs by keyword and says why; a config that cannot
             be used is refused with its reason.
  backends   Ollama and an OpenAI-style server are asked the documented way
             at a loopback address only; sentence-transformers is loaded text
             only, from local files, in float32 or bfloat16.
  the file   made private, made again when missing, unreadable or of another
             layout, and the log never carries a word of a card or a query.
  scale      a first build of 1,000 cards and 30,000 messages.

The semantic cases need numpy and are skipped without it, which is the board's
own Python as installed: run there, the rest prove the keyword board.

    python3 -m unittest tests/test_card_search.py

card_search.py is found beside server.py by walking up from this file.
"""

import http.server
import importlib.util
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock


def _find_module():
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "card_search.py"
        if candidate.is_file():
            return candidate
    raise AssertionError("card_search.py was not found above this test")


def _load():
    spec = importlib.util.spec_from_file_location("card_search_under_test", _find_module())
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = _load()
try:
    import numpy
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
needs_numpy = unittest.skipUnless(HAS_NUMPY, "numpy is not installed in this Python")


def day(year, month, date, hour=12):
    """A moment on a day, in this Mac's own time zone, as the filters read days."""
    return datetime(year, month, date, hour).timestamp()


class Board:
    """A made-up board: its cards as the server's reader answers them, and a
    transcript rows are appended to, one JSON object a line."""

    def __init__(self, folder: Path):
        self.transcript = folder / "transcript.jsonl"
        self.transcript.write_text("")
        self.cards = {}
        self.reads = 0
        self.held_size = None   # a size to answer instead of the file's, for the race case

    def card(self, cid, title, lane="facilitator", section="doing", ts=None, stamp=0.0):
        self.cards[cid] = {"id": cid, "title": title, "lane": lane, "section": section,
                           "ts": ts if ts is not None else day(2026, 9, 1), "stamp": stamp}

    def row(self, kind, box, text="", ts=None, end="\n", **fields):
        event = {"ts": ts if ts is not None else day(2026, 9, 1), "kind": kind, "box": box, "text": text}
        event.update(fields)
        with self.transcript.open("a") as f:
            f.write(json.dumps(event) + end)

    def read(self):
        self.reads += 1
        size = self.transcript.stat().st_size if self.held_size is None else self.held_size
        return [dict(card) for card in self.cards.values()], size


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.board = Board(self.dir)
        self.lines = []
        self.indexes = []

    def tearDown(self):
        for index in self.indexes:
            if index._db is not None:
                index._db.close()
        self.tmp.cleanup()

    def log(self, kind, **fields):
        self.lines.append((kind, fields))

    def index(self, **options):
        index = S.Index(self.dir / "search-index.sqlite", self.board.transcript, self.board.read,
                        log=self.log, **options)
        index.open()
        self.indexes.append(index)
        return index

    def find(self, index, q="", **params):
        args = {"q": [q]} if q else {}
        args.update({name: [str(value)] for name, value in params.items()})
        status, answer = index.search(args)
        self.assertEqual(status, 200, answer)
        return answer

    def ids(self, answer):
        return [result["card"] for result in answer["results"]]


class Building(Case):
    def test_first_pass_indexes_titles_and_messages(self):
        b = self.board
        b.card("m1", "Natural-language card search")
        b.card("m2", "Kitchen shelves", lane="home")
        b.row("create", "m1", "Natural-language card search", ts=day(2026, 9, 2))
        b.row("user", "m1", "Could the search use the new gemma model?", ts=day(2026, 9, 3))
        b.row("agent", "m1", "Yes: a local embedding model ranks by meaning.", ts=day(2026, 9, 4))
        b.row("user", "m2", "Measure the alcove before buying brackets", ts=day(2026, 9, 5))
        index = self.index()
        done = index.catch_up()
        self.assertEqual(done, {"cards": 2, "renamed": 0, "gone": 0, "messages": 3})
        status = index.status()
        self.assertEqual((status["cards"], status["messages"], status["chunks"]), (2, 3, 5))
        self.assertTrue(status["ready"])
        self.assertEqual(status["keyword"], "fts5" if S._has_fts5() else "like")

        answer = self.find(index, "gemma")
        self.assertEqual(answer["mode"], "keyword")
        self.assertEqual(self.ids(answer), ["m1"])
        hit = answer["results"][0]
        self.assertEqual({k: hit[k] for k in ("card", "title", "lane", "section")},
                         {"card": "m1", "title": "Natural-language card search",
                          "lane": "facilitator", "section": "doing"})
        # made when its first row was written, changed with its last
        self.assertEqual(hit["created"], day(2026, 9, 1))   # the box's first sight is earlier still
        self.assertEqual(hit["changed"], day(2026, 9, 4))
        self.assertEqual(hit["match"]["kind"], "user")
        self.assertEqual(hit["match"]["ts"], day(2026, 9, 3))
        self.assertGreater(hit["score"], 0)
        self.assertEqual(hit["mode"], "keyword")
        snippet, marks = hit["match"]["snippet"], hit["match"]["marks"]
        self.assertIn("gemma", snippet)
        self.assertEqual([snippet[a:z] for a, z in marks], ["gemma"])

    def test_created_is_the_first_row_when_the_box_was_seen_later(self):
        b = self.board
        b.card("m7", "Seen late", ts=day(2026, 10, 1))
        b.row("create", "m7", "Seen late", ts=day(2026, 8, 20))
        index = self.index()
        index.catch_up()
        self.assertEqual(self.find(index)["results"][0]["created"], day(2026, 8, 20))

    def test_a_row_written_twice_under_one_operation_is_one_message(self):
        b = self.board
        b.card("m1", "Retries")
        b.row("user", "m1", "the retried words", op="op-12345678")
        b.row("user", "m1", "the retried words", op="op-12345678")
        b.row("user", "m1", "said twice without an id")
        b.row("user", "m1", "said twice without an id")
        index = self.index()
        index.catch_up()
        self.assertEqual(index.status()["messages"], 3)

    def test_rows_past_the_reading_wait_for_the_next_pass(self):
        b = self.board
        b.card("m1", "Race")
        b.row("user", "m1", "before the reading")
        b.held_size = b.transcript.stat().st_size
        b.row("user", "m1", "after the reading")
        index = self.index()
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, "before")), ["m1"])
        self.assertEqual(self.find(index, "after")["results"], [])
        b.held_size = None
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, "after")), ["m1"])

    def test_a_half_written_last_row_waits_until_it_is_whole(self):
        b = self.board
        b.card("m1", "Half")
        b.row("user", "m1", "whole row")
        with b.transcript.open("a") as f:
            f.write('{"ts": 1, "kind": "user", "box": "m1", "text": "unfinish')
        index = self.index()
        index.catch_up()
        self.assertEqual(index.status()["messages"], 1)
        with b.transcript.open("a") as f:
            f.write('ed words"}\n')
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, "unfinished")), ["m1"])

    def test_rows_of_cards_deleted_long_ago_are_passed_over(self):
        b = self.board
        b.card("m2", "Still here")
        b.row("user", "m1", "a card that is gone")
        b.row("user", "m2", "a card that is here")
        index = self.index()
        index.catch_up()
        self.assertEqual(index.status()["messages"], 1)
        self.assertEqual(self.find(index, "gone")["results"], [])

    def test_replies_are_read_by_the_boards_own_reader_and_marker(self):
        b = self.board
        b.card("m1", "Replies")
        b.row("agent", "m1", "legacy short --- legacy full")
        b.row("schema", "", schema="reply_variants", version=1)
        b.row("agent", "m1", "new text", reply_full="new full words")
        seen = []

        def row_text(event, legacy):
            seen.append(legacy)
            if "reply_full" in event:
                return event["reply_full"]
            return event["text"].split("---")[-1] if legacy else event["text"]

        index = self.index(row_text=row_text, is_boundary=lambda e: e.get("kind") == "schema")
        index.catch_up()
        self.assertEqual(seen, [True, False])
        self.assertEqual(self.ids(self.find(index, "legacy full")), ["m1"])
        self.assertEqual(self.ids(self.find(index, "full words")), ["m1"])
        self.assertEqual(self.find(index, "short")["results"], [])

    def test_a_long_message_is_cut_into_overlapping_chunks(self):
        words = " ".join(f"word{n}" for n in range(1000))
        pieces = S._pieces(words)
        self.assertGreater(len(pieces), 4)
        self.assertTrue(all(len(p) <= S.CHUNK_CHARS for p in pieces))
        for before, after in zip(pieces, pieces[1:]):
            self.assertIn(after.split()[0], before.split())   # each starts inside the one before
        self.assertEqual(pieces[-1].split()[-1], "word999")
        self.assertEqual(S._pieces("  short  "), ["short"])
        self.assertEqual(S._pieces("   "), [])

    def test_the_progress_and_note_kinds_are_messages_and_bookkeeping_is_not(self):
        b = self.board
        b.card("m1", "Kinds")
        for kind in ("user", "agent", "note", "progress", "ack", "fresh", "handover", "title"):
            b.row(kind, "m1", f"{kind}word")
        index = self.index()
        index.catch_up()
        for kind in ("user", "agent", "note", "progress"):
            self.assertEqual(self.find(index, f"{kind}word")["results"][0]["match"]["kind"], kind)
        for kind in ("ack", "fresh", "handover", "title"):
            self.assertEqual(self.find(index, f"{kind}word")["results"], [])


class Current(Case):
    def setUp(self):
        super().setUp()
        b = self.board
        b.card("m1", "Gutter repair")
        b.card("m2", "Holiday plans")
        b.row("user", "m1", "the downpipe leaks at the joint", ts=day(2026, 9, 2))
        b.row("user", "m2", "book the ferry in October", ts=day(2026, 9, 3))

    def test_a_new_message_is_found_after_the_next_pass(self):
        index = self.index()
        index.catch_up()
        self.assertEqual(self.find(index, "sealant")["results"], [])
        self.board.row("agent", "m1", "use a silicone sealant on the joint", ts=day(2026, 9, 9))
        self.assertEqual(index.catch_up()["messages"], 1)
        answer = self.find(index, "sealant")
        self.assertEqual(self.ids(answer), ["m1"])
        self.assertEqual(answer["results"][0]["changed"], day(2026, 9, 9))

    def test_a_renamed_card_is_found_by_its_new_title_only(self):
        index = self.index()
        index.catch_up()
        self.board.cards["m1"]["title"] = "Roof drainage"
        self.assertEqual(index.catch_up()["renamed"], 1)
        self.assertEqual(self.find(index, "gutter")["results"], [])
        answer = self.find(index, "drainage")
        self.assertEqual(self.ids(answer), ["m1"])
        self.assertEqual(answer["results"][0]["title"], "Roof drainage")
        self.assertEqual(answer["results"][0]["match"]["kind"], "title")
        # the title counts as part of each message: one word from each finds it
        self.assertEqual(self.ids(self.find(index, "drainage downpipe")), ["m1"])
        self.assertEqual(self.find(index, "drainage downpipe")["words"], "all")

    def test_a_card_given_an_empty_title_loses_its_title_chunk(self):
        index = self.index()
        index.catch_up()
        self.board.cards["m1"]["title"] = ""
        index.catch_up()
        self.assertEqual(self.find(index, "gutter")["results"], [])
        self.assertEqual(self.ids(self.find(index, "downpipe")), ["m1"])
        self.board.cards["m1"]["title"] = "Gutter again"
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, "gutter")), ["m1"])

    def test_a_card_deleted_for_good_goes_with_its_words(self):
        index = self.index()
        index.catch_up()
        del self.board.cards["m1"]
        self.assertEqual(index.catch_up()["gone"], 1)
        self.assertEqual(self.find(index, "downpipe")["results"], [])
        self.assertEqual(self.find(index, "downpipe", section="bin")["results"], [])
        self.assertEqual(index.status()["chunks"], 2)   # m2's title and message

    def test_a_card_in_the_bin_is_searched_only_when_asked_and_comes_back_whole(self):
        index = self.index()
        index.catch_up()
        self.board.cards["m1"].update(section="bin", stamp=day(2026, 9, 20))
        index.catch_up()
        self.assertEqual(self.find(index, "downpipe")["results"], [])
        binned = self.find(index, "downpipe", section="bin")
        self.assertEqual(self.ids(binned), ["m1"])
        self.assertEqual(binned["results"][0]["section"], "bin")
        self.assertEqual(binned["results"][0]["changed"], day(2026, 9, 20))
        self.board.cards["m1"].update(section="doing", stamp=0.0)
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, "downpipe")), ["m1"])
        self.assertEqual(index.status()["binned"], 0)

    def test_a_section_move_is_dated_and_filtered(self):
        index = self.index()
        index.catch_up()
        before = time.time()
        self.board.cards["m2"]["section"] = "docked"
        index.catch_up()
        moved = self.find(index, "ferry")["results"][0]
        self.assertEqual(moved["section"], "docked")
        self.assertGreaterEqual(moved["changed"], before)
        self.assertEqual(self.find(index, "ferry", section="doing")["results"], [])

    def test_a_replaced_transcript_is_read_again(self):
        index = self.index()
        index.catch_up()
        self.board.transcript.write_text(json.dumps(
            {"ts": day(2026, 9, 5), "kind": "user", "box": "m2", "text": "a whole new file"}) + "\n")
        index.catch_up()
        self.assertEqual(self.find(index, "downpipe")["results"], [])
        self.assertEqual(self.ids(self.find(index, "whole new file")), ["m2"])
        self.assertIn(("searchindex", {"step": "reread"}), self.lines)

    def test_a_transcript_with_the_same_length_and_other_words_is_read_again(self):
        index = self.index()
        index.catch_up()
        text = self.board.transcript.read_text()
        self.board.transcript.write_text(text.replace("downpipe", "drainpip"))
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, "drainpip")), ["m1"])
        self.assertEqual(self.find(index, "downpipe")["results"], [])

    def test_a_new_index_on_an_old_board_starts_from_the_whole_transcript(self):
        first = self.index()
        first.catch_up()
        first._db.close()
        first._db = None
        (self.dir / "search-index.sqlite").unlink()
        second = self.index()
        self.assertEqual(second.catch_up()["messages"], 2)


class Keyword(Case):
    def setUp(self):
        super().setUp()
        b = self.board
        b.card("m1", "Searching the board")
        b.card("m2", "Card tray")
        b.card("m3", "Garden")
        b.row("user", "m1", "the searches should rank by meaning")
        b.row("user", "m2", "a carrier for the cards")
        b.row("user", "m3", "plant the tulip bulbs before the frost")

    def test_words_are_stemmed_and_ranked(self):
        index = self.index()
        index.catch_up()
        if not index._fts:
            self.skipTest("this SQLite has no FTS5")
        self.assertEqual(self.ids(self.find(index, "search")), ["m1"])   # searching, searches

    def test_every_word_first_then_any(self):
        index = self.index()
        index.catch_up()
        answer = self.find(index, "tulip carrier")
        self.assertEqual(answer["words"], "any")
        self.assertEqual(sorted(self.ids(answer)), ["m2", "m3"])
        answer = self.find(index, "tulip frost")
        self.assertEqual((answer["words"], self.ids(answer)), ("all", ["m3"]))

    def test_a_quoted_phrase_is_kept_whole(self):
        index = self.index()
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, '"tulip bulbs"')), ["m3"])
        self.assertEqual(self.find(index, '"bulbs tulip"', mode="keyword")["results"], [])

    def test_a_prefix_only_when_asked(self):
        index = self.index()
        index.catch_up()
        self.assertEqual(self.find(index, "tuli")["results"], [])
        self.assertEqual(self.ids(self.find(index, "tuli", prefix=1)), ["m3"])

    def test_fts5_syntax_typed_by_a_person_is_only_words(self):
        index = self.index()
        index.catch_up()
        for typed in ('tulip OR', 'NEAR(tulip', 'tulip*', '"tulip', 'tulip AND -frost', "col:tulip"):
            self.assertEqual(self.ids(self.find(index, typed)), ["m3"], typed)
        self.assertEqual(self.find(index, "!!! ???")["mode"], "filter")

    def test_the_plain_scan_where_fts5_is_missing(self):
        index = self.index(fts5=False)
        index.catch_up()
        self.assertEqual(index.status()["keyword"], "like")
        answer = self.find(index, "TULIP")
        self.assertEqual(self.ids(answer), ["m3"])
        snippet, marks = answer["results"][0]["match"]["snippet"], answer["results"][0]["match"]["marks"]
        self.assertEqual([snippet[a:z] for a, z in marks], ["tulip"])
        self.assertEqual(sorted(self.ids(self.find(index, "tulip carrier"))), ["m2", "m3"])
        self.assertEqual(self.ids(self.find(index, "card tray")), ["m2"])

    def test_an_index_made_without_fts5_is_made_again_where_it_is(self):
        if not S._has_fts5():
            self.skipTest("this SQLite has no FTS5")
        plain = self.index(fts5=False)
        plain.catch_up()
        plain._db.close()
        plain._db = None
        index = self.index()
        self.assertEqual(index.status()["keyword"], "fts5")
        self.assertIn(("searchindex", {"step": "rebuild"}), self.lines)
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, "tulip")), ["m3"])

    def test_a_snippet_marks_its_words_and_skips_to_them(self):
        b = self.board
        b.card("m4", "Long")
        b.row("user", "m4", " ".join(["filler"] * 200) + " the needle is here " + " ".join(["filler"] * 50))
        index = self.index()
        index.catch_up()
        match = self.find(index, "needle")["results"][0]["match"]
        self.assertTrue(match["snippet"].startswith("…"))
        self.assertEqual([match["snippet"][a:z] for a, z in match["marks"]], ["needle"])


class Filters(Case):
    def setUp(self):
        super().setUp()
        b = self.board
        b.card("m1", "Early doing", ts=day(2026, 9, 5))
        b.card("m2", "Middle done", lane="pastures", section="done", ts=day(2026, 9, 20))
        b.card("m3", "Late docked", section="docked", ts=day(2026, 10, 2))
        b.card("m4", "Binned one", section="bin", ts=day(2026, 9, 10))
        b.row("user", "m1", "budget for the fence", ts=day(2026, 9, 5))
        b.row("user", "m1", "fence posts arrived", ts=day(2026, 10, 10))
        b.row("user", "m2", "fence painted", ts=day(2026, 9, 21))
        b.row("user", "m3", "fence gate hinge", ts=day(2026, 10, 3))
        b.row("user", "m4", "fence in the bin", ts=day(2026, 9, 11))
        self.ix = self.index()
        self.ix.catch_up()

    def test_no_words_lists_cards_newest_first(self):
        answer = self.find(self.ix)
        self.assertEqual(answer["mode"], "filter")
        self.assertEqual(self.ids(answer), ["m3", "m2", "m1"])
        self.assertEqual(answer["total"], 3)
        self.assertIsNone(answer["results"][0]["match"])
        self.assertIsNone(answer["results"][0]["score"])

    def test_cards_made_in_a_date_range(self):
        answer = self.find(self.ix, **{"from": "2026-09-01", "to": "2026-09-30"})
        self.assertEqual(self.ids(answer), ["m2", "m1"])
        answer = self.find(self.ix, **{"from": "2026-09-20", "to": "2026-09-20"})
        self.assertEqual(self.ids(answer), ["m2"])   # the whole of the last day counts
        answer = self.find(self.ix, **{"to": str(day(2026, 9, 19))})
        self.assertEqual(self.ids(answer), ["m1"])
        answer = self.find(self.ix, **{"from": "2026-10-01T00:00:00"})
        self.assertEqual(self.ids(answer), ["m3"])

    def test_cards_changed_in_a_date_range(self):
        answer = self.find(self.ix, date="changed", **{"from": "2026-10-01"})
        self.assertEqual(self.ids(answer), ["m3", "m1"])
        answer = self.find(self.ix, date="changed", sort="changed", **{"from": "2026-10-01"})
        self.assertEqual(self.ids(answer), ["m1", "m3"])

    def test_messages_in_a_date_range(self):
        answer = self.find(self.ix, date="message", **{"from": "2026-10-01", "to": "2026-10-31"})
        self.assertEqual(sorted(self.ids(answer)), ["m1", "m3"])
        latest = {r["card"]: r["match"] for r in answer["results"]}
        self.assertEqual(latest["m1"]["ts"], day(2026, 10, 10))
        self.assertIn("posts", latest["m1"]["snippet"])
        answer = self.find(self.ix, "fence", date="message", **{"from": "2026-10-01"})
        self.assertEqual(sorted(self.ids(answer)), ["m1", "m3"])
        self.assertEqual({r["match"]["ts"] >= day(2026, 10, 1, 0) for r in answer["results"]}, {True})

    def test_lane_and_section(self):
        self.assertEqual(self.ids(self.find(self.ix, "fence", lane="pastures")), ["m2"])
        self.assertEqual(self.ids(self.find(self.ix, lane="pastures,facilitator")), ["m3", "m2", "m1"])
        self.assertEqual(self.ids(self.find(self.ix, "fence", section="done")), ["m2"])
        self.assertEqual(sorted(self.ids(self.find(self.ix, "fence", section="doing,docked"))), ["m1", "m3"])
        self.assertEqual(self.ids(self.find(self.ix, "fence", section="bin")), ["m4"])
        self.assertNotIn("m4", self.ids(self.find(self.ix, "fence")))

    def test_words_sorted_by_date(self):
        answer = self.find(self.ix, "fence", sort="created")
        self.assertEqual(self.ids(answer), ["m3", "m2", "m1"])

    def test_paging(self):
        first = self.find(self.ix, limit=2)
        second = self.find(self.ix, limit=2, offset=2)
        self.assertEqual((self.ids(first), self.ids(second)), (["m3", "m2"], ["m1"]))
        self.assertEqual((first["total"], first["limit"], second["offset"]), (3, 2, 2))

    def test_bad_requests_are_refused_without_repeating_them(self):
        secret = "zebra-secret-words"
        for args, words in (({"section": [secret]}, "section is"), ({"mode": [secret]}, "mode is"),
                            ({"date": [secret]}, "date is"), ({"from": [secret]}, "from and to"),
                            ({"to": ["nan"]}, "from and to"), ({"limit": ["0"]}, "limit is from"),
                            ({"limit": [secret]}, "limit is a whole"), ({"offset": ["999"]}, "offset is"),
                            ({"sort": [secret]}, "sort is"), ({"prefix": [secret]}, "prefix is"),
                            ({"lane": ["x" * 65]}, "a lane is"), ({"q": ["x" * 501]}, "a query is"),
                            ({"from": ["2026-10-02"], "to": ["2026-10-01"]}, "from is after to")):
            status, answer = self.ix.search(args)
            self.assertEqual(status, 400, args)
            self.assertIn(words, answer["error"])
            self.assertNotIn(secret, answer["error"])


class Fusion(unittest.TestCase):
    def test_reciprocal_rank_fusion(self):
        keyword = [("a", 1, 9.0), ("b", 2, 8.0)]
        semantic = [("b", 3, 0.9), ("c", 4, 0.8)]
        fused = S._fuse(keyword, semantic)
        self.assertEqual([e["card"] for e in fused], ["b", "a", "c"])
        b, a, c = fused
        self.assertAlmostEqual(b["score"], 1 / 62 + 1 / 61)
        self.assertAlmostEqual(a["score"], 1 / 61)
        self.assertAlmostEqual(c["score"], 1 / 62)
        self.assertEqual((b["keyword"], b["semantic"], b["chunk"], b["from"]), (2, 1, 3, "semantic"))
        self.assertEqual((a["chunk"], a["from"], a["similarity"]), (1, "keyword", None))
        self.assertEqual((c["chunk"], c["from"], c["similarity"]), (4, "semantic", 0.8))

    def test_a_tie_keeps_the_keyword_chunk(self):
        fused = S._fuse([("a", 1, 3.0)], [("a", 2, 0.5)])
        self.assertEqual((fused[0]["chunk"], fused[0]["from"]), (1, "keyword"))

    def test_one_half_keeps_its_own_order_and_score(self):
        fused = S._fuse([("a", 1, 3.0), ("b", 2, 1.0)], None)
        self.assertEqual([(e["card"], e["score"], e["keyword"]) for e in fused], [("a", 3.0, 1), ("b", 1.0, 2)])
        fused = S._fuse(None, [("c", 5, 0.7)])
        self.assertEqual((fused[0]["similarity"], fused[0]["semantic"], fused[0]["from"]), (0.7, 1, "semantic"))
        self.assertEqual(S._fuse(None, None), [])


@needs_numpy
class Semantic(Case):
    def setUp(self):
        super().setUp()
        b = self.board
        b.card("m1", "Weekend errands")
        b.card("m2", "Insurance")
        b.card("m3", "Office")
        b.row("user", "m1", "my car broke down on the motorway", ts=day(2026, 9, 2))
        b.row("user", "m2", "renew the automobile cover before it lapses", ts=day(2026, 9, 3))
        b.row("user", "m3", "order more printer paper", ts=day(2026, 9, 4))
        self.fake = S.FakeEmbedder(dims=1024)   # wide, so unrelated words stay far apart
        self.ix = self.index(embedder=self.fake)
        self.ix.catch_up()
        self.ix._load_model()
        self.assertEqual(self.ix._model_state, "ready")
        self.ix.embed_pending()

    def test_the_prefixes_reach_the_model(self):
        seen = list(self.fake.seen)
        self.assertIn("title: Weekend errands | text: my car broke down on the motorway", seen)
        self.assertIn("title: none | text: Weekend errands", seen)
        self.find(self.ix, "vehicle trouble")
        self.assertEqual(self.fake.seen[-1], "task: search result | query: vehicle trouble")

    def test_meaning_finds_what_the_words_miss(self):
        words = self.find(self.ix, "automobile", mode="keyword")
        self.assertEqual(self.ids(words), ["m2"])
        hybrid = self.find(self.ix, "automobile")
        self.assertEqual(hybrid["mode"], "hybrid")
        self.assertEqual(self.ids(hybrid)[:2], ["m2", "m1"])
        first, second = hybrid["results"][:2]
        self.assertEqual((first["mode"], second["mode"]), ("hybrid", "semantic"))
        self.assertEqual(first["ranks"]["keyword"], 1)
        self.assertIn(first["ranks"]["semantic"], (1, 2))
        self.assertIsNone(second["ranks"]["keyword"])
        self.assertGreater(second["similarity"], 0)
        self.assertIn("car", second["match"]["snippet"])
        semantic = self.find(self.ix, "automobile", mode="semantic")
        self.assertEqual(semantic["mode"], "semantic")
        self.assertEqual(sorted(self.ids(semantic)[:2]), ["m1", "m2"])
        self.assertLess(semantic["results"][2]["similarity"], semantic["results"][1]["similarity"])
        self.assertEqual(self.find(self.ix, "automobile")["index"]["semantic"], "ready")

    def test_filters_hold_in_the_semantic_half(self):
        self.board.cards["m1"]["lane"] = "errands"
        self.ix.catch_up()
        answer = self.find(self.ix, "automobile", mode="semantic", lane="facilitator")
        self.assertNotIn("m1", self.ids(answer))
        answer = self.find(self.ix, "car", mode="semantic", date="message",
                           **{"from": "2026-09-03", "to": "2026-09-03"})
        self.assertEqual(self.ids(answer), ["m2"])

    def test_vectors_are_stored_cut_and_unit_length(self):
        rows = self.ix._db.execute("SELECT vector FROM vectors").fetchall()
        self.assertEqual(len(rows), 6)
        for (blob,) in rows:
            vector = numpy.frombuffer(blob, numpy.float32)
            self.assertEqual(vector.shape, (1024,))
            self.assertAlmostEqual(float(numpy.linalg.norm(vector)), 1.0, places=5)
        self.assertEqual(self.ix.status()["semantic"]["embedded"], 6)
        self.assertEqual(self.ix.status()["semantic"]["waiting"], 0)

    def test_a_rename_embeds_the_cards_messages_again(self):
        self.fake.seen.clear()
        self.board.cards["m1"]["title"] = "Garage visit"
        self.ix.catch_up()
        self.assertEqual(self.ix.status()["semantic"]["waiting"], 2)   # its title and its message
        self.assertEqual(self.ix.embed_pending(), 2)
        self.assertIn("title: Garage visit | text: my car broke down on the motorway", self.fake.seen)
        self.assertIn("title: none | text: Garage visit", self.fake.seen)
        # the new vectors took the old ones' place
        self.assertEqual(self.ix._db.execute("SELECT count(*) FROM vectors").fetchone()[0], 6)
        self.assertEqual(self.ix._vectors.count(), 6)

    def test_a_new_message_is_embedded_and_found(self):
        self.board.row("note", "m3", "the truck delivers on Tuesday", ts=day(2026, 9, 6))
        self.ix.catch_up()
        self.assertEqual(self.ix.embed_pending(), 1)
        answer = self.find(self.ix, "vehicle", mode="semantic")
        self.assertIn("m3", self.ids(answer))

    def test_a_deleted_card_drops_its_vectors(self):
        self.assertEqual(self.ix._vectors.count(), 6)
        del self.board.cards["m1"]
        self.ix.catch_up()
        self.assertEqual(self.ix._vectors.count(), 4)
        self.assertEqual(self.ix._db.execute("SELECT count(*) FROM vectors").fetchone()[0], 4)
        self.assertNotIn("m1", self.ids(self.find(self.ix, "car", mode="semantic")))

    def test_another_model_embeds_everything_again(self):
        self.ix._db.close()
        self.ix._db = None
        other = self.index(embedder=S.FakeEmbedder(model="fake-two", dims=32))
        other._load_model()
        self.assertEqual(other.status()["semantic"]["waiting"], 6)
        self.assertEqual(other._vectors.count(), 0)
        self.assertEqual(other.embed_pending(), 6)
        same = self.index(embedder=S.FakeEmbedder(model="fake-two", dims=32))
        same._load_model()
        self.assertEqual((same._vectors.count(), same.status()["semantic"]["waiting"]), (6, 0))

    def test_a_partly_embedded_index_still_searches_by_both(self):
        self.board.card("m9", "Unembedded")
        self.board.row("user", "m9", "automobile parts list")
        self.ix.catch_up()
        answer = self.find(self.ix, "automobile")
        self.assertEqual(answer["mode"], "hybrid")
        self.assertIn("m9", self.ids(answer))   # by its words, before it has a vector
        self.assertEqual(answer["index"]["waiting"], 2)

    def test_a_model_that_stops_answering_falls_back_to_keyword(self):
        self.ix._queries.clear()
        with mock.patch.object(self.fake, "embed", side_effect=OSError("gone")):
            answer = self.find(self.ix, "automobile")
        self.assertEqual(answer["mode"], "keyword")
        self.assertIn("did not answer", answer["fallback"])
        self.assertEqual(self.ix.status()["semantic"]["state"], "unavailable")

    def test_a_busy_model_falls_back_to_keyword(self):
        self.ix._queries.clear()
        with mock.patch.object(S, "QUERY_WAIT", 0.05):
            with self.ix._model_lock:
                answer = self.find(self.ix, "automobile")
        self.assertEqual(answer["mode"], "keyword")
        self.assertIn("busy", answer["fallback"])
        self.assertEqual(self.ix._model_state, "ready")

    def test_a_second_page_does_not_ask_the_model_again(self):
        self.find(self.ix, "automobile")
        count = len(self.fake.seen)
        self.find(self.ix, "automobile", offset=1)
        self.assertEqual(len(self.fake.seen), count)


@needs_numpy
class Vectors(unittest.TestCase):
    def test_cut_and_unit_length(self):
        raw = numpy.random.default_rng(3).normal(size=(4, 768))
        unit = S._unit(numpy, raw, 512)
        self.assertEqual(unit.shape, (4, 512))
        self.assertTrue(numpy.allclose(numpy.linalg.norm(unit, axis=1), 1.0, atol=1e-5))
        self.assertTrue(numpy.allclose(unit[0], raw[0, :512] / numpy.linalg.norm(raw[0, :512]), atol=1e-6))

    def test_nan_and_wrong_shapes_are_refused(self):
        with self.assertRaisesRegex(ValueError, "not finite"):
            S._unit(numpy, [[float("nan")] * 8], 8)
        with self.assertRaisesRegex(ValueError, "wrong shape"):
            S._unit(numpy, [[1.0] * 4], 8)
        self.assertEqual(S._unit(numpy, [[0.0] * 8], 8).tolist(), [[0.0] * 8])

    def test_the_fake_model_keeps_unrelated_words_apart(self):
        # a thousand words that share nothing with the query, against one
        # filed under the same concept: the stand-in for meaning must not be
        # drowned by chance likeness, as a board of many words would show
        fake = S.FakeEmbedder(dims=256)
        query = S._unit(numpy, fake.embed([S.QUERY_PREFIX + "automobile"]), 256)[0]
        others = S._unit(numpy, fake.embed([f"word{n}" for n in range(1000)]), 256)
        self.assertLess(float(numpy.abs(others @ query).max()), 0.35)
        car = S._unit(numpy, fake.embed([S._document("Errands", "my car")]), 256)[0]
        self.assertGreater(float(car @ query), 0.5)

    def test_rows_are_replaced_dropped_and_packed(self):
        v = S.Vectors(numpy, 4)
        e = numpy.eye(4, dtype=numpy.float32)
        v.put([(n, f"c{n % 3}", float(n), False, e[n % 4]) for n in range(3000)])
        self.assertEqual(v.count(), 3000)
        v.put([(5, "c2", 5.0, False, e[0])])
        self.assertEqual(v.count(), 3000)
        v.drop(range(2000))
        self.assertEqual((v.count(), v.size), (1000, 1000))   # packed once half went
        best = v.best(e[1], cards={"c0"}, top=3)
        self.assertEqual([(card, round(score)) for _, card, score in best], [("c0", 1)] * 3)
        self.assertEqual(v.best(e[1], cards=set()), [])


class NoModel(Case):
    def setUp(self):
        super().setUp()
        self.board.card("m1", "Plain words")
        self.board.row("user", "m1", "searchable without any model")

    def test_no_entry_is_keyword_only(self):
        index = self.index()
        index.catch_up()
        semantic = index.status()["semantic"]
        self.assertEqual((semantic["state"], semantic["waiting"], semantic["embedded"]), ("off", None, 0))
        answer = self.find(index, "searchable")
        self.assertEqual((answer["mode"], answer["index"]["semantic"]), ("keyword", "off"))
        answer = self.find(index, "searchable", mode="semantic")
        self.assertEqual(answer["mode"], "keyword")
        self.assertIn("no model is set up", answer["fallback"])

    def test_missing_numpy_is_named(self):
        index = self.index(embedder=S.FakeEmbedder())
        index.catch_up()
        with mock.patch.object(S, "_numpy", side_effect=ImportError("numpy")):
            index._load_model()
        status = index.status()["semantic"]
        self.assertEqual((status["state"], status["reason"]),
                         ("unavailable", "numpy is not installed (see docs/search.md)"))
        answer = self.find(index, "searchable", mode="hybrid")
        self.assertEqual((answer["mode"], answer["fallback"]), ("keyword", status["reason"]))
        self.assertEqual(self.ids(answer), ["m1"])

    def test_missing_sentence_transformers_is_named(self):
        index = self.index(config={"embedder": "sentence-transformers"})
        index.catch_up()
        with mock.patch.dict(sys.modules, {"sentence_transformers": None, "torch": None}):
            index._load_model()
        reason = index.status()["semantic"]["reason"]
        if HAS_NUMPY:
            self.assertEqual(reason, "the packages the sentence-transformers embedder needs are not "
                                     "installed (see docs/search.md)")
        else:
            self.assertEqual(reason, "numpy is not installed (see docs/search.md)")
        self.assertEqual(self.find(index, "searchable")["mode"], "keyword")

    def test_a_model_server_that_is_not_running(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]   # free once closed: nothing answers there
        index = self.index(config={"embedder": "ollama", "url": f"http://127.0.0.1:{port}", "timeout": 2})
        index.catch_up()
        index._load_model()
        status = index.status()["semantic"]
        self.assertEqual(status["state"], "unavailable")
        self.assertTrue(status["reason"].startswith("numpy is not installed" if not HAS_NUMPY
                                                    else "the model did not answer"), status["reason"])
        self.assertGreater(index._retry_at, time.monotonic())
        self.assertEqual(self.find(index, "searchable")["mode"], "keyword")

    def test_a_child_imports_the_packages_first_and_only_once(self):
        folder = self.dir / "search-packages"
        folder.mkdir()
        index = self.index(config={"embedder": "sentence-transformers"}, packages=folder)
        with mock.patch.object(S.subprocess, "run") as run, \
                mock.patch.dict(sys.modules, {"sentence_transformers": None, "torch": None}):
            index._load_model()
            index._load_model()   # a retry after a failure does not start another child
        self.assertEqual(run.call_count, 1)
        args = run.call_args.args[0]
        self.assertEqual(args[0], sys.executable)
        self.assertTrue(args[-2].endswith("import numpy; import torch; import sentence_transformers"))
        self.assertEqual(args[-1], str(folder))
        self.assertEqual(run.call_args.kwargs["timeout"], 300)

    def test_a_child_that_cannot_start_changes_nothing(self):
        index = self.index(embedder=S.FakeEmbedder())
        with mock.patch.object(S.subprocess, "run", side_effect=OSError("no child")):
            index._load_model()
        self.assertEqual(index._model_state, "ready" if HAS_NUMPY else "unavailable")

    def test_the_packages_folder_is_looked_in_after_the_venv(self):
        folder = self.dir / "search-packages"
        folder.mkdir()
        index = self.index(embedder=S.FakeEmbedder(), packages=folder)
        with mock.patch.object(sys, "path", list(sys.path)):
            index._load_model()
            self.assertEqual(sys.path[-1], str(folder))

    def test_entries_that_cannot_be_used(self):
        for config, words in (("ollama", "not an object"),
                              ({"embedder": "gpt"}, "embedder is none"),
                              ({"embedder": "ollama", "dims": 300}, "dims is"),
                              ({"embedder": "ollama", "dims": True}, "dims is"),
                              ({"embedder": "sentence-transformers", "dtype": "float16"}, "float16 breaks"),
                              ({"embedder": "ollama", "url": "http://192.168.1.4:11434"}, "on this Mac"),
                              ({"embedder": "openai", "url": "https://example.com"}, "on this Mac"),
                              ({"embedder": "ollama", "device": "mps"}, 'takes no "device"'),
                              ({"embedder": "ollama", "timeout": "soon"}, "wrong kind")):
            with self.assertRaises(S.Unavailable) as caught:
                S.make_embedder(config)
            self.assertIn(words, str(caught.exception), config)
        index = self.index(config={"embedder": "gpt"})
        self.assertEqual(index.status()["semantic"]["state"], "unavailable")
        self.assertIsNone(S.make_embedder(None))
        self.assertIsNone(S.make_embedder({"embedder": "none"}))
        self.assertIsNone(S.make_embedder({}))
        made = S.make_embedder({"embedder": "ollama"})
        self.assertEqual((made.model, made.dims, made.url), ("embeddinggemma-2:270m-q8_0-text", 512,
                                                             "http://127.0.0.1:11434"))
        made = S.make_embedder({"embedder": "openai", "url": "http://localhost:9931/", "dims": 256})
        self.assertEqual((made.url, made.dims), ("http://localhost:9931", 256))


class _ModelServer:
    """A local stand-in for Ollama and an OpenAI-style embeddings server:
    it records each request and answers vectors 768 long."""

    def __init__(self, test):
        calls = self.calls = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append((self.path, body))
                texts = body["input"]
                vectors = [[float((len(t) + i) % 7) + 1.0 for i in range(768)] for t in texts]
                if self.path == "/api/embed":
                    answer = {"model": body["model"], "embeddings": vectors}
                else:   # given out of order, as the API allows; index puts them back
                    answer = {"data": [{"index": i, "embedding": v} for i, v in reversed(list(enumerate(vectors)))]}
                data = json.dumps(answer).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        test.addCleanup(self.server.server_close)
        test.addCleanup(self.server.shutdown)


class Backends(Case):
    def test_ollama_is_asked_the_documented_way(self):
        server = _ModelServer(self)
        model = S.make_embedder({"embedder": "ollama", "url": server.url})
        vectors = model.embed(["title: none | text: a", "task: search result | query: bb"])
        self.assertEqual(len(vectors), 2)
        self.assertEqual(len(vectors[0]), 768)
        path, body = server.calls[0]
        self.assertEqual(path, "/api/embed")
        self.assertEqual(body, {"model": "embeddinggemma-2:270m-q8_0-text",
                                "input": ["title: none | text: a", "task: search result | query: bb"],
                                "truncate": True, "keep_alive": "30m"})

    def test_an_openai_style_server_is_asked_the_documented_way(self):
        server = _ModelServer(self)
        model = S.make_embedder({"embedder": "openai", "url": server.url, "model": "eg2"})
        vectors = model.embed(["one", "three"])
        self.assertEqual([v[0] for v in vectors], [4.0, 6.0])   # back in the order asked
        self.assertEqual(server.calls[0], ("/v1/embeddings", {"model": "eg2", "input": ["one", "three"],
                                                              "encoding_format": "float"}))

    def test_no_proxy_stands_between_the_board_and_its_model(self):
        server = _ModelServer(self)
        model = S.make_embedder({"embedder": "ollama", "url": server.url})
        with mock.patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9",
                                          "no_proxy": "", "NO_PROXY": ""}):
            self.assertEqual(len(model.embed(["x"])), 1)

    @needs_numpy
    def test_a_whole_index_on_the_ollama_backend(self):
        server = _ModelServer(self)
        self.board.card("m1", "Over HTTP")
        self.board.row("user", "m1", "vectors from a local server")
        index = self.index(config={"embedder": "ollama", "url": server.url, "dims": 256})
        index.catch_up()
        index._load_model()
        self.assertEqual(index._model_state, "ready")
        self.assertEqual(index.embed_pending(), 2)
        (blob,) = index._db.execute("SELECT vector FROM vectors LIMIT 1").fetchone()
        self.assertEqual(len(blob), 256 * 4)
        self.assertEqual(self.find(index, "local server")["mode"], "hybrid")

    @needs_numpy
    def test_sentence_transformers_is_loaded_text_only_from_local_files(self):
        made = {}

        class SentenceTransformer:
            def __init__(self, name, **options):
                made["name"], made["options"] = name, options

            def encode(self, texts, **options):
                made["encode"] = options
                return numpy.ones((len(texts), 768), numpy.float32)

        torch = types.ModuleType("torch")
        torch.float32, torch.bfloat16 = "torch.float32", "torch.bfloat16"
        library = types.ModuleType("sentence_transformers")
        library.SentenceTransformer = SentenceTransformer
        with mock.patch.dict(sys.modules, {"torch": torch, "sentence_transformers": library}):
            index = self.index(config={"embedder": "sentence-transformers", "dtype": "bfloat16"})
            index._load_model()
        self.assertEqual(index._model_state, "ready", index._model_reason)
        self.assertEqual(made["name"], "google/embeddinggemma-2")
        self.assertEqual(made["options"], {"device": None, "local_files_only": True,
                                           "config_kwargs": {"vision_config": None, "audio_config": None},
                                           "model_kwargs": {"dtype": "torch.bfloat16"}})
        self.assertEqual(made["encode"]["prompt"], "")
        self.assertTrue(made["encode"]["convert_to_numpy"])
        vector = index._query_vector("x")
        self.assertEqual(vector.shape, (512,))
        self.assertAlmostEqual(float(numpy.linalg.norm(vector)), 1.0, places=5)


class TheFile(Case):
    def test_the_file_is_private_to_this_account(self):
        self.board.card("m1", "Private")
        index = self.index()
        index.catch_up()
        path = self.dir / "search-index.sqlite"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        for suffix in ("-wal", "-shm"):
            other = Path(str(path) + suffix)
            if other.exists():
                self.assertEqual(stat.S_IMODE(other.stat().st_mode) & 0o077, 0, suffix)

    def test_a_new_file_has_pages_that_hold_several_vectors(self):
        index = self.index()
        self.assertEqual(index._db.execute("PRAGMA page_size").fetchone()[0], 16384)
        self.assertEqual(index._db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        self.assertEqual(index._db.execute("PRAGMA wal_autocheckpoint").fetchone()[0], 256)

    def test_an_unreadable_file_is_made_again(self):
        (self.dir / "search-index.sqlite").write_bytes(b"this is not a database" * 100)
        self.board.card("m1", "Rebuilt")
        index = self.index()
        index.catch_up()
        self.assertEqual(self.ids(self.find(index, "rebuilt")), ["m1"])
        self.assertIn(("searchindex", {"step": "rebuild"}), self.lines)

    def test_a_file_of_another_layout_is_made_again(self):
        first = self.index()
        first._db.execute("UPDATE meta SET value = '0' WHERE key = 'schema'")
        first._db.commit()
        first._db.close()
        first._db = None
        self.index()
        self.assertIn(("searchindex", {"step": "rebuild"}), self.lines)

    def test_search_before_the_file_exists(self):
        index = S.Index(self.dir / "search-index.sqlite", self.board.transcript, self.board.read)
        status, answer = index.search({"q": ["anything"]})
        self.assertEqual((status, answer["results"], answer["index"]["ready"]), (200, [], False))
        self.assertFalse((self.dir / "search-index.sqlite").exists())   # a search never makes it
        self.assertEqual(index.status()["cards"], 0)

    def test_the_thread_builds_the_file_and_follows_wakes(self):
        self.board.card("m1", "Threaded")
        self.board.row("user", "m1", "first words")
        index = S.Index(self.dir / "search-index.sqlite", self.board.transcript, self.board.read)
        stopping = threading.Event()
        with mock.patch.object(S, "QUIET", 0.01):
            thread = threading.Thread(target=index.run, args=(stopping,), daemon=True)
            thread.start()
            try:
                self.assertTrue(self._until(lambda: index._ready))
                self.assertEqual(self.ids(self.find(index, "first")), ["m1"])
                self.board.row("user", "m1", "second words")
                index.wake()
                self.assertTrue(self._until(lambda: self.find(index, "second")["results"]))
            finally:
                stopping.set()
                index.wake()
                thread.join(5)
        self.assertFalse(thread.is_alive())

    def _until(self, check, seconds=10.0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if check():
                return True
            time.sleep(0.02)
        return False

    def test_the_log_carries_no_words(self):
        secret = "quokka"
        self.board.card("m1", f"Title about {secret}")
        self.board.row("user", "m1", f"a message about the {secret}")
        index = self.index(embedder=S.FakeEmbedder()) if HAS_NUMPY else self.index()
        index._pass()
        if HAS_NUMPY:
            index._load_model()
            index.embed_pending()
        self.find(index, secret)
        self.find(index, f"{secret} plain", mode="semantic")
        self.board.cards["m1"]["title"] = f"Renamed {secret}"
        index._pass()
        self.assertTrue(self.lines)
        self.assertNotIn(secret, json.dumps(self.lines))


class Scale(Case):
    CARDS, PER_CARD = 1000, 30

    def test_a_first_build_of_a_thousand_cards(self):
        b = self.board
        lanes = ("facilitator", "pastures", "home", "garden")
        sentence = ("we talked about the {} plan, the {} budget and what the next step for the "
                    "{} should be before the review on {}")
        topics = ("roof", "garden", "search", "invoice", "holiday", "printer", "garage", "fence")
        with b.transcript.open("a") as f:
            for n in range(1, self.CARDS + 1):
                cid = f"m{n}"
                b.card(cid, f"Card {n} about the {topics[n % 8]}", lane=lanes[n % 4],
                       section=("doing", "docked", "deferred", "done")[n % 4], ts=day(2026, 1, 1) + n * 3600)
                for m in range(self.PER_CARD):
                    text = sentence.format(topics[m % 8], topics[(n + m) % 8], cid, m)
                    if m == 0:
                        text = " ".join([text] * 20)   # a long one, cut into chunks
                    f.write(json.dumps({"ts": day(2026, 1, 1) + n * 3600 + m * 60, "kind": ("user", "agent")[m % 2],
                                        "box": cid, "text": text}) + "\n")
        index = self.index()
        gaps, stop = [], threading.Event()

        def requests():
            # a stand-in for the board answering while the build runs: small
            # pieces of work, and the longest wait between two of them
            last = time.monotonic()
            while not stop.is_set():
                json.dumps({"rev": 1, "boxes": list(range(50))})
                now = time.monotonic()
                gaps.append(now - last)
                last = now
                time.sleep(0.001)

        watcher = threading.Thread(target=requests, daemon=True)
        watcher.start()
        started = time.monotonic()
        done = index.catch_up()
        took = time.monotonic() - started
        stop.set()
        watcher.join()
        self.assertEqual(done["cards"], self.CARDS)
        self.assertEqual(done["messages"], self.CARDS * self.PER_CARD)
        self.assertEqual(b.reads, 1)   # one held stretch of the board's lock for the whole pass
        status = index.status()
        self.assertEqual(status["messages"], self.CARDS * self.PER_CARD)
        self.assertGreater(status["chunks"], self.CARDS * (self.PER_CARD + 2))   # the long ones were cut
        started = time.monotonic()
        answer = self.find(index, "invoice budget", lane="garden", **{"from": "2026-01-10"})
        searched = time.monotonic() - started
        self.assertTrue(answer["results"])
        self.assertEqual({r["lane"] for r in answer["results"]}, {"garden"})
        print(f"\n  first build: {self.CARDS} cards, {done['messages']} messages, {status['chunks']} chunks "
              f"in {took:.1f} s; longest gap between the stand-in requests {max(gaps) * 1000:.0f} ms; "
              f"a filtered search {searched * 1000:.0f} ms; index file "
              f"{(self.dir / 'search-index.sqlite').stat().st_size / 1e6:.1f} MB", file=sys.stderr)
        self.assertLess(took, 120)
        self.assertLess(max(gaps), 0.5)
        self.assertLess(searched, 2.0)


if __name__ == "__main__":
    unittest.main()
