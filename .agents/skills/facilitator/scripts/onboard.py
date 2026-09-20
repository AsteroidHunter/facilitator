#!/usr/bin/env python3
"""Resolve this checkout's board lane and receive one confirmed claim."""

import argparse
import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


REPO = Path(__file__).resolve().parents[4]
RUNBOOK = REPO / "RUNBOOK.md"


def output(status, **fields):
    print(json.dumps({"status": status, **fields}, ensure_ascii=False))


def port():
    try:
        value = json.loads((REPO / "run.config.json").read_text()).get("port", 8877)
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
    roots = []
    for owner, raw in state["pwds"].items():
        if isinstance(owner, str) and isinstance(raw, str) and owner in state["busy"]:
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


def inspect(args):
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
    elif state.get("end"):
        output("ended", **common)
    elif state.get("paused"):
        output("paused", **common)
    else:
        output("ready", **common)


def wait(args):
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
        claim = request("GET", f"/wait?{query}", timeout=args.timeout + 20)
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
        elif claim.get("idle") or claim.get("paused") or claim.get("end"):
            output("idle" if claim.get("idle") else "paused" if claim.get("paused") else "ended", owner=owner)
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
    wait_parser.add_argument("--timeout", type=int, choices=range(1, 541), default=540,
                             metavar="SECONDS")
    args = parser.parse_args()
    (inspect if args.command == "inspect" else wait)(args)


if __name__ == "__main__":
    main()
