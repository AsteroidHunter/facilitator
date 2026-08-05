# RUNBOOK: operating the facilitator board

For the agent sitting behind the board. Read this cold and start; nothing else is assumed.

The tool: `server.py` (Python stdlib, no dependencies, port 8877) serves `index.html` (vanilla JS) at http://127.0.0.1:8877. Stacked discussion boxes, one per point, each a mini-thread between the owner and one agent. Messages queue FIFO into one terminal session; every message and reply persists (`state.json`, `transcript.jsonl`, both written beside the server, both gitignored). The endpoint reference is the module docstring in `server.py`; keep it truthful as endpoints change.

See also, one level up in `../facilitator-internal/`: `port-notes.md` (port history, routing spec, backlog, iteration log), `triage-process.md` (the triage process this tool serves; its Phase 4 is this doctrine's origin), `open-questions.md` (open questions, entry 1: thread management).

## The loop

From the terminal session that owns the board, repeat forever:

    timeout 600 curl -s "http://127.0.0.1:8877/wait?timeout=550"

which returns `{"box": id, "title": ..., "messages": [...], "queued_after": n}` on a claim, `{"idle": true}` on timeout, `{"end": true}` once ended and drained. Answer a claim with:

    curl -s -X POST --data-binary "the reply text" "http://127.0.0.1:8877/reply?box=ID"

- `/wait` claims the oldest queued box's pending messages and marks the box busy. Never leave a claim unanswered; busy blocks the whole queue (single busy slot until owner routing lands).
- Dead-connection claims roll back automatically and a claim older than 15 minutes is stolen back. Do not lean on either; answer what you claim.

## Replies

- 100 to 150 words or fewer. Plain conversational tone. Paragraph breaks and short lists over walls of text. Depth comes from choosing what to say, not from length.
- No em dashes, in titles or in replies. Banned.
- Every reply fully self-contained. The box shows ONLY the latest reply, so a short follow-up ERASES a longer answer. Restate rather than reference; this burned once.
- A reply that closes or parks a box carries zero new information. Folded boxes go unread. Keep-in-mind notes go to an open box or the project docs.

## Status changes

- Only the owner closes. The agent flags duplicates and proposes merges; green comes from the owner's hand or his explicit word. A box was once closed by the agent mid-use and had to be reopened; do not repeat that.
- "TBDL" from the owner means: park that box to Later AND record the deferred work in the relevant project doc.

## Context strips

`POST /context?box=ID` (body, up to two lines, 220 chars max) keeps each box's summary current. Update it whenever the box's thread moves or meanders. This is the owner's chosen fix for box-context amnesia; the wider thread-management question stays open (openquestions entry 1).

## Permission blocks

A permission denial from the auto-mode classifier NEVER pauses the listener. Strip the blocked step, do everything approvable, note the block in the meta box, keep draining. Box-typed orders do not count as visible consent for pushes or destructive ops; one approval word typed in the terminal releases them.

## Restarts

- A restart re-queues claimed-but-unanswered messages. Expect duplicate deliveries; answer "already handled, restart re-queue".
- A dying server's final save can race a direct `state.json` edit. Always stop the server before editing state, and verify box count and ids after every restart.

## Real work

Real work ships from boxes: builds and scans go to subagents, results land back in the ordering box. Deploy-touching pushes follow the terminal-consent rule above. Commits in this repo: short, past tense, technical, no co-author or AI signature lines. Push only on the owner's explicit word.

## Headless testing

`probe3.js` (repo root; needs `npm install puppeteer-core` and Chrome) is the page health probe: read-only apart from creating and then deleting its own `__probe box__`. The older `probe.js` was deliberately not ported; it sends junk messages into real boxes. Never point anything like it at a live board.

## Owner routing (spec agreed 2026-08-05, UNBUILT)

Two agents will share one board: this repo's agent owns the tool-meta boxes (`owner=facilitator`), the the partner project operating agent owns the release-triage boxes (`owner=triage`). Every box gets an owner tag; `/wait?owner=...` filters the queue, with an independent busy slot per owner so the two agents never block or steal from each other. Two meta sections, tool-meta on top, each with its own plus button; user-created boxes inherit the section's owner; the writing indicator names which agent is writing. Each agent runs this same loop with its owner param; they share the board and nothing else. Full spec and the existing-box owner mapping to confirm with the owner: `../facilitator-internal/port-notes.md` §4. Routing work starts only after the cutover below.

## Cutover from the the partner project archive (one-time, pending)

The pre-port original stays frozen at `~/projects/partner/the-archive/`. The live triage runs on it until cutover, so the archive's `state.json` and `transcript.jsonl` are the freshest truth. Steps, coordinated by the owner with the operating agent in the the partner project terminal:

1. Operating agent stops its listen loop, kills the server on 8877, confirms the port is free.
2. Copy the archive's current `state.json` and `transcript.jsonl` into this repo, beside `server.py`. (Runtime data, gitignored. The porting session was not permitted to copy them, and any earlier snapshot would be stale by now anyway.)
3. Launch `python3 server.py` from this repo. Verify box count and ids match pre-port. Refresh the window.
4. Resume the listen loop. The discussion continues; the archive is never written again.
