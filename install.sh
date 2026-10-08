#!/usr/bin/env bash
# Install this checkout and expose the facilitator command.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

CLAUDE_URL='https://code.claude.com/docs/en/overview'
CODEX_URL='https://developers.openai.com/codex/cli'
CHROME_URL='https://www.google.com/chrome/'
TAILSCALE_URL='https://tailscale.com/download'
# uv's own installer, locked to one release and run only when what comes back
# has exactly this fingerprint; keep both in step with UV_PIN and
# UV_INSTALL_SHA256 in facilitator.
UV_PIN='0.12.22'
UV_INSTALL_URL="https://astral.sh/uv/$UV_PIN/install.sh"
UV_INSTALL_SHA256='58488ae8dbd0773134c92c85e901430e33f99d975bd7f929d26aa9ab0c2f9390'
MIN_PYTHON='3.9'      # runs the setup and the command; keep in step with MIN_PYTHON in facilitator
MANAGED_PYTHON='3.14' # the Python .venv is built on; keep in step with APP_PYTHON in facilitator
UV_MIN='0.9.0'        # the first uv that installs Python 3.14.0; keep in step with UV_MIN in facilitator

DEV_FLAG=''
if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
  printf 'usage: ./install.sh [--dev]\n\n'
  printf 'Check for Claude Code or Codex and Chrome, set up a private Python\n'
  printf 'environment for this checkout, offer the phone client (Tailscale and\n'
  printf 'an app password), and register the command and shared agent skill.\n'
  printf -- '--dev also installs the packages only the tests need, locked to the\n'
  printf 'versions in tests/package-lock.json; it needs node and npm.\n'
  exit 0
elif [ "$#" -eq 1 ] && [ "$1" = "--dev" ]; then
  DEV_FLAG=1
elif [ "$#" -gt 0 ]; then
  printf '\n⚠ Unknown option or argument: %s.\n  usage: ./install.sh [--dev]\n' "$*" >&2
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

# stop_plain <headline> [line ...]: like stop, but each line is flush left and
# an empty one is a blank line, which splits the lines into groups.
stop_plain() {
  local headline="$1" line
  shift
  if [ "$FRESH" -eq 0 ]; then printf '\n' >&2; fi
  printf '⚠ %s\n' "$headline" >&2
  for line in "$@"; do
    printf '%s\n' "$line" >&2
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
# Ctrl+C stops the run the same way wherever it lands: a new line, one
# sentence, status 130. The steps facilitator runs exit quietly on it, so this
# is the only place the sentence is printed.
trap 'restore_tty; printf "\nExiting facilitator installer.\n"; exit 130' INT

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

# python3 on PATH that is new enough to run the setup, which the Python Apple
# ships is. The board itself and its app password run on the Python
# $MANAGED_PYTHON in .venv, which uv provides. The stub macOS keeps in
# /usr/bin opens a dialog asking to install developer tools when it is run
# without them, so it is not run in that case.
usable_python3() {
  local found
  found="$(command -v python3)" || return 1
  if [ "$found" = /usr/bin/python3 ] && [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
    return 1
  fi
  "$found" -c "import sys; sys.exit(0 if sys.version_info >= (${MIN_PYTHON/./, }) else 1)" >/dev/null 2>&1
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

# sha256_of <file>: the file's SHA-256 as lowercase hex, from shasum (macOS)
# or sha256sum; fails when neither is here.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    return 1
  fi
}

# Install uv, with Homebrew when it is there and otherwise with uv's own
# installer for exactly UV_PIN, told not to touch any shell profile. That
# installer runs only when the file that came back has UV_INSTALL_SHA256. It
# checks what it downloads against the fingerprints it carries only when a
# sha256sum command exists, and macOS has shasum instead, so one is put first
# on PATH for it.
install_uv() {
  local dir file got out status=0
  if command -v brew >/dev/null 2>&1; then
    say 'uv is not installed. Installing it with Homebrew.'
    brew install uv || stop 'Homebrew could not install uv.' 'Install uv yourself, then run ./install.sh again.'
  else
    command -v curl >/dev/null 2>&1 || stop 'curl is needed to fetch the uv installer.' 'Install uv yourself, then run ./install.sh again.'
    if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
      stop 'Cannot check what the uv installer downloads: neither sha256sum nor shasum is here.' 'Nothing was run. Install uv yourself, then run ./install.sh again.'
    fi
    say 'uv is not installed. Installing it with the astral.sh installer'
    say 'into your home.'
    dir="$(mktemp -d)" || stop 'Could not make a folder for the uv installer.' 'Install uv yourself, then run ./install.sh again.'
    file="$dir/install.sh"
    if ! curl --proto '=https' --tlsv1.2 -LsSf "$UV_INSTALL_URL" -o "$file" || [ ! -s "$file" ]; then
      rm -rf "$dir"
      stop 'Could not download the uv installer.' 'Install uv yourself, then run ./install.sh again.'
    fi
    got="$(sha256_of "$file")" || got=''
    if [ "$got" != "$UV_INSTALL_SHA256" ]; then
      rm -rf "$dir"
      stop 'The uv installer from astral.sh is not the one this checkout expects.' 'Nothing was run. Install uv yourself, then run ./install.sh again.'
    fi
    mkdir "$dir/bin"
    if ! command -v sha256sum >/dev/null 2>&1; then
      printf '#!/bin/sh\nexec %q -a 256 "$@"\n' "$(command -v shasum)" > "$dir/bin/sha256sum"
      chmod +x "$dir/bin/sha256sum"
    fi
    # its own progress lines are held back and shown only if it fails
    out="$(PATH="$dir/bin:$PATH" INSTALLER_NO_MODIFY_PATH=1 sh "$file" 2>&1)" || status=$?
    rm -rf "$dir"
    if [ "$status" -ne 0 ]; then
      printf '%s\n' "$out" >&2
      stop 'The uv installer did not finish.' 'Install uv yourself, then run ./install.sh again.'
    fi
  fi
}

# uv_new_enough <uv>: whether that uv is UV_MIN or newer, which it has to be to
# install Python $MANAGED_PYTHON. UV_VERSION ends up naming what it said.
uv_new_enough() {
  local have want i
  read -r _ UV_VERSION _ <<< "$("$1" --version 2>/dev/null)" || UV_VERSION=''
  IFS=. read -r -a have <<< "$UV_VERSION"
  IFS=. read -r -a want <<< "$UV_MIN"
  for i in 0 1 2; do
    have[i]="${have[i]:-}"
    have[i]="${have[i]%%[!0-9]*}"
    [ -n "${have[i]}" ] || return 1
    if (( 10#${have[i]} > 10#${want[i]} )); then return 0; fi
    if (( 10#${have[i]} < 10#${want[i]} )); then return 1; fi
  done
  return 0
}

# No python3 that is new enough: get uv, then a Python of uv's own. PY ends up
# naming it. Nothing goes into the user's Python.
bootstrap_python() {
  local uv out found=1
  say "No Python this setup can use was found (it needs $MIN_PYTHON or newer)."
  say 'uv will provide one for the private environment.'
  if ! uv="$(find_uv)"; then
    found=0
    install_uv
    uv="$(find_uv)" || stop 'uv is installed but still not found.' 'Open a new shell so it is on PATH, then run ./install.sh again.'
  fi
  if ! uv_new_enough "$uv"; then
    local which="uv $UV_VERSION"
    [ -n "$UV_VERSION" ] || which="The uv at $uv, whose version could not be read,"
    stop "$which is too old to install Python $MANAGED_PYTHON: upgrade it to $UV_MIN or newer (brew upgrade uv, or uv self update), then run ./install.sh again."
  fi
  if [ "$found" -eq 0 ]; then ok 'uv installed.'; fi
  say "Installing Python $MANAGED_PYTHON with uv."
  # uv's own progress lines are held back and shown only if it fails
  if ! out="$("$uv" python install --no-bin "$MANAGED_PYTHON" 2>&1)"; then
    printf '%s\n' "$out" >&2
    stop 'uv could not install Python.' 'See the output above, then run ./install.sh again.'
  fi
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
  stop_plain 'Neither Claude Code nor Codex was found.' \
    '' \
    'Facilitator needs at least one of them. Install one:' \
    "Claude Code: $CLAUDE_URL" \
    "Codex: $CODEX_URL" \
    '' \
    'Then run ./install.sh again. Nothing was changed.'
fi

section '2. Chrome'
if chrome_known; then
  ok 'Chrome found.'
else
  stop_plain 'Chrome was not found.' \
    '' \
    'Facilitator is meant to run as its own Chrome app window, not in a' \
    'browser tab. Install Chrome:' \
    "$CHROME_URL" \
    '' \
    'Then run ./install.sh again. Nothing was changed.'
fi

PY=''
if usable_python3; then
  PY=python3
  preflight
fi

section '3. Python'
say 'Setup installs what Facilitator needs when it is missing.'
printf '\n'
FRESH=1
if [ -z "$PY" ]; then
  bootstrap_python
  preflight
fi
FACILITATOR_INTERNAL_INSTALL=1 "$PY" "$REPO/facilitator" _install ${DEV_FLAG:+--dev}

section '4. Mobile app'
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
printf '%s2.%s Complete the quick onboarding to start using the Facilitator!\n\n' "$BOLD" "$RESET"
