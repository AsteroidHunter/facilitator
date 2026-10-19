#!/usr/bin/env python3
"""Resolve this checkout's board lane and receive one confirmed claim.

On one of the owner's servers, where the setup program (scripts/pair.py) put
this skill in ~/.facilitator/skill with remote.json beside it, the board is
on the owner's Mac and is reached by connecting out to its agent door over
the tailnet, never by the Mac logging in here. inspect makes sure this
server's link runs (scripts/link.py), then joins the lane with the server's
key, which gives this agent a key of its own for the lane, kept in
~/.facilitator/agents/<lane>.key with a curl config beside it (both for this
account alone); wait listens with that key, and keeps trying through a drop
until its own deadline. Runs on python3 3.7 and newer."""

import argparse
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
REMOTE_FILE = REPO / "remote.json"
LINK = Path(__file__).resolve().parent / "link.py"
LISTEN_SECONDS = 420
CLIENT_SLACK = 10
LINK_RETRY = 3          # seconds between tries while the board cannot be reached
ACK_PATIENCE = 60       # seconds an ack is tried again through a drop
WAIT_CYCLE = 25         # seconds one /wait call from a server may last
REMOTE_BASE = "http://board"   # what an agent on a server writes for the board
LANE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,99}")


def output(status, **fields):
    print(json.dumps({"status": status, **fields}, ensure_ascii=False))


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


def request(method, route, *, timeout=3):
    url = f"http://127.0.0.1:{port()}{route}"
    with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=timeout) as response:
        return json.load(response)


def board():
    try:
        state = request("GET", "/state")
    except urllib.error.HTTPError:
        return None, "different_server"
    except ValueError:
        return None, "different_server"
    except OSError:
        return None, "down"
    if not isinstance(state, dict) or not all(
        isinstance(state.get(key), dict) for key in ("pwds", "busy", "listening", "listenerGap")
    ) or not isinstance(state.get("pwd"), str):
        return None, "different_server"
    if Path(state["pwd"]).resolve() != REPO:
        return None, "different_board"
    return state, None


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


def remote_request(rec, method, route, key, body=None, timeout=10):
    """(status, answer) from the board's door; LinkDown when nothing answers."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Bearer " + key}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(rec["board"].rstrip("/") + route, data=data, method=method, headers=headers)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as refused:
        with refused:
            raw, status = refused.read(), refused.code
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as problem:
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
    work with -K and the key never shows in ps."""
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
        output("key_refused", detail="this server has no key: pair it again with facilitator remote pair on the Mac",
               **common)
        return
    try:
        status, answer = remote_request(rec, "POST", "/remote/join", server_key, asked)
    except LinkDown as problem:
        output("link_down", detail=str(problem), **common)
        return
    if status == 401:
        output("key_refused", detail="the board does not know this server's key: "
                                     "pair it again with facilitator remote pair on the Mac", **common)
        return
    if status != 200 or not isinstance(answer, dict) or not isinstance(answer.get("status"), str):
        output("different_server", **common)
        return
    found = answer.pop("status")
    key = answer.pop("key", None)
    answer.pop("server", None)
    if found == "ready":
        if not isinstance(key, str) or not key or not isinstance(answer.get("owner"), str) \
                or not LANE_ID.fullmatch(answer["owner"]):
            output("protocol_error", detail="join answered no key", **common)
            return
        config = save_key(rec, answer["owner"], key)
        output("ready", owner=answer["owner"], curl=f"-K {config}", base=remote_base(rec),
               runbook=str(RUNBOOK), **common)
        return
    output(found, **answer, **common)


def wait_remote(args, rec):
    """One listen through the door, made of /wait calls of at most
    WAIT_CYCLE seconds inside the listen's own deadline, so a call cut off by
    a drop is gone from the board before a message sent while the project is
    faded could be handed to it. Through a drop it keeps trying until the
    deadline, and a hand-off is confirmed through a short drop."""
    owner = args.owner
    if not LANE_ID.fullmatch(owner):
        output("project_unknown", owner=owner)
        return
    held, _ = key_files(rec, owner)
    try:
        key = held.read_text().strip()
    except OSError:
        output("key_refused", owner=owner, detail="this lane has no key here: run inspect to join it")
        return
    deadline = time.monotonic() + args.timeout
    dropped = False
    look = True      # read the lane's state before the next call

    def refused():
        output("key_refused", owner=owner, detail="the board no longer takes this lane's key: run inspect to join again")

    while True:
        settling = False
        try:
            if look:
                status, lane = remote_request(rec, "GET", "/remote/lane", key)
                if status == 401:
                    refused()
                    return
                if status != 200 or not isinstance(lane, dict):
                    output("protocol_error", detail="the lane's state did not come back")
                    return
                # after a drop, a hand-off nobody confirmed and a listener
                # still counted are this listen's own, cut off by the drop: the
                # card comes back by itself and the board lets the call go
                # once it sees it gone, so this waits for both
                if lane.get("busy") and (lane.get("confirmed") or not dropped):
                    output("claim_held", owner=owner, box=lane["busy"])
                    return
                if lane.get("listening") and not dropped:
                    output("listener_present", owner=owner)
                    return
                settling = bool(lane.get("busy") or lane.get("listening"))
            if not settling:
                remaining = int(deadline - time.monotonic())
                if remaining < 1:
                    output("idle", owner=owner)
                    return
                cycle = min(remaining, WAIT_CYCLE)
                query = urllib.parse.urlencode({"owner": owner, "timeout": cycle, "agent": args.agent})
                status, claim = remote_request(rec, "GET", f"/wait?{query}", key, timeout=cycle + CLIENT_SLACK)
        except LinkDown:
            dropped, look = True, True
            if time.monotonic() + LINK_RETRY >= deadline:
                output("link_down", owner=owner)
                return
            time.sleep(LINK_RETRY)
            continue
        if settling:
            if time.monotonic() + LINK_RETRY >= deadline:
                output("idle", owner=owner)
                return
            time.sleep(LINK_RETRY)
            continue
        if status == 401:
            refused()
            return
        if status != 200 or not isinstance(claim, dict):
            output("protocol_error", detail="invalid wait response")
            return
        token = claim.get("ack")
        if not token:
            if claim.get("idle"):
                # this listen's own call ran its course: the next one follows
                # at once, with nothing to look at first
                dropped, look = False, False
                continue
            output("protocol_error", detail="wait response has no claim or state")
            return
        receipt = urllib.parse.urlencode({"owner": owner, "token": token})
        patience = time.monotonic() + ACK_PATIENCE
        while True:
            try:
                status, confirmed = remote_request(rec, "POST", f"/ack?{receipt}", key)
                break
            except LinkDown:
                if time.monotonic() + LINK_RETRY >= patience:
                    # never confirmed: the card goes back on the queue by itself
                    output("link_down", owner=owner)
                    return
                time.sleep(LINK_RETRY)
        if status != 200 or not isinstance(confirmed, dict) or confirmed.get("ok") is not True:
            output("ack_failed", owner=owner, box=claim.get("box"))
            return
        claim.pop("ack", None)
        output("claim", owner=owner, **claim)
        return


def inspect(args):
    rec = remote_record()
    if rec is not None:
        inspect_remote(args, rec)
        return
    state, problem = board()
    if problem:
        output(problem, port=port())
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
    if state["busy"].get(owner):
        output("claim_held", box=state["busy"][owner], **common)
    elif state["listening"].get(owner) or state["listenerGap"].get(owner, 1e9) < 60:
        output("listener_present", **common)
    else:
        output("ready", **common)


def wait(args):
    rec = remote_record()
    if rec is not None:
        wait_remote(args, rec)
        return
    state, problem = board()
    if problem:
        output(problem, port=port())
        return
    owner = args.owner
    if owner not in state["busy"]:
        output("project_unknown", available=sorted(state["busy"]))
        return
    if state["busy"].get(owner):
        output("claim_held", owner=owner, box=state["busy"][owner])
        return
    if state["listening"].get(owner):
        output("listener_present", owner=owner)
        return
    query = urllib.parse.urlencode({"owner": owner, "timeout": args.timeout, "agent": args.agent})
    try:
        claim = request("GET", f"/wait?{query}", timeout=args.timeout + CLIENT_SLACK)
        if not isinstance(claim, dict):
            output("protocol_error", detail="invalid wait response")
            return
        token = claim.get("ack")
        if token:
            receipt = urllib.parse.urlencode({"owner": owner, "token": token})
            confirmed = request("POST", f"/ack?{receipt}")
            if not isinstance(confirmed, dict) or confirmed.get("ok") is not True:
                output("ack_failed", owner=owner, box=claim.get("box"))
                return
            claim.pop("ack", None)
            output("claim", owner=owner, **claim)
        elif claim.get("idle"):
            output("idle", owner=owner)
        else:
            output("protocol_error", detail="wait response has no claim or state")
    except (OSError, ValueError, urllib.error.HTTPError) as problem:
        output("connection_error", detail=str(problem))


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
    args = parser.parse_args()
    (inspect if args.command == "inspect" else wait)(args)


if __name__ == "__main__":
    main()
