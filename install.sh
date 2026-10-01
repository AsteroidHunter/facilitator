#!/usr/bin/env bash
# Install this checkout and expose the facilitator command.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -gt 0 ]; then
  if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
    printf 'usage: ./install.sh\n\n'
    printf 'Set up this checkout, create a phone app password, and register the\n'
    printf 'command and shared agent skill.\n'
    exit 0
  fi
  printf '\n⚠ Unknown option or argument: %s.\n  usage: ./install.sh\n' "$*" >&2
  exit 2
fi

# Colour only when stdout is a terminal, so pipes and logs stay plain.
if [ -t 1 ]; then
  BOLD=$'\033[1m'
  GREEN=$'\033[38;2;0;114;0m'
  RESET=$'\033[0m'
else
  BOLD='' GREEN='' RESET=''
fi

banner() {
  python3 - <<'PY'
import sys
word = 'FACILITATOR'
glyphs = {
'F':['█████','█    ','████ ','█    ','█    '],
'A':['█████','█   █','█████','█   █','█   █'],
'C':['█████','█    ','█    ','█    ','█████'],
'I':['█████','  █  ','  █  ','  █  ','█████'],
'L':['█    ','█    ','█    ','█    ','█████'],
'T':['█████','  █  ','  █  ','  █  ','  █  '],
'O':['█████','█   █','█   █','█   █','█████'],
'R':['████ ','█   █','████ ','█  █ ','█   █']}
rows = [' '.join(glyphs[c][n] for c in word) for n in range(5)]
for row in rows:
    out = ''
    for i, ch in enumerate(row):
        t = i/max(len(row)-1, 1)
        r,g,b = int(190+55*t),int(55+91*t),int(30+45*t)
        out += f'\033[38;2;{r};{g};{b}m{ch}' if ch != ' ' and sys.stdout.isatty() else ch
    print(out + ('\033[0m' if sys.stdout.isatty() else ''))
print(' ' * (len(rows[0])-9) + 'installer')
PY
}
section() {
  local title="$1" underline="" i=0
  printf '\n%s%s%s\n' "$BOLD" "$title" "$RESET"
  while [ "$i" -lt "${#title}" ]; do
    underline="${underline}─"
    i=$((i+1))
  done
  printf '%s\n\n' "$underline"
}
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }

banner

section '1. Locations'
printf 'Setup adds a facilitator command, links the agent skill and adds\n'
printf 'one block to your shell profile. This step only checks that none of\n'
printf 'them is blocked by something already there. It changes nothing.\n\n'
python3 "$REPO/shell_integration.py" preflight
ok 'Nothing is in the way.'

section '2. Board'
printf 'Setup builds a private Python environment in .venv with uv, installs\n'
printf 'the pinned packages, and writes run.config.json and seed.json from\n'
printf 'their examples when they are missing. When node is here it also\n'
printf 'installs the packages the tests need.\n\n'
FACILITATOR_INTERNAL_INSTALL=1 python3 "$REPO/facilitator" _install

section '3. App password'
FACILITATOR_INTERNAL_INSTALL=1 python3 "$REPO/facilitator" _password-setup

section '4. Command and skill'
printf 'The facilitator command goes in a private folder under your home,\n'
printf 'the agent skill is linked for Claude Code and Codex, and one block\n'
printf 'in your shell profile puts the command on your PATH.\n\n'
python3 "$REPO/shell_integration.py" install

section '5. Claude limits'
printf 'The home page can show your Claude plan limits. Claude Code sends\n'
printf 'them to claude-statusline.py after each reply. Saying yes adds that\n'
printf 'script as the status line in your Claude Code settings, around any\n'
printf 'status line you already have, which shows as before.\n\n'
python3 "$REPO/shell_integration.py" statusline

printf '\n%s✦%s Facilitator is installed!\n\n' "$GREEN" "$RESET"
printf '%sNext steps:%s\n\n' "$BOLD" "$RESET"
printf '%s1.%s Start the board: facilitator run\n' "$BOLD" "$RESET"
printf '%s2.%s Onboard your agent, in Claude Code: /facilitator onboard\n' "$BOLD" "$RESET"
printf '   or in Codex: $facilitator onboard\n\n'
