# RUNBOOK: operating the facilitator board

For an agent sitting behind the board. Read this cold and start; nothing else is assumed.

Facilitator is a board on your Mac for working with Claude Code or Codex agents. Each card is one point of discussion, a thread between you and one agent. Your messages wait in order for the agent of the card's project, and every message and reply is saved on the Mac. The board runs at `http://127.0.0.1:<port>`, where the port is the `port` in `run.config.json`: 8877 on a new install when it is free.

The folder you cloned holds three folders: `app/`, the program (this runbook is in it), `docs/`, the pages that tell people and their agents how to install, set up and use Facilitator, and `data/`, everything the board saves: cards and history (`state.json`, `transcript.jsonl`), `settings.json`, `profile.json`, `run.config.json`, `seed.json`, attachments, logs, magic boxes, the phone's sign-in, the push key and the board's own Python. git ignores `data/`, so none of it is ever committed or pushed. Every file named in this runbook without a folder, such as `run.config.json`, is in `data/`.

## Questions about using Facilitator

When someone asks how to install, set up or use Facilitator, read `docs/README.md` in the folder you cloned, open the page it names, answer from that page and name it. Do not answer from memory.

## The loop

From the agent conversation that owns your lane, repeat the current two-call production protocol. The installed `facilitator` skill resolves the lane and its `scripts/onboard.py wait` helper makes both calls for each claim. In every command here, `$PORT` is the board's port: the `port` that `scripts/onboard.py inspect` reports, which is the `port` in `run.config.json` (8877 unless `facilitator run` has moved the board to another pair). Read it fresh rather than remembering it, since a board that moved stays on its new port, and set it once in your shell (`PORT=8877`, say) or write the number in:

    curl --max-time 430 -sS "http://127.0.0.1:$PORT/wait?owner=facilitator&timeout=420&agent=claude"
    curl -sS -X POST "http://127.0.0.1:$PORT/ack?owner=facilitator&token=<the ack field>"

`agent=` names you; a card you answer shows that name on its ticket. `/wait` returns `{"box": id, "title": ..., "messages": [...], "queued_after": n, "ack": token}` on a claim, or `{"idle": true}` on timeout.

The `ack` token is the receipt for the card you were just handed, and confirming it is part of claiming, not an extra. A hand-off is provisional until you confirm it, because the answer can die on the wire: your own kill timer fires, the connection drops, and the server thinks it delivered a card nobody ever saw. Confirm it the moment the claim lands, before you start reading or working. A card nobody confirms goes back to the front of its lane's queue after 90 seconds and its colour falls back to the queued grey, so nothing sits green with nobody on it. Confirming twice is fine; the second call answers the same `{"ok": true}`.

WARNING: a loop without the confirm line claims cards it cannot keep. Every claim bounces back to the queue 90 seconds later and gets handed out again, forever, and your reply lands on a card you no longer hold.

After reading the separate `/fresh` result as described below, answer with a complete reply:

    curl -sS -X POST --data-binary @reply.txt "http://127.0.0.1:$PORT/reply?box=ID"

- `/wait?owner=...` claims the oldest queued box in your owner lane and marks it busy. Never leave a claim unanswered; an open claim blocks your whole lane (each owner has its own busy slot, see Owner routing below).
- Immediately before **every** `/reply`, including an interim or worker-completion reply, call `GET /fresh?owner=YOURLANE` and read its result before composing and sending. If it returns messages for the card you are answering, include them; those messages are folded into the held claim. If it names a different held card, handle that claim first and do not use its messages in a reply on another card. With no held card, `/fresh` returns an empty message list and hands over nothing; queued messages on other cards remain for their own claims. Do not combine a `/fresh` call with a prewritten reply in one command.
- Three nets sit under a claim, in order: a hand-off written into a dead socket rolls back at once, an unconfirmed claim returns after 90 seconds, and a claim older than 15 minutes is stolen back. Do not lean on any of them; confirm what you claim and answer what you confirm.
- Before going idle, and between the steps of any follow-up work, check whether anything is waiting on your lane: `GET /unread?owner=YOURLANE` answers `{"queued": N, "claimed": M}`, messages still waiting plus messages in the claim you hold. It reads only, so it is safe from a hook. Claim waiting cards before going on, and while workers run, listen with a short `timeout` so you can check on them between rounds. Paste this as a Stop hook command and go back to the loop instead of idling whenever `queued` is above zero:

      curl -s "http://127.0.0.1:$PORT/unread?owner=facilitator"

## Replies

- 100 to 150 words or fewer. Plain conversational tone: no coined shorthand, no unexplained jargon; a term either gets defined by what it concretely does or gets dropped. Paragraph breaks and short lists over walls of text. Depth comes from choosing what to say, not from length.
- Fit the shape to the content. A one-point answer is one or two plain sentences. When there are several points, open with the answer in one bold sentence, then list the points, each with a short bold lead-in. Bold only that sentence and the lead-ins, never a paragraph. Drop the structure when it would only pad the reply.
- No em dashes, in titles or in replies. Banned.
- Every reply fully self-contained. The box shows ONLY the latest reply, so a short follow-up ERASES a longer answer. Restate rather than reference, and name another card by its title, never by its id or a reply's time. A late reply, such as a worker's result, opens with one line naming the question it answers, and results from parallel workers go out as one reply.
- Answer what was asked and stop: no unsolicited offers, no "want me to" tails, no validation preambles.
- `POST /note?box=ID` consumes and releases a held claim. Do not use it for progress on a claim: later owner messages can be hidden until a full reply. For work that continues, register `/working`, keep its heartbeat current, and send a full `/reply` with the flag still live. That reply remains deferred until the work truly ends and the flag drops. Post the final reply first, while the flag is still on, and only then turn the flag off; turning it off first hands the card to the reader at once, so it shows a stale yellow card with the old reply until the final reply lands.
- Every card sits in one server-side state and the colour is a pure read of it. A normal reply under a live working flag lands the card in deferred, still green; the turn is handed over when the flag drops (`/working?box=ID&v=0`) or its heartbeat expires. A progress note stays in note until another event or the heartbeat ends.
- `POST /testing?box=ID&v=1` raises the ready-to-test marker: use it only once a delivered change is actually available for the reader to try, not because a merge is planned or a reply reads as finished. It is refused unless the card is awaiting the reader (a completed reply waits and no job runs), so it never marks active, queued or done work. `v=0` lowers it by hand; the reader answering the card, and close/done, lower it on their own. It only sets the flag: no reply, no claim, no move.
- A reply that closes a box carries zero new information, and one that parks a box (`POST /park?box=ID&v=1`) only restates what the card is, what is known and why it waits. Keep-in-mind notes go to an open box or the project docs.
- Never ask for a password or key on a card, since `transcript.jsonl` keeps every message; say where to put it instead.

## The magic box

Each card can have one magic box, for what a reply carries badly: a picture or a chart, a page you made, a website. Open one yourself whenever it would help the owner follow the card; nobody has to ask for it. The box waits on its card: it shows only when the owner is on that card, and on the Mac board only while the window leaves room for it beside the card (it never covers the card; in a narrower window it stays open, `show` still says `"open": true`, and it shows again once the window is wide enough). It never moves the board to the card, and it never takes the keys, so opening one never pulls the owner out of what they are typing. On the Mac board the box takes the size of what it shows, up to its largest: a page you made is sized to its own contents, so keep a page's body free of a full height (`height:100vh` or a centred full-screen layout) unless you want the whole box. The box is narrow: on the Mac board a page is laid out between about 220 and 400 pixels wide (400 when the window has room for the box at full size), so design a page to fit 360 pixels and shrink below that, with no fixed width or column minimum wider than the box (a page wider than the box scrolls sideways inside it, but nobody should have to). Use the `facilitator` command, which finds the board's port itself:

    facilitator magic m12 markdown --file notes.md --title "Release notes"
    facilitator magic m12 text "plain words, shown as typed"
    facilitator magic m12 image --file plot.png
    facilitator magic m12 image https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/OSIRIS_Mars_true_color.jpg/330px-OSIRIS_Mars_true_color.jpg
    facilitator magic m12 html --file page.html
    facilitator magic m12 url https://en.wikipedia.org/wiki/Mars
    facilitator magic m12 close

`-` in place of the content reads standard input; `reopen` shows a closed box again and `show` prints what it holds. The answer is one JSON line, `{"ok": true, "box": ..., "kind": ..., "rev": ..., "shown": ...}`; a refusal exits 1 with the board's own words. The same over HTTP: `curl -sS -X POST --data-binary @page.html "http://127.0.0.1:$PORT/magic?box=ID&kind=html&title=T"`, with `POST /magic/close?box=ID` and `POST /magic/reopen?box=ID` beside it.

- One box per card. A new one replaces what the box held and opens it; a closed box keeps what it held until it is replaced.
- The box is display only: nothing in it comes back to you. It has a bar with a cross at its right that lets the owner close the box (`show` then says `"open": false`, and filling it again opens it). Words that run long scroll inside the box. A `--title` is kept with the box and `show` prints it, but the board does not draw it.
- On the Mac board, Control + Option + right moves your keys into the box and Control + Option + left brings them back to the card (see [Browsing and selecting cards](../docs/board.md#browsing-and-selecting-cards)); it works only while the card on screen has an open box.
- A click or tap on the picture of an `image` box, or on a picture in a `markdown` box, opens it full screen with the same zoom, close and keys as a picture in a card, on the Mac board and the phone. On the Mac board the first click on a picture only selects the box and the next click opens it; the phone's box has no selected state, so a tap opens it at once. Pictures inside an `html` page stay the page's own.
- `text` is shown as typed and `markdown` as a card shows a reply. Both, and `html`, are limited to 1 MiB; a picture to 10 MiB (PNG, JPEG, GIF, WebP, or SVG without script).
- An `html` page runs its own script, sealed off from the board and with no network at all: no fetches, no forms, no outside pictures or fonts. Its buttons, fields, sliders and drawings work. It cannot focus anything until the owner has clicked or typed in it, and if a page or a website takes the keys anyway the board puts them straight back where the owner was. Put pictures and styles inline (`data:` addresses, `<style>`).
- `url` and web pictures take https addresses on the public internet only; this computer, the home network and the tailnet are refused. The board asks the site first. A site that allows it is shown live (`"shown": "frame"`); one that refuses to be framed, as Google, GitHub and MDN do, is shown as a square with the site's name, which opens the site in a new page when clicked, on the Mac in the owner's own Chrome (`"shown": "preview"`, `reason` saying why). The owner's logins never show in the box. A site shown live has no way from the box to open it in the owner's browser. Wikimedia serves only its standard thumbnail widths (330px and others); for another width the board refuses it with a 502 saying the site answered 400.
- Never put a password, key or private page in a box.

## Titles

A user-created box is auto-named with the chopped first line of its first message, which reads badly. When you claim such a box (title ends in "…" or just parrots the message), set a brief accurate title as part of answering it: `POST /title?box=ID`, raw text body. Keep titles short enough to sit on one line. Never set one longer than two lines: the card shrinks a title to keep it on two lines, and whatever still does not fit is cut off at the end of the second line and never seen.

## Status changes

- Only the owner closes. The agent flags duplicates and proposes merges; Done comes from the owner's hand or explicit word.
- A finding unrelated to the card's question goes on a new card (`POST /create?owner=YOURLANE`, the body's first line as its title), not into this card's reply.

## Permission blocks

Follow the current host's permission rules and the user's authorization in this session. A board card does not override a host restriction. If a step is blocked, complete permitted work, explain the blocked step and reason in the relevant reply, and keep the listener running when possible. Do not infer permission for pushes or destructive operations merely from these operating instructions.

## Restarts

- A restart re-queues claimed-but-unanswered messages. Expect duplicate deliveries; answer a repeated message with the same full answer, since a short reply would hide the real one.
- A stop is graceful: open requests get three seconds to finish and a listener waiting on `/wait` is answered `{"idle": true}` at once, so the loop simply asks again.

## Real work

Real work ships from boxes: delegate bounded builds and scans when delegation is available and authorized, and report results in the ordering box. Build only on a clear go: a reproducible bug report, or the person's pick from options you offered, is one; a described problem, a question, a short reaction or thinking aloud gets an answer instead. Weigh a worker's report before relaying it: decide the obvious choices yourself, drop caveats that change nothing, and check its conclusions against their sources and what the person saw. When a check disagrees with what the person saw, suspect the check; for what the board showed earlier, read `transcript.jsonl`, which keeps every event with its time. Follow the actual session's authorization for pushes and destructive operations. After work is finished and verified, stage and commit its changes when authorized.

## Delegation

The listener normally delegates substantive bounded work and stays responsible for the card, unless the owner asks it to do the work directly or the current host does not authorize delegation. The listener may do quick lookups and run simple commands itself; anything that turns into real digging, such as reading code or logs to find a cause, or into a change goes to a worker. Sort by the shape of the job before starting; a misjudged job need not be handed off halfway through. Answer a claim within moments: confirm it, raise the card's flag, start the worker, reply briefly and listen again; never hold a claim while setting work up.

Every worker brief carries six parts: the goal as one checkable sentence, with the person's request quoted word for word and neither narrowed nor widened; full context, since the worker starts knowing nothing; boundaries, what it must not touch and which neighboring work is someone else's; the output contract, the exact shape coming back; proof, the worker verifies its own work before reporting, with a check sized to the change (a driven browser or equivalent for what a person sees); and the house rules (plain words, no em dashes, no signatures, never restart the server, delete any probe box after use). Quality test: a stranger with no history could do the job right from the brief alone. Size the worker to the change too: a word or colour swap goes to a quick worker that runs only its own test.

Any work belonging to a card carries that card's green flag for exactly as long as it is happening: worker runs, but also verifying a worker's result, post-build checks, and committing that card's code after the claim is released. `POST /working?box=ID&v=1` before starting, `v=0` the moment the card's work truly ends. Post the final reply first, while the flag is still on, and only then turn the flag off; turning it off first hands the card to the reader at once, so it shows a stale yellow card with the old reply until the final reply lands. Green means exactly the machine's two green states: working (claimed right now, or that card's work happening anywhere) and deferred (the same, with a reply already waiting to become the owner's turn when the work ends).

Green is verified, not trusted: registration starts a heartbeat clock, and without `POST /ping?box=ID` at least every 75 seconds the green expires on its own, so a dead job can never leave a card stuck green. Keep a pinger beside any long job:

    ( while curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/ping?box=ID"; do sleep 30; done ) &

and kill it when the work ends. When `GET /limits` shows numbers, check it while workers run; near a limit, start no new worker and pause the running ones.

## Owner routing

Two agents share one board. Every box carries an owner tag: `facilitator` (discussion about this tool, served by this repo's agent) or a project lane such as `example` (the project under discussion, served by its own agent). `/wait?owner=...` claims only that owner's boxes, and each owner has its own busy slot and listener-presence tracking, so the two agents never block or steal from each other. An ownerless `/wait` defaults to facilitator. The server always registers the `facilitator` owner, so that default answers on a board whose `lanes` list is empty, but nothing is drawn for it until a card or a project gives it a tab: a fresh install's `run.config.example.json` has `"lanes": []` and `"navigator_lanes": []`, and no board begins with a lane nobody made. The two loops, side by side:

    curl --max-time 430 -sS "http://127.0.0.1:$PORT/wait?owner=facilitator&timeout=420&agent=claude"
    curl --max-time 430 -sS "http://127.0.0.1:$PORT/wait?owner=example&timeout=420&agent=claude"

Each lane confirms its own claims against its own owner: `POST /ack?owner=facilitator&token=...` and `POST /ack?owner=example&token=...`. A token belongs to one lane's claim and is refused (409) anywhere else.
