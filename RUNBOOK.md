# RUNBOOK: operating the facilitator board

For an agent sitting behind the board. Read this cold and start; nothing else is assumed.

The tool: `server.py` (Python, port 8877) serves `index.html` (vanilla JS) at http://127.0.0.1:8877. Its pinned packages go in the standard `.venv` beside it. For a new checkout run `uv venv .venv` and `uv pip sync --python .venv/bin/python requirements.txt`; after requirements change, refresh an existing checkout with the second command alone. `facilitator run` starts the server with that `.venv`. Stacked discussion boxes, one per point, each a mini-thread between the owner and one agent. Messages queue FIFO into the agent's terminal session; every message and reply persists (`state.json`, `transcript.jsonl`, both written beside the server, both gitignored). The endpoint reference is the module docstring in `server.py`; keep it truthful as endpoints change.

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

- `/wait?owner=...` claims the oldest queued box in your owner lane and marks it busy. This is an **auto** lane; a lane in select mode reads a queue and chooses instead, and `/wait` there claims nothing (see Select lanes below). Never leave a claim unanswered; an open claim blocks your whole lane (each owner has its own busy slot, see Owner routing below).
- Three nets sit under a claim, in order: a hand-off written into a dead socket rolls back at once, an unconfirmed claim returns after 90 seconds, and a claim older than 15 minutes is stolen back. Do not lean on any of them; confirm what you claim and answer what you confirm.
- Before going idle, check whether anything is waiting on your lane: `GET /unread?owner=YOURLANE` answers `{"queued": N, "claimed": M}`, messages still waiting plus messages in the claim you hold. It reads only, so it is safe from a hook. Paste this as a Stop hook command and go back to the loop instead of idling whenever `queued` is above zero:

      curl -s "http://127.0.0.1:8877/unread?owner=facilitator"

- `{"paused": true}` means the owner hit the pause button (laptop-close mode). Stop polling `/wait`; idle locally and re-check about once a minute (`curl -s http://127.0.0.1:8877/state`, read `paused`) until it goes false, then resume the loop. Messages still queue while paused; finish any open claim before going quiet.

## Select lanes: the queue you read and choose from

A lane is served one of two ways. **Auto** is everything above: `/wait` hands you the oldest card with all its messages, and you confirm. **Select** hands you nothing. You read a table, pick a card on purpose, and only then open it. One flag moves a lane either way, and nothing else about the board changes:

    curl -s -X POST "http://127.0.0.1:8877/mode?owner=YOURLANE&mode=select"

Beside the conversation runs one connection per project, `facilitator-connect connect`. It holds the poll, reconnects, renews the lane's holder record, retries anything whose answer was lost, runs the notification adapter and owns the work indicators. You never write a pinger, never start a listen loop, and never spend a turn on an empty poll. It tells you when something is waiting; the queue is the source of truth, so a repeated line costs one redundant look.

Inside your own turn, four commands do the work:

    facilitator-connect queue                       # rows: card, wait, count, state, title, flags. No request text
    facilitator-connect select ID                   # reserve it; the card turns green through the usual claim
    facilitator-connect open ID                     # the messages, and the receipt that says they arrived
    facilitator-connect reply ID "..." --ctx "..."  # the answer, exactly as on an auto lane

`release ID --reason "..."` gives a card back to the front of the queue. `open ID --fresh` collects messages that landed after you reserved it; they are their own delivery with their own receipt, and they are never also in the first one. `--ctx` is required on a reply here even though the server has accepted its absence since 20260821. `attachment ID FILE` fetches an image or document over the protocol rather than off the disk, which is what lets the connection run on a different machine from the board.

A row is metadata and never a message: seeing one is not reading a card. `starved` means the oldest message has waited longer than the 15 minute steal window; passing one over is allowed and is written down. `seen before` means a delivery of those messages was acknowledged once already, so an answer may repeat one you have given. `mini` means a reply over 100 words will be refused.

Three facts the board records, and what each one means. A notice outcome says what one adapter could observe, never that the conversation displayed anything. A receipt says your client received a complete body and names the route that carried it; it is not evidence that anyone read it. A live work registration says a registered job is running. Nothing claims more than that.

Exit codes: 0 done, 3 refused, 4 card not in this lane, 5 conflict with the current row printed, 6 board unreachable, 7 lane already held, 8 an unresolved receipt that needs a person. On 5 for a selection or an open, look at the queue again and choose again. On 8, stop and say so: do not send the same words again under a new id.

## What project routing does and does not protect

The board routes by project. A request naming a card that is not in the lane it names is refused, a lane's listing shows only that lane's cards, and the holder record stops two connections serving one project by accident. These are correctness checks. They keep ordinary operation right.

They are not a boundary. They do not stop an agent with arbitrary local access that names another lane on purpose, calls the board directly, or reads the board's files off the disk. The first version relies on each agent following its own project's instructions. Enforced isolation is card m298, and nothing here should be read as doing its job.

## Where the board is

The connection takes one board address from `board` in `run.config.json`, per lane or for all of them, and `--board` overrides it. Everything works the same whether that address is on this machine or another: the same routes, the same semantics, the same receipts.

What changes when a connection runs on another machine: nothing it needs comes off a shared disk, so message text arrives from `open` and attachments from `attachment` rather than from the uploads folder. Every age and expiry is the board's own number, never two clocks compared. A reconnect carries its cursor, so it asks only about what it missed. The connection's own files live under `~/.facilitator-connect/<lane>`, or wherever `FACILITATOR_CONNECT_HOME` says, and its config under `FACILITATOR_CONNECT_CONFIG` where there is no `run.config.json` beside the board.

What does not change: the server still binds 127.0.0.1, exactly as before. Reaching it from anywhere else is the bridge's business and a deployment question, not something the connection settles.

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

The phone keeps at most 40 recent interaction events and 60 seconds of lead-up in page memory. It sends none of that routine history. A visible, uninterrupted UI span of at least 150 ms, phone request of at least two seconds, failed operation/request, recorded page problem, visible freeze, or broken render invariant may save it automatically, with a 30 second automatic cooldown. The Settings marker, or Control + Shift + M, saves the same bounded history when a glitch is noticed. A save batch is capped at 12 KB on the phone and the route still refuses any body over 16 KB. The phone makes at most four save attempts per minute and the server permits four incident writes per minute across all pages and reasons. Failed and offline manual saves retain their original marker in that open page for an explicit retry. Closing the page loses any history that was never sent.

`/send`, `/create`, and `/m/state` responses carry a numeric server-duration header for the phone history. A request on one of those routes that takes at least one second also writes one rate-limited `slowrequest` INFO line. These timings cover server handling, not the phone's network transit.

The dated file is the only stream. Started by the CLI the server's output goes nowhere else, so no event is written twice; started by hand in a terminal, INFO is mirrored there as well in a short human form, so it says what it is doing as it does it. A crash lands in the file like anything else: a request that throws, and a start that dies of something rather than being asked to stop, each write one `crash` line naming the exception's type, its own words when those words are plain enough to keep, and where it happened as `file:function:line` with no path in it. A fatal one is followed by the stop line that says which type ended the run. The one failure no file can hold is a server that dies before its logger exists, which is an import going wrong; `facilitator run` notices the child is already gone and says so in one sentence, and running `python3 server.py` by hand shows it.

Five things never appear in any line: message or title text, keys and authentication tokens, whole push endpoints (the service's host only), file paths, and email addresses. The rule is kept where the line is written, by not passing those things in: the board event line carries a message's length and never the message, and the lane-creation line carries the folder's name and never the path to it. Phone incident entries accept only fixed event/state names, bounded numbers, existing card IDs, and canonical operation receipt IDs. Anyone adding a line keeps it that way. A filter over a formatted line can be fooled; not passing the text cannot.

## Real work

Real work ships from boxes: builds and scans go to subagents, results land back in the ordering box. Pushes and destructive operations follow the terminal-consent rule above. After work is finished and verified, stage and commit its changes automatically. Messages: short, imperative, technical, no co-author or AI signature lines. Commit messages and code comments never name private folder paths, machines, people, or other projects. Push only on the owner's explicit word, typed in the terminal.

## Delegation

Anything past about a minute of hands-on work (code edits, builds, scans, renders) goes to a throwaway worker agent; the listener answers cards and never grinds. Sort by the shape of the job before starting, never mid-way: a misjudged job is finished by the listener, not handed off half done.

Every worker brief carries six parts: the goal as one checkable sentence; full context, since the worker starts knowing nothing; boundaries, what it must not touch and which neighboring work is someone else's; the output contract, the exact shape coming back; proof, the worker verifies its own work (driven browser or equivalent) before reporting; and the house rules (plain words, no em dashes, no signatures, never restart the server, delete any probe box after use). Quality test: a stranger with no history could do the job right from the brief alone.

Any work belonging to a card carries that card's green flag for exactly as long as it is happening: worker runs, but also verifying a worker's result, post-build checks, and committing that card's code after the claim is released. `POST /working?box=ID&v=1` before starting, `v=0` the moment the card's work truly ends. Green means exactly the machine's two green states: working (claimed right now, or that card's work happening anywhere) and deferred (the same, with a reply already waiting to become the owner's turn when the work ends).

Green is verified, not trusted: registration starts a heartbeat clock, and without a beat at least every 75 seconds the green expires on its own, so a dead job can never leave a card stuck green. On a select lane the beating is not your business at all. Register the job and the connection owns the rest:

    facilitator-connect work start ID --job j-build --pid $!
    facilitator-connect work end ID --job j-build

With `--pid` the connection watches that process, identified by its number and its start time together so a reused number cannot keep an unrelated card green, and ends the job itself the moment it exits. Without a process to watch, pass `--for SECONDS` (900 by default): the registration is bounded and the connection ends it when the time is up, because a card green on nothing anybody can observe is the failure this replaces. An indicator means a registered job is alive. It does not mean the job is getting anywhere.

On an auto lane the old arrangement still stands: `POST /working?box=ID&v=1`, your own `POST /ping?box=ID` every 30 seconds, `v=0` when the work ends.

The server also watches the other direction: an agent alive but absent from the listening call for over a minute, holding no claim and no live job, makes the bar read "working, card not marked". Do not let that be true of you.

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

`./facilitator run` starts the server if the port is empty and opens the chromeless app window, nothing else: it never touches tmux by default, and only reports lanes with no listener, printing the attach instruction for pasting. `--attach` types that instruction into the existing tmux sessions named in `run.config.json` (machine-local and gitignored, since lanes name real directories; see `run.config.example.json`); `--spawn` additionally creates new agent sessions where none is reachable. `./facilitator restart` stops and restarts only the server: it signals the one process holding the listening socket on the configured port, with SIGTERM and never SIGKILL, after reading that process back as this folder's `server.py` twice, once when it is found and once in the moment before the signal. What is read is the kernel's own answer about it: start time, executable and argument vector, which must be exactly our `server.py` under an interpreter this board uses, so a pid that has been released and reused, or a process that has become something else, is refused rather than killed. It polls until the port is actually free before starting the replacement (an unreadable port is never treated as a free one), then waits for the new server to answer AND for the one listener to be that exact child before saying anything went well; a port taken over by something else is refused and that process is never signalled. It leaves the browser alone: a Chrome tab or chromeless app window already showing the board is kept as it is and named for reloading, a new app window is opened only when Chrome is certainly showing the board nowhere, and when Chrome cannot be asked nothing is opened and the limit is said out loud. It touches no lane, no tmux session and no bridge; `--dry-run` prints the plan and changes nothing. `./facilitator status` prints a one-line board summary.

## The phone page and the bridge

`GET /m` is the board for a phone: the project tabs across the top, one card filling the screen with the app's thin margins, and the card list (doing, deferred, done) in a drawer pulled in from the left edge. The card does what the desktop card does: the full reply, the sent messages, older replies (the arrows in the card's top bar), a composer that sends, a plus that attaches a photo through `/upload`, the defer chip, the close cross, and a plus in the drawer for a new card. Nothing else is on the phone.

The phone reads the board through `GET /m/state`, naming the revision it holds, so a poll that finds nothing new costs a few hundred bytes; it refreshes every 1.2 seconds while on screen, with a deadline on each read and a backoff on failure, and shows a "reconnecting" note under the tabs when the board has not answered. Every send and every new card from the phone carries an operation id, and the server keeps the result beside the effect: a retry after a lost reply is answered from the receipt and never lands twice. A message shows "Sending" until the board confirms it, then "Delivered"; one the board could not be reached for stays in the card as "Not sent yet" and is retried, across a lock and a reopen, for half a day. After that it is kept as "Could not confirm it was sent": nothing more is sent for it, readings keep asking the board whether it landed, and the board's receipt settles it either way, as delivered or as "Not sent". A message the board has no receipt of is called not sent only while that still proves something (about a day and a half), and a tap on a not-sent row puts the words back in the composer. An unconfirmed one needs two taps within a few seconds, since it may already have gone; the phone never resends it on its own. At most fifty unconfirmed messages are kept; past that a send is held with its words left in the composer until room is made. The plus in the drawer makes one card per press: a second press while the first is still being made is the same press.

`./facilitator bridge` toggles the phone bridge, `./facilitator bridge on` enables it, and `./facilitator bridge off` disables it. On and off are idempotent. Enabling prints a QR code for the phone page and returns while Tailscale keeps the bridge active; it stays active until an `off` command removes it. The server keeps listening on 127.0.0.1 only. The enable command uses a background HTTPS Serve root handler that proxies to the board, so being on the tailnet is the whole of the access control: no password, no token, no login. The off command removes only that root handler and leaves unrelated Serve paths, ports, Funnel routes, foreground sessions, and named Services alone. A conflicting root, Funnel on the same HTTPS endpoint, or another configuration that exposes this board is reported without changing anything. Tailscale only issues certificates once HTTPS certificates are switched on for the tailnet, a one time change under DNS in the Tailscale admin console; with that off the command says so and stops. `--dry-run` reads the live state and prints the one change it would make.

Notifications: add the page to the phone's home screen (on an iPhone push only works from there), open it, and tap Notifications at the foot of the drawer. While `./facilitator bridge` is up, the server sends one push each time a card turns to your turn: a plain reply with no live working flag, or a working flag dropped or expired while a reply waited. It checks that Tailscale is connected and that the active HTTPS Serve proxy points to this board before each send; a turn while the bridge is down does not push later, and subscriptions stay saved for the next live turn. The phone app may be closed or in the background. Progress notes never push. Each push carries that event's card id and title in an encrypted `aes128gcm` payload, so delayed events retain their own card. The signing key pair is `vapid-key.pem` beside `state.json`, made by `openssl` on first need and gitignored; subscriptions live in `state.json` under `push_subs`.
