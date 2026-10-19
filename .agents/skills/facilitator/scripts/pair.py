#!/usr/bin/env python3
"""Pair this server with the owner's Facilitator board, from the server.

The owner runs it here, logged in to this server by hand, with the line
`facilitator remote pair` prints on the Mac:

    curl -fsS --noproxy '*' http://ADDRESS:8870/remote/setup | python3 - http://ADDRESS:8870

It asks for the pairing code printed with that line, trades it at the
board's agent door for this server's own key, puts the skill, the runbook
and the docs in ~/.facilitator/skill, links the skill where Claude Code and
Codex look for skills (never over anything else), and starts this server's
link (scripts/link.py), which connects out to the board and keeps trying
while the Mac is away. Everything it writes is for this account alone. The
code is read from the terminal, never from the command line, where other
accounts here could see it, and nothing logs in anywhere. Run it again with
a new code to bring a newer skill here or to pair afresh.

Runs on python3 3.7 and newer, standard library only."""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TOP_NAME = ".facilitator"
SKILL_LINK = Path(".agents") / "skills" / "facilitator"
CONNECT_WAIT = 15      # seconds the link is given to reach the board before this says so

# no proxy, ever: a proxy named in this account's settings would be handed
# the pairing code and the key that comes back
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def say(line=""):
    print(line, flush=True)


def stop(*lines):
    for line in lines:
        say(line)
    sys.exit(1)


def board_url(text):
    """The board's door as `facilitator remote pair` printed it: http or
    https, a host and a port, nothing after them."""
    text = (text or "").strip().rstrip("/")
    if not re.fullmatch(r"https?://(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?", text):
        stop("That is not the board's address. Copy the whole line `facilitator remote pair` printed on the Mac.")
    return text


def read_code():
    """The pairing code, typed or pasted at the terminal, which is where it
    has to come from: standard input is the program itself when it is piped
    in. Opened as getpass opens it, unbuffered, since a terminal cannot be
    opened for buffered reading and writing at once. With no terminal (a
    test, or a pipe of its own) the first line of standard input."""
    try:
        fd = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
    except OSError:
        return sys.stdin.readline().strip()
    try:
        os.write(fd, b"Pairing code from the Mac: ")
        line = b""
        while not line.endswith(b"\n") and len(line) < 256:
            chunk = os.read(fd, 256)
            if not chunk:
                break
            line += chunk
        return line.decode("utf-8", "replace").strip()
    finally:
        os.close(fd)


def private_dir(path):
    """A folder for this account alone, refused when it is a link or a file."""
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        stop(str(path) + " is not a folder; move it aside and run this again.")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_uid != os.getuid():
        stop(str(path) + " belongs to another account.")
    os.chmod(str(path), 0o700)


def private_write(path, text, mode=0o600):
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(str(tmp), mode)
    os.replace(str(tmp), str(path))


def trade(board, code):
    """The code for this server's key and the skill's files."""
    home = os.path.expanduser("~")
    asked = {"host": socket.gethostname(), "home": home, "top": os.path.realpath(home)}
    request = urllib.request.Request(board + "/remote/pair", data=json.dumps(asked).encode(), method="POST",
                                     headers={"Authorization": "Bearer " + code,
                                              "Content-Type": "application/json"})
    try:
        with OPENER.open(request, timeout=60) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as refused:
        with refused:
            raw, status = refused.read(), refused.code
    except (urllib.error.URLError, OSError, ValueError):
        stop("The board did not answer. Check that the Mac is awake, the board is running and",
             "Tailscale is on, here and there, then run the line again.")
    try:
        said = json.loads(raw)
    except ValueError:
        said = None
    if status != 200:
        stop("The board refused: " + (said or {}).get("error", "status " + str(status)) + ".")
    if (not isinstance(said, dict) or not isinstance(said.get("key"), str) or not isinstance(said.get("server"), str)
            or not isinstance(said.get("name"), str) or not isinstance(said.get("files"), dict)):
        stop("The board's answer could not be read; nothing was changed here.")
    return said


def safe_rel(rel):
    """A file of the skill's, by a path that stays inside the skill folder."""
    parts = Path(rel).parts
    return (isinstance(rel, str) and parts and not Path(rel).is_absolute()
            and all(p not in ("", ".", "..") for p in parts))


def put_skill(top, said, board):
    """The skill in ~/.facilitator/skill, swapped in whole."""
    skill, new, old = top / "skill", top / "skill.new", top / "skill.old"
    shutil.rmtree(str(new), ignore_errors=True)
    for rel, entry in sorted(said["files"].items()):
        if not safe_rel(rel) or not isinstance(entry, list) or len(entry) != 2 or not isinstance(entry[0], str):
            shutil.rmtree(str(new), ignore_errors=True)
            stop("The board sent a file this setup does not take; nothing was changed here.")
        path = new / rel
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        private_write(path, entry[0], 0o700 if rel.endswith(".py") else 0o600)
    remote = {"server": said["server"], "name": said["name"], "board": board, "home": str(top)}
    private_write(new / "remote.json", json.dumps(remote, indent=1) + "\n")
    shutil.rmtree(str(old), ignore_errors=True)
    if skill.exists() or skill.is_symlink():
        os.rename(str(skill), str(old))
    os.rename(str(new), str(skill))
    shutil.rmtree(str(old), ignore_errors=True)
    return skill


def link_skill(home, skill):
    """The skill where Claude Code and Codex look for skills, unless
    something else already holds that name. Answers {link: made, kept or
    taken}."""
    target = skill / SKILL_LINK
    out = {}
    for parent in (home / ".agents" / "skills", home / ".claude" / "skills"):
        link = parent / "facilitator"
        if link.is_symlink() and os.readlink(str(link)) == str(target):
            out[str(link)] = "kept"
        elif link.is_symlink() or link.exists():
            out[str(link)] = "taken"
        else:
            parent.mkdir(parents=True, exist_ok=True)
            os.symlink(str(target), str(link))
            out[str(link)] = "made"
    return out


def start_link(skill, top):
    """The link from the skill just put here: an older one stopped first,
    then this one started and given a moment to reach the board."""
    script = skill / SKILL_LINK / "scripts" / "link.py"
    subprocess.run([sys.executable, "-B", str(script), "stop"], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=30)
    subprocess.run([sys.executable, "-B", str(script), "start", "--quiet"], timeout=30)
    ends = time.monotonic() + CONNECT_WAIT
    while time.monotonic() < ends:
        try:
            st = json.loads((top / "link.state").read_text())
        except (OSError, ValueError):
            st = {}
        if st.get("connected"):
            return True, script
        time.sleep(0.3)
    return False, script


def main(argv):
    if len(argv) != 2:
        stop("usage: curl -fsS --noproxy '*' BOARD/remote/setup | python3 - BOARD",
             "Run the line `facilitator remote pair` prints on the Mac.")
    board = board_url(argv[1])
    code = read_code()
    if not code:
        stop("No code was given; nothing was changed here.")
    said = trade(board, code)
    home = Path(os.path.expanduser("~"))
    top = home / TOP_NAME
    os.umask(0o077)
    private_dir(top)
    private_dir(top / "agents")
    skill = put_skill(top, said, board)
    private_write(top / "server.key", said["key"] + "\n")
    # what an earlier version, which reached servers over ssh, left here
    for stale in ("join.key", "board.sock"):
        try:
            (top / stale).unlink()
        except OSError:
            pass
    links = link_skill(home, skill)
    say("✓ Paired with the board as " + said["name"] + ".")
    say("✓ The facilitator skill is in ~/" + TOP_NAME + "/skill.")
    for link, how in sorted(links.items()):
        if how == "taken":
            say("⚠ " + link + " already holds something else and was left as it is.")
            say("  An agent here finds the skill once that name links to " + str(skill / SKILL_LINK) + ".")
    connected, script = start_link(skill, top)
    if connected:
        say("✓ The link is connected. It runs in the background and keeps trying while the Mac is away.")
    else:
        say("⚠ The link runs but has not reached the board yet; it keeps trying.")
        say("  python3 " + str(script) + " status   says how it is doing.")
    say()
    say("Next: on the board, choose Open a new folder and pick " + said["name"] + " under Machines.")
    say("Then start Claude Code or Codex in that folder here and ask it to onboard.")
    say("The link outlives this login. If the server ends every program at logout, an agent's")
    say("onboard starts it again, and so does: python3 " + str(script) + " start")


if __name__ == "__main__":
    main(sys.argv)
