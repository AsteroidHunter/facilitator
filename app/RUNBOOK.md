# RUNBOOK: operating the facilitator board

For an agent sitting behind the board. Read this cold and start; nothing else is assumed.

Facilitator is a board on your Mac for working with Claude Code or Codex agents. Each card is one point of discussion, a thread between you and one agent. Your messages wait in order for the agent of the card's project, and every message and reply is saved on the Mac. The board runs at `http://127.0.0.1:<port>`, where the port is the `port` in `run.config.json`: 8877 on a new install when it is free.

The folder you cloned holds two folders: `app/`, the program (this runbook is in it), and `data/`, everything the board saves: cards and history (`state.json`, `transcript.jsonl`), `settings.json`, `profile.json`, `run.config.json`, `seed.json`, attachments, logs, magic boxes, the phone's sign-in, the push key and the board's own Python. git ignores `data/`, so none of it is ever committed or pushed. Every file named in this runbook without a folder, such as `run.config.json`, is in `data/`.

To install, run `./install.sh` in the downloaded folder. It needs Claude Code or Codex, Google Chrome (the board runs as its own Chrome window) and macOS 11 or later, and stops without changing anything if Chrome, or both Claude Code and Codex, are missing. It sets up a private Python and the board's packages, each pinned to an exact version, and never changes your own Python. It writes `run.config.json` and `seed.json` only when they are missing. It asks whether you want the phone client, and on yes checks with you that Tailscale is set up (see "The phone page and the bridge") and asks for a phone password. It says when Chrome's graphics acceleration is on; when it is off, it offers to turn it on with Chrome closed, or with Chrome open shows where to turn it on and never quits or waits for Chrome. Last, it adds the `facilitator` command and the agent skill and prints the next steps. It is safe to run again. Run without a terminal, it asks nothing and skips the phone client.

`facilitator uninstall` (or `./uninstall.sh`) removes only what the installer added, and keeps your cards, settings, phone sign-in data and any config you changed. It asks whether to keep card attachments: Enter keeps them, and only a clear no removes them (`--keep-attachments` or `--remove-attachments` answers ahead of time). It has no dry run.

`facilitator update` brings the folder up to date with one command. On a folder from before `data/`, where the board kept its files at the top and its attachments and logs in a `facilitator-internal` folder beside it, the update first moves them into `data/`, once. It backs everything up into `data/backups/` first, copies each file and checks it by checksum, and removes an old copy only after the board, started again on the new code, shows every card it had. Until the move is done the board does not start, and every other command says to run `facilitator update`; running it again finishes a move that was cut off.

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
- Before going idle, check whether anything is waiting on your lane: `GET /unread?owner=YOURLANE` answers `{"queued": N, "claimed": M}`, messages still waiting plus messages in the claim you hold. It reads only, so it is safe from a hook. Paste this as a Stop hook command and go back to the loop instead of idling whenever `queued` is above zero:

      curl -s "http://127.0.0.1:$PORT/unread?owner=facilitator"

## Replies

- 100 to 150 words or fewer. Plain conversational tone: no coined shorthand, no unexplained jargon; a term either gets defined by what it concretely does or gets dropped. Paragraph breaks and short lists over walls of text. Depth comes from choosing what to say, not from length.
- Fit the shape to the content. A one-point answer is one or two plain sentences. When there are several points, open with the answer in one bold sentence, then list the points, each with a short bold lead-in. Bold only that sentence and the lead-ins, never a paragraph. Drop the structure when it would only pad the reply.
- No em dashes, in titles or in replies. Banned.
- Every reply fully self-contained. The box shows ONLY the latest reply, so a short follow-up ERASES a longer answer. Restate rather than reference.
- Answer what was asked and stop: no unsolicited offers, no "want me to" tails, no validation preambles.
- `POST /note?box=ID` consumes and releases a held claim. Do not use it for progress on a claim: later owner messages can be hidden until a full reply. For work that continues, register `/working`, keep its heartbeat current, and send a full `/reply` with the flag still live. That reply remains deferred until the work truly ends and the flag drops. Post the final reply first, while the flag is still on, and only then turn the flag off; turning it off first hands the card to the reader at once, so it shows a stale yellow card with the old reply until the final reply lands.
- Every card sits in one server-side state and the colour is a pure read of it. A normal reply under a live working flag lands the card in deferred, still green; the turn is handed over when the flag drops (`/working?box=ID&v=0`) or its heartbeat expires. A progress note stays in note until another event or the heartbeat ends.
- `POST /testing?box=ID&v=1` raises the ready-to-test marker: use it only once a delivered change is actually available for the reader to try, not because a merge is planned or a reply reads as finished. It is refused unless the card is awaiting the reader (a completed reply waits and no job runs), so it never marks active, queued or done work. `v=0` lowers it by hand; the reader answering the card, and close/done, lower it on their own. It only sets the flag: no reply, no claim, no move.
- A reply that closes or parks a box carries zero new information. Keep-in-mind notes go to an open box or the project docs.

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
- On the Mac board, Control + Option + right moves your keys into the box and Control + Option + left brings them back to the card (see Browsing and selecting cards); it works only while the card on screen has an open box.
- A click or tap on the picture of an `image` box, or on a picture in a `markdown` box, opens it full screen with the same zoom, close and keys as a picture in a card, on the Mac board and the phone. On the Mac board the first click on a picture only selects the box and the next click opens it; the phone's box has no selected state, so a tap opens it at once. Pictures inside an `html` page stay the page's own.
- `text` is shown as typed and `markdown` as a card shows a reply. Both, and `html`, are limited to 1 MiB; a picture to 10 MiB (PNG, JPEG, GIF, WebP, or SVG without script).
- An `html` page runs its own script, sealed off from the board and with no network at all: no fetches, no forms, no outside pictures or fonts. Its buttons, fields, sliders and drawings work. It cannot focus anything until the owner has clicked or typed in it, and if a page or a website takes the keys anyway the board puts them straight back where the owner was. Put pictures and styles inline (`data:` addresses, `<style>`).
- `url` and web pictures take https addresses on the public internet only; this computer, the home network and the tailnet are refused. The board asks the site first. A site that allows it is shown live (`"shown": "frame"`); one that refuses to be framed, as Google, GitHub and MDN do, is shown as a square with the site's name, which opens the site in a new page when clicked, on the Mac in the owner's own Chrome (`"shown": "preview"`, `reason` saying why). The owner's logins never show in the box. A site shown live has no way from the box to open it in the owner's browser. Wikimedia serves only its standard thumbnail widths (330px and others); for another width the board refuses it with a 502 saying the site answered 400.
- Never put a password, key or private page in a box.

## Titles

A user-created box is auto-named with the chopped first line of its first message, which reads badly. When you claim such a box (title ends in "…" or just parrots the message), set a brief accurate title as part of answering it: `POST /title?box=ID`, raw text body. Keep titles short enough to sit on one line. Never set one longer than two lines: the card shrinks a title to keep it on two lines, and whatever still does not fit is cut off at the end of the second line and never seen.

## Status changes

- Only the owner closes. The agent flags duplicates and proposes merges; Done comes from the owner's hand or explicit word.
- "TBDL" from the owner means: move it to Deferred AND record the deferred work in the relevant project doc.

## Permission blocks

Follow the current host's permission rules and the user's authorization in this session. A board card does not override a host restriction. If a step is blocked, complete permitted work, explain the blocked step and reason in the relevant reply, and keep the listener running when possible. Do not infer permission for pushes or destructive operations merely from these operating instructions.

## Restarts

- A restart re-queues claimed-but-unanswered messages. Expect duplicate deliveries; answer "already handled, restart re-queue".
- A stop is graceful: open requests get three seconds to finish and a listener waiting on `/wait` is answered `{"idle": true}` at once, so the loop simply asks again.
- `facilitator stop` ends the board and closes its window, saying `Board stopped.` (or `Board was not running.`). Everything saved is kept. A board that will not stop is left alone and the command names `--force`, which ends it at once. A board tab beside other Chrome tabs stays open. With a phone password set, it also turns the phone link off. `--dry-run` shows what it would do. Do not run it while `facilitator run` or `facilitator restart` is still starting the board.

## The log

The board writes its own dated log files into `data/logs`, which never goes into the repository, and they record only what the board did, never anyone's words, keys, file paths or email addresses.

A new install logs errors only (`"log_level": "error"` in `run.config.example.json`), so for the server, bridge and phone logs the folder gains a file only when something goes wrong; a `run.config.json` with no `log_level` keeps logging at info, and `FACILITATOR_LOG_LEVEL` or `"log_level": "debug"` turns on full diagnostics.

## Real work

Real work ships from boxes: delegate bounded builds and scans when delegation is available and authorized, and report results in the ordering box. Follow the actual session's authorization for pushes and destructive operations. After work is finished and verified, stage and commit its changes when authorized.

## Delegation

The listener normally delegates substantive bounded work and stays responsible for the card, unless the owner asks it to do the work directly or the current host does not authorize delegation. The listener may do quick lookups and run simple commands itself; anything that turns into real digging, such as reading code or logs to find a cause, or into a change goes to a worker. Sort by the shape of the job before starting; a misjudged job need not be handed off halfway through.

Every worker brief carries six parts: the goal as one checkable sentence; full context, since the worker starts knowing nothing; boundaries, what it must not touch and which neighboring work is someone else's; the output contract, the exact shape coming back; proof, the worker verifies its own work (driven browser or equivalent) before reporting; and the house rules (plain words, no em dashes, no signatures, never restart the server, delete any probe box after use). Quality test: a stranger with no history could do the job right from the brief alone.

Any work belonging to a card carries that card's green flag for exactly as long as it is happening: worker runs, but also verifying a worker's result, post-build checks, and committing that card's code after the claim is released. `POST /working?box=ID&v=1` before starting, `v=0` the moment the card's work truly ends. Post the final reply first, while the flag is still on, and only then turn the flag off; turning it off first hands the card to the reader at once, so it shows a stale yellow card with the old reply until the final reply lands. Green means exactly the machine's two green states: working (claimed right now, or that card's work happening anywhere) and deferred (the same, with a reply already waiting to become the owner's turn when the work ends).

Green is verified, not trusted: registration starts a heartbeat clock, and without `POST /ping?box=ID` at least every 75 seconds the green expires on its own, so a dead job can never leave a card stuck green. Keep a pinger beside any long job:

    ( while curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/ping?box=ID"; do sleep 30; done ) &

and kill it when the work ends.
## Who can reach the board

Only your own Mac can use the board: its address works only on this Mac, and it refuses any request another website sets off. Another site may open the board's page but cannot change anything or show the board inside its own page. The phone reaches the board only through the phone link, which needs the phone password. A magic box can be filled only from the Mac itself; a signed-in phone can see one and close it. The files the board keeps about your work, attachments and logs included, can be read only by your Mac account.

## Owner routing

Two agents share one board. Every box carries an owner tag: `facilitator` (discussion about this tool, served by this repo's agent) or a project lane such as `example` (the project under discussion, served by its own agent). `/wait?owner=...` claims only that owner's boxes, and each owner has its own busy slot and listener-presence tracking, so the two agents never block or steal from each other. An ownerless `/wait` defaults to facilitator. The server always registers the `facilitator` owner, so that default answers on a board whose `lanes` list is empty, but nothing is drawn for it until a card or a project gives it a tab: a fresh install's `run.config.example.json` has `"lanes": []` and `"navigator_lanes": []`, and no board begins with a lane nobody made. A lane is added to `run.config.json` by hand as `{"owner": "myproject", "tmux": "<tmux session>", "dir": "~/projects/myproject", "instruction": "<what to type to attach its agent>", "prompt": "<what a new agent session starts with>"}`: `owner` is required, `tmux` and `instruction` are what `facilitator run --attach` uses, `dir` and `prompt` are what `--spawn` uses, and `dir` is also the folder the board shows for that lane. A project added from the home page needs no lane entry. Nothing rewrites an existing `run.config.json`, so a board that has lanes keeps them. The two loops, side by side:

    curl --max-time 430 -sS "http://127.0.0.1:$PORT/wait?owner=facilitator&timeout=420&agent=claude"
    curl --max-time 430 -sS "http://127.0.0.1:$PORT/wait?owner=example&timeout=420&agent=claude"

Each lane confirms its own claims against its own owner: `POST /ack?owner=facilitator&token=...` and `POST /ack?owner=example&token=...`. A token belongs to one lane's claim and is refused (409) anywhere else.

## The ticket list

The ticket list beside the card, on the Mac board and the phone, has four sections: Doing for what is active, Docked for the current sprint, Deferred for a later sprint, and Done. Doing and Docked show first; the small triangle beside Docked switches to Deferred and Done, and back. Press a section's name to show its list.

On the Mac board, the plus under the ticket list makes a new card, exactly as Command + T does. The list is only as tall as its tickets need, up to its full height, and the plus stands under its foot.

A ticket is green while an agent is working on its card, grey while your message waits for an agent to pick it up, and has a darker title while a reply is unread. A folded corner means the agent says a change is ready for you to try; a click on the corner, or Control + U, clears it.

Docked, Deferred and Done list the latest arrival first. Doing lists new cards on top, then the cards waiting on you, oldest first (Settings, Appearance, "Cards waiting on you" turns them to newest first), then the cards queued or being worked on.

Each card has four buttons in its top bar: a sun for Doing, a sun behind a cloud for Docked, a moon for Deferred and a cross for Done; the one for the card's own section is faded. The keys are Control + Shift + [ for Doing, Control + Shift + ] for Docked, Control + Shift + \ for Deferred and Control + Shift + Backspace or Delete for Done, and they work while typing. When you are not typing, [, ] and \ alone do the first three. Plain Backspace and Delete never mark a card Done. After you move the card on screen, the next card in the section it left shows. A new message from you brings a Docked or Deferred card back to Doing.

On the Mac board, in the Done section only, a garbage can shows just left of a ticket while the pointer is over it or the paper beside it. Doing, Docked and Deferred never show it. One click on the can deletes that card at once, with no menu and no question: it leaves every section and goes to the Bin on the settings page (see "The settings page"), and if it was the card on screen, the next card in its section shows. There is no key for it yet, and the phone has no can. A card in the Bin keeps its thread, attachments, queued messages and magic box, but no agent is handed it and no page or phone shows it; a claim held on it is let go with its messages still waiting, and a reply sent to it is refused. After 30 days in the Bin the board deletes it for good, checked when the board starts and once a day.

## The board's settings

The Mac board's settings (the background colour, the switches on the settings page, the chime's mute and where the board's boxes sit) belong to the board, not to one browser, so another browser, or the board after a port move, shows them the same. Each window keeps its own open card and project. The phone keeps its own settings, apart from the two it shares with the Mac (see "The settings page").

## The Mac board's top bar

Along the top of the Mac board, from the left: a Home button, which opens the home page and stays pressed while it is open; a pill with the open project's name (while the home page is up, the name of the project you came from, with a down chevron after it); and a few faint project names. At the right end, evenly spaced, the speaker mutes the reply chime, the bug opens the feedback box on its own (see "Improvements" under the settings page below), and the squid opens the settings page.

Click the pill to open the list of every open project, in your order, each with its number (the one Command + 1 to 9 opens it by), and the ones holding unread replies in bold. Click a project to switch to it. Rest the pointer on a row and a cross shows at its right end that closes that project (the last one stays open). Hold a row and drag it up or down to reorder the projects; drag it out of the list and let go to open that project in a window of its own. "Open a new folder", the last row, opens the Mac's folder chooser and adds the folder as a project. Escape or a click outside closes the list. Closed projects come back from the home page. On the home page, a click on the pill's name opens the project you came from, and a click on the chevron after the name opens the list, with no project checked.

The faint names beside the pill are open projects with unread replies that were active in the last 7 days, newest first. When there are none, they are the 3 with the most unread replies, then the most recently active. The project you just left is always first, and there are never more than 4. On the home page the project you came from is the pill's name, so it is not among them. Click one to switch to it: it moves into the pill and the project you left appears first beside it.

Command + 1 to 9 opens the projects in the list's order.

## The home page

The Home button at the left of the top bar opens the home page, above every project. A board with no project open starts there. The phone has the same page, opened from Home at the top of its project list.

The left half lists your projects. Click one to open its board (a closed one opens again). "Open a new folder" opens the Mac's folder chooser and adds the folder as a project.

The right half shows "Token consumption per day": the tokens Claude Code and Codex have used on this Mac each day, as a heatmap of the last 365 days (a calendar of shaded squares) or a line chart of this year so far, January 1 to today, picked with the switch in its corner. Scroll or drag sideways for earlier weeks, and point at a day for its numbers. The counts are read from the logs Claude Code and Codex already keep on this Mac; only the counts are kept. `token_logs` in `run.config.json` can point at other log folders, or turn a tool off with an empty list.

The download button beside the switch saves the chart on show as a high resolution PNG (3:1 for the heatmap, 2:1 for the line) of the whole range with the Facilitator name on it, and on the line also marks the day this board first started; the Mac downloads it and the phone opens its share sheet.

Under it, "Usage Limits" shows how much of each plan limit is used, with when it was last updated: Claude 5-hour, Claude weekly, Codex 5-hour and Codex weekly, each only when there is a number. Codex's come from Codex itself. Claude's come through Claude Code's status line, which the installer does not set up: add `"statusLine": {"type": "command", "command": "python3 <folder>/claude-statusline.py"}` to `~/.claude/settings.json`, where `<folder>` is the folder this RUNBOOK is in (`app/` in the folder you cloned). To keep a status line you already have, put its command after the script as one quoted argument. Claude Code sends limits only on Pro and Max plans, after a session's first reply.

## Browsing and selecting cards

A card on screen is either browsed or selected, on the Mac board and the phone alike. Browsing (the arrow keys, a swipe on the phone, switching projects, opening the board) shows a card without marking it read. Selecting (Enter, or a click or tap on the card or its ticket) marks it read, and so does typing in it. A reply that lands on the selected card counts as read only while the board's window is in front. The ticket of the card on screen is always lifted, so the list shows where you are. A double click on the empty board (on the phone, a double tap on the margin round the card) lowers the open card; showing any card raises it again.

An empty typing box shows a light-hearted line in grey. A card keeps its line until a message is sent on it, then takes a new one, drawn at random from a shuffled bag of the twenty so none comes back until all have been shown. Each device keeps its own lines (in the browser's localStorage), and a card that is deleted loses its entry.

The keys, on the Mac board and on the phone with a paired keyboard:

- Left and right arrows: the previous or next card. Control + Shift + left and right do the same while typing.
- Enter: select the card and start typing. In the typing box, Enter sends, Shift + Enter starts a new line, and Command + Enter sends without moving.
- Enter twice, or Control + Shift + Enter: send, then go to the card that has waited longest on you (with nothing typed, Control + Shift + Enter only moves). Control + Enter alone is not bound: on an iPhone with a keyboard the system opens its copy menu on it. On the phone, Enter twice sends and then opens the card list.
- Escape: leave the typing box, then let go of the card; it also closes a menu or a picture.
- Control + R: a random card from the list that is neither being worked on nor waiting for an agent.
- Control + Shift + up and down: the card's older and newer replies.
- Control + S: hold to scroll the answer down, faster the longer you hold; tap and then hold to scroll up. With your keys in the card's magic box (put there by Control + Option + right, or by a click in it) it scrolls the box instead, its words or a page an agent made, the same way; with your keys on the card it is the card that scrolls.
- Control + U: clear a ticket's ready-to-test corner.
- Control + Shift + [ , ] , \ and Backspace or Delete: move the card to Doing, Docked, Deferred or Done.
- Control + Shift + ' and ;: the next or previous section of the ticket list.
- Command + T: a new card. Command + 1 to 9: switch project, in the order of the pill's list. Command + 0 (the Mac board and the installed phone app; a Safari tab does not take it, because Safari on iPad uses it to reset zoom): the home page, as the Home button does; it works while typing and does nothing on the home page.
- Tab: steps from the card's title to its typing box to the card itself, and round; Shift + Tab goes the other way. On a card that already has a title, the first Tab goes to the typing box, and so does the first Tab after you come back to the card or click it.
- Control + Option + up and down: move between the card's title, its answer and its typing box, top to bottom. Up goes from the typing box to the answer to the title, down comes back, and they stop at either end; with nothing focused, up goes to the answer and down to the typing box. In the answer a caret stands that types nothing: Shift with the arrows selects, with Option a word at a time and with Command to the end of a line or of the answer; Command + A selects the whole answer and nothing else; Command + C copies. Escape or a click elsewhere leaves it. While Apple's screen reader is on, it takes these keys.
- Control + Option + right and left: right moves your keys into the card's magic box, as a click in it would, when the card on screen has one open, whether you are on the bare card or typing in its typing box; the box becomes the raised one and the card settles, and the box's own keys work there (Control + S scrolls its words or its page, Command + A selects its words). Left brings you back to exactly where you were on the card: the typing box with its caret and selection where they were, or the card itself if you were not typing. With no box open on the card, or left when your keys are not in the box, nothing happens and the key is left alone. If you have clicked or tabbed into a page an agent made, left still brings you back; a website in the box keeps every key typed in it to itself, so there left cannot be heard and a click on the card brings you back. While Apple's screen reader is on, it takes these keys.
- On the phone, Control + Shift + comma opens and shuts the card list; with it out, up and down walk the tickets, Enter selects the lifted one and shuts the list, and Escape just shuts it.
- On the phone, Control + Shift + period opens and shuts the card's magic box the same way. Either key swaps out whatever else is open: the card list, the box or the settings. Between the list and the box the card stays down, and one takes the other's place. On a card with no magic box the period opens nothing, and the card bounces to show the key was heard.

The keys with Command or Control also work from a card's typing box and title. The board turns off Chrome shortcuts that would get in the way, such as Save Page, Print, zoom and new tabs; Command + F still finds and Command + R still reloads.

A link in a reply opens a small menu with Copy link and Open in browser (an ordinary Chrome window on the Mac, the phone's browser on the phone); an attachment's link adds Download. A click or tap on a picture shows it large: on the phone as large as the screen holds, on the Mac in the Settings window's place. Pinch it, on the phone's screen or the Mac's trackpad, to zoom up to four times; zoomed, drag it or scroll with two fingers to look around. A double tap or double click zooms to twice at that point and back. At its fitted size a click or tap puts it back; zoomed, Escape does, which works at any size. On the phone, hold a finger on a picture for its menu.

## Seeing a card's magic box

An agent can open a magic box beside a card to show you a picture, a chart, a page it made or a website. It shows only while you are on that card, and it never takes your keys. On the Mac board, Control + Option + right puts your keys in it, as a click would, and Control + Option + left puts them back on the card, in your typing box where you were typing. On the Mac board it stands beside the card and never over it: in a window too narrow to give it room there, it is not shown, and it comes back by itself as soon as the window is wide enough again. On the phone, on a card that has one, a pull from the right edge, right to left, brings it out above the card; Control + Shift + period brings it too. On the Mac board, whichever of the card and the box you last clicked into is shown in full and the other is faded; a card with no box never fades. On the phone the box is for reading only. The box takes the size of what it shows, and long text scrolls inside it. On the Mac board that holds for every kind, up to the box's largest size: a picture in its own shape, text at its own height, and a page an agent made at the height of its own contents (a website, which the board cannot measure, keeps the full size). Also on the Mac board, two dashed lines join the card to its box, one about a tenth of the box's height (52/488, as picked on the mock's box) down from its top and one the same share up from its bottom, so they keep the same look on a box of any size. The box has a bar with a cross at its right, which closes the box until an agent fills it again. On the Mac board, in a portrait window too, the bar is at the box's top; on the phone it is at the box's bottom, so the cross is in the box's bottom right corner. A website that will not be shown inside the box appears as a square with its name, and a click on it opens the site in a new page, on the Mac in your own Chrome.

## The settings page

On the Mac board, the squid at the right end of the top bar opens the settings page over the board; the red button at its top left, Escape, or a click outside closes it. Its sections, in this order:

- Profile: a picture (one of twelve small animal, face and object drawings, with no name shown, drawn at random the first time Settings asks on this Mac, then kept in the profile for good and never sent anywhere; nothing to click yet) with Name and Email beside it, then Work, Main agent and your time zone, written out as in "Pacific Time, UTC−7". The email is the yes to feedback emails and there is no switch for it (see "Usage counts").
- Appearance: the background colour, and "Cards waiting on you", which lists the cards waiting on you newest first instead of oldest first.
- Editor: "Format text while typing", off unless you turn it on.
- Improvements: "Share Feedback", with the line "Encountered bugs? Have feature requests or questions? Please tell us how we can improve." and a feedback box under it, above "Share daily usage counts", which is on unless you turn it off (see "Usage counts"). The box is greyed out until your Profile has a name and an email; type a message, press the arrow (or Enter) and you have three seconds to press the cross and cancel before it is sent with your name and email, and "Sent. Thank you." shows under the box. The bug in the top bar opens this same box, alone, in the middle of the window over the same dark shade as Settings: it holds the title, the line and the box and nothing else, and a click anywhere outside it (or Escape) puts it away. It is the one box, so closing it keeps what you typed for next time and a send already counting down carries on.
- Bin: the cards the garbage can beside the tickets deleted, newest first, each with its title, its project and when it was deleted, and a restore icon (an arrow curling back, titled Restore) that shows at the row's right end while the pointer is on or near the row and puts the card back in its own place and section, whole. A card is deleted for good after 30 days here, and nothing empties the Bin sooner.

On the phone the settings are in a drawer, and only the squid on the bottom row opens it: no pull and no key does. A pull from the right edge brings a card's magic box, and on a card without one it does nothing. The drawer's sections are Profile, Appearance, Editor, Notifications and Improvements; there is no Bin, since only the Mac restores deleted cards. Improvements holds the same feedback box (it is sent by the Mac) above "Share daily usage counts"; the phone has no bug in its bottom row, and its box is set at 16px so that tapping it does not zoom the page in. "Cards waiting on you" and "Share daily usage counts" (with the same caption) are shared with the Mac; the profile is only shown, since it is changed on the Mac: its picture, name, email, work, main agent and the time zone in plain words, with no feedback switch. The power mark at the bottom of the drawer signs the phone out. A tap beside the drawer, or a swipe to the right, puts it away.

A new install starts with a white background and plain typing. To change those starting points wherever nobody has chosen, set `"background_default"` (a colour such as `"#ffffff"`) or `"compose_format_default": true` in `run.config.json` and run `facilitator restart`. A choice made on the settings page always wins.

## The onboarding and the profile

Each Mac board asks a few questions once, the first time it opens (or on an older board with no profile yet), and they cover the board until they are done. The phone is never blocked by them.

It is a run of real cards: Welcome (the Facilitator mark as its header, then "Hi there 👋", one line about the app and the right arrow for the next card), one card titled "Let's onboard you onto the Facilitator!", four short cards: 101: Atomizing asks, 101: Tickets, 101: Hotkeys and 101: Phone App (a picture slot, then how to set up the phone app with `facilitator bridge setup`; the words are the constant `PHONE_APP` in `onboarding.html`, and the picture is a grey stub box, `PHONE_IMAGE` in the same file, to be swapped for the real picture), and a last card titled "You are all set up" that thanks you and asks for bugs and feedback through the bug button in the top-right corner. Right arrow, or Control + Shift + right while typing, goes to the next card. The cards after the onboarding card open only once every question is answered: a move to them before that, by any key or click, stays on the onboarding card and shows the current question's short line. The ticket list beside the card stays hidden until 101: Tickets, then shows and stays.

The onboarding card asks its questions one after another as its replies: What should we call you?, What's your email?, What will you mostly use Facilitator for? and Which agent do you use most?. Tab goes to the reply box and Enter sends; each answer brings the next question. Every question must be answered: Enter with the box empty keeps the question and shows one short line asking for its answer, and so does an email with no @ or no dot after it. Giving an email is saying yes to feedback emails. The time zone is read from the Mac. The last reply lists every answer and says how to change one and how to go to the next card.

Each reply is a page of the card's history and belongs to the question on it. To change an answer, go back to its question with Control + Shift + up and send a new one: it replaces the old answer, and the card returns to where you were and says what changed. Control + Shift + down steps forward again.

With the first answer a keyboard shows at the foot of the card and stays for the rest of the onboarding. It lights the keys a card teaches: left Control, left Shift and up, then left Control, Shift and right, on the onboarding card's last reply, and each chord in turn on 101: Hotkeys, Command and T first (that card, like 101: Phone App, goes on with Control + Shift + right). With the pointer over a key's name on a card, those keys light too.

The onboarding also makes a sample project, a folder named `facilitator-sample` in your home folder (an existing one is never touched), and opens it as your first project. While the last card shows, the board's three top-right buttons fade in, in their exact place on the board: the speaker, the bug and the settings squid (the onboarding's white page covers the board's own bar, so the page draws them, and the board's bar takes over with no jump when the board opens). The speaker and the squid are greyed and cannot be pressed; the bug is at full strength and opens the board's Share Feedback sheet. It works because your answers are saved as your profile as soon as the summary card ("Here is what you told us") is passed, which is what wakes the Share Feedback box (it is greyed, and the server refuses a send, until the profile has a name and an email); the board is told, so it keeps the onboarding up until the last card is done even though the profile now exists. A change to an answer is saved again when the summary card is passed again. The buttons are not shown on any card before the last. Marking the last card, "You are all set up", Done (Control + Shift + Backspace or its cross) saves your answers again and shows the sample project's board; with an answer missing it goes back to the first question not answered instead, and asks for that answer with the same short line (on the first question, the name, it shows the Tab hint again).

Your answers are your profile, kept on the Mac where only your account can read them, and changed in Settings, Profile on the Mac: a field is saved when you leave it, and giving an email there is the same yes as giving one in the onboarding, while clearing the email takes the yes back. What leaves the Mac is under "Usage counts".

## Usage counts

Once a day the board sends one message of counts about the day before to the Facilitator project in PostHog (in the US), under a random id made for this install. The counts come from what the board already keeps, never read for their words: messages sent, cards made and closed, projects added, agent replies (split into Claude, Codex or other), minutes used and whether the phone app was opened. A day is sent only if the board was used, and only once. The switch is "Share daily usage counts" in Settings, Improvements, on the Mac or the phone; a day that ends while it is off is never sent.

What leaves the Mac, exactly:

- Every used day, unless the switch is off: one message of counts, the app version and the main macOS version number, under the install id. Never a word anybody typed, a name, a card title, a folder or a path.
- Only after a yes to feedback emails (an email given, in the onboarding or in Settings, Profile; there is no switch for it), and only while the "Share daily usage counts" switch is on: your email, name, what you will mostly use Facilitator for, your main agent and your time zone, each only if given. They go once, at the yes; after that, an answer you change goes again on its own, and one you clear is removed there.
- Taking the yes back, by clearing the email in Settings, Profile, sends nothing more, and the Mac forgets your email and answers; what PostHog already holds stays there. A later yes sends them all again.
- With the switch off nothing leaves, the profile included, except a message you write in the feedback box and send.
- Without the yes, the profile never leaves the Mac.
- A message from the feedback box in Settings, Improvements: the one thing sent with words. Only when you press send and let the three seconds to cancel pass (text only, at most 5000 characters), as one "feedback sent" event under the install id with your name and email attached to it. It goes whether or not the switch is on, because sending feedback is its own choice, and its words are never written to a log.

## The reply chime

The Mac board plays a soft two-note bell when an agent's reply makes a card your turn; a burst of replies rings once. While the board's window is in front, replies on the project you are looking at stay quiet. Chrome lets a page play sound only after a click or key press in it, so the chime works from your first one. The speaker at the right end of the top bar mutes it. The phone gets notifications instead (see "The phone page and the bridge").

## Seeding a board

A new board starts with no cards, and the onboarding opens the sample project. To start a brand new board with cards of your own, put them in `data/seed.json` before its first start: a `title` for the board and an `items` list with one entry per card, such as `{"id": "1.1", "bucket": "must", "owner": "myproject", "title": "Fix the login timeout", "context": "the card's first reply"}`. `id`, `bucket` and `title` are required, and every seeded card starts in Doing; `owner` is the lane it belongs to (`facilitator` when left out), and `context` is optional. The file is read only at the very first start.

## Bringing everything up

`facilitator run` starts the board if it is not running, opens it in its own Chrome window and, once a phone password is set, turns the phone link on. It prints `Board up on http://127.0.0.1:<port>` and `Facilitator is live!`, plus one line if the phone link could not come up. A new install's window opens full screen (`"app_fullscreen": true` in `run.config.json`); if Chrome was already running it may not, and Control + Command + F fixes that. `--attach` types each lane's attach instruction into its tmux session, `--spawn` also starts agent sessions where none can be reached (see "Owner routing"), and `--dry-run` describes a run without doing it.

The board uses two ports: the `port` in `run.config.json` and the one above it, for the phone. If another program holds either, `facilitator run` moves the board to the next free pair, writes the new port into `run.config.json`, says so in one line and points the phone link there too. The board stays on its new port. Its settings come along, but a window open at the old address cannot reach it. The other commands read the port from `run.config.json`, so they follow a move.

`facilitator restart` restarts only the board's server, making sure it stops this board's own server and nothing else. It says `Board restarted.` (or `Board started.`), and adds `Reload the board (command + R).` when a board window is open. It leaves agents, the phone link and the port alone. When the board is running on a port the config does not name, it says so, names both ports and starts nothing, since `facilitator run` is what brings the two together. `facilitator stop` is under "Restarts". `facilitator status` prints a one-line summary.

`facilitator update` brings the app up to date, so nobody has to use git by hand. It stops without changing anything when files in the app's folder have been edited, or the folder is not on a git branch linked to its online copy. Otherwise it pulls the new version (moving forward only, never merging), updates the board's private Python and packages, runs any new update steps, and restarts the board if it was running and something changed. It ends with the old and new version and a reminder to reload the board and reopen the phone app.

## The phone page and the bridge

The phone app is the board on your phone, one card at a time, reached privately over Tailscale.

Setting it up: it needs Tailscale signed in on the Mac and the phone, HTTPS certificates switched on for your Tailscale network (in the Tailscale admin console, under DNS: turn on MagicDNS and allow HTTPS Certificates), and a phone password, which the installer asks for and `facilitator password set` sets or changes. Someone who said no to the phone client at install can run `facilitator bridge setup` at any time: it shows the installer's banner and then only the installer's Mobile app step, with the same questions, and it does not turn the link on. `facilitator bridge on` turns the phone link on and prints a QR code for the phone page, `facilitator bridge off` turns it off, and `facilitator bridge` switches it; `--dry-run` shows what would change. Once a password is set, `facilitator run` turns the link on and `facilitator stop` turns it off by themselves. Only devices on your own Tailscale network can reach the link, never the open internet. When something else already uses the Mac's Tailscale web address, the command says so and changes nothing.

Signing in: scan the QR code with the phone and open it in Safari, which shows how to add the app to the Home Screen. The Home Screen app asks for the password, then stays signed in, through closing the app and restarting the board, until you sign out (the power mark at the bottom of the settings drawer) or the password is changed. The Mac keeps only scrambled forms of the password and sign-ins.

Using it: the card fills the screen, with four buttons along the bottom. The ticket circle opens the card list; the project oval names the open project and opens the project list (Home first; hold a row and drag to reorder); the plus makes a new card; the squid opens the settings drawer. Pulling the card from the left edge also opens the card list, and pulling from the right edge opens the card's magic box when it has one. Tap a ticket to show its card; tap the card or the ticket circle to shut the list. Swipe sideways on the card to step through cards. The card works like the Mac's, with older replies behind the arrows in its top bar and a plus for files beside the typing box.

When the board cannot be reached as the app opens (Tailscale off, or the Mac asleep or offline), the phone shows "Is the Facilitator server down?" and keeps trying on its own. The app always waits for the latest page and files from the Mac, however slowly they come, and keeps no older copy; if one of them still fails, it shows that same screen and opens by itself once the file comes through.

Attachments, on the phone and the Mac: the plus, a paste or a drop adds photos, videos, recordings, PDF and Word files, up to 100 MB each. Each waits in a tray over the typing box, with a ring showing its upload and a cross to take it out, and goes with the message. Pictures show in the card as a grid, videos and recordings with play controls, and documents as links. An upload that fails is tried again on its own, then waits with a red mark to tap; a file the board refuses (not what its name says, empty or too large) gets the red mark too. Attachments are kept in `data/uploads`; those saved in the repository before attachments moved out of it are in `data/uploads-old`.

Delivery marks, on the phone and the Mac: a sent message is faded until the board has saved it, then says "Delivered", and "Read" once an agent picks it up. A message that could not be sent is tried again on its own; if it still fails it gets a red mark with a retry arrow, and a cross that puts its words back in the typing box.

Notifications: add the app to the Home Screen (on an iPhone notifications only work from there), open the settings drawer, open Notifications and turn the switch on. While the phone link is on, the board sends one notification, with the card's title, each time a card becomes your turn; a tap on it opens that card. Progress notes never notify, a turn while the link was off does not notify later, and signing out stops notifications for that phone. There is no Restore button: if the switch cannot turn on it stays off, and tapping it again tries again. A line under it appears only when permission is off in the phone's settings, or the phone cannot do notifications at all.

When the Mac board's window is much taller than it is wide, the Mac shows this same phone page in it, keeping your project, card and unsent words; make the window wider to go back to the board.
