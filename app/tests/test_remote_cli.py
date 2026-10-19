"""`facilitator remote` from a scratch copy of the checkout, with no board
running, so every case is the command's own; pairing against a running
board is in test_remote_board.py.

  pair      with no board running, pair says to start it and prints no code;
            a stray word is refused
  add       retired: it says the board no longer logs in to servers, points
            at pair, and changes nothing
  list      no servers, and servers read from the file while the board is down
  remove    an unknown server is refused; a known one is forgotten in the file
            while the board is down
  help      names pair, list and remove
  installer install.sh on a Linux server stops at its Chrome step and points
            at pair, before anything is changed

    python3 -B -m unittest tests/test_remote_cli.py
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
CLONE = APP.parent
sys.path.insert(0, str(APP))
import remote_link  # noqa: E402


class RemoteCommand(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="rc-", dir="/tmp")).resolve()
        outer = self.root / "board"
        shutil.copytree(APP, outer / "app", ignore=shutil.ignore_patterns("tests", "__pycache__", "node_modules"))
        shutil.copytree(CLONE / ".agents", outer / ".agents", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(CLONE / "docs", outer / "docs")
        self.data = outer / "data"
        self.data.mkdir(mode=0o700)
        # a port nothing listens on, so the command finds no board
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        (self.data / "run.config.json").write_text(json.dumps({"port": port, "lanes": []}))
        self.cli_path = outer / "app" / "facilitator"
        self.env = {**os.environ, "HOME": str(self.root / "mac"), "PYTHONDONTWRITEBYTECODE": "1"}

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def cli(self, *words):
        r = subprocess.run([sys.executable, "-B", str(self.cli_path), *words], env=self.env,
                           capture_output=True, text=True, timeout=90)
        return r.returncode, r.stdout + r.stderr

    def servers(self):
        path = self.data / "remote" / "servers.json"
        return json.loads(path.read_text())["servers"] if path.exists() else []

    def keep(self, *names):
        remote_link.Store(self.data).save_servers([
            {"id": remote_link.slug(n), "name": n, "home": "/home/you", "top": "/home/you",
             "key": remote_link.digest("k-" + n), "added": 1, "paired": 1} for n in names])

    def test_pair_needs_the_running_board(self):
        code, said = self.cli("remote", "pair")
        self.assertEqual(code, 1)
        self.assertIn("The board is not running.", said)
        self.assertNotIn("Pairing code", said)
        self.assertEqual(self.cli("remote", "pair", "--name")[0], 1)
        self.assertEqual(self.cli("remote", "pair", "you@lab")[0], 1)

    def test_add_is_retired_and_changes_nothing(self):
        code, said = self.cli("remote", "add", "you@lab")
        self.assertEqual(code, 1)
        self.assertIn("facilitator remote add is retired: the board no longer logs in to servers.", said)
        self.assertIn("facilitator remote pair", said)
        self.assertFalse((self.data / "remote").exists())

    def test_list_with_the_board_down(self):
        self.assertIn("No servers. Pair one with: facilitator remote pair", self.cli("remote", "list")[1])
        self.keep("lab", "farm box")
        code, said = self.cli("remote", "list")
        self.assertEqual(code, 0)
        self.assertIn("lab  not connected (board not running)", said)
        self.assertIn("farm box  not connected (board not running)", said)

    def test_remove(self):
        self.keep("lab", "farm")
        code, said = self.cli("remote", "remove", "nothing")
        self.assertEqual(code, 1)
        self.assertIn("No server named nothing.", said)
        code, said = self.cli("remote", "remove", "LAB")
        self.assertEqual(code, 0, said)
        self.assertEqual([s["id"] for s in self.servers()], ["farm"])
        self.assertIn("Forgot lab on this Mac", said)
        self.assertIn("The board is not running; it starts without that server.", said)

    def test_help(self):
        code, said = self.cli("remote", "--help")
        self.assertEqual(code, 0)
        self.assertIn("usage: facilitator remote pair [--name NAME]", said)
        self.assertIn("Nothing logs in to the server", said)
        self.assertNotIn("remote add", said)


class InstallerOnAServer(unittest.TestCase):
    """install.sh run on a Linux server stops at its Chrome step and says
    that a server needs nothing from it, before anything is changed."""

    def test_the_installer_points_a_server_at_pairing(self):
        root = Path(tempfile.mkdtemp(prefix="ri-", dir="/tmp")).resolve()
        try:
            outer = root / "board"
            shutil.copytree(APP, outer / "app", ignore=shutil.ignore_patterns("tests", "__pycache__", "node_modules"))
            shutil.copy(CLONE / "install.sh", outer / "install.sh")
            fake = root / "bin"
            fake.mkdir()
            for name, body in (("uname", "echo Linux"), ("claude", "exit 0"), ("mdfind", "exit 1"), ("open", "exit 1")):
                (fake / name).write_text(f"#!/bin/sh\n{body}\n")
                (fake / name).chmod(0o755)
            r = subprocess.run(["/bin/bash", str(outer / "install.sh")], cwd=outer, capture_output=True, text=True,
                               env={"PATH": f"{fake}:/usr/bin:/bin", "HOME": str(root / "home")}, timeout=60)
            said = r.stdout + r.stderr
            self.assertEqual(r.returncode, 1, said)
            self.assertIn("This setup is for the Mac the board runs on.", said)
            self.assertIn("On your Mac, run: facilitator remote pair", said)
            self.assertNotIn("remote add", said)
            self.assertNotIn("Chrome was not found.", said)
            self.assertFalse((outer / "data").exists())
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
