"""Curse words saved as [expletive]: the matcher behind the board's "Replace
curse words" switch (Settings, Editor), and a command that checks the word
list against the messages already on the board.

With the switch on, the server runs mask() over the words of each message the
person sends, from the Mac board or the phone, before it saves them, so the
saved message, every screen, the history and every agent only ever have
"[expletive]" where a curse word was. Messages an agent sends (by=agent) are
saved as they came.

The word list is expletives.txt beside this file, a plain text file with three
headings:

  [anywhere]  a root matched anywhere, even inside a longer word, for roots no
              normal English word holds: "fuck" in "unfuckingbelievable"
  [alone]     a word matched only on its own, for roots that sit inside normal
              words: "ass" (class, assume), "hell" (hello, shell)
  [never]     a normal word left as it is although it holds a root above:
              "scunthorpe", "cocked"

Every letter of a root may repeat ("fuuuck"), case does not matter, and each
root takes the endings in ENDINGS. A root in [anywhere] that sits inside a
joined word takes only -ing or -in there, so "unfuckingbelievable" becomes
"un[expletive]believable" and "fuckface" becomes "[expletive]face". The text
around a match is kept exactly as it was, and the same words always give the
same result. The file is read again when it changes, so adding a word is one
line and needs no restart.

The command, which reads data/transcript.jsonl and writes nothing anywhere:

  python3 app/expletives.py scan     every word of the person's messages the
                                     list matches, and the likely misses, with
                                     counts
  python3 app/expletives.py dryrun   every word a swap would replace, with
                                     counts, and the messages where it changed
                                     something that may not be a curse

--transcript PATH reads another transcript, --list PATH another word list, and
--limit N (dryrun) caps the messages shown for review.

Standard library only, and Python 3.9 compatible.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

TAG = "[expletive]"
HERE = Path(__file__).resolve().parent
LIST_PATH = HERE / "expletives.txt"
TRANSCRIPT_PATH = HERE.parent / "data" / "transcript.jsonl"
DICTIONARY_PATH = Path("/usr/share/dict/words")
SECTIONS = ("anywhere", "alone", "never")
# the endings every root takes, longest first where one starts another
ENDINGS = ("iest", "ier", "ies", "ings", "ing", "in'", "in’", "in", "ers", "ery", "er", "ed", "es", "d", "s", "y")
# the endings a root in [anywhere] takes in the middle of a joined word
INFIXES = ("ing", "in")
LETTER = r"[^\W\d_]"
ENTRY = re.compile(r"[a-z]+")
HEADING = re.compile(r"\[([a-z]+)\]")


def _stretch(word: str) -> str:
    """A root as a pattern in which every letter may repeat."""
    return "".join(re.escape(c) + "+" for c in word)


def _either(patterns) -> str:
    return "|".join(patterns)


def _by_length(words) -> list:
    return sorted(set(words), key=lambda w: (-len(w), w))


class WordList:
    """The three kinds of entry, made into one pattern. At each place in the
    text a [never] word is tried first and kept as it is, so a root inside it
    is never reached; then an [alone] word, then an [anywhere] root."""

    def __init__(self, anywhere=(), alone=(), never=(), problems=()):
        self.anywhere = _by_length(anywhere)
        self.alone = _by_length(alone)
        self.never = _by_length(never)
        self.problems = list(problems)
        ends = _either(re.escape(e) for e in ENDINGS)
        infix = _either(re.escape(e) for e in INFIXES)
        hit = []
        if self.alone:
            hit.append(rf"(?<!{LETTER})(?:{_either(map(_stretch, self.alone))})(?:{ends})?(?!{LETTER})")
        if self.anywhere:
            hit.append(rf"(?:{_either(map(_stretch, self.anywhere))})(?:(?:{ends})(?!{LETTER})|(?:{infix}))?")
        if not hit:
            self.pattern = None
            return
        keep = rf"(?P<keep>(?<!{LETTER})(?:{_either(map(re.escape, self.never))})(?!{LETTER}))|" if self.never else ""
        self.pattern = re.compile(rf"{keep}(?P<hit>{_either(hit)})", re.IGNORECASE)

    def __len__(self) -> int:
        return len(self.anywhere) + len(self.alone)

    def spans(self, text: str) -> list:
        """Where each match is: (start, end) pairs, in order."""
        if not self.pattern or not text:
            return []
        return [m.span("hit") for m in self.pattern.finditer(text) if m.group("hit") is not None]

    def mask(self, text: str) -> str:
        """The text with every match replaced by TAG and nothing else changed."""
        if not self.pattern or not text:
            return text
        return self.pattern.sub(lambda m: m.group(0) if m.group("hit") is None else TAG, text)


def parse(source: str) -> WordList:
    """The list's text as a WordList. A line is a heading, an entry under the
    heading above it, or blank; # starts a comment. An entry is one word of
    the letters a to z. A line that is neither is left out and named in
    problems, so one bad line never stops the rest from working."""
    found = {name: [] for name in SECTIONS}
    problems = []
    section = None
    for number, line in enumerate(source.splitlines(), 1):
        line = line.split("#", 1)[0].strip().lower()
        if not line:
            continue
        heading = HEADING.fullmatch(line)
        if heading:
            section = heading.group(1)
            if section not in found:
                problems.append(f"line {number}: unknown heading [{section}]")
                section = None
            continue
        if section is None:
            problems.append(f"line {number}: {line!r} is not under a heading")
        elif not ENTRY.fullmatch(line):
            problems.append(f"line {number}: {line!r} is not one word of the letters a to z")
        else:
            found[section].append(line)
    return WordList(found["anywhere"], found["alone"], found["never"], problems)


_loaded: dict = {}   # path -> (the file's mtime and size, its WordList)


def word_list(path=LIST_PATH) -> WordList:
    """The list at path, read again only when the file has changed. A list
    that cannot be read raises OSError."""
    path = Path(path)
    st = os.stat(path)
    stamp = (st.st_mtime_ns, st.st_size)
    kept = _loaded.get(path)
    if kept and kept[0] == stamp:
        return kept[1]
    words = parse(path.read_text(encoding="utf-8"))
    _loaded[path] = (stamp, words)
    return words


def mask(text: str, path=LIST_PATH) -> str:
    """The text with every curse word on the list replaced by TAG."""
    return word_list(path).mask(text)


# ---- the scan and the dry run ------------------------------------------------------
# Both read the person's own messages out of the transcript, read-only: every
# "user" row an agent did not send, and every "widget" row (the person's
# messages typed in a card's widget). Nothing is written anywhere; the
# reports go to standard output.

WORD = re.compile(rf"{LETTER}+(?:['’]{LETTER}+)*")
# a word with letters and the marks people hide a curse word's letters with
TOKEN = re.compile(r"[\w*@$!#]+")
LEET = str.maketrans({"1": "i", "!": "i", "0": "o", "3": "e", "4": "a", "@": "a", "$": "s", "5": "s"})
# shortenings and exclamations that stand for a curse word without spelling
# one, which the list leaves alone; the scan counts the ones that are used
WATCH = ("wtf", "stfu", "gtfo", "ffs", "omfg", "lmfao", "fml", "mf", "af", "bs", "pos",
         "jesus", "christ", "god", "moron", "idiot", "stupid", "dumb")


def person_messages(path):
    """The person's own messages, oldest first: (kind, text) pairs."""
    with open(path, encoding="utf-8", errors="replace") as transcript:
        for line in transcript:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict) or not isinstance(row.get("text"), str):
                continue
            if row.get("kind") == "user" and row.get("by") != "agent":
                yield "user", row["text"]
            elif row.get("kind") == "widget":
                yield "widget", row["text"]


def _dictionary() -> set:
    try:
        return {w.strip().lower() for w in DICTIONARY_PATH.read_text(errors="replace").split()}
    except OSError:
        return set()


def _word_at(text: str, start: int, end: int) -> tuple:
    """The whole run of letters a match sits in, and its span."""
    while start > 0 and (text[start - 1].isalpha() or text[start - 1] in "'’"):
        start -= 1
    while end < len(text) and text[end].isalpha():
        end += 1
    return text[start:end], start, end


def _collapse(word: str) -> str:
    """A word with each run of one letter cut to one: "fuuuck" is "fuck"."""
    return re.sub(r"(.)\1+", r"\1", word)


def _near(roots) -> dict:
    """Every spelling one letter away from a root, each with its root: two
    letters swapped or a letter put in, and for a root of five letters or more
    also a letter changed or left out, since one changed or dropped letter
    makes a normal word out of most four-letter roots (shit: sit, hit, shot)."""
    letters = "abcdefghijklmnopqrstuvwxyz"
    near = {}
    for root in roots:
        r = _collapse(root)
        if len(r) < 4:
            continue
        for i in range(len(r) + 1):
            for c in letters:
                near.setdefault(r[:i] + c + r[i:], root)
            if i < len(r) - 1:
                near.setdefault(r[:i] + r[i + 1] + r[i] + r[i + 2:], root)
            if i < len(r) and len(r) >= 5:
                near.setdefault(r[:i] + r[i + 1:], root)
                for c in letters:
                    near.setdefault(r[:i] + c + r[i + 1:], root)
        near.pop(r, None)
    return near


def _known(word: str, dictionary: set) -> bool:
    """Whether a word is a normal English word: in the dictionary, or one of
    its plain forms (the dictionary keeps "class" and not "classes")."""
    if word in dictionary:
        return True
    for end in ("s", "es", "ed", "d", "ing", "er", "ers", "ly", "y"):
        if word.endswith(end) and len(word) > len(end) + 2:
            stem = word[:-len(end)]
            if {stem, stem + "e", stem[:-1] if stem[-1:] == stem[-2:-1] else stem} & dictionary:
                return True
            if end in ("es", "ed", "er") and stem.endswith("i") and stem[:-1] + "y" in dictionary:
                return True
    return False


def _counted(counter: Counter, limit=None) -> list:
    return [f"  {n:6d}  {w}" for w, n in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]]


def scan(transcript, words: WordList) -> str:
    """Every word the list matches in the person's messages and the likely
    misses, with counts. Words only, never a message."""
    dictionary = _dictionary()
    near = _near(words.anywhere + words.alone)
    matched, hidden, close, watched = Counter(), Counter(), Counter(), Counter()
    close_root, hidden_as = {}, {}
    messages = 0
    for _, text in person_messages(transcript):
        messages += 1
        for s, e in words.spans(text):
            matched[_word_at(text, s, e)[0].lower()] += 1
        for token in TOKEN.findall(text):
            low = token.lower()
            if words.spans(token):
                continue
            if low in WATCH:
                watched[low] += 1
            letters = re.sub(r"[^a-z]", "", low)
            # a word with marks in it that reads as a curse word once the
            # marks are letters again: "f*ck", "sh!t", "a$$"
            if re.search(r"[a-z]", low) and re.search(r"[*@$!#0-9]", low.strip("*#!")):
                guess = low.translate(LEET)
                reads = next((g for g in [guess] + [guess.replace("*", c) for c in "uiaoec"] if words.spans(g)), None)
                if reads:
                    hidden[low] += 1
                    hidden_as[low] = reads
                continue
            # a spelling one letter away from a root, at the word's start, that
            # no dictionary knows: "fukc", "assholoe"
            if not letters or letters != low or _known(low, dictionary):
                continue
            short = _collapse(low)
            root = near.get(short) or next((near[short[:-len(e)]] for e in ENDINGS
                                            if short.endswith(e) and short[:-len(e)] in near), None)
            # a run of letters that starts with one ("fukcksjkfnl")
            root = root or next((near[short[:n]] for n in range(5, len(short)) if short[:n] in near), None)
            if root:
                close[low] += 1
                close_root[low] = root
    out = [f"Scan of {transcript}", f"Messages read: {messages} (the person's own, typed on a card or in a widget)",
           f"Word list: {len(words.anywhere)} anywhere, {len(words.alone)} alone, {len(words.never)} never",
           *(f"List problem: {p}" for p in words.problems), "",
           f"Words the list matches ({len(matched)} distinct, {sum(matched.values())} in all):", *_counted(matched), "",
           "Likely misses",
           f"Curse words spelled with marks in place of letters ({len(hidden)}):",
           *(f"{line}  (reads as {hidden_as[line.split()[-1]]})" for line in _counted(hidden)), "",
           f"Spellings one letter from a root on the list ({len(close)}):",
           *(f"{line}  (near {close_root[line.split()[-1]]})" for line in _counted(close)), "",
           "Shortenings and rude words the list leaves alone:", *_counted(watched), ""]
    return "\n".join(out)


def _snippet(text: str, start: int, end: int, room: int = 60) -> str:
    a, b = max(0, start - room), min(len(text), end + room)
    piece = text[a:start] + "<<" + text[start:end] + ">>" + text[end:b]
    return ("..." if a else "") + " ".join(piece.split()) + ("..." if b < len(text) else "")


def dryrun(transcript, words: WordList, limit: int = 150) -> str:
    """What the swap would do to the person's messages, saving nothing: every
    distinct replaced word with counts, and for review every message where a
    replacement touched something that may not be a curse word, which is a
    match with letters or a hyphen joining it to more of a word
    ("un-fucking-believable", "pushitem"), or a match that is also a normal
    word ("hell", "cocked")."""
    dictionary = _dictionary()
    replaced, review = Counter(), Counter()
    why, examples = {}, defaultdict(list)
    messages = changed = hits = 0
    for kind, text in person_messages(transcript):
        messages += 1
        spans = words.spans(text)
        if not spans:
            continue
        changed += 1
        hits += len(spans)
        for s, e in spans:
            part = text[s:e].lower()
            replaced[part] += 1
            whole, ws, we = _word_at(text, s, e)
            joined = (ws < s or we > e) and "joined to more letters"
            if not joined:
                if (s > 1 and text[s - 1] == "-" and text[s - 2].isalpha()) or (
                        e < len(text) - 1 and text[e] == "-" and text[e + 1].isalpha()):
                    joined = "joined by a hyphen"
            normal = _known(part, dictionary) and "also a normal word"
            reason = joined or normal
            if not reason:
                continue
            key = (whole.lower() if joined == "joined to more letters" else
                   _hyphened(text, s, e) if joined else part)
            review[key] += 1
            why[key] = reason
            examples[key].append((text, s, e))
    out = [f"Dry run over {transcript} (nothing saved)",
           f"Messages read: {messages}; messages a swap would change: {changed}; words replaced: {hits}",
           *(f"List problem: {p}" for p in words.problems), "",
           f"Every word replaced ({len(replaced)} distinct):", *_counted(replaced), "",
           f"For review: replacements that may have hit more than a curse word ({len(review)} distinct, "
           f"{sum(review.values())} in all):",
           *(f"{line}  -> {words.mask(line.split()[-1])}  ({why[line.split()[-1]]})" for line in _counted(review)), ""]
    shown = 0
    out.append(f"The messages for review, at most 3 for each word above and {limit} in all, "
               "with the replaced part between << and >>:")
    for key, _ in sorted(review.items(), key=lambda kv: (-kv[1], kv[0])):
        for text, s, e in examples[key][:3]:
            if shown >= limit:
                break
            shown += 1
            out.append(f"  [{key}] {_snippet(text, s, e)}")
    out.append("")
    return "\n".join(out)


def _hyphened(text: str, s: int, e: int) -> str:
    """The hyphenated run a match is part of, as one word: "re-asses"."""
    a, b = s, e
    while a > 0 and (text[a - 1].isalpha() or text[a - 1] == "-"):
        a -= 1
    while b < len(text) and (text[b].isalpha() or text[b] == "-"):
        b += 1
    return text[a:b].strip("-").lower()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="expletives.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("command", choices=("scan", "dryrun"))
    parser.add_argument("--transcript", default=str(TRANSCRIPT_PATH))
    parser.add_argument("--list", default=str(LIST_PATH))
    parser.add_argument("--limit", type=int, default=150)
    args = parser.parse_args(argv)
    try:
        words = parse(Path(args.list).read_text(encoding="utf-8"))
    except OSError as e:
        print(f"the word list {args.list} could not be read: {e.strerror}", file=sys.stderr)
        return 1
    if not Path(args.transcript).is_file():
        print(f"no transcript at {args.transcript}", file=sys.stderr)
        return 1
    report = scan(args.transcript, words) if args.command == "scan" else dryrun(args.transcript, words, args.limit)
    sys.stdout.write(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
