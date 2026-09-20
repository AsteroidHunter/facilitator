#!/usr/bin/env bash
# Install this checkout and expose the facilitator command.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

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
step() { printf '\n%s\n%s\n' "$1" '────────────────────────────────────────'; }

banner
step '1. Check the command location'
python3 "$REPO/shell_integration.py" preflight
step '2. Set up the board and dependencies'
FACILITATOR_INTERNAL_INSTALL=1 python3 "$REPO/facilitator" _install
step '3. Add the facilitator command'
python3 "$REPO/shell_integration.py" install
printf '\nInstalled. Run: facilitator run\n'
