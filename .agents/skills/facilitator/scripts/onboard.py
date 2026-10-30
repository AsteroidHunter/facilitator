#!/usr/bin/env python3
"""Resolve this checkout's board lane and receive one confirmed claim.

On the Mac every call carries the board's agent key, which the board keeps in
data/agent.key with a curl config beside it, data/agent.curl, and inspect
names that file for the runbook's curl lines once the board has made it.

On one of the owner's servers, where the setup program (scripts/pair.py) put
this skill in ~/.facilitator/skill with remote.json beside it, the board is
on the owner's Mac and is reached by connecting out to its agent door over
the tailnet, never by the Mac logging in here. inspect makes sure this
server's link runs (scripts/link.py), then joins the lane with the server's
key, which gives this agent a key of its own for the lane, kept in
~/.facilitator/agents/<lane>.key with a curl config beside it (both for this
account alone); wait listens with that key, and keeps trying through a drop
until its own deadline. Runs on python3 3.7 and newer.

wait --reply CARD, with the reply on standard input, answers CARD and listens
again in one command: it reads /fresh first and posts nothing when anything
came that the reply has not seen, and otherwise posts the reply to /reply and
then makes the same listen as wait, whose result it gives in next."""

import argparse
import errno
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


REPO = Path(__file__).resolve().parents[4]
RUNBOOK = REPO / "app" / "RUNBOOK.md"
PROFILE = REPO / "data" / "profile.json"
AGENT_KEY = REPO / "data" / "agent.key"
AGENT_CURL = REPO / "data" / "agent.curl"
REMOTE_FILE = REPO / "remote.json"
LINK = Path(__file__).resolve().parent / "link.py"
LISTEN_SECONDS = 420
CLIENT_SLACK = 10
LINK_RETRY = 3          # seconds between tries while the board cannot be reached
ACK_PATIENCE = 60       # seconds an ack is tried again through a drop
WAIT_CYCLE = 25         # seconds one /wait call from a server may last
REMOTE_BASE = "http://board"   # what an agent on a server writes for the board
LANE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,99}")
# the shape of the keys the board makes (43 of these characters): a key of
# any other shape is refused before it is kept, since a lane's key goes
# into a curl config
KEY_SHAPE = re.compile(r"[A-Za-z0-9_-]{20,100}")
# a name the board keeps (server.py's _clean_text): at most 200 characters,
# and no control character other than a tab or a new line
NAME_MAX = 200
NAME_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def result(status, **fields):
    """One answer of this helper, as the object it prints."""
    if status == "permission_denied":
        fields.setdefault("detail", "Access to the local board was denied by the operating system or sandbox.")
    elif status == "connection_error":
        fields.setdefault("detail", "The local board could not be reached; its state is unknown.")
    return {"status": status, **fields}


def show(said):
    print(json.dumps(said, ensure_ascii=False))


def output(status, **fields):
    show(result(status, **fields))


def config_file():
    """data/run.config.json; the checkout's top until the update has moved
    the board's files into data/."""
    moved = REPO / "data" / "run.config.json"
    return moved if moved.exists() else REPO / "run.config.json"


def port():
    try:
        value = json.loads(config_file().read_text()).get("port", 8877)
        number = int(value)
        if 1 <= number <= 65535:
            return number
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return 8877


def first_name(name):
    """The first word of a name, as typed, or None for no name: a profile
    may hold a first name alone or a full one, and an agent is given only
    the first."""
    if not isinstance(name, str) or NAME_CONTROL.search(name) or len(name.strip()) > NAME_MAX:
        return None
    words = name.split()
    return words[0] if words else None


def profile_name():
    """The first name in the board's profile (data/profile.json), read the
    way the board reads the name, and nothing else of the profile."""
    try:
        name = json.loads(PROFILE.read_text(encoding="utf-8")).get("name")
    except (OSError, ValueError, AttributeError):
        return None
    return first_name(name)


def agent_key():
    """The board's agent key (data/agent.key), or None when there is none
    this helper can read."""
    try:
        key = AGENT_KEY.read_text().strip()
    except OSError:
        return None
    return key if KEY_SHAPE.fullmatch(key) else None


def request(method, route, *, timeout=3, data=None):
    """One call to the board's own port with its agent key, never through a
    proxy, which would be handed the key. data is the body, as bytes."""
    url = f"http://127.0.0.1:{port()}{route}"
    key = agent_key()
    headers = {"Authorization": "Bearer " + key} if key else {}
    with OPENER.open(urllib.request.Request(url, data=data, method=method, headers=headers),
                     timeout=timeout) as response:
        return json.load(response)


def connection_status(problem):
    """Classify the transport cause, which urlopen usually wraps in URLError.

    Only an explicit connection refusal means down; denied access and an
    inconclusive failure say nothing about whether the board is running.
    """
    while isinstance(problem, urllib.error.URLError) and isinstance(problem.reason, BaseException):
        problem = problem.reason
    if isinstance(problem, PermissionError) or getattr(problem, "errno", None) in (errno.EPERM, errno.EACCES):
        return "permission_denied"
    if getattr(problem, "errno", None) == errno.ECONNREFUSED:
        return "down"
    return "connection_error"


def board():
    try:
        state = request("GET", "/state")
    except urllib.error.HTTPError as refused:
        if refused.code == 401:
            return None, "key_refused"
        return None, "different_server"
    except ValueError:
        return None, "different_server"
    except OSError as problem:
        return None, connection_status(problem)
    if not isinstance(state, dict) or not all(
        isinstance(state.get(key), dict) for key in ("pwds", "busy", "listening", "listenerGap")
    ) or not isinstance(state.get("pwd"), str):
        return None, "different_server"
    if Path(state["pwd"]).resolve() != REPO:
        return None, "different_board"
    return state, None


def refused_words(problem):
    """The detail a refused key gets on the Mac."""
    if problem != "key_refused":
        return {}
    return {"detail": "the board on this port did not take this folder's agent key "
                      f"({AGENT_KEY}): it is another folder's board, or that file cannot be "
                      "read here; report it"}


def common_git_dir(path):
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return Path(result.stdout.strip()).resolve() if result.returncode == 0 and result.stdout.strip() else None


def resolve_path(state, requested):
    path = Path(requested).expanduser().resolve()
    if not path.is_dir():
        return [], "path_missing"
    # a project on one of the owner's servers names a path on that server,
    # which on this Mac is some other folder or none
    elsewhere = {p.get("id") for p in state.get("projects", []) if isinstance(p, dict) and p.get("server")}
    roots = []
    for owner, raw in state["pwds"].items():
        if isinstance(owner, str) and isinstance(raw, str) and owner in state["busy"] and owner not in elsewhere:
            roots.append((owner, Path(raw).expanduser().resolve()))
    containing = [(owner, root) for owner, root in roots if path == root or root in path.parents]
    if containing:
        depth = max(len(root.parts) for _, root in containing)
        return sorted(owner for owner, root in containing if len(root.parts) == depth), None
    source_git = common_git_dir(path)
    if source_git is not None:
        matches = [owner for owner, root in roots if common_git_dir(root) == source_git]
        if matches:
            return sorted(matches), None
    return [], "project_unknown"


def resolve_board(state, name):
    owners = list(state["busy"])
    exact = [owner for owner in owners if owner == name]
    if exact:
        return exact
    matches = [owner for owner in owners if owner.casefold() == name.casefold()]
    matches.extend(
        project["id"] for project in state.get("projects", [])
        if isinstance(project, dict) and isinstance(project.get("id"), str)
        and isinstance(project.get("name"), str) and project["id"] in owners
        and project["name"].casefold() == name.casefold()
    )
    return sorted(set(matches))


# ---- on one of the owner's servers ----------------------------------------------

class LinkDown(Exception):
    """The board's door does not answer: the tailnet, the Mac or the board is
    away."""


class Blocked(LinkDown):
    """The operating system or a sandbox did not let this process connect to
    the board's door, which says nothing about whether the board is up, and
    trying again in the same place does not help."""


BLOCKED = "Access to the board on the owner's Mac was denied by the operating system or sandbox."


# no proxy, ever: a proxy named in this account's settings would be handed
# the lane's key with every call
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def remote_record():
    """remote.json, which the setup program (scripts/pair.py) wrote beside
    this skill on a server: {server, name, board, home}. None on the Mac."""
    try:
        rec = json.loads(REMOTE_FILE.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or not isinstance(rec.get("home"), str) or not rec["home"].startswith("/"):
        return None
    if not isinstance(rec.get("board"), str) or not re.fullmatch(r"https?://[^/?#\s]+", rec["board"]):
        return None
    return rec


def remote_request(rec, method, route, key, body=None, timeout=10, raw=None):
    """(status, answer) from the board's door; LinkDown when nothing answers.
    body goes as JSON, raw as the bytes it is."""
    data = json.dumps(body).encode() if body is not None else raw
    headers = {"Authorization": "Bearer " + key}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(rec["board"].rstrip("/") + route, data=data, method=method, headers=headers)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as refused:
        with refused:
            raw, status = refused.read(), refused.code
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as problem:
        if connection_status(problem) == "permission_denied":
            raise Blocked(BLOCKED)
        reason = getattr(problem, "reason", problem)
        raise LinkDown(getattr(reason, "strerror", None) or type(reason).__name__)
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def ensure_link(rec):
    """This server's link to the board (scripts/link.py), started when it is
    not running, so the folder picker reaches this server whenever an agent
    here has joined."""
    try:
        subprocess.run([sys.executable, "-B", str(LINK), "start", "--quiet"], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    except (OSError, subprocess.SubprocessError):
        pass


def private_write(path, text):
    """Written whole, for this account alone."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(text)
    os.replace(str(tmp), str(path))


def key_files(rec, owner):
    agents = Path(rec["home"]) / "agents"
    return agents / (owner + ".key"), agents / (owner + ".curl")


def remote_base(rec):
    """The address an agent here writes in its curl lines. For the board's
    plain address it is REMOTE_BASE, which the curl config sends on to the
    board, so the board's real address stays in that file."""
    return REMOTE_BASE if rec["board"].startswith("http://") else rec["board"].rstrip("/")


def save_key(rec, owner, key):
    """The lane's key, and a curl config that carries it, sends the runbook's
    curl lines on to the board's door and never through a proxy, so they
    work with -K and the key never shows in ps. A key of any other shape
    than the board's is refused, and nothing is written."""
    if not isinstance(key, str) or not KEY_SHAPE.fullmatch(key):
        raise ValueError("not a key this server can use")
    held, config = key_files(rec, owner)
    lines = [f'header = "Authorization: Bearer {key}"', 'noproxy = "*"']
    if rec["board"].startswith("http://"):
        door = urllib.parse.urlsplit(rec["board"])
        host = f"[{door.hostname}]" if ":" in (door.hostname or "") else door.hostname
        lines.append(f'connect-to = "::{host}:{door.port or 80}"')
    private_write(held, key + "\n")
    private_write(config, "\n".join(lines) + "\n")
    return config


def inspect_remote(args, rec):
    common = {"remote": True, "server": rec.get("name", "")}
    if args.board is None:
        if args.path == "":
            output("path_missing", **common)
            return
        path = Path(args.path if args.path is not None else os.getcwd()).expanduser().resolve()
        if not path.is_dir():
            output("path_missing", **common)
            return
        git = common_git_dir(path)
        asked = {"path": str(path), "git": str(git) if git else None}
    else:
        asked = {"board": args.board}
    ensure_link(rec)
    try:
        server_key = (Path(rec["home"]) / "server.key").read_text().strip()
    except OSError:
        output("key_refused", detail="this server has no key: pair it again with facilitator remote pair --name NAME on the Mac",
               **common)
        return
    try:
        status, answer = remote_request(rec, "POST", "/remote/join", server_key, asked)
    except Blocked:
        output("permission_denied", detail=BLOCKED, **common)
        return
    except LinkDown as problem:
        output("link_down", detail=str(problem), **common)
        return
    if status == 401:
        output("key_refused", detail="the board does not know this server's key: "
                                     "pair it again with facilitator remote pair --name NAME on the Mac", **common)
        return
    if status != 200 or not isinstance(answer, dict) or not isinstance(answer.get("status"), str):
        output("different_server", **common)
        return
    found = answer.pop("status")
    key = answer.pop("key", None)
    answer.pop("server", None)
    # the board has no profile here: a join it answers ready carries the
    # person's first name, given on with the runbook as on the Mac
    name = first_name(answer.pop("name", None))
    if found == "ready":
        if not isinstance(key, str) or not key or not isinstance(answer.get("owner"), str) \
                or not LANE_ID.fullmatch(answer["owner"]):
            output("protocol_error", detail="join answered no key", **common)
            return
        if not KEY_SHAPE.fullmatch(key):
            output("protocol_error", detail="join answered a key this server cannot use", **common)
            return
        config = save_key(rec, answer["owner"], key)
        named = {"name": name} if name else {}
        output("ready", owner=answer["owner"], curl=f"-K {config}", base=remote_base(rec),
               runbook=str(RUNBOOK), **named, **common)
        return
    output(found, **answer, **common)


def lane_key(rec, owner):
    """The key this server was given for the lane, or None for none."""
    held, _ = key_files(rec, owner)
    try:
        return held.read_text().strip()
    except OSError:
        return None


NO_LANE_KEY = "this lane has no key here: run inspect to join it"
LANE_KEY_GONE = "the board no longer takes this lane's key: run inspect to join again"


def listen_remote(args, rec):
    """One listen through the door, made of /wait calls of at most
    WAIT_CYCLE seconds inside the listen's own deadline, so a call cut off by
    a drop is gone from the board before a message sent while the project is
    faded could be handed to it. Through a drop it keeps trying until the
    deadline, and a hand-off is confirmed through a short drop."""
    owner = args.owner
    if not LANE_ID.fullmatch(owner):
        return result("project_unknown", owner=owner)
    key = lane_key(rec, owner)
    if key is None:
        return result("key_refused", owner=owner, detail=NO_LANE_KEY)
    deadline = time.monotonic() + args.timeout
    dropped = False
    look = True      # read the lane's state before the next call

    def refused():
        return result("key_refused", owner=owner, detail=LANE_KEY_GONE)

    while True:
        settling = False
        try:
            if look:
                status, lane = remote_request(rec, "GET", "/remote/lane", key)
                if status == 401:
                    return refused()
                if status != 200 or not isinstance(lane, dict):
                    return result("protocol_error", detail="the lane's state did not come back")
                # after a drop, a hand-off nobody confirmed and a listener
                # still counted are this listen's own, cut off by the drop: the
                # card comes back by itself and the board lets the call go
                # once it sees it gone, so this waits for both
                if lane.get("busy") and (lane.get("confirmed") or not dropped):
                    return result("claim_held", owner=owner, box=lane["busy"])
                if lane.get("listening") and not dropped:
                    return result("listener_present", owner=owner)
                settling = bool(lane.get("busy") or lane.get("listening"))
            if not settling:
                remaining = int(deadline - time.monotonic())
                if remaining < 1:
                    return result("idle", owner=owner)
                cycle = min(remaining, WAIT_CYCLE)
                query = urllib.parse.urlencode({"owner": owner, "timeout": cycle, "agent": args.agent})
                status, claim = remote_request(rec, "GET", f"/wait?{query}", key, timeout=cycle + CLIENT_SLACK)
        except Blocked:
            return result("permission_denied", owner=owner, detail=BLOCKED)
        except LinkDown:
            dropped, look = True, True
            if time.monotonic() + LINK_RETRY >= deadline:
                return result("link_down", owner=owner)
            time.sleep(LINK_RETRY)
            continue
        if settling:
            if time.monotonic() + LINK_RETRY >= deadline:
                return result("idle", owner=owner)
            time.sleep(LINK_RETRY)
            continue
        if status == 401:
            return refused()
        if status != 200 or not isinstance(claim, dict):
            return result("protocol_error", detail="invalid wait response")
        token = claim.get("ack")
        if not token:
            if claim.get("idle"):
                # this listen's own call ran its course: the next one follows
                # at once, with nothing to look at first
                dropped, look = False, False
                continue
            return result("protocol_error", detail="wait response has no claim or state")
        receipt = urllib.parse.urlencode({"owner": owner, "token": token})
        patience = time.monotonic() + ACK_PATIENCE
        while True:
            try:
                status, confirmed = remote_request(rec, "POST", f"/ack?{receipt}", key)
                break
            except Blocked:
                # never confirmed: the card goes back on the queue by itself
                return result("permission_denied", owner=owner, detail=BLOCKED)
            except LinkDown:
                if time.monotonic() + LINK_RETRY >= patience:
                    # never confirmed: the card goes back on the queue by itself
                    return result("link_down", owner=owner)
                time.sleep(LINK_RETRY)
        if status != 200 or not isinstance(confirmed, dict) or confirmed.get("ok") is not True:
            return result("ack_failed", owner=owner, box=claim.get("box"))
        claim.pop("ack", None)
        return result("claim", owner=owner, **claim)


def reply_remote(args, rec, card, body):
    """wait --reply through the door: /fresh, then /reply when nothing came,
    then the listen."""
    owner = args.owner
    if not LANE_ID.fullmatch(owner):
        return result("project_unknown", owner=owner)
    key = lane_key(rec, owner)
    if key is None:
        return result("key_refused", owner=owner, detail=NO_LANE_KEY)
    try:
        status, fresh = remote_request(rec, "GET", "/fresh?" + urllib.parse.urlencode({"owner": owner}), key)
    except Blocked:
        return result("permission_denied", owner=owner, detail=BLOCKED)
    except LinkDown as problem:
        return result("link_down", owner=owner, detail=str(problem))
    if status == 401:
        return result("key_refused", owner=owner, detail=LANE_KEY_GONE)
    if status != 200:
        return result("protocol_error", detail=f"/fresh answered {status}", answer=fresh)
    stop = fresh_stop(fresh, card)
    if stop is not None:
        return stop
    try:
        status, answer = remote_request(rec, "POST", "/reply?" + urllib.parse.urlencode({"box": card}), key,
                                        raw=body, timeout=REPLY_TIMEOUT)
    except LinkDown as problem:
        return result("reply_failed", box=card, detail=REPLY_CUT.format(problem))
    if status != 200 or not isinstance(answer, dict) or answer.get("ok") is not True:
        return result("reply_failed", box=card, code=status, reply=answer)
    return result("replied", box=card, reply=answer, next=listen_remote(args, rec))


def inspect(args):
    rec = remote_record()
    if rec is not None:
        inspect_remote(args, rec)
        return
    state, problem = board()
    if problem:
        output(problem, port=port(), **refused_words(problem))
        return
    if args.board is not None:
        matches, problem = resolve_board(state, args.board), "project_unknown"
    elif args.path == "":
        matches, problem = [], "path_missing"
    else:
        matches, problem = resolve_path(state, args.path if args.path is not None else os.getcwd())
    if len(matches) != 1:
        output("ambiguous" if matches else problem, matches=matches,
               available=sorted(state["busy"]))
        return
    owner = matches[0]
    common = {"owner": owner, "port": port(), "runbook": str(RUNBOOK)}
    # the key file goes with the runbook once the board has made it: a board
    # older than the key, still running after an update, makes none and asks
    # for none, and curl -K on a missing file stops before it calls
    if AGENT_CURL.is_file():
        common.update(curl=f"-K {AGENT_CURL}", base=f"http://127.0.0.1:{port()}")
    # the person's first name goes with the runbook, and none for no name
    name = profile_name()
    if name:
        common["name"] = name
    if state["busy"].get(owner):
        output("claim_held", box=state["busy"][owner], **common)
    elif state["listening"].get(owner) or state["listenerGap"].get(owner, 1e9) < 60:
        output("listener_present", **common)
    else:
        output("ready", **common)


def call_failed(problem):
    """A call that failed on its way: denied access, or a connection whose
    end is not known."""
    status = "permission_denied" if connection_status(problem) == "permission_denied" else "connection_error"
    return result(status, detail=str(problem))


def listen_local(args):
    state, problem = board()
    if problem:
        return result(problem, port=port(), **refused_words(problem))
    owner = args.owner
    if owner not in state["busy"]:
        return result("project_unknown", available=sorted(state["busy"]))
    if state["busy"].get(owner):
        return result("claim_held", owner=owner, box=state["busy"][owner])
    if state["listening"].get(owner):
        return result("listener_present", owner=owner)
    query = urllib.parse.urlencode({"owner": owner, "timeout": args.timeout, "agent": args.agent})
    try:
        claim = request("GET", f"/wait?{query}", timeout=args.timeout + CLIENT_SLACK)
        if not isinstance(claim, dict):
            return result("protocol_error", detail="invalid wait response")
        token = claim.get("ack")
        if token:
            receipt = urllib.parse.urlencode({"owner": owner, "token": token})
            confirmed = request("POST", f"/ack?{receipt}")
            if not isinstance(confirmed, dict) or confirmed.get("ok") is not True:
                return result("ack_failed", owner=owner, box=claim.get("box"))
            claim.pop("ack", None)
            return result("claim", owner=owner, **claim)
        if claim.get("idle"):
            return result("idle", owner=owner)
        return result("protocol_error", detail="wait response has no claim or state")
    except (OSError, ValueError, urllib.error.HTTPError) as problem:
        # A failed wait or ack may already have reached the board. Never
        # retry here or turn an unconfirmed hand-off into a claim.
        return call_failed(problem)


# ---- wait --reply ------------------------------------------------------------------

REPLY_TIMEOUT = 30      # seconds a /reply call may take
REPLY_CUT = ("the call that posts the reply failed ({}): the board may or may not have the reply, "
             "and no listen was started")


def reply_body():
    """The reply on standard input, as its bytes, or None when there is no
    text: nothing piped in (a terminal) or only white space, which the board
    would keep as an empty reply."""
    stream = sys.stdin
    if stream is None or stream.isatty():
        return None
    body = stream.buffer.read()
    return body if body.decode("utf-8", "replace").strip() else None


def fresh_stop(fresh, card):
    """What /fresh answered, as this command's answer, when it stops the
    reply: messages the reply has not seen (folded into the claim now, so the
    rewritten reply covers them), a widget message, or another card held.
    None when nothing came and the reply may go."""
    if not isinstance(fresh, dict) or not isinstance(fresh.get("messages"), list):
        return result("protocol_error", detail="invalid fresh response")
    held = fresh.get("box")
    if fresh["messages"] or fresh.get("widget_messages") or (held is not None and held != card):
        return result("fresh", **{name: value for name, value in fresh.items() if name != "status"})
    return None


def board_answer(refused):
    """The JSON a refusing board sent with its HTTP error, or None."""
    try:
        with refused:
            return json.loads(refused.read())
    except (OSError, ValueError):
        return None


def reply_local(args, card, body):
    """wait --reply on the Mac: the board checked as wait checks it, /fresh,
    then /reply when nothing came, then the listen."""
    state, problem = board()
    if problem:
        return result(problem, port=port(), **refused_words(problem))
    owner = args.owner
    if owner not in state["busy"]:
        return result("project_unknown", available=sorted(state["busy"]))
    try:
        fresh = request("GET", "/fresh?" + urllib.parse.urlencode({"owner": owner}), timeout=10)
    except urllib.error.HTTPError as refused:
        if refused.code == 401:
            refused.close()
            return result("key_refused", port=port(), **refused_words("key_refused"))
        return result("protocol_error", detail=f"/fresh answered {refused.code}", answer=board_answer(refused))
    except (OSError, ValueError) as problem:
        return call_failed(problem)
    stop = fresh_stop(fresh, card)
    if stop is not None:
        return stop
    try:
        code, answer = 200, request("POST", "/reply?" + urllib.parse.urlencode({"box": card}),
                                    data=body, timeout=REPLY_TIMEOUT)
    except urllib.error.HTTPError as refused:
        code, answer = refused.code, board_answer(refused)
    except (OSError, ValueError) as problem:
        return result("reply_failed", box=card, detail=REPLY_CUT.format(problem))
    if code != 200 or not isinstance(answer, dict) or answer.get("ok") is not True:
        return result("reply_failed", box=card, code=code, reply=answer)
    return result("replied", box=card, reply=answer, next=listen_local(args))


def answer_and_listen(args):
    body = reply_body()
    if body is None:
        return result("empty_reply", box=args.reply,
                      detail="no reply text came on standard input; nothing was called")
    rec = remote_record()
    if rec is not None:
        return reply_remote(args, rec, args.reply, body)
    return reply_local(args, args.reply, body)


def wait(args):
    if getattr(args, "reply", None) is not None:
        show(answer_and_listen(args))
        return
    rec = remote_record()
    show(listen_remote(args, rec) if rec is not None else listen_local(args))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect_parser = commands.add_parser("inspect", help="resolve the current session's board lane")
    choice = inspect_parser.add_mutually_exclusive_group()
    choice.add_argument("--board", help="board lane ID or project name")
    choice.add_argument("--path", help="project directory instead of this session's directory")
    wait_parser = commands.add_parser("wait", help="receive and immediately confirm one claim")
    wait_parser.add_argument("--owner", required=True)
    wait_parser.add_argument("--agent", default="agent")
    wait_parser.add_argument("--timeout", type=int, choices=range(1, 541), default=LISTEN_SECONDS,
                             metavar="SECONDS",
                             help=f"seconds to listen in one request, 1 to 540 (default {LISTEN_SECONDS}, "
                                  f"7 minutes); the client deadline is {CLIENT_SLACK} seconds longer")
    wait_parser.add_argument("--reply", metavar="CARD",
                             help="first answer CARD with the reply text on standard input: read /fresh, post "
                                  "nothing if anything new came (answers fresh), else post it to /reply and "
                                  "listen as wait does (answers replied, with the listen's result in next)")
    args = parser.parse_args()
    (inspect if args.command == "inspect" else wait)(args)


if __name__ == "__main__":
    main()
