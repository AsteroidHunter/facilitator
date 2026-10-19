#!/usr/bin/env python3
"""This server's link to the owner's Facilitator board.

A process of the owner's own account on this server, started by the setup
program (scripts/pair.py) and by the agent's helper whenever it is not
running. It connects out to the board's agent door over the tailnet with
this server's key and holds a short poll there; on a poll the board hands it
the folder picker's questions about this server, and the next poll carries
the answers back. It answers three questions and no others: a folder's
subfolders, a new folder, and a folder's real path with its repository, all
inside this account's home, with no link followed out of it, no hidden
folder and the same limits and words as the board's own folder picker. It
runs no command and reads no file but the few git keeps to say where a
repository is. While the board cannot be reached it tries again, sooner at
first and then every 15 seconds; nothing else on this server depends on it.

    python3 link.py start     run in the background, one per account
    python3 link.py stop      stop it
    python3 link.py status    whether it runs and whether the board answers
    python3 link.py run       run in the foreground

Its files are in ~/.facilitator, for this account alone: the server's key
(server.key), the lock that keeps it to one (link.lock), what it last heard
(link.state) and a short log (link.log), which never holds a key or an
address. Runs on python3 3.7 and newer, standard library only."""

import fcntl
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

SKILL_TOP = Path(__file__).resolve().parents[4]
REMOTE_FILE = SKILL_TOP / "remote.json"
HOLD = 10                      # seconds the board holds a poll
SLACK = 15                     # seconds more a poll may take on the wire
BACKOFF = (1, 2, 5, 10, 15)    # seconds before each new try; the last one repeats
ASKS_MAX = 8                   # questions one poll may bring
LOG_MAX = 256 * 1024           # bytes of link.log before it is started afresh

# the folder picker's own limits and words, as the board keeps them for its
# own folders (server.py's FOLDER_ constants and _folder_name_problem)
ROWS_MAX = 2000
SCAN_MAX = 50000
SCAN_TIME = 2.0
COUNT_MAX = 9999
COUNT_TIME = 0.4
PATH_MAX = 4096
NAME_MAX = 255
NAME_BAD = set('<>:"|?*')
JOINERS = set((chr(0x200C), chr(0x200D)))


# ---- the three questions ------------------------------------------------------------

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


def typed(text, t):
    """~ alone or before a slash is home; another account's ~name is never
    looked up, so no answer can tell which accounts there are."""
    if not text.startswith("~"):
        return text
    if text == "~" or text[1] == "/":
        return t + text[1:]
    return None


def named(path, base, t):
    if max(len(path.encode("utf-8", "surrogatepass")), len(base.encode("utf-8", "surrogatepass"))) > PATH_MAX:
        return None, "that path is too long"
    try:
        p = typed(path, t) if path else t
        if p is not None and not os.path.isabs(p):
            start = typed(base, t) if base else t
            p = None if start is None else os.path.join(start if os.path.isabs(start) else t, p)
        if p is None:
            return None, "outside the home folder"
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
    """p's subfolders, sorted, and whether the reading stopped short: a folder
    of more than SCAN_MAX names, or a disk slower than SCAN_TIME, is read that
    far and no further. A link is listed only where it may be opened."""
    out, seen, cut = [], 0, False
    ends = time.monotonic() + SCAN_TIME
    with os.scandir(p) as entries:
        for e in entries:
            seen += 1
            if seen > SCAN_MAX or time.monotonic() > ends:
                cut = True
                break
            if e.name.startswith("."):
                continue
            try:
                if not e.is_dir():
                    continue
                st = e.stat()
                if e.is_symlink():
                    target = os.path.realpath(e.path)
                    if not inside(target, t) or hidden_below(target, t):
                        continue
            except (OSError, RuntimeError):
                continue
            if not hidden_mark(st):
                out.append((e.name, e.path, st.st_mtime))
    out.sort(key=lambda row: natural(row[0]))
    return out, cut


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
              "trail": trail, "dirs": [], "more": 0, "cut": False, "unreadable": False}
    try:
        found, answer["cut"] = rows(p, t)
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
    if any(unicodedata.category(c) == "Cc" for c in name):
        return "a folder name cannot hold a control character"
    if any(unicodedata.category(c) in ("Cf", "Cs", "Zl", "Zp") and c not in JOINERS for c in name):
        return "a folder name cannot hold an invisible character"
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


def _first_line(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read(4096).strip()


def git_common(p):
    """The repository holding p, as its git common dir, found the way git
    finds it without running git: the nearest folder at or above p with a
    .git, either the repository itself or, in a worktree, a file naming it,
    and then that one's commondir when it has one. None without a
    repository."""
    at = p
    while True:
        dot = os.path.join(at, ".git")
        gitdir = None
        try:
            if os.path.isdir(dot):
                gitdir = dot
            elif os.path.isfile(dot):
                line = _first_line(dot)
                if not line.startswith("gitdir:"):
                    return None
                named_dir = line[len("gitdir:"):].strip()
                gitdir = named_dir if os.path.isabs(named_dir) else os.path.join(at, named_dir)
        except OSError:
            return None
        if gitdir is not None:
            common = gitdir
            try:
                rel = _first_line(os.path.join(gitdir, "commondir"))
                if rel:
                    common = rel if os.path.isabs(rel) else os.path.join(gitdir, rel)
            except OSError:
                pass
            return os.path.realpath(common)
        parent = os.path.dirname(at)
        if parent == at:
            return None
        at = parent


OPS = {"dirs": (op_dirs, 2), "mkdir": (op_mkdir, 2), "describe": (op_describe, 1)}


def answer(ask):
    """One question from the board, answered: {id, answer} or {id, error}.
    A question that is not one of OPS, or not in its shape, is refused."""
    qid = ask.get("id") if isinstance(ask, dict) else None
    if not isinstance(qid, str):
        return None
    op, args = ask.get("op"), ask.get("args")
    if op not in OPS or not isinstance(args, list) or len(args) != OPS[op][1] \
            or not all(isinstance(a, str) for a in args):
        return {"id": qid, "error": "the server does not answer that"}
    try:
        out = OPS[op][0](*args)
    except Exception:
        out = {"error": "the server could not answer that"}
    return {"id": qid, **out}


# ---- this account's files -------------------------------------------------------------

def record():
    """remote.json beside this skill copy: {server, name, board, home}, home
    being ~/.facilitator. None when this skill was not set up on a server."""
    try:
        rec = json.loads(REMOTE_FILE.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or not isinstance(rec.get("home"), str) or not rec["home"].startswith("/") \
            or not isinstance(rec.get("board"), str) or not re.fullmatch(r"https?://[^/?#\s]+", rec["board"]):
        return None
    return rec


def private_write(path, text):
    """Written whole, for this account alone."""
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(text)
    os.replace(str(tmp), str(path))


def files(rec):
    home = Path(rec["home"])
    return {"key": home / "server.key", "lock": home / "link.lock", "state": home / "link.state",
            "log": home / "link.log"}


def note(rec, words):
    """One line in link.log, with the time. A log past LOG_MAX starts again."""
    path = files(rec)["log"]
    try:
        if path.exists() and path.stat().st_size > LOG_MAX:
            os.replace(str(path), str(path) + ".1")
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + words + "\n")
    except OSError:
        pass


def write_state(rec, connected, refused=False):
    try:
        private_write(files(rec)["state"], json.dumps({"connected": connected, "refused": refused,
                                                       "since": round(time.time()), "pid": os.getpid()}) + "\n")
    except OSError:
        pass


def read_state(rec):
    try:
        st = json.loads(files(rec)["state"].read_text())
    except (OSError, ValueError):
        return {}
    return st if isinstance(st, dict) else {}


def holder(rec):
    """The pid of the link that runs now, or None. Read off the lock, which
    the kernel lets go of however the link ended, so a stale pid in the file
    is never taken for a live one."""
    path = files(rec)["lock"]
    try:
        fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            try:
                return int(os.pread(fd, 32, 0).decode().strip() or 0) or -1
            except (OSError, ValueError):
                return -1
        fcntl.flock(fd, fcntl.LOCK_UN)
        return None
    finally:
        os.close(fd)


def take_lock(rec):
    """The lock for this link, held until the process ends, or None when
    another link holds it."""
    fd = os.open(str(files(rec)["lock"]), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.pwrite(fd, str(os.getpid()).encode(), 0)
    return fd


# ---- the board ------------------------------------------------------------------------

class Unreachable(Exception):
    """The board's door did not answer: the tailnet, the Mac or the board is
    away. Its words never hold an address."""


# no proxy, ever: a proxy named in this account's settings would be handed
# the server's key with every poll
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(url, key, body, timeout):
    """(status, answer) from the board. Unreachable when nothing answers."""
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": "Bearer " + key,
                                              "Content-Type": "application/json"})
    try:
        with OPENER.open(request, timeout=timeout) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as refused:
        with refused:
            raw, status = refused.read(), refused.code
    except (urllib.error.URLError, OSError, ValueError) as problem:
        reason = getattr(problem, "reason", problem)
        raise Unreachable(getattr(reason, "strerror", None) or type(reason).__name__)
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def run(rec):
    """The link itself, until it is stopped or the board refuses its key."""
    lock = take_lock(rec)
    if lock is None:
        print("The link already runs.")
        return 0
    try:
        key = files(rec)["key"].read_text().strip()
    except OSError:
        note(rec, "no server key here: pair this server again")
        write_state(rec, False, refused=True)
        return 1
    url = rec["board"].rstrip("/") + "/remote/link"
    note(rec, "started")
    connected, tries, answers = None, 0, []
    while True:
        try:
            status, said = post(url, key, {"answers": answers}, HOLD + SLACK)
        except Unreachable as problem:
            if connected is not False:
                note(rec, "the board cannot be reached (" + str(problem) + "); trying again")
                write_state(rec, False)
            connected, answers = False, []
            time.sleep(BACKOFF[min(tries, len(BACKOFF) - 1)])
            tries += 1
            continue
        if status == 401:
            note(rec, "the board no longer knows this server's key: pair this server again")
            write_state(rec, False, refused=True)
            return 1
        if status != 200 or not isinstance(said, dict):
            if connected is not False:
                note(rec, "the board answered a poll with " + str(status) + "; trying again")
                write_state(rec, False)
            connected, answers = False, []
            time.sleep(BACKOFF[min(tries, len(BACKOFF) - 1)])
            tries += 1
            continue
        tries = 0
        if connected is not True:
            note(rec, "connected to the board")
            write_state(rec, True)
        connected = True
        asks = said.get("asks") if isinstance(said.get("asks"), list) else []
        answers = [a for a in (answer(ask) for ask in asks[:ASKS_MAX]) if a is not None]


def start(rec, quiet=False):
    """The link in the background, in a session of its own, so it outlives
    the login that started it."""
    pid = holder(rec)
    if pid:
        if not quiet:
            print("The link already runs" + (" (pid " + str(pid) + ")." if pid > 0 else "."))
        return 0
    log = files(rec)["log"]
    fd = os.open(str(log), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "run"], cwd=rec["home"],
                         stdin=subprocess.DEVNULL, stdout=fd, stderr=fd, start_new_session=True, close_fds=True)
    finally:
        os.close(fd)
    ends = time.monotonic() + 5
    while time.monotonic() < ends:
        pid = holder(rec)
        if pid:
            if not quiet:
                print("The link runs in the background (pid " + str(pid) + ").")
            return 0
        time.sleep(0.1)
    if not quiet:
        print("The link did not start; see " + str(log))
    return 1


def stop(rec):
    pid = holder(rec)
    if not pid or pid < 0:
        print("The link is not running." if not pid else "The link runs, but its pid could not be read.")
        return 0 if not pid else 1
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    ends = time.monotonic() + 5
    while time.monotonic() < ends and holder(rec):
        time.sleep(0.1)
    if holder(rec):
        print("The link did not stop (pid " + str(pid) + ").")
        return 1
    write_state(rec, False)
    print("The link is stopped.")
    return 0


def status(rec):
    pid = holder(rec)
    st = read_state(rec)
    if not pid:
        print("The link is not running. Start it with: python3 " + str(Path(__file__).resolve()) + " start")
        return 1
    since = time.strftime("%H:%M:%S", time.localtime(st["since"])) if isinstance(st.get("since"), int) else "?"
    if st.get("connected") and st.get("pid") == pid:
        print("The link runs (pid " + str(pid) + ") and is connected to the board, since " + since + ".")
    else:
        print("The link runs (pid " + str(pid) + ") but the board cannot be reached now; it keeps trying.")
    return 0


def main(argv):
    words = argv[1:]
    if words not in (["start"], ["start", "--quiet"], ["stop"], ["status"], ["run"]):
        print("usage: link.py start | stop | status | run")
        return 2
    rec = record()
    if rec is None:
        print("This skill is not set up on a server: pair it first (facilitator remote pair, on the Mac).")
        return 1
    if words[0] == "run":
        try:
            return run(rec)
        except KeyboardInterrupt:
            return 0
    if words[0] == "start":
        return start(rec, quiet=words[1:] == ["--quiet"])
    return stop(rec) if words[0] == "stop" else status(rec)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
