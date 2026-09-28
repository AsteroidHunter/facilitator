# RUNBOOK: operating the facilitator board

For an agent sitting behind the board. Read this cold and start; nothing else is assumed.

The tool: `server.py` (Python, port 8877) serves `index.html` (vanilla JS) at http://127.0.0.1:8877. Its pinned packages go in the standard `.venv` beside it. For a new checkout run `./install.sh`: it checks Python, finds or installs uv, builds the `.venv` and syncs the pinned packages, writes `run.config.json` and `seed.json` from the examples when they are missing, installs the test dependencies when node is present, prompts for a phone app password in an interactive terminal, and registers the shared agent skill. A noninteractive install finishes without a password; run `facilitator password set` before enabling the bridge. It is safe to run again, and after requirements change it syncs the `.venv` on its own. `facilitator uninstall` (or `./uninstall.sh`) removes only setup artifacts recorded as installer-owned, including its agent-skill links; it preserves preexisting or edited config and keeps board data and bridge credentials unless `--wipe` is given. Right after its banner it asks whether to keep the card attachments (`../facilitator-internal/uploads/` and the older in-repo `uploads/`), with or without `--wipe`; Enter, an unclear answer or a run with no terminal keeps them, only a clear no removes those two folders (a link is kept, never followed), and `--keep-attachments` or `--remove-attachments` answers without asking. Uninstall has no dry run. Artifacts from the former `facilitator install` have no ownership record, so uninstall keeps those legacy files for manual inspection. `facilitator run` starts the server with that `.venv`. Stacked discussion boxes, one per point, each a mini-thread between the owner and one agent. Messages queue FIFO into the agent's terminal session; every message and reply persists (`state.json`, `transcript.jsonl`, both written beside the server, both gitignored). The endpoint reference is the module docstring in `server.py`; keep it truthful as endpoints change.

## The loop

From the agent conversation that owns your lane, repeat the current two-call production protocol. The installed `facilitator` skill resolves the lane and its `scripts/onboard.py wait` helper makes both calls for each claim:

    curl --max-time 60 -sS "http://127.0.0.1:8877/wait?owner=facilitator&timeout=50&agent=claude"
    curl -sS -X POST "http://127.0.0.1:8877/ack?owner=facilitator&token=<the ack field>"

`agent=` states your name; the board's card rows show each lane's live agent name, or offline, from exactly this. It returns `{"box": id, "title": ..., "messages": [...], "queued_after": n, "ack": token}` on a claim, `{"idle": true}` on timeout, `{"paused": true}` while paused, `{"end": true}` once ended and drained.

The `ack` token is the receipt for the card you were just handed, and confirming it is part of claiming, not an extra. A hand-off is provisional until you confirm it, because the answer can die on the wire: your own kill timer fires, the connection drops, and the server thinks it delivered a card nobody ever saw. Confirm it the moment the claim lands, before you start reading or working. A card nobody confirms goes back to the front of its lane's queue after 90 seconds and its colour falls back to the queued grey, so nothing sits green with nobody on it. Confirming twice is fine; the second call answers the same `{"ok": true}`.

WARNING: a loop without the confirm line claims cards it cannot keep. Every claim bounces back to the queue 90 seconds later and gets handed out again, forever, and your reply lands on a card you no longer hold.

After reading the separate `/fresh` result as described below, answer with a complete reply:

    curl -sS -X POST --data-binary @reply.txt "http://127.0.0.1:8877/reply?box=ID"

`ctx=` is optional compatibility data. A supplied context is stored and must be at most 50 words. The server accepts a reply without one.

- `/wait?owner=...` claims the oldest queued box in your owner lane and marks it busy. Never leave a claim unanswered; an open claim blocks your whole lane (each owner has its own busy slot, see Owner routing below).
- Immediately before **every** `/reply`, including an interim or worker-completion reply, call `GET /fresh?owner=YOURLANE` and read its result before composing and sending. If it returns messages for the card you are answering, include them; those messages are folded into the held claim. If it names a different held card, handle that claim first and do not use its messages in a reply on another card. With no held card, `/fresh` returns an empty message list and hands over nothing; queued messages on other cards remain for their own claims. Do not combine a `/fresh` call with a prewritten reply in one command.
- Three nets sit under a claim, in order: a hand-off written into a dead socket rolls back at once, an unconfirmed claim returns after 90 seconds, and a claim older than 15 minutes is stolen back. Do not lean on any of them; confirm what you claim and answer what you confirm.
- Before going idle, check whether anything is waiting on your lane: `GET /unread?owner=YOURLANE` answers `{"queued": N, "claimed": M}`, messages still waiting plus messages in the claim you hold. It reads only, so it is safe from a hook. Paste this as a Stop hook command and go back to the loop instead of idling whenever `queued` is above zero:

      curl -s "http://127.0.0.1:8877/unread?owner=facilitator"

- `{"paused": true}` means the owner hit the pause button (laptop-close mode). Stop polling `/wait`; idle locally and re-check about once a minute (`curl -s http://127.0.0.1:8877/state`, read `paused`) until it goes false, then resume the loop. Messages still queue while paused; finish any open claim before going quiet.

## Replies

- 100 to 150 words or fewer. Plain conversational tone: no coined shorthand, no unexplained jargon; a term either gets defined by what it concretely does or gets dropped. Paragraph breaks and short lists over walls of text. Depth comes from choosing what to say, not from length.
- No em dashes, in titles or in replies. Banned.
- Every reply fully self-contained. The box shows ONLY the latest reply, so a short follow-up ERASES a longer answer. Restate rather than reference.
- A small-card version, when needed, is a separate urlencoded `short` query on `/reply`. If it is omitted, both cards show the full body. Never put `---` in the body as a hidden separator. It is authored Markdown and renders as a horizontal rule.
- Answer what was asked and stop: no unsolicited offers, no "want me to" tails, no validation preambles.
- `POST /note?box=ID` consumes and releases a held claim. Do not use it for progress on a claim: later owner messages can be hidden until a full reply. For work that continues, register `/working`, keep its heartbeat current, and send a full `/reply` with the flag still live. That reply remains deferred until the work truly ends and the flag drops. The removed `quiet` query is rejected.
- The colour law is the machine's now, not your discipline: every card sits in one server-side state and the colour is a pure read of it. A normal reply under a live working flag lands the card in deferred, still green; the turn is handed over when the flag drops (`/working?box=ID&v=0`) or its heartbeat expires. A progress note stays in note until another event or the heartbeat ends.
- `POST /testing?box=ID&v=1` raises the ready-to-test marker: use it only once a delivered change is actually available for the reader to try, not because a merge is planned or a reply reads as finished. It is refused unless the card is awaiting the reader (a completed reply waits and no job runs), so it never marks active, queued or done work. `v=0` lowers it by hand; the reader answering the card, and close/done, lower it on their own. It only sets the flag: no reply, no claim, no move.
- A reply that closes or parks a box carries zero new information. Folded boxes go unread. Keep-in-mind notes go to an open box or the project docs.

## Titles

A user-created box is auto-named with the chopped first line of its first message, which reads badly. When you claim such a box (title ends in "…" or just parrots the message), set a brief accurate title as part of answering it: `POST /title?box=ID`, raw text body. Keep titles short enough to sit on one line.

## Status changes

- Only the owner closes. The agent flags duplicates and proposes merges; green comes from the owner's hand or their explicit word. A box was once closed by the agent mid-use and had to be reopened; do not repeat that.
- "TBDL" from the owner means: park that box to Later AND record the deferred work in the relevant project doc.

## Context strips

`POST /context?box=ID` stores optional historical context (50 words max, refused over that, never truncated). `/reply` no longer requires `ctx=`. When answering, use the current claim and `/fresh` for new messages rather than relying on an old strip.

## Permission blocks

Follow the current host's permission rules and the user's authorization in this session. A board card does not override a host restriction. If a step is blocked, complete permitted work, explain the blocked step and reason in the relevant reply, and keep the listener running when possible. Do not infer permission for pushes or destructive operations merely from these operating instructions.

## Restarts

- A restart re-queues claimed-but-unanswered messages. Expect duplicate deliveries; answer "already handled, restart re-queue".
- A dying server's final save can race a direct `state.json` edit. Always stop the server before editing state, and verify box count and ids after every restart.
- Kill by PID and POLL until the port is actually free before launching the replacement; a fixed sleep loses the bind race and leaves the OLD server serving while the new one dies with "Address already in use" (bitten twice). Confirm the new code answers (hit a new endpoint) before trusting the restart.
- The first start of a server that keeps the revision and the receipts (`rev` and `ops` in `state.json`) copies the old file beside it as `state.json.bak-<stamp>` before its first save. To go back to an older server: stop the board, rename that copy over `state.json`, start the old code. Nothing else about the file changed; an older server ignores the two new keys.
- A stop is graceful: open requests get three seconds to finish and a listener waiting on `/wait` is answered `{"idle": true}` at once, so the loop simply asks again.

## The log

Three dated files in `facilitator-internal/logs`, the sibling folder beside this repo, so nothing here is ever committed:

- `server-YYYYMMDD.log`: what the board did. Start and stop with the reason it stopped, every refusal it sent, every push outcome with the service's own words, board events, unusually slow phone command/state requests, a save that failed, and every crash.
- `client-YYYYMMDD.jsonl`: what the three pages reported: a thrown error, a rejected promise, a request that failed, a card that would not draw, a timer that ran more than two seconds late, and a saved phone incident history.
- `bridge-YYYYMMDD.log`: the tailnet share going up and coming down, and what ended it.

Each file caps at 5 MB and rolls, thirty of each kind are kept and older ones are deleted, so the folder cannot pass about 150 MB whatever goes wrong. One line is one event, as JSON:

    {"ts": "2026-09-03T18:22:41.108Z", "level": "info", "kind": "refusal", "box": "m12", "route": "/reply", "code": 400, "reason": "bad box"}

Three levels and no more. INFO is what happened and is on by default; ERROR is something that failed and was not meant to; DEBUG is the noise you switch on while hunting, a line per request with its milliseconds plus claims, acks and unconfirmed hand-offs. Raise it for one run and no longer:

    FACILITATOR_LOG_LEVEL=debug .venv/bin/python3 server.py

`log_level` in `run.config.json` (`info`, `debug`, `error`) sets the standing level and that variable beats it; a level nobody has heard of falls back to `info` rather than stopping the board. `FACILITATOR_LOG_DIR` moves the whole folder, which is what the tests use so no test can write into the real one. `GET /log?lines=N` tails the day's server file.

The phone keeps a sparse 120-second lead-up to a glitch in page memory, then records up to 20 seconds of recovery before uploading one incident. Edge pulls, card selection, and vertical response scrolling retain coarse input and frame timing; ordinary successful state polls are summarized every ten seconds so they cannot crowd out gestures. Schema 4 also records bounded Enter-event, viewport, and handler decisions without draft text. Schema 5 adds where the response stood during a swipe on it, described below. A visible UI span of at least 150 ms, request of at least two seconds, failed operation/request, page problem, visible frame/timer gap, broken render invariant, or a response swipe that moved nothing may save automatically, with a 30-second automatic cooldown. The Settings marker, or Control + Shift + M, records the same bounded history and shows that it is collecting for 20 seconds; it says saved only after the server confirms the write. A save batch stays capped at 12 KB on the phone and the route refuses any body over 16 KB. The phone still makes at most four save attempts per minute, including each compatibility POST, and the server permits four incident writes per minute across all pages and reasons. Failed and offline manual saves retain their original marker in that open page for an explicit retry. A page hidden during collection can send a best-effort beacon but cannot confirm persistence; closing the page loses history that was never sent. A schema-3 receiver still accepts ordinary 120-second lead-up and 20-second recovery histories; Enter details are omitted, and a save that missed them says the server needs updating. A stale schema-4 report rejected by that receiver gets a budgeted schema-3 retry. A schema-4 receiver gets schema-5 histories with the new gesture fields and parts left out and a cancelled touch sent as `touch-end`, the same way and within the same budget; a manual save that lost them says the server needs updating. Schema-1/2 receivers use the older 40-event/60-second format.

On schema 5 a touch that begins on the selected card's response also records the response's scroll position (`top`), how far it can scroll (`range`), its visible height (`view`), which edge it is at (`edge`: `top`, `bottom`, `middle`, or `none` when it cannot scroll), whether an older reply is showing (`hist`), keyboard and focus (`kb`, `focus`), and how late the page handled the touch (`lag`). The intent adds the finger's direction (`dir`, `up` or `down`), whether it has gone 24 px (`far`), `edge` and `lag`. The first scroll event adds `wait`, the time from the touch to that scroll. The touch end adds how far the position moved (`moved`), how many scroll events arrived (`count`), how long the touch lasted (`ms`), whether the same response is still on the page and selected (`same`), and whether page script cancelled the pan (`prevented`); a touch the system cancelled ends as `touch-cancel`. A `taken` input names what took the touch instead (`by`): the drawer pull, the card swipe, a focus change, the shade over the page, the startup curtain, or a menu still sliding away. A `reply-swap` phase means a render replaced the reply's words while the finger was down or within a second after. Scroll position and heights are read only at touch start, intent and touch end, and no coordinates are ever recorded, only the direction. An intent with no `edge` began off the response, on the title or the typing row.

That same history is saved automatically as `no-scroll` when a swipe on a response that can scroll moved nothing. It is judged at touch end, or 300 ms after the intent if the finger is still down: no scroll event arrived, the position did not change, the finger went at least 24 px, and it was not pushing into the edge the response was already at. The 300 ms and 24 px are not yet checked on the phone. The save shares the 30-second cooldown and the four-per-minute cap, each card saves at most once every 120 seconds however often it stays stuck, and it only runs once the server offers schema 5. A `no-scroll` save has no schema-4 form, so a receiver rolled back under the open page leaves it held there rather than saved under another reason.

An incident's HTML build token names only the loaded phone page; its worker field names the cache version reported by the controlling worker, or `unknown`. Neither is a hash of every loaded asset. Frame callbacks show frame opportunities, not proof that pixels appeared. A late timer after a page resumes is not treated as a continuously visible freeze. Browser/OS causes still need an affected-device capture when these phase timings do not settle them.

`/send`, `/create`, and `/m/state` responses carry a numeric server-duration header for the phone history. A request on one of those routes that takes at least one second also writes one rate-limited `slowrequest` INFO line. These timings cover server handling, not the phone's network transit.

The dated file is the only stream. Started by the CLI the server's output goes nowhere else, so no event is written twice; started by hand in a terminal, INFO is mirrored there as well in a short human form, so it says what it is doing as it does it. A crash lands in the file like anything else: a request that throws, and a start that dies of something rather than being asked to stop, each write one `crash` line naming the exception's type, its own words when those words are plain enough to keep, and where it happened as `file:function:line` with no path in it. A fatal one is followed by the stop line that says which type ended the run. The one failure no file can hold is a server that dies before its logger exists, which is an import going wrong; `facilitator run` notices the child is already gone and says so in one sentence, and running `python3 server.py` by hand shows it.

Five things never appear in any line: message or title text, keys and authentication tokens, whole push endpoints (the service's host only), file paths, and email addresses. The rule is kept where the line is written, by not passing those things in: the board event line carries a message's length and never the message, and the lane-creation line carries the folder's name and never the path to it. Phone incident entries accept only fixed event/state names, bounded numbers, existing card IDs, and canonical operation receipt IDs. Anyone adding a line keeps it that way. A filter over a formatted line can be fooled; not passing the text cannot.

## Real work

Real work ships from boxes: delegate bounded builds and scans when delegation is available and authorized, and report results in the ordering box. Follow the actual session's authorization for pushes and destructive operations. After work is finished and verified, stage and commit its changes when authorized. Messages: short, imperative, technical, no co-author or AI signature lines. Commit messages and code comments never name private folder paths, machines, people, or other projects.

## App version

The displayed `0.2.N` is this project's count of meaningful updates. When a verified feature or substantive fix lands on premain, advance N once for each distinct meaningful update; do not count its merge again. Tests, documentation, behavior-preserving refactors, pure cosmetic tuning, version-label edits, and reverted or superseded experiments do not add a count.

Keep the displayed value in `index.html` at `#npversion`. The phone installation and sign-in gate derives its label from that same value, so do not add a second hardcoded version. The gate caches its HTML at server startup; a running gate picks up a changed label after the next authorized restart.

## Delegation

The listener normally delegates substantive bounded work and stays responsible for the card, unless the owner asks it to do the work directly or the current host does not authorize delegation. Sort by the shape of the job before starting; a misjudged job need not be handed off halfway through.

Every worker brief carries six parts: the goal as one checkable sentence; full context, since the worker starts knowing nothing; boundaries, what it must not touch and which neighboring work is someone else's; the output contract, the exact shape coming back; proof, the worker verifies its own work (driven browser or equivalent) before reporting; and the house rules (plain words, no em dashes, no signatures, never restart the server, delete any probe box after use). Quality test: a stranger with no history could do the job right from the brief alone.

Any work belonging to a card carries that card's green flag for exactly as long as it is happening: worker runs, but also verifying a worker's result, post-build checks, and committing that card's code after the claim is released. `POST /working?box=ID&v=1` before starting, `v=0` the moment the card's work truly ends. Green means exactly the machine's two green states: working (claimed right now, or that card's work happening anywhere) and deferred (the same, with a reply already waiting to become the owner's turn when the work ends).

Green is verified, not trusted: registration starts a heartbeat clock, and without `POST /ping?box=ID` at least every 75 seconds the green expires on its own, so a dead job can never leave a card stuck green. Keep a pinger beside any long job:

    ( while curl -s -o /dev/null -X POST "http://127.0.0.1:8877/ping?box=ID"; do sleep 30; done ) &

and kill it when the work ends. The server also watches the other direction: an agent alive but absent from the listening call for over a minute, holding no claim and no live job, makes the bar read "working, card not marked". Do not let that be true of you.

## Headless testing

`probe3.js` (repo root; needs `npm install puppeteer-core` and Chrome) is the page health probe: read-only apart from creating and then deleting its own probe box. Never point a message-sending script at a live board.

## Owner routing

Two agents share one board. Every box carries an owner tag: `facilitator` (discussion about this tool, served by this repo's agent) or a project lane such as `example` (the project under discussion, served by its own agent). `/wait?owner=...` claims only that owner's boxes, and each owner has its own busy slot and listener-presence tracking, so the two agents never block or steal from each other. An ownerless `/wait` defaults to facilitator. Two meta sections sit on top, tool-meta first, each with its own plus button; user-created boxes inherit the section's owner; the writing indicator and the offline banner name the agent. Every meta box carries the owner's remove cross, any standing card the seed placed included (box `0` for the tool lane, for instance); a lane with its standing box removed just works from its remaining boxes, and notes that would have gone there go to an open box or the project docs. The two loops, side by side:

    curl --max-time 60 -sS "http://127.0.0.1:8877/wait?owner=facilitator&timeout=50&agent=claude"
    curl --max-time 60 -sS "http://127.0.0.1:8877/wait?owner=example&timeout=50&agent=claude"

Each lane confirms its own claims against its own owner: `POST /ack?owner=facilitator&token=...` and `POST /ack?owner=example&token=...`. A token belongs to one lane's claim and is refused (409) anywhere else.

## Showing a picture on your lane

Magic box 3 holds one picture per lane, a plot above all. Write the file into your own project's internal folder, named `panel` with any image extension:

    <your project folder>/<your lane id>-internal/panel.png

So the `example` lane writes `~/projects/example/example-internal/panel.png`. Png, svg, jpg, gif and webp all work. The board picks it up within about four seconds, swaps itself when you rewrite the file, and falls back to its empty marks when you delete it. Nothing needs adding to the server, and no lane can read another's folder. Note that the panel is switched on for one configured tab only; every other tab still shows the plain stub.

## The file navigator

On a lane listed in `navigator_lanes`, magic box 3 (and the navigator-only box for
later lanes) is a file navigator over that lane's own two folders, its internal
folder and its wiki. It shows every file in a folder, not just Markdown:
folders, text, code, images and anything else, dotfiles included, each with a
type icon and a plain black label. (The icon set is easy to swap later.) Text files open in the built-in editor, with
the live Markdown preview for `.md` and plain text for everything else; images
preview inline with their name, size and date; anything that is not text or an
image shows that same metadata and a note that it cannot be opened here. The
listing is read one directory at a time, so a folder holding a large archive
costs nothing until it is opened. The boundaries hold exactly as before: only
the two configured folders are reachable, a path that resolves outside them is
refused, a symlink pointing out of a folder is shown but never opened or served,
and a special file is shown but never read. Editing writes text back with the
same stale-write guard and never overwrites a binary or creates a new file.

## The Spotify player

`spotify_client_id` in `run.config.json` is the client id magic box 1 signs into Spotify with; make an app at the Spotify developer dashboard (https://developer.spotify.com/dashboard) to get one, and leave the key empty until you do.

## The home page

The house at the left end of the tab bar opens the home page: a blank page above every project holding one panel, the tokens Claude Code and Codex have spent on this machine, as a year heatmap or a line of 7-day averages, switched by the pill in its corner. Any project tab goes back to that project's board. The counts come from `GET /tokens/daily`, which `tokens.py` reads out of the logs both tools already write (`~/.claude/projects`, `~/.codex/sessions` and `~/.codex/archived_sessions`, or wherever `CLAUDE_CONFIG_DIR` and `CODEX_HOME` put them). A day's total is fresh input, cache writes, cache reads and output added up, each message counted once; `tokens.py` says why. Only counts ever leave it, kept in the gitignored `tokens-cache.json` beside `state.json` so a request reads only what the logs gained, and a log the tools later clear away keeps its counts there. `token_logs` in `run.config.json` names other folders, `{"claude": "~/elsewhere", "codex": []}`, where an empty list turns a tool off. The phone page has the same home page: the house at the left end of its tab row opens it and stays there however far the tabs scroll, the panel spans the screen within the app's margins with both charts scrolling sideways as they do here, a tap on a day or on the line shows its pop-up, and any project tab goes back to that project's board. Over the bridge, `/tokens/daily` and the panel's two files need the same signed-in session as every other route.

## Seeding a board

A first-ever start (no `state.json`) reads `seed.json` beside the server: the board title plus opening boxes (see `seed.example.json` for the shape). `seed.json` is gitignored because real discussion content is private and never ships in this repo; the example holds invented content only. To start a new project's board: copy the example to `seed.json`, fill in real items, run the server.

## Bringing everything up

`facilitator run` starts the server if the port is empty and opens the chromeless app window, nothing else: it never touches tmux by default, and only reports lanes with no listener, printing the attach instruction for pasting. `--attach` types that instruction into the existing tmux sessions named in `run.config.json` (machine-local and gitignored, since lanes name real directories; see `run.config.example.json`); `--spawn` additionally creates new agent sessions where none is reachable. `facilitator restart` stops and restarts only the server: it signals the one process holding the listening socket on the configured port, with SIGTERM and never SIGKILL, after reading that process back as this folder's `server.py` twice, once when it is found and once in the moment before the signal. What is read is the kernel's own answer about it: start time, executable and argument vector, which must be exactly our `server.py` under an interpreter this board uses, so a pid that has been released and reused, or a process that has become something else, is refused rather than killed. It polls until the port is actually free before starting the replacement (an unreadable port is never treated as a free one), then waits for the new server to answer AND for the one listener to be that exact child before saying anything went well; a port taken over by something else is refused and that process is never signalled. It leaves the browser alone: a Chrome tab or chromeless app window already showing the board is kept as it is and named for reloading, a new app window is opened only when Chrome is certainly showing the board nowhere, and when Chrome cannot be asked nothing is opened and the limit is said out loud. It touches no lane, no tmux session and no bridge; `--dry-run` prints the plan and changes nothing. `facilitator status` prints a one-line board summary.

The board installs as a Chrome app once per Mac, which is what gives it its own icon in the dock. Open `http://127.0.0.1:8877` in an ordinary Chrome tab, not the chromeless window, and press `Install app` in the bar at the top of the page, then Install in the box Chrome puts up; Chrome's own install control at the right of the address bar does the same thing. The control on the page stands there only while Chrome is offering an install, so it is not there before the board qualifies, inside the installed app, or once the install is done. Chrome writes a small Mac app named for the board's manifest into `~/Applications/Chrome Apps.localized`, carrying the board's mark. `facilitator run` keeps opening the chromeless window either way; the installed app is opened from the dock or Launchpad like any other app, and moving it to the bin removes it with no other change. The install is per Chrome profile, and the phone page's own app at `/m` is a separate one that this leaves alone.

## The phone page and the bridge

`GET /m` is the board for a phone: the project tabs across the top, one card filling the screen with the app's thin margins, and the card list (doing, deferred, done) in a drawer pulled in from the left edge. The card does what the desktop card does: the full reply, the sent messages, older replies (the arrows in the card's top bar), a composer that sends, a plus that attaches a photo through `/upload`, the defer chip, the close cross, and a plus in the drawer for a new card. The house at the left end of the tabs opens the home page (see "The home page"). Nothing else is on the phone.

The phone reads the board through `GET /m/state`, naming the revision it holds, so a poll that finds nothing new costs a few hundred bytes; it refreshes every 1.2 seconds while on screen, with a backoff on failure, and shows a "reconnecting" note under the tabs when the board has not answered. When something has changed, a phone holding a reading this server run sent names it (`delta`) and gets only the cards that differ from that reading, with where new cards go and which cards went; the server remembers its last 32 readings for this, and a phone holding one it has forgotten, or one from before a restart, gets the whole board once. Every answer of 256 bytes or more is gzip compressed when the phone accepts gzip, which Safari always does. On a test board of about 700 cards, about 800 KB whole, a change now costs a kilobyte or two on the wire, and a whole board (the first open, or the first change after a restart) about a quarter of its size. A read has 8 seconds for its answer to start; after that, a download that keeps arriving is waited for however slow it is, and only one that brings nothing for 8 seconds is given up and tried again. A phone page opened before this change keeps working against it and reads whole boards, now compressed; this page against an older server reads whole boards as before. Every send and every new card from the phone carries an operation id, and the server keeps the result beside the effect: a retry after a lost reply is answered from the receipt and never lands twice. A message shows "Sending" until the board confirms it, then "Delivered"; one the board could not be reached for stays in the card as "Not sent yet" and is retried, across a lock and a reopen, for half a day. After that it is kept as "Could not confirm it was sent": nothing more is sent for it, readings keep asking the board whether it landed, and the board's receipt settles it either way, as delivered or as "Not sent". A message the board has no receipt of is called not sent only while that still proves something (about a day and a half), and a tap on a not-sent row puts the words back in the composer. An unconfirmed one needs two taps within a few seconds, since it may already have gone; the phone never resends it on its own. At most fifty unconfirmed messages are kept; past that a send is held with its words left in the composer until room is made. The plus in the drawer makes one card per press: a second press while the first is still being made is the same press.

`facilitator bridge` toggles the phone bridge, `facilitator bridge on` enables it, and `facilitator bridge off` disables it. On and off are idempotent. Enabling prints a QR code for the phone page and returns while Tailscale keeps the bridge active; it stays active until an `off` command removes it. The server listens on two loopback sockets: 8877 for the local desktop and agents, and 8878 for the phone bridge. The HTTPS Serve root handler proxies only to 8878, where the server requires a password-backed session on every state, command, attachment and desktop route. A phone opened from the QR in Safari sees an install card first; a Home Screen app opens at the password box. Sign-in persists across reopens and server restarts until Sign out in the right drawer or `facilitator password set` invalidates it. The cookie is Secure, HttpOnly and SameSite Strict; the server stores only a password hash and session hashes in the gitignored `bridge-auth.json`, separate from board state. Signing out also stops push delivery for that session. The local 8877 socket keeps the agent protocol unchanged. An older Serve rule targeting 8877 must be removed with `facilitator bridge off` before starting this version: server startup refuses to bind 8877 while that rule exists, so it cannot remain an unguarded remote path. Then set the password if needed, restart, and run `facilitator bridge on`. The off command removes only its root handler and leaves unrelated Serve paths, ports, Funnel routes, foreground sessions, and named Services alone. A conflicting root, Funnel on the same HTTPS endpoint, or another configuration that exposes this board is reported without changing anything. Tailscale only issues certificates once HTTPS certificates are switched on for the tailnet, a one time change under DNS in the Tailscale admin console; with that off the command says so and stops. `--dry-run` reads the live state and prints the one change it would make.

Notifications: add the page to the phone's home screen (on an iPhone push only works from there), open it, and tap Notifications at the foot of the drawer. While `facilitator bridge` is up, the server sends one push each time a card turns to your turn: a plain reply with no live working flag, or a working flag dropped or expired while a reply waited. It checks that Tailscale is connected and that the active HTTPS Serve proxy points to this board before each send; a turn while the bridge is down does not push later, and subscriptions stay saved for the next live turn. The phone app may be closed or in the background. Progress notes never push. Each push carries that event's card id and title in an encrypted `aes128gcm` payload, so delayed events retain their own card. The signing key pair is `vapid-key.pem` beside `state.json`, made by `openssl` on first need and gitignored; subscriptions live in `state.json` under `push_subs`.
