# RUNBOOK: operating the facilitator board

For an agent sitting behind the board. Read this cold and start; nothing else is assumed.

The tool: `server.py` (Python stdlib, no dependencies, port 8877) serves `index.html` (vanilla JS) at http://127.0.0.1:8877. Stacked discussion boxes, one per point, each a mini-thread between the owner and one agent. Messages queue FIFO into the agent's terminal session; every message and reply persists (`state.json`, `transcript.jsonl`, both written beside the server, both gitignored). The endpoint reference is the module docstring in `server.py`; keep it truthful as endpoints change.

## The loop

From the terminal session that owns your lane, repeat forever. Two calls, both required:

    timeout 560 curl -s "http://127.0.0.1:8877/wait?owner=facilitator&timeout=540&agent=claude"
    curl -s -X POST "http://127.0.0.1:8877/ack?owner=facilitator&token=<the ack field>"

`agent=` states your name; the board's card rows show each lane's live agent name, or offline, from exactly this. It returns `{"box": id, "title": ..., "messages": [...], "queued_after": n, "ack": token}` on a claim, `{"idle": true}` on timeout, `{"paused": true}` while paused, `{"end": true}` once ended and drained.

The `ack` token is the receipt for the card you were just handed, and confirming it is part of claiming, not an extra. A hand-off is provisional until you confirm it, because the answer can die on the wire: your own kill timer fires, the connection drops, and the server thinks it delivered a card nobody ever saw. Confirm it the moment the claim lands, before you start reading or working. A card nobody confirms goes back to the front of its lane's queue after 90 seconds and its colour falls back to the queued grey, so nothing sits green with nobody on it. Confirming twice is fine; the second call answers the same `{"ok": true}`.

WARNING: a loop without the confirm line claims cards it cannot keep. Every claim bounces back to the queue 90 seconds later and gets handed out again, forever, and your reply lands on a card you no longer hold.

Answer a claim with:

    curl -s -X POST --data-binary "the full reply text" "http://127.0.0.1:8877/reply?box=ID&ctx=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "two line summary of where this card stands")"

`ctx=` is REQUIRED: every reply carries a fresh two-line summary strip (220 chars max, urlencoded), stored as the card's grey summary box in the same move. The server refuses a reply without one. Write the summary first, from the reader's seat, then the reply.

- `/wait?owner=...` claims the oldest queued box in your owner lane and marks it busy. Never leave a claim unanswered; an open claim blocks your whole lane (each owner has its own busy slot, see Owner routing below).
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
- `POST /note?box=ID` is the only background-progress action. It stores the interim text, consumes and releases any held claim, enters the explicit green note state, starts or refreshes the heartbeat, and keeps the turn with the agent. Keep pinging while work continues. A note whose heartbeat dies rests grey, never yellow. `/reply` is only for a final answer and rejects the removed `quiet` query.
- The colour law is the machine's now, not your discipline: every card sits in one server-side state and the colour is a pure read of it. A normal reply under a live working flag lands the card in deferred, still green; the turn is handed over when the flag drops (`/working?box=ID&v=0`) or its heartbeat expires. A progress note stays in note until another event or the heartbeat ends.
- A reply that closes or parks a box carries zero new information. Folded boxes go unread. Keep-in-mind notes go to an open box or the project docs.

## Titles

A user-created box is auto-named with the chopped first line of its first message, which reads badly. When you claim such a box (title ends in "…" or just parrots the message), set a brief accurate title as part of answering it: `POST /title?box=ID`, raw text body. Keep titles short enough to sit on one line.

## Status changes

- Only the owner closes. The agent flags duplicates and proposes merges; green comes from the owner's hand or their explicit word. A box was once closed by the agent mid-use and had to be reopened; do not repeat that.
- "TBDL" from the owner means: park that box to Later AND record the deferred work in the relevant project doc.

## Context strips

`POST /context?box=ID` (body, 50 words max, refused over that, never truncated) keeps each box's summary current; the same text rides every reply's required `ctx=`. Its job is orientation, never recap: line one says why the card exists and what it is trying to settle; line two says where that stands right now. Details of the latest exchange do not belong in it. It is the working cure for box-context amnesia; the wider question of keeping per-box context straight at scale stays open.

## Permission blocks

A permission denial from an automated classifier NEVER pauses the listener. Strip the blocked step, do everything approvable, note the block in the meta box, keep draining. Box-typed orders do not count as visible consent for pushes or destructive operations; one approval word typed in the terminal releases them.

## Restarts

- A restart re-queues claimed-but-unanswered messages. Expect duplicate deliveries; answer "already handled, restart re-queue".
- A dying server's final save can race a direct `state.json` edit. Always stop the server before editing state, and verify box count and ids after every restart.
- Kill by PID and POLL until the port is actually free before launching the replacement; a fixed sleep loses the bind race and leaves the OLD server serving while the new one dies with "Address already in use" (bitten twice). Confirm the new code answers (hit a new endpoint) before trusting the restart.

## The log

Three dated files in `facilitator-internal/logs`, the sibling folder beside this repo, so nothing here is ever committed:

- `server-YYYYMMDD.log`: what the board did. Start and stop with the reason it stopped, every refusal it sent, every push outcome with the service's own words, board events, a save that failed, and every crash.
- `client-YYYYMMDD.jsonl`: what the three pages reported: a thrown error, a rejected promise, a request that failed, a card that would not draw, a timer that ran more than two seconds late.
- `bridge-YYYYMMDD.log`: the tailnet share going up and coming down, and what ended it.

Each file caps at 5 MB and rolls, thirty of each kind are kept and older ones are deleted, so the folder cannot pass about 150 MB whatever goes wrong. One line is one event, as JSON:

    {"ts": "2026-09-03T18:22:41.108Z", "level": "info", "kind": "refusal", "box": "m12", "route": "/reply", "code": 400, "reason": "bad box"}

Three levels and no more. INFO is what happened and is on by default; ERROR is something that failed and was not meant to; DEBUG is the noise you switch on while hunting, a line per request with its milliseconds plus claims, acks and unconfirmed hand-offs. Raise it for one run and no longer:

    FACILITATOR_LOG_LEVEL=debug python3 server.py

`log_level` in `run.config.json` (`info`, `debug`, `error`) sets the standing level and that variable beats it; a level nobody has heard of falls back to `info` rather than stopping the board. `FACILITATOR_LOG_DIR` moves the whole folder, which is what the tests use so no test can write into the real one. `GET /log?lines=N` tails the day's server file.

The dated file is the only stream. Started by the CLI the server's output goes nowhere else, so no event is written twice; started by hand in a terminal, INFO is mirrored there as well in a short human form, so it says what it is doing as it does it. A crash lands in the file like anything else: a request that throws, and a start that dies of something rather than being asked to stop, each write one `crash` line naming the exception's type, its own words when those words are plain enough to keep, and where it happened as `file:function:line` with no path in it. A fatal one is followed by the stop line that says which type ended the run. The one failure no file can hold is a server that dies before its logger exists, which is an import going wrong; `facilitator run` notices the child is already gone and says so in one sentence, and running `python3 server.py` by hand shows it.

Five things never appear in any line: message text, keys and tokens, whole push endpoints (the service's host only), file paths, and email addresses. The rule is kept where the line is written, by not passing those things in: the board event line carries a message's length and never the message, and the lane-creation line carries the folder's name and never the path to it. Anyone adding a line keeps it that way. A filter over a formatted line can be fooled; not passing the text cannot.

## Real work

Real work ships from boxes: builds and scans go to subagents, results land back in the ordering box. Pushes and destructive operations follow the terminal-consent rule above. Commits happen only on the owner's order, never automatically after changes; finished work sits uncommitted until he asks. Messages: short, past tense, technical, no co-author or AI signature lines. Commit messages and code comments never name private folder paths, machines, people, or other projects. Push only on the owner's explicit word, typed in the terminal.

## Delegation

Anything past about a minute of hands-on work (code edits, builds, scans, renders) goes to a throwaway worker agent; the listener answers cards and never grinds. Sort by the shape of the job before starting, never mid-way: a misjudged job is finished by the listener, not handed off half done.

Every worker brief carries six parts: the goal as one checkable sentence; full context, since the worker starts knowing nothing; boundaries, what it must not touch and which neighboring work is someone else's; the output contract, the exact shape coming back; proof, the worker verifies its own work (driven browser or equivalent) before reporting; and the house rules (plain words, no em dashes, no signatures, never restart the server, delete any probe box after use). Quality test: a stranger with no history could do the job right from the brief alone.

Any work belonging to a card carries that card's green flag for exactly as long as it is happening: worker runs, but also verifying a worker's result, post-build checks, and committing that card's code after the claim is released. `POST /working?box=ID&v=1` before starting, `v=0` the moment the card's work truly ends. Green means exactly the machine's two green states: working (claimed right now, or that card's work happening anywhere) and deferred (the same, with a reply already waiting to become the owner's turn when the work ends).

Green is verified, not trusted: registration starts a heartbeat clock, and without `POST /ping?box=ID` at least every 75 seconds the green expires on its own, so a dead job can never leave a card stuck green. Keep a pinger beside any long job:

    ( while curl -s -o /dev/null -X POST "http://127.0.0.1:8877/ping?box=ID"; do sleep 30; done ) &

and kill it when the work ends. The server also watches the other direction: an agent alive but absent from the listening call for over a minute, holding no claim and no live job, makes the bar read "working, card not marked". Do not let that be true of you.

## Headless testing

`probe3.js` (repo root; needs `npm install puppeteer-core` and Chrome) is the page health probe: read-only apart from creating and then deleting its own probe box. Never point a message-sending script at a live board.

## Owner routing

Two agents share one board. Every box carries an owner tag: `facilitator` (discussion about this tool, served by this repo's agent) or `pastureland` (the project under discussion, served by its own agent). `/wait?owner=...` claims only that owner's boxes, and each owner has its own busy slot and listener-presence tracking, so the two agents never block or steal from each other. An ownerless `/wait` defaults to pastureland. Two meta sections sit on top, tool-meta first, each with its own plus button; user-created boxes inherit the section's owner; the writing indicator and the offline banner name the agent. Every meta box carries the owner's remove cross, the standing `0` (facilitator) and `t0` (pastureland) included; a lane with its standing box removed just works from its remaining boxes, and notes that would have gone there go to an open box or the project docs. The two loops, side by side:

    timeout 560 curl -s "http://127.0.0.1:8877/wait?owner=facilitator&timeout=540&agent=claude"
    timeout 560 curl -s "http://127.0.0.1:8877/wait?owner=pastureland&timeout=540&agent=claude"

Each lane confirms its own claims against its own owner: `POST /ack?owner=facilitator&token=...` and `POST /ack?owner=pastureland&token=...`. A token belongs to one lane's claim and is refused (409) anywhere else.

## Showing a picture on your lane

Magic box 3 holds one picture per lane, a plot above all. Write the file into your own project's internal folder, named `panel` with any image extension:

    <your project folder>/<your lane id>-internal/panel.png

So the `sketchbook` lane writes `~/projects/sketchbook/sketchbook-internal/panel.png`. Png, svg, jpg, gif and webp all work. The board picks it up within about four seconds, swaps itself when you rewrite the file, and falls back to its empty marks when you delete it. Nothing needs adding to the server, and no lane can read another's folder. Note that the panel is currently switched on for the `sketchbook` tab only; every other tab still shows the plain stub.

## Seeding a board

A first-ever start (no `state.json`) reads `seed.json` beside the server: the board title plus opening boxes (see `seed.example.json` for the shape). `seed.json` is gitignored because real discussion content is private and never ships in this repo; the example holds invented content only. To start a new project's board: copy the example to `seed.json`, fill in real items, run the server.

## Bringing everything up

`./facilitator run` starts the server if the port is empty and opens the chromeless app window, nothing else: it never touches tmux by default, and only reports lanes with no listener, printing the attach instruction for pasting. `--attach` types that instruction into the existing tmux sessions named in `run.config.json` (machine-local and gitignored, since lanes name real directories; see `run.config.example.json`); `--spawn` additionally creates new agent sessions where none is reachable. `./facilitator status` prints a one-line board summary.

## The phone page and the bridge

`GET /m` is the board for a phone: the project tabs across the top, one card filling the screen with the app's thin margins, and the card list (doing, deferred, done) in a drawer pulled in from the left edge. The card does what the desktop card does: the full reply, the sent messages, older replies (the arrows in the card's top bar), a composer that sends, a plus that attaches a photo through `/upload`, the defer chip, the close cross, and a plus in the drawer for a new card. Nothing else is on the phone.

`./facilitator bridge` publishes the board on this Mac's Tailscale name over HTTPS and prints a QR code that opens the phone page, with the address under it. The server keeps listening on 127.0.0.1 only; the command runs `tailscale serve --bg --https=443 http://127.0.0.1:8877` (the `Tailscale` binary inside the Mac app when `tailscale` is not on PATH), so Tailscale terminates HTTPS and proxies to the board, and being on the tailnet is the whole of the access control: no password, no token, no login. Tailscale only issues certificates once HTTPS certificates are switched on for the tailnet, a one time change under DNS in the Tailscale admin console; with that off the command says so in one sentence and stops. The command then keeps the terminal open and switches the sharing off the moment you press Ctrl-C, press Ctrl-Z, kill it or close the terminal, and every run first clears whatever an earlier one left on. Ctrl-Z ends it rather than suspending it, because a suspended bridge leaves the address published with nothing running to take it down. `--dry-run` prints the commands instead of running them.

Notifications: add the page to the phone's home screen (on an iPhone push only works from there), open it, and tap Notifications at the foot of the drawer. While `./facilitator bridge` is up, the server sends one push each time a card turns to your turn: a plain reply with no live working flag, or a working flag dropped or expired while a reply waited. It checks that Tailscale is connected and that the active HTTPS Serve proxy points to this board before each send; a turn while the bridge is down does not push later, and subscriptions stay saved for the next live turn. The phone app may be closed or in the background. Progress notes never push. The push carries no payload; the phone's worker reads `/state` and shows the card's title. The signing key pair is `vapid-key.pem` beside `state.json`, made by `openssl` on first need and gitignored; subscriptions live in `state.json` under `push_subs`.
