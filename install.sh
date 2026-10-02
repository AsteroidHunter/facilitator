#!/usr/bin/env bash
# Install this checkout and expose the facilitator command.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

CLAUDE_URL='https://code.claude.com/docs/en/overview'
CODEX_URL='https://developers.openai.com/codex/cli'
CHROME_URL='https://www.google.com/chrome/'
TAILSCALE_URL='https://tailscale.com/download'
UV_INSTALL_URL='https://astral.sh/uv/install.sh'
MIN_PYTHON='3.9'      # runs the setup and the command; keep in step with MIN_PYTHON in facilitator
MANAGED_PYTHON='3.14' # the Python .venv is built on; keep in step with APP_PYTHON in facilitator

if [ "$#" -gt 0 ]; then
  if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
    printf 'usage: ./install.sh\n\n'
    printf 'Check for Claude Code or Codex and Chrome, set up a private Python\n'
    printf 'environment for this checkout, offer the phone client (Tailscale and\n'
    printf 'an app password), and register the command and shared agent skill.\n'
    exit 0
  fi
  printf '\n⚠ Unknown option or argument: %s.\n  usage: ./install.sh\n' "$*" >&2
  exit 2
fi

# Colour only when stdout is a terminal, so pipes and logs stay plain.
if [ -t 1 ]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  GREEN=$'\033[38;2;0;114;0m'
  RESET=$'\033[0m'
else
  BOLD='' DIM='' GREEN='' RESET=''
fi

BANNER_ROWS=(
  '##### ##### ##### ##### #     ##### ##### ##### ##### ##### #### '
  '#     #   # #       #   #       #     #   #   #   #   #   # #   #'
  '####  ##### #       #   #       #     #   #####   #   #   # #### '
  '#     #   # #       #   #       #     #   #   #   #   #   # #  # '
  '#     #   # ##### ##### ##### #####   #   #   #   #   ##### #   #'
)

# The banner is drawn here rather than by python3, which may not be there yet.
banner() {
  local row out ch i last r g b
  for row in "${BANNER_ROWS[@]}"; do
    out=''
    last=$(( ${#row} - 1 ))
    for (( i = 0; i <= last; i++ )); do
      ch="${row:i:1}"
      if [ "$ch" != '#' ]; then
        out="${out} "
      elif [ -n "$RESET" ]; then
        r=$(( 190 + 55 * i / last ))
        g=$(( 55 + 91 * i / last ))
        b=$(( 30 + 45 * i / last ))
        out="${out}"$'\033[38;2;'"${r};${g};${b}m█"
      else
        out="${out}█"
      fi
    done
    printf '%s%s\n' "$out" "$RESET"
  done
  printf '%*s%s\n' $(( ${#BANNER_ROWS[0]} - 9 )) '' 'installer'
}

# True right after a section title: its blank line is already printed, so a
# stop message does not add a second one.
FRESH=0
section() {
  local title="$1" underline="" i=0
  printf '\n%s%s%s\n' "$BOLD" "$title" "$RESET"
  while [ "$i" -lt "${#title}" ]; do
    underline="${underline}─"
    i=$((i+1))
  done
  printf '%s\n\n' "$underline"
  FRESH=1
}
ok() { FRESH=0; printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
skipped() { FRESH=0; printf '%s⊘%s %s\n' "$DIM" "$RESET" "$1"; }
say() { FRESH=0; printf '%s\n' "$1"; }

# stop <headline> [next step ...]: the problem, then each next step indented.
stop() {
  local headline="$1" line
  shift
  if [ "$FRESH" -eq 0 ]; then printf '\n' >&2; fi
  printf '⚠ %s\n' "$headline" >&2
  for line in "$@"; do
    printf '  %s\n' "$line" >&2
  done
  exit 1
}

# Single-key questions. A key that is not an answer is ignored. The terminal
# is put back whatever ends the run.
TTY_STATE=''
restore_tty() {
  if [ -n "$TTY_STATE" ]; then
    stty "$TTY_STATE" 2>/dev/null || true
    TTY_STATE=''
  fi
}
trap restore_tty EXIT
trap 'restore_tty; printf "\n"; exit 130' INT

# ask_key <valid keys> <prompt>: the key goes in REPLY. Fails when the input
# ends before a key arrives.
ask_key() {
  local valid="$1" key
  TTY_STATE="$(stty -g 2>/dev/null)" || TTY_STATE=''
  printf '%s' "$2"
  while true; do
    if ! IFS= read -rsn1 key; then
      restore_tty
      printf '\n'
      return 1
    fi
    key="$(printf '%s' "$key" | tr 'A-Z' 'a-z')"
    if [ -n "$key" ] && [[ "$valid" == *"$key"* ]]; then
      restore_tty
      printf '%s\n' "$key"
      REPLY="$key"
      return 0
    fi
  done
}

# press_any_key <prompt>: waits for one key, whichever it is.
press_any_key() {
  local key
  TTY_STATE="$(stty -g 2>/dev/null)" || TTY_STATE=''
  printf '%s' "$1"
  if ! IFS= read -rsn1 key; then
    restore_tty
    printf '\n'
    return 1
  fi
  restore_tty
  printf '\n'
}

# Chrome is looked up by asking macOS, never by reading the Applications
# folder. Spotlight answers first; Launch Services answers when Spotlight does
# not know, and only a Chrome that Spotlight missed can make it reveal itself
# in Finder.
chrome_known() {
  local found
  found="$(mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" 2>/dev/null)" || found=''
  if [ -n "$found" ]; then
    return 0
  fi
  open -Ra 'Google Chrome' >/dev/null 2>&1
}

# python3 on PATH that is new enough and has scrypt, which the app password is
# hashed with and the Python that Apple ships lacks. The stub macOS keeps in
# /usr/bin opens a dialog asking to install developer tools when it is run
# without them, so it is not run in that case.
usable_python3() {
  local found
  found="$(command -v python3)" || return 1
  if [ "$found" = /usr/bin/python3 ] && [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
    return 1
  fi
  "$found" -c "import hashlib, sys; sys.exit(0 if sys.version_info >= (${MIN_PYTHON/./, }) and hasattr(hashlib, 'scrypt') else 1)" >/dev/null 2>&1
}

find_uv() {
  local candidate
  if command -v uv >/dev/null 2>&1; then
    command -v uv
    return 0
  fi
  for candidate in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Install uv, with Homebrew when it is there and otherwise with uv's own
# installer, told not to touch any shell profile.
install_uv() {
  local script
  if command -v brew >/dev/null 2>&1; then
    say 'uv is not installed. Installing it with Homebrew.'
    brew install uv || stop 'Homebrew could not install uv.' 'Install uv yourself, then run ./install.sh again.'
  else
    command -v curl >/dev/null 2>&1 || stop 'curl is needed to fetch the uv installer.' 'Install uv yourself, then run ./install.sh again.'
    say 'uv is not installed. Installing it with the astral.sh installer'
    say 'into your home.'
    script="$(curl -LsSf "$UV_INSTALL_URL")" || script=''
    [ -n "$script" ] || stop 'Could not download the uv installer.' 'Install uv yourself, then run ./install.sh again.'
    printf '%s\n' "$script" | INSTALLER_NO_MODIFY_PATH=1 sh || stop 'The uv installer did not finish.' 'Install uv yourself, then run ./install.sh again.'
  fi
}

# No python3 that is new enough: get uv, then a Python of uv's own. PY ends up
# naming it. Nothing goes into the user's Python.
bootstrap_python() {
  local uv
  say "No Python this setup can use was found (it needs $MIN_PYTHON or newer, with scrypt)."
  say 'uv will provide one for the private environment.'
  if ! uv="$(find_uv)"; then
    install_uv
    uv="$(find_uv)" || stop 'uv is installed but still not found.' 'Open a new shell so it is on PATH, then run ./install.sh again.'
    ok 'uv installed.'
  fi
  say "Installing Python $MANAGED_PYTHON with uv."
  "$uv" python install --no-bin "$MANAGED_PYTHON" || stop 'uv could not install Python.' 'See the output above, then run ./install.sh again.'
  PY="$("$uv" python find --managed-python "$MANAGED_PYTHON")" || PY=''
  [ -n "$PY" ] && [ -x "$PY" ] || stop 'uv installed Python but it was not found.' 'See the output above, then run ./install.sh again.'
  ok "Python $MANAGED_PYTHON installed."
}

# Fails, and says so, before anything is changed, when the command or a skill
# location is already taken by something else.
preflight() {
  local out
  if ! out="$("$PY" "$REPO/shell_integration.py" preflight 2>&1)"; then
    printf '\n%s\n' "$out" >&2
    exit 1
  fi
}

phone_client() {
  local later=0
  say 'The phone client puts your board on your phone, over Tailscale and'
  say 'behind an app password.'
  printf '\n'
  ask_key yn 'Would you like to use the phone client? (y / n) ' || return 1
  [ "$REPLY" = y ] || return 0

  section '4.1 Tailscale'
  say 'Tailscale connects your phone to the board on your Mac privately,'
  say 'without opening it to the internet. It is free.'
  printf '\n'
  ask_key yn 'Is Tailscale installed on both your devices? (y / n) ' || return 1
  if [ "$REPLY" = n ]; then
    printf '\nWould you like to install it now or later?\n\n'
    printf '  y - yes, I would like to install it now\n'
    printf '  n - no, I will install it later\n\n'
    ask_key yn 'answer: ' || return 1
    if [ "$REPLY" = y ]; then
      printf '\nGet Tailscale for your Mac and your phone: %s\n' "$TAILSCALE_URL"
      printf 'On your phone, the App Store is the easiest place to get it.\n\n'
      press_any_key 'Once installed, press any key.' || return 1
    else
      later=1
      printf '\nThe phone client needs Tailscale on your Mac and your phone, with\n'
      printf 'HTTPS certificates switched on for your Tailscale account.\n'
    fi
  fi
  if [ "$later" -eq 0 ]; then
    printf '\nAre HTTPS certificates switched on for your Tailscale account?\n\n'
    printf '  y - yes!\n'
    printf '  n - no / I do not know\n\n'
    ask_key yn 'answer: ' || return 1
    if [ "$REPLY" = n ]; then
      printf '\nTurning on HTTPS certificates is a one time step and quite simple:\n\n'
      printf 'Tailscale -> Network -> DNS -> Enable MagicDNS and allow HTTPS Certificates\n'
    fi
  fi

  section '4.2 App password'
  FACILITATOR_INTERNAL_INSTALL=1 "$PY" "$REPO/facilitator" _password-setup || exit 1
}

banner

section '1. Claude Code or Codex'
agent_found=0
if command -v claude >/dev/null 2>&1; then
  ok 'Claude Code found.'
  agent_found=1
fi
if command -v codex >/dev/null 2>&1; then
  ok 'Codex found.'
  agent_found=1
fi
if [ "$agent_found" -eq 0 ]; then
  stop 'Neither Claude Code nor Codex was found.' \
    'Facilitator needs at least one of them. Install one:' \
    "  Claude Code: $CLAUDE_URL" \
    "  Codex: $CODEX_URL" \
    'Then run ./install.sh again. Nothing was changed.'
fi

section '2. Chrome'
if chrome_known; then
  ok 'Chrome found.'
else
  stop 'Chrome was not found.' \
    'Facilitator is meant to run as its own Chrome app window, not in a' \
    'browser tab. Install Chrome:' \
    "  $CHROME_URL" \
    'Then run ./install.sh again. Nothing was changed.'
fi

PY=''
if usable_python3; then
  PY=python3
  preflight
fi

section '3. Python'
say 'Setup builds a private Python environment in .venv with uv, installs'
say 'the pinned packages, and writes run.config.json and seed.json from'
say 'their examples when they are missing. Your own Python is not changed.'
say 'When node is here it also installs the packages the tests need.'
printf '\n'
FRESH=1
if [ -z "$PY" ]; then
  bootstrap_python
  preflight
fi
FACILITATOR_INTERNAL_INSTALL=1 "$PY" "$REPO/facilitator" _install

section '4. Phone client'
if [ ! -t 0 ]; then
  skipped 'Skipped the phone client: there is no interactive terminal.'
elif ! phone_client; then
  skipped 'Skipped the rest of the phone client: no answer was read.'
fi

printf '\n'
if out="$("$PY" "$REPO/shell_integration.py" install --quiet 2>&1)"; then
  ok 'facilitator command and agent skill installed'
  if [ -n "$out" ]; then printf '%s\n' "$out"; fi
else
  printf '%s\n' "$out" >&2
  exit 1
fi

printf '\n%s✦%s Facilitator is installed!\n\n' "$GREEN" "$RESET"
printf '%sNext steps:%s\n\n' "$BOLD" "$RESET"
printf '%s1.%s Start the board: facilitator run\n' "$BOLD" "$RESET"
printf '%s2.%s Onboard your agent, in Claude Code: /facilitator onboard\n' "$BOLD" "$RESET"
printf '   or in Codex: $facilitator onboard\n\n'
