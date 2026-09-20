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

AUTH_FILE = Path(__file__).resolve().parent / "bridge-auth.json"
LOCK_FILE = AUTH_FILE.with_suffix(".lock")
COOKIE = "__Host-facilitator_session"
MAX_ATTEMPTS = 5
WINDOW_SECONDS = 60
_failures = []
CURRENT_SESSION = ContextVar("bridge_session", default="")


def validate_password(value):
    """The same input rule as Pastureland's installer, with an upper bound."""
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
        _write({"version": 1, "salt": salt.hex(), "password": digest.hex(), "sessions": []})


def _session_digest(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def has_session(token):
    if not token or len(token) != 64:
        return False
    try:
        digest = _session_digest(token)
    except (UnicodeEncodeError, AttributeError):
        return False
    with _locked():
        data = _read()
        return bool(data and any(hmac.compare_digest(digest, item)
                                 for item in data["sessions"] if isinstance(item, str)))


def current_session_digest():
    token = CURRENT_SESSION.get()
    return _session_digest(token) if token and has_session(token) else ""


def has_session_digest(digest):
    if not isinstance(digest, str) or len(digest) != 64:
        return False
    with _locked():
        data = _read()
        return bool(data and digest in data["sessions"])


def login(value):
    now = time.monotonic()
    _failures[:] = [moment for moment in _failures if now - moment < WINDOW_SECONDS]
    if len(_failures) >= MAX_ATTEMPTS:
        return "limited", None
    if not isinstance(value, str) or len(value) > 256:
        _failures.append(now)
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
            _failures.append(now)
            return "wrong", None
        _failures.clear()
        token = secrets.token_hex(32)
        data["sessions"].append(_session_digest(token))
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
        _write(data)


def session_cookie(token):
    return f"{COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=315360000"


def clear_cookie():
    return f"{COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
