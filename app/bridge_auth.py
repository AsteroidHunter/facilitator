"""Durable password and sessions for the phone bridge.

This file is deliberately independent of board state. A board backup, seed or
state migration must never restore a signed-out phone session.
"""

import fcntl
import hashlib
import hmac
import json
import os
import secrets
import string
import tempfile
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

# in data/ at the top of the checkout, beside app/ where this file is
AUTH_FILE = Path(__file__).resolve().parent.parent / "data" / "bridge-auth.json"
LOCK_FILE = AUTH_FILE.with_suffix(".lock")
COOKIE = "__Host-facilitator_session"
# wrong passwords are counted per device: MAX_ATTEMPTS in WINDOW_SECONDS from
# one device, and MAX_ATTEMPTS_ALL from all of them together, because a program
# on this Mac can reach the phone's port directly and name any device it likes
MAX_ATTEMPTS = 5
MAX_ATTEMPTS_ALL = 20
WINDOW_SECONDS = 60
DEVICES_KEPT = 256
_failures = {}   # device -> the moments of its wrong passwords in the window
# a sign-in not used for IDLE_SECONDS ends; its last use is written down at
# most once every STAMP_SECONDS, so a phone in use does not rewrite the file on
# every request
IDLE_SECONDS = 30 * 24 * 60 * 60
STAMP_SECONDS = 60 * 60
_now = time.time
CURRENT_SESSION = ContextVar("bridge_session", default="")


def validate_password(value):
    """Require a bounded printable ASCII password with mixed character types."""
    if not value:
        raise ValueError("That was empty. Choose a strong passphrase.")
    if len(value) < 11 or len(value) > 256:
        raise ValueError("Use 11 to 256 characters, with a letter, a number and a symbol.")
    if not all(" " <= ch <= "~" for ch in value):
        raise ValueError("Use printable ASCII letters, numbers, spaces or symbols only.")
    if value != value.strip():
        raise ValueError("Leave out spaces at the beginning and end.")
    if not all(any(ch in chars for ch in value) for chars in
               (string.ascii_letters, string.digits, string.punctuation)):
        raise ValueError("Use a letter, a number and a symbol; spaces are not symbols.")


@contextmanager
def _locked():
    # data/ private to this account, like the files in it, when this is the
    # first thing to need it
    AUTH_FILE.parent.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(LOCK_FILE, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _read():
    try:
        data = json.loads(AUTH_FILE.read_text())
        if data.get("version") == 1 and isinstance(data.get("sessions"), list):
            return data
    except (OSError, ValueError, AttributeError):
        pass
    return None


def _write(data):
    fd, name = tempfile.mkstemp(prefix=".bridge-auth-", dir=AUTH_FILE.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(data, out, separators=(",", ":"))
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, AUTH_FILE)
        parent_fd = os.open(AUTH_FILE.parent, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def configured():
    with _locked():
        return _read() is not None


def set_password(value):
    validate_password(value)
    salt = secrets.token_bytes(32)
    digest = hashlib.scrypt(value.encode("ascii"), salt=salt, n=2**14, r=8, p=1)
    with _locked():
        _write({"version": 1, "salt": salt.hex(), "password": digest.hex(), "sessions": [], "used": {}})


def _session_digest(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _stamp():
    return int(_now())


def _expire(data, now):
    """Give every sign-in a last use and remove the ones unused for longer than
    IDLE_SECONDS, with their stamps and any stamp whose sign-in is gone. A
    sign-in with no stamp (made before stamps, or by older code) and one stamped
    in the future (the clock moved back) count as used now. True when data
    changed. "used" sits beside "sessions", which keeps the shape older code
    reads."""
    held = data.get("used")
    held = held if isinstance(held, dict) else None
    kept, used = [], {}
    for item in data["sessions"]:
        if not isinstance(item, str):
            kept.append(item)
            continue
        stamp = held.get(item) if held is not None else None
        if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not 0 <= stamp <= now:
            stamp = now
        if now - stamp > IDLE_SECONDS:
            continue
        kept.append(item)
        used[item] = stamp
    changed = kept != data["sessions"] or used != held
    data["sessions"], data["used"] = kept, used
    return changed


def has_session(token):
    if not token or len(token) != 64:
        return False
    try:
        digest = _session_digest(token)
    except (UnicodeEncodeError, AttributeError):
        return False
    with _locked():
        data = _read()
        if data is None:
            return False
        now = _stamp()
        changed = _expire(data, now)
        known = any(hmac.compare_digest(digest, item)
                    for item in data["sessions"] if isinstance(item, str))
        if known and now - data["used"][digest] >= STAMP_SECONDS:
            data["used"][digest] = now
            changed = True
        if changed:
            _write(data)
        return known


def current_session_digest():
    token = CURRENT_SESSION.get()
    return _session_digest(token) if token and has_session(token) else ""


def has_session_digest(digest):
    if not isinstance(digest, str) or len(digest) != 64:
        return False
    with _locked():
        data = _read()
        if data is None:
            return False
        if _expire(data, _stamp()):
            _write(data)
        return digest in data["sessions"]


def _failed(device, now):
    if device not in _failures and len(_failures) >= DEVICES_KEPT:
        del _failures[min(_failures, key=lambda name: _failures[name][-1])]
    _failures.setdefault(device, []).append(now)


def login(value, device="local"):
    now = time.monotonic()
    for name in list(_failures):
        _failures[name] = [moment for moment in _failures[name] if now - moment < WINDOW_SECONDS]
        if not _failures[name]:
            del _failures[name]
    if (len(_failures.get(device, ())) >= MAX_ATTEMPTS
            or sum(map(len, _failures.values())) >= MAX_ATTEMPTS_ALL):
        return "limited", None
    if not isinstance(value, str) or len(value) > 256:
        _failed(device, now)
        return "wrong", None
    with _locked():
        data = _read()
        if data is None:
            return "unconfigured", None
        try:
            candidate = hashlib.scrypt(value.encode("ascii"), salt=bytes.fromhex(data["salt"]),
                                       n=2**14, r=8, p=1)
            good = hmac.compare_digest(candidate, bytes.fromhex(data["password"]))
        except (UnicodeEncodeError, ValueError, KeyError, TypeError):
            good = False
        if not good:
            _failed(device, now)
            return "wrong", None
        _failures.pop(device, None)
        token = secrets.token_hex(32)
        digest, stamp = _session_digest(token), _stamp()
        _expire(data, stamp)
        data["sessions"].append(digest)
        data["used"][digest] = stamp
        _write(data)
        return "ok", token


def logout(token):
    if not token or len(token) != 64:
        return
    try:
        digest = _session_digest(token)
    except (UnicodeEncodeError, AttributeError):
        return
    with _locked():
        data = _read()
        if data is None:
            return
        data["sessions"] = [item for item in data["sessions"] if item != digest]
        if isinstance(data.get("used"), dict):
            data["used"].pop(digest, None)
        _write(data)


def session_cookie(token):
    return f"{COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=315360000"


def clear_cookie():
    return f"{COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
