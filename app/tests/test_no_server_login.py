"""Nothing in the board, its command, its installers or the skill logs in to
a server, keeps a login, or runs a command on one: read straight off the
source, so a later change that brings one back fails here.

  programs  no ssh, scp, sftp, rsync, sshpass, autossh, mosh, telnet, rsh or
            plink is started, by name in a command line or through a shell
  libraries no ssh library (paramiko, asyncssh, fabric, pexpect's pxssh) is
            imported
  setup     no ssh option (BatchMode, ControlMaster, ProxyCommand and the
            rest), no ~/.ssh, no ssh agent and no ssh config is read or named
  pages     no page script can start a program at all
  questions the board asks a server's link three fixed questions and the link
            answers those three and nothing else; the server side runs no
            shell and evaluates nothing it is sent

    python3 -B -m unittest tests/test_no_server_login.py
"""

import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
CLONE = APP.parent
SKILL = CLONE / ".agents" / "skills" / "facilitator"
sys.path.insert(0, str(APP))


def sources():
    """Every file here that can start a program: the board's Python, the
    command, the installers and the skill's scripts."""
    found = sorted(APP.glob("*.py")) + [APP / "facilitator"] + sorted(CLONE.glob("*.sh")) \
        + sorted(APP.glob("*.sh")) + sorted(SKILL.rglob("*.py"))
    return [p for p in found if p.is_file()]


def code_lines(path):
    """The lines of a file that are code: comments and docstrings are prose
    and may say what the code no longer does."""
    text = path.read_text(errors="replace")
    if path.suffix == ".py" or path.name == "facilitator":
        text = re.sub(r'"""[\s\S]*?"""', lambda m: "\n" * m.group(0).count("\n"), text)
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        out.append((n, line))
    return out


LOGIN_PROGRAMS = ("ssh", "scp", "sftp", "rsync", "sshpass", "autossh", "mosh", "telnet", "rsh", "rlogin", "plink",
                  "ssh-agent", "ssh-add", "ssh-keygen", "ssh-copy-id", "ssh-keyscan")
PROGRAM = re.compile(r"""["'](?:/usr/bin/|/bin/|/usr/local/bin/|/opt/homebrew/bin/)?(%s)["']"""
                     % "|".join(re.escape(p) for p in LOGIN_PROGRAMS))
SHELL_PROGRAM = re.compile(r"(?:^|[\s;&|(`$])(%s)\s" % "|".join(re.escape(p) for p in LOGIN_PROGRAMS))
LIBRARIES = re.compile(r"\b(?:import|from)\s+(paramiko|asyncssh|fabric|pexpect|pxssh|ssh2|libssh|scrapli)\b")
SSH_SETUP = re.compile(r"BatchMode|ControlMaster|ControlPath|ControlPersist|ProxyCommand|ProxyJump"
                       r"|StrictHostKeyChecking|UserKnownHostsFile|ServerAliveInterval|IdentityFile"
                       r"|SSH_AUTH_SOCK|SSH_CONFIG|ssh_config|authorized_keys|known_hosts"
                       r"|[\"'/~]\.ssh\b|ssh://")


class NoLogin(unittest.TestCase):
    def assert_none(self, pattern, files, what, shell=False):
        hits = []
        for path in files:
            for n, line in code_lines(path):
                if pattern.search(line):
                    hits.append(f"{path.relative_to(CLONE)}:{n}: {line.strip()[:120]}")
        self.assertEqual(hits, [], what)

    def test_the_sources_are_all_read(self):
        names = {p.name for p in sources()}
        for name in ("server.py", "remote_link.py", "facilitator", "install.sh", "onboard.py", "link.py", "pair.py"):
            self.assertIn(name, names)

    def test_no_login_program_is_started(self):
        self.assert_none(PROGRAM, sources(), "a login program named in a command line")
        shells = [p for p in sources() if p.suffix == ".sh"]
        self.assert_none(SHELL_PROGRAM, shells, "a login program run by a shell script")

    def test_no_ssh_library(self):
        self.assert_none(LIBRARIES, sources(), "an ssh library imported")

    def test_no_ssh_setup_is_read_or_named(self):
        self.assert_none(SSH_SETUP, sources(), "ssh's options, keys or config")

    def test_no_page_script_starts_a_program(self):
        pages = sorted(APP.glob("*.js")) + sorted(APP.glob("*.html"))
        self.assertTrue(pages)
        self.assert_none(re.compile(r"child_process|require\(['\"](?:node:)?child_process|Deno\.run|spawnSync"),
                         pages, "a page script that could start a program")

    def test_the_three_questions_and_no_others(self):
        import importlib.util
        import remote_link
        self.assertEqual(remote_link.OPS, frozenset({"dirs", "mkdir", "describe"}))
        spec = importlib.util.spec_from_file_location("link_for_the_grep", SKILL / "scripts" / "link.py")
        link = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(link)
        self.assertEqual(set(link.OPS), set(remote_link.OPS))

    def test_the_server_side_runs_no_shell_and_evaluates_nothing(self):
        server_side = [SKILL / "scripts" / name for name in ("link.py", "pair.py", "onboard.py", "magic.py")]
        self.assert_none(re.compile(r"shell\s*=\s*True|os\.system|os\.popen|\beval\(|\bexec\(|pickle|marshal"
                                    r"|__import__|importlib"), server_side, "a shell or an evaluation")
        # the magic box's command only asks the door
        self.assert_none(re.compile(r"\bsubprocess\b|\bos\.exec|\bos\.spawn"), [SKILL / "scripts" / "magic.py"],
                         "a program started")
        # the link starts no program but itself, and asks git nothing: a
        # repository is found by reading what git keeps
        link = (SKILL / "scripts" / "link.py").read_text()
        starts = re.compile(r"subprocess\.(?:run|Popen|call|check_call|check_output|getoutput|getstatusoutput)\b")
        started = [line.strip() for n, line in code_lines(SKILL / "scripts" / "link.py") if starts.search(line)]
        self.assertEqual(len(started), 1, started)
        self.assertIn("subprocess.Popen([sys.executable, \"-B\", str(Path(__file__).resolve()), \"run\"]", started[0])
        self.assertIsNone(re.search(r"\[\s*[\"']git[\"']", link), "the link runs git")


if __name__ == "__main__":
    unittest.main()
