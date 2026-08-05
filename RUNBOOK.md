# RUNBOOK: operating the facilitator board

For the agent sitting behind the board. Read this cold and start; nothing else is assumed.

The tool: `server.py` (Python stdlib, no dependencies, port 8877) serves `index.html` (vanilla JS) at http://127.0.0.1:8877. Stacked discussion boxes, one per point, each a mini-thread between the owner and one agent. Messages queue FIFO into one terminal session; every message and reply persists (`state.json`, `transcript.jsonl`, both written beside the server, both gitignored). The endpoint reference is the module docstring in `server.py`; keep it truthful as endpoints change.

See also, one level up in `../facilitator-internal/`: `port-notes.md` (port history, routing spec, backlog, iteration log), `triage-process.md` (the triage process this tool serves; its Phase 4 is this doctrine's origin), `open-questions.md` (open questions, entry 1: thread management).

## The loop

From the terminal session that owns the board, repeat forever:

    timeout 600 curl -s "http://127.0.0.1:8877/wait?owner=facilitator&timeout=550"

which returns `{"box": id, "title": ..., "messages": [...], "queued_after": n}` on a claim, `{"idle": true}` on timeout, `{"end": true}` once ended and drained. Answer a claim with:

    curl -s -X POST --data-binary "the reply text" "http://127.0.0.1:8877/reply?box=ID"

- `/wait?owner=...` claims the oldest queued box in your owner lane and marks it busy. Never leave a claim unanswered; an open claim blocks your whole lane (each owner has its own busy slot, see Owner routing below).
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

## Owner routing (built 2026-08-05)

Two agents share one board: this repo's agent owns the tool-meta boxes (`owner=facilitator`), the the partner project operating agent owns the release-triage boxes (`owner=triage`). Every box carries an owner tag; `/wait?owner=...` claims only that owner's boxes, and each owner has its own busy/claim slot and listener-presence tracking, so the two agents never block or steal from each other. An ownerless `/wait` defaults to triage, so the the partner project agent's pre-routing loop keeps working unmodified. Two meta sections sit on top, tool-meta first, each with its own plus button; user-created boxes inherit the section's owner; the writing indicator and the offline banner name the agent. Pinned meta boxes: `0` (facilitator) and `t0` (triage), neither deletable. Mapping applied to pre-routing boxes: `0` to facilitator, every numbered triage box to triage. Full spec: `../facilitator-internal/port-notes.md` §4.

The two loops, side by side:

    timeout 600 curl -s "http://127.0.0.1:8877/wait?owner=facilitator&timeout=550"   # this repo's agent
    timeout 600 curl -s "http://127.0.0.1:8877/wait?owner=triage&timeout=550"        # the partner project agent

## Cutover from the the partner project archive (done 2026-08-05)

The pre-port original is frozen at `~/projects/partner/the-archive/`. Its final `state.json` and `transcript.jsonl` were copied here on the owner's explicit terminal direction (the old server was already down), the repo's server took over port 8877, and box count and ids were verified identical. The archive is never written again; this repo is the only live copy.
