"""Own the command link and exact shell blocks installed by ./install.sh."""
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


def install():
    preflight()
    BIN.parent.mkdir(parents=True, exist_ok=True)
    if not owned_link():
        BIN.symlink_to(CLI)
        print(f"command: linked {BIN}")
    else:
        print("command: already linked")
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
    recorded = recorded_profiles()
    if owned_link():
        BIN.unlink()
        print(f"removed command link {BIN}")
    elif BIN.exists() or BIN.is_symlink():
        print(f"kept changed command {BIN}")
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


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("preflight", "install", "uninstall"):
        raise SystemExit("usage: shell_integration.py preflight|install|uninstall")
    globals()[sys.argv[1]]()
