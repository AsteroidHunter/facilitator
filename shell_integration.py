"""Own the small shell integration installed by ./install.sh.

Only an exact Facilitator block and a symlink to this checkout are ours.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLI = ROOT / "facilitator"
HOME = Path.home()
BIN = HOME / ".local" / "share" / "facilitator" / "bin" / "facilitator"
BEGIN = "# >>> Facilitator installer >>>\n"
END = "# <<< Facilitator installer <<<\n"
BLOCK = (BEGIN + 'export PATH="$HOME/.local/share/facilitator/bin:$PATH"\n' + END)


def profile():
    shell = Path(os.environ.get("SHELL", "")).name
    return HOME / (".bashrc" if shell == "bash" else ".zshrc")


def owned_link():
    return BIN.is_symlink() and os.readlink(BIN) == str(CLI)


def preflight():
    if (BIN.exists() or BIN.is_symlink()) and not owned_link():
        raise SystemExit(f"facilitator: {BIN} already exists; leaving it untouched")
    rc = profile()
    if rc.is_symlink():
        raise SystemExit(f"facilitator: {rc} is a symlink; add ~/.local/share/facilitator/bin to PATH manually")
    if rc.exists():
        content = rc.read_text()
        if (BEGIN in content or END in content) and BLOCK not in content:
            raise SystemExit(f"facilitator: edited installer block in {rc}; leaving it untouched")


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
    rc = profile()
    if rc.is_symlink():
        raise SystemExit(f"facilitator: {rc} is a symlink; add ~/.local/share/facilitator/bin to PATH manually")
    content = rc.read_text() if rc.exists() else ""
    if BLOCK in content:
        print(f"PATH: installer block already present in {rc}")
        return
    if BEGIN in content or END in content:
        raise SystemExit(f"facilitator: edited installer block in {rc}; leaving it untouched")
    with rc.open("a") as out:
        out.write(("\n" if content else "") + BLOCK)
    print(f"PATH: added installer block to {rc}; open a new terminal to use facilitator")


def uninstall():
    if owned_link():
        BIN.unlink()
        print(f"removed command link {BIN}")
    elif BIN.exists() or BIN.is_symlink():
        print(f"kept changed command {BIN}")
    other_entries = BIN.parent.is_dir() and any(BIN.parent.iterdir())
    for rc in (HOME / ".zshrc", HOME / ".bashrc"):
        if other_entries:
            print(f"kept PATH block: other commands remain in {BIN.parent}")
            break
        if not rc.exists() or rc.is_symlink():
            continue
        content = rc.read_text()
        if BLOCK not in content:
            if BEGIN in content or END in content:
                print(f"kept edited installer block in {rc}; remove it manually if desired")
            continue
        # Remove only the exact block. Keep every byte outside it, including
        # an adjacent user comment or changed PATH line.
        owned = ("\n" + BLOCK) if "\n" + BLOCK in content else BLOCK
        rc.write_text(content.replace(owned, "", 1))
        print(f"removed installer block from {rc}")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("preflight", "install", "uninstall"):
        raise SystemExit("usage: shell_integration.py preflight|install|uninstall")
    globals()[sys.argv[1]]()
