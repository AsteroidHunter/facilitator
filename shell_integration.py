"""Own the command, shell block and personal skill links installed by ./install.sh,
and take back the Claude Code status line entry an older install added."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLI = ROOT / "facilitator"
HOME = Path.home()
BIN = HOME / ".local" / "share" / "facilitator" / "bin" / "facilitator"
PROFILE_RECORD = BIN.parent.parent / "profiles.json"
SKILL = ROOT / ".agents" / "skills" / "facilitator"
SKILL_RECORD = ROOT / ".facilitator-skills.json"
STATUSLINE = ROOT / "claude-statusline.py"
STATUSLINE_RECORD = ROOT / ".facilitator-statusline.json"
BEGIN = b"# >>> Facilitator installer >>>"
END = b"# <<< Facilitator installer <<<"
PATH_LINE = b'export PATH="$HOME/.local/share/facilitator/bin:$PATH"'


def style(code, text):
    """ANSI styling only on a terminal, so pipes and logs stay plain."""
    return f"\033[{code}m{text}\033[0m" if sys.stdout.isatty() else text


_printed = False
QUIET = False
done = 0


def ok(text):
    global _printed, done
    done += 1
    if QUIET:
        return
    _printed = True
    print(f"{style('38;2;0;114;0', '✓')} {text}")


def skipped(text):
    global _printed
    _printed = True
    print(f"{style('2', '⊘')} {text}")


def problem(headline, *next_steps):
    """The text for SystemExit: the problem, then each next step indented two
    spaces. A blank line comes first, unless nothing has been printed yet,
    because the step intro before it already ended with one."""
    lead = "\n" if _printed else ""
    return lead + "⚠ " + headline + "".join("\n  " + line for line in next_steps)


def block(newline):
    return newline.join((BEGIN, PATH_LINE, END, b""))


def profiles():
    shell = Path(os.environ.get("SHELL", "")).name
    if shell == "bash":
        login = next((HOME / name for name in (".bash_profile", ".bash_login", ".profile")
                     if (HOME / name).exists()), HOME / ".bash_profile")
        return [HOME / ".bashrc", login]
    if shell == "zsh":
        # ZDOTDIR is often set in .zshenv without being exported, so a Bash
        # installer process cannot see it in its own environment. Ask Zsh to
        # read that startup file and report the directory it will actually use.
        try:
            check = subprocess.run(
                [os.environ.get("SHELL") or "zsh", "-c",
                 'printf "\\n__FACILITATOR_ZDOTDIR__%s\\n" "${ZDOTDIR:-$HOME}"'],
                capture_output=True, text=True, timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise SystemExit(problem("Could not determine Zsh's ZDOTDIR.", "No profile was changed."))
        marker = "__FACILITATOR_ZDOTDIR__"
        lines = [line[len(marker):] for line in check.stdout.splitlines() if line.startswith(marker)]
        if check.returncode or not lines:
            raise SystemExit(problem("Could not determine Zsh's ZDOTDIR.", "No profile was changed."))
        zdot = Path(lines[-1]).expanduser()
        if not zdot.is_dir():
            raise SystemExit(problem(f"ZDOTDIR {zdot} does not exist."))
        return [zdot / ".zshrc"]
    raise SystemExit(problem("SHELL is not bash or zsh.",
                             "Set SHELL to bash or zsh, then run ./install.sh again."))


def recorded_profiles():
    if PROFILE_RECORD.is_symlink():
        raise SystemExit(problem(f"{PROFILE_RECORD} is a symlink.", "Leaving it untouched."))
    if not PROFILE_RECORD.exists():
        return {}
    try:
        entries = json.loads(PROFILE_RECORD.read_text())
        if not isinstance(entries, dict) or any(
            not isinstance(p, str) or not Path(p).is_absolute() or not isinstance(created, bool)
            for p, created in entries.items()
        ):
            raise ValueError("invalid profile record")
        return entries
    except (OSError, ValueError):
        raise SystemExit(problem(f"{PROFILE_RECORD} is invalid.", "Leaving your profiles untouched."))


def owned_link():
    return BIN.is_symlink() and os.readlink(BIN) == str(CLI)


def inspect_profile(rc):
    if rc.is_symlink():
        raise SystemExit(problem(f"{rc} is a symlink.", "Add the Facilitator bin to PATH by hand."))
    content = rc.read_bytes() if rc.exists() else b""
    newline = b"\r\n" if b"\r\n" in content else b"\n"
    owned = block(newline)
    if (BEGIN in content or END in content) and owned not in content:
        raise SystemExit(problem(f"The installer block in {rc} was edited.", "Leaving it untouched."))
    return content, newline, owned


def preflight():
    if (BIN.exists() or BIN.is_symlink()) and not owned_link():
        raise SystemExit(problem(f"{BIN} already exists.", "Leaving it untouched."))
    for rc in set(profiles() + [Path(p) for p in recorded_profiles()]):
        inspect_profile(rc)
    skills_preflight()


def install():
    preflight()
    BIN.parent.mkdir(parents=True, exist_ok=True)
    if not owned_link():
        BIN.symlink_to(CLI)
        ok(f"Command linked at {BIN}.")
    else:
        ok("Command already linked.")
    skills_install()
    local_bin = str(BIN.parent)
    if local_bin in os.environ.get("PATH", "").split(os.pathsep):
        ok("The command folder is already on PATH.")
        return
    recorded = recorded_profiles()
    added = False
    for rc in profiles():
        created = not rc.exists()
        content, newline, owned = inspect_profile(rc)
        if owned in content:
            ok(f"Installer block already in {rc}.")
        else:
            with rc.open("ab") as out:
                out.write((newline if content else b"") + owned)
            ok(f"Added the installer block to {rc}.")
            added = True
        recorded.setdefault(str(rc), created)
    PROFILE_RECORD.write_text(json.dumps(recorded) + "\n")
    if added:
        print("Open a new terminal to use facilitator.")


def uninstall():
    statusline_uninstall()
    skills_uninstall()
    # Another checkout's command and profile block are not ours, even though
    # the block text is identical. Without the command link as evidence, leave
    # global shell settings alone.
    if not owned_link():
        if BIN.exists() or BIN.is_symlink():
            skipped(f"Kept command {BIN}, which has changed since install.")
        skipped("Kept the PATH block: the command is not owned by this checkout.")
        return
    recorded = recorded_profiles()
    BIN.unlink()
    ok(f"Removed command link {BIN}.")
    other_entries = BIN.parent.is_dir() and any(BIN.parent.iterdir())
    if other_entries:
        skipped(f"Kept the PATH block: other commands remain in {BIN.parent}.")
        return
    targets = list(dict.fromkeys([Path(p) for p in recorded] + [HOME / ".zshrc", HOME / ".bashrc", HOME / ".bash_profile", HOME / ".bash_login", HOME / ".profile"]))
    keep_record = False
    for rc in targets:
        if rc.is_symlink():
            keep_record = True
            continue
        if not rc.exists():
            continue
        content = rc.read_bytes()
        newline = b"\r\n" if b"\r\n" in content else b"\n"
        owned = block(newline)
        if owned not in content:
            if BEGIN in content or END in content:
                skipped(f"Kept the edited installer block in {rc}.")
                print("Remove it by hand if desired.")
                keep_record = True
            continue
        addition = (newline + owned) if newline + owned in content else owned
        rc.write_bytes(content.replace(addition, b"", 1))
        if recorded.get(str(rc)) and rc.stat().st_size == 0:
            rc.unlink()
        ok(f"Removed installer block from {rc}.")
    if PROFILE_RECORD.exists() and not keep_record:
        PROFILE_RECORD.unlink()


def claude_dir():
    root = os.environ.get("CLAUDE_CONFIG_DIR")
    claude = Path(root).expanduser() if root else HOME / ".claude"
    if not claude.is_absolute():
        raise SystemExit(problem("CLAUDE_CONFIG_DIR must be an absolute path."))
    return claude


def skill_destinations():
    """Personal skill locations in the two hosts, without editing their settings."""
    return (claude_dir() / "skills" / "facilitator", HOME / ".agents" / "skills" / "facilitator")


def skill_record():
    if SKILL_RECORD.is_symlink():
        raise SystemExit(problem(f"{SKILL_RECORD} is a symlink.", "Leaving it untouched."))
    if not SKILL_RECORD.exists():
        return {"version": 1, "links": {}, "dirs": {}}
    try:
        record = json.loads(SKILL_RECORD.read_text())
        if (not isinstance(record, dict) or record.get("version") != 1
                or not isinstance(record.get("links"), dict)
                or not isinstance(record.get("dirs"), dict)):
            raise ValueError("invalid skill record")
        for path, entry in record["links"].items():
            if (not Path(path).is_absolute() or Path(path).name != "facilitator"
                    or Path(path).parent.name != "skills" or not isinstance(entry, dict)
                    or entry.get("target") != str(SKILL)
                    or not isinstance(entry.get("dev"), int)
                    or not isinstance(entry.get("ino"), int)
                    or not isinstance(entry.get("ctime_ns"), int)
                    or not isinstance(entry.get("parent"), str)):
                raise ValueError("invalid skill link record")
        for path, entry in record["dirs"].items():
            if (not Path(path).is_absolute() or not isinstance(entry, dict)
                    or not isinstance(entry.get("dev"), int)
                    or not isinstance(entry.get("ino"), int)):
                raise ValueError("invalid skill directory record")
        return record
    except (OSError, ValueError):
        raise SystemExit(problem(f"{SKILL_RECORD} is invalid.", "Leaving your skills untouched."))


def save_skill_record(record):
    temporary = SKILL_RECORD.with_suffix(".tmp")
    if temporary.exists() or temporary.is_symlink():
        raise SystemExit(problem(f"{temporary} already exists.", "Leaving it untouched."))
    temporary.write_text(json.dumps(record, indent=2) + "\n")
    temporary.replace(SKILL_RECORD)


def same_skill(link):
    if not link.is_symlink():
        return False
    try:
        return (link.parent / os.readlink(link)).resolve() == SKILL.resolve()
    except (OSError, RuntimeError):
        return False


def skills_preflight():
    skill_record()
    if not (SKILL / "SKILL.md").is_file():
        raise SystemExit(problem(f"The skill source is missing at {SKILL}."))
    for link in skill_destinations():
        if (link.exists() or link.is_symlink()) and not same_skill(link):
            raise SystemExit(problem(f"{link} already exists.", "Leaving the existing skill untouched."))


def make_skill_parents(parent, record):
    missing = []
    cursor = parent
    while not cursor.exists() and not cursor.is_symlink():
        missing.append(cursor)
        cursor = cursor.parent
    if not cursor.is_dir():
        raise SystemExit(problem(f"{cursor} is not a directory.", "Leaving your skills untouched."))
    for directory in reversed(missing):
        directory.mkdir()
        stat = directory.lstat()
        record["dirs"][str(directory)] = {"dev": stat.st_dev, "ino": stat.st_ino}
        save_skill_record(record)


def skills_install():
    skills_preflight()
    record = skill_record()
    for link in skill_destinations():
        if link.is_symlink():
            ok(f"Skill already linked at {link}.")
            continue
        make_skill_parents(link.parent, record)
        link.symlink_to(SKILL)
        stat = link.lstat()
        record["links"][str(link)] = {"target": str(SKILL), "dev": stat.st_dev,
                                      "ino": stat.st_ino, "ctime_ns": stat.st_ctime_ns,
                                      "parent": str(link.parent.resolve())}
        save_skill_record(record)
        ok(f"Skill linked at {link}.")


def skills_uninstall():
    record = skill_record()
    for raw, entry in record["links"].items():
        link = Path(raw)
        if (link.is_symlink() and os.readlink(link) == entry["target"]
                and str(link.parent.resolve()) == entry["parent"]
                and (link.lstat().st_dev, link.lstat().st_ino, link.lstat().st_ctime_ns)
                == (entry["dev"], entry["ino"], entry["ctime_ns"])):
            link.unlink()
            ok(f"Removed skill link {link}.")
        elif link.exists() or link.is_symlink():
            skipped(f"Kept skill {link}, which has changed since install.")
    for raw, entry in sorted(record["dirs"].items(), key=lambda item: len(Path(item[0]).parts), reverse=True):
        directory = Path(raw)
        if directory.is_dir() and not directory.is_symlink():
            stat = directory.lstat()
            if (stat.st_dev, stat.st_ino) == (entry["dev"], entry["ino"]):
                try:
                    directory.rmdir()
                except OSError:
                    pass  # other skills or settings now live here
    if SKILL_RECORD.exists():
        SKILL_RECORD.unlink()


WHITESPACE = " \t\r\n"
DECODER = json.JSONDecoder()


def skip_space(text, at):
    while at < len(text) and text[at] in WHITESPACE:
        at += 1
    return at


def members_of(text, at=0):
    """The object that starts at text[at], as (open, members, close). Each
    member is (key, key_start, key_end, value_start, value_end), so one can be
    added, replaced or taken out without rewriting the rest of the text."""
    i = skip_space(text, at)
    if text[i:i + 1] != "{":
        raise ValueError("not an object")
    opened = i
    i = skip_space(text, i + 1)
    found = []
    if text[i:i + 1] == "}":
        return opened, found, i
    while True:
        key, key_end = DECODER.raw_decode(text, i)
        colon = skip_space(text, key_end)
        if not isinstance(key, str) or text[colon:colon + 1] != ":":
            raise ValueError("bad member")
        start = skip_space(text, colon + 1)
        _, end = DECODER.raw_decode(text, start)
        found.append((key, i, key_end, start, end))
        i = skip_space(text, end)
        if text[i:i + 1] == ",":
            i = skip_space(text, i + 1)
        elif text[i:i + 1] == "}":
            return opened, found, i
        else:
            raise ValueError("bad object")


def last_member(found, key):
    return next((m for m in reversed(found) if m[0] == key), None)


def remove_member(text, key):
    """text without the last member named key, and nothing else changed."""
    opened, found, closed = members_of(text)
    at = next(i for i in reversed(range(len(found))) if found[i][0] == key)
    if len(found) == 1:
        return text[:opened] + "{}" + text[closed + 1:]
    if at == len(found) - 1:
        return text[:found[at - 1][4]] + text[found[at][4]:]
    return text[:found[at][1]] + text[found[at + 1][1]:]


def statusline_spans(text):
    """Where the statusLine value and its command value sit in text, each as
    (start, end), or None for a part that is not there."""
    _, found, _ = members_of(text)
    member = last_member(found, "statusLine")
    if member is None:
        return None, None
    command = None
    if text[member[3]] == "{":
        _, inner, _ = members_of(text, member[3])
        got = last_member(inner, "command")
        command = (got[3], got[4]) if got else None
    return (member[3], member[4]), command


def read_settings(path):
    """The settings file's text; None when there is no file; ValueError when
    it is not a JSON object."""
    if path.is_symlink() and not path.exists():
        raise ValueError("dangling link")
    if not path.exists():
        return None
    text = path.read_bytes().decode("utf-8")
    if not isinstance(json.loads(text), dict):
        raise ValueError("not an object")
    return text


def write_settings(path, text):
    """Replace the file whole and move it into place, through a link if the
    settings file is one."""
    real = Path(os.path.realpath(path))
    temporary = real.with_name(real.name + ".facilitator-tmp")
    try:
        temporary.write_bytes(text.encode("utf-8"))
        if real.exists():
            shutil.copymode(real, temporary)
        os.replace(temporary, real)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise


def statusline_record():
    """The saved record; None when there is none; ValueError when it is not
    one this checkout wrote."""
    if STATUSLINE_RECORD.is_symlink():
        raise ValueError("link")
    if not STATUSLINE_RECORD.exists():
        return None
    record = json.loads(STATUSLINE_RECORD.read_text())
    if (not isinstance(record, dict) or record.get("version") != 1
            or not isinstance(record.get("settings"), str)
            or not Path(record["settings"]).is_absolute()
            or record.get("script") != str(STATUSLINE)
            or not isinstance(record.get("created"), bool)
            or not isinstance(record.get("entry"), dict)
            or not (record.get("original") is None
                    or (isinstance(record["original"], str) and isinstance(json.loads(record["original"]), str)))):
        raise ValueError("invalid status line record")
    return record


def statusline_uninstall():
    """Take out the entry install added, or give a wrapped command back, and
    only while the entry is still exactly what install wrote."""
    try:
        record = statusline_record()
    except (OSError, ValueError):
        skipped(f"Kept {STATUSLINE_RECORD}: it is not a record this installer wrote.")
        return
    if record is None:
        return
    settings = Path(record["settings"])
    try:
        text = read_settings(settings)
        whole, command = (None, None) if text is None else statusline_spans(text)
        current = None if whole is None else json.loads(text[whole[0]:whole[1]])
    except (OSError, ValueError):
        skipped(f"Kept the status line in {settings}: it could not be read as JSON.")
        return
    if current != record["entry"]:
        STATUSLINE_RECORD.unlink()
        if current is not None:
            skipped(f"Kept the status line in {settings}, which has changed since install.")
        return
    try:
        if record["original"] is not None:
            write_settings(settings, text[:command[0]] + record["original"] + text[command[1]:])
            ok(f"Restored your status line in {settings}.")
        else:
            updated = remove_member(text, "statusLine")
            if record["created"] and json.loads(updated) == {}:
                settings.unlink()
                ok(f"Removed {settings}, which setup made.")
            else:
                write_settings(settings, updated)
                ok(f"Removed the Claude limits status line from {settings}.")
    except OSError as error:
        skipped(f"Kept the status line in {settings}: could not write it ({error.strerror or 'error'}).")
        return
    STATUSLINE_RECORD.unlink()


if __name__ == "__main__":
    operations = {"preflight": preflight, "install": install, "uninstall": uninstall}
    words = sys.argv[1:]
    QUIET = words[1:] == ["--quiet"] and words[0] == "install"
    if QUIET:
        words = words[:1]
    if len(words) != 1 or words[0] not in operations:
        raise SystemExit("usage: shell_integration.py preflight|install [--quiet]|uninstall")
    operations[words[0]]()
