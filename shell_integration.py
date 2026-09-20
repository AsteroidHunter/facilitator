"""Own the command, shell block, and personal skill links installed by ./install.sh."""
import json
import os
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
BEGIN = b"# >>> Facilitator installer >>>"
END = b"# <<< Facilitator installer <<<"
PATH_LINE = b'export PATH="$HOME/.local/share/facilitator/bin:$PATH"'


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
            raise SystemExit("facilitator: could not determine Zsh's ZDOTDIR; no profile changed")
        marker = "__FACILITATOR_ZDOTDIR__"
        lines = [line[len(marker):] for line in check.stdout.splitlines() if line.startswith(marker)]
        if check.returncode or not lines:
            raise SystemExit("facilitator: could not determine Zsh's ZDOTDIR; no profile changed")
        zdot = Path(lines[-1]).expanduser()
        if not zdot.is_dir():
            raise SystemExit(f"facilitator: ZDOTDIR {zdot} does not exist")
        return [zdot / ".zshrc"]
    raise SystemExit("facilitator: set SHELL to bash or zsh before installation")


def recorded_profiles():
    if PROFILE_RECORD.is_symlink():
        raise SystemExit(f"facilitator: {PROFILE_RECORD} is a symlink; leaving it untouched")
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
        raise SystemExit(f"facilitator: {PROFILE_RECORD} is invalid; leaving profiles untouched")


def owned_link():
    return BIN.is_symlink() and os.readlink(BIN) == str(CLI)


def inspect_profile(rc):
    if rc.is_symlink():
        raise SystemExit(f"facilitator: {rc} is a symlink; add the Facilitator bin to PATH manually")
    content = rc.read_bytes() if rc.exists() else b""
    newline = b"\r\n" if b"\r\n" in content else b"\n"
    owned = block(newline)
    if (BEGIN in content or END in content) and owned not in content:
        raise SystemExit(f"facilitator: edited installer block in {rc}; leaving it untouched")
    return content, newline, owned


def preflight():
    if (BIN.exists() or BIN.is_symlink()) and not owned_link():
        raise SystemExit(f"facilitator: {BIN} already exists; leaving it untouched")
    for rc in set(profiles() + [Path(p) for p in recorded_profiles()]):
        inspect_profile(rc)
    skills_preflight()


def install():
    preflight()
    BIN.parent.mkdir(parents=True, exist_ok=True)
    if not owned_link():
        BIN.symlink_to(CLI)
        print(f"command: linked {BIN}")
    else:
        print("command: already linked")
    skills_install()
    local_bin = str(BIN.parent)
    if local_bin in os.environ.get("PATH", "").split(os.pathsep):
        print("PATH: Facilitator bin already available")
        return
    recorded = recorded_profiles()
    for rc in profiles():
        created = not rc.exists()
        content, newline, owned = inspect_profile(rc)
        if owned in content:
            print(f"PATH: installer block already present in {rc}")
        else:
            with rc.open("ab") as out:
                out.write((newline if content else b"") + owned)
            print(f"PATH: added installer block to {rc}; open a new terminal to use facilitator")
        recorded.setdefault(str(rc), created)
    PROFILE_RECORD.write_text(json.dumps(recorded) + "\n")


def uninstall():
    skills_uninstall()
    # Another checkout's command and profile block are not ours, even though
    # the block text is identical. Without the command link as evidence, leave
    # global shell settings alone.
    if not owned_link():
        if BIN.exists() or BIN.is_symlink():
            print(f"kept changed command {BIN}")
        print("kept PATH block: command is not owned by this checkout")
        return
    recorded = recorded_profiles()
    BIN.unlink()
    print(f"removed command link {BIN}")
    other_entries = BIN.parent.is_dir() and any(BIN.parent.iterdir())
    if other_entries:
        print(f"kept PATH block: other commands remain in {BIN.parent}")
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
                print(f"kept edited installer block in {rc}; remove it manually if desired")
                keep_record = True
            continue
        addition = (newline + owned) if newline + owned in content else owned
        rc.write_bytes(content.replace(addition, b"", 1))
        if recorded.get(str(rc)) and rc.stat().st_size == 0:
            rc.unlink()
        print(f"removed installer block from {rc}")
    if PROFILE_RECORD.exists() and not keep_record:
        PROFILE_RECORD.unlink()


def skill_destinations():
    """Personal skill locations in the two hosts, without editing their settings."""
    claude_root = os.environ.get("CLAUDE_CONFIG_DIR")
    claude = Path(claude_root).expanduser() if claude_root else HOME / ".claude"
    if not claude.is_absolute():
        raise SystemExit("facilitator: CLAUDE_CONFIG_DIR must be an absolute path")
    return (claude / "skills" / "facilitator", HOME / ".agents" / "skills" / "facilitator")


def skill_record():
    if SKILL_RECORD.is_symlink():
        raise SystemExit(f"facilitator: {SKILL_RECORD} is a symlink; leaving it untouched")
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
        raise SystemExit(f"facilitator: {SKILL_RECORD} is invalid; leaving skills untouched")


def save_skill_record(record):
    temporary = SKILL_RECORD.with_suffix(".tmp")
    if temporary.exists() or temporary.is_symlink():
        raise SystemExit(f"facilitator: {temporary} already exists; leaving it untouched")
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
        raise SystemExit(f"facilitator: skill source missing at {SKILL}")
    for link in skill_destinations():
        if (link.exists() or link.is_symlink()) and not same_skill(link):
            raise SystemExit(f"facilitator: {link} already exists; leaving existing skill untouched")


def make_skill_parents(parent, record):
    missing = []
    cursor = parent
    while not cursor.exists() and not cursor.is_symlink():
        missing.append(cursor)
        cursor = cursor.parent
    if not cursor.is_dir():
        raise SystemExit(f"facilitator: {cursor} is not a directory; leaving skills untouched")
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
            print(f"skill: {link} already points to this checkout")
            continue
        make_skill_parents(link.parent, record)
        link.symlink_to(SKILL)
        stat = link.lstat()
        record["links"][str(link)] = {"target": str(SKILL), "dev": stat.st_dev,
                                      "ino": stat.st_ino, "ctime_ns": stat.st_ctime_ns,
                                      "parent": str(link.parent.resolve())}
        save_skill_record(record)
        print(f"skill: linked {link}")


def skills_uninstall():
    record = skill_record()
    for raw, entry in record["links"].items():
        link = Path(raw)
        if (link.is_symlink() and os.readlink(link) == entry["target"]
                and str(link.parent.resolve()) == entry["parent"]
                and (link.lstat().st_dev, link.lstat().st_ino, link.lstat().st_ctime_ns)
                == (entry["dev"], entry["ino"], entry["ctime_ns"])):
            link.unlink()
            print(f"removed skill link {link}")
        elif link.exists() or link.is_symlink():
            print(f"kept changed skill {link}")
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


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("preflight", "install", "uninstall"):
        raise SystemExit("usage: shell_integration.py preflight|install|uninstall")
    globals()[sys.argv[1]]()
