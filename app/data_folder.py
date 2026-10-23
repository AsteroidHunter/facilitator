"""Where the board keeps what it writes, and the one-time move of an older
checkout's files into it.

Everything the board writes lives in data/ at the top of the checkout (the
folder that was cloned), beside app/, which holds the program: cards, history,
settings, profile, run.config.json, seed.json, attachments, logs, magic boxes,
the push key, the phone's sign-in, caches, records, the server's lock and its
.venv. git ignores the folder.

A checkout from before this kept those files at its own top, with attachments
and logs in facilitator-internal/ beside it. `facilitator update` moves them
into data/ once. Until it has, the board does not start (unfinished below), so
it can never open a fresh board from seed.json while the real cards wait in
the old place.

The move copies and never renames the board's files in place. Before anything
is copied it backs every one of them up into data/backups and checks the copy;
each file then lands in data/ only after its copy matches the original's
SHA-256; and the old copies are removed only by finish, once the board, started
again from app/, shows every card the old state.json held, and only after each
old file and its backup copy have been read and checked once more. An
interrupted move leaves the .moving marker, and running it again carries on.

Standard library only, and Python 3.9 compatible: the facilitator command
imports this on the python3 macOS ships, and server.py on .venv's Python.
"""
import ctypes
import fcntl
import fnmatch
import hashlib
import json
import os
import shutil
import stat
import tempfile
import time
from pathlib import Path

DATA_NAME = "data"
# in data/: the move has started writing and has not finished; while this is
# there neither the server nor the command starts anything
MOVING = ".moving"
# in data/: the record of a move that has copied everything into place
MOVED = ".moved"
# in data/: where the backups go, the staging the copies land in first
BACKUPS = "backups"
STAGING = ".moving-staging"
BACKUP_PREFIX = "before-data-move-"
PARTIAL = ".partial"

# The board's files at an older checkout's top, by name or pattern. Each goes
# into data/ under the same name.
TOP_FILES = (
    "state.json", "state.json.bak-*", "state.tmp", "transcript.jsonl",
    "settings.json", "settings.json.tmp", "settings.json.bad-*",
    "profile.json", "profile.json.tmp",
    "run.config.json", "run.config.json.tmp", "seed.json",
    "vapid-key.pem", "bridge-auth.json", ".bridge-auth-*",
    "tokens-cache.json", "tokens-cache.json.tmp",
    "claude-limits.json", "claude-limits.json.tmp",
    "usage-counts.json", "usage-counts.json.tmp",
    "usage-install.json", "usage-install.json.tmp",
    ".facilitator-install.json", ".facilitator-skills.json", ".facilitator-skills.tmp",
    ".facilitator-statusline.json", ".facilitator-statusline.tmp",
    ".facilitator-updates.json", ".facilitator-updates.tmp",
)
# folders at the old top and the folder each becomes in data/. The old in-repo
# uploads/ stays a folder of its own, read after data/uploads as it was read
# after the folder beside the checkout, so every address serves the same file
TOP_FOLDERS = {"magic-boxes": "magic-boxes", "uploads": "uploads-old"}
# the folder beside an older checkout, and what of it was the board's
BESIDE = "facilitator-internal"
BESIDE_FOLDERS = {"uploads": "uploads", "logs": "logs"}
# held by a running server, never data: not copied, and removed at the finish
LOCKS = ("server.lock", "bridge-auth.lock")
# what a backup calls the two old places
BACKUP_TOP = "checkout"
BACKUP_BESIDE = "facilitator-internal"
# room kept free on top of what the copies need
SPARE_BYTES = 64 * 1024 * 1024


def data_dir(clone):
    return Path(clone) / DATA_NAME


def old_items(clone):
    """The board's files and folders still at an older checkout's top, by
    name, in a stable order. Neither .venv nor a lock counts: they are not
    the board's data."""
    clone = Path(clone)
    try:
        names = sorted(os.listdir(clone))
    except OSError:
        return []
    found = []
    for name in names:
        if name in TOP_FOLDERS or any(fnmatch.fnmatchcase(name, pattern) for pattern in TOP_FILES):
            found.append(name)
    return found


def unfinished(clone):
    """(headline, next step) when the board must not start because its files
    are part way through moving into data/, or have not moved yet; None when
    it may start: the move has been made, or there is nothing to move."""
    data = data_dir(clone)
    if (data / MOVING).exists():
        return ("This board's files are part way through moving into data/, so the board stayed down.",
                "Run facilitator update to finish the move. Nothing was changed.")
    if (data / MOVED).exists():
        return None
    left = old_items(clone)
    if not left:
        return None
    named = ", ".join(left[:3]) + (f" and {len(left) - 3} more" if len(left) > 3 else "")
    return (f"This board's files are still in their old place at the top of {clone} ({named}), "
            "so the board stayed down.",
            "Run facilitator update to move them into data/. Nothing was changed.")


def state(clone):
    """Where a checkout stands: "moving" (a move started and did not finish),
    "pending" (moved, the old copies not yet removed), "done" (moved and
    finished), "unmoved" (board files at the old top) or "none" (nothing to
    move: a fresh install)."""
    data = data_dir(clone)
    if (data / MOVING).exists():
        return "moving"
    if (data / MOVED).exists():
        record = read_record(clone)
        return "done" if record and record.get("finished") else "pending"
    return "unmoved" if old_items(clone) else "none"


class Refused(Exception):
    """The move or the finish will not go on: a headline and the lines under it."""

    def __init__(self, headline, *lines):
        super().__init__(headline)
        self.headline = headline
        self.lines = list(lines)


# ---- files: hashing and copying ---------------------------------------------

def file_hash(path):
    """The SHA-256 of a file, or of a link's own target text for a link (a
    link is copied as a link, never followed)."""
    if os.path.islink(path):
        return "link:" + hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


_clonefile_fn = []


def _clonefile(src, dst):
    """clonefile(2): a copy that shares the original's blocks until either is
    written, with its own mode, owner and times. Raises OSError where the disk
    or the system does not offer it."""
    if not _clonefile_fn:
        fn = None
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            fn = libc.clonefile
            fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
            fn.restype = ctypes.c_int
        except (OSError, AttributeError):
            fn = None
        _clonefile_fn.append(fn)
    fn = _clonefile_fn[0]
    if fn is None:
        raise OSError(45, "clonefile is not offered here")
    if fn(os.fsencode(src), os.fsencode(dst), 1) != 0:   # 1: CLONE_NOFOLLOW
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def copy_entry(src, dst):
    """Copy one file or link to dst, which must not exist: a link as a link,
    a file as a clone where the disk allows it, else byte for byte with its
    mode and times. A copy cut off part way is removed."""
    if os.path.islink(src):
        os.symlink(os.readlink(src), dst)
        return
    try:
        _clonefile(src, dst)
        return
    except OSError:
        if os.path.lexists(dst):
            os.unlink(dst)
    try:
        shutil.copy2(src, dst, follow_symlinks=False)
    except BaseException:
        try:
            os.unlink(dst)
        except OSError:
            pass
        raise


def _write_json(path, value):
    """A JSON file written whole: a temporary file beside it, then a rename."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(value, f, indent=1)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _stop_here(point, count=0, total=0):
    """The test seam that stops a move the way a kill would, at a named point:
    FACILITATOR_TEST_MOVE_STOP names it, and a point with a count stops half
    way through. Nothing else reads the variable."""
    if os.environ.get("FACILITATOR_TEST_MOVE_STOP") != point:
        return
    if total and count < max(total // 2, 1):
        return
    os._exit(9)


# ---- what the move carries --------------------------------------------------

def _walk(root):
    """Every file and link under root, as paths relative to it, and every
    folder, in a stable order. A link to a folder is a link, not a folder."""
    files, folders = [], []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        here = Path(dirpath)
        for name in list(dirnames):
            if (here / name).is_symlink():
                files.append((here / name).relative_to(root))
                dirnames.remove(name)
            else:
                folders.append((here / name).relative_to(root))
        for name in sorted(filenames):
            files.append((here / name).relative_to(root))
    return files, folders


def _beside(clone):
    return Path(clone).parent / BESIDE


def scan(clone, hashed=True):
    """Everything the move carries, as a list of items, each a dict with the
    source path ("from"), its place in data/ ("to"), its place in the backup
    ("backup"), its size and its SHA-256 (None when not hashed); and the
    folders to make in data/, with the source's mode. The folder beside the
    checkout comes along only for a checkout that still has board files at
    its top: a fresh copy beside it owns none of what is there."""
    clone = Path(clone)
    names = old_items(clone)
    roots = []
    for name in names:
        source = clone / name
        if name in TOP_FOLDERS:
            if source.is_dir():
                roots.append((source, TOP_FOLDERS[name], f"{BACKUP_TOP}/{name}"))
            continue
        if source.is_symlink() or source.is_file():
            roots.append((source, name, f"{BACKUP_TOP}/{name}"))
    if names:
        for name, to in BESIDE_FOLDERS.items():
            source = _beside(clone) / name
            if source.is_dir():
                roots.append((source, to, f"{BACKUP_BESIDE}/{name}"))
    items, folders = [], []
    for source, to, backup in roots:
        if source.is_dir() and not source.is_symlink():
            folders.append({"to": to, "mode": stat.S_IMODE(os.stat(source).st_mode)})
            files, subfolders = _walk(source)
            for sub in subfolders:
                folders.append({"to": f"{to}/{sub.as_posix()}",
                                "mode": stat.S_IMODE(os.stat(source / sub).st_mode)})
            for rel in files:
                items.append(_item(source / rel, f"{to}/{rel.as_posix()}", f"{backup}/{rel.as_posix()}",
                                   hashed=hashed))
        elif source.is_dir():
            # a folder that is a link: what it holds is copied, followed once
            # here, and the link and its target are left alone at the finish
            folders.append({"to": to, "mode": 0o700})
            files, subfolders = _walk(source.resolve())
            for sub in subfolders:
                folders.append({"to": f"{to}/{sub.as_posix()}", "mode": 0o700})
            for rel in files:
                items.append(_item(source / rel, f"{to}/{rel.as_posix()}", f"{backup}/{rel.as_posix()}",
                                   linked=True, hashed=hashed))
        else:
            items.append(_item(source, to, backup, hashed=hashed))
    return items, folders


def _item(source, to, backup, linked=False, hashed=True):
    info = os.lstat(source)
    if not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
        raise Refused(f"{source} is neither a file nor a link, so the move cannot copy it.",
                      "Move it out of the way, then run facilitator update again. Nothing was moved.")
    return {"from": str(source), "to": to, "backup": backup, "size": info.st_size,
            "sha256": file_hash(source) if hashed else None, "linked": linked}


def _card_ids(clone):
    """The ids of the cards in the old state.json, and whether it could be read
    at all: (ids, readable). No state.json is ([], True)."""
    path = Path(clone) / "state.json"
    if not path.exists():
        return [], True
    try:
        boxes = json.loads(path.read_text(encoding="utf-8")).get("boxes")
        return [str(box["id"]) for box in boxes if isinstance(box, dict) and "id" in box], True
    except (OSError, ValueError, AttributeError, TypeError, KeyError):
        return [], False


def manifest_digest(items):
    """One fingerprint for a whole list of items, so a rerun can tell whether
    the files it would back up are the ones a finished backup already holds."""
    digest = hashlib.sha256()
    for item in sorted(items, key=lambda i: i["from"]):
        digest.update(f"{item['from']}\0{item['size']}\0{item['sha256']}\n".encode("utf-8", "surrogateescape"))
    return digest.hexdigest()


def _can_clone(src_dir, target_dir):
    """Whether a file in src_dir can be cloned into target_dir: a probe file,
    removed again whatever happens."""
    probe_src = probe_dst = None
    try:
        fd, probe_src = tempfile.mkstemp(prefix=".facilitator-clone-probe-", dir=str(src_dir))
        os.close(fd)
        probe_dst = probe_src + ".copy"
        if Path(target_dir) != Path(src_dir):
            probe_dst = os.path.join(str(target_dir), os.path.basename(probe_src) + ".copy")
        _clonefile(probe_src, probe_dst)
        return True
    except OSError:
        return False
    finally:
        for path in (probe_src, probe_dst):
            if path and os.path.lexists(path):
                try:
                    os.unlink(path)
                except OSError:
                    pass


def plan(clone, light=False):
    """What the move would do, changing nothing of the board's: the items, the
    folders, the card ids of the old state.json, which items are already in
    data/ with the same bytes, which collide with a different file there, and
    whether the disk has room for the backup and the copy. light hashes only
    the files that already have a counterpart in data/: enough to find every
    clash before the board is stopped, not enough to move anything with."""
    clone = Path(clone)
    data = data_dir(clone)
    items, folders = scan(clone, hashed=not light)
    already, conflicts = [], []
    for item in items:
        dest = data / item["to"]
        if not os.path.lexists(dest):
            continue
        if item["sha256"] is None:
            item["sha256"] = file_hash(item["from"])
        same = (os.path.islink(dest) or dest.is_file()) and file_hash(dest) == item["sha256"]
        (already if same else conflicts).append(item)
    for folder in folders:
        dest = data / folder["to"]
        if os.path.lexists(dest) and not (dest.is_dir() and not dest.is_symlink()):
            conflicts.append({"from": folder["to"], "to": folder["to"], "folder": True})
    ids, readable = _card_ids(clone)
    # room: nothing extra where the disk clones, two full copies where not
    total = sum(item["size"] for item in items)
    need = 2 * total
    if total and _can_clone(clone, clone):
        devices = {os.lstat(item["from"]).st_dev for item in items}
        if devices == {os.stat(clone).st_dev}:
            need = 0
    free = shutil.disk_usage(str(clone)).free
    return {"items": items, "folders": folders, "already": already, "conflicts": conflicts,
            "card_ids": ids, "state_readable": readable, "bytes": total, "need": need + (SPARE_BYTES if need else 0),
            "free": free}


# ---- the locks --------------------------------------------------------------

class Locks:
    """The old server.lock at the checkout's top, when there is one, and
    data/server.lock, held for as long as the move runs: no server from this
    folder, old or new, can be running while they are held, nor start."""

    def __init__(self, clone):
        self.clone = Path(clone)
        self.fds = []

    def __enter__(self):
        old = self.clone / "server.lock"
        new = data_dir(self.clone) / "server.lock"
        for path, make in ((old, False), (new, True)):
            if not make and not path.exists():
                continue
            if make:
                path.parent.mkdir(mode=0o700, exist_ok=True)
            fd = os.open(path, os.O_RDWR | (os.O_CREAT if make else 0), 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                self.__exit__(None, None, None)
                which = "the old place" if path == old else "data/"
                raise Refused(f"A board from this folder is still running (it holds server.lock in {which}).",
                              "Stop it, then run facilitator update again. Nothing was moved.")
            self.fds.append(fd)
        return self

    def __exit__(self, *exc):
        for fd in self.fds:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
            except OSError:
                pass
        self.fds = []
        return False


# ---- the move ---------------------------------------------------------------

def _make_folders(base, folders):
    for folder in folders:
        path = Path(base) / folder["to"]
        if not path.is_dir():
            path.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(path, folder["mode"])
            except OSError:
                pass


def _backup_readme(clone, when):
    return (
        "This folder is a copy of everything the board kept before its files moved\n"
        f"into data/, made by facilitator update on {when}.\n\n"
        f"{BACKUP_TOP}/              what was at the top of {clone}\n"
        f"{BACKUP_BESIDE}/  what was in {_beside(clone)}/uploads and logs\n\n"
        "Every file here was checked against its original by SHA-256; manifest.json\n"
        "lists each one, where it came from and where it went in data/. Nothing\n"
        "reads this folder, and nothing removes it: it can stay as long as you like.\n"
        "To go back, copy the files out of it to where they were.\n")


def _make_backup(clone, made, say):
    """A complete, checked backup of every item, in data/backups/<name>; the
    name. Built in <name>.partial and renamed only once every copy matches."""
    data = data_dir(clone)
    backups = data / BACKUPS
    backups.mkdir(mode=0o700, exist_ok=True)
    when = time.strftime("%Y-%m-%d %H:%M:%S")
    name = BACKUP_PREFIX + time.strftime("%Y%m%d-%H%M%S")
    while (backups / name).exists() or (backups / (name + PARTIAL)).exists():
        name += "-1"
    partial = backups / (name + PARTIAL)
    partial.mkdir(mode=0o700)
    items = made["items"]
    for count, item in enumerate(items, 1):
        dest = partial / item["backup"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        copy_entry(item["from"], str(dest))
        if file_hash(dest) != item["sha256"]:
            raise Refused(f"The backup copy of {item['from']} does not match it.", "Nothing old was removed.",
                          "Run facilitator update again: it carries on from here.")
        _stop_here("backup", count, len(items))
    (partial / "README.txt").write_text(_backup_readme(clone, when))
    _write_json(partial / "manifest.json", {"version": 1, "made": when, "clone": str(clone),
                                            "items": [{k: i[k] for k in ("from", "to", "backup", "size", "sha256")}
                                                      for i in items]})
    os.rename(partial, backups / name)
    say("backup", name, len(items), made["bytes"])
    return name


def read_marker(clone):
    """What the .moving marker of an unfinished move says, or {}."""
    try:
        return json.loads((data_dir(clone) / MOVING).read_text())
    except (OSError, ValueError):
        return {}


def note_stopped_board(clone):
    """Put the .moving marker down the moment the update has stopped the
    board, before anything is planned or copied, saying so: a run that fails
    after this point, and the next one, which finishes the move, both know to
    start the board again. The board stays down while it is there."""
    data = data_dir(clone)
    data.mkdir(mode=0o700, exist_ok=True)
    marker = read_marker(clone)
    if marker.get("stopped_board"):
        return
    marker.update({"version": 1, "clone": str(clone), "stage": marker.get("stage") or "planned",
                   "stopped_board": True})
    marker.setdefault("started", time.strftime("%Y-%m-%dT%H:%M:%S"))
    _write_json(data / MOVING, marker)


def move(clone, made, say=lambda *a: None, stopped_board=False):
    """Back everything up, copy it into data/, check it, and leave the record
    the finish works from. made is what plan answered, taken with Locks held
    and the old board stopped. say(kind, ...) reports each step.
    stopped_board says the update stopped a running board for the move, and
    is kept in the marker, so a rerun after an interruption starts it again.
    Returns the record."""
    clone = Path(clone)
    data = data_dir(clone)
    data.mkdir(mode=0o700, exist_ok=True)
    if not data.is_symlink():
        # private, as the board makes it, even when it was there before the move
        os.chmod(data, 0o700)
    if (data / MOVED).exists():
        # a move that wrote its record and was cut off before taking the
        # marker away: everything is already in place
        if (data / MOVING).exists():
            (data / MOVING).unlink()
        return read_record(clone)
    if made["conflicts"]:
        raise Refused("Files are in both their old place and data/, and they differ.",
                      *[f"{c['from']} and {data / c['to']}" for c in made["conflicts"]])
    if any(item["sha256"] is None for item in made["items"]):
        raise ValueError("move takes a full plan, not a light one")
    marker = data / MOVING
    previous = {}
    if marker.exists():
        try:
            previous = json.loads(marker.read_text())
        except (OSError, ValueError):
            previous = {}
    digest = manifest_digest(made["items"])
    started = previous.get("started") or time.strftime("%Y-%m-%dT%H:%M:%S")
    stopped_board = bool(stopped_board or previous.get("stopped_board"))
    _write_json(marker, {"version": 1, "started": started, "clone": str(clone), "stage": "backup",
                         "backup": previous.get("backup"), "digest": previous.get("digest"),
                         "stopped_board": stopped_board})
    # what an interrupted run left half made, only ever made by the move
    backups = data / BACKUPS
    if backups.is_dir():
        for entry in backups.iterdir():
            if entry.name.startswith(BACKUP_PREFIX) and entry.name.endswith(PARTIAL) and entry.is_dir():
                shutil.rmtree(entry)
    if (data / STAGING).exists():
        shutil.rmtree(data / STAGING)
    # the backup: reused when an earlier run of this move made it of exactly
    # these files, made afresh otherwise; an earlier one is never removed
    name = previous.get("backup")
    if not (name and previous.get("digest") == digest and (backups / name / "manifest.json").exists()):
        name = _make_backup(clone, made, say) if made["items"] else None
    else:
        say("backup-kept", name, len(made["items"]), made["bytes"])
    _write_json(marker, {"version": 1, "started": started, "clone": str(clone), "stage": "copy",
                         "backup": name, "digest": digest, "stopped_board": stopped_board})
    # the copy: into staging, each one checked, then each renamed into place
    staging = data / STAGING
    staging.mkdir(mode=0o700)
    _make_folders(staging, made["folders"])
    todo = [item for item in made["items"] if item not in made["already"]]
    for item in todo:
        dest = staging / item["to"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        copy_entry(item["from"], str(dest))
        if file_hash(dest) != item["sha256"]:
            raise Refused(f"The copy of {item['from']} does not match it.", "Nothing old was removed.",
                          "Run facilitator update again: it carries on from here.")
    _make_folders(data, made["folders"])
    for count, item in enumerate(todo, 1):
        dest = data / item["to"]
        if os.path.lexists(dest):
            raise Refused(f"{dest} appeared while the move was copying.",
                          "Nothing old was removed. Move it aside, then run facilitator update again.")
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.rename(staging / item["to"], dest)
        _stop_here("copy", count, len(todo))
    shutil.rmtree(staging)
    say("copied", len(made["items"]), made["bytes"])
    _stop_here("before-record")
    # the environment, renamed whole, and the test packages
    venv_old, venv_new = clone / ".venv", data / ".venv"
    if venv_old.is_dir() and not venv_old.is_symlink() and not os.path.lexists(venv_new):
        os.rename(venv_old, venv_new)
        say("venv")
    nm_old, nm_new = clone / "tests" / "node_modules", clone / "app" / "tests" / "node_modules"
    if nm_old.is_dir() and not nm_old.is_symlink() and not os.path.lexists(nm_new) and nm_new.parent.is_dir():
        os.rename(nm_old, nm_new)
        try:
            (clone / "tests").rmdir()
        except OSError:
            pass
    record = {"version": 1, "moved": time.strftime("%Y-%m-%dT%H:%M:%S"), "clone": str(clone),
              "backup": name, "card_ids": made["card_ids"], "state_readable": made["state_readable"],
              "items": [{k: i[k] for k in ("from", "to", "backup", "size", "sha256", "linked")} for i in made["items"]],
              "finished": None, "kept": []}
    _write_json(data / MOVED, record)
    marker.unlink()
    return record


def read_record(clone):
    try:
        return json.loads((data_dir(clone) / MOVED).read_text())
    except (OSError, ValueError):
        return None


# ---- the finish -------------------------------------------------------------

def sharing_copies(clone):
    """Other copies of the board beside this checkout that still keep their
    own board in the old way (server.py, the command and a state.json at
    their top): they read the folder beside them too."""
    clone = Path(clone)
    names = []
    try:
        for child in sorted(clone.parent.iterdir()):
            if child.is_symlink() or not child.is_dir() or child.resolve() == clone.resolve():
                continue
            if all((child / name).is_file() for name in ("server.py", "facilitator", "state.json")):
                names.append(child.name)
    except OSError:
        pass
    return names


def _through_link(path, stop):
    """Whether any folder between stop and path (stop itself included) is a
    link: nothing is ever removed through one."""
    path, stop = Path(path), Path(stop)
    for parent in [path.parent, *path.parent.parents]:
        if parent.is_symlink():
            return True
        if parent == stop or parent == stop.parent:
            break
    return False


def finish(clone, say=lambda *a: None):
    """Remove the old copies of a finished move, one by one, each only when it
    still has exactly the bytes that were copied and its backup copy does
    too; then the folders they leave empty, the old locks, the old .venv and
    the bytecode at the old top. Anything that fails a check is kept and
    named. Call only once the board shows every old card from app/. Returns
    (removed count, [(path, why kept)])."""
    clone = Path(clone)
    data = data_dir(clone)
    record = read_record(clone)
    if not record or record.get("finished"):
        return 0, []
    backup = data / BACKUPS / record["backup"] if record.get("backup") else None
    sharing = sharing_copies(clone)
    beside = _beside(clone)
    removed, kept = 0, []
    for item in record["items"]:
        source = Path(item["from"])
        if not os.path.lexists(source):
            continue
        if beside in source.parents and sharing:
            kept.append((str(source), "another copy of the board beside this one still uses it: " + ", ".join(sharing)))
            continue
        if item.get("linked") or _through_link(source, beside if beside in source.parents else clone):
            kept.append((str(source), "it is reached through a link, which is never followed to remove anything"))
            continue
        try:
            if file_hash(source) != item["sha256"]:
                kept.append((str(source), "it changed after it was copied"))
                continue
            copy = backup / item["backup"] if backup else None
            if copy is None or not os.path.lexists(copy) or file_hash(copy) != item["sha256"]:
                kept.append((str(source), "its backup copy is missing or does not match"))
                continue
            os.unlink(source)
            removed += 1
        except OSError as error:
            kept.append((str(source), f"it could not be read or removed ({error.strerror or error})"))
    # the folders left empty, deepest first, never the checkout itself
    roots = [clone / name for name in TOP_FOLDERS] + [beside / name for name in BESIDE_FOLDERS]
    for root in roots:
        if not root.is_dir() or root.is_symlink():
            continue
        for dirpath, _dirnames, _files in sorted(os.walk(root), key=lambda w: -len(w[0])):
            try:
                os.rmdir(dirpath)
            except OSError:
                pass
    try:
        beside.rmdir()
    except OSError:
        pass
    # the old locks, held by nothing now, the environment and the bytecode
    for name in LOCKS:
        path = clone / name
        if path.is_file() and not path.is_symlink():
            try:
                path.unlink()
            except OSError:
                pass
    venv_old = clone / ".venv"
    if (venv_old.is_dir() and not venv_old.is_symlink() and (venv_old / "pyvenv.cfg").is_file()
            and (data / ".venv").is_dir()):
        shutil.rmtree(venv_old, ignore_errors=True)
    # bytecode left at the old top and in the old tests/, whose files are in
    # app/tests now; tests/ goes too, only when nothing else is left in it
    for cache in (clone / "__pycache__", clone / "tests" / "__pycache__"):
        if cache.is_dir() and not cache.is_symlink():
            try:
                if all(entry.suffix == ".pyc" and entry.is_file() for entry in cache.iterdir()):
                    shutil.rmtree(cache, ignore_errors=True)
            except OSError:
                pass
    try:
        (clone / "tests").rmdir()
    except OSError:
        pass
    record["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    record["kept"] = [{"path": path, "why": why} for path, why in kept]
    _write_json(data / MOVED, record)
    say("finished", removed, kept)
    return removed, kept
