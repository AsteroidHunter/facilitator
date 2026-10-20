#!/usr/bin/env python3
"""`facilitator magic` for an agent on one of the owner's servers.

The facilitator command is the Mac's, and the board is there; on a server,
where the setup program (scripts/pair.py) put this skill in
~/.facilitator/skill with remote.json beside it, this takes the same words
and sends them to the board's agent door, as the runbook's curl lines go,
with the key of the lane whose card it names, kept in
~/.facilitator/agents/<lane>.key since that lane's agent joined. The door
lets a lane's key reach that lane's cards alone. The content is read here,
so the board is handed bytes and never a path. Prints the board's answer as
one JSON line, or exits 1 with the board's words; never a key or the
board's address. Runs on python3 3.7 and newer, standard library only."""

import http.client
import json
import re
import select
import sys
import urllib.parse
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
REMOTE_FILE = REPO / "remote.json"
LANE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,99}")
TIMEOUT = 60      # seconds: the board asks a website within its own 15 before it answers
PIECE = 64 * 1024     # bytes sent at a time, looking for an early answer between them

MAGIC_KINDS = ("text", "markdown", "html", "image", "url")
MAGIC_ACTIONS = ("close", "reopen", "show")
MAGIC_HELP = """usage: magic.py CARD KIND (CONTENT | --file PATH | -) [--title TITLE]
       magic.py CARD close|reopen|show

On one of the owner's servers, what `facilitator magic` is on the Mac, with
the same words. Fill a card's magic box on the Mac board and open it, in
place of what it held. KIND is text, markdown, html, image or url. CONTENT
is the words, or one https address for url and image; --file sends a file's
contents (a picture's bytes for image) and - reads standard input. close
hides the box and keeps it, reopen shows it again, show prints what it
holds. Prints the board's answer as one JSON line; exits 1 with the board's
words when it refuses."""


class LinkDown(Exception):
    """The board's door does not answer: the tailnet, the Mac or the board is
    away."""


def remote_record():
    """remote.json, which the setup program wrote beside this skill on a
    server: {server, name, board, home}. None on the Mac."""
    try:
        rec = json.loads(REMOTE_FILE.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or not isinstance(rec.get("home"), str) or not rec["home"].startswith("/"):
        return None
    if not isinstance(rec.get("board"), str) or not re.fullmatch(r"https?://[^/?#\s]+", rec["board"]):
        return None
    return rec


def lane_keys(rec):
    """The lane keys this account holds, by lane name."""
    out = []
    for held in sorted((Path(rec["home"]) / "agents").glob("*.key")):
        if not LANE_ID.fullmatch(held.stem):
            continue
        try:
            key = held.read_text().strip()
        except OSError:
            continue
        if key:
            out.append(key)
    return out


def send_body(conn, body):
    """The body in pieces, stopping once the board has answered: it refuses
    a body it will not take before reading it, and a client still sending
    then may lose that answer."""
    view = memoryview(body)
    try:
        for at in range(0, len(body), PIECE):
            if select.select([conn.sock], [], [], 0)[0]:
                return
            conn.sock.sendall(view[at:at + PIECE])
    except OSError:
        pass   # the board closed early; its answer, if any, is read next


def ask(rec, method, route, key, body=None):
    """(status, answer) from the board's door; LinkDown when nothing answers.
    http.client asks no proxy, so the key goes nowhere but the door."""
    door = urllib.parse.urlsplit(rec["board"])
    kind = http.client.HTTPSConnection if door.scheme == "https" else http.client.HTTPConnection
    try:
        conn = kind(door.hostname, door.port, timeout=TIMEOUT)
    except ValueError:
        raise LinkDown()
    try:
        conn.putrequest(method, route, skip_accept_encoding=True)
        conn.putheader("Authorization", "Bearer " + key)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        if body:
            send_body(conn, body)
        response = conn.getresponse()
        raw, status = response.read(), response.status
    except (OSError, ValueError, http.client.HTTPException):
        raise LinkDown()
    finally:
        conn.close()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def refusal(status, answer):
    """The board's own words for a refusal, as the Mac's command prints them."""
    said = answer.get("error") if isinstance(answer, dict) else None
    return "magic: " + (said if isinstance(said, str) and said else "the board answered " + str(status))


def main(argv):
    words = argv[1:]
    if words in ([], ["-h"], ["--help"]):
        if words:
            print(MAGIC_HELP)
            return
        sys.exit(MAGIC_HELP)
    title, path, rest = None, None, []
    at = 0
    while at < len(words):
        word = words[at]
        if word in ("--title", "--file"):
            if at + 1 == len(words):
                sys.exit("magic: " + word + " needs a value")
            if word == "--title":
                title = words[at + 1]
            else:
                path = words[at + 1]
            at += 2
            continue
        rest.append(word)
        at += 1
    if len(rest) < 2:
        sys.exit(MAGIC_HELP)
    card, what, content = rest[0], rest[1], rest[2:]
    if what in MAGIC_ACTIONS:
        if content or path is not None or title is not None:
            sys.exit("magic: " + what + " takes only the card")
        method, route, body, query = ("GET" if what == "show" else "POST",
                                      "/magic" if what == "show" else "/magic/" + what,
                                      None if what == "show" else b"", {"box": card})
    elif what in MAGIC_KINDS:
        if len(content) + (path is not None) != 1:
            sys.exit("magic: give the content once: as one argument, as --file PATH, or as - to read standard input")
        if path is not None:
            try:
                body = Path(path).expanduser().read_bytes()
            except OSError as error:
                sys.exit("magic: " + path + " cannot be read: " + (error.strerror or str(error)))
        elif content[0] == "-":
            body = sys.stdin.buffer.read()
        else:
            body = content[0].encode("utf-8")
        method, route, query = "POST", "/magic", {"box": card, "kind": what}
        if title is not None:
            query["title"] = title
    else:
        sys.exit("magic: " + what + " is not one of " + ", ".join(MAGIC_KINDS) + ", " + ", ".join(MAGIC_ACTIONS))
    rec = remote_record()
    if rec is None:
        sys.exit("magic: this is not one of the owner's servers; on the Mac run facilitator magic")
    keys = lane_keys(rec)
    if not keys:
        sys.exit("magic: no lane on this server has a key yet: onboard first")
    look = "/magic?" + urllib.parse.urlencode({"box": card})
    try:
        # the door lets only the card's own lane's key read its box, so each
        # key held here is tried with that reading, which changes nothing,
        # until one is let through; nothing is sent with a key it refuses
        chosen, refused = None, None
        for key in keys:
            status, answer = ask(rec, "GET", look, key)
            if status not in (401, 403):
                chosen = key
                break
            if refused is None or status == 403:
                refused = (status, answer)
        if chosen is None:
            sys.exit(refusal(*refused))
        if what != "show":
            status, answer = ask(rec, method, route + "?" + urllib.parse.urlencode(query), chosen, body)
    except LinkDown:
        sys.exit("magic: the board cannot be reached now (the Mac asleep, Tailscale or the board down); "
                 "try again in a minute")
    if status != 200 or not isinstance(answer, dict):
        sys.exit(refusal(status, answer))
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
