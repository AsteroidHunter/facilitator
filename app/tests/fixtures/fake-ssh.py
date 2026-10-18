#!/usr/bin/env python3
"""A stand-in for ssh, for the tests of the owner's servers: the "server" is
a folder on this machine and nothing leaves it.

FAKE_SSH_HOME is the server account's home: a command runs there under sh
with HOME set to it, as a login would. While the file FAKE_SSH_DOWN exists the
server cannot be reached: every login fails as ssh does (255), and a master
already logged in ends as one does when its keepalives go unanswered, leaving
its forwarded socket behind on the "server", as sshd does.

What the board runs is understood: a ControlMaster (-M -S PATH -N) keeps a
control socket that answers check, forward and exit; -O check, -O forward -R
A:B and -O exit ask it; -R A:B forwards the Unix socket A to the Unix socket B
with A made for the account alone (sshd's StreamLocalBindMask 0177). A command
through -S needs the master's socket to answer, or falls back to a login of
its own, as ssh with ControlMaster=no does. Every argument line is appended to
FAKE_SSH_LOG when that is set."""

import os
import socket
import subprocess
import sys
import threading
import time

HOME = os.environ.get("FAKE_SSH_HOME", "")
DOWN = os.environ.get("FAKE_SSH_DOWN", "")


def down():
    return bool(DOWN) and os.path.exists(DOWN)


def fail(words):
    sys.stderr.write("ssh: " + words + "\n")
    sys.exit(255)


def parse(argv):
    opts = {"o": [], "R": [], "M": False, "N": False, "T": False, "S": None, "O": None, "F": None}
    at = 0
    while at < len(argv):
        word = argv[at]
        if word == "--":
            at += 1
            break
        if word in ("-M", "-N", "-T"):
            opts[word[1]] = True
        elif word in ("-o", "-R", "-S", "-O", "-F"):
            value = argv[at + 1]
            if word in ("-o", "-R"):
                opts[word[1]].append(value)
            else:
                opts[word[1]] = value
            at += 1
        else:
            break
        at += 1
    rest = argv[at:]
    dest = rest[0] if rest else ""
    command = rest[1] if len(rest) > 1 else None
    return opts, dest, command


def ask(control, line):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(5)
            s.connect(control)
            s.sendall((line + "\n").encode())
            return s.makefile().readline().strip()
    except OSError:
        return None


def pump(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def relay(listener, target):
    while True:
        try:
            near, _ = listener.accept()
        except OSError:
            return
        far = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            far.connect(target)
        except OSError:
            near.close()
            continue
        threading.Thread(target=pump, args=(near, far), daemon=True).start()
        threading.Thread(target=pump, args=(far, near), daemon=True).start()


def master(control):
    if down():
        fail("connect to host: Connection refused")
    listeners = []
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        srv.bind(control)
    finally:
        os.umask(old)
    srv.listen(16)

    def finish(code):
        for s in listeners + [srv]:
            try:
                s.close()
            except OSError:
                pass
        try:
            os.unlink(control)
        except OSError:
            pass
        os._exit(code)

    def watch():
        while True:
            if down():
                finish(255)
            time.sleep(0.2)

    threading.Thread(target=watch, daemon=True).start()
    while True:
        conn, _ = srv.accept()
        line = conn.makefile().readline().strip()
        word, _, rest = line.partition(" ")
        if word == "check":
            conn.sendall(b"ok\n")
        elif word == "forward":
            listen, _, target = rest.partition(":")
            try:
                ear = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                old = os.umask(0o177)
                try:
                    ear.bind(listen)
                finally:
                    os.umask(old)
                ear.listen(16)
                listeners.append(ear)
                threading.Thread(target=relay, args=(ear, target), daemon=True).start()
                conn.sendall(b"ok\n")
            except OSError:
                conn.sendall(b"fail\n")
        elif word == "exit":
            conn.sendall(b"ok\n")
            conn.close()
            finish(0)
        conn.close()


def run(command):
    env = {**os.environ, "HOME": HOME}
    return subprocess.run(["sh", "-c", command], cwd=HOME, env=env).returncode


def main():
    opts, dest, command = parse(sys.argv[1:])
    if os.environ.get("FAKE_SSH_LOG"):
        with open(os.environ["FAKE_SSH_LOG"], "a") as f:
            f.write(" ".join(sys.argv[1:]) + "\n")
    if not dest or dest.startswith("-"):
        fail("no destination")
    if opts["M"]:
        master(opts["S"])
        return
    if opts["O"]:
        if opts["O"] == "check":
            sys.exit(0 if ask(opts["S"], "check") == "ok" else 255)
        if opts["O"] == "forward":
            listen, _, target = opts["R"][0].partition(":")
            sys.exit(0 if ask(opts["S"], f"forward {listen}:{target}") == "ok" else 255)
        if opts["O"] == "exit":
            sys.exit(0 if ask(opts["S"], "exit") == "ok" else 255)
        fail("unknown -O")
    through = opts["S"] and ask(opts["S"], "check") == "ok"
    if not through and down():
        fail("connect to host: Connection refused")
    sys.exit(run(command or "true"))


if __name__ == "__main__":
    main()
