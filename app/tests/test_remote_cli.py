"""`facilitator remote` from a scratch copy of the checkout, against a
"server" that is a scratch folder (tests/fixtures/fake-ssh.py) and with no
board running, so every case is the command's own.

  refusals  a destination that could be an option is refused before ssh runs;
            a login that fails says what ssh said and what to put right; a
            server without python3 3.7 or newer is refused, with nothing put
            on it
  links     a skill name the server already uses for something else is left
            as it is and named; the other one is made
  again     adding the same server again keeps its name and record and puts a
            new join key in place of the old
  name      --name names the server
  board     with no board running, add says the link starts with the board
            and list says each link is down for that reason
  remove    an unknown server is refused; a known one is forgotten
  secrets   the join key is never printed

    python3 -B -m unittest tests/test_remote_cli.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
CLONE = APP.parent
FAKE_SSH = HERE / "fixtures" / "fake-ssh.py"


class RemoteCommand(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="rc-", dir="/tmp")).resolve()
        outer = self.root / "board"
        shutil.copytree(APP, outer / "app", ignore=shutil.ignore_patterns("tests", "__pycache__", "node_modules"))
        shutil.copytree(CLONE / ".agents", outer / ".agents")
        shutil.copytree(CLONE / "docs", outer / "docs")
        self.data = outer / "data"
        self.data.mkdir(mode=0o700)
        # a port nothing listens on, so the command finds no board
        with __import__("socket").socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        (self.data / "run.config.json").write_text(json.dumps({"port": port, "lanes": []}))
        self.cli_path = outer / "app" / "facilitator"
        self.home = self.root / "server"
        self.home.mkdir()
        self.down = self.root / "down"
        self.log = self.root / "ssh.log"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        tool = bin_dir / "ssh"
        tool.write_text(f'#!/bin/sh\nexec "{sys.executable}" -B "{FAKE_SSH}" "$@"\n')
        tool.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(self.root / "mac"),
                    "FAKE_SSH_HOME": str(self.home), "FAKE_SSH_DOWN": str(self.down),
                    "FAKE_SSH_LOG": str(self.log), "PYTHONDONTWRITEBYTECODE": "1"}
        self.env.pop("FACILITATOR_SSH_CONFIG", None)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def cli(self, *words, **env):
        r = subprocess.run([sys.executable, "-B", str(self.cli_path), *words], env={**self.env, **env},
                           capture_output=True, text=True, timeout=90)
        return r.returncode, r.stdout + r.stderr

    def servers(self):
        path = self.data / "remote" / "servers.json"
        return json.loads(path.read_text())["servers"] if path.exists() else []

    def join_key(self):
        return (self.home / ".facilitator" / "join.key").read_text().strip()

    def test_a_destination_that_could_be_an_option_runs_no_ssh(self):
        for bad in ("-oProxyCommand=touch /tmp/x", "you@lab extra"):
            with self.subTest(dest=bad):
                code, said = self.cli("remote", "add", bad)
                self.assertEqual(code, 1)
                self.assertIn("remote add:", said)
        self.assertFalse(self.log.exists())

    def test_a_failed_login_says_what_ssh_said_and_what_to_do(self):
        self.down.write_text("")
        code, said = self.cli("remote", "add", "you@lab")
        self.assertEqual(code, 1)
        self.assertIn("Could not log in to you@lab with ssh.", said)
        self.assertIn("ssh said: ssh: connect to host: Connection refused", said)
        self.assertIn("without a password prompt", said)
        self.assertEqual(self.servers(), [])

    def test_a_server_without_python3_is_refused_with_nothing_put_there(self):
        code, said = self.cli("remote", "add", "you@lab", FAKE_SSH_PATH="/bin")
        self.assertEqual(code, 1)
        self.assertIn("has no python3 of 3.7 or newer", said)
        self.assertFalse((self.home / ".facilitator").exists())
        self.assertEqual(self.servers(), [])

    def test_add_with_no_board_running(self):
        code, said = self.cli("remote", "add", "you@lab.example.org")
        self.assertEqual(code, 0, said)
        self.assertIn("The facilitator skill is on lab.example.org", said)
        self.assertIn("The board is not running: the link to lab.example.org starts with it", said)
        self.assertNotIn(self.join_key(), said)
        saved = self.servers()
        self.assertEqual([(s["id"], s["name"], s["dest"]) for s in saved],
                         [("lab-example-org", "lab.example.org", "you@lab.example.org")])
        self.assertNotIn(self.join_key(), (self.data / "remote" / "servers.json").read_text())
        code, listed = self.cli("remote", "list")
        self.assertEqual(code, 0)
        self.assertIn("lab.example.org  you@lab.example.org  link down (board not running)", listed)
        # the login is BatchMode every time
        for line in self.log.read_text().splitlines():
            self.assertIn("BatchMode=yes", line)

    def test_a_skill_name_already_in_use_is_left_and_named(self):
        mine = self.home / ".claude" / "skills" / "facilitator"
        mine.mkdir(parents=True)
        (mine / "SKILL.md").write_text("someone else's")
        code, said = self.cli("remote", "add", "you@lab")
        self.assertEqual(code, 0, said)
        self.assertIn(f"{mine} already holds something else and was left as it is.", said)
        self.assertEqual((mine / "SKILL.md").read_text(), "someone else's")
        made = self.home / ".agents" / "skills" / "facilitator"
        self.assertTrue(made.is_symlink())

    def test_adding_again_keeps_the_record_and_puts_a_new_join_key(self):
        self.assertEqual(self.cli("remote", "add", "you@lab", "--name", "Lab box")[0], 0)
        first, first_key = self.servers(), self.join_key()
        self.assertEqual([(s["id"], s["name"]) for s in first], [("lab-box", "Lab box")])
        code, said = self.cli("remote", "add", "you@lab")
        self.assertEqual(code, 0, said)
        again = self.servers()
        self.assertEqual([(s["id"], s["name"]) for s in again], [("lab-box", "Lab box")])
        self.assertNotEqual(self.join_key(), first_key)
        self.assertNotEqual(again[0]["join"], first[0]["join"])

    def test_remove(self):
        self.assertEqual(self.cli("remote", "add", "you@lab")[0], 0)
        code, said = self.cli("remote", "remove", "nothing")
        self.assertEqual(code, 1)
        self.assertIn("No server named nothing.", said)
        code, said = self.cli("remote", "remove", "lab")
        self.assertEqual(code, 0, said)
        self.assertEqual(self.servers(), [])
        self.assertIn("Forgot lab on this Mac", said)

    def test_help(self):
        code, said = self.cli("remote", "--help")
        self.assertEqual(code, 0)
        self.assertIn("usage: facilitator remote add you@server", said)


class InstallerOnAServer(unittest.TestCase):
    """install.sh run on a Linux server stops at its Chrome step and says
    that a server needs nothing from it, before anything is changed."""

    def test_the_installer_points_a_server_at_remote_add(self):
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
            self.assertIn("On your Mac, run: facilitator remote add you@this-server", said)
            self.assertNotIn("Chrome was not found.", said)
            self.assertFalse((outer / "data").exists())
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
