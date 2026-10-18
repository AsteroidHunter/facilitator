"""The owner's own servers: the ssh link to each, the keys that let an agent
on one reach its own lane, and the programs the board runs there.

A server is added from the Mac with `facilitator remote add you@server`,
which checks the login, puts the skill, the runbook and the docs in
~/.facilitator on the server, writes the server's join key there and saves
the server's record in data/remote/servers.json. From then on the board keeps
one ssh link to each server alive for as long as it runs (Link): one ssh
ControlMaster, logged in with the owner's own ssh key and never a password
(BatchMode), which forwards ~/.facilitator/board.sock on the server to the
board's own Unix socket here. sshd makes that socket for the account alone
(its StreamLocalBindMask, 0177 unless changed), so another user on the server
cannot reach the board through it.

Every request that comes through a link lands on the board's Unix socket, and
BoardProtocol marks it with SERVER_MARK, an address no TCP request can carry,
so a server's request is never taken for a page or an agent on this Mac.
RemoteGate then lets through only the agent's own routes for its own lane:
the join key (one per server) only asks for a lane's key, an agent key (one
per lane, a new one at each join) only works that lane's cards. The Mac keeps
the keys' SHA-256 and never the keys; nothing here writes a key to a log, a
card, a URL or a command line.

The board also runs one small Python program on a server over the link's own
login, for the folder picker's listing of that server and for the folder a
project names (PROGRAM). Its words travel in the program's text on standard
input, never through the server's shell.

Standard library only, and Python 3.9, since the facilitator command imports
it on the python3 macOS ships; the programs for the server run on 3.7 and up.
FACILITATOR_SSH_CONFIG, when it is set, gives every ssh run here `-F` and that
file, which is how a test reaches a stand-in server without the owner's
~/.ssh."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import socket
import stat
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs

SSH = "ssh"                    # the ssh command; tests put a stand-in here
FADE_AFTER = 30.0              # seconds a link is down before its projects fade
KEEPALIVE = 5                  # seconds between ssh's keepalives
KEEPALIVE_MISSES = 3           # keepalives unanswered before ssh gives the link up
CONNECT_TIMEOUT = 15           # seconds a login may take
COMMAND_TIMEOUT = 20           # seconds one program on a server may take
BACKOFF = (1, 2, 5, 10, 15)    # seconds before each new try; the last one repeats
STEADY = 60.0                  # a link up this long starts the tries from the first again
REMOTE_DIR = ".facilitator"    # on the server, in the account's home
SOCKET_NAME = "board.sock"     # the link's end on the server and the board's socket here
SOCKET_DIR_MAX = 79            # characters: the folder for this Mac's sockets, see socket_dir
SERVER_PATH_MAX = 96           # characters in the server's socket path (Linux allows 107)
JOIN_BODY_MAX = 4096           # bytes of a join's body
LANE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,99}")
# the address a request on the board's Unix socket carries: it came through
# a link, from an agent on a server, and from nowhere else
SERVER_MARK = ("facilitator-remote", 0)

# what an agent on a server may ask, and how the lane it names is read: from
# owner=, from the card box= names, or the key's own lane
AGENT_ROUTES = {
    ("GET", "/wait"): "owner", ("POST", "/ack"): "owner", ("GET", "/fresh"): "owner",
    ("GET", "/unread"): "owner", ("POST", "/create"): "owner",
    ("POST", "/reply"): "box", ("POST", "/note"): "box", ("POST", "/working"): "box",
    ("POST", "/ping"): "box", ("POST", "/title"): "box", ("POST", "/testing"): "box",
    ("POST", "/park"): "box", ("POST", "/progress"): "box", ("POST", "/context"): "box",
    ("GET", "/remote/lane"): "lane",
}
KNOWN_ROUTES = frozenset(route for _, route in AGENT_ROUTES)


class Problem(Exception):
    """Something the owner has to put right, in words for the terminal: a
    headline, then each next step."""

    def __init__(self, headline, *steps):
        super().__init__(headline)
        self.headline = headline
        self.steps = steps


# ---- names and keys ---------------------------------------------------------------

def slug(text: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in text.lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def new_key() -> str:
    return secrets.token_urlsafe(32)


def digest(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8", "replace")).hexdigest()


def short(text: str) -> str:
    """A server's name as a log line may carry it: a short hash, so lines about
    one link can be told apart without a machine's name in the file."""
    return hashlib.sha256(text.encode()).hexdigest()[:6]


def destination_problem(dest: str):
    """Why ssh must not be handed this destination, or None. A leading dash
    would be read as an option, and white space or a control character is no
    host anyone means."""
    if not dest:
        return "name the server, for example you@server"
    if dest.startswith("-"):
        return "a server cannot start with -"
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in dest):
        return "a server cannot hold spaces or control characters"
    return None


# ---- files on this Mac --------------------------------------------------------------

def _write_private(path: Path, text: str) -> None:
    """Written whole or not at all, for the owner alone."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Store:
    """data/remote/: servers.json, the servers `remote add` saved, each
    {id, name, dest, home, python, join, added} with join the SHA-256 of the
    server's join key; and keys.json, {lanes: {lane: {hash, server, ts}}},
    the one agent key each server lane has, by its SHA-256. Both owner-only."""

    def __init__(self, data: Path):
        self.dir = Path(data) / "remote"
        self.servers_file = self.dir / "servers.json"
        self.keys_file = self.dir / "keys.json"

    def servers(self) -> list:
        try:
            raw = json.loads(self.servers_file.read_text())
        except (OSError, ValueError):
            return []
        out = []
        for rec in raw.get("servers", []) if isinstance(raw, dict) else []:
            if (isinstance(rec, dict) and all(isinstance(rec.get(k), str) and rec[k]
                                              for k in ("id", "name", "dest", "home", "python", "join"))
                    and LANE_ID.fullmatch(rec["id"]) and destination_problem(rec["dest"]) is None):
                out.append(rec)
        return out

    def save_servers(self, servers: list) -> None:
        _write_private(self.servers_file, json.dumps({"servers": servers}, indent=1) + "\n")

    def keys(self) -> dict:
        try:
            raw = json.loads(self.keys_file.read_text())
        except (OSError, ValueError):
            return {}
        lanes = raw.get("lanes") if isinstance(raw, dict) else None
        return {k: v for k, v in (lanes or {}).items()
                if isinstance(v, dict) and isinstance(v.get("hash"), str) and isinstance(v.get("server"), str)}

    def save_keys(self, lanes: dict) -> None:
        _write_private(self.keys_file, json.dumps({"lanes": lanes}, indent=1) + "\n")


def socket_dir(data: Path) -> Path:
    """Where this Mac's sockets go: the board's own and each link's control
    socket. data/remote/ when its path is short enough, since a socket's path
    is capped at 104 bytes here and ssh adds 17 to a control socket's while it
    makes it; a private folder in the account's temporary folder otherwise,
    named from the data folder so one board always finds its own."""
    home = Path(data) / "remote"
    if len(str(home)) <= SOCKET_DIR_MAX and ":" not in str(home):
        return home
    return Path(tempfile.gettempdir()) / ("facilitator-" + hashlib.sha256(str(data).encode()).hexdigest()[:10])


def private_dir(path: Path) -> Path:
    """The folder made for the owner alone, and refused when it is anything
    else: a link, or a folder someone else owns or others may enter."""
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise OSError(f"{path} is not this account's own folder")
    if st.st_mode & 0o077:
        os.chmod(path, 0o700)
    return path


def listen_socket(path: Path) -> socket.socket:
    """The board's Unix socket for its links, for this account alone."""
    private_dir(path.parent)
    try:
        if stat.S_ISSOCK(os.lstat(path).st_mode):
            path.unlink()
    except FileNotFoundError:
        pass
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        sock.bind(str(path))
    finally:
        os.umask(old)
    os.chmod(path, 0o600)
    sock.listen(128)
    return sock


# ---- ssh ------------------------------------------------------------------------------

def ssh_argv(dest: str, *options: str, command: str | None = None) -> list:
    """One ssh: never a password prompt, a login that gives up in time, and
    the owner's own ssh setup unless FACILITATOR_SSH_CONFIG names another file.
    The destination comes after --, so nothing in it is read as an option."""
    argv = [SSH]
    named = os.environ.get("FACILITATOR_SSH_CONFIG")
    if named:
        argv += ["-F", named]
    argv += ["-o", "BatchMode=yes", "-o", f"ConnectTimeout={CONNECT_TIMEOUT}", *options, "--", dest]
    if command is not None:
        argv.append(command)
    return argv


def last_words(raw: bytes, lines: int = 3) -> list:
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else (raw or "")
    kept = [line.strip() for line in text.splitlines() if line.strip()]
    return kept[-lines:]


def server_socket(rec: dict) -> str:
    return rec["home"].rstrip("/") + "/" + REMOTE_DIR + "/" + SOCKET_NAME


# ---- the program the board runs on a server -------------------------------------------
# Folder listings for the picker, a new folder in one, and the folder a project
# names, in the shapes server.py gives for this Mac's own folders, with the
# same refusals in the same words. Fenced to the account's home, hidden folders
# left out. main() takes the operation and its words as JSON appended to the
# program, so a path never passes through the server's shell.

PROGRAM = r'''
import json, os, re, stat, subprocess, sys, time

ROWS_MAX = 2000
COUNT_MAX = 9999
COUNT_TIME = 0.4
NAME_MAX = 255
NAME_BAD = set('<>:"|?*')


def top():
    return os.path.realpath(os.path.expanduser("~"))


def inside(p, t):
    return p == t or p.startswith(t.rstrip("/") + "/")


def hidden_mark(st):
    return bool(getattr(st, "st_flags", 0) & getattr(stat, "UF_HIDDEN", 0))


def hidden_below(p, t):
    at = p
    while at != t and inside(at, t):
        if os.path.basename(at).startswith("."):
            return True
        try:
            if hidden_mark(os.stat(at)):
                return True
        except OSError:
            pass
        at = os.path.dirname(at)
    return False


def named(path, base, t):
    try:
        p = os.path.expanduser(path) if path else t
        if not os.path.isabs(p):
            start = os.path.expanduser(base) if base else t
            p = os.path.join(start if os.path.isabs(start) else t, p)
        p = os.path.realpath(p)
    except (OSError, ValueError):
        return None, "that path cannot be read"
    if not inside(p, t):
        return None, "outside the home folder"
    if hidden_below(p, t):
        return None, "that folder is hidden"
    try:
        if not os.path.exists(p):
            return None, "no folder there"
        if not os.path.isdir(p):
            return None, "that is a file, not a folder"
    except (OSError, ValueError):
        return None, "that path cannot be read"
    return p, None


def natural(name):
    return [int(part) if i % 2 else part for i, part in enumerate(re.split(r"(\d+)", name.casefold()))]


def rows(p, t):
    out = []
    with os.scandir(p) as entries:
        for e in entries:
            if e.name.startswith("."):
                continue
            try:
                if not e.is_dir():
                    continue
                st = e.stat()
                if e.is_symlink() and not inside(os.path.realpath(e.path), t):
                    continue
            except (OSError, RuntimeError):
                continue
            if not hidden_mark(st):
                out.append((e.name, e.path, st.st_mtime))
    out.sort(key=lambda row: natural(row[0]))
    return out


def count(p):
    n = 0
    try:
        with os.scandir(p) as entries:
            for e in entries:
                if not e.name.startswith("."):
                    n += 1
                    if n > COUNT_MAX:
                        break
    except OSError:
        return None
    return n


def op_dirs(path, base):
    t = top()
    p, why = named(path, base, t)
    if p is None:
        return {"error": why}
    trail, at = [], p
    while True:
        trail.append({"name": os.path.basename(at) or at, "path": at})
        if at == t:
            break
        at = os.path.dirname(at)
    trail.reverse()
    answer = {"path": p, "name": os.path.basename(p) or p,
              "short": "~" if p == t else "~/" + os.path.relpath(p, t),
              "top": t, "parent": os.path.dirname(p) if p != t else None,
              "trail": trail, "dirs": [], "more": 0, "unreadable": False}
    try:
        found = rows(p, t)
    except OSError:
        answer["unreadable"] = True
        return {"answer": answer}
    answer["more"] = max(0, len(found) - ROWS_MAX)
    ends = time.monotonic() + COUNT_TIME
    for name, full, modified in found[:ROWS_MAX]:
        items = count(full) if time.monotonic() < ends else None
        row = {"name": name, "path": full, "modified": modified, "items": items}
        if items is not None and items > COUNT_MAX:
            row.update(items=COUNT_MAX, itemsCut=True)
        answer["dirs"].append(row)
    return {"answer": answer}


def name_problem(name):
    if not name:
        return "a folder needs a name"
    if "/" in name or "\\" in name:
        return "a folder name cannot hold a slash"
    if name.startswith("."):
        return "a folder name cannot start with a dot"
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        return "a folder name cannot hold a control character"
    if any(c in NAME_BAD for c in name):
        return 'a folder name cannot hold any of < > : " | ? *'
    if len(name.encode("utf-8", "surrogatepass")) > NAME_MAX:
        return "that name is too long"
    return None


def op_mkdir(path, name):
    why = name_problem(name)
    if why:
        return {"error": why}
    parent, why = named(path, "", top())
    if parent is None:
        return {"error": why}
    made = os.path.join(parent, name)
    try:
        os.mkdir(made)
    except FileExistsError:
        return {"error": "a folder by that name is already here"}
    except PermissionError:
        return {"error": "the board may not make a folder here"}
    except OSError:
        return {"error": "that folder could not be made"}
    return {"answer": {"ok": True, "name": name, "path": made}}


def op_describe(path):
    p, why = named(path, "", top())
    if p is None:
        return {"error": why}
    return {"answer": {"path": p, "name": os.path.basename(p) or p, "git": git_common(p)}}


def git_common(p):
    """The folder's repository as its git common dir, made absolute against
    the folder, so a worktree and its checkout name the same one; None
    without git or a repository. A git before 2.31 answers relative only."""
    try:
        r = subprocess.run(["git", "-C", p, "rev-parse", "--git-common-dir"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    line = r.stdout.decode("utf-8", "replace").strip()
    if r.returncode != 0 or not line:
        return None
    return os.path.realpath(os.path.join(p, line))


OPS = {"dirs": op_dirs, "mkdir": op_mkdir, "describe": op_describe}


def main(op, args):
    try:
        out = OPS[op](*args)
    except Exception:
        out = {"error": "the server could not answer that"}
    sys.stdout.write(json.dumps(out) + "\n")
'''


def program_text(op: str, *args) -> bytes:
    return (PROGRAM + "\nmain(*json.loads(" + repr(json.dumps([op, list(args)])) + "))\n").encode()


# what `remote add` asks a server first: its home, its system, and the python3
# the helper and the program above will run on
PROBE = r'''
printf 'home=%s\n' "$HOME"
printf 'system=%s\n' "$(uname -s 2>/dev/null)"
py="$(command -v python3 2>/dev/null)"
printf 'python=%s\n' "$py"
if [ -n "$py" ]; then
  printf 'version=%s\n' "$("$py" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"
fi
'''

# what `remote add` runs on a server after that: the skill, the runbook and
# the docs in ~/.facilitator/skill, laid out the way the checkout lays them out
# so the skill finds them the same way; the server's join key beside it; and
# the skill's links, made only where nothing else holds those names
INSTALLER = r'''
import base64, json, os, shutil, sys


def private(path):
    if os.path.islink(path) or (os.path.lexists(path) and not os.path.isdir(path)):
        raise SystemExit(json.dumps({"error": path + " is not a folder"}))
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def main(payload):
    os.umask(0o077)
    home = os.path.expanduser("~")
    top = os.path.join(home, ".facilitator")
    private(top)
    private(os.path.join(top, "agents"))
    skill, new, old = (os.path.join(top, n) for n in ("skill", "skill.new", "skill.old"))
    shutil.rmtree(new, ignore_errors=True)
    for rel, (data, mode) in sorted(payload["files"].items()):
        path = os.path.join(new, rel)
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        os.chmod(path, mode)
    shutil.rmtree(old, ignore_errors=True)
    if os.path.lexists(skill):
        os.rename(skill, old)
    os.rename(new, skill)
    shutil.rmtree(old, ignore_errors=True)
    tmp = os.path.join(top, "join.key.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(payload["join"] + "\n")
    os.replace(tmp, os.path.join(top, "join.key"))
    target = os.path.join(skill, ".agents", "skills", "facilitator")
    links = {}
    for parent in (os.path.join(home, ".agents", "skills"), os.path.join(home, ".claude", "skills")):
        link = os.path.join(parent, "facilitator")
        if os.path.islink(link) and os.readlink(link) == target:
            links[link] = "kept"
        elif os.path.lexists(link):
            links[link] = "taken"
        else:
            os.makedirs(parent, exist_ok=True)
            os.symlink(target, link)
            links[link] = "made"
    sys.stdout.write(json.dumps({"ok": True, "skill": skill, "links": links}) + "\n")
'''

# what goes into ~/.facilitator/skill, from the checkout
BUNDLE = (".agents/skills/facilitator/SKILL.md", ".agents/skills/facilitator/scripts/onboard.py",
          "app/RUNBOOK.md")


def bundle(clone: Path, rec: dict) -> dict:
    """The skill's files as the installer takes them, {relative path: [base64,
    mode]}, with the docs and the server's own remote.json."""
    files = {}
    names = list(BUNDLE) + sorted("docs/" + p.name for p in (clone / "docs").glob("*.md"))
    for rel in names:
        data = (clone / rel).read_bytes()
        files[rel] = [base64.b64encode(data).decode(), 0o700 if rel.endswith(".py") else 0o600]
    remote = {"server": rec["id"], "name": rec["name"], "home": rec["home"].rstrip("/") + "/" + REMOTE_DIR}
    files["remote.json"] = [base64.b64encode((json.dumps(remote, indent=1) + "\n").encode()).decode(), 0o600]
    return files


def probe(dest: str) -> dict:
    """Log in once and read what the record needs. Raises Problem with ssh's
    own last lines when the login does not work."""
    try:
        r = subprocess.run(ssh_argv(dest, command="sh -s"), input=PROBE.encode(),
                           capture_output=True, timeout=CONNECT_TIMEOUT + COMMAND_TIMEOUT)
    except FileNotFoundError:
        raise Problem("ssh was not found on this Mac.")
    except subprocess.TimeoutExpired:
        raise Problem(f"Logging in to {dest} took too long.", "Check that the server is up and reachable, then try again.")
    if r.returncode != 0:
        said = last_words(r.stderr)
        raise Problem(f"Could not log in to {dest} with ssh.",
                      *(["ssh said: " + line for line in said]),
                      f"Make `ssh {dest}` work without a password prompt first: your ssh key on the",
                      "server, its passphrase in the Keychain or the ssh agent. Then run this again.")
    found = {}
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            found[key.strip()] = value.strip()
    home = found.get("home", "")
    if not home.startswith("/") or ":" in home:
        raise Problem(f"{dest} did not name a home folder this link can use.")
    if len(home.rstrip("/") + "/" + REMOTE_DIR + "/" + SOCKET_NAME) > SERVER_PATH_MAX:
        raise Problem(f"The home folder on {dest} has too long a path for the link's socket.")
    version = found.get("version", "")
    try:
        major, minor = (int(part) for part in version.split("."))
    except ValueError:
        major, minor = 0, 0
    if not found.get("python") or (major, minor) < (3, 7):
        raise Problem(f"{dest} has no python3 of 3.7 or newer on the path a login gets.",
                      "The agent's helper and the folder listing run on it. Install python3 there, then run this again.")
    return {"home": home.rstrip("/") or "/", "system": found.get("system", ""), "python": found["python"]}


def install(dest: str, rec: dict, join_key: str, clone: Path) -> dict:
    """Put the skill and the join key on the server. Answers the installer's
    {ok, skill, links}; raises Problem when it could not."""
    payload = {"files": bundle(clone, rec), "join": join_key}
    text = (INSTALLER + "\nmain(json.loads(" + repr(json.dumps(payload)) + "))\n").encode()
    try:
        r = subprocess.run(ssh_argv(dest, "-T", command=shlex.quote(rec["python"]) + " -"), input=text,
                           capture_output=True, timeout=CONNECT_TIMEOUT + COMMAND_TIMEOUT * 3)
    except subprocess.TimeoutExpired:
        raise Problem(f"Putting the skill on {dest} took too long.", "Try again.")
    lines = r.stdout.decode("utf-8", "replace").strip().splitlines()
    try:
        answer = json.loads(lines[-1]) if lines else {}
    except ValueError:
        answer = {}
    if r.returncode != 0 or not answer.get("ok"):
        raise Problem(f"Could not put the skill on {dest}.",
                      *([answer["error"]] if answer.get("error") else ["ssh said: " + line for line in last_words(r.stderr)]))
    return answer


# ---- the link ---------------------------------------------------------------------------

class Link:
    """One server's ssh link, kept up by a thread of its own for as long as the
    board runs: log in as a ControlMaster, clear a socket a dropped link left on
    the server, forward that socket to the board's own, then wait for the
    login to end and try again, sooner at first and then every BACKOFF[-1]
    seconds. up and since say what the pages are shown."""

    def __init__(self, rec: dict, board_socket: Path, control: Path, note=None):
        self.rec = rec
        self.board_socket = board_socket
        self.control = control
        self.note = note or (lambda *a, **k: None)
        self.up = False
        self.since = time.time()
        self.reason = "starting"
        self._stop = threading.Event()
        self._proc = None
        self._thread = None
        self._lock = threading.Lock()

    @property
    def id(self) -> str:
        return self.rec["id"]

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="remote-link", daemon=True)
        self._thread.start()

    def stop(self, wait: float = 3.0) -> None:
        self._stop.set()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=wait)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    proc.kill()
                except OSError:
                    pass
        self._end_old_master()
        if self._thread is not None:
            self._thread.join(timeout=wait)

    def state(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        with self._lock:
            up, since = self.up, self.since
        return {"name": self.rec["name"], "up": up, "faded": (not up) and now - since >= FADE_AFTER}

    def _set(self, up: bool, reason: str) -> None:
        with self._lock:
            changed = up != self.up
            self.up = up
            self.reason = reason
            if changed:
                self.since = time.time()
        if changed:
            self.note("remotelink", server=short(self.id), up=up, reason=reason)

    def _mux(self, *options, command=None, timeout=COMMAND_TIMEOUT, data=None):
        """One ssh through this link's login: no new login, no prompt."""
        argv = ssh_argv(self.rec["dest"], "-S", str(self.control), "-o", "ControlMaster=no", *options,
                        command=command)
        return subprocess.run(argv, input=data, stdin=None if data is not None else subprocess.DEVNULL,
                              capture_output=True, timeout=timeout)

    def _end_old_master(self) -> None:
        """A master a board before this one left running, or this one's own on
        the way out: asked to exit through its control socket, and the socket
        taken away."""
        if not os.path.exists(self.control):
            return
        try:
            self._mux("-O", "exit", timeout=5)
        except (OSError, subprocess.SubprocessError):
            pass
        try:
            if stat.S_ISSOCK(os.lstat(self.control).st_mode):
                os.unlink(self.control)
        except OSError:
            pass

    def _once(self) -> str:
        """One login, held for as long as it lasts. Answers why it ended."""
        self._end_old_master()
        sock = server_socket(self.rec)
        try:
            proc = subprocess.Popen(
                ssh_argv(self.rec["dest"], "-M", "-S", str(self.control), "-N", "-T",
                         "-o", "ControlPersist=no", "-o", f"ServerAliveInterval={KEEPALIVE}",
                         "-o", f"ServerAliveCountMax={KEEPALIVE_MISSES}", "-o", "ExitOnForwardFailure=yes"),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
        except OSError:
            return "ssh could not start"
        self._proc = proc
        try:
            deadline = time.monotonic() + CONNECT_TIMEOUT + 10
            logged_in = False
            while proc.poll() is None and time.monotonic() < deadline and not self._stop.is_set():
                try:
                    if self._mux("-O", "check", timeout=5).returncode == 0:
                        logged_in = True
                        break
                except (OSError, subprocess.SubprocessError):
                    pass
                self._stop.wait(0.3)
            if not logged_in:
                return "stopped" if self._stop.is_set() else "login failed"
            folder = sock.rsplit("/", 1)[0]
            clear = self._mux(command=f"umask 077; mkdir -p {shlex.quote(folder)}; rm -f {shlex.quote(sock)}")
            if clear.returncode != 0:
                return "could not clear the socket"
            forward = self._mux("-O", "forward", "-R", f"{sock}:{self.board_socket}")
            if forward.returncode != 0:
                return "forward refused"
            self._set(True, "up")
            while proc.poll() is None and not self._stop.is_set():
                self._stop.wait(1.0)
            return "stopped" if self._stop.is_set() else "link lost"
        except (OSError, subprocess.SubprocessError):
            return "ssh failed"
        finally:
            if proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired):
                    proc.kill()
            self._proc = None

    def _run(self) -> None:
        tries = 0
        while not self._stop.is_set():
            began = time.monotonic()
            why = self._once()
            self._set(False, why)
            if self._stop.is_set():
                break
            if time.monotonic() - began >= STEADY:
                tries = 0
            self._stop.wait(BACKOFF[min(tries, len(BACKOFF) - 1)])
            tries += 1


# ---- all of them ---------------------------------------------------------------------------

class Remote:
    """The board's servers: their links, their keys and what the board asks of
    them. One per board, made at its start; the gate and the routes ask it."""

    def __init__(self, data: Path, note=None, links: bool = True):
        self.data = Path(data)
        self.store = Store(self.data)
        self.note = note or (lambda *a, **k: None)
        self.sockets = socket_dir(self.data)
        self.board_socket = self.sockets / SOCKET_NAME
        self.links: dict = {}
        self.records: dict = {}
        self.started = time.time()
        self.run_links = links
        self._lock = threading.Lock()
        self._keys = self.store.keys()

    # -- the servers and their links
    def control(self, sid: str) -> Path:
        return self.sockets / hashlib.sha256(sid.encode()).hexdigest()[:6]

    def reload(self) -> list:
        """Read servers.json again: a new server's link starts, a removed one's
        stops, one whose login changed starts again; keys of a removed server's
        lanes go. Answers the server ids now known."""
        records = {rec["id"]: rec for rec in self.store.servers()}
        with self._lock:
            gone = [sid for sid in self.links if sid not in records
                    or records[sid]["dest"] != self.records[sid]["dest"]
                    or records[sid]["home"] != self.records[sid]["home"]]
            stopping = [self.links.pop(sid) for sid in gone]
            self.records = records
            fresh = []
            for sid, rec in records.items():
                if sid not in self.links:
                    link = Link(rec, self.board_socket, self.control(sid), self.note)
                    self.links[sid] = link
                    fresh.append(link)
                else:
                    self.links[sid].rec = rec
            stale = [lane for lane, v in self._keys.items() if v["server"] not in records]
            for lane in stale:
                del self._keys[lane]
            if stale:
                self.store.save_keys(self._keys)
        for link in stopping:
            link.stop()
        if self.run_links:
            for link in fresh:
                link.start()
        return sorted(records)

    def stop(self) -> None:
        with self._lock:
            links = list(self.links.values())
        for link in links:
            link.stop()

    def server(self, sid: str):
        with self._lock:
            return self.records.get(sid)

    def is_up(self, sid: str) -> bool:
        link = self.links.get(sid)
        return bool(link and link.up)

    def status(self, now: float | None = None) -> dict:
        """{id: {name, up, faded}} for every server, what the pages draw."""
        with self._lock:
            links = dict(self.links)
        return {sid: link.state(now) for sid, link in links.items()}

    def listing(self) -> list:
        """The servers for `facilitator remote list`: never a key or its hash."""
        now = time.time()
        with self._lock:
            links = dict(self.links)
        return [{"id": sid, "name": link.rec["name"], "dest": link.rec["dest"], "up": link.up,
                 "since": link.since, "reason": link.reason, "faded": link.state(now)["faded"]}
                for sid, link in sorted(links.items())]

    def machines(self) -> list:
        """Each server as the folder picker's /machines lists a machine."""
        with self._lock:
            links = dict(self.links)
        out = []
        for sid, link in sorted(links.items()):
            home = link.rec["home"]
            out.append({"id": sid, "name": link.rec["name"], "kind": "server", "online": link.up,
                        "top": home, "home": home, "sep": "/",
                        "places": [{"id": "home", "name": home.rstrip("/").rsplit("/", 1)[-1] or home,
                                    "path": home}]})
        return out

    # -- what the board asks a server
    def ask(self, sid: str, op: str, *args) -> tuple:
        """Run one of PROGRAM's operations on the server over its link's login:
        (200, answer) or (400, {error}) in plain words."""
        rec = self.server(sid)
        if rec is None:
            return 400, {"error": "no such machine"}
        link = self.links.get(sid)
        if link is None or not link.up:
            return 400, {"error": rec["name"] + " is not connected"}
        try:
            r = link._mux("-T", command=shlex.quote(rec["python"]) + " -", data=program_text(op, *args))
        except subprocess.TimeoutExpired:
            return 400, {"error": rec["name"] + " took too long to answer"}
        except OSError:
            return 400, {"error": rec["name"] + " could not be asked"}
        lines = r.stdout.decode("utf-8", "replace").strip().splitlines()
        try:
            out = json.loads(lines[-1]) if lines else None
        except ValueError:
            out = None
        if not isinstance(out, dict):
            return 400, {"error": rec["name"] + " could not be asked"}
        if out.get("error"):
            return 400, {"error": str(out["error"])}
        return 200, out.get("answer")

    def list_dirs(self, sid: str, path: str, base: str) -> tuple:
        status, answer = self.ask(sid, "dirs", path, base)
        if status == 200 and isinstance(answer, dict):
            answer = {"machine": sid, **answer}
        return status, answer

    def make_dir(self, sid: str, path: str, name: str) -> tuple:
        return self.ask(sid, "mkdir", path, name)

    def describe(self, sid: str, path: str) -> tuple:
        return self.ask(sid, "describe", path)

    # -- keys
    def server_of_join(self, key: str):
        """The server whose join key this is, or None."""
        if not key:
            return None
        h = digest(key)
        with self._lock:
            records = list(self.records.values())
        for rec in records:
            if hmac.compare_digest(rec["join"], h):
                return rec
        return None

    def mint(self, lane: str, sid: str) -> str:
        """A new key for the lane, which ends the lane's earlier one."""
        key = new_key()
        with self._lock:
            self._keys[lane] = {"hash": digest(key), "server": sid, "ts": round(time.time())}
            self.store.save_keys(self._keys)
        return key

    def lane_of(self, key: str):
        """(lane, server id) for an agent key, or None."""
        if not key:
            return None
        h = digest(key)
        with self._lock:
            items = list(self._keys.items())
            known = set(self.records)
        for lane, v in items:
            if hmac.compare_digest(v["hash"], h) and v["server"] in known:
                return lane, v["server"]
        return None

    def forget(self, lane: str) -> None:
        with self._lock:
            if self._keys.pop(lane, None) is not None:
                self.store.save_keys(self._keys)


# ---- which lane a join asks for -------------------------------------------------------------

def _within(path: str, root: str) -> bool:
    root = root.rstrip("/") or "/"
    return path == root or path.startswith(root + "/") or root == "/"


def resolve_lane(projects: list, path=None, name=None, git=None) -> tuple:
    """The lanes of one server a join can mean, as the helper on the Mac picks
    a lane: by id or name when one is named, else the project folder holding
    the path (the deepest), else a project of the same git repository.
    Answers (matches, the status for none)."""
    if name is not None:
        exact = [p["id"] for p in projects if p["id"] == name]
        if exact:
            return exact, "project_unknown"
        folded = name.casefold()
        return sorted({p["id"] for p in projects
                       if p["id"].casefold() == folded or str(p.get("name", "")).casefold() == folded}), "project_unknown"
    if not path:
        return [], "path_missing"
    holding = [p for p in projects if isinstance(p.get("dir"), str) and _within(path, p["dir"])]
    if holding:
        depth = max(len(p["dir"].rstrip("/")) for p in holding)
        return sorted(p["id"] for p in holding if len(p["dir"].rstrip("/")) == depth), "project_unknown"
    if git:
        same = sorted(p["id"] for p in projects if p.get("git") and p["git"] == git)
        if same:
            return same, "project_unknown"
    return [], "project_unknown"


def presence_status(presence: dict) -> str:
    """ready, or why a second listener should keep away, by the same rules the
    helper on the Mac reads off /state."""
    if presence.get("busy"):
        return "claim_held"
    if presence.get("listening") or presence.get("gap", 1e9) < 60:
        return "listener_present"
    return "ready"


# ---- the gate -----------------------------------------------------------------------------------

def _bearer(scope) -> str:
    for name, value in scope.get("headers") or ():
        if name.lower() == b"authorization":
            text = value.decode("latin-1").strip()
            if text[:7].lower() == "bearer ":
                return text[7:].strip()
            return ""
    return ""


async def _reply(send, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store"),
                            (b"content-length", str(len(body)).encode()), (b"connection", b"close")]})
    await send({"type": "http.response.body", "body": body})


async def _read_body(receive, cap: int, wait: float = 10.0):
    body = bytearray()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    while True:
        try:
            event = await asyncio.wait_for(receive(), timeout=max(0.0, deadline - loop.time()))
        except asyncio.TimeoutError:
            return None
        if event["type"] != "http.request":
            return None
        body.extend(event.get("body", b""))
        if len(body) > cap:
            return None
        if not event.get("more_body"):
            return bytes(body)


REFUSAL_WINDOW = 5.0     # seconds: one refusal line per reason and route per window


class RemoteGate:
    """Every request that came through a link, decided here before any route
    sees it. Everything else passes untouched.

    board is the server's side of it: board.remote (the Remote, or None when
    no link runs), board.projects(server id), board.presence(lane) and
    board.box_lane(box), each taking the board's lock itself, and
    board.log(kind, **fields). A line names a route and a reason, never a key."""

    def __init__(self, app, board):
        self.app = app
        self.board = board
        self._noted: dict = {}

    def _refuse_note(self, route: str, reason: str) -> None:
        try:
            now = time.monotonic()
            name = reason + " " + route
            window = self._noted.get(name)
            if window is not None and now - window[0] < REFUSAL_WINDOW:
                window[1] += 1
                return
            if len(self._noted) > 64:
                self._noted.clear()
            self._noted[name] = [now, 0]
            # a route outside the list is named as other, so nothing the
            # request made up reaches the file
            known = route in KNOWN_ROUTES or route == "/remote/join"
            self.board.log("remoterefused", route=route if known else "other",
                           reason=reason, folded=(window[1] if window else 0) or None)
        except Exception:
            pass

    async def _in_thread(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or tuple(scope.get("server") or ()) != SERVER_MARK:
            await self.app(scope, receive, send)
            return
        path, method = scope.get("path", ""), scope.get("method", "")
        remote = self.board.remote
        if remote is None:
            await _reply(send, 503, {"error": "this board runs no links"})
            return
        key = _bearer(scope)
        if (method, path) == ("POST", "/remote/join"):
            await self._join(scope, receive, send, remote, key)
            return
        held = remote.lane_of(key)
        if held is None:
            self._refuse_note(path, "key")
            await _reply(send, 401, {"error": "this key is not known: join again"})
            return
        lane, sid = held
        rule = AGENT_ROUTES.get((method, path))
        if rule is None:
            self._refuse_note(path, "route")
            await _reply(send, 403, {"error": "an agent on a server may not use this"})
            return
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
        if rule == "lane":
            presence = await self._in_thread(self.board.presence, lane)
            await _reply(send, 200, {"owner": lane, "server": sid, **presence})
            return
        if rule == "owner":
            ok = query.get("owner") == [lane]
        else:
            boxes = query.get("box") or []
            ok = len(boxes) == 1 and await self._in_thread(self.board.box_lane, boxes[0]) == lane
        if not ok:
            self._refuse_note(path, "lane")
            await _reply(send, 403, {"error": "this key is for another project"})
            return
        await self.app({**scope, "facilitator.remote": {"lane": lane, "server": sid}}, receive, send)

    async def _join(self, scope, receive, send, remote, key):
        rec = remote.server_of_join(key)
        if rec is None:
            self._refuse_note("/remote/join", "key")
            await _reply(send, 401, {"error": "this server's key is not known: add the server again from the Mac"})
            return
        raw = await _read_body(receive, JOIN_BODY_MAX)
        try:
            asked = json.loads(raw) if raw else None
        except ValueError:
            asked = None
        if not isinstance(asked, dict):
            await _reply(send, 400, {"error": "a join names a path or a board"})
            return
        path, name, git = (asked.get(k) if isinstance(asked.get(k), str) else None for k in ("path", "board", "git"))
        projects = await self._in_thread(self.board.projects, rec["id"])
        matches, problem = resolve_lane(projects, path, name, git)
        if len(matches) != 1:
            status = "ambiguous" if matches else problem
            self.board.log("remotejoin", server=short(rec["id"]), status=status)
            await _reply(send, 200, {"status": status, "matches": matches,
                                     "available": sorted(p["id"] for p in projects)})
            return
        lane = matches[0]
        presence = await self._in_thread(self.board.presence, lane)
        status = presence_status(presence)
        self.board.log("remotejoin", server=short(rec["id"]), status=status)
        answer = {"status": status, "owner": lane, "server": rec["name"]}
        if status == "claim_held":
            answer["box"] = presence.get("busy")
        if status == "ready":
            answer["key"] = remote.mint(lane, rec["id"])
        await _reply(send, 200, answer)
