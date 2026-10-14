# What ./install.sh and `facilitator bridge setup` share: the banner, the
# section titles, the single-key questions and the "Mobile app" step. It is
# sourced, never run. The step needs PY (a Python that runs the facilitator
# command) and REPO (the folder this file is in) to be set first.

TAILSCALE_URL='https://tailscale.com/download'

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
# is the only place the sentence is printed. EXIT_NAME is what it names.
EXIT_NAME="${EXIT_NAME:-installer}"
trap 'restore_tty; printf "\nExiting facilitator %s.\n" "$EXIT_NAME"; exit 130' INT

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

# The installer's "Mobile app" step, whole: its title, the phone client
# questions, and the one line it ends on when there is nobody to ask.
mobile_app() {
  section '4. Mobile app'
  if [ ! -t 0 ]; then
    skipped 'Skipped the phone client: there is no interactive terminal.'
  elif ! phone_client; then
    skipped 'Skipped the rest of the phone client: no answer was read.'
  fi
}

# `facilitator bridge setup`: what the installer prints at its start, then
# only the step above.
bridge_setup() {
  EXIT_NAME='bridge setup'
  banner
  mobile_app
}
