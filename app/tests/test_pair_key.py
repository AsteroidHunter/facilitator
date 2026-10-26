"""The setup program (scripts/pair.py) on a server, against a stand-in for
the board's agent door over TCP: the server's key the board answers is kept
only when it is the shape of the board's keys.

  refused   a key with a quote and a line break, one too short, one too long
            and one with a space each stop with the line that nothing was
            changed, before anything is written here, and are never printed
  kept      a key as the board makes them is kept in ~/.facilitator/server.key
            for the account alone, as before

    python3 -B -m unittest tests/test_pair_key.py
"""

import contextlib
import http.server
import importlib.util
import io
import json
import os
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLONE = HERE.parent.parent
PAIR = CLONE / ".agents" / "skills" / "facilitator" / "scripts" / "pair.py"
UNREADABLE = "The board's answer could not be read; nothing was changed here."

# the link, stood in for: started, it says it is connected
LINK = ("import json, os, sys\n"
        "if sys.argv[1:2] == ['start']:\n"
        "    top = os.path.join(os.path.expanduser('~'), '.facilitator')\n"
        "    with open(os.path.join(top, 'link.state'), 'w') as f:\n"
        "        json.dump({'connected': True}, f)\n")

BAD_KEYS = (
    ("a quote and a line break", "k-" + "x" * 40 + '"\nheader = "X: y'),
    ("too short", "short-" + "q" * 13),
    ("too long", "long-" + "q" * 96),
    ("a space", "spaced " + "q" * 30),
)


class Board(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(http.server.BaseHTTPRequestHandler):
    key = None
    seen = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        self.rfile.read(length)
        Handler.seen.append((self.command, self.path, self.headers.get("authorization")))
        files = {".agents/skills/facilitator/scripts/link.py": [LINK, 0o700]}
        raw = json.dumps({"server": "lab", "name": "lab", "key": Handler.key, "files": files}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ServerKey(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="pk-", dir="/tmp")).resolve()
        self.board = Board(("127.0.0.1", free_port()), Handler)
        self.door = f"http://127.0.0.1:{self.board.server_address[1]}"
        threading.Thread(target=self.board.serve_forever, daemon=True).start()
        Handler.key, Handler.seen = None, []

    def tearDown(self):
        self.board.shutdown()
        self.board.server_close()
        shutil.rmtree(self.home, ignore_errors=True)

    def pair(self):
        """The setup program as the owner runs it, the code on standard input
        since there is no terminal: a session of its own has none."""
        return subprocess.run([sys.executable, "-B", str(PAIR), self.door], input="CODE-1234\n",
                              env={**os.environ, "HOME": str(self.home)}, capture_output=True, text=True,
                              timeout=60, start_new_session=True)

    def test_trade_stops_on_a_key_this_server_cannot_use(self):
        spec = importlib.util.spec_from_file_location("pair_under_test", PAIR)
        pair = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pair)
        for kind, bad in BAD_KEYS:
            with self.subTest(key=kind):
                Handler.key = bad
                with contextlib.redirect_stdout(io.StringIO()) as printed, self.assertRaises(SystemExit) as stopped:
                    pair.trade(self.door, "CODE-1234")
                self.assertEqual(stopped.exception.code, 1)
                self.assertEqual(printed.getvalue(), UNREADABLE + "\n")

    def test_a_key_this_server_cannot_use_writes_nothing(self):
        for kind, bad in BAD_KEYS:
            with self.subTest(key=kind):
                Handler.key = bad
                r = self.pair()
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertEqual(r.stdout.strip().splitlines()[-1], UNREADABLE)
                self.assertNotIn(bad, r.stdout + r.stderr)
                self.assertFalse((self.home / ".facilitator" / "server.key").exists())
                self.assertEqual(sorted(p.name for p in self.home.iterdir()), [])
        self.assertEqual(len(Handler.seen), len(BAD_KEYS))

    def test_a_key_as_the_board_makes_them_is_kept(self):
        Handler.key = secrets.token_urlsafe(32)
        r = self.pair()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Paired with the board as lab.", r.stdout)
        self.assertIn("The link is connected.", r.stdout)
        self.assertNotIn(Handler.key, r.stdout + r.stderr)
        held = self.home / ".facilitator" / "server.key"
        self.assertEqual(held.read_text(), Handler.key + "\n")
        self.assertEqual(stat.S_IMODE(os.stat(held).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(held.parent).st_mode), 0o700)
        self.assertEqual(Handler.seen, [("POST", "/remote/pair", "Bearer CODE-1234")])


if __name__ == "__main__":
    unittest.main()
