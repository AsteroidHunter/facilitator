"""The board share in tokens.py: which log files ran the board's wait helper,
how a day's tokens split by it, and the cache taken over from before it.

  helper    a Claude Code tool_use or a Codex function call whose command runs
            scripts/onboard.py wait, or the older curl call to /wait?owner=,
            makes its file a yes; words only written or read never do
  subagent  a Claude subagent's file counts with its session's own file
  split     each day's tokens are board, off_board or board_unknown, and the
            three add up to the tools' own totals
  kept      the cache holds a yes or no per file and never the command
  taken     a version 2 cache keeps every count with its answer unknown, a
            later helper line makes it a yes, a reread gives a full answer;
            any other old version is started over

Every log here is invented, in a temporary folder; nothing reads a real one.

    python3 -m unittest tests/test_token_board_share.py
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import tokens  # noqa: E402

DAY = "2026-10-04"
AT = DAY + "T12:00:00Z"        # noon UTC is the same calendar day in nearly every zone
WAIT = 'python3 "$HOME/.agents/skills/facilitator/scripts/onboard.py" wait --owner SECRET-lane --agent claude'
CURL = 'curl --max-time 430 -sS "http://127.0.0.1:$PORT/wait?owner=SECRET-lane&timeout=420&agent=claude"'
SECRETS = ("SECRET", "onboard", "--owner", "curl", "grep", "notes.md", "invented words")


def claude(mid, counts, command=None, text="invented words", tool="Bash", key="command"):
    content = [{"type": "text", "text": text}]
    if command is not None:
        content.append({"type": "tool_use", "id": "toolu_" + mid, "name": tool,
                        "input": {key: command, "description": "SECRET step"}})
    inp, cw, cr, out = counts
    return {"type": "assistant", "timestamp": AT,
            "message": {"id": mid, "role": "assistant", "content": content,
                        "usage": {"input_tokens": inp, "cache_creation_input_tokens": cw,
                                  "cache_read_input_tokens": cr, "output_tokens": out}}}


def record(rid, inp, cached, out):
    return {"timestamp": AT, "type": "token_usage_record",
            "payload": {"response_id": rid, "usage": {"input_tokens": inp, "cached_input_tokens": cached,
                                                      "output_tokens": out, "total_tokens": inp + out}}}


def shell(command):
    return {"timestamp": AT, "type": "response_item",
            "payload": {"type": "function_call", "name": "shell", "call_id": "call_1",
                        "arguments": json.dumps({"command": ["bash", "-lc", command], "workdir": "/SECRET"})}}


def exec_command(command):
    return {"timestamp": AT, "type": "response_item",
            "payload": {"type": "function_call", "name": "exec_command", "call_id": "call_2",
                        "arguments": json.dumps({"cmd": command})}}


def local_shell(command):
    return {"timestamp": AT, "type": "response_item",
            "payload": {"type": "local_shell_call", "call_id": "call_3",
                        "action": {"type": "exec", "command": ["bash", "-lc", command]}}}


def patch(text):
    return {"timestamp": AT, "type": "response_item",
            "payload": {"type": "custom_tool_call", "name": "apply_patch", "call_id": "call_4", "input": text}}


class Logs(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="token-board-share-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.claude = self.dir / "claude" / "projects" / "proj"
        self.codex = self.dir / "codex" / "sessions"
        self.cache = self.dir / "tokens-cache.json"

    def put(self, path, rows, mode="w"):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, mode) as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
        return path

    def ledger(self):
        return tokens.TokenLedger({"claude": [self.dir / "claude" / "projects"], "codex": [self.codex]},
                                  self.cache)

    def split(self, ledger=None):
        tally = (ledger or self.ledger()).tally()
        return {share: sum(tally[share].get(DAY, [0])) for share in tokens.SHARES}

    def answers(self):
        files = json.loads(self.cache.read_text())["files"]
        return {os.path.relpath(path, self.dir): rec["board"] for path, rec in files.items()}


class Helper(Logs):
    def test_a_claude_session_that_ran_the_helper_is_board_and_its_subagents_with_it(self):
        self.put(self.claude / "attached.jsonl", [claude("m1", [10, 100, 1000, 5], WAIT), claude("m2", [1, 0, 0, 1])])
        self.put(self.claude / "attached" / "subagents" / "agent-a.jsonl", [claude("m3", [2, 0, 20, 2])])
        self.put(self.claude / "plain.jsonl", [
            claude("m4", [3, 0, 30, 3], text="next I run scripts/onboard.py wait --owner SECRET"),   # only words
            claude("m5", [4, 0, 0, 4], "grep -n 'onboard.py' notes.md"),                            # no wait
            claude("m6", [5, 0, 0, 5], WAIT, tool="Write", key="content"),                           # a file written
        ])
        self.put(self.claude / "plain" / "subagents" / "agent-b.jsonl", [claude("m7", [6, 0, 0, 6])])
        # a subagent that ran the helper itself is board; its session is not made so
        self.put(self.claude / "lent.jsonl", [claude("m8", [7, 0, 0, 7])])
        self.put(self.claude / "lent" / "subagents" / "agent-c.jsonl", [claude("m9", [8, 0, 0, 8], CURL)])
        tally = self.ledger().tally()
        self.assertEqual(tally["board"][DAY], [10 + 1 + 2 + 8, 100, 1000 + 20, 5 + 1 + 2 + 8])
        self.assertEqual(tally["off_board"][DAY], [3 + 4 + 5 + 6 + 7, 0, 30, 3 + 4 + 5 + 6 + 7])
        self.assertNotIn(DAY, tally["board_unknown"])
        self.assertEqual(self.answers(), {
            "claude/projects/proj/attached.jsonl": True,
            "claude/projects/proj/attached/subagents/agent-a.jsonl": False,
            "claude/projects/proj/plain.jsonl": False,
            "claude/projects/proj/plain/subagents/agent-b.jsonl": False,
            "claude/projects/proj/lent.jsonl": False,
            "claude/projects/proj/lent/subagents/agent-c.jsonl": True,
        })

    def test_a_codex_function_call_that_runs_the_helper_is_board(self):
        for name, call in (("shell", shell(WAIT)), ("exec", exec_command(WAIT)), ("local", local_shell(WAIT)),
                           ("curl", exec_command(CURL)), ("bare", exec_command("python3 onboard.py wait"))):
            self.put(self.codex / f"rollout-{name}.jsonl", [call, record("r-" + name, 100, 60, 10)])
        self.put(self.codex / "rollout-other.jsonl", [
            patch("*** Add File: notes.md\n+python3 scripts/onboard.py wait --owner SECRET\n"),   # a patch, not a run
            exec_command("python3 onboard.py inspect"),                                       # the helper, not wait
            exec_command("python3 onboard.py waiting.py"),
            {"timestamp": AT, "type": "response_item",
             "payload": {"type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": WAIT}]}},                  # the person's words
            record("r-other", 50, 0, 5),
        ])
        self.assertEqual(self.split(), {"board": 5 * 110, "off_board": 55, "board_unknown": 0})
        self.assertEqual(sum(v for v in self.answers().values()), 5)

    def test_the_three_shares_add_up_to_the_tools_and_daily_is_as_it_was(self):
        self.put(self.claude / "attached.jsonl", [claude("m1", [10, 100, 1000, 5], WAIT)])
        self.put(self.claude / "plain.jsonl", [claude("m2", [1, 2, 3, 4])])
        self.put(self.codex / "rollout-a.jsonl", [shell(WAIT), record("r1", 100, 60, 10)])
        self.put(self.codex / "rollout-b.jsonl", [record("r2", 50, 0, 5)])
        ledger = self.ledger()
        tally = ledger.tally()
        both = [a + b for a, b in zip(tally["claude"][DAY], tally["codex"][DAY])]
        shares = [sum(tally[share].get(DAY, [0, 0, 0, 0])[i] for share in tokens.SHARES) for i in range(4)]
        self.assertEqual(shares, both)
        row = next(r for r in ledger.daily(3, today=tokens.datetime.date(2026, 10, 5))["days"] if r["date"] == DAY)
        self.assertEqual(set(row), {"date", "total", *tokens.KINDS, *tokens.TOOLS}, "the route's rows changed")

    def test_a_yes_stays_a_yes_and_a_no_becomes_one_when_a_later_line_runs_the_helper(self):
        lane = self.put(self.claude / "lane.jsonl", [claude("m1", [1, 0, 0, 1])])
        ledger = self.ledger()
        self.assertEqual(self.split(ledger), {"board": 0, "off_board": 2, "board_unknown": 0})
        self.put(lane, [claude("m2", [2, 0, 0, 2], WAIT)], "a")
        self.assertEqual(self.split(ledger), {"board": 6, "off_board": 0, "board_unknown": 0})
        self.put(lane, [claude("m3", [3, 0, 0, 3])], "a")
        self.assertEqual(self.split(ledger), {"board": 12, "off_board": 0, "board_unknown": 0})

    def test_the_cache_keeps_the_yes_or_no_and_never_the_command(self):
        self.put(self.claude / "attached.jsonl", [claude("m1", [1, 0, 0, 1], WAIT)])
        self.put(self.claude / "older.jsonl", [claude("m2", [1, 0, 0, 1], CURL)])
        self.put(self.claude / "plain.jsonl", [claude("m3", [1, 0, 0, 1], "grep -n onboard.py notes.md")])
        self.put(self.codex / "rollout-a.jsonl", [shell(WAIT), record("r1", 100, 60, 10)])
        self.ledger().tally()
        kept = self.cache.read_text()
        for secret in SECRETS:
            self.assertNotIn(secret, kept)
        self.assertEqual(json.loads(kept)["version"], 3)
        self.assertEqual(sorted(self.answers().values()), [False, True, True, True])
        # a restarted board reads the answers back without opening a file
        again = self.ledger()
        again._read = lambda *a: self.fail("an unchanged file was opened again")
        self.assertEqual(self.split(again), {"board": 2 + 2 + 110, "off_board": 2, "board_unknown": 0})


class TakenOver(Logs):
    """A cache written before the board kept the answer: version 2, the same
    records without "board"."""

    def make_old_cache(self, limits=True):
        """Counts every log as the board before did and writes the cache back
        as that board left it."""
        self.ledger().tally()
        data = json.loads(self.cache.read_text())
        for rec in data["files"].values():
            del rec["board"]
        data["version"] = 2
        if limits:
            data["limits"] = {"at": 1.0, "primary": {"used_percent": 12.0, "window_minutes": 300.0, "resets_at": 2.0}}
        self.cache.write_text(json.dumps(data))

    def test_every_count_stays_and_every_file_is_unknown(self):
        self.put(self.claude / "lane.jsonl", [claude("m1", [10, 100, 1000, 5], WAIT)])
        gone = self.put(self.claude / "gone.jsonl", [claude("m2", [1, 2, 3, 4])])
        self.put(self.claude / "lane" / "subagents" / "agent-a.jsonl", [claude("m3", [2, 0, 0, 2])])
        self.put(self.codex / "rollout-a.jsonl", [record("r1", 100, 60, 10)])
        before = self.ledger().tally()
        self.make_old_cache()
        gone.unlink()   # Claude Code cleared it away: only the cache still has its counts
        ledger = self.ledger()
        self.assertEqual(ledger.limits["primary"]["used_percent"], 12.0, "the limits were lost")
        tally = ledger.tally()
        for tool in tokens.TOOLS:
            self.assertEqual(tally[tool], before[tool], "a count was lost in the takeover")
        self.assertEqual(self.split(ledger), {"board": 0, "off_board": 0,
                                              "board_unknown": 1115 + 10 + 4 + 110})

    def test_a_later_helper_line_makes_it_a_yes_and_a_reread_gives_a_full_answer(self):
        lane = self.put(self.claude / "lane.jsonl", [claude("m1", [1, 0, 0, 1])])
        quiet = self.put(self.claude / "quiet.jsonl", [claude("m2", [2, 0, 0, 2])])
        redone = self.put(self.claude / "redone.jsonl", [claude("m3", [3, 0, 0, 3])])
        gone = self.put(self.claude / "gone.jsonl", [claude("m4", [4, 0, 0, 4])])
        self.put(self.codex / "rollout-a.jsonl", [record("r1", 5, 0, 5)])
        self.make_old_cache(limits=False)
        gone.unlink()
        ledger = self.ledger()
        self.assertEqual(self.split(ledger), {"board": 0, "off_board": 0, "board_unknown": 2 + 4 + 6 + 8 + 10})
        self.put(lane, [claude("m5", [5, 0, 0, 5], WAIT)], "a")              # runs the helper after the takeover
        self.put(quiet, [claude("m6", [6, 0, 0, 6])], "a")                   # grows without it
        self.put(redone, [claude("m7", [7, 0, 0, 7], text="again")])          # rewritten: read from the start
        self.assertEqual(self.split(ledger), {"board": 2 + 10, "off_board": 14,
                                              "board_unknown": 4 + 12 + 8 + 10})
        saved = json.loads(self.cache.read_text())
        self.assertEqual(saved["version"], 3)
        self.assertEqual(self.answers(), {
            "claude/projects/proj/lane.jsonl": True,
            "claude/projects/proj/quiet.jsonl": None,
            "claude/projects/proj/redone.jsonl": False,
            "claude/projects/proj/gone.jsonl": None,
            "codex/sessions/rollout-a.jsonl": None,
        })
        # read back after a restart, the unknown stay unknown and the rest stay known
        self.assertEqual(self.split(self.ledger()), {"board": 12, "off_board": 14, "board_unknown": 34})

    def test_a_subagent_of_an_unknown_session_is_unknown_unless_it_ran_the_helper(self):
        self.put(self.claude / "s.jsonl", [claude("m1", [1, 0, 0, 1])])
        sub = self.put(self.claude / "s" / "subagents" / "agent-a.jsonl", [claude("m2", [2, 0, 0, 2])])
        self.make_old_cache(limits=False)
        ledger = self.ledger()
        self.put(self.claude / "s" / "subagents" / "agent-b.jsonl", [claude("m3", [3, 0, 0, 3])])   # new, no
        self.put(self.claude / "s" / "subagents" / "agent-c.jsonl", [claude("m4", [4, 0, 0, 4], WAIT)])
        self.assertEqual(self.split(ledger), {"board": 8, "off_board": 0, "board_unknown": 2 + 4 + 6})
        self.assertTrue(sub.exists())

    def test_any_other_version_is_started_over(self):
        self.put(self.claude / "s.jsonl", [claude("m1", [1, 0, 0, 1])])
        gone = self.put(self.claude / "gone.jsonl", [claude("m2", [2, 0, 0, 2])])
        self.make_old_cache(limits=False)
        data = json.loads(self.cache.read_text())
        data["version"] = 1
        self.cache.write_text(json.dumps(data))
        gone.unlink()
        self.assertEqual(self.split(), {"board": 0, "off_board": 2, "board_unknown": 0})


if __name__ == "__main__":
    unittest.main()
