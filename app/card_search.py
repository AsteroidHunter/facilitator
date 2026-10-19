"""Search over the board's cards and messages.

The index is one SQLite file beside state.json, search-index.sqlite. It holds
a row for every card on the board and in the Bin (its title, lane, section,
when it was made and when it last changed) and the words those cards hold, cut
into chunks: one for each card's title and one or more for each message, read
from the transcript the way /thread reads it: what the reader sent (user), the
agent's replies (agent), its notes (note) and its progress notes (progress).

A thread of its own keeps the index current, and nothing about it runs on a
request but the search itself. The board wakes it after every save; it lets a
burst of saves settle, reads the cards in one short held stretch of the
board's lock, and then reads the transcript rows written since its last pass,
found by the byte offset it stopped at. A card that leaves the board for the
Bin keeps its rows and is searched only when a search asks for the Bin; a card
deleted for good goes from the index with everything it held.

Two ways to find things, and one answer for both:
  keyword   SQLite's full-text search, FTS5, over the words. It needs nothing
            past the standard library. A Python whose SQLite has no FTS5 gets
            a plain scan (LIKE) instead: slower and ranked more roughly, but
            the same answer
  semantic  an embedding model ranks chunks by meaning. Only when
            run.config.json names one under "search" and it loads, so the
            board starts and searches by keyword without it. EmbeddingGemma 2
            is the model this is made for; docs/search.md says how to switch
            it on
  hybrid    both, merged card by card by reciprocal rank fusion, which is what
            a search runs as whenever the model is ready

The index is derived data: deleting it is safe, and the board builds it again
from state.json and the transcript. It holds the cards' words, so it is
private to this account like the files it comes from, and none of it leaves
the Mac: a model runs in this process or is asked at a loopback address, and
nothing else. No line this writes to the log carries a word of a card, a
message or a query.

Standard library only for the keyword half. numpy and the model's own
packages are needed for the semantic half alone; they may sit in the board's
.venv or in a folder of their own (data/search-packages), which an update's
sync of requirements.txt leaves alone.
"""

from __future__ import annotations

import collections
import functools
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

SCHEMA = 1                 # the index file's layout: another number builds the file again
PREFIX_VERSION = 1         # the two prefixes below: another number embeds every chunk again
# EmbeddingGemma 2's own forms for a search (its model card, "Task Instruction
# Prefixes"): a query, and a document with its title, or none when it has none
QUERY_PREFIX = "task: search result | query: "
DOCUMENT_PREFIX = "title: {} | text: "

MESSAGE_KINDS = frozenset(("user", "agent", "note", "progress"))
SECTIONS = ("doing", "docked", "deferred", "done", "bin")
SHOWN = ("doing", "docked", "deferred", "done")   # what a search covers unless it names the Bin
DATES = ("created", "changed", "message")
SORTS = ("relevance", "created", "changed")
MODES = ("auto", "keyword", "semantic", "hybrid")
DIMENSIONS = (128, 256, 512, 768)   # the lengths EmbeddingGemma 2 is trained to be cut to
DTYPES = ("float32", "bfloat16")    # never float16: the model's activations overflow it
LOOPBACK = frozenset(("127.0.0.1", "localhost", "::1"))

CHUNK_CHARS = 1200         # characters of one chunk at most
CHUNK_OVERLAP = 200        # characters a chunk repeats of the one before it
READ_BLOCK = 1 << 22       # bytes of the transcript read at a time
ROWS_PER_COMMIT = 1000     # messages one transaction writes
EMBED_BATCH = 16           # chunks one call to the model embeds: small, so a query waits little
QUIET = 0.5                # seconds a burst of saves is given to settle
PAUSE = 0.005              # seconds the thread steps aside between batches
RETRY = 60.0               # seconds before a model that would not answer is tried again
QUERY_WAIT = 5.0           # seconds a query waits for the model before searching by keyword
RRF_K = 60                 # reciprocal rank fusion's constant, the usual one
TOP_CHUNKS = 600           # best chunks the semantic half reads before it groups them by card
TOP_CARDS = 200            # cards each half hands the merge, and the most a search pages through
KEYWORD_ROWS = 5000        # matching chunks the keyword half reads at most
QUERY_MAX = 500            # characters of a query
LANE_MAX = 64              # characters of a lane's name
LIMIT = 20
LIMIT_MAX = 100
SNIPPET_TOKENS = 24        # words of a keyword snippet
SNIPPET_CHARS = 200        # characters of any other snippet
QUERY_CACHE = 64           # query vectors kept, so a second page does not ask the model again
HEAD_BYTES = 4096          # bytes of the transcript's start kept to tell it is the same file
OPEN, SHUT = "\x02", "\x03"   # a matched word's ends in an FTS5 snippet, taken out before answering

_WORD = re.compile(r"\w+")
_QUOTED = re.compile(r'"([^"]*)"')
_DOCUMENT = re.compile(r"title: (.*?) \| text: (.*)", re.S)


class Refused(ValueError):
    """A search asked for something it cannot have. The words are the
    answer's error, and never carry what the caller typed."""


class Unavailable(Exception):
    """The semantic half cannot run, and the words say why."""


class Busy(Exception):
    """The model was busy for longer than a query waits."""


# ---- words --------------------------------------------------------------------


def _pieces(text: str) -> list[str]:
    """One message's words as chunks of CHUNK_CHARS at most, each cut at the
    last paragraph, line, sentence or word break in its second half, and each
    after the first starting CHUNK_OVERLAP characters back, at a word."""
    text = text.strip()
    if len(text) <= CHUNK_CHARS:
        return [text] if text else []
    pieces, start = [], 0
    while True:
        end = start + CHUNK_CHARS
        if end >= len(text):
            pieces.append(text[start:].strip())
            break
        floor = start + CHUNK_CHARS // 2
        for mark in ("\n\n", "\n", ". ", " "):
            cut = text.rfind(mark, floor, end)
            if cut != -1:
                end = cut + len(mark)
                break
        pieces.append(text[start:end].strip())
        back = end - CHUNK_OVERLAP
        space = text.find(" ", back, end)
        start = space + 1 if space != -1 else back
    return [p for p in pieces if p]


def _document(title: str, text: str) -> str:
    """A chunk the way the model reads it: EmbeddingGemma 2's document form."""
    return DOCUMENT_PREFIX.format(title.strip() or "none") + text


def _digest(doc: str) -> str:
    return hashlib.sha256(doc.encode("utf-8", "replace")).hexdigest()[:32]


def _terms(text: str, prefix: bool = False) -> list[str]:
    """A query's words as FTS5 strings: each quoted phrase whole, then each
    word left over. Every one goes in double quotes and holds word characters
    only, so nothing a person types is read as FTS5's own syntax. prefix
    lets the last one match the start of a longer word, for a box that
    searches while it is typed into."""
    terms = []
    for phrase in _QUOTED.findall(text):
        words = _WORD.findall(phrase)
        if words:
            terms.append('"' + " ".join(words) + '"')
    terms += [f'"{word}"' for word in _WORD.findall(_QUOTED.sub(" ", text))]
    if prefix and terms:
        terms[-1] += "*"
    return terms


def _words(text: str) -> list[str]:
    """A query's words, lowercase, each once, in the order typed."""
    return list(dict.fromkeys(word.lower() for word in _WORD.findall(text)))


def _mark_pattern(words: list[str]):
    if not words:
        return None
    alternatives = "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))
    return re.compile(rf"(?<!\w)(?:{alternatives})\w*", re.IGNORECASE)


def _marked(snippet: str) -> tuple[str, list]:
    """An FTS5 snippet with its markers taken out, and where each matched
    word starts and ends in what is left, in characters."""
    flat = " ".join(snippet.split())
    plain, marks, at, start = [], [], 0, None
    for part in re.split(f"([{OPEN}{SHUT}])", flat):
        if part == OPEN:
            start = at
        elif part == SHUT:
            if start is not None:
                marks.append([start, at])
                start = None
        else:
            plain.append(part)
            at += len(part)
    return "".join(plain), marks


def _window(text: str, words: list[str]) -> tuple[str, list]:
    """SNIPPET_CHARS of a chunk around the first query word in it, or its
    opening when it holds none (a chunk only the model found), cut at words,
    with every query word in it marked as a keyword snippet marks them."""
    flat = " ".join(text.split())
    pattern = _mark_pattern(words)
    found = pattern.search(flat) if pattern else None
    start = 0
    if found and found.start() > SNIPPET_CHARS // 3:
        start = flat.rfind(" ", 0, found.start() - SNIPPET_CHARS // 3) + 1
    end = start + SNIPPET_CHARS
    if end < len(flat):
        space = flat.rfind(" ", start, end)
        end = space if space > start else end
    lead = "…" if start > 0 else ""
    piece = flat[start:end]
    marks = ([[m.start() + len(lead), m.end() + len(lead)] for m in pattern.finditer(piece)]
             if pattern else [])
    return lead + piece + ("…" if end < len(flat) else ""), marks


# ---- what a search asks -------------------------------------------------------


def _one(args, name: str, default: str = "") -> str:
    values = args.get(name) or []
    return values[0] if values else default


def _many(args, name: str) -> list[str]:
    """Every value a name was given, repeated or comma separated."""
    out = []
    for value in args.get(name) or []:
        out += [part.strip() for part in value.split(",") if part.strip()]
    return list(dict.fromkeys(out))


def _count(args, name: str, default: int, low: int, high: int) -> int:
    value = _one(args, name)
    if not value:
        return default
    try:
        number = int(value)
    except ValueError:
        raise Refused(f"{name} is a whole number") from None
    if not low <= number <= high:
        raise Refused(f"{name} is from {low} to {high}")
    return number


def _when(value: str, end: bool) -> float:
    """One end of a date range, as seconds since the epoch: seconds as they
    are; a day, YYYY-MM-DD, as its first moment, or for the end of a range
    its last, in this Mac's time zone; or an ISO 8601 time, read in this
    Mac's time zone unless it names its own."""
    value = value.strip()
    try:
        seconds = float(value)
    except ValueError:
        seconds = None
    if seconds is not None:
        if not math.isfinite(seconds):
            raise Refused("from and to take a date (YYYY-MM-DD), a time (ISO 8601) or seconds")
        return seconds
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            day = datetime.strptime(value, "%Y-%m-%d")
            return (day + timedelta(days=1)).timestamp() - 0.001 if end else day.timestamp()
        return datetime.fromisoformat(value).timestamp()
    except (ValueError, OverflowError, OSError):
        raise Refused("from and to take a date (YYYY-MM-DD), a time (ISO 8601) or seconds") from None


def _params(args) -> dict:
    """What one GET /search asks, checked; see the route in server.py."""
    q = _one(args, "q").strip()
    if len(q) > QUERY_MAX:
        raise Refused(f"a query is {QUERY_MAX} characters at most")
    if not _WORD.search(q):
        q = ""   # nothing to search for: the answer lists cards by the filters alone
    mode = _one(args, "mode", "auto")
    if mode not in MODES:
        raise Refused("mode is auto, keyword, semantic or hybrid")
    sections = _many(args, "section")
    if any(s not in SECTIONS for s in sections):
        raise Refused("section is doing, docked, deferred, done or bin")
    lanes = _many(args, "lane")
    if any(len(lane) > LANE_MAX for lane in lanes):
        raise Refused(f"a lane is {LANE_MAX} characters at most")
    date = _one(args, "date", "created")
    if date not in DATES:
        raise Refused("date is created, changed or message")
    since = _when(_one(args, "from"), False) if _one(args, "from") else None
    until = _when(_one(args, "to"), True) if _one(args, "to") else None
    if since is not None and until is not None and since > until:
        raise Refused("from is after to")
    sort = _one(args, "sort", "relevance" if q else "created")
    if sort not in SORTS:
        raise Refused("sort is relevance, created or changed")
    if not q and sort == "relevance":
        sort = "created"   # with no words there is no relevance to sort by
    prefix = _one(args, "prefix", "0")
    if prefix not in ("0", "1"):
        raise Refused("prefix is 0 or 1")
    return {"q": q, "mode": mode, "sections": sections, "lanes": lanes, "date": date,
            "since": since, "until": until, "sort": sort, "prefix": prefix == "1",
            "limit": _count(args, "limit", LIMIT, 1, LIMIT_MAX),
            "offset": _count(args, "offset", 0, 0, TOP_CARDS)}


def _card_filter(p: dict) -> tuple[str, list]:
    """The SQL that keeps the cards a search's filters allow, on cards k."""
    sections = p["sections"] or list(SHOWN)
    where = [f"k.section IN ({','.join('?' * len(sections))})"]
    args: list = list(sections)
    if p["lanes"]:
        where.append(f"k.lane IN ({','.join('?' * len(p['lanes']))})")
        args += p["lanes"]
    if p["date"] in ("created", "changed"):
        # the column is one of the two names above, never the caller's words
        if p["since"] is not None:
            where.append(f"k.{p['date']} >= ?")
            args.append(p["since"])
        if p["until"] is not None:
            where.append(f"k.{p['date']} <= ?")
            args.append(p["until"])
    return " AND ".join(where), args


def _message_filter(p: dict) -> tuple[str, list]:
    """The SQL that keeps the chunks of messages in a search's range, on
    chunks c: only when the range is the messages' own times."""
    if p["date"] != "message" or (p["since"] is None and p["until"] is None):
        return "", []
    where, args = ["c.kind != 'title'"], []
    if p["since"] is not None:
        where.append("c.ts >= ?")
        args.append(p["since"])
    if p["until"] is not None:
        where.append("c.ts <= ?")
        args.append(p["until"])
    return " AND " + " AND ".join(where), args


def _best_per_card(hits) -> list[tuple]:
    """Ranked chunks as ranked cards: each card's first chunk stands for it."""
    seen, ranked = set(), []
    for chunk, card, score in hits:
        if card not in seen:
            seen.add(card)
            ranked.append((card, chunk, score))
    return ranked


def _fuse(keyword: list | None, semantic: list | None) -> list[dict]:
    """The two halves' cards as one list, by reciprocal rank fusion: a card
    scores 1 / (RRF_K + its rank) in each list it is in, summed, so a card
    both halves rank well beats one that only one half ranks first. A card
    keeps the chunk of the half that ranked it higher, the keyword one on a
    tie, since that one has its words marked. With one half there is nothing
    to fuse, and that half's own order and score stand."""
    if semantic is None or keyword is None:
        half, ranked = ("keyword", keyword or []) if semantic is None else ("semantic", semantic)
        return [{"card": card, "chunk": chunk, "score": score, "from": half,
                 "keyword": rank if half == "keyword" else None,
                 "semantic": rank if half == "semantic" else None,
                 "similarity": score if half == "semantic" else None}
                for rank, (card, chunk, score) in enumerate(ranked, 1)]
    merged: dict = {}
    for half, ranked in (("keyword", keyword), ("semantic", semantic)):
        for rank, (card, chunk, score) in enumerate(ranked[:TOP_CARDS], 1):
            entry = merged.setdefault(card, {"card": card, "chunk": chunk, "score": 0.0, "from": half,
                                             "keyword": None, "semantic": None, "similarity": None})
            entry["score"] += 1.0 / (RRF_K + rank)
            entry[half] = rank
            if half == "semantic":
                entry["similarity"] = score
                if entry["keyword"] is None or rank < entry["keyword"]:
                    entry["chunk"], entry["from"] = chunk, "semantic"
    return sorted(merged.values(),
                  key=lambda e: (-e["score"], min(r for r in (e["keyword"], e["semantic"]) if r)))


# ---- the models -----------------------------------------------------------------


def _numpy():
    import numpy
    return numpy


def _unit(np, raw, dims: int):
    """What a model answered, cut to dims and made unit length again. Cutting
    a unit vector leaves it shorter than one, and dot products of uneven
    lengths rank wrongly without saying so, which is the model card's own
    warning; sentence-transformers' truncate_dim cuts after it normalizes,
    so every backend's answer comes through here. A model run in float16
    answers NaN rather than failing, and that is refused here too."""
    vectors = np.asarray(raw, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[1] < dims:
        raise ValueError("the model answered vectors of the wrong shape")
    if not np.isfinite(vectors).all():
        raise ValueError("the model answered numbers that are not finite")
    vectors = np.ascontiguousarray(vectors[:, :dims])
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vectors / norms


class Embedder:
    """What the index asks of a model. load runs once on the index's own
    thread and may take its time. embed takes texts that already carry their
    prefixes and answers one vector for each, dims long or longer, in any
    scale: the index cuts and normalizes every one itself. The signature
    names everything that makes one model's vectors unlike another's, and a
    change of it embeds every chunk again."""

    backend = ""
    modules: tuple = ()   # the packages load imports, besides numpy

    def __init__(self, model: str, dims: int) -> None:
        self.model, self.dims = model, dims

    def load(self) -> None:
        pass

    def embed(self, texts: list[str]):
        raise NotImplementedError

    def signature(self) -> str:
        return f"{self.backend}|{self.model}|{self.dims}|{PREFIX_VERSION}"


# the fake model's whole idea of meaning: words filed under one concept count
# as the same word, so a test can tell a search by meaning from one by words
FAKE_CONCEPTS = {
    "car": "vehicle", "cars": "vehicle", "automobile": "vehicle", "truck": "vehicle",
    "bug": "fault", "bugs": "fault", "error": "fault", "errors": "fault", "crash": "fault",
    "broken": "fault", "defect": "fault",
    "photo": "picture", "photos": "picture", "image": "picture", "images": "picture",
    "picture": "picture", "pictures": "picture",
    "money": "cost", "price": "cost", "budget": "cost", "expensive": "cost", "cost": "cost",
    "sleep": "rest", "tired": "rest", "nap": "rest",
}


def _unprefixed(text: str) -> str:
    if text.startswith(QUERY_PREFIX):
        return text[len(QUERY_PREFIX):]
    found = _DOCUMENT.fullmatch(text)
    if found:
        return ("" if found.group(1) == "none" else found.group(1)) + " " + found.group(2)
    return text


@functools.lru_cache(maxsize=8192)
def _fake_direction(word: str, dims: int):
    np = _numpy()
    seed = int.from_bytes(hashlib.blake2b(word.encode(), digest_size=8).digest(), "big")
    direction = np.random.default_rng(seed).standard_normal(dims).astype(np.float32)
    direction.setflags(write=False)
    return direction


class FakeEmbedder(Embedder):
    """A stand-in model for the tests, and for trying the semantic half on a
    scratch board. Each word, or the concept FAKE_CONCEPTS files it under,
    stands for a direction of its own, random but the same on every run, and
    a text is the sum of its words' directions. Two texts are near when they
    share words or concepts and nearly unrelated otherwise, since random
    directions in this many dimensions are close to perpendicular; that is
    all it knows of meaning. It reads past the prefixes the way the real model
    does, and keeps the last texts it was handed, so a test can see what
    reached it."""

    backend = "fake"

    def __init__(self, model: str = "fake", dims: int = 256, concepts: dict | None = None,
                 delay: float = 0.0) -> None:
        super().__init__(model, dims)
        self.concepts = FAKE_CONCEPTS if concepts is None else concepts
        self.delay = delay
        self.seen: collections.deque = collections.deque(maxlen=10000)

    def embed(self, texts: list[str]):
        np = _numpy()
        if self.delay:
            time.sleep(self.delay)
        self.seen.extend(texts)
        out = np.zeros((len(texts), self.dims), np.float32)
        for row, text in enumerate(texts):
            for word in _WORD.findall(_unprefixed(text).lower()):
                out[row] += _fake_direction(self.concepts.get(word, word), self.dims)
        return out


def _loopback(url: str) -> str:
    """A model's address, refused unless it is on this Mac: what is sent
    there is the board's own words."""
    try:
        parts = urlparse(url)
        host = parts.hostname
    except ValueError:
        parts, host = None, None
    if parts is None or parts.scheme not in ("http", "https") or host not in LOOPBACK:
        raise Unavailable("the model's address must be on this Mac (127.0.0.1 or localhost)")
    return url.rstrip("/")


# a model on this Mac is asked straight, never through a proxy the
# environment names, which would carry the board's words off the machine
_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _post_json(url: str, payload: dict, timeout: float):
    request = urllib.request.Request(url, json.dumps(payload).encode(),
                                     {"Content-Type": "application/json"})
    with _DIRECT.open(request, timeout=timeout) as answer:
        return json.loads(answer.read())


class OllamaEmbedder(Embedder):
    """EmbeddingGemma 2 run by Ollama, asked over its own local API, POST
    /api/embed. The model is pulled beforehand (ollama pull); Ollama keeps it
    loaded for keep_alive after each call."""

    backend = "ollama"

    def __init__(self, model: str = "embeddinggemma-2:270m-q8_0-text", dims: int = 512,
                 url: str = "http://127.0.0.1:11434", timeout: float = 60.0,
                 keep_alive: str = "30m") -> None:
        super().__init__(model, dims)
        self.url, self.timeout, self.keep_alive = _loopback(url), timeout, keep_alive

    def embed(self, texts: list[str]):
        # the vectors come whole and are cut here, the same as every backend's
        answer = _post_json(self.url + "/api/embed",
                            {"model": self.model, "input": list(texts), "truncate": True,
                             "keep_alive": self.keep_alive}, self.timeout)
        vectors = answer.get("embeddings") if isinstance(answer, dict) else None
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            raise ValueError("ollama answered the wrong number of vectors")
        return vectors


class OpenAIEmbedder(Embedder):
    """EmbeddingGemma 2 behind a local server that speaks the OpenAI
    embeddings API, POST /v1/embeddings: llama.cpp's llama-server started
    with --embeddings, or LM Studio."""

    backend = "openai"

    def __init__(self, model: str = "embeddinggemma-2", dims: int = 512,
                 url: str = "http://127.0.0.1:9931", timeout: float = 60.0) -> None:
        super().__init__(model, dims)
        self.url, self.timeout = _loopback(url), timeout

    def embed(self, texts: list[str]):
        answer = _post_json(self.url + "/v1/embeddings",
                            {"model": self.model, "input": list(texts), "encoding_format": "float"},
                            self.timeout)
        rows = answer.get("data") if isinstance(answer, dict) else None
        if not isinstance(rows, list) or len(rows) != len(texts):
            raise ValueError("the model server answered the wrong number of vectors")
        rows = sorted(rows, key=lambda row: row.get("index", 0))
        return [row.get("embedding") for row in rows]


class SentenceTransformersEmbedder(Embedder):
    """EmbeddingGemma 2 run in this process by sentence-transformers 6.1.0 or
    newer, on transformers 5.19.0 or newer and torch, text part only. The
    model is read from the Hugging Face cache, or from a folder model names,
    and never downloaded here: the download is a step of its own
    (docs/search.md)."""

    backend = "sentence-transformers"
    modules = ("torch", "sentence_transformers")

    def __init__(self, model: str = "google/embeddinggemma-2", dims: int = 512,
                 device: str | None = None, dtype: str = "float32") -> None:
        super().__init__(model, dims)
        self.device, self.dtype = device, dtype
        self._model = None

    def load(self) -> None:
        import torch
        from sentence_transformers import SentenceTransformer
        self._model = SentenceTransformer(
            self.model, device=self.device, local_files_only=True,
            # text only: the vision and audio encoders stay unloaded, which
            # is the model card's own setting for a text-only deployment
            config_kwargs={"vision_config": None, "audio_config": None},
            model_kwargs={"dtype": getattr(torch, self.dtype)})

    def embed(self, texts: list[str]):
        # prompt="" keeps the library from putting a prompt of its own in
        # front: the prefixes are on already, and its "Document" prompt
        # would say title: none for every chunk
        return self._model.encode(list(texts), prompt="", batch_size=EMBED_BATCH,
                                  convert_to_numpy=True, show_progress_bar=False)


BACKENDS = {"ollama": OllamaEmbedder, "openai": OpenAIEmbedder,
            "sentence-transformers": SentenceTransformersEmbedder, "fake": FakeEmbedder}
# what each backend may be told in run.config.json, besides embedder and dims
OPTIONS = {"ollama": {"model": str, "url": str, "timeout": (int, float), "keep_alive": str},
           "openai": {"model": str, "url": str, "timeout": (int, float)},
           "sentence-transformers": {"model": str, "device": str, "dtype": str},
           "fake": {"model": str}}


def make_embedder(config) -> Embedder | None:
    """The model run.config.json's "search" entry names, or None when it
    names none (no entry, or an embedder of "none"), which leaves the board
    searching by keyword. An entry that cannot be used raises Unavailable,
    saying what is wrong with it.

        "search": {"embedder": "ollama", "model": "embeddinggemma-2:270m-q8_0-text", "dims": 512}
    """
    if config is None:
        return None
    if not isinstance(config, dict):
        raise Unavailable('the "search" entry in run.config.json is not an object')
    name = config.get("embedder") or "none"
    if name == "none":
        return None
    if name not in BACKENDS:
        raise Unavailable("embedder is none, ollama, openai, sentence-transformers or fake")
    dims = config.get("dims", 512)
    if isinstance(dims, bool) or dims not in DIMENSIONS:
        raise Unavailable("dims is 128, 256, 512 or 768")
    options = {"dims": dims}
    for key, value in config.items():
        if key in ("embedder", "dims"):
            continue
        kind = OPTIONS[name].get(key)
        if kind is None:
            raise Unavailable(f'the {name} embedder takes no "{key}"')
        if isinstance(value, bool) or not isinstance(value, kind):
            raise Unavailable(f'"{key}" is the wrong kind of value')
        options[key] = value
    if options.get("dtype", "float32") not in DTYPES:
        raise Unavailable("dtype is float32 or bfloat16; float16 breaks EmbeddingGemma 2")
    return BACKENDS[name](**options)


class Vectors:
    """The embedded chunks in memory: one row each of a float32 matrix, with
    the chunk's id, its card, its time and whether it is a title kept beside
    it. A chunk embedded again takes its old row; one that goes is marked
    dead, and the rows are packed again once half of them are. Every read
    and write holds lock."""

    def __init__(self, np, dims: int) -> None:
        self.np, self.dims = np, dims
        self.lock = threading.Lock()
        self.size = 0              # rows used, dead ones among them
        self.dead = 0
        self.at: dict = {}         # chunk id -> row
        self.card_ix: dict = {}    # card id -> its number
        self.card_ids: list = []   # number -> card id
        self.mat = np.zeros((0, dims), np.float32)
        self.ids = np.zeros(0, np.int64)
        self.card = np.zeros(0, np.int32)
        self.ts = np.zeros(0, np.float64)
        self.title = np.zeros(0, bool)

    def _room(self, wanted: int) -> None:
        np = self.np
        if wanted <= len(self.ids):
            return
        grown = max(wanted, 2 * len(self.ids), 1024)
        for name, kind, shape in (("mat", np.float32, (grown, self.dims)), ("ids", np.int64, grown),
                                  ("card", np.int32, grown), ("ts", np.float64, grown),
                                  ("title", bool, grown)):
            bigger = np.zeros(shape, kind)
            bigger[:self.size] = getattr(self, name)[:self.size]
            setattr(self, name, bigger)

    def put(self, rows) -> None:
        """rows: (chunk id, card id, time, is a title, vector) each."""
        with self.lock:
            self._room(self.size + len(rows))
            for chunk, card, ts, title, vector in rows:
                ix = self.card_ix.get(card)
                if ix is None:
                    ix = self.card_ix[card] = len(self.card_ids)
                    self.card_ids.append(card)
                row = self.at.get(chunk)
                if row is None:
                    row = self.at[chunk] = self.size
                    self.size += 1
                self.mat[row], self.ids[row], self.card[row] = vector, chunk, ix
                self.ts[row], self.title[row] = ts, title

    def drop(self, chunks) -> None:
        with self.lock:
            for chunk in chunks:
                row = self.at.pop(chunk, None)
                if row is not None:
                    self.ids[row] = -1
                    self.mat[row] = 0
                    self.dead += 1
            if self.dead > 1000 and self.dead * 2 > self.size:
                self._pack()

    def _pack(self) -> None:
        keep = self.np.flatnonzero(self.ids[:self.size] >= 0)
        for name in ("mat", "ids", "card", "ts", "title"):
            column = getattr(self, name)
            column[:len(keep)] = column[keep]
        self.size, self.dead = len(keep), 0
        self.at = {int(chunk): row for row, chunk in enumerate(self.ids[:self.size])}

    def count(self) -> int:
        with self.lock:
            return self.size - self.dead

    def best(self, query, cards=None, since=None, until=None, messages=False,
             top: int = TOP_CHUNKS) -> list[tuple]:
        """The top chunks by similarity to a unit query vector, best first, as
        (chunk id, card id, cosine): among the cards named, when they are, and
        among messages in a time range, when one is given."""
        np = self.np
        with self.lock:
            n = self.size
            if n == 0:
                return []
            scores = self.mat[:n] @ query
            keep = self.ids[:n] >= 0
            if cards is not None:
                allowed = np.zeros(len(self.card_ids) + 1, bool)
                allowed[[self.card_ix[c] for c in cards if c in self.card_ix]] = True
                keep &= allowed[self.card[:n]]
            if messages:
                keep &= ~self.title[:n]
            if since is not None:
                keep &= self.ts[:n] >= since
            if until is not None:
                keep &= self.ts[:n] <= until
            k = min(top, int(keep.sum()))
            if k == 0:
                return []
            scores = np.where(keep, scores, -np.inf)
            pick = np.argpartition(-scores, k - 1)[:k]
            pick = pick[np.argsort(-scores[pick], kind="stable")]
            return [(int(self.ids[i]), self.card_ids[self.card[i]], float(scores[i])) for i in pick]


# ---- the index -------------------------------------------------------------------


def _has_fts5() -> bool:
    try:
        probe = sqlite3.connect(":memory:")
        try:
            probe.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        finally:
            probe.close()
        return True
    except sqlite3.Error:
        return False


def _number(value) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


def _plain_row_text(event: dict, legacy: bool) -> str:
    return event.get("reply_full", event.get("text", ""))


class Index:
    """The search index of one board, and the thread that keeps it current.

    read_cards answers (cards, size) from one held stretch of the board's
    lock: each card on the board and in the Bin as {id, title, lane, section,
    ts, stamp}, and the transcript's size at that same moment. A pass reads
    rows only up to that size, so every row it reads belongs to a card that
    reading knows of, or to one deleted for good, whose rows are passed over.
    row_text and is_boundary are the board's own readers of a reply row and
    of the transcript's schema marker (_row_reply_full and
    _is_reply_schema_boundary in server.py), so a reply is searched by the
    words /thread shows for it.

    config is run.config.json's "search" entry (see make_embedder), and
    embedder a model to use in its place, which is how the tests hand in the
    fake one. packages is the folder of optional packages. fts5 False makes
    the index use the plain scan even where FTS5 is there, for the tests of
    a Python without it. log is the board's _info."""

    def __init__(self, path, transcript, read_cards, *, row_text=None, is_boundary=None,
                 config=None, embedder: Embedder | None = None, packages=None, log=None,
                 fts5: bool | None = None) -> None:
        self.path, self.transcript = Path(path).absolute(), Path(transcript)
        self._read_cards = read_cards
        self._row_text = row_text or _plain_row_text
        self._is_boundary = is_boundary or (lambda event: False)
        self._packages = Path(packages) if packages else None
        self._log = log or (lambda kind, **fields: None)
        self._fts = _has_fts5() if fts5 is None else (fts5 and _has_fts5())
        self._wake = threading.Event()
        self._db: sqlite3.Connection | None = None
        self._cards: dict = {}         # card id -> [title, lane, section, stamp], as indexed
        self._ready = False            # a whole pass has finished since the file opened
        self._building = False
        self._failed: str | None = None
        # off: no model is named. loading: one is named and not ready yet.
        # ready: it answers. unavailable: it did not, and reason says why
        self._embedder = embedder
        self._model_state, self._model_reason = "off", None
        if embedder is None:
            try:
                self._embedder = make_embedder(config)
            except Unavailable as error:
                self._model_state, self._model_reason = "unavailable", str(error)
        if self._embedder is not None:
            self._model_state = "loading"
        self._model_lock = threading.Lock()
        self._retry_at = 0.0
        self._warmed = False
        self._np = None
        self._vectors: Vectors | None = None
        self._queries: collections.OrderedDict = collections.OrderedDict()
        self._queries_lock = threading.Lock()

    # -- the file

    def _connect(self) -> sqlite3.Connection:
        # made for this account alone before SQLite opens it, like the files
        # its words come from; the journal files SQLite makes take its mode
        os.close(os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600))
        os.chmod(self.path, 0o600)
        db = sqlite3.connect(self.path, timeout=5)
        try:
            # pages that hold several vectors: one of 512 floats is half of
            # SQLite's usual 4 KB page, and would leave the other half empty.
            # only a new file takes it, and WAL fixes it from then on
            db.execute("PRAGMA page_size=16384")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")   # derived data: a lost commit is read again
            # the log is copied into the file every 4 MB, SQLite's usual
            # stretch at its usual page size, and not every 16 MB at these pages
            db.execute("PRAGMA wal_autocheckpoint=256")
        except sqlite3.Error:
            db.close()
            raise
        return db

    def _discard(self) -> None:
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(str(self.path) + suffix).unlink(missing_ok=True)

    def _meta(self, db=None) -> dict:
        return dict((db or self._db).execute("SELECT key, value FROM meta"))

    def _set_meta(self, **values) -> None:
        self._db.executemany("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                             [(key, str(value)) for key, value in values.items()])

    def _create(self, db: sqlite3.Connection) -> None:
        with db:
            db.executescript("""
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, lane TEXT NOT NULL,
                                    section TEXT NOT NULL, created REAL NOT NULL,
                                    changed REAL NOT NULL, stamp REAL NOT NULL);
                CREATE TABLE chunks (id INTEGER PRIMARY KEY, card TEXT NOT NULL,
                                     message TEXT NOT NULL, part INTEGER NOT NULL,
                                     kind TEXT NOT NULL, ts REAL NOT NULL, title TEXT NOT NULL,
                                     text TEXT NOT NULL, doc TEXT NOT NULL,
                                     waiting INTEGER NOT NULL DEFAULT 1,
                                     UNIQUE (card, message, part));
                CREATE INDEX chunks_card_ts ON chunks (card, ts);
                CREATE INDEX chunks_waiting ON chunks (id) WHERE waiting = 1;
                -- the model's vectors apart from the words, each added at the
                -- end, so a chunk's row never grows and the pages stay full.
                -- waiting is 1 until a chunk's own words have a vector here
                CREATE TABLE vectors (seq INTEGER PRIMARY KEY, id INTEGER NOT NULL UNIQUE,
                                      vector BLOB NOT NULL);
                CREATE TRIGGER chunks_gone AFTER DELETE ON chunks BEGIN
                    DELETE FROM vectors WHERE id = old.id;
                END;
            """)
            if self._fts:
                # the words live once, in chunks; the full-text table indexes
                # them from there, and the three triggers keep it in step
                db.executescript("""
                    CREATE VIRTUAL TABLE chunks_fts USING fts5 (
                        title, text, content='chunks', content_rowid='id',
                        tokenize='porter unicode61 remove_diacritics 2');
                    CREATE TRIGGER chunks_in AFTER INSERT ON chunks BEGIN
                        INSERT INTO chunks_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
                    END;
                    CREATE TRIGGER chunks_out AFTER DELETE ON chunks BEGIN
                        INSERT INTO chunks_fts (chunks_fts, rowid, title, text)
                            VALUES ('delete', old.id, old.title, old.text);
                    END;
                    CREATE TRIGGER chunks_words AFTER UPDATE OF title, text ON chunks BEGIN
                        INSERT INTO chunks_fts (chunks_fts, rowid, title, text)
                            VALUES ('delete', old.id, old.title, old.text);
                        INSERT INTO chunks_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
                    END;
                """)
            db.executemany("INSERT INTO meta (key, value) VALUES (?, ?)",
                           [("schema", str(SCHEMA)), ("fts", "1" if self._fts else "0"),
                            ("offset", "0"), ("legacy", "1"), ("head", ""), ("headlen", "0"),
                            ("embedder", "")])

    def open(self) -> None:
        """Open the index file on the thread that writes it: made when it is
        missing, and made again when it cannot be read or was laid out by
        another version of this file or for another kind of keyword search."""
        made = not self.path.exists()
        try:
            self._db = self._connect()
            meta = self._meta()
            current = meta.get("schema") == str(SCHEMA) and meta.get("fts") == ("1" if self._fts else "0")
        except sqlite3.DatabaseError:
            current = False
        if not current:
            if self._db is not None:
                self._db.close()
            self._discard()
            self._db = self._connect()
            self._create(self._db)
            if not made:
                self._log("searchindex", step="rebuild")
        self._cards = {row[0]: list(row[1:])
                       for row in self._db.execute("SELECT id, title, lane, section, stamp FROM cards")}

    def _reader(self) -> sqlite3.Connection:
        """A connection of a request's own: it opens a file that is there and
        never makes one, and it writes nothing."""
        db = sqlite3.connect(self.path.as_uri() + "?mode=rw", uri=True, timeout=2)
        db.execute("PRAGMA query_only=1")
        return db

    # -- the passes

    def wake(self) -> None:
        """The board saved: a pass is due. Only sets a flag."""
        self._wake.set()

    def run(self, stopping: threading.Event) -> None:
        """The index's own thread: open the file, make a first pass at once and
        another after every wake, and do the model's work in between."""
        try:
            self.open()
        except Exception as error:
            self._failed = type(error).__name__
            self._log("searchfail", step="open", reason=self._failed)
            return
        self._wake.set()
        try:
            while not stopping.is_set():
                woke = self._wake.wait(RETRY)
                if stopping.is_set():
                    break
                if woke:
                    self._wake.clear()
                    if stopping.wait(QUIET):   # a burst of saves lands before the pass reads it
                        break
                    self._pass()
                if (self._embedder is not None and self._model_state in ("loading", "unavailable")
                        and time.monotonic() >= self._retry_at):
                    self._load_model()
                if self._model_state == "ready":
                    self._embed_safely(stopping)
        finally:
            self._db.close()
            self._db = None

    def _pass(self) -> None:
        started = time.monotonic()
        self._building = True
        try:
            done = self.catch_up()
        except Exception as error:
            self._log("searchfail", step="pass", reason=type(error).__name__)
            return
        finally:
            self._building = False
        if any(done.values()):
            self._log("searchindex", ms=round((time.monotonic() - started) * 1000), **done)

    def catch_up(self) -> dict:
        """One pass: the cards as the board has them now, then each transcript
        row written since the last pass. Answers what changed, in counts."""
        cards, size = self._read_cards()
        done = {"cards": 0, "renamed": 0, "gone": 0, "messages": 0}
        self._take_cards(cards, done)
        self._take_rows(size, done)
        self._ready = True
        return done

    def _take_cards(self, cards: list, done: dict) -> None:
        db, now = self._db, time.time()
        board: dict = {}
        for card in cards:
            cid = card.get("id")
            if isinstance(cid, str) and cid and cid not in board:
                board[cid] = card
        dropped: list = []
        with db:
            for cid in [cid for cid in self._cards if cid not in board]:
                # deleted for good: the card goes, and every word it held
                dropped += [row[0] for row in db.execute("SELECT id FROM chunks WHERE card = ?", (cid,))]
                db.execute("DELETE FROM chunks WHERE card = ?", (cid,))
                db.execute("DELETE FROM cards WHERE id = ?", (cid,))
                del self._cards[cid]
                done["gone"] += 1
            for cid, card in board.items():
                title = str(card.get("title") or "")
                lane = str(card.get("lane") or "")
                section = card.get("section") if card.get("section") in SECTIONS else "doing"
                ts, stamp = _number(card.get("ts")) or now, _number(card.get("stamp"))
                known = self._cards.get(cid)
                if known is None:
                    db.execute("INSERT INTO cards (id, title, lane, section, created, changed, stamp) "
                               "VALUES (?, ?, ?, ?, ?, ?, ?)",
                               (cid, title, lane, section, ts, max(ts, stamp), stamp))
                    if title.strip():
                        self._insert(cid, "", 0, "title", ts, title, title)
                    self._cards[cid] = [title, lane, section, stamp]
                    done["cards"] += 1
                    continue
                if known[0] != title:
                    self._rename(cid, title, ts, dropped)
                    known[0] = title
                    done["renamed"] += 1
                if known[1:] != [lane, section, stamp]:
                    # a move between sections is dated by its own stamp, and
                    # by this pass when the move dropped one: undocking does
                    moved = now if known[2] != section and stamp <= known[3] else 0.0
                    db.execute("UPDATE cards SET lane = ?, section = ?, stamp = ?, "
                               "changed = max(changed, ?, ?) WHERE id = ?",
                               (lane, section, stamp, stamp, moved, cid))
                    known[1:] = [lane, section, stamp]
        if dropped and self._vectors is not None:
            self._vectors.drop(dropped)

    def _insert(self, cid: str, message: str, part: int, kind: str, ts: float,
                title: str, text: str) -> None:
        doc = _document("" if kind == "title" else title, text)
        self._db.execute("INSERT OR IGNORE INTO chunks (card, message, part, kind, ts, title, text, doc) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         (cid, message, part, kind, ts, title, text, _digest(doc)))

    def _rename(self, cid: str, title: str, ts: float, dropped: list) -> None:
        """A card's new title: on its title chunk, and on each of its messages,
        whose keyword rows carry it and whose model form starts with it, so
        those wait to be embedded again. Until they are, the old vectors
        stand in for them."""
        db = self._db
        db.execute("UPDATE cards SET title = ? WHERE id = ?", (title, cid))
        for chunk, kind, text in db.execute("SELECT id, kind, text FROM chunks WHERE card = ?", (cid,)).fetchall():
            if kind == "title":
                if not title.strip():
                    db.execute("DELETE FROM chunks WHERE id = ?", (chunk,))
                    dropped.append(chunk)
                    continue
                text = title
            doc = _digest(_document("" if kind == "title" else title, text))
            db.execute("UPDATE chunks SET title = ?, text = ?, waiting = CASE WHEN doc = ? THEN waiting ELSE 1 END, "
                       "doc = ? WHERE id = ?", (title, text, doc, doc, chunk))
        if title.strip():
            self._insert(cid, "", 0, "title", ts, title, title)   # one with no title chunk yet

    def _take_rows(self, size: int, done: dict) -> None:
        meta = self._meta()
        offset, legacy = int(meta["offset"]), meta["legacy"] == "1"
        try:
            transcript = open(self.transcript, "rb")
        except FileNotFoundError:
            return
        with transcript:
            if size < offset or not self._same_head(transcript, meta):
                # the transcript was replaced or cut short: offsets into the
                # old one mean nothing, so every message is read again
                self._forget_messages()
                offset, legacy = 0, True
                self._log("searchindex", step="reread")
            if size <= offset:
                return
            transcript.seek(offset)
            position, left, rest = offset, size - offset, b""
            batch: list = []
            times: dict = {}
            while left > 0:
                block = transcript.read(min(READ_BLOCK, left))
                if not block:
                    break
                left -= len(block)
                lines = (rest + block).split(b"\n")
                rest = lines.pop()   # after the last newline: not a whole row yet, read next pass
                for line in lines:
                    legacy = self._take_row(line, position, legacy, batch, times)
                    position += len(line) + 1
                    if len(batch) >= ROWS_PER_COMMIT:
                        self._write_rows(batch, times, position, legacy, transcript, done)
                        batch, times = [], {}
                        time.sleep(PAUSE)
            self._write_rows(batch, times, position, legacy, transcript, done)

    def _same_head(self, transcript, meta: dict) -> bool:
        length = int(meta.get("headlen") or 0)
        if not length:
            return True
        transcript.seek(0)
        return hashlib.sha256(transcript.read(length)).hexdigest() == meta["head"]

    def _take_row(self, line: bytes, at: int, legacy: bool, batch: list, times: dict) -> bool:
        """One transcript row into the batch, when it is a message of a card
        this pass knows. Answers whether the rows after it are legacy reply
        rows, which only the schema marker changes, as /thread reads them."""
        try:
            event = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            return legacy
        if not isinstance(event, dict):
            return legacy
        if self._is_boundary(event):
            return False
        cid = event.get("box")
        if not isinstance(cid, str) or cid not in self._cards:
            return legacy
        ts = event.get("ts")
        if isinstance(ts, (int, float)) and not isinstance(ts, bool):
            low, high = times.get(cid, (ts, ts))
            times[cid] = (min(low, ts), max(high, ts))
        kind = event.get("kind")
        if kind in MESSAGE_KINDS:
            text = event.get("text", "") if kind == "user" else self._row_text(event, legacy)
            if isinstance(text, str) and text.strip():
                # a row written twice under one operation id is one event,
                # read once as /thread reads it: the id is the message's name
                op = event.get("op")
                message = f"{kind}:{op}" if isinstance(op, str) and op else f"@{at}"
                batch.append((cid, message, kind, _number(ts), text))
        return legacy

    def _write_rows(self, batch: list, times: dict, position: int, legacy: bool,
                    transcript, done: dict) -> None:
        db = self._db
        meta = self._meta()
        head = {}
        if int(meta.get("headlen") or 0) < HEAD_BYTES:
            transcript_at = transcript.tell()
            transcript.seek(0)
            start = transcript.read(min(position, HEAD_BYTES))
            transcript.seek(transcript_at)
            head = {"head": hashlib.sha256(start).hexdigest(), "headlen": len(start)}
        with db:
            for cid, message, kind, ts, text in batch:
                title = self._cards[cid][0]
                for part, piece in enumerate(_pieces(text)):
                    self._insert(cid, message, part, kind, ts, title, piece)
            db.executemany("UPDATE cards SET created = min(created, ?), changed = max(changed, ?) WHERE id = ?",
                           [(low, high, cid) for cid, (low, high) in times.items()])
            self._set_meta(offset=position, legacy="1" if legacy else "0", **head)
        done["messages"] += len(batch)

    def _forget_messages(self) -> None:
        db = self._db
        with db:
            dropped = [row[0] for row in db.execute("SELECT id FROM chunks WHERE kind != 'title'")]
            db.execute("DELETE FROM chunks WHERE kind != 'title'")
            self._set_meta(offset=0, legacy="1", head="", headlen=0)
        if self._vectors is not None:
            self._vectors.drop(dropped)

    # -- the model

    def _load_model(self) -> None:
        """Load the model named, check it answers, and take every stored vector
        it made into memory. A model unlike the one that made the stored
        vectors (another backend, model, length or prefix) has every chunk
        embedded again. On any failure the reason is kept for
        /search/status, the board goes on by keyword, and it is tried again
        after RETRY."""
        embedder = self._embedder
        self._model_state, self._model_reason = "loading", None
        try:
            packages = self._packages is not None and self._packages.is_dir()
            if packages and str(self._packages) not in sys.path:
                # after the .venv's own, so a package both hold is the board's
                sys.path.append(str(self._packages))
            self._warm(("numpy", *embedder.modules), self._packages if packages else None)
            try:
                np = _numpy()
            except ImportError:
                raise Unavailable("numpy is not installed (see docs/search.md)") from None
            try:
                embedder.load()
            except ImportError:
                raise Unavailable(f"the packages the {embedder.backend} embedder needs are not "
                                  f"installed (see docs/search.md)") from None
            with self._model_lock:
                _unit(np, embedder.embed([QUERY_PREFIX + "probe"]), embedder.dims)
        except Unavailable as error:
            self._model_unavailable(str(error))
            return
        except Exception as error:
            self._model_unavailable(f"the model did not answer ({type(error).__name__})")
            return
        signature = embedder.signature()
        if self._meta().get("embedder") != signature:
            with self._db:
                self._db.execute("DELETE FROM vectors")
                self._db.execute("UPDATE chunks SET waiting = 1 WHERE waiting = 0")
                self._set_meta(embedder=signature)
        vectors = Vectors(np, embedder.dims)
        rows = self._db.execute("SELECT c.id, c.card, c.ts, c.kind, v.vector FROM vectors v "
                                "JOIN chunks c ON c.id = v.id ORDER BY v.seq")
        width = embedder.dims * 4
        while True:
            some = rows.fetchmany(5000)
            if not some:
                break
            vectors.put([(chunk, card, ts, kind == "title", np.frombuffer(blob, np.float32))
                         for chunk, card, ts, kind, blob in some if len(blob) == width])
        self._np, self._vectors = np, vectors
        self._model_state = "ready"
        self._log("searchmodel", state="ready", backend=embedder.backend, dims=embedder.dims,
                  vectors=vectors.count())

    def _warm(self, modules: tuple, packages) -> None:
        """Import the model's packages in a child process, once, before this
        one does. The first load of a package's native libraries after it is
        installed can take seconds, the operating system checking each one,
        and this process would spend them holding the interpreter's lock that
        the board's requests wait on. A child pays that, and the import here
        finds them ready. A child that fails or cannot start changes nothing:
        the import here says why."""
        if self._warmed or not sys.executable:
            return
        self._warmed = True
        code = ("import sys; sys.path.append(sys.argv[1]) if sys.argv[1] else None; " +
                "; ".join(f"import {name}" for name in modules))
        bytecode = ["-B"] if sys.flags.dont_write_bytecode else []
        try:
            subprocess.run([sys.executable, *bytecode, "-c", code, str(packages or "")],
                           capture_output=True, timeout=300, check=False)
        except (OSError, subprocess.SubprocessError):
            pass

    def _model_unavailable(self, reason: str) -> None:
        self._model_state, self._model_reason = "unavailable", reason
        self._retry_at = time.monotonic() + RETRY
        self._log("searchmodel", state="unavailable", backend=self._embedder.backend)

    def _embed_safely(self, stopping) -> None:
        try:
            self.embed_pending(stopping)
        except Exception as error:
            self._model_unavailable(f"the model did not answer ({type(error).__name__})")

    def embed_pending(self, stopping: threading.Event | None = None, limit: int | None = None) -> int:
        """Embed the chunks still waiting for a vector, newest first,
        EMBED_BATCH at a time and each batch committed as it is done, so a
        stop loses one batch at most and the next start carries on. On the
        index's own thread it stops early once the board has saved again, so
        new words are searchable by keyword before the backlog is done.
        Answers how many it embedded."""
        if self._model_state != "ready":
            return 0
        np, embedder, db, total = self._np, self._embedder, self._db, 0
        while limit is None or total < limit:
            if stopping is not None and (stopping.is_set() or self._wake.is_set()):
                break
            rows = db.execute("SELECT id, card, ts, kind, title, text FROM chunks "
                              "WHERE waiting = 1 ORDER BY id DESC LIMIT ?", (EMBED_BATCH,)).fetchall()
            if not rows:
                break
            docs = [_document("" if kind == "title" else title, text) for _, _, _, kind, title, text in rows]
            with self._model_lock:
                vectors = _unit(np, embedder.embed(docs), embedder.dims)
            with db:
                db.executemany("INSERT OR REPLACE INTO vectors (id, vector) VALUES (?, ?)",
                               [(row[0], vector.tobytes()) for row, vector in zip(rows, vectors)])
                db.executemany("UPDATE chunks SET waiting = 0 WHERE id = ?", [(row[0],) for row in rows])
            self._vectors.put([(chunk, card, ts, kind == "title", vector)
                               for (chunk, card, ts, kind, _, _), vector in zip(rows, vectors)])
            total += len(rows)
            if stopping is not None:
                time.sleep(PAUSE)
        return total

    def _query_vector(self, text: str):
        with self._queries_lock:
            if text in self._queries:
                self._queries.move_to_end(text)
                return self._queries[text]
        if not self._model_lock.acquire(timeout=QUERY_WAIT):
            raise Busy()
        try:
            vector = _unit(self._np, self._embedder.embed([QUERY_PREFIX + text]), self._embedder.dims)[0]
        finally:
            self._model_lock.release()
        with self._queries_lock:
            self._queries[text] = vector
            while len(self._queries) > QUERY_CACHE:
                self._queries.popitem(last=False)
        return vector

    # -- searching

    def search(self, args) -> tuple[int, dict]:
        """GET /search: args are the query's names, each with a list of values.
        See the route in server.py for what it asks and answers."""
        started = time.monotonic()
        try:
            p = _params(args)
        except Refused as error:
            return 400, {"error": str(error)}
        if self._failed:
            return 503, {"error": "the search index could not be opened"}
        try:
            db = self._reader()
        except sqlite3.Error:
            db = None
        try:
            try:
                answer = self._ask(db, p) if db is not None else None
            except sqlite3.OperationalError:
                if self._ready:
                    raise
                answer = None   # the file is still being made
            if answer is None:
                answer = {"mode": "filter" if not p["q"] else "keyword", "results": [], "total": 0}
            answer.update({"q": p["q"], "limit": p["limit"], "offset": p["offset"],
                           "index": self._brief(db), "ms": round((time.monotonic() - started) * 1000)})
            return 200, answer
        finally:
            if db is not None:
                db.close()

    def _ask(self, db, p: dict) -> dict:
        if not p["q"]:
            return self._listing(db, p)
        ready = self._model_state == "ready" and self._vectors is not None and self._vectors.count() > 0
        mode, fallback = p["mode"], None
        if mode == "auto":
            mode = "hybrid" if ready else "keyword"
        elif not ready and mode in ("semantic", "hybrid"):
            mode, fallback = "keyword", self._why_not()
        keyword = semantic = None
        words, match = "all", None
        if mode in ("semantic", "hybrid"):
            try:
                semantic = self._semantic(db, p)
            except Busy:
                fallback = "the model was busy; this search ran by keyword"
            except Exception as error:
                self._model_unavailable(f"the model did not answer ({type(error).__name__})")
                fallback = self._why_not()
            if semantic is None:
                mode = "keyword"
        if mode in ("keyword", "hybrid"):
            keyword, words, match = self._keyword(db, p)
        fused = _fuse(keyword, semantic)
        if p["sort"] != "relevance" and fused:
            times = dict(db.execute(f"SELECT id, {p['sort']} FROM cards WHERE id IN "
                                    f"({','.join('?' * len(fused))})", [e["card"] for e in fused]))
            fused.sort(key=lambda e: -times.get(e["card"], 0))
        answer = {"mode": mode, "results": self._results(db, fused[p["offset"]:p["offset"] + p["limit"]],
                                                         match, _words(p["q"])),
                  "total": len(fused)}
        if keyword is not None:
            answer["words"] = words
        if fallback:
            answer["fallback"] = fallback
        return answer

    def _why_not(self) -> str:
        if self._model_state == "off":
            return "no model is set up for searching by meaning (see docs/search.md)"
        if self._model_state == "loading":
            return "the model is still loading"
        if self._model_state == "ready":
            return "no chunk is embedded yet"
        return self._model_reason or "the model is not available"

    def _keyword(self, db, p: dict) -> tuple[list, str, str | None]:
        """The keyword half: every word in one chunk, the card's title counting
        as part of each of its chunks, and when no chunk has them all, any of
        them. Ranked by BM25 with the title worth twice the text, or under the
        plain scan by how many of the words a chunk holds, titles first."""
        terms = _terms(p["q"], p["prefix"])
        if not terms:
            return [], "all", None
        where, args = _card_filter(p)
        chunk_where, chunk_args = _message_filter(p)
        ranked, words, match = [], "all", None
        for words, joiner in (("all", " "), ("any", " OR ")):
            if self._fts:
                match = joiner.join(terms)
                rows = db.execute(
                    "SELECT c.id, c.card, -bm25(chunks_fts, 2.0, 1.0) FROM chunks_fts "
                    "JOIN chunks c ON c.id = chunks_fts.rowid JOIN cards k ON k.id = c.card "
                    f"WHERE chunks_fts MATCH ? AND {where}{chunk_where} ORDER BY 3 DESC LIMIT ?",
                    [match, *args, *chunk_args, KEYWORD_ROWS]).fetchall()
            else:
                rows = self._scan(db, _words(p["q"]), words == "all", where + chunk_where,
                                  args + chunk_args)
            ranked = _best_per_card(rows)
            if ranked or len(terms) == 1:
                break
        return ranked[:TOP_CARDS], words, match

    def _scan(self, db, words: list, every: bool, where: str, args: list) -> list:
        """The keyword half where SQLite has no FTS5: LIKE over each chunk's
        words and its card's title. LIKE folds case for ASCII letters only."""
        if not words:
            return []
        def like(word):
            return "%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        one = "(c.text LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')"
        held = " + ".join("(instr(lower(c.text), ?) > 0)" for _ in words)
        return db.execute(
            f"SELECT c.id, c.card, {held} AS score FROM chunks c JOIN cards k ON k.id = c.card "
            f"WHERE ({(' AND ' if every else ' OR ').join([one] * len(words))}) AND {where} "
            "ORDER BY score DESC, c.kind = 'title' DESC, c.ts DESC LIMIT ?",
            [*words, *[v for w in words for v in (like(w), like(w))], *args, KEYWORD_ROWS]).fetchall()

    def _semantic(self, db, p: dict) -> list:
        """The semantic half: the query's vector against every embedded chunk
        the filters allow, best chunk per card."""
        vector = self._query_vector(p["q"])
        where, args = _card_filter(p)
        cards = {row[0] for row in db.execute(f"SELECT id FROM cards k WHERE {where}", args)}
        messages = p["date"] == "message" and (p["since"] is not None or p["until"] is not None)
        hits = self._vectors.best(vector, cards, p["since"] if messages else None,
                                  p["until"] if messages else None, messages)
        return _best_per_card(hits)[:TOP_CARDS]

    def _results(self, db, page: list, match: str | None, words: list) -> list:
        if not page:
            return []
        cards = {row[0]: row for row in db.execute(
            "SELECT id, title, lane, section, created, changed FROM cards WHERE id IN "
            f"({','.join('?' * len(page))})", [e["card"] for e in page])}
        chunks = {row[0]: row for row in db.execute(
            "SELECT id, message, kind, ts, text FROM chunks WHERE id IN "
            f"({','.join('?' * len(page))})", [e["chunk"] for e in page])}
        snippets = {}
        marked = [e["chunk"] for e in page if e["from"] == "keyword"]
        if match and self._fts and marked:
            for chunk, snippet in db.execute(
                    "SELECT rowid, snippet(chunks_fts, 1, ?, ?, '…', ?) FROM chunks_fts "
                    f"WHERE chunks_fts MATCH ? AND rowid IN ({','.join('?' * len(marked))})",
                    [OPEN, SHUT, SNIPPET_TOKENS, match, *marked]):
                snippets[chunk] = _marked(snippet)
        out = []
        for entry in page:
            card, chunk = cards.get(entry["card"]), chunks.get(entry["chunk"])
            if card is None or chunk is None:
                continue   # gone between the ranking and this read
            snippet, marks = snippets.get(chunk[0]) or _window(chunk[4], words)
            found = "hybrid" if entry["keyword"] and entry["semantic"] else entry["from"]
            out.append({**self._card(card), "score": round(entry["score"], 6), "mode": found,
                        "ranks": {"keyword": entry["keyword"], "semantic": entry["semantic"]},
                        "similarity": None if entry["similarity"] is None else round(entry["similarity"], 6),
                        "match": self._match(chunk, snippet, marks)})
        return out

    @staticmethod
    def _card(row) -> dict:
        cid, title, lane, section, created, changed = row
        return {"card": cid, "title": title, "lane": lane, "section": section,
                "created": created, "changed": changed}

    @staticmethod
    def _match(chunk, snippet: str, marks: list) -> dict:
        _, message, kind, ts, _ = chunk
        return {"kind": kind, "message": message or None, "ts": ts, "snippet": snippet, "marks": marks}

    def _listing(self, db, p: dict) -> dict:
        """A search with no words: the cards its filters allow, newest first by
        when they were made, or by when they last changed. With the range on
        the messages' own times, the cards with a message in it, each with the
        latest such message as its match."""
        where, args = _card_filter(p)
        chunk_where, chunk_args = _message_filter(p)
        latest = "NULL"
        if chunk_where:
            inner = f"FROM chunks c WHERE c.card = k.id{chunk_where}"
            where += f" AND EXISTS (SELECT 1 {inner})"
            args += chunk_args
            latest = f"(SELECT c.id {inner} ORDER BY c.ts DESC LIMIT 1)"
        total = db.execute(f"SELECT count(*) FROM cards k WHERE {where}", args).fetchone()[0]
        rows = db.execute(
            f"SELECT k.id, k.title, k.lane, k.section, k.created, k.changed, {latest} FROM cards k "
            f"WHERE {where} ORDER BY k.{p['sort']} DESC, k.id LIMIT ? OFFSET ?",
            [*(chunk_args if chunk_where else []), *args, p["limit"], p["offset"]]).fetchall()
        ids = [row[6] for row in rows if row[6] is not None]
        chunks = {row[0]: row for row in db.execute(
            f"SELECT id, message, kind, ts, text FROM chunks WHERE id IN ({','.join('?' * len(ids))})", ids)} if ids else {}
        results = []
        for row in rows:
            chunk = chunks.get(row[6])
            results.append({**self._card(row[:6]), "score": None, "mode": "filter",
                            "ranks": None, "similarity": None,
                            "match": self._match(chunk, *_window(chunk[4], [])) if chunk else None})
        return {"mode": "filter", "results": results, "total": total}

    # -- what it holds

    def _brief(self, db) -> dict:
        """The few facts about the index a search answer carries with it."""
        waiting = None
        if db is not None and self._model_state == "ready":
            try:
                waiting = db.execute("SELECT count(*) FROM chunks WHERE waiting = 1").fetchone()[0]
            except sqlite3.Error:
                pass
        return {"ready": self._ready, "building": self._building, "semantic": self._model_state,
                "embedded": self._vectors.count() if self._vectors is not None else 0,
                "waiting": waiting}

    def status(self) -> dict:
        """GET /search/status: whether the index is built and current, what it
        holds, which keyword search this SQLite gives, and where the semantic
        half stands and why."""
        info = {"ready": self._ready, "building": self._building,
                "keyword": "fts5" if self._fts else "like",
                "cards": 0, "binned": 0, "messages": 0, "chunks": 0, "file": self.path.name}
        if self._failed:
            info["error"] = "the search index could not be opened"
        embedder = self._embedder
        semantic = {"state": self._model_state, "reason": self._model_reason,
                    "backend": embedder.backend if embedder else None,
                    "model": embedder.model if embedder else None,
                    "dims": embedder.dims if embedder else None,
                    "embedded": self._vectors.count() if self._vectors is not None else 0,
                    "waiting": None}
        try:
            db = self._reader()
        except sqlite3.Error:
            db = None
        if db is not None:
            try:
                info["cards"] = db.execute("SELECT count(*) FROM cards WHERE section != 'bin'").fetchone()[0]
                info["binned"] = db.execute("SELECT count(*) FROM cards WHERE section = 'bin'").fetchone()[0]
                info["chunks"] = db.execute("SELECT count(*) FROM chunks").fetchone()[0]
                info["messages"] = db.execute(
                    "SELECT count(*) FROM (SELECT 1 FROM chunks WHERE kind != 'title' "
                    "GROUP BY card, message)").fetchone()[0]
                if embedder is not None:   # with no model named, nothing waits for one
                    semantic["waiting"] = db.execute(
                        "SELECT count(*) FROM chunks WHERE waiting = 1").fetchone()[0]
            except sqlite3.Error:
                pass
            finally:
                db.close()
        info["semantic"] = semantic
        return info
