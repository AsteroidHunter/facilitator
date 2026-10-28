"""The curse word matcher (expletives.py) and its word list (expletives.txt).

  examples   the swaps the board promised: un-fucking-believable,
             unfuckingbelievable, FUUUCK this, you ass, a classy assessment
  matching   repeated letters, mixed case, punctuation around a word, the
             endings, hyphenated and joined compounds, a word only on its own
  normal     normal words that hold a root are left alone: class, assume,
             hello, shell, Dickens, Scunthorpe and more
  kept       the text around a match is kept exactly; the swap is the same
             every time and does nothing to text it already swapped
  links      an attached file's address, a web link and a markdown link's
             target are never swapped, curse words around them still are, and
             a markdown link's words take the tag with its brackets escaped
  list       the shipped list reads with no problems, names its source and
             licence, and has all three kinds of entry; a bad line is left out
             and named; an empty list swaps nothing; a changed file is read again
  command    scan and dryrun read only the person's messages from a
             transcript, write nothing, and count words without quoting
             messages (scan) or show the messages for review (dryrun)

Every message here is invented.

    python3 -B -m unittest tests/test_expletives.py
"""

import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import expletives  # noqa: E402

T = expletives.TAG


def mask(text):
    return expletives.mask(text)


class Examples(unittest.TestCase):
    def test_the_promised_examples(self):
        self.assertEqual(mask("un-fucking-believable"), f"un-{T}-believable")
        self.assertEqual(mask("unfuckingbelievable"), f"un{T}believable")
        self.assertEqual(mask("FUUUCK this"), f"{T} this")
        self.assertEqual(mask("you ass"), f"you {T}")
        self.assertEqual(mask("a classy assessment"), "a classy assessment")


class Matching(unittest.TestCase):
    def test_repeated_letters(self):
        for word in ("fuuuuck", "ffffuck", "fuckkkk", "shiiiit", "shhhit", "asssss", "helllll", "cuuunt", "biiitch"):
            with self.subTest(word=word):
                self.assertEqual(mask(word), T)

    def test_mixed_case(self):
        for word in ("FuCkInG", "Shit", "SHIT", "ASS", "Hell", "BullShit", "MotherFucker"):
            with self.subTest(word=word):
                self.assertEqual(mask(word), T)

    def test_punctuation_around_words(self):
        cases = {
            "(fuck)": f"({T})",
            "fuck!": f"{T}!",
            '"shit,"': f'"{T},"',
            "you ass.": f"you {T}.",
            "what the hell?": f"what the {T}?",
            "*fucking* broken": f"*{T}* broken",
            "**shit**": f"**{T}**",
            "for fuck's sake": f"for {T}'s sake",
            "ass/hole": f"{T}/hole",
            "...damn...": f"...{T}...",
            "[shit]": f"[{T}]",
        }
        for text, want in cases.items():
            with self.subTest(text=text):
                self.assertEqual(mask(text), want)

    def test_endings(self):
        for word in ("fucking", "fucked", "fucker", "fuckers", "fucks", "fuckin", "fuckin'", "fuckery",
                     "shitty", "shitting", "shits", "asses", "pissed", "pissing", "crappy", "damned",
                     "bitches", "bitchy", "bastards", "fcking", "fcked"):
            with self.subTest(word=word):
                self.assertEqual(mask(word), T)

    def test_hyphenated_compounds(self):
        cases = {
            "un-fucking-believable": f"un-{T}-believable",
            "in-fucking-comprehensible": f"in-{T}-comprehensible",
            "half-assed": f"half-{T}",
            "kick-ass": f"kick-{T}",
            "what-the-hell": f"what-the-{T}",
            "holy-shit-moment": f"holy-{T}-moment",
        }
        for text, want in cases.items():
            with self.subTest(text=text):
                self.assertEqual(mask(text), want)

    def test_joined_compounds(self):
        cases = {
            "unfuckingbelievable": f"un{T}believable",
            "facefuckingpalm": f"face{T}palm",
            "fuckface": f"{T}face",
            "fuckhead": f"{T}head",
            "motherfucker": T,
            "motherfucking": T,
            "clusterfuck": T,
            "bullshit": T,
            "bullshitting": T,
            "horseshit": T,
            "cocksucker": T,
            "asshole": T,
            "assholes": T,
            "shithead": f"{T}head",
        }
        for text, want in cases.items():
            with self.subTest(text=text):
                self.assertEqual(mask(text), want)

    def test_words_only_on_their_own(self):
        # the roots that sit inside normal words are swapped only standing alone
        self.assertEqual(mask("you dick"), f"you {T}")
        self.assertEqual(mask("Dickens"), "Dickens")
        self.assertEqual(mask("a cock-up"), f"a {T}-up")
        self.assertEqual(mask("peacock"), "peacock")
        self.assertEqual(mask("crap"), T)
        self.assertEqual(mask("scrap"), "scrap")
        self.assertEqual(mask("Saturday"), "Saturday")
        self.assertEqual(mask("a turd"), f"a {T}")


class Normal(unittest.TestCase):
    NORMAL = (
        # holds ass
        "class", "classy", "classic", "classes", "glass", "pass", "passage", "password", "assume", "assumption",
        "assess", "assessment", "reassess", "assign", "asset", "assistant", "associate", "assembly", "embarrass",
        "harass", "bass", "bassist", "massive", "brass", "compass", "Atlassian", "assassin",
        # holds hell
        "hello", "shell", "shells", "shellfish", "Hellenic", "Michelle", "seashell", "powershell",
        # holds dick, cock, tit, cunt, shit, crap, turd, arse, wank, piss, spic, coon
        "Dickens", "Dickinson", "Scunthorpe", "cocktail", "cockpit", "peacock", "Hitchcock", "cocked", "cocky",
        "title", "constitution", "titan", "petition", "Shiite", "Shiites", "shiitake", "mishit",
        "scrap", "scrape", "scraping", "Saturday", "Saturdays", "parse", "parsed", "sparse", "swanky",
        "spicy", "spices", "spiced", "raccoon", "cocoon", "tycoon",
        # words of other roots and endings
        "therapist", "analysis", "pricked", "dicker", "damning", "retarding", "hotkey", "sucks", "button",
        "assholes are not here",
    )

    def test_normal_words_are_left_alone(self):
        for word in self.NORMAL[:-1]:
            with self.subTest(word=word):
                self.assertEqual(mask(word), word)
                self.assertEqual(mask(word.upper()), word.upper())
                self.assertEqual(mask(f"a {word}, then"), f"a {word}, then")

    def test_a_sentence_of_normal_words(self):
        text = ("Michelle passed the class assessment in Scunthorpe on Saturday, then said hello to "
                "Dickens fans and parsed the shell script for a classic cocktail.")
        self.assertEqual(mask(text), text)


class Kept(unittest.TestCase):
    def test_the_text_around_a_match_is_kept_exactly(self):
        text = "line one\n\n  fuck\tthis 🙂  and\r\nthat shit!  "
        self.assertEqual(mask(text), f"line one\n\n  {T}\tthis 🙂  and\r\nthat {T}!  ")

    def test_the_swap_is_the_same_every_time(self):
        text = "Fucking hell, this shit is unfuckingbelievable, you ass. A classy assessment."
        once = mask(text)
        self.assertEqual(once, f"{T} {T}, this {T} is un{T}believable, you {T}. A classy assessment.")
        self.assertEqual(mask(text), once)
        self.assertEqual(mask(once), once, "the tag itself was swapped")

    def test_empty_and_clean_text(self):
        self.assertEqual(mask(""), "")
        self.assertEqual(mask("nothing to swap here"), "nothing to swap here")


class Links(unittest.TestCase):
    L = expletives.LINK_TAG

    def test_an_attached_files_address_is_kept(self):
        for address in ("/uploads/1761600000000000000-shit-list.pdf",
                        "/uploads/1761600000000000001-fucking%20notes.docx",
                        "/uploads/1761600000000000002-ASS.png"):
            with self.subTest(address=address):
                self.assertEqual(mask(address), address)
                # the Mac board's way round, the words then the file
                self.assertEqual(mask("the damn file\n" + address), f"the {T} file\n" + address)

    def test_the_phones_layout_keeps_every_address(self):
        text = ("/uploads/1-a.png /uploads/2-shit.png\n\n/uploads/3-fuck.pdf\n/uploads/4-hell.mp3\n\n"
                "what the hell is this shit")
        self.assertEqual(mask(text), text.replace("the hell is this shit", f"the {T} is this {T}"))

    def test_a_web_link_is_kept(self):
        link = "https://example.com/shit-happens?q=fuck#ass"
        self.assertEqual(mask(link), link)
        self.assertEqual(mask("HTTP://EXAMPLE.COM/SHIT"), "HTTP://EXAMPLE.COM/SHIT")
        self.assertEqual(mask(f"<{link}>"), f"<{link}>")

    def test_a_markdown_links_target_is_kept_and_its_words_swapped(self):
        self.assertEqual(mask("[my shit list](https://example.com/shit-list)"),
                         f"[my {self.L} list](https://example.com/shit-list)")
        self.assertEqual(mask("![shit](/uploads/1-shit.png)"), f"![{self.L}](/uploads/1-shit.png)")
        self.assertEqual(mask("[mail the ass](mailto:ass@example.com)"),
                         f"[mail the {self.L}](mailto:ass@example.com)")
        self.assertEqual(mask("[notes](<my fuck file.pdf>)"), "[notes](<my fuck file.pdf>)")
        self.assertEqual(mask("[a](b(shit)c)"), "[a](b(shit)c)")

    def test_curse_words_outside_a_link_are_still_swapped(self):
        self.assertEqual(mask("look at https://example.com/shit then fix this shit"),
                         f"look at https://example.com/shit then fix this {T}")
        self.assertEqual(mask("[the list](https://example.com/fuck) is fucking long, damn"),
                         f"[the list](https://example.com/fuck) is {T} long, {T}")
        self.assertEqual(mask("fuck/uploads/x"), f"{T}/uploads/x")
        # brackets that make no link are words, and so is a target with spaces in it
        self.assertEqual(mask("[shit] (fuck)"), f"[{T}] ({T})")
        self.assertEqual(mask("[note](what the fuck)"), f"[note](what the {T})")
        self.assertEqual(mask("\\[shit](https://example.com/shit)"), f"\\[{T}](https://example.com/shit)")

    def test_the_swap_of_a_link_is_the_same_every_time(self):
        once = mask("[shit](https://example.com/shit) and /uploads/1-shit.pdf, shit")
        self.assertEqual(once, f"[{self.L}](https://example.com/shit) and /uploads/1-shit.pdf, {T}")
        self.assertEqual(mask(once), once)

    def test_a_long_message_of_brackets_is_read_quickly(self):
        for text in ("[" * 65536, "](" * 32768, "[a](" * 16384 + ")" * 16384):
            with self.subTest(start=text[:4]):
                started = time.monotonic()
                self.assertEqual(mask(text), text)
                self.assertLess(time.monotonic() - started, 2)


class List(unittest.TestCase):
    def test_the_shipped_list(self):
        words = expletives.word_list()
        self.assertEqual(words.problems, [])
        self.assertTrue(words.anywhere and words.alone and words.never)
        head = expletives.LIST_PATH.read_text(encoding="utf-8")
        self.assertIn("LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words", head)
        self.assertIn("Attribution 4.0 International", head)
        for heading in ("[anywhere]", "[alone]", "[never]"):
            self.assertIn("\n" + heading + "\n", head)
        self.assertNotIn("—", head)

    def test_a_bad_line_is_left_out_and_named(self):
        words = expletives.parse("stray\n[anywhere]\nfuck\nnot one word\n[sometimes]\nshit\n[alone]\nass\nf*ck\n")
        self.assertEqual(words.anywhere, ["fuck"])
        self.assertEqual(words.alone, ["ass"])
        self.assertEqual(len(words.problems), 5, words.problems)
        self.assertEqual(words.mask("fuck shit ass"), f"{T} shit {T}")

    def test_comments_and_case(self):
        words = expletives.parse("# a comment\n[ALONE]  # the heading\n  Darn   # an entry\n")
        self.assertEqual(words.alone, ["darn"])
        self.assertEqual(words.mask("DARN it"), f"{T} it")

    def test_an_empty_list_swaps_nothing(self):
        for source in ("", "[anywhere]\n[alone]\n", "[never]\nscunthorpe\n"):
            with self.subTest(source=source):
                self.assertEqual(expletives.parse(source).mask("fuck, all of it"), "fuck, all of it")

    def test_never_wins_over_a_root_inside_it(self):
        words = expletives.parse("[anywhere]\ncunt\n[never]\nscunthorpe\n")
        self.assertEqual(words.mask("Scunthorpe, SCUNTHORPE, scunthorpes, cunt"), f"Scunthorpe, SCUNTHORPE, s{T}horpes, {T}")

    def test_a_changed_file_is_read_again(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "list.txt"
            path.write_text("[alone]\ndarn\n")
            self.assertEqual(expletives.mask("darn heck", path), f"{T} heck")
            path.write_text("[alone]\ndarn\nheck\n")
            os.utime(path, ns=(time.time_ns(), time.time_ns() + 10 ** 9))
            self.assertEqual(expletives.mask("darn heck", path), f"{T} {T}")
            path.unlink()
            with self.assertRaises(OSError):
                expletives.mask("darn", path)


class Command(unittest.TestCase):
    ROWS = [
        {"kind": "user", "box": "1", "text": "this is fucking broken, you ass", "ts": 1},
        {"kind": "user", "box": "1", "text": "unfuckingbelievable, and the class assessment passed", "ts": 2},
        {"kind": "user", "box": "1", "text": "f*ck and shiet and wtf", "ts": 3},
        {"kind": "user", "box": "2", "by": "agent", "text": "an agent's shit is not read", "ts": 4},
        {"kind": "agent", "box": "1", "text": "a reply with hell in it is not read", "ts": 5},
        {"kind": "widget", "box": "3", "text": "a widget message, damn", "ts": 6},
        {"kind": "create", "box": "4", "text": "a title with crap in it", "ts": 7},
    ]

    def run_command(self, *args):
        with tempfile.TemporaryDirectory() as folder:
            transcript = Path(folder) / "transcript.jsonl"
            transcript.write_text("".join(json.dumps(r) + "\n" for r in self.ROWS) + "not json\n")
            before = sorted(os.listdir(folder)), transcript.read_bytes()
            out = io.StringIO()
            with redirect_stdout(out):
                code = expletives.main([*args, "--transcript", str(transcript)])
            self.assertEqual(code, 0)
            self.assertEqual((sorted(os.listdir(folder)), transcript.read_bytes()), before, "the command wrote something")
        return out.getvalue()

    def test_scan_counts_the_persons_words(self):
        out = self.run_command("scan")
        self.assertIn("Messages read: 4", out)
        matched = out.split("Words the list matches")[1].split("Likely misses")[0]
        for line in ("1  fucking", "1  ass", "1  unfuckingbelievable", "1  damn"):
            self.assertIn(line, matched)
        for word in ("shit", "hell", "crap"):
            self.assertNotIn(word, matched, f"{word} came from a row that is not the person's message")
        self.assertIn("1  f*ck  (reads as fuck)", out)
        self.assertIn("1  shiet  (near shit)", out)
        self.assertIn("1  wtf", out)
        self.assertNotIn("broken", out, "the scan quoted a message")

    def test_dryrun_counts_the_swaps_and_shows_the_ones_to_review(self):
        out = self.run_command("dryrun")
        self.assertIn("Messages read: 4; messages a swap would change: 3; words replaced: 4", out)
        self.assertIn(f"unfuckingbelievable  -> un{T}believable  (joined to more letters)", out)
        self.assertIn("ass  -> [expletive]  (also a normal word)" if expletives.DICTIONARY_PATH.exists()
                      else "words replaced", out)
        self.assertIn("[unfuckingbelievable] un<<fucking>>believable, and the class assessment passed", out)

    def test_words_in_a_link_are_not_counted(self):
        rows = self.ROWS
        self.ROWS = rows + [{"kind": "user", "box": "1", "text": "/uploads/1-crap.pdf https://example.com/crap", "ts": 8}]
        try:
            out = self.run_command("dryrun")
        finally:
            self.ROWS = rows
        self.assertIn("Messages read: 5; messages a swap would change: 3; words replaced: 4", out)
        self.assertNotIn("crap", out)

    def test_a_missing_transcript_is_said_plainly(self):
        err = io.StringIO()
        from contextlib import redirect_stderr
        with redirect_stderr(err):
            self.assertEqual(expletives.main(["scan", "--transcript", "/nonexistent/transcript.jsonl"]), 1)
        self.assertIn("no transcript at", err.getvalue())


if __name__ == "__main__":
    unittest.main()
