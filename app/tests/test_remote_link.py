"""remote_link.py on its own: the ssh it runs, the records and keys it keeps,
one server's link going up, down and up again, the fade's timing, and the
program it runs on a server, run here against a scratch home.

  ssh       every ssh is BatchMode with a login timeout, the destination after
            --, and -F only when FACILITATOR_SSH_CONFIG names a file
  records   servers.json and keys.json are the owner's alone and keys.json
            holds hashes, never a key
  sockets   the board's socket is the account's alone, in a folder short
            enough for a socket's path
  link      against tests/fixtures/fake-ssh.py: the link comes up and clears a
            socket a dropped link left; a server that goes away takes it down
            and coming back brings it up again on its own; stop ends the ssh
  fade      down for 29.9 seconds is not faded, 30 is, and a link back up is
            not faded at once
  keys      a join key names its server, a minted key its lane and server, a
            new key ends the lane's old one, a removed server's keys go
  program   the folder listing in the picker's shape and with its refusals,
            a new folder, and the folder a project names with its repository

    python3 -B -m unittest tests/test_remote_link.py
"""

import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import remote_link  # noqa: E402

FAKE_SSH = HERE / "fixtures" / "fake-ssh.py"


def short_tmp(prefix):
    # sockets need short paths, and this machine's temp folder may be long
    return Path(tempfile.mkdtemp(prefix=prefix, dir="/tmp")).resolve()


def fake_ssh_bin(folder: Path) -> Path:
    tool = folder / "ssh"
    tool.write_text(f'#!/bin/sh\nexec "{sys.executable}" -B "{FAKE_SSH}" "$@"\n')
    tool.chmod(0o755)
    return tool


def until(check, seconds=15.0):
    ends = time.monotonic() + seconds
    while time.monotonic() < ends:
        if check():
            return True
        time.sleep(0.1)
    return False


class Ssh(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("FACILITATOR_SSH_CONFIG", None)

    def test_every_ssh_is_batch_with_the_destination_last(self):
        argv = remote_link.ssh_argv("you@lab", "-N", command="true")
        self.assertEqual(argv[0], remote_link.SSH)
        self.assertIn("BatchMode=yes", argv)
        self.assertIn(f"ConnectTimeout={remote_link.CONNECT_TIMEOUT}", argv)
        self.assertEqual(argv[-3:], ["--", "you@lab", "true"])
        self.assertNotIn("-F", argv)

    def test_a_config_is_used_only_when_named(self):
        os.environ["FACILITATOR_SSH_CONFIG"] = "/tmp/some-config"
        argv = remote_link.ssh_argv("lab")
        self.assertEqual(argv[1:3], ["-F", "/tmp/some-config"])

    def test_a_destination_that_could_be_an_option_is_refused(self):
        for bad in ("", "-oProxyCommand=x", "you@lab extra", "lab\n", "a\x7fb"):
            with self.subTest(dest=bad):
                self.assertIsNotNone(remote_link.destination_problem(bad))
        for good in ("you@lab", "lab", "ssh://you@lab:2222", "you@10.0.0.4"):
            with self.subTest(dest=good):
                self.assertIsNone(remote_link.destination_problem(good))


class Records(unittest.TestCase):
    def setUp(self):
        self.data = short_tmp("rl-data-")
        self.store = remote_link.Store(self.data)

    def tearDown(self):
        shutil.rmtree(self.data, ignore_errors=True)

    def test_servers_are_kept_for_the_owner_alone_and_checked_on_read(self):
        good = {"id": "lab", "name": "lab", "dest": "you@lab", "home": "/home/you",
                "python": "/usr/bin/python3", "join": "ab" * 32}
        self.store.save_servers([good, {"id": "Bad Id", "name": "x"}, {**good, "id": "x", "dest": "-oX"}])
        self.assertEqual([s["id"] for s in self.store.servers()], ["lab"])
        self.assertEqual(stat.S_IMODE(os.stat(self.store.servers_file).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.store.dir).st_mode), 0o700)

    def test_the_sockets_folder_is_short_enough(self):
        self.assertEqual(remote_link.socket_dir(self.data), self.data / "remote")
        deep = self.data / ("x" * 90)
        far = remote_link.socket_dir(deep)
        self.assertNotEqual(far, deep / "remote")
        self.assertLessEqual(len(str(far)), remote_link.SOCKET_DIR_MAX)
        self.assertEqual(far, remote_link.socket_dir(deep))   # the same board finds the same folder

    def test_the_boards_socket_is_the_accounts_alone(self):
        path = self.data / "remote" / "board.sock"
        sock = remote_link.listen_socket(path)
        try:
            self.assertTrue(stat.S_ISSOCK(os.stat(path).st_mode))
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(path.parent).st_mode), 0o700)
        finally:
            sock.close()
        again = remote_link.listen_socket(path)   # a socket left by an earlier board is replaced
        again.close()


class Keys(unittest.TestCase):
    def setUp(self):
        self.data = short_tmp("rl-keys-")
        self.join = remote_link.new_key()
        remote_link.Store(self.data).save_servers([
            {"id": "lab", "name": "lab", "dest": "you@lab", "home": "/home/you",
             "python": "/usr/bin/python3", "join": remote_link.digest(self.join)}])
        self.remote = remote_link.Remote(self.data, links=False)
        self.remote.reload()

    def tearDown(self):
        shutil.rmtree(self.data, ignore_errors=True)

    def test_a_join_key_names_its_server(self):
        self.assertEqual(self.remote.server_of_join(self.join)["id"], "lab")
        self.assertIsNone(self.remote.server_of_join("not it"))
        self.assertIsNone(self.remote.server_of_join(""))

    def test_a_minted_key_names_its_lane_and_the_file_holds_only_its_hash(self):
        key = self.remote.mint("demo", "lab")
        self.assertEqual(self.remote.lane_of(key), ("demo", "lab"))
        self.assertIsNone(self.remote.lane_of(key + "x"))
        held = self.remote.store.keys_file.read_text()
        self.assertNotIn(key, held)
        self.assertIn(remote_link.digest(key), held)
        self.assertEqual(stat.S_IMODE(os.stat(self.remote.store.keys_file).st_mode), 0o600)

    def test_a_new_key_ends_the_lanes_old_one(self):
        first = self.remote.mint("demo", "lab")
        second = self.remote.mint("demo", "lab")
        self.assertIsNone(self.remote.lane_of(first))
        self.assertEqual(self.remote.lane_of(second), ("demo", "lab"))

    def test_a_server_is_listed_for_the_picker_at_its_real_home(self):
        recs = self.remote.store.servers()
        self.remote.store.save_servers([{**recs[0], "home": "/home/you", "top": "/data/home/you"}])
        self.remote.reload()
        machine = self.remote.machines()[0]
        self.assertEqual((machine["id"], machine["kind"], machine["online"]), ("lab", "server", False))
        self.assertEqual((machine["top"], machine["home"]), ("/data/home/you", "/data/home/you"))
        self.assertEqual(machine["places"], [{"id": "home", "name": "you", "path": "/data/home/you"}])

    def test_a_removed_servers_keys_go(self):
        key = self.remote.mint("demo", "lab")
        self.remote.store.save_servers([])
        self.remote.reload()
        self.assertIsNone(self.remote.lane_of(key))
        self.assertEqual(self.remote.store.keys(), {})


class Lanes(unittest.TestCase):
    PROJECTS = [{"id": "app", "name": "App", "dir": "/home/you/app", "git": "/home/you/app/.git"},
                {"id": "app-web", "name": "Web", "dir": "/home/you/app/web"},
                {"id": "notes", "name": "Notes", "dir": "/home/you/notes"}]

    def test_the_deepest_folder_holding_the_path_wins(self):
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, "/home/you/app/web/src")[0], ["app-web"])
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, "/home/you/app/api")[0], ["app"])
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, "/home/you/application")[0], [])

    def test_a_worktree_finds_its_project_by_repository(self):
        found, _ = remote_link.resolve_lane(self.PROJECTS, "/home/you/wt/app-fix", git="/home/you/app/.git")
        self.assertEqual(found, ["app"])

    def test_a_named_board_by_id_or_name(self):
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, name="notes")[0], ["notes"])
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, name="web")[0], ["app-web"])
        self.assertEqual(remote_link.resolve_lane(self.PROJECTS, name="nope"), ([], "project_unknown"))

    def test_presence_reads_as_the_helper_reads_it(self):
        self.assertEqual(remote_link.presence_status({"busy": "m3"}), "claim_held")
        self.assertEqual(remote_link.presence_status({"busy": None, "listening": True}), "listener_present")
        self.assertEqual(remote_link.presence_status({"busy": None, "listening": False, "gap": 12}), "listener_present")
        self.assertEqual(remote_link.presence_status({"busy": None, "listening": False, "gap": 300}), "ready")


class Fade(unittest.TestCase):
    def test_a_link_fades_thirty_seconds_after_it_went_down(self):
        link = remote_link.Link({"id": "lab", "name": "lab", "dest": "x", "home": "/h"},
                                Path("/tmp/none"), Path("/tmp/none-ctl"))
        link.up, link.since = False, 1000.0
        self.assertFalse(link.state(1000.0)["faded"])
        self.assertFalse(link.state(1029.9)["faded"])
        self.assertTrue(link.state(1030.0)["faded"])
        link._set(True, "up")
        self.assertFalse(link.state()["faded"])
        link._set(False, "link lost")   # a fresh drop starts the count again
        self.assertFalse(link.state(link.since + 29)["faded"])
        self.assertTrue(link.state(link.since + 30)["faded"])


class LinkUpAndDown(unittest.TestCase):
    def setUp(self):
        self.root = short_tmp("rl-link-")
        self.home = self.root / "server"
        self.home.mkdir()
        self.down = self.root / "down"
        self.saved = remote_link.SSH, remote_link.BACKOFF
        remote_link.SSH = str(fake_ssh_bin(self.root))
        remote_link.BACKOFF = (0.5, 1)
        os.environ["FAKE_SSH_HOME"] = str(self.home)
        os.environ["FAKE_SSH_DOWN"] = str(self.down)
        self.board = self.root / "mac" / "board.sock"
        self.listener = remote_link.listen_socket(self.board)
        self.rec = {"id": "lab", "name": "lab", "dest": "you@lab", "home": str(self.home),
                    "python": sys.executable, "join": "x"}
        self.link = remote_link.Link(self.rec, self.board, self.root / "mac" / "c1")

    def tearDown(self):
        self.link.stop()
        self.listener.close()
        remote_link.SSH, remote_link.BACKOFF = self.saved
        for name in ("FAKE_SSH_HOME", "FAKE_SSH_DOWN"):
            os.environ.pop(name, None)
        shutil.rmtree(self.root, ignore_errors=True)

    def server_socket(self):
        return Path(remote_link.server_socket(self.rec))

    def reaches_board(self):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(2)
                s.connect(str(self.server_socket()))
                s.sendall(b"ping")
            near, _ = self.listener.accept()
            with near:
                return near.recv(4) == b"ping"
        except OSError:
            return False

    def test_up_clears_a_stale_socket_and_forwards_for_the_account_alone(self):
        stale = self.server_socket()
        stale.parent.mkdir(parents=True)
        left = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        left.bind(str(stale))
        left.close()   # a socket file nobody listens on, as a dropped link leaves it
        self.link.start()
        self.assertTrue(until(lambda: self.link.up), "the link did not come up")
        self.assertEqual(stat.S_IMODE(os.stat(stale).st_mode), 0o600)
        self.listener.settimeout(5)
        self.assertTrue(self.reaches_board())

    def test_a_server_that_goes_away_takes_the_link_down_and_back_up(self):
        self.link.start()
        self.assertTrue(until(lambda: self.link.up))
        self.down.write_text("")
        self.assertTrue(until(lambda: not self.link.up), "the link did not notice the server go")
        self.assertIn(self.link.reason, ("link lost", "login failed"))
        time.sleep(1.5)
        self.assertFalse(self.link.up, "a server that is still down came back up")
        self.down.unlink()
        self.assertTrue(until(lambda: self.link.up), "the link did not come back on its own")
        self.listener.settimeout(5)
        self.assertTrue(self.reaches_board())

    def test_stop_ends_the_ssh(self):
        self.link.start()
        self.assertTrue(until(lambda: self.link.up))
        proc = self.link._proc
        self.link.stop()
        self.assertIsNotNone(proc.poll())
        self.assertFalse(self.link.control.exists())


class Program(unittest.TestCase):
    """PROGRAM as the board runs it on a server, run here with HOME a scratch
    folder and nothing between: the same text on standard input."""

    def setUp(self):
        self.home = short_tmp("rl-prog-")
        for name in ("alpha", "beta", "run-10", "run-9", ".secret", "beta/inner", "beta/two"):
            (self.home / name).mkdir(parents=True)
        (self.home / "afile").write_text("x")
        (self.home / "beta" / "note.txt").write_text("x")
        os.symlink("/", self.home / "outward")

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_op(self, op, *args):
        r = subprocess.run([sys.executable, "-B", "-"], input=remote_link.program_text(op, *args),
                           capture_output=True, env={**os.environ, "HOME": str(self.home)}, timeout=20)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.decode().strip().splitlines()[-1])

    def test_the_home_listing_is_the_pickers_shape(self):
        out = self.run_op("dirs", "", "")["answer"]
        self.assertEqual(set(out), {"path", "name", "short", "top", "parent", "trail", "dirs", "more", "cut", "unreadable"})
        self.assertFalse(out["cut"])
        self.assertEqual(out["path"], str(self.home))
        self.assertEqual(out["short"], "~")
        self.assertIsNone(out["parent"])
        self.assertEqual([d["name"] for d in out["dirs"]], ["alpha", "beta", "run-9", "run-10"])
        beta = next(d for d in out["dirs"] if d["name"] == "beta")
        self.assertEqual(set(beta), {"name", "path", "modified", "items"})
        self.assertEqual(beta["items"], 3)

    def test_a_folder_below_has_its_trail(self):
        out = self.run_op("dirs", "inner", str(self.home / "beta"))["answer"]
        self.assertEqual(out["short"], "~/beta/inner")
        self.assertEqual([t["name"] for t in out["trail"]], [self.home.name, "beta", "inner"])
        self.assertEqual(out["parent"], str(self.home / "beta"))

    def test_the_pickers_refusals_in_its_words(self):
        for path, said in (("/", "outside the home folder"), ("outward", "outside the home folder"),
                           (".secret", "that folder is hidden"), ("nothing", "no folder there"),
                           ("afile", "that is a file, not a folder"),
                           # another account's home is never looked up
                           ("~root", "outside the home folder"), ("~nobody/x", "outside the home folder"),
                           ("a" * 5000, "that path is too long")):
            with self.subTest(path=path):
                self.assertEqual(self.run_op("dirs", path, ""), {"error": said})

    def test_a_new_folder(self):
        out = self.run_op("mkdir", str(self.home / "alpha"), "made")["answer"]
        self.assertEqual(out["path"], str(self.home / "alpha" / "made"))
        self.assertTrue((self.home / "alpha" / "made").is_dir())
        self.assertEqual(self.run_op("mkdir", str(self.home / "alpha"), "made"),
                         {"error": "a folder by that name is already here"})
        self.assertEqual(self.run_op("mkdir", str(self.home), ".dot"),
                         {"error": "a folder name cannot start with a dot"})
        self.assertEqual(self.run_op("mkdir", str(self.home), "a\u202eb"),
                         {"error": "a folder name cannot hold an invisible character"})
        self.assertTrue(self.run_op("mkdir", str(self.home), "a\u200db")["answer"]["ok"])   # a joiner may stand

    def test_describe_names_the_real_folder_and_its_repository(self):
        repo = self.home / "alpha"
        if shutil.which("git") is None:
            self.skipTest("no git here")
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        out = self.run_op("describe", str(repo))["answer"]
        self.assertEqual(out["path"], str(repo))
        self.assertEqual(out["git"], str(repo / ".git"))
        self.assertIsNone(self.run_op("describe", str(self.home / "beta"))["answer"]["git"])
        self.assertEqual(self.run_op("describe", "/"), {"error": "outside the home folder"})


if __name__ == "__main__":
    unittest.main()
