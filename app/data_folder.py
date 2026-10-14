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

Standard library only, and Python 3.9 compatible: the facilitator command
imports this on the python3 macOS ships, and server.py on .venv's Python.
"""
import fnmatch
import os
from pathlib import Path

DATA_NAME = "data"
# in data/: the move has started writing and has not finished; while this is
# there neither the server nor the command starts anything
MOVING = ".moving"
# in data/: the record of a move that has copied everything into place
MOVED = ".moved"

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
