# RUNBOOK: operating the facilitator board

For an agent sitting behind the board. Read this cold and start; nothing else is assumed.

The tool: `server.py` (Python stdlib, no dependencies, port 8877) serves `index.html` (vanilla JS) at http://127.0.0.1:8877. Stacked discussion boxes, one per point, each a mini-thread between the owner and one agent. Messages queue FIFO into the agent's terminal session; every message and reply persists (`state.json`, `transcript.jsonl`, both written beside the server, both gitignored). The endpoint reference is the module docstring in `server.py`; keep it truthful as endpoints change.

## The loop

From the terminal session that owns your lane, repeat forever:

    timeout 560 curl -s "http://127.0.0.1:8877/wait?owner=facilitator&timeout=540&agent=claude"

`agent=` states your name; the board's card rows show each lane's live agent name, or offline, from exactly this. It returns `{"box": id, "title": ..., "messages": [...], "queued_after": n}` on a claim, `{"idle": true}` on timeout, `{"paused": true}` while paused, `{"end": true}` once ended and drained. Answer a claim with:

    curl -s -X POST --data-binary "the reply text" "http://127.0.0.1:8877/reply?box=ID&ctx=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "two line summary of where this card stands")"

`ctx=` is REQUIRED: every reply carries a fresh two-line summary strip (220 chars max, urlencoded), stored as the card's grey summary box in the same move. The server refuses a reply without one. Write the summary first, from the reader's seat, then the reply.

- `/wait?owner=...` claims the oldest queued box in your owner lane and marks it busy. Never leave a claim unanswered; an open claim blocks your whole lane (each owner has its own busy slot, see Owner routing below).
- Dead-connection claims roll back automatically and a claim older than 15 minutes is stolen back. Do not lean on either; answer what you claim.
- `{"paused": true}` means the owner hit the pause button (laptop-close mode). Stop polling `/wait`; idle locally and re-check about once a minute (`curl -s http://127.0.0.1:8877/state`, read `paused`) until it goes false, then resume the loop. Messages still queue while paused; finish any open claim before going quiet.

## Replies

- 100 to 150 words or fewer. Plain conversational tone: no coined shorthand, no unexplained jargon; a term either gets defined by what it concretely does or gets dropped. Paragraph breaks and short lists over walls of text. Depth comes from choosing what to say, not from length.
- No em dashes, in titles or in replies. Banned.
- Every reply fully self-contained. The box shows ONLY the latest reply, so a short follow-up ERASES a longer answer. Restate rather than reference.
- Answer what was asked and stop: no unsolicited offers, no "want me to" tails, no validation preambles.
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

## Real work

Real work ships from boxes: builds and scans go to subagents, results land back in the ordering box. Pushes and destructive operations follow the terminal-consent rule above. Commits: short, past tense, technical, no co-author or AI signature lines. Commit messages and code comments never name private folder paths, machines, people, or other projects. Push only on the owner's explicit word, typed in the terminal.

## Delegation

Anything past about a minute of hands-on work (code edits, builds, scans, renders) goes to a throwaway worker agent; the listener answers cards and never grinds. Sort by the shape of the job before starting, never mid-way: a misjudged job is finished by the listener, not handed off half done.

Every worker brief carries six parts: the goal as one checkable sentence; full context, since the worker starts knowing nothing; boundaries, what it must not touch and which neighboring work is someone else's; the output contract, the exact shape coming back; proof, the worker verifies its own work (driven browser or equivalent) before reporting; and the house rules (plain words, no em dashes, no signatures, never restart the server, delete any probe box after use). Quality test: a stranger with no history could do the job right from the brief alone.

Any work belonging to a card carries that card's green flag for exactly as long as it is happening: worker runs, but also verifying a worker's result, post-build checks, and committing that card's code after the claim is released. `POST /working?box=ID&v=1` before starting, `v=0` the moment the card's work truly ends. Green means exactly: claimed right now, or that card's work happening anywhere.

Green is verified, not trusted: registration starts a heartbeat clock, and without `POST /ping?box=ID` at least every 75 seconds the green expires on its own, so a dead job can never leave a card stuck green. Keep a pinger beside any long job:

    ( while curl -s -o /dev/null "http://127.0.0.1:8877/ping?box=ID"; do sleep 30; done ) &

and kill it when the work ends. The server also watches the other direction: an agent alive but absent from the listening call for over a minute, holding no claim and no live job, makes the bar read "working, card not marked". Do not let that be true of you.

## Headless testing

`probe3.js` (repo root; needs `npm install puppeteer-core` and Chrome) is the page health probe: read-only apart from creating and then deleting its own probe box. Never point a message-sending script at a live board.

## Owner routing

Two agents share one board. Every box carries an owner tag: `facilitator` (discussion about this tool, served by this repo's agent) or `triage` (the project under discussion, served by its own agent). `/wait?owner=...` claims only that owner's boxes, and each owner has its own busy slot and listener-presence tracking, so the two agents never block or steal from each other. An ownerless `/wait` defaults to triage. Two meta sections sit on top, tool-meta first, each with its own plus button; user-created boxes inherit the section's owner; the writing indicator and the offline banner name the agent. Every meta box carries the owner's remove cross, the standing `0` (facilitator) and `t0` (triage) included; a lane with its standing box removed just works from its remaining boxes, and notes that would have gone there go to an open box or the project docs. The two loops, side by side:

    timeout 560 curl -s "http://127.0.0.1:8877/wait?owner=facilitator&timeout=540&agent=claude"
    timeout 560 curl -s "http://127.0.0.1:8877/wait?owner=triage&timeout=540&agent=claude"

## Seeding a board

A first-ever start (no `state.json`) reads `seed.json` beside the server: the board title plus opening boxes (see `seed.example.json` for the shape). `seed.json` is gitignored because real discussion content is private and never ships in this repo; the example holds invented content only. To start a new project's board: copy the example to `seed.json`, fill in real items, run the server.

## Bringing everything up

`./facilitator run` starts the server if the port is empty and opens the chromeless app window, nothing else: it never touches tmux by default, and only reports lanes with no listener, printing the attach instruction for pasting. `--attach` types that instruction into the existing tmux sessions named in `run.config.json` (machine-local and gitignored, since lanes name real directories; see `run.config.example.json`); `--spawn` additionally creates new agent sessions where none is reachable. `./facilitator status` prints a one-line board summary.
