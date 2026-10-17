# Installing, updating and running Facilitator

## Installing

To install, run `./install.sh` in the downloaded folder. It needs Claude Code or Codex, Google Chrome (the board runs as its own Chrome window) and macOS 11 or later, and stops without changing anything if Chrome, or both Claude Code and Codex, are missing. It sets up a private Python and the board's packages, each pinned to an exact version, and never changes your own Python. It writes `run.config.json` and `seed.json` only when they are missing. It asks whether you want the phone client, and on yes checks with you that Tailscale is set up (see [The phone page and the bridge](phone.md)) and asks for a phone password. It says when Chrome's graphics acceleration is on; when it is off, it offers to turn it on with Chrome closed, or with Chrome open shows where to turn it on and never quits or waits for Chrome. Last, it adds the `facilitator` command and the agent skill and prints the next steps. It is safe to run again. Run without a terminal, it asks nothing and skips the phone client.

## Uninstalling

`facilitator uninstall` (or `./uninstall.sh`) removes only what the installer added, and keeps your cards, settings, phone sign-in data and any config you changed. It asks whether to keep card attachments: Enter keeps them, and only a clear no removes them (`--keep-attachments` or `--remove-attachments` answers ahead of time). It has no dry run.

## Updating

`facilitator update` brings the folder up to date with one command. On a folder from before `data/`, where the board kept its files at the top and its attachments and logs in a `facilitator-internal` folder beside it, the update first moves them into `data/`, once. It backs everything up into `data/backups/` first, copies each file and checks it by checksum, and removes an old copy only after the board, started again on the new code, shows every card it had. Until the move is done the board does not start, and every other command says to run `facilitator update`; running it again finishes a move that was cut off.

## Seeding a board

A new board starts with no cards, and the onboarding opens the sample project. To start a brand new board with cards of your own, put them in `data/seed.json` before its first start: a `title` for the board and an `items` list with one entry per card, such as `{"id": "1.1", "bucket": "must", "owner": "myproject", "title": "Fix the login timeout", "context": "the card's first reply"}`. `id`, `bucket` and `title` are required, and every seeded card starts in Doing; `owner` is the lane it belongs to (`facilitator` when left out), and `context` is optional. The file is read only at the very first start.

## Bringing everything up

`facilitator run` starts the board if it is not running, opens it in its own Chrome window and, once a phone password is set, turns the phone link on. It prints `Board up on http://127.0.0.1:<port>` and `Facilitator is live!`, plus one line if the phone link could not come up. A new install's window opens full screen (`"app_fullscreen": true` in `run.config.json`); if Chrome was already running it may not, and Control + Command + F fixes that. `--attach` types each lane's attach instruction into its tmux session, `--spawn` also starts agent sessions where none can be reached (see [Adding a lane](#adding-a-lane)), and `--dry-run` describes a run without doing it.

The board uses two ports: the `port` in `run.config.json` and the one above it, for the phone. If another program holds either, `facilitator run` moves the board to the next free pair, writes the new port into `run.config.json`, says so in one line and points the phone link there too. The board stays on its new port. Its settings come along, but a window open at the old address cannot reach it. The other commands read the port from `run.config.json`, so they follow a move.

`facilitator restart` restarts only the board's server, making sure it stops this board's own server and nothing else. It says `Board restarted.` (or `Board started.`), and adds `Reload the board (command + R).` when a board window is open. It leaves agents, the phone link and the port alone. When the board is running on a port the config does not name, it says so, names both ports and starts nothing, since `facilitator run` is what brings the two together. `facilitator stop` is under [Stopping the board](#stopping-the-board). `facilitator status` prints a one-line summary.

`facilitator update` brings the app up to date, so nobody has to use git by hand. It stops without changing anything when files in the app's folder have been edited, or the folder is not on a git branch linked to its online copy. Otherwise it pulls the new version (moving forward only, never merging), updates the board's private Python and packages, runs any new update steps, and restarts the board if it was running and something changed. It ends with the old and new version and a reminder to reload the board and reopen the phone app.

## Stopping the board

`facilitator stop` ends the board and closes its window, saying `Board stopped.` (or `Board was not running.`). Everything saved is kept. A board that will not stop is left alone and the command names `--force`, which ends it at once. A board tab beside other Chrome tabs stays open. With a phone password set, it also turns the phone link off. `--dry-run` shows what it would do. Do not run it while `facilitator run` or `facilitator restart` is still starting the board.

## Adding a lane

A lane is added to `run.config.json` by hand as `{"owner": "myproject", "tmux": "<tmux session>", "dir": "~/projects/myproject", "instruction": "<what to type to attach its agent>", "prompt": "<what a new agent session starts with>"}`: `owner` is required, `tmux` and `instruction` are what `facilitator run --attach` uses, `dir` and `prompt` are what `--spawn` uses, and `dir` is also the folder the board shows for that lane. A project added from the home page needs no lane entry. Nothing rewrites an existing `run.config.json`, so a board that has lanes keeps them.
