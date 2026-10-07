"""Triage facilitator — thinnest possible local server.

The board listens on a pair of loopback ports: the one run.config.json names
(port, 8877 when it names none) for the desktop and the agents, and the one
above it, which Tailscale Serve targets, separately gated. `facilitator run`
moves the pair to a free one when something else holds it and writes the new
port into the config. Every route on the gated socket requires a persistent
session, except the install/sign-in page, its manifest and icons, and auth
endpoints. An old Serve mapping to the board's own port prevents startup
until it is removed. One server per folder: server.lock beside state.json is
held for as long as the server runs, and names its pid and port.

One page, one state file. The human types into per-item boxes; messages queue
FIFO; the agent (Claude, in the terminal session that launched this) drains the
queue one box at a time via GET /wait (long-poll) and answers via POST /reply.

Endpoints:
  GET  /                    -> index.html, the card board
  GET  /page                -> page.html, the same lanes drawn as one typed page
  GET  /state               -> full UI state (page polls this), with rev, the
                               board's revision: every saved change moves it,
                               and settingsRev, the settings' own revision
                               (see /settings)
  GET  /m/state[?since=R][&delta=E][&ops=A,B] -> what the phone reads: {rev,
                               changed, live, ...}. With since naming the
                               revision the phone already holds and nothing
                               saved since, only rev, changed:false and the
                               live section (who is listening) come back;
                               otherwise the cards with the fields the phone
                               draws, the title, the tabs and the lanes as
                               well, and epoch, this server run's name for its
                               readings. delta names the epoch of the reading
                               the phone holds: when it is this run's and the
                               board still remembers the cards it sent at R
                               (its last PHONE_KEPT readings), the answer has
                               delta:R and only the cards that differ from
                               that reading, with gone (ids no longer on the
                               board), after (each new card's id mapped to the
                               id before it, "" for the first), count (cards on
                               the board) and, only when those cannot rebuild
                               the order, ids (the whole order). Without delta,
                               or with one that cannot be built on, every card
                               comes, as it always did. An answer of
                               PHONE_GZIP_MIN bytes or more is gzip compressed
                               when Accept-Encoding takes gzip. ops names up
                               to 32 operation ids and each is answered
                               {status: applied|unknown, result} in the same
                               reading
  GET  /op?id=OP            -> one operation id's receipt: {status, kind, box,
                               result, rev}; status unknown for an id the board
                               holds no receipt of. A receipt is kept well past
                               the point a phone stops retrying (never let go
                               while younger than OP_EVICT_FLOOR, and at most
                               OP_RETENTION), so unknown for an id a client
                               could still be sending means it never landed; a
                               much later query cannot tell a never-landed id
                               from one whose receipt has since aged out
  POST /send?box=ID[&via=mini][&op=OP] -> body = the human's message text (plain text).
                               via states where it was typed: mini is the small
                               card in the corner, no via at all is the big card
                               in the middle. Only the literal "mini" is stored
                               (as the message's via field), so any other value
                               and any older caller land exactly as before.
                               Sending to a docked or parked card brings it back to
                               Doing in the same saved update. op is an
                               operation id the caller minted before its first
                               try, 8 to 64 letters, digits, - or _: the result
                               {ok, mid, box, rev} is committed beside the
                               message itself, the same id sent again answers
                               that result with replayed:true and stores
                               nothing, and the same id with other words is a
                               409. A receipt is never let go while a phone
                               could still be sending its id, so a retry always
                               finds it rather than landing twice. A send with
                               no op lands as it always did and is never
                               deduplicated
  POST /done?box=ID&v=1|0[&sid=S&seq=N] -> mark a box done / not done
  POST /close?box=ID[&sid=S&seq=N] -> atomically close from the authoritative card:
                               a card with a reply, reply count, or pending
                               message is marked done; only a truly empty meta
                               card is removed
  POST /working?box=ID&v=1|0 -> a job runs behind this box: it shows green
                               without holding the lane's claim. Registration
                               starts a heartbeat clock; without /ping every
                               75s the green expires on its own. v=0 and that
                               expiry are also where a turn deferred by a
                               reply under the flag is handed over
  POST /ping?box=ID         -> heartbeat for a registered job; refreshes its
                               green while the job actually runs
  POST /testing?box=ID&v=1|0 -> raise or lower the ready-to-test marker: a
                               durable per-card flag the agent sets once a
                               delivered change is actually available for the
                               reader to try. v=1 is refused unless the card is
                               awaiting the reader (a completed reply waits and
                               no job runs), so it can never mark active, queued
                               or done work. v=0 always clears. The reader
                               answering the card, and close/done, clear it too.
                               The pages send v=0 when the reader unfolds the
                               ticket.
                               It adds no reply, consumes no claim and moves no card
  POST /dock?box=ID&v=1|0[&after=T&sid=S&seq=N] -> move a card to Docked / Doing
  POST /park?box=ID&v=1|0[&after=T&sid=S&seq=N] -> defer a card / bring it back.
                               Docked keeps the card's working or reply color.
                               Dock, park, done and close share an optional
                               per-page sid/seq order; an older command cannot
                               replace a newer one from that page. Dock and park
                               refuse a move decided before an owner message
                               newer than after, when that basis is supplied
  POST /context?box=ID      -> body = the box's two-line context strip (agent-kept)
  POST /title?box=ID        -> body = replacement title (agent keeps titles brief;
                               auto-names are just the chopped first message)
  POST /create?owner=O[&op=OP] -> body's first line titles a new meta box (empty =
                               "…", named later by its first message); ids m1, m2...;
                               owner defaults to facilitator. Answers {ok, id,
                               rev, card}, the card in the phone's shape. op
                               is an operation id, as on /send: the same id
                               again answers the first try's id and makes no
                               second card
  POST /project?name=N      -> body = the chosen folder's absolute path (under
                               the home directory): creates a new project lane
                               whose owner id is a slug of N, stores {id, name,
                               dir} in state.json so restarts keep it, and
                               returns the id; the lane starts with Omni Ticket #1;
                               a taken id walks numbered suffixes (-2, -3) until
                               free; empty names and bad folders are refused (400)
  POST /delete?box=ID       -> legacy empty-meta removal route. A stale caller
                               that sends a nonempty meta card here closes it to
                               done instead, so old tabs cannot erase a thread
  POST /upload?name=F[&op=ID] -> body = raw attachment bytes; saves to the sibling internal
                               folder ../facilitator-internal/uploads/ (outside the
                               repo, never pushed), returns {"url": "/uploads/..."}
                               unchanged; GET /uploads/<file> serves it back. The
                               bytes stream to a hidden part file, owner-only, and
                               are put in place only once complete and only if
                               their first bytes are the kind the name says (415
                               otherwise; an SVG carrying script is refused too).
                               The body may go UPLOAD_STALL_TIMEOUT with nothing
                               arriving and UPLOAD_TIME_LIMIT in all (408). ID is
                               the caller's operation id: a repeat under the same
                               ID is answered with the file already stored
  GET  /upload?op=ID        -> the receipt of that upload: {"url": ...} once
                               stored, {"arriving": true} while it is still coming,
                               404 when this server run has no record of it
  GET  /uploads/<file>      -> a previously uploaded attachment: served from the internal
                               uploads folder, falling back to the old in-repo
                               uploads/ for images saved before the move
  GET  /laneimg/<lane>/<file> -> a picture out of that lane's OWN internal folder,
                               <lane dir>/<lane id>-internal, the same rule this
                               repo's facilitator-internal/ already follows. The
                               lane dirs are the ones /state hands out as pwds.
                               <file> must be one plain file name and the resolved
                               path has to sit inside that folder, so .. segments,
                               nested paths, absolute names and symlinks pointing
                               out of it are all refused. Only the image content
                               types in IMG_TYPES are served; anything else,
                               an unknown lane, a missing folder or a missing file
                               is a 404. Lets an agent working in another project
                               show a picture on the board without writing a file
                               into this repo
  GET  /cm-markdown.js      -> the vendored CodeMirror 6 bundle beside index.html,
                               fetched the first time the file navigator opens a file
  GET  /card-markdown.js    -> the shared, finite card-prose renderer used by
                               the board, page view and small card
  GET  /card-tokens.css     -> the card's shared sheet: the colour and font
                               tokens, the card's constants, the card prose
                               rules and the sent box's arrival dress, loaded
                               by the board and folded into the phone page as
                               /m serves it
  GET  /card-logic.js       -> the card's shared logic: the card state rules,
                               the lanes, the sent box's rows and the helpers
                               the board and the phone page carry in common
  GET  /compose-format.js   -> the composer's typed formatting: the setting,
                               and the editor layer the card pages put over a
                               composer while it is on. The board's default
                               for a page with no stored choice, from
                               run.config.json's compose_format_default (off
                               when the key is missing), is written in front
                               of the file as it goes out
  GET  /home-widgets.js, /home-widgets.css -> the home page's token panel: its
                               heatmap and line chart, the pill that switches
                               them, and their sheet, fetched by the board the
                               first time its home page opens
  GET  /mac-phone-view.js   -> the Mac's retained phone-view host and draft handoff;
                               /m on the local board port allows only same-origin
                               framing, while the root and bridge remain unframeable
  GET  /manifest.json, /sw.js -> what makes the board page installable as a Mac
                               app: its web app manifest, whose name the
                               installed app's bundle and dock icon are taken
                               from, and its service worker, which keeps nothing
                               and is there so the install offer cannot turn on
                               which Chrome is installed. The worker is served
                               from the root so its scope can be the whole
                               board; /m keeps its own worker, whose scope is
                               the longer of the two. The icons are the
                               phone's, served as below
  GET  /m                   -> m.html after bridge sign-in, the phone page: the project tabs, one
                               card filling the screen, the card list in a
                               drawer off the left edge; before sign-in the bridge
                               serves m-gate.html with PWA installation steps.
                               m.html goes out with card-tokens.css's text in
                               place of its link, so the startup curtain's first
                               frame needs no second file
  GET  /auth/check          -> bridge session status and password setup status
  POST /auth/login          -> JSON {password}; sets a persistent HttpOnly cookie
  POST /auth/logout         -> invalidates that session and clears its cookie
  GET  /m-manifest.json, /m-sw.js, /m-icon-<size>.png, /m-splash-squid.png, /m-splash.js
                            -> what makes the phone page installable: its web
                               app manifest, its service worker (network
                               first, shows the push notifications), its
                               home screen icons, cut from the board's own mark,
                               the mark on its own with no background, which
                               the page paints this phone's home screen launch
                               image from, and the painter itself, which the
                               sign-in page runs too, since iOS keeps the
                               picture of the page an icon is added from.
                               The manifest's name and short_name are answered
                               from the saved board title, so the install
                               prompt offers the one name the board goes by
                               (the untitled default, the lowercase lane name,
                               is offered as the app's name, Facilitator);
                               every other field is served as the file has it,
                               and a blank title leaves the file's own name
  GET  /assets/ticket-<1|2|3>.webp -> supplied Omni Ticket artwork
  GET  /push/key            -> {"key": ...}: the VAPID public key, base64url,
                               that the phone subscribes with. The key pair
                               lives in vapid-key.pem beside state.json,
                               gitignored and made by openssl on first need
  POST /push/subscribe      -> body = the browser's push subscription as JSON
                               ({endpoint, keys, ...}); kept in state.json under
                               push_subs, one per endpoint. Each time a card
                               turns to the owner's turn (a plain reply with no
                               live working flag, or a working flag dropped or
                               expired while a reply waited in deferred) one
                               push with that event's encrypted card id and
                               title goes to every subscription with an active
                               bridge session
                               only while Tailscale is connected and its HTTPS
                               Serve proxy targets this board. The push is
                               signed with a VAPID token openssl produces; the
                               phone's worker uses that event identity directly.
                               Progress notes never push. A subscription the
                               push service reports gone (404, 410) is dropped.
                               Each subscribe, unsubscribe, drop and skipped
                               session writes one log line with a short hash of
                               the endpoint and the number now stored
  POST /push/unsubscribe    -> JSON {endpoint}; remove this phone's subscription
  GET  /navfiles?lane=L&kind=K&rel=D -> the navigator's listing. Always the two
                               folders lane L owns (its internal folder and its
                               wiki, both named after the lane's own directory),
                               each with the kind it answers to and whether it
                               exists, for the panel's two tabs. Plus the
                               immediate children of ONE directory: folder K
                               (internal by default), directory D under it (its
                               root for a blank D). Every child carries its name
                               and type (dir, file or other), a file its ext, size
                               and stamp. All names are shown, dotfiles and
                               dotfolders included; a fifo/socket/device is named
                               but marked unavailable, and a symlink pointing out
                               of the folder is named but never resolved for its
                               content. Bounded to one directory per request, so a
                               folder holding a large archive costs nothing until
                               opened. A missing or empty directory, and a lane the
                               panel is not mounted on, come back present-and-empty
  GET  /navfile?lane=L&root=R&rel=P -> one text file's whole text plus the stamp
                               the save guard wants back, and crlf saying which
                               line endings it arrived in. R has to be one of lane
                               L's own two folder names, so one lane asking for
                               another lane's folder is refused, and P is a path
                               under it. The joined path is resolved and has to
                               land inside that folder: a path that resolves
                               OUTSIDE it is refused (400), whether it got there by
                               .. segments, an absolute rel, or a symlink pointing
                               out; a .. that still resolves inside names that same
                               in-root location and is served. The target has to
                               be a regular file (404 for a missing name, a
                               directory or a special file), within the editor size
                               cap (413), and actual text: not a recognized binary
                               type by extension and not bytes that merely decode
                               as utf-8 (415)
  GET  /navimg?lane=L&root=R&rel=P -> one in-root image for the inline preview.
                               Same lane and path rules as /navfile. The target has
                               to be a regular file whose extension is an image
                               type (415 otherwise) under a conservative size cap
                               (413). Served with nosniff and a sandbox CSP like
                               /uploads, so even an SVG runs no script; the bytes
                               are loaded into an <img>, never injected into the
                               board
  POST /navsave?lane=L&root=R&rel=P&mtime=S -> body = the file's whole new text,
                               raw and unstripped. Same lane and path rules as
                               /navfile. The target has to already exist as a
                               regular file (the navigator creates nothing), what
                               is on disk now has to itself be text (415, so a
                               binary is never overwritten by a text body) and the
                               new body has to be text too. S is the stamp handed
                               out on read: if the file's stamp has moved since,
                               somebody else wrote it and the save is refused with
                               409 and the current stamp, never merged and never
                               clobbered. Written temp-file-then-rename like
                               state.json, keeping the file's permission bits, and
                               answers the new stamp
  POST /tabs                -> body = the project tab bar's whole record as
                               JSON, {"order": [owner ids], "closed": [owner
                               ids]}: which tabs the bar shows and in what
                               order. Kept here rather than in one browser, so
                               the board and the phone show the same tabs in
                               the same order and either can reorder them.
                               Every id has to be a known owner (400
                               otherwise, nothing stored) and a repeated id is
                               dropped. Answers the stored record
  POST /seen                -> body = {"<box id>": <replies read>, ...}: how
                               many of each card's replies the owner has read,
                               so a card read on the phone counts as read on
                               the board too. Counts are whole numbers, never
                               below zero; an unknown box or a bad count is a
                               400 with nothing stored at all. Answers the
                               stored counts for the ids it was given
  GET  /board-settings.js   -> the desktop pages' settings store, the file
                               beside this one, with the board's settings
                               written in front of it as
                               globalThis.BOARD_SETTINGS = {rev, values}, so a
                               page has them before its first line runs. The
                               settings are what the reader arranges on the
                               desktop pages: each lane's box places, sizes,
                               hides and shows, the background colour, the
                               outline's width, formatting while typing,
                               whether the daily usage counts are shared
                               (usagecounts, "0" when off), the home chart,
                               the typed page's tasks and the one-time layout
                               passes, under the key names and
                               text values the browsers kept them under. They
                               live in settings.json beside state.json, so
                               every address the board is opened at shows the
                               same board. When run.config.json names a
                               background_default, a #rrggbb colour, it is
                               written after them as
                               globalThis.BOARD_BGCOLOR_DEFAULT, the colour a
                               page uses until a bgcolor is saved
  GET  /settings            -> {rev, values}: the same settings, for a page
                               whose /state says settingsRev has moved
  POST /settings[?seed=1]   -> body = {"<key>": "<value>" or null, ...}: sets
                               or removes those keys and keeps every other, so
                               two windows changing different boxes both keep
                               theirs, and the last write to one key wins. A
                               key outside the fixed patterns (SETTINGS_KEY), a
                               value over SETTINGS_VALUE_MAX characters or a
                               store past SETTINGS_KEYS_MAX keys is a 400 with
                               nothing stored. seed=1 is a browser's one-time
                               copy of what it already held: applied only
                               while the store is empty, and seeded says
                               whether it was. Answers {ok, rev, values}.
                               Never moves the board's revision, so a box
                               dragged on the desktop sends no phone a new board
  GET  /spotify/session     -> the Spotify sign-in magic box 1 plays with,
                               {access, refresh, expires, scopes}, or {} when
                               none is kept: in settings.json, owner-only, so a
                               board that moved needs no new sign-in. Answered
                               only to a local page: on the board's own port,
                               never the phone's, with no Tailscale forwarding
                               header, a loopback Host and no cross-site fetch;
                               a 404 to anything else. It never travels in
                               /state, /settings or /board-settings.js
  POST /spotify/session[?seed=1] -> body = those four fields as text, replacing
                               the kept sign-in ({} drops it). Local only as
                               above, and a 403 unless Origin is the page's own
                               loopback address. seed=1 is a browser's one-time
                               copy, applied only while none is kept
  The five quick note routes below are OFF in this version
  (QUICK_NOTES_ON is False): each answers 404, the same as an unknown route,
  and /state carries no quicknotes. The notes already stored in state.json
  are left as they are. The entries say what the routes do with the switch on.
  GET  /quicknotes          -> {notes, rev}: every quick note, oldest first, each
                               {id, text, created, updated, card}. A quick note
                               is plain text the owner jots down from the
                               board's corner; card is the id of the card it is
                               attached to, or null while it stands alone. With
                               the switch on, /state carries the same list
                               without the text, which is enough for a card to
                               show it has a note; the text itself travels only
                               on these routes
  POST /quicknote/new[?card=ID] -> body = the note's text, kept as typed and
                               never stripped. Makes a note, ids qn1, qn2...
                               never reused, attached to card ID when one is
                               named; an unknown card is a 400 with nothing
                               stored. Answers {ok, note, rev}
  POST /quicknote/save?id=N -> body = the note's whole new text, as typed.
                               Replaces the text and moves updated; the same
                               text again changes nothing and saves nothing.
                               Answers {ok, note, rev}; an unknown id is a 400
  POST /quicknote/attach?id=N[&card=ID] -> attaches note N to card ID, or, with
                               no card, detaches it so it stands alone again. An
                               unknown note or card is a 400 with nothing
                               stored. Answers {ok, note, rev}
  POST /quicknote/del?id=N  -> removes note N for good. Answers {ok, id, rev}.
                               No quick note route writes a note's text to the
                               log or the transcript: the log line names the
                               note, its card and its length. They are served on
                               the local port like every route here, and the
                               phone bridge hands a signed-in session through to
                               them exactly as it does to every other route
  POST /clientlog          -> body = {"page": "board"|"phone"|"page",
                               "client": "chrome"|"electron"|"tauri"|"safari"|
                               "phone"|"other", "window": 16 hex characters,
                               "reports": [...]}: what a page noticed and has no
                               other way to say. Client and window name the kind
                               of window and the page load that sent it, and are
                               kept on every line. One report per thrown error,
                               rejected promise, failed request, failed render
                               or timer that ran late, each carrying its kind,
                               its message, where it happened, the card that was
                               open and how many times it repeated. Never any
                               card text. The pages batch these and send them on
                               page hide through sendBeacon. Written to
                               client-DATE.jsonl beside the server's own log, at
                               most 10 writes per key per minute with the excess
                               dropped and counted, at most 20 reports per batch
                               and 500 characters per string field. A batch this
                               board cannot read is a 400 with nothing stored, a
                               body over 16 KB a 413. Phone incident histories
                               use a strict versioned schema: v1/v2 keep up to
                               40 events over 60 seconds; v3/v4 keep up to 128
                               over a 120-second lead-up and 20-second recovery.
                               V4 adds bounded Enter decisions and viewport
                               geometry without draft text. V5 adds response
                               scroll position, heights and finger direction
                               (never coordinates) and the no-scroll reason.
                               All versions share four writes per minute across
                               incident reasons.
                               Six more kinds come from the phone alone, each
                               with fixed fields and nothing else: pushreceived
                               (its worker's record of one push, shown or
                               skipped and why), notifycheck (permission and
                               whether a subscription exists, at open and on
                               return), notifylost (permission granted, no
                               subscription), and three that follow one tap on
                               a notification by one tap id: notifytap (what
                               the worker did with the tap), notifyarrive (the
                               card reaching the page and what stood over it)
                               and notifyresult (whether the card was shown
                               once drawn). A field outside the list or a
                               value outside its words is a 400.
                               Confirmation follows a successful log write/flush
  GET  /thread?box=ID&n=N   -> last N user/agent/note messages of a box from the
                               transcript (read by the quick chat panel and the
                               page view's own stepper)
  GET  /history?box=ID      -> {"replies": [...]}: one card's older final
                               replies, oldest first, without the one the card
                               is showing and without its progress notes, at
                               most HISTORY_MAX of them. What the reply-history
                               arrows walk, and the same rule that decides the
                               olderReplies count sent with the card, so the
                               marks a page draws before it asks and the list
                               it gets when it does agree. The filter runs
                               before the cap, so a long run of notes since the
                               last answer cannot push the answers out of the
                               window, and the live page is left out by the
                               card's own record rather than by matching text
  GET  /log?lines=N         -> tail of the day's server log file, the dated one
                               under the sibling internal folder's logs/;
                               $FACILITATOR_LOG names another file instead
  GET  /dirs?path=P         -> the subdirectories of P (name + absolute path)
                               for the page's folder chooser; empty P means the
                               home directory; hidden folders are excluded and
                               paths outside the home directory are refused
  GET  /tokens/daily?days=N -> the tokens the local coding agents spent per
                               day, what the home page's charts draw: the last
                               N days (1 to 3660, 365 when absent) ending today,
                               oldest first, every day present, each {date,
                               total, input, cache_write, cache_read, output,
                               claude, codex}, then the range's total, its
                               kinds, each tool's share, and whether each
                               tool's log folder was found. Counted from the
                               logs Claude Code and Codex already write under
                               the home folder by tokens.py beside this file,
                               which says what counts; run.config.json's
                               token_logs names other folders. Only counts
                               come back, and missing logs are zeros
  GET  /limits              -> how much of its plan each coding agent has used,
                               what the home page's limits box draws: {"claude":
                               {...}, "codex": {...}} holding only the tools with
                               a window to show, each window ("five_hour",
                               "weekly") {used, resets}: a whole percent from 0
                               to 100, 0 once the reset time has passed, and the
                               reset as epoch seconds or null, plus "fetched"
                               (epoch seconds when Codex was last read, or
                               null), "now" (this server's clock) and
                               "refreshing" (a renewal is running). It answers
                               at once from the last reading; one five minutes
                               old is renewed in the background. limits.py
                               beside this file says where each number comes from
  GET  /pickdir             -> the system folder chooser on the desktop this
                               server runs in: blocks until a folder is chosen,
                               then {"path": "..."}; a dismissed chooser answers
                               {"cancelled": true}, a real failure {"error": "..."}.
                               With FACILITATOR_PICKDIR_STUB set on the server
                               process the value answers at once and no dialog
                               ever opens, so tests can drive the flow headless
  POST /ws/goal?owner&ws    -> body = the workspace's goal text
  POST /ws/task?owner&ws[&id][&status][&del=1] -> body = task text; no id creates,
                               status one of pending|ongoing|done, del removes
  POST /ws/current?owner&ws&id -> set the workspace's current task
  POST /pages/new?owner=O   -> add a blank view page to O's page list and answer
                               {ok, id, pages}. A view page is one of the
                               environments a project can be looked at in: the
                               board page every project starts with, and blank
                               pages added since. It holds no cards and no
                               conversations of its own, so adding or removing
                               one moves no card, no workspace and no task. At
                               most PAGE_LIMIT per project; past that a 400
  POST /pages/del?owner=O&id=P -> remove one view page and answer {ok, pages}.
                               The project's cards, its conversations and its
                               internal workspaces are untouched; any page may
                               go, the board page included, and a project whose
                               pages have all been removed keeps an empty list
                               rather than being given a new one
  POST /assign?box=ID&task=T -> file a chat under a task (empty task unfiles)
  POST /dismiss?box=ID      -> drop the box's queued messages unanswered (they
                               stay in the transcript)
  POST /progress?box=ID     -> interim note while holding a claim; keeps the
                               card green and resets the steal timer, no release.
                               The messages the claim holds at that moment are
                               read from then on (pendingStates on /state)
  GET  /fresh?owner=O       -> while O's agent holds a card: any messages that
                               landed on that card after the claim, handed over
                               and folded into the claim, so the one reply
                               covers them and nothing is delivered twice.
                               Answers {box, messages, message_via}, with
                               message_via in the same shape /wait uses: one
                               entry per handed-over message in the same order,
                               "mini" for a small card message and null for a
                               big card one. A mini message handed over here
                               becomes the newest message the claim covers, so
                               it is the one that decides /reply's 100 word cap,
                               and the agent has to be able to see it;
                               {"messages": [], "message_via": []} when nothing
                               new or no card held
  GET  /wait?owner=O&timeout=S[&agent=NAME] -> agent long-poll; claims the oldest
                               queued box owned by O (facilitator or a project
                               lane; defaults to facilitator) + its pending
                               messages. agent= states the caller's name; the card
                               rows' little tag shows the lane's live name or
                               offline, never a stored guess. A claim answers
                               {box, title, messages, message_via, queued_after,
                               ack}: messages stays a list of plain strings and
                               message_via runs beside it, one entry per message
                               in the same order, "mini" for a small card message
                               and null for a big card one. Also returns
                               {"idle":true} on timeout.
                               Delivery is confirmed, always: ack carries a short
                               token and the claim counts as provisional until
                               POST /ack names it. There is no unconfirmed mode.
                               An ack=1 in the query is accepted and ignored, so
                               a loop that learned the flag still works
  POST /ack?owner=O&token=T -> confirms the provisional claim that token was
                               minted for and answers {"ok": true}; acking an
                               already confirmed claim again says the same, so a
                               resent ack is safe. An unknown or stale token is a
                               409 with a short reason. A provisional claim
                               nobody confirms within 90 seconds is released: the
                               box goes back to the FRONT of its lane's queue and
                               the card falls back to the queued grey, exactly
                               like an unpicked card, never yellow. That clock is
                               swept wherever the 15 minute steal-back is swept
                               and on every /state, which the board polls about
                               once a second, so it runs even with no /wait open.
                               A loop that claims and never acks gets the same
                               card handed back every 90 seconds
  GET  /unread?owner=O      -> {"queued": N, "claimed": M} for that lane: messages
                               still waiting to be handed over, and messages in
                               the claim that lane's agent holds right now. Read
                               only, it claims nothing and releases nothing; for
                               a Stop hook checking whether anything is waiting
                               before the agent goes idle, and for humans
  POST /reply?box=ID[&ctx=S][&short=S] -> body = the agent's full final reply
                               text (plain text). short is an OPTIONAL,
                               separately stored small-card version. When it
                               is absent, the full text is used in both places.
                               Authored punctuation, including a line containing
                               only ---, always remains part of the reply.
                               ctx is an OPTIONAL urlencoded summary
                               strip, 50 words max, stored as the box's
                               context when passed. The summary box was taken
                               off the card 20260821 and nothing displays it;
                               an overlong strip is still refused (400), never
                               silently truncated.
                               When the newest message the claim covers came
                               from the small card (via=mini), its displayed
                               variant over 100 whitespace separated words is
                               refused (400, nothing stored). With no short
                               value that means the full body. A big card
                               message has no cap.
                               A normal reply hands the ball to you only when
                               no working flag beats on the box. While one
                               does, nothing awaits you yet: the card goes to
                               the deferred state and the turn is handed over
                               when that flag drops or expires, so a mid-work
                               reply cannot turn a green card yellow.
                               The removed quiet query is rejected so a stale
                               agent contract cannot turn progress into an
                               accidental final handover.
  POST /note?box=ID&ctx=S   -> the named interim-note action: stores the body
                               and ctx summary like /reply (reply, count,
                               agent_ts, ts, context), consumes and releases
                               any held claim, and enters the explicit note
                               state with a fresh heartbeat. note is green
                               while the work lives and rests grey if it dies;
                               it never hands the ball to "you". A normal
                               /reply is the sole final handover action.

Owner routing (2026-08-05): every box carries an owner tag, facilitator (tool
discussion, this repo's agent) or a project lane (the project under discussion,
its own agent). Each owner has its own busy/claim slot and listener-presence
tracking, so the lanes drain the same board without blocking each other.

State persists to state.json next to this file; every send/reply also appends
to transcript.jsonl so the discussion survives anything. The desktop pages'
settings and the Spotify sign-in persist to settings.json beside it. A first-ever start
(no state.json) seeds the board title and boxes from seed.json if present;
the shipped seed.example.json holds a title and no boxes, so a new install
opens with no project. Real discussion content never ships in this code.

Once a day, unless the usagecounts setting is "0", a thread of the server's own
sends one message of counts about the day before to PostHog (usage_counts.py;
README.md, "Usage counts", lists every field). It is no route and answers
nothing; usage-counts.json beside state.json holds the last day it dealt with.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import fcntl
import gzip
import hashlib
import json
import logging
import logging.handlers
import os
import re
import random
import secrets
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlparse, quote

HERE = Path(__file__).resolve().parent

# ---- the log ----------------------------------------------------------------
# One event per line, as JSON, in a dated file, and that file is the only place
# the server's output lands. A terminal gets the same event in a short human
# form as well, but only when there is a terminal on the other end of standard
# output: a server started by hand should say what it is doing, and a server
# started by the CLI has nobody reading and would only be writing everything
# twice. Three levels and no more: INFO is what happened and is on by default,
# DEBUG is the noise switched on while hunting, ERROR is something that failed
# and was not meant to.
#
# Five things never appear in any line: message text, keys, whole push
# endpoints, file paths and addresses. The rule is kept HERE, where the line is
# written, by not passing those things in. A filter over a formatted line can be
# fooled; not passing the text cannot.
LOG_LEVELS = {"info": logging.INFO, "debug": logging.DEBUG, "error": logging.ERROR}
LOG_MAX_BYTES = 5 * 1024 * 1024   # one file's cap
LOG_KEEP = 30                     # files of one kind kept; older ones are deleted
# The folder is worked out from this file's own place, the way INTERNAL_UPLOADS
# below is, so no machine's home directory gets into tracked source and every
# test's copy of this file writes into its own sandbox. The variable points one
# run somewhere else, which is what a rotation test needs.
LOG_DIR = Path(os.environ.get("FACILITATOR_LOG_DIR")
               or (HERE.parent / "facilitator-internal" / "logs"))


def _private_opener(path, flags):
    """An opener for open(): the file is readable by this account alone. The
    creation mode is cut by the umask and does not touch a file that already
    exists, so the mode is also set on the open file itself."""
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except OSError:
        pass   # a volume that keeps no modes still takes the write
    return fd


def _configured_level() -> str:
    """The level in force: the environment variable wins over run.config.json's
    log_level, which wins over info. Never raises, and a value that names no
    level falls back to info rather than stopping the board.

    Its own small read rather than a field on the lane config's read, because
    the level has to be known before the socket is bound (a refused bind is
    itself worth writing down) and that read deliberately refuses some files."""
    named = os.environ.get("FACILITATOR_LOG_LEVEL")
    if not named:
        try:
            named = json.loads((HERE / "run.config.json").read_text()).get("log_level")
        except Exception:
            named = None
    named = str(named or "").strip().lower()
    return named if named in LOG_LEVELS else "info"


def _image_panel_lane() -> str:
    """The lane whose own internal folder feeds the image panel (magic box 3),
    read from run.config.json (machine-local, gitignored). Empty when unset,
    which leaves the panel off on every tab and the feature idle."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        return ""
    return str(cfg.get("image_panel_lane") or "").strip()


def _navigator_lanes() -> tuple:
    """The lanes the file navigator is mounted on, read from run.config.json
    (machine-local, gitignored) under `navigator_lanes`. Empty when unset, which
    leaves the navigator off on every tab. A lane not listed here has no navigator
    folders and every navigator route refuses it. The former key `markdown_lanes`
    is no longer read; _warn_legacy_config names its replacement once at startup if
    it is still present."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        return ()
    lanes = cfg.get("navigator_lanes") or []
    return tuple(x.strip() for x in lanes if isinstance(x, str) and x.strip())


def _warn_legacy_config() -> None:
    """One startup line when run.config.json still carries a config key this
    server no longer reads, naming the key that replaced it. Best-effort and read
    fresh: a missing or unreadable config is simply nothing to warn about. Today
    that is `markdown_lanes`, which became `navigator_lanes` when the panel it
    named became the file navigator."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        return
    if isinstance(cfg, dict) and "markdown_lanes" in cfg:
        _warning("stale_config", key="markdown_lanes", use="navigator_lanes")


def _spotify_client_id() -> str:
    """The Spotify app client id the player signs in with, read from
    run.config.json (machine-local, gitignored). Empty when unset, which turns
    the connect stub into a prompt to create an app id rather than a sign-in."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        return ""
    return str(cfg.get("spotify_client_id") or "").strip()


def _compose_format_default() -> bool:
    """Whether formatting while typing starts on in a browser that has stored no
    choice of its own, read from run.config.json (machine-local, gitignored)
    under `compose_format_default`. Only true turns it on: a missing key, a
    missing file or any other value leaves it off. A browser's own stored
    choice always wins over this."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        return False
    return isinstance(cfg, dict) and cfg.get("compose_format_default") is True


def _background_default() -> str:
    """The colour a board's pages use until a background colour has been saved
    with the board's settings, read from run.config.json (machine-local,
    gitignored) under `background_default`. Only a string of the form #rrggbb
    counts, kept in lower case; a missing key, a missing file or anything else
    is empty, which leaves the pages' own paper colour as it is. A saved
    colour always wins over this."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        return ""
    value = cfg.get("background_default") if isinstance(cfg, dict) else None
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return value.lower()
    return ""


class DatedRotatingHandler(logging.handlers.RotatingFileHandler):
    """A file per day per kind, capped by size and pruned by count.

    Neither handler in the standard library does both. RotatingFileHandler takes
    its name once, so a process running past midnight keeps writing yesterday's
    date forever; TimedRotatingFileHandler rolls at midnight and has no size cap
    at all, and the thing most likely to write a lot is exactly the thing going
    wrong. This rolls on either, and prunes by listing the folder rather than
    shuffling numbered backups, which also clears files left by earlier runs."""

    def __init__(self, folder: Path, stem: str, suffix: str, delay: bool = False) -> None:
        self.folder, self.stem, self.suffix = folder, stem, suffix
        self.day, self.roll = time.strftime("%Y%m%d"), 0
        folder.mkdir(parents=True, exist_ok=True)
        super().__init__(str(self._file()), maxBytes=LOG_MAX_BYTES,
                         backupCount=0, encoding="utf-8", delay=delay)

    def _open(self):
        return open(self.baseFilename, self.mode, encoding=self.encoding,
                    errors=self.errors, opener=_private_opener)

    def _file(self) -> Path:
        """<stem>-<day><suffix>, and <stem>-<day>.1<suffix> for a second roll
        on the same day."""
        return self.folder / (f"{self.stem}-{self.day}"
                              + (f".{self.roll}" if self.roll else "") + self.suffix)

    def emit_confirmed(self, record: logging.LogRecord) -> None:
        """The manual phone marker needs to know whether its file was written.
        Standard logging swallows write errors; this path uses the same file,
        formatter and rotation but lets its caller answer failure honestly."""
        self.acquire()
        try:
            if self.shouldRollover(record):
                self.doRollover()
            if self.stream is None:
                self.stream = self._open()
            self.stream.write(self.format(record) + self.terminator)
            self.flush()
        finally:
            self.release()

    def _age(self, p: Path) -> tuple:
        """Oldest first, read out of the name rather than off a modification
        time, so files carried over from earlier runs still sort truthfully."""
        day, _, roll = p.name[len(self.stem) + 1:-len(self.suffix)].partition(".")
        return (day, int(roll) if roll.isdigit() else 0)

    def shouldRollover(self, record: logging.LogRecord) -> int:  # noqa: N802
        if time.strftime("%Y%m%d") != self.day:
            return 1
        return super().shouldRollover(record)

    def doRollover(self) -> None:  # noqa: N802
        if self.stream:
            self.stream.close()
            self.stream = None
        today = time.strftime("%Y%m%d")
        if today != self.day:
            self.day, self.roll = today, 0
        else:
            self.roll += 1
        while self._file().exists():   # never reopen a file this run already filled
            self.roll += 1
        self.baseFilename = str(self._file())
        self.stream = self._open()
        self._prune()

    def _prune(self) -> None:
        """Thirty of this kind kept, the oldest deleted. A folder that cannot be
        listed is left alone: pruning must never be the thing that stops a
        line from being written."""
        try:
            kept = sorted(self.folder.glob(f"{self.stem}-*{self.suffix}"), key=self._age)
        except OSError:
            return
        for old in kept[:-LOG_KEEP]:
            try:
                old.unlink()
            except OSError:
                pass


class JsonLineFormatter(logging.Formatter):
    """One event, one line: a UTC timestamp with the date in it, the level, the
    kind, the box when the event belongs to a card, then that kind's own fields.
    A traceback travels as an ordinary string field, whose newlines json.dumps
    escapes, so one event never becomes several lines."""

    def format(self, record: logging.LogRecord) -> str:
        line = {
            "ts": (time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
                   + f".{int(record.msecs):03d}Z"),
            "level": record.levelname.lower(),
            "kind": record.getMessage(),
        }
        if getattr(record, "box", ""):
            line["box"] = record.box
        for name, value in (getattr(record, "fields", None) or {}).items():
            if value is not None:
                line[name] = value
        return json.dumps(line, default=str)


class HumanLineFormatter(logging.Formatter):
    """The terminal's copy of the same event, in local time and without the
    braces. The gap after the kind is never eaten however long the kind is,
    which the padded print this replaces could not promise. A traceback is not
    mirrored here; the file has it whole."""

    def format(self, record: logging.LogRecord) -> str:
        tag = f"[{record.box}]" if getattr(record, "box", "") else ""
        fields = getattr(record, "fields", None) or {}
        bits = " ".join(f"{name}={value}" for name, value in fields.items()
                        if name != "trace" and value is not None and value != "")
        return (f"{time.strftime('%H:%M:%S', time.localtime(record.created))}  "
                f"{record.getMessage():<9} {tag:<7} {bits}").rstrip()


LOG_LEVEL = _configured_level()
IMAGE_PANEL_LANE = _image_panel_lane()
SPOTIFY_CLIENT_ID = _spotify_client_id()
COMPOSE_FORMAT_DEFAULT = _compose_format_default()
BACKGROUND_DEFAULT = _background_default()
LOGGER = logging.getLogger("facilitator")
LOGGER.setLevel(LOG_LEVELS[LOG_LEVEL])
LOGGER.propagate = False
if not LOGGER.handlers:
    _to_file = DatedRotatingHandler(LOG_DIR, "server", ".log")
    _to_file.setFormatter(JsonLineFormatter())
    LOGGER.addHandler(_to_file)
    # A watching terminal sees INFO and above, in human form: JSON in a terminal
    # is unreadable, and making the terminal readable by making the file
    # unstructured would give up reading the file back with json.loads. Only a
    # terminal, though. Started any other way there is nobody on the other end
    # of standard output, and a copy written there is the same events a second
    # time in a second place, which is what this stopped doing.
    if sys.stdout is not None and sys.stdout.isatty():
        _to_terminal = logging.StreamHandler(sys.stdout)
        _to_terminal.setLevel(logging.INFO)
        _to_terminal.setFormatter(HumanLineFormatter())
        LOGGER.addHandler(_to_terminal)


def _event(level: int, kind: str, box: str = "", /, **fields) -> None:
    """One structured event: kind names it, box is the card it belongs to (empty
    when it belongs to none), and the rest are that kind's own fields. The three
    named parts are positional only, so an event may carry a field called level
    or kind without colliding with the call itself."""
    if LOGGER.isEnabledFor(level):
        LOGGER.log(level, kind, extra={"box": box, "fields": fields})


def _info(kind: str, box: str = "", /, **fields) -> None:
    _event(logging.INFO, kind, box, **fields)


def _debug(kind: str, box: str = "", /, **fields) -> None:
    _event(logging.DEBUG, kind, box, **fields)


def _warning(kind: str, box: str = "", /, **fields) -> None:
    _event(logging.WARNING, kind, box, **fields)


def _error(kind: str, box: str = "", /, **fields) -> None:
    _event(logging.ERROR, kind, box, **fields)


# ---- the transport's libraries -------------------------------------------------
# uvicorn speaks HTTP and Starlette routes the requests; both are installed
# into the .venv beside this file from requirements.txt. Imported here, after
# the logger exists, so a board started without them writes one line saying
# so and says one sentence on the terminal, instead of dying of an import
# nobody is there to read. A Python older than 3.11 is turned away the same
# way, before them: the request bodies are read under asyncio.timeout, which
# 3.11 brought, so on an older one the board would start and then fail every
# change made on it. facilitator run starts it on the Python 3.14 in .venv.
if sys.version_info < (3, 11):
    _running = ".".join(str(part) for part in sys.version_info[:3])
    _error("startuprefused", reason="python is older than 3.11")
    sys.exit(f"facilitator's server needs Python 3.11 or newer and this is {_running}. Start it with "
             "facilitator run, which uses the Python 3.14 in .venv, or run ./install.sh to rebuild .venv.")
try:
    import anyio
    import h11
    import http_ece
    import uvicorn
    from cryptography.hazmat.primitives.asymmetric import ec
    from starlette.applications import Starlette
    from starlette.concurrency import run_in_threadpool
    from starlette.requests import ClientDisconnect, Request
    from starlette.responses import Response, FileResponse
    from starlette.routing import Route
    from uvicorn.protocols.http.h11_impl import H11Protocol
except ImportError:
    _error("startuprefused", reason="requirements are not installed")
    sys.exit("facilitator needs the packages in requirements.txt: beside server.py run ./install.sh, "
             "which builds .venv on Python 3.14 and installs them, then start the board with facilitator run")


CRASH_FRAMES = 12           # frames a crash line walks back through, innermost last
CRASH_MESSAGE_CHARS = 200   # of an exception's own words, the first this many
# What an exception's message may be made of for a line to carry it at all:
# plain words and the punctuation a sentence needs. An interpreter phrases some
# messages by quoting the value it choked on, and that value can be text out of
# a request, so a message that is anything but plain words is dropped whole and
# the line names the type alone.
CRASH_PLAIN = frozenset("abcdefghijklmnopqrstuvwxyz"
                        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.:;()-")


def _crash_fields(error: BaseException) -> dict:
    """What a crash line says about an exception that got away, with nothing in
    it that is a path or could be something a caller sent.

    The type is always safe to write down and is what a line always carries.
    The message is checked before it is kept, by the rule above. The place is
    the innermost frame, named by the file's own name and never by where that
    file sits, and the frames behind it are the same three parts each: enough
    to walk back to the line without printing a machine's folders."""
    walked = [f"{os.path.basename(frame.filename)}:{frame.name}:{frame.lineno}"
              for frame in traceback.extract_tb(error.__traceback__)[-CRASH_FRAMES:]]
    words = str(error)
    return {"error": type(error).__name__,
            "message": words[:CRASH_MESSAGE_CHARS] if words and set(words) <= CRASH_PLAIN else None,
            "where": walked[-1] if walked else None,
            "frames": walked or None}


def _log_file() -> Path:
    """What GET /log tails: the day's server file, unless FACILITATOR_LOG names
    another one, which is the override that route has always had."""
    named = os.environ.get("FACILITATOR_LOG")
    return Path(named) if named else LOG_DIR / f"server-{time.strftime('%Y%m%d')}.log"


# ---- what the pages report ---------------------------------------------------
# The pages have no other way to say that something broke: 41 empty catch blocks
# and 61 swallowing .catch tails turn a failure into silence. A report is one
# thing a page noticed, and it goes in its own file beside the server's, never
# into the transcript. The caps below are what bound the disk: a page's own
# counters die on reload, so a page throwing during boot and reloading in a
# cycle has fresh counters every time and only the server's cap is a cap.
CLIENT_PAGES = ("board", "phone", "page")
CLIENT_KINDS = ("error", "rejection", "fetch", "render", "slow", "incident",
                "pushreceived", "notifycheck", "notifylost",
                "notifytapready", "notifytap", "notifyarrive", "notifyresult")
# the kind of window a page is open in, and its id for one page load: the same
# page in the Chrome window, the Electron app and the Tauri app is otherwise
# indistinguishable. Only these names and 16 hex characters are ever kept
CLIENT_NAMES = ("chrome", "electron", "tauri", "safari", "phone", "other")
CLIENT_WINDOW_ID = re.compile(r"[a-f0-9]{16}", re.ASCII)
CLIENT_MAX_BODY = 16 * 1024   # bytes in one batch
CLIENT_MAX_REPORTS = 20       # reports in one batch
CLIENT_MAX_CHARS = 500        # characters of any one string a report carries
CLIENT_PER_MINUTE = 10        # writes per key per minute; the rest are dropped and counted
# a phone that was out of reach sends everything its worker kept at once, and
# the worker keeps 50, so that kind may write more than the rest in a minute
CLIENT_KIND_PER_MINUTE = {"pushreceived": 60}
CLIENT_WINDOW = 60.0          # the minute that cap is measured over
CLIENT_KEYS_KEPT = 512        # keys the cap remembers before the stale ones are swept
# what a report may carry at all; anything else a page sends is dropped here
CLIENT_FIELDS = ("message", "file", "line", "col", "count", "late", "doing", "route")
INCIDENT_PER_MINUTE = 4      # one key, regardless of reason, card or operation
INCIDENT_EVENTS = frozenset(("create", "select", "focus", "send", "operation", "request",
                            "render", "stage", "observer", "drawer", "viewport", "lifecycle", "problem", "freeze", "mark"))
INCIDENT_EVENTS_V3 = INCIDENT_EVENTS | frozenset(("input", "scroll", "frame", "timer", "phase", "poll"))
INCIDENT_EVENTS_V4 = INCIDENT_EVENTS_V3 | {"enter"}
INCIDENT_SCHEMA = 6          # what /m/state offers the phone; every older version is still read
INCIDENT_REASONS = ("manual", "slow-ui", "slow-request", "invariant", "problem", "freeze")
INCIDENT_REASONS_V5 = INCIDENT_REASONS + ("no-scroll",)
INCIDENT_NUMBERS = {"ms": 600000, "seq": 1000000000, "status": 599, "serverMs": 600000,
                    "rev": 1000000000000, "boxes": 10000, "vh": 10000, "vt": 10000,
                    "late": 600000, "resume": 1000000000, "count": 1000000, "bytes": 16000000}
INCIDENT_FLAGS = frozenset(("present", "shown", "title", "titled", "emptyTitle", "editing", "known",
                            "kb", "lifting", "visible", "online", "editor", "editorReady", "inputReady",
                            "selectedDom", "paneBlank", "loading", "connected", "formatted", "active",
                            "changed", "persisted"))
INCIDENT_CHOICES = {"phase": ("start", "end"), "route": ("/send", "/create", "/m/state"),
                    "side": ("left", "right"), "source": ("settings", "shortcut"),
                    "outcome": ("minted", "applied", "retry", "unsure", "failed"),
                    "lifecycle": ("start", "hidden", "visible", "pageshow", "pagehide", "online", "offline"),
                    "problem": ("error", "rejection", "render", "fetch"),
                    "stage": ("create-response", "card-insertion", "editor-init", "selected-ready", "title-input"),
                    "observer": ("loop-limit", "undelivered")}
INCIDENT_BOX = re.compile(r"(?:[mt]?\d+(?:\.\d+)*|q)", re.ASCII)
INCIDENT_OP = re.compile(r"(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})")
INCIDENT_BUILD = re.compile(r"[a-z0-9._-]{1,64}", re.ASCII)
INCIDENT_SESSION = re.compile(r"[a-f0-9]{16}", re.ASCII)
INCIDENT_ACTIONS = ("drawer", "card", "response-scroll", "project", "state")
INCIDENT_PARTS = ("touch", "intent", "touch-end", "handler", "menu-commit", "frame-one",
                  "frame-two", "transition", "select", "tickets", "tabs", "blur", "scroll-view",
                  "fetch-headers", "json", "apply", "reconcile", "observer")
INCIDENT_PARTS_V5 = INCIDENT_PARTS + ("touch-cancel", "taken", "reply-swap")
# v5: where the response stood and which way the finger went, never where the
# finger was. Only the gesture events carry these
INCIDENT_SCROLL_EVENTS = frozenset(("input", "scroll", "phase"))
INCIDENT_SCROLL_NUMBERS = {"top": 1000000, "range": 1000000, "view": 10000, "lag": 600000,
                           "wait": 600000, "moved": 1000000}
INCIDENT_SCROLL_FLAGS = frozenset(("hist", "far", "same", "prevented"))
INCIDENT_SCROLL_CHOICES = {"edge": ("top", "bottom", "middle", "none"), "dir": ("up", "down"),
                           "focus": ("textarea", "editor", "other", "none"),
                           "by": ("drawer", "cardswipe", "focus", "scrim", "curtain", "panel")}
INCIDENT_ENTER_NUMBERS = {"base": 10000, "inner": 10000, "scale": 1000, "keyCode": 255}
INCIDENT_ENTER_FLAGS = frozenset(("shift", "repeat", "composing", "prevented", "draft", "minted"))
INCIDENT_ENTER_CHOICES = {
    "step": ("capture", "format", "editor", "handler", "beforeinput", "input"),
    "branch": ("seen", "other-key", "composition", "modifier", "send", "shift", "keyboard",
               "repeat", "empty", "held", "row-line", "empty-item", "editor", "no-caret",
               "line-intent", "line-applied"),
    "key": ("Enter", "Unidentified", "Other"),
    "code": ("Enter", "NumpadEnter", "Unidentified", "Other"),
    "target": ("textarea", "editor", "other"), "focus": ("textarea", "editor", "other"),
    "inputType": ("insertLineBreak", "insertParagraph"),
}


def _incident_integer(value, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _incident_box(value) -> bool:
    return isinstance(value, str) and len(value) <= 32 and (not value or bool(INCIDENT_BOX.fullmatch(value)))


def _incident_timing_valid(timing) -> bool:
    """The packed keyboard trace: fixed words, bounded clocks and scroll offsets."""
    if (not isinstance(timing, dict) or set(timing) != {"lost", "longtasks", "rows"}
            or not _incident_integer(timing["lost"], 0, 1000000000)
            or type(timing["longtasks"]) is not bool or not isinstance(timing["rows"], list)
            or len(timing["rows"]) > 240):
        return False
    def number(value, low, high):
        # Bounds also reject NaN and infinity; bool is not a clock reading.
        return type(value) in (int, float) and low <= value <= high
    previous = -120000
    for row in timing["rows"]:
        if (not isinstance(row, list) or len(row) < 3 or not number(row[0], previous, 20000)
                or row[2] not in ("reply", "list")):
            return False
        previous = row[0]
        kind = row[1]
        if kind in ("start", "end"):
            valid = len(row) == 3
        elif kind == "step":
            valid = (len(row) == 7 and number(row[4], 0, 1000000)
                     and all(number(row[i], -120000, 20000) for i in (3, 5, 6)))
        elif kind == "frame":
            valid = len(row) == 4 and number(row[3], -120000, 20000)
        elif kind in ("job-start", "job-end"):
            valid = len(row) == 4 and row[3] in ("board", "json", "list", "reply", "glass")
        elif kind == "longtask":
            valid = len(row) == 4 and number(row[3], 0, 600000)
        else:
            valid = False
        if not valid:
            return False
    return len(json.dumps(timing, separators=(",", ":"))) <= 6144


def _incident_valid(page: str, report: dict) -> bool:
    """No free text; only bounded events and the packed keyboard timing rows. Reject
    unknown fields and bad types before any part of a batch reaches a log."""
    version = report.get("v")
    fields = {"kind", "v", "reason", "marked", "box", "lost", "suppressed", "events"}
    if version in (2, 3, 4, 5, 6): fields.add("build")
    if version in (3, 4, 5, 6): fields.update(("worker", "session"))
    if version == 6: fields.add("timing")
    reasons = INCIDENT_REASONS_V5 if version in (5, 6) else INCIDENT_REASONS
    if (page != "phone" or set(report) != fields
            or type(version) is not int or version not in (1, 2, 3, 4, 5, 6)
            or (version >= 2 and (not isinstance(report["build"], str) or not INCIDENT_BUILD.fullmatch(report["build"])))
            or (version >= 3 and (not isinstance(report["worker"], str) or not INCIDENT_BUILD.fullmatch(report["worker"])
                                  or not isinstance(report["session"], str) or not INCIDENT_SESSION.fullmatch(report["session"])))
            or report["reason"] not in reasons or not _incident_box(report["box"])
            or not _incident_integer(report["marked"], 0, 10000000000000)
            or not _incident_integer(report["lost"], 0, 1000000000)
            or not _incident_integer(report["suppressed"], 0, 1000000000)):
        return False
    if version == 6 and not _incident_timing_valid(report["timing"]):
        return False
    entries = report["events"]
    if not isinstance(entries, list) or not 1 <= len(entries) <= (128 if version >= 3 else 40):
        return False
    previous = -120000 if version >= 3 else -60000
    for entry in entries:
        if (not isinstance(entry, dict) or not {"event", "at", "visible", "online", "resume"} <= entry.keys()
                or not isinstance(entry["event"], str)
                or entry["event"] not in (INCIDENT_EVENTS_V4 if version >= 4 else INCIDENT_EVENTS_V3 if version == 3 else INCIDENT_EVENTS)
                or not _incident_integer(entry["at"], previous, 20000 if version >= 3 else 0)):
            return False
        if entry["event"] == "enter" and not {"step", "branch", "base", "inner", "vh", "vt",
                                                 "scale", "kb", "target", "focus", "draft"} <= entry.keys():
            return False
        previous = entry["at"]
        for name, value in entry.items():
            if name in ("event", "at"):
                continue
            if name in INCIDENT_FLAGS:
                if type(value) is not bool:
                    return False
            elif name in INCIDENT_NUMBERS:
                if not _incident_integer(value, 0, INCIDENT_NUMBERS[name]):
                    return False
            elif name in INCIDENT_CHOICES:
                if value not in INCIDENT_CHOICES[name]:
                    return False
            elif name == "reason":
                if value not in reasons:
                    return False
            elif version >= 3 and name == "action":
                if value not in INCIDENT_ACTIONS:
                    return False
            elif version >= 3 and name == "part":
                if value not in (INCIDENT_PARTS_V5 if version >= 5 else INCIDENT_PARTS):
                    return False
            elif version >= 4 and entry["event"] == "enter" and name in INCIDENT_ENTER_NUMBERS:
                if not _incident_integer(value, 0, INCIDENT_ENTER_NUMBERS[name]):
                    return False
            elif version >= 4 and entry["event"] == "enter" and name in INCIDENT_ENTER_FLAGS:
                if type(value) is not bool:
                    return False
            elif version >= 4 and entry["event"] == "enter" and name in INCIDENT_ENTER_CHOICES:
                if value not in INCIDENT_ENTER_CHOICES[name]:
                    return False
            elif version >= 5 and entry["event"] in INCIDENT_SCROLL_EVENTS and name in INCIDENT_SCROLL_NUMBERS:
                if not _incident_integer(value, 0, INCIDENT_SCROLL_NUMBERS[name]):
                    return False
            elif version >= 5 and entry["event"] in INCIDENT_SCROLL_EVENTS and name in INCIDENT_SCROLL_FLAGS:
                if type(value) is not bool:
                    return False
            elif version >= 5 and entry["event"] in INCIDENT_SCROLL_EVENTS and name in INCIDENT_SCROLL_CHOICES:
                if value not in INCIDENT_SCROLL_CHOICES[name]:
                    return False
            elif name in ("box", "selected"):
                if not _incident_box(value):
                    return False
            elif name == "op":
                if not isinstance(value, str) or not INCIDENT_OP.fullmatch(value):
                    return False
            else:
                return False
    if version >= 3:
        marks = [e for e in entries if e["event"] == "mark"]
        return len(marks) == 1 and marks[0].get("reason") == report["reason"] and marks[0]["at"] == 0
    return entries[-1]["event"] == "mark" and entries[-1].get("reason") == report["reason"]


# What the phone says about its notifications: a push reaching its worker and
# whether it was shown, what the page finds when it opens or comes back, and
# what became of each tap on a notification (the worker's own line, the card
# reaching the page, and where the card stood once drawn). Every field is a
# fixed word, a flag or a bounded number, or a card id or tap id of a fixed
# form, so no report can carry an address, a key, a token or any text; a report
# with a field not listed, or a value not allowed, refuses the whole batch.
NOTICE_FIELDS = {
    "pushreceived": ("outcome", "reason", "ms", "status", "ago", "n", "worker"),
    "notifycheck": ("source", "perm", "reg", "sub"),
    "notifylost": ("source", "reg"),
    "notifytapready": ("stage", "tap", "box", "at", "worker", "windows", "visibility", "focused"),
    "notifytap": ("box", "tap", "windows", "route", "focus", "opened", "ms", "age"),
    "notifyarrive": ("tap", "box", "via", "reading", "found", "visible", "menu", "home", "hist"),
    "notifyresult": ("tap", "box", "shown", "covered", "pending"),
}
NOTICE_CHOICES = {
    "stage": ("received", "ready"),
    "visibility": ("visible", "hidden", "none"),
    "focused": ("yes", "no", "none"),
    "outcome": ("shown", "skipped"),
    "reason": ("check-failed", "timeout", "not-signed-in", "show-failed", "other"),
    "source": ("start", "return"),
    "perm": ("granted", "denied", "default", "unsupported"),
    "sub": ("yes", "no", "error"),
    "route": ("message", "open", "failed"),
    "focus": ("ok", "rejected", "none"),
    "opened": ("client", "null", "rejected"),
    "via": ("message", "url"),
    "reading": ("yes", "no"), "found": ("yes", "no"), "visible": ("yes", "no"),
    "home": ("yes", "no"), "hist": ("yes", "no"), "shown": ("yes", "no"), "pending": ("yes", "no"),
    "menu": ("cards", "settings", "projects", "none"),
    "covered": ("cards", "settings", "projects", "none"),
}
NOTICE_NUMBERS = {"ms": 600000, "status": 599, "ago": 7776000, "n": 1000000000000,
                  "windows": 1000, "age": 7776000, "at": 10000000000000}
# a tap's id is eight hex characters made by the worker; a page opened with no
# id, by an older worker, says "none"
NOTICE_TAP = re.compile(r"(?:[a-f0-9]{8}|none)", re.ASCII)


def _notice_valid(page: str, report: dict) -> bool:
    """Exactly the fields the kind allows, each of an allowed value. A push
    that was shown has no reason and one that was skipped must have one. A
    tap that asked for a window says how that went and no other tap does; the
    age of the notification is left out when the worker could not tell."""
    allowed = NOTICE_FIELDS[report["kind"]]
    wanted = {"kind", *allowed}
    if report["kind"] == "notifytapready":
        if report.get("stage") == "received":
            wanted.difference_update(("windows", "visibility", "focused"))
        elif report.get("stage") == "ready":
            no_window = report.get("windows") == 0
            if ((report.get("visibility") == "none") != no_window
                    or (report.get("focused") == "none") != no_window):
                return False
    if report["kind"] == "pushreceived":
        if report.get("outcome") == "shown":
            wanted.discard("reason")
        elif report.get("outcome") != "skipped":
            return False
    if report["kind"] == "notifytap":
        if report.get("route") != "open":
            wanted.discard("opened")
        if "age" not in report:
            wanted.discard("age")
    if page != "phone" or set(report) != wanted:
        return False
    for name, value in report.items():
        if name == "kind":
            continue
        if name in NOTICE_CHOICES:
            if not isinstance(value, str) or value not in NOTICE_CHOICES[name]:
                return False
        elif name in NOTICE_NUMBERS:
            if not _incident_integer(value, 0, NOTICE_NUMBERS[name]):
                return False
        elif name == "reg":
            if type(value) is not bool:
                return False
        elif name == "worker":
            if not isinstance(value, str) or not INCIDENT_BUILD.fullmatch(value):
                return False
        elif name == "tap":
            if (not isinstance(value, str) or not NOTICE_TAP.fullmatch(value)
                    or (value == "none" and report["kind"] in ("notifytap", "notifytapready"))):
                return False
        elif name == "box":
            if not _incident_box(value):
                return False
        else:
            return False
    return True


CLIENT_LOGGER = logging.getLogger("facilitator.client")
CLIENT_LOGGER.setLevel(logging.INFO)
CLIENT_LOGGER.propagate = False
if not CLIENT_LOGGER.handlers:
    # delayed, so a board no page has ever reported from has no file at all
    _client_file = DatedRotatingHandler(LOG_DIR, "client", ".jsonl", delay=True)
    _client_file.setFormatter(JsonLineFormatter())
    CLIENT_LOGGER.addHandler(_client_file)

_client_lock = threading.Lock()
_client_seen: dict = {}   # key -> [when its minute started, written, dropped]


def _client_event(kind: str, box: str = "", /, **fields) -> None:
    """One line in the client file. Its own logger and its own file: page
    reports are not board events and must never be read as if they were."""
    CLIENT_LOGGER.info(kind, extra={"box": box, "fields": fields})


def _client_key(page: str, report: dict) -> str:
    """A report's identity: what it says and where it happened. Two throws from
    the same line are one key, however many times they happen."""
    if report["kind"] == "incident":
        return "incident|phone"
    return "|".join(str(report.get(part, "")) for part in
                    ("kind", "message", "file", "line")) + "|" + page


def _client_fields(report: dict) -> dict:
    """Only the fields a report is allowed to carry, each string cut to its cap.
    A page cannot write whatever it likes into a file on this machine."""
    if report["kind"] == "incident":
        names = ("v", "reason", "marked", "lost", "suppressed", "events")
        return {k: report[k] for k in (*names, "build", "worker", "session", "timing") if k in report}
    if report["kind"] in NOTICE_FIELDS:
        # a card's id is the line's own box, written beside the kind
        out = {k: report[k] for k in NOTICE_FIELDS[report["kind"]] if k in report and k not in ("ago", "box")}
        if "ago" in report:
            # the worker says how long ago the push came; the line says when
            then = time.time() - report["ago"]
            out["at"] = (time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(then))
                         + f".{int(then * 1000) % 1000:03d}Z")
        return out
    out = {}
    for name in CLIENT_FIELDS:
        value = report.get(name)
        if isinstance(value, str):
            out[name] = value[:CLIENT_MAX_CHARS]
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            out[name] = value
    return out


def _client_who(batch: dict):
    """Which window sent a batch: its kind and its id for this page load. A page
    opened before the board was updated sends neither, so each may be missing,
    but neither may be anything else. None when one is not what a page sends."""
    who = {}
    if "client" in batch:
        if batch["client"] not in CLIENT_NAMES:
            return None
        who["client"] = batch["client"]
    if "window" in batch:
        value = batch["window"]
        if not isinstance(value, str) or not CLIENT_WINDOW_ID.fullmatch(value):
            return None
        who["window"] = value
    return who


def _client_batch(page: str, reports: list, who: dict) -> tuple:
    """One batch to the client file, under the per key per minute cap: how many
    were written and how many were dropped. What the cap drops is counted and
    said, so a file missing lines says how many are missing rather than quietly
    being short."""
    now = time.time()
    written = 0
    lost = {}
    with _client_lock:
        if len(_client_seen) > CLIENT_KEYS_KEPT:   # a page inventing keys cannot grow this forever
            for stale in [k for k, w in _client_seen.items() if now - w[0] >= CLIENT_WINDOW]:
                del _client_seen[stale]
        for report in reports:
            key = _client_key(page, report)
            window = _client_seen.get(key)
            if window is None or now - window[0] >= CLIENT_WINDOW:
                window = _client_seen[key] = [now, 0, 0]
            limit = (INCIDENT_PER_MINUTE if report["kind"] == "incident"
                     else CLIENT_KIND_PER_MINUTE.get(report["kind"], CLIENT_PER_MINUTE))
            if window[1] >= limit:
                window[2] += 1
                count, _ = lost.get(key, (0, None))
                lost[key] = (count + 1, report)
                continue
            fields = _client_fields(report)
            if report["kind"] == "incident":
                record = CLIENT_LOGGER.makeRecord(CLIENT_LOGGER.name, logging.INFO, "", 0, "incident", (), None,
                                                  extra={"box": report["box"], "fields": {"page": page, **who, **fields}})
                _client_file.emit_confirmed(record)
            else:
                _client_event(report["kind"], str(report.get("box") or "")[:64], page=page, **who, **fields)
            window[1] += 1
            written += 1
    for count, sample in lost.values():
        _client_event("dropped", str(sample.get("box") or "")[:64], page=page, **who,
                      report=sample["kind"], message=str(sample.get("message") or "")[:CLIENT_MAX_CHARS],
                      line=sample.get("line") if isinstance(sample.get("line"), int) else None,
                      dropped=count)
    return written, sum(count for count, _ in lost.values())


class SaveFailed(RuntimeError):
    """The board's state could not be written to disk. Its own exception rather
    than a bare OSError, so the POST dispatch can answer this one and nothing
    else, and no other failure is quietly turned into a 500."""


def _lane_dirs() -> dict:
    """Per-owner project directory from run.config.json (machine-local, gitignored);
    served to the page for the pwd line, never part of tracked content."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        return {}
    lanes = cfg.get("lanes", [])
    return {ln["owner"]: str(Path(ln["dir"]).expanduser())
            for ln in lanes if ln.get("owner") and ln.get("dir")}
STATE_PATH = HERE / "state.json"
TRANSCRIPT_PATH = HERE / "transcript.jsonl"
# held by the running server for as long as it runs: one server per folder,
# and the pid and port it names are how the CLI finds this board on any port
SERVER_LOCK = HERE / "server.lock"
# uploaded images now save outside the repo, in the sibling internal folder
# (not a git repo, never pushed); reads still fall back to the old in-repo
# uploads/ so the images saved there before this change keep resolving
INTERNAL_UPLOADS = HERE.parent / "facilitator-internal" / "uploads"
# Lane panels remain image-only. Uploads also accept media and documents.
IMG_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
UPLOAD_TYPES = {**IMG_TYPES,
                ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime",
                ".webm": "video/webm", ".ogv": "video/ogg",
                ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
                ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
                ".opus": "audio/ogg", ".weba": "audio/webm",
                ".pdf": "application/pdf", ".doc": "application/msword",
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
# The board's pair of ports: PORT for the desktop and the agents, and the
# phone's guarded socket one above it. run.config.json's port names the pair,
# and `facilitator run` moves it to a free pair when something else holds this
# one, so the port is read rather than assumed. A test's copy of this file sets
# FACILITATOR_TEST_PORT, which wins over the config, so no config a test
# carries can steer it onto a real port; older tests swap the text of the line
# below for their own port, which lands the same way.
DEFAULT_PORT = 8877


def _configured_port() -> int:
    """FACILITATOR_TEST_PORT when it is set, else run.config.json's port when
    it is a whole number from 1 to 65534 (the pair needs the one above it),
    else DEFAULT_PORT. Read here, once, because the sockets are bound before
    anything else is read; a missing or unreadable config is the default, the
    way the agent skill's helper reads it."""
    named = os.environ.get("FACILITATOR_TEST_PORT")
    if named:
        return int(named)
    try:
        value = json.loads((HERE / "run.config.json").read_text()).get("port")
        number = None if isinstance(value, bool) else int(value)
    except Exception:
        number = None
    return number if number is not None and 1 <= number <= 65534 else DEFAULT_PORT


PORT = _configured_port()
BRIDGE_PORT = PORT + 1  # a distinct socket; never infer trust from Host or proxy headers
# ---- the transport's bounds ------------------------------------------------------
# What the board accepts at once and how long it lets a peer sit on the line.
# The numbers are for one Mac serving one desktop, one phone through the
# tunnel and a few agent loops, with room for a runaway; how they protect the
# commands is explained with the Transport class below.
LISTEN_BACKLOG = 128
CONNECTION_LIMIT = 200          # connections open at once before uvicorn answers 503
WAIT_SLOTS = 8                  # agent long polls held open at once
READ_SLOTS = 32                 # board readings in flight at once, their sending included
THREAD_POOL_SIZE = 64           # worker threads the routes' locked work may use
FIRST_REQUEST_TIMEOUT = 15.0    # seconds a new connection may sit before its request arrives
KEEP_ALIVE_TIMEOUT = 5          # seconds an idle kept-alive connection is held between requests
WRITE_STALL_TIMEOUT = 30.0      # seconds an answer may sit unread in a full socket before the connection is cut
BODY_READ_TIMEOUT = 30.0        # seconds a request body may take to arrive
GRACEFUL_STOP_TIMEOUT = 3       # seconds a stop waits for open requests before cutting them
MAX_TEXT_BODY = 1024 * 1024     # bytes of a plain text body: a message, a reply, a text file
MAX_UPLOAD_BODY = 100 * 1024 * 1024   # bytes of one attachment
# an attachment is not held to BODY_READ_TIMEOUT: a phone video over a slow
# link can need minutes, and a flat total cuts a slow but steady upload as
# surely as a dead one. It is cut when nothing has arrived for the first clock,
# and in any case once the second has run out
UPLOAD_STALL_TIMEOUT = 60.0     # seconds an upload may go with no bytes arriving
UPLOAD_TIME_LIMIT = 3600.0      # seconds a whole upload may take
UPLOAD_RECEIPTS = 256           # finished uploads remembered by operation id, newest kept
MAX_IMG_PREVIEW = 25 * 1024 * 1024    # bytes of an in-root image the navigator will preview inline
# the control bytes a real text file never carries: every C0 control except tab,
# newline, carriage return and form feed. A file can decode as utf-8 and still be
# binary (an ascii-only payload, or bytes that merely validate), so the navigator
# treats any of these, or a decode failure, as "not text": such a file is never
# opened in the editor and never overwritten by an editor save.
_TEXT_FORBIDDEN = bytes(b for b in range(0x20) if b not in (0x09, 0x0a, 0x0c, 0x0d))
# ---- operation receipts ----------------------------------------------------------
# A receipt lives at most OP_RETENTION and is never let go by the count cap
# while it is younger than OP_EVICT_FLOOR. The phone stops retrying an operation
# far sooner than the floor (see OP_GIVE_UP in m.html), so an id a phone could
# still be sending is never dropped, and a retry never finds its receipt gone
# and lands a second time. The cap only trims receipts already older than any
# live retry; under one person's use the store never approaches it.
OP_RETENTION = 7 * 86400        # seconds a receipt is kept at the very most
OP_EVICT_FLOOR = 2 * 86400      # a receipt younger than this is kept whatever the cap
OP_KEEP = 4000                  # the soft cap the count is trimmed toward, oldest-and-old first
OP_ASK_MAX = 32                 # receipts one reading of the board may ask after
OP_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
BG_STALE = 75.0   # seconds without a /ping before a registered job stops counting as green
# view pages a project may hold at once. A page is four short fields, so the cap
# is not about disk: it is what keeps the switcher at the foot of the workspace a
# row of dots a hand can hit rather than a strip nobody can aim at
PAGE_LIMIT = 24
# seconds a claim may sit unconfirmed before it goes back to the queue. Short on
# purpose: the whole point is that a hand-off lost on the wire comes back while
# the message still matters, not fifteen minutes later
ACK_GRACE = 90.0
# Version 1 removes the old convention that treated a line containing only ---
# as a hidden short/full delimiter. Existing state is split once in _migrate;
# every new reply has explicit fields and the Markdown renderer is never asked
# to infer application state from authored punctuation.
REPLY_VARIANTS_VERSION = 1
# Transcript rows written before this physical marker used the retired ---
# convention. Rows after it do not. File order, rather than event timestamps,
# is the durable boundary because transcript timestamps are authored data and
# may be missing, malformed, duplicated, or in the future.
TRANSCRIPT_REPLY_SCHEMA = "reply_variants"
# Version 1 gives every card its own count of final replies, which is what the
# reply-history arrows walk. The aggregate "replies" count includes progress
# notes and so cannot answer whether a card has an older page. Cards written
# before this are counted once from the transcript, since only the transcript
# holds what a card was answered with before now.
HISTORY_COUNTS_VERSION = 1
# How many older replies one card's history offers, on both sides of the same
# answer: the count sent with the card and the list GET /history hands out are
# capped here together, so neither can promise a page the other cannot reach.
# This is a cap on final replies only, unlike /thread's n, which counts every
# row of the conversation.
HISTORY_MAX = 200
# Answered batches (2026-09-11): which of the owner's messages one completed
# reply was actually given. Only the board can state that, so it is recorded
# where a delivery happens (a claim, or a mid-work hand-over) and written down
# beside the reply that answers it. Version 1 is the boundary: a reply recorded
# before it carries no batch and never has one reconstructed for it, because
# nothing durable says what a reply of that age was handed. Unknown stays
# unknown, and is a different fact from a reply that was handed nothing.
ANSWERED_BATCH_VERSION = 1
# There is deliberately no cap on a batch, and no count, text or payload cap
# standing in for one. Every message a completed reply was handed belongs to
# it, with its own identity, its own words and its own send time, however many
# there are: the batch states an exact association, and a trimmed association
# is a false one. Nothing between the hand-over and the card, the history or
# the transcript row shortens it.
# HISTORY_MAX above is a different thing entirely: it caps how many PAGES of
# reply history one card offers, never what any one of those pages answered.
BUILTIN_OWNERS = ("facilitator",)  # the tool's own lane, always present
OWNERS = BUILTIN_OWNERS
# facilitator is the only built-in owner; every other lane is registered from
# data (run.config.json, saved cards, stored projects) at load and at creation

# names for unnamed cards, handed out without repeats among live cards
FAIRY_NAMES = (
    "Thistledown Pixie Waltz", "Mossbank Sprite Parade", "Glowworm Court Jester",
    "Dewdrop Troll Picnic", "Bramble Elf Sonata", "Foxglove Gnome Errand",
    "Toadstool Fae Council", "Willow Wisp Detour", "Acorn Imp Heist",
    "Fernshade Nixie Riddle", "Clover Brownie Feast", "Pondlight Kelpie Drift",
    "Twilight Boggart Shuffle", "Honeymead Dryad Toast", "Frostbell Goblin March",
    "Starlit Selkie Crossing", "Buttercup Ogre Nap", "Silverfern Faun Prank",
    "Mushroom Hobgoblin Tea", "Cobweb Banshee Lullaby", "Riverbed Undine Chorus",
)
# The canonical Omni title and the typed words that ask for one. Both are kept
# character for character with card-logic.js (omniTicket, omniEntry), so the
# page and the board can never read one title two ways: ASCII digits with no
# leading zero, up to the largest whole number a page's script holds exactly,
# and the same explicit white space and line breaks on both sides.
OMNI_TITLE_RE = re.compile(r"Omni Ticket #([1-9][0-9]*)")
OMNI_MAX = 2 ** 53 - 1
_OMNI_BREAK = re.compile(r"[\n\r\v\f\x1c\x1d\x1e\x85\U00002028\U00002029]")
_OMNI_SPACE = re.compile(
    r"[\t\n\v\f\r \xa0\U00001680\U00002000-\U0000200a\U00002028\U00002029\U0000202f\U0000205f\U00003000]+")
_OMNI_NUMBER = re.compile(r"#?([1-9][0-9]*)")
_LANE_DIRS = {}

SEED_PATH = HERE / "seed.json"

_lock = threading.Condition()
_state: dict = {}
# runtime-only listener presence (not persisted), per owner: how the UI knows
# whether each agent's long-poll is actually connected right now
_waiters = {ow: 0 for ow in OWNERS}
# zero, not boot time: a lane counts as alive only once its agent actually asks
_last_wait = {ow: 0.0 for ow in OWNERS}
# the name each lane's agent last stated on its /wait call; None until stated
_agent_names: dict = {ow: None for ow in OWNERS}


def _agent_kind(owner: str) -> str:
    """claude, codex or other: which agent the lane's listener said it was on
    its last /wait, or other when none has said since the start. A reply's
    transcript row carries this one word, never the name itself, so the daily
    usage counts (usage_counts.py) can split replies by agent."""
    said = (_agent_names.get(owner) or "").lower()
    return "claude" if "claude" in said else "codex" if "codex" in said else "other"


# ---- waking the listeners --------------------------------------------------------
# The agents' long polls wait on the event loop, not on the condition above.
# Every change to the board comes through _notify: it moves a version number
# and asks the loop to wake every waiter, and a waiter that reads the version
# before sleeping and again on waking can never miss a change that landed in
# between. _LOOP is the running loop, set by the application's lifespan; a
# change made before it runs, or after it has gone, wakes nobody, and that is
# right, since nobody is waiting then.
_change_version = 0
_LOOP = None
_wakers: set = set()
_STOPPING = threading.Event()   # set by the stop signal: waiters go home at once


def _wake_all() -> None:
    for ev in list(_wakers):
        ev.set()


def _notify() -> None:
    """The board changed: whoever is waiting for that should look again.
    Callers hold _lock."""
    global _change_version
    _change_version += 1
    loop = _LOOP
    if loop is not None:
        try:
            loop.call_soon_threadsafe(_wake_all)
        except RuntimeError:
            pass   # the loop is closed: nobody is left to wake


def _register_owner(ow: str) -> None:
    """A stored or just-created project lane joins the runtime owner set and
    the listener-presence structures; idempotent, so _migrate can re-run it."""
    global OWNERS
    if ow not in OWNERS:
        OWNERS = OWNERS + (ow,)
    _waiters.setdefault(ow, 0)
    _last_wait.setdefault(ow, 0.0)
    _agent_names.setdefault(ow, None)


def _sync_owner_registries() -> None:
    """Bring the runtime owner set and its presence maps back in step with the
    state: the built-in facilitator, the run.config.json lanes, the projects the
    state holds and any owner a saved card carries, in that order, and nothing
    else. Run after the state is put back by a failed save, so a lane a route
    registered before that save is forgotten with it, while the live counts of
    every lane that stays are kept. Callers hold _lock."""
    global OWNERS
    kept = list(BUILTIN_OWNERS)
    for ow in _LANE_DIRS:
        if ow not in kept:
            kept.append(ow)
    for p in _state.get("projects", []):
        if isinstance(p, dict) and p.get("id") and p["id"] not in kept:
            kept.append(p["id"])
    for b in _state.get("boxes", []):
        ow = b.get("owner") if isinstance(b, dict) else None
        if ow and ow not in kept:
            kept.append(ow)
    OWNERS = tuple(kept)
    for registry in (_waiters, _last_wait, _agent_names):
        for ow in [ow for ow in registry if ow not in OWNERS]:
            del registry[ow]
    for ow in OWNERS:
        _waiters.setdefault(ow, 0)
        _last_wait.setdefault(ow, 0.0)
        _agent_names.setdefault(ow, None)


def _lane_pwds() -> dict:
    """Every lane's folder in one map: the built-in owners sit in this folder,
    run.config.json overrides them, project lanes carry their own stored dir.
    The page reads this as /state's pwds and /laneimg resolves against it, so
    the two can never disagree about where a lane lives."""
    return {**{ow: str(HERE) for ow in OWNERS}, **_LANE_DIRS,
            **{p["id"]: p["dir"] for p in _state.get("projects", [])}}


def _lane_internal(lane: str) -> Path | None:
    """A lane's own internal folder, <lane dir>/<lane id>-internal: where that
    project keeps the files that belong to it and never get pushed. This repo's
    own facilitator-internal/ is already exactly that, one folder up from here.
    None for a lane nobody has heard of."""
    d = _lane_pwds().get(lane)
    return Path(d) / (lane + "-internal") if d else None


# the lanes the file navigator is mounted on, and the two folders each of them
# may read and write: that lane's own internal folder and its wiki beside it.
# The folder names come off the lane's own directory and not its owner id,
# because a lane can be named for its work while its folder is named for its
# project directory. Worked out per lane rather than written down as paths,
# the way _lane_internal already does it, so no one machine's home directory
# gets into tracked source and a lane moved on disk carries its folders with it.
# The lane list is what makes this a fence: a lane not on it has no folders at
# all here, and every route below then refuses it.
NAV_LANES = _navigator_lanes()
NAV_KINDS = ("internal", "wiki")


def _nav_roots(lane: str) -> list[tuple]:
    """One lane's allowed folders as (kind, folder) pairs, fully resolved, in the
    order the page's head offers them. Resolved once here so every path check
    downstream compares real paths against real paths: a root that is itself
    reached through a symlink still matches the files inside it. Each folder
    carries its kind rather than the caller counting on the order, so a folder
    that could not be resolved at all takes only its own place out of the list.
    A lane the panel is not mounted on, and a lane nobody has heard of, yield
    nothing, and every route then refuses."""
    d = _lane_pwds().get(lane) if lane in NAV_LANES else None
    if not d:
        return []
    out = []
    for kind in NAV_KINDS:
        try:
            out.append((kind, (Path(d) / (Path(d).name + "-" + kind)).resolve()))
        except OSError:
            pass   # unreadable or a symlink loop: the folder simply is not offered
    return out


def _nav_path(lane: str, root: str, rel: str) -> Path | None:
    """The file a navigator request names, or None when it is not genuinely one
    of that lane's. root is a folder name and rel is a path under it, and the
    root has to be one of the two this lane itself owns: one lane asking for
    another lane's folder by name gets nothing, since that name is not among
    these. resolve() is what does the rest: it eats .. segments and follows
    every symlink, so the containment test below sees where the path really
    lands and not what it was spelled as. An absolute rel replaces the root
    outright under pathlib's join, which is exactly why the same test catches
    it. Any file type now, not markdown alone: what a file can be opened or saved
    as is decided by the caller's own regular-file and text checks, not by its
    name. Never the folder itself, and never a path that lands outside the root,
    so a symlink pointing out of the folder still resolves to nothing here."""
    bases = {p.name: p for _, p in _nav_roots(lane)}
    base = bases.get(root)
    if base is None or not rel:
        return None
    try:
        p = (base / rel).resolve()
    except OSError:
        return None
    return p if p != base and base in p.parents else None


def _looks_text(data: bytes) -> bool:
    """Whether a byte string is editable text rather than binary that happens to
    decode. NUL and the other C0 control bytes are the tell of a binary file, so
    their presence is a no up front; then a clean utf-8 decode is required. The
    control-byte scan is one C-level translate, so this stays cheap on a whole
    file. Kept separate from every path check because it is the gate that decides
    what may open in the editor and what may be written back over an existing
    file, and both sides have to apply exactly the same rule."""
    if data.translate(None, _TEXT_FORBIDDEN) != data:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def _read_capped(p: Path, cap: int) -> bytes | None:
    """At most cap+1 bytes of an already-resolved path, or None when it is not a
    regular file the server may read. One reader for the editor read, the
    overwrite check and the image preview, so allocation is always bounded by
    cap+1 and never sized by the file on disk. The open is non-blocking, so a
    fifo swapped in at the path never stalls a worker: it opens at once and is
    then rejected by the regular-file test on the descriptor. O_NOFOLLOW guards
    the final component: _nav_path already resolved every symlink, so the real
    file is opened directly and a link planted at the path between resolve and
    open is refused rather than followed. A len of cap+1 is the caller's signal
    that the file is over its ceiling."""
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        with os.fdopen(fd, "rb", closefd=True) as fh:
            fd = -1
            return fh.read(cap + 1)
    except OSError:
        return None
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


# extensions whose files are a recognized binary container even when a stretch of
# their bytes happens to be ascii: a PDF, an office document, an archive, a media
# file, a compiled artifact, a database. _looks_text alone cannot catch these,
# since a minimal PDF is all printable ascii yet editing it as text corrupts its
# byte offsets. This is a deliberate, NOT exhaustive, deny-list for the one job of
# keeping the text editor from opening or overwriting a known container; it makes
# no claim to detect every binary format. svg is intentionally absent: it is text,
# editable, and separately previewable as an image. Unknown and extensionless
# names are left to _looks_text, so plain notes and source files still open.
_BINARY_EXTS = frozenset({
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
    "rtf", "pages", "numbers", "epub", "mobi",
    "zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "war", "whl",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff",
    "heic", "heif",
    "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba",
    "mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "ogv",
    "woff", "woff2", "ttf", "otf", "eot",
    "exe", "dll", "so", "dylib", "class", "pyc", "wasm", "o", "a",
    "db", "sqlite", "sqlite3",
})


def _binary_ext(rel: str) -> bool:
    """Whether a name ends in a recognized binary/container extension the text
    editor must never open or overwrite. Extension only, by design: see
    _BINARY_EXTS. Not a universal binary test."""
    return Path(rel).suffix.lower().lstrip(".") in _BINARY_EXTS


def _nav_entry(e: "os.DirEntry", base: Path) -> dict:
    """One directory entry as the navigator lists it, without ever following a
    link that leaves the root. A symlink pointing outside the two folders is
    named but marked unavailable and never resolved for its content; a symlink
    inside is classified by what it points at; a fifo, socket or device is named
    but not offered. Dotfiles and dotfolders are listed like any other name, so
    the panel really does show everything that is in the folder."""
    name = e.name
    try:
        if e.is_symlink():
            try:
                real = Path(e.path).resolve()
                inside = real != base and base in real.parents
            except OSError:
                inside = False
            if not inside:
                return {"name": name, "type": "other", "avail": False,
                        "reason": "link outside the folder"}
        # after the guard above, is_dir/is_file may follow the link safely: it is
        # either not a link at all or one that already lands inside this root
        if e.is_dir():
            return {"name": name, "type": "dir", "avail": True}
        if e.is_file():
            st = e.stat()
            return {"name": name, "type": "file", "avail": True,
                    "ext": Path(name).suffix.lower().lstrip("."),
                    "size": st.st_size, "mtime": str(st.st_mtime_ns)}
    except OSError:
        return {"name": name, "type": "other", "avail": False, "reason": "unreadable"}
    return {"name": name, "type": "other", "avail": False, "reason": "not a regular file"}


def _nav_stamp(p: Path) -> str:
    """A file's modification time as the stale-write guard carries it: whole
    nanoseconds, as a decimal string. A string because the number is around
    1.8e18 and a browser would round it away as a double, and the guard has to
    compare exactly. Agents edit these files too, so this is the whole reason a
    save can be refused."""
    return str(p.stat().st_mtime_ns)


# the worktree names a lane can offer, cached per lane for a few seconds. the
# card's top bar asks for these, and it asks on every tab switch and every
# opening of the list, so a bare shell-out on each call would put a git process
# on the board's own thread several times a second. git itself is the only
# source: a worktree name has to point at a worktree that exists, and the page
# offers no way to type one in, so a stale or invented name cannot get in.
_WT_CACHE: dict = {}
_WT_TTL = 15.0


def _wt_list(d: Path) -> dict | None:
    """git's own worktree listing for one folder, parsed, or None when that
    folder is not a checkout at all. Read only: it runs git's list and writes
    nothing. None and not an empty answer, because the caller has to tell "no
    repository here, try the next folder" apart from "a repository with nothing
    to offer", and only the first of those is worth another look."""
    if not d.is_dir():
        return None
    try:
        # --porcelain is the stable form: one paragraph per worktree, the path
        # on a "worktree " line and the ref on a "branch " line. a detached head
        # carries no branch line at all and is skipped, since it names nothing a
        # card could be moved onto
        raw = subprocess.run(["git", "worktree", "list", "--porcelain"],
                             cwd=str(d), capture_output=True, text=True, timeout=5)
    except Exception:
        return None       # no git on this machine, or the folder went away under us
    if raw.returncode != 0:
        return None       # exit 128, "not a git repository": nothing here to list
    out = {"current": "", "names": []}
    here, path = d.resolve(), None
    for line in raw.stdout.splitlines():
        if line.startswith("worktree "):
            path = Path(line[9:]).resolve()
        elif line.startswith("branch "):
            name = line[7:].removeprefix("refs/heads/")
            if name not in out["names"]:
                out["names"].append(name)
            if path == here:
                out["current"] = name
    return out


def _lane_worktrees(lane: str) -> dict:
    """The lane folder's own checked-out branch and the branches of every
    worktree of the same repository, newest listing first. Read only, and it
    never raises: a lane with no repository under it, or a machine with no git,
    hands back nothing at all, so the bar shows no name and offers no list.

    Two folders are tried, in this order. A lane's dir is often a wrapper rather
    than the checkout itself, with the repository one level in, in a child named
    after the wrapper: a wrapper folder holds a same-name checkout beside its
    own siblings. So the lane's own folder is asked first, and the same-name
    child only if that folder is not a checkout. Only ever the same-name child
    and never an arbitrary one: a wrapper may also hold an unrelated reference
    checkout under a different name, and offering its branches as the lane's own
    would be a quiet lie. A wrapper with no same-name checkout under it simply
    has no repository, which is the true answer for it."""
    d = _lane_pwds().get(lane)
    if not d:
        return {"current": "", "names": []}
    hit = _WT_CACHE.get(lane)
    if hit and time.time() - hit[0] < _WT_TTL:
        return hit[1]
    out = None
    try:
        here = Path(d)
        for cand in (here, here / here.name):
            out = _wt_list(cand)
            if out is not None:
                break
    except Exception:
        out = None        # an unusable path: the lane simply offers nothing
    if out is None:
        out = {"current": "", "names": []}
    _WT_CACHE[lane] = (time.time(), out)
    return out


def _seed_state() -> dict:
    """First-ever start: board title and boxes come from seed.json if present
    (the item shape is under "Seeding a board" in RUNBOOK.md); otherwise the
    board starts empty."""
    seed = json.loads(SEED_PATH.read_text()) if SEED_PATH.exists() else {}
    return {
        "title": seed.get("title", "facilitator"),
        # seeded ids are kept as written, and a numeric one is shown as its own
        # card number (ticketNum in card-logic.js). quick notes attach by that
        # number, so a change to how seeded ids are numbered has to be carried
        # into the quick note system as well: card-logic.js quickNoteRef and
        # quickNoteCard (which also settles a seeded 12 against a made m12),
        # _post_quicknote_new and _post_quicknote_attach in this file, and
        # parked/quick-note.js syncQuickNoteChip
        "boxes": [
            {
                "id": it["id"], "bucket": it["bucket"], "title": it["title"],
                "reply": it.get("context", ""),
                "reply_full": it.get("context", ""),
                "reply_short": it.get("context", ""),
                "pending": [], "done": False, "docked": False, "replies": 0,
                "owner": it.get("owner", "facilitator"),
            }
            for it in seed.get("items", [])
        ],
        "inbox": [],          # box ids, FIFO (shared; owner-filtered at claim time)
        "busy": {ow: None for ow in OWNERS},   # box id each agent is composing for
        "claimed": {ow: [] for ow in OWNERS},  # message ids in each current claim
        "busy_ts": {ow: 0.0 for ow in OWNERS},
        # confirmed delivery bookkeeping, one slot per owner beside the claim
        # itself: {box, token, ts, confirmed} for the claim in play, None when
        # the lane holds nothing
        "ack": {ow: None for ow in OWNERS},
        "next_mid": 1,
        "next_bid": 1,
    }


def _backup_state() -> None:
    """A copy of state.json beside it, taken once before the first save that
    adds the revision and the receipts: the way back to the server this file
    replaced is to stop the board and rename the copy over state.json. The
    name is the only thing written down about it; the folder is not."""
    stamp = time.strftime("%Y%m%dT%H%M%S")
    kept = STATE_PATH.with_name(f"state.json.bak-{stamp}")
    try:
        shutil.copy2(STATE_PATH, kept)
    except OSError as e:
        _error("backupfail", reason=e.strerror or type(e).__name__)
        return
    _info("backup", kept=kept.name)


def _load() -> None:
    global _state, _LANE_DIRS
    _LANE_DIRS = _lane_dirs()
    if STATE_PATH.exists():
        _state = json.loads(STATE_PATH.read_text())
        if isinstance(_state, dict) and "rev" not in _state:
            _backup_state()
    else:
        _state = _seed_state()
    for b in _state["boxes"]:  # ages start counting from first sight
        b.setdefault("ts", time.time())
    _migrate()


def _legacy_reply_variants(value: str) -> tuple[str, str]:
    """Reproduce the retired browser split for pre-version-1 saved data only.

    This is deliberately a migration helper, not part of card formatting or a
    fallback for new writes. A --- inside a column-zero backtick fence remains
    content, and only the first outside fence was ever a delimiter.
    """
    text = value or ""
    lines = text.split("\n")

    def clipped(part: list[str]) -> str:
        while part and not part[0].strip():
            part.pop(0)
        while part and not part[-1].strip():
            part.pop()
        return "\n".join(part)

    in_code = False
    for index, line in enumerate(lines):
        if line.startswith("```"):
            in_code = not in_code
            continue
        if not in_code and line.strip() == "---":
            return clipped(lines[:index]), clipped(lines[index + 1:])
    return text, text


def _set_reply_variants(box: dict, full: str, short: str | None = None) -> None:
    """Store explicit full and small-card text; reply stays as a full-text shim."""
    box["reply_full"] = full
    box["reply_short"] = full if short is None else short
    box["reply"] = full


def _row_reply_full(event: dict, legacy: bool) -> str:
    """The full-text variant of one transcript reply row.

    legacy says the row stands before the durable schema marker, which is the
    only thing that may revive the retired --- delimiter. Every reader of a
    reply row goes through here, so /thread and the history count can never
    read the same row two different ways."""
    if "reply_full" in event or "reply_short" in event:
        return event.get("reply_full", event.get("text", ""))
    if legacy:
        return _legacy_reply_variants(event.get("text", ""))[1]
    return event.get("text", "")


def _answered_out(value) -> list | None:
    """One answered batch as a client reads it: the words and the send time of
    each message that reply was given, in the order they were sent.

    None is the honest answer for a reply the board recorded nothing for, and an
    empty list is a reply that was handed nothing. Those are different facts and
    a caller may act on either, so they are never folded together. A stored
    entry that is not a message record is dropped rather than guessed at."""
    if not isinstance(value, list):
        return None
    out = []
    for rec in value:
        if not isinstance(rec, dict):
            continue
        ts = rec.get("ts", 0)
        out.append({"text": rec.get("text", ""),
                    "ts": ts if isinstance(ts, (int, float)) else 0})
    return out


def _row_reply_meta(event: dict) -> dict:
    """One history page's own identity, completion time and answered batch.

    The identity is the board's name for that reply, so two replies with the
    same words, or two completed in the same second, are still two pages a
    client can tell apart and hold its own state for. The time is when that
    reply was completed, read off the row itself and never off a later note.

    A row written before this feature carries none of it. Its identity and its
    batch are then null, which says the association is unknown, and nothing is
    rebuilt from the rows around it: the transcript records what was said, not
    which messages any one reply was handed."""
    rid = event.get("reply_id")
    ts = event.get("reply_ts", event.get("ts", 0))
    return {
        "id": rid if isinstance(rid, str) and rid else None,
        "ts": ts if isinstance(ts, (int, float)) else 0,
        "answered": _answered_out(event.get("answered")),
    }


def _older_replies(box: dict) -> int:
    """How many older pages this card's reply history holds: every final reply
    except the one the card is showing, and never more than the history route
    hands out. A progress note is not a page of the history and never hides the
    reply it was written over.

    This is the count /state sends and GET /history is the list of the same
    thing. One rule decides both: which rows count (final replies only) and
    which one is the page you are on (the card's reply_kind, never a guess made
    by comparing text). So the marks a page draws before it asks and the list
    it walks when it does cannot say different things."""
    count = box.get("full_replies", 0)
    if box.get("reply_kind") == "agent":
        count -= 1     # the newest final reply is the one on the card
    return max(min(count, HISTORY_MAX), 0)


def _is_reply_schema_boundary(event: dict) -> bool:
    """True only for our durable transcript schema marker."""
    try:
        version = int(event.get("version", 0))
    except (TypeError, ValueError):
        return False
    return (event.get("kind") == "schema" and
            event.get("schema") == TRANSCRIPT_REPLY_SCHEMA and
            version >= REPLY_VARIANTS_VERSION)


def _scan_transcript_replies() -> dict:
    """Per card: how many final replies the transcript holds, and what wrote
    the words the card is showing. One pass over the whole file, for the
    one-time count of cards answered before the board kept this itself.

    What wrote the card is the kind of the last row that writes one, in file
    order. Never by matching that row's text against the card, because a
    progress note that repeats the answer under it word for word would then
    read as the answer itself and hide a page that is really there.

    Rows are read the way /thread reads them, so the count a page is told and
    the list it walks are made of the same rows: rows written twice under one
    operation id are one event."""
    found: dict = {}   # box id -> [final replies, kind of the last row that wrote the card]
    seen_ops: set = set()
    try:
        with TRANSCRIPT_PATH.open(errors="replace") as transcript:
            for line in transcript:
                try:
                    event = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if not isinstance(event, dict):
                    continue
                kind = event.get("kind")
                if kind not in ("agent", "note", "progress"):
                    continue
                bid = event.get("box")
                if not isinstance(bid, str):
                    continue
                op = event.get("op")
                if isinstance(op, str) and op:
                    if (kind, op) in seen_ops:
                        continue
                    seen_ops.add((kind, op))
                record = found.setdefault(bid, [0, ""])
                if kind == "agent":
                    record[0] += 1
                record[1] = kind
    except FileNotFoundError:
        pass
    return found


def _ensure_reply_schema_boundary() -> None:
    """Append the v1 transcript boundary exactly once.

    The transcript is append-only. Scanning for the marker makes this safe when
    a process stops between appending it and saving state: the next start sees
    the already-durable marker instead of appending another. The state version
    records that the migration ran, but readers deliberately trust file order.
    """
    found = False
    needs_separator = False
    try:
        with TRANSCRIPT_PATH.open(errors="replace") as transcript:
            for line in transcript:
                try:
                    event = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if isinstance(event, dict) and _is_reply_schema_boundary(event):
                    found = True
                    break
    except FileNotFoundError:
        pass
    try:
        with TRANSCRIPT_PATH.open("rb") as transcript:
            transcript.seek(0, os.SEEK_END)
            if transcript.tell():
                transcript.seek(-1, os.SEEK_END)
                needs_separator = transcript.read(1) != b"\n"
    except FileNotFoundError:
        pass
    if not found or needs_separator:
        marker = {
            "kind": "schema",
            "schema": TRANSCRIPT_REPLY_SCHEMA,
            "version": REPLY_VARIANTS_VERSION,
        }
        with open(TRANSCRIPT_PATH, "a", opener=_private_opener) as transcript:
            # A crash or manual repair may have left a truncated final JSON
            # object with no newline. Separate it before the schema event so
            # the durable boundary is independently parseable and all later
            # appends start on their own records.
            if needs_separator:
                transcript.write("\n")
            if not found:
                transcript.write(json.dumps(marker) + "\n")
            transcript.flush()
            os.fsync(transcript.fileno())
    _state["transcript_reply_variants_version"] = REPLY_VARIANTS_VERSION


def _backfill_rest_stamps() -> None:
    """Give each docked, parked or done card missing its section time the time of
    the latest matching dock, park or done event, and its own ts
    when the transcript holds none. Only a missing stamp is filled and nothing
    else on a card is touched, so a start with every stamp in place reads no
    transcript and changes nothing. Callers hold _lock or run before serving."""
    missing = [(b, flag, stamp)
               for b in _state["boxes"]
               for flag, stamp in (("docked", "docked_ts"), ("parked", "parked_ts"), ("done", "done_ts"))
               if b.get(flag) and not isinstance(b.get(stamp), (int, float))]
    if not missing:
        return
    latest: dict = {}   # (box id, event kind) -> time of the last such row in file order
    try:
        with TRANSCRIPT_PATH.open(errors="replace") as transcript:
            for line in transcript:
                try:
                    event = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if not isinstance(event, dict) or event.get("kind") not in ("dock", "park", "done"):
                    continue
                bid, ts = event.get("box"), event.get("ts")
                if isinstance(bid, str) and isinstance(ts, (int, float)) and not isinstance(ts, bool):
                    latest[(bid, event["kind"])] = ts
    except FileNotFoundError:
        pass
    now = time.time()
    for b, flag, stamp in missing:
        kind = {"docked": "dock", "parked": "park", "done": "done"}[flag]
        b[stamp] = latest.get((b["id"], kind)) or b.get("ts") or now


def _migrate() -> None:
    """Apply each versioned, idempotent upgrade to saved board state."""
    _state.pop("paused", None)   # the pause switch is gone; drop what an older board saved
    _state.pop("end", None)   # the end switch is gone; drop what an older board saved
    _state.setdefault("title", "facilitator")
    # owners come from data, not code: the built-in facilitator, the lanes named
    # in run.config.json, the stored project lanes, and any owner a saved card
    # already carries. Registered here, before the per-owner loops below lay out
    # each lane's slots, workspaces and pages
    for ow in _LANE_DIRS:
        _register_owner(ow)
    for p in _state.setdefault("projects", []):
        _register_owner(p["id"])
    for b in _state["boxes"]:
        if b.get("owner"):
            _register_owner(b["owner"])
    # monotonic box-id counter: count-based ids collided after a deletion.
    # it is the source of every card number, so a change to it has to be carried
    # into the quick note system too: card-logic.js quickNoteRef and quickNoteCard
    # (the "card N" / "cN" parser and its lookup), _post_quicknote_new and
    # _post_quicknote_attach in this file (the attach routes) and
    # parked/quick-note.js syncQuickNoteChip (the note chip);
    # _create_box_record lists them in full
    _state.setdefault("next_bid", 1 + max(
        [int(b["id"][1:]) for b in _state["boxes"]
         if b["id"].startswith("m") and b["id"][1:].isdigit()] or [0]))
    for b in _state["boxes"]:
        b.setdefault("owner", "facilitator")
        # Docked is a separate section flag; older cards begin in Doing and
        # old pages still read their usual working/queued/reply machine state.
        b.setdefault("docked", False)
    if not isinstance(_state.get("busy"), dict):  # scalar claim slots -> per-owner maps
        _state["busy"] = {ow: None for ow in OWNERS}
        _state["claimed"] = {ow: [] for ow in OWNERS}
        _state["busy_ts"] = {ow: 0.0 for ow in OWNERS}
    # confirmed delivery (2026-08-25): state written before it existed has no
    # ack map at all, and an empty one reads exactly like no claim in play
    _state.setdefault("ack", {})
    # a third owner appearing in OWNERS gets its claim slots on upgrade
    for slot in ("busy", "claimed", "busy_ts", "ack"):
        if isinstance(_state.get(slot), dict):
            for ow in OWNERS:
                _state[slot].setdefault(ow, [] if slot == "claimed" else (0.0 if slot == "busy_ts" else None))
    _state.setdefault("ever_listened", {})
    # the last push that actually worked (2026-09-03): null, like an absent
    # field, means none ever has, which is the truthful reading of older state
    _state.setdefault("push_last_ok", None)
    # the revision and the receipts (2026-09-06): every saved change moves the
    # revision, so a phone can name the reading it holds and be told whether it
    # is current; the receipts are what a command sent again is answered from
    _state.setdefault("rev", 0)
    if not isinstance(_state.get("ops"), dict):
        _state["ops"] = {}
    # workspaces (2026-08-09): each owner gets at least one, a named collection
    # of chats aimed at a goal, with a task list the human and agent both edit
    ws = _state.setdefault("workspaces", {})
    for ow in OWNERS:
        if not ws.get(ow):
            started = min([b.get("ts", time.time()) for b in _state["boxes"]
                           if b.get("owner") == ow] or [time.time()])
            ws[ow] = [{"id": "w1", "name": "main", "started": started,
                       "goal": "", "tasks": [], "current": None}]
    _state.setdefault("next_tid", 1)
    # view pages (2026-09-10): each project's own ordered list of the
    # environments it can be looked at in. This is a view record and nothing
    # more: it holds no cards, no chats and no tasks, and it is deliberately
    # separate from the workspaces above, which carry a goal and a task list
    # and are what the cards are filed under.
    # Only a project with no key at all is given its opening board page. An
    # empty list is a project whose pages were all removed by hand, and it is
    # left empty, so a deleted page cannot come back on the next reading
    pages = _state.setdefault("pages", {})
    for ow in OWNERS:
        if ow not in pages:
            pages[ow] = [_page_record("pg1", "board")]
    # never reused, like the box counter: a page id that has been deleted does
    # not come back on a later page and take a stale selection with it
    _state.setdefault("next_pgid", 1 + max(
        [int(p["id"][2:]) for lst in pages.values() if isinstance(lst, list) for p in lst
         if isinstance(p, dict) and str(p.get("id", "")).startswith("pg")
         and str(p["id"])[2:].isdigit()] or [0]))
    # the project tab bar (2026-09-02): which tabs are shown and in what order
    # is one board-wide record, not one browser's own. An empty order is a
    # board that has never had one written, and every page then falls back to
    # the natural lane order it always used
    if not isinstance(_state.get("tabs"), dict):
        _state["tabs"] = {}
    for field in ("order", "closed"):
        if not isinstance(_state["tabs"].get(field), list):
            _state["tabs"][field] = []
    for b in _state["boxes"]:
        b.setdefault("ws", ws[b.get("owner", "facilitator")][0]["id"])
        b.setdefault("task", None)
        b.setdefault("agent_ts", 0)
        # how many of this card's replies have been read (2026-09-02): a board
        # record, so opening a card on the phone marks it read on the board
        b.setdefault("seen", 0)
        # the ready-to-test marker (2026-09-21): a durable per-card flag the
        # agent sets once a delivered change is actually available for the
        # reader to try. Cards written before it default off.
        b.setdefault("testing", False)
        # the crease a ticket kept once that marker was lowered (2026-09-27) is
        # retired: the fold leaves no mark. Cards saved while it lived carry a
        # creased flag nothing reads, so it is dropped here.
        b.pop("creased", None)
    # the card state machine (2026-08-26): boxes written before it carry the
    # old scattered flags. bg and bg_ts collapse into hb; a fresh heartbeat
    # keeps its green (deferred if a turn was recorded under the flag), a dead
    # flag hands a recorded turn over now, and everything else lands where it
    # rests. ball_due dies here; ball stays as the machine's turn register
    for b in _state["boxes"]:
        b.setdefault("ball", "you")
        if "state" not in b:
            b["hb"] = b.get("bg_ts", 0) if b.get("bg") else 0
            if _hb_live(b):
                b["state"] = "deferred" if b.get("ball_due") else "working"
            else:
                if b.get("ball_due"):
                    b["ball"] = "you"
                b["state"] = _rest(b)
        b.setdefault("hb", 0)
        for k in ("ball_due", "bg", "bg_ts"):
            b.pop(k, None)
    # Reply variants (2026-09-01) are a one-time data representation migration.
    # A box that already has either explicit field is new-schema data even when
    # a top-level marker is absent, as happens for a fresh seed or a partially
    # migrated state. Only a genuine legacy box with neither field is split.
    if _state.get("reply_variants_version", 0) < REPLY_VARIANTS_VERSION:
        for b in _state["boxes"]:
            if "reply_full" in b or "reply_short" in b:
                full = b.get("reply_full", b.get("reply", ""))
                short = b.get("reply_short", full)
            else:
                short, full = _legacy_reply_variants(b.get("reply", ""))
            _set_reply_variants(b, full, short)
        _state["reply_variants_version"] = REPLY_VARIANTS_VERSION
    else:
        # Versioned state should already have both fields. Defaults make a box
        # manually added by an older helper safe without reviving the delimiter.
        for b in _state["boxes"]:
            full = b.get("reply_full", b.get("reply", ""))
            _set_reply_variants(b, full, b.get("reply_short", full))
    # The old first-pass timestamp cutoff was not a stable schema boundary.
    # Drop it and append a file-order marker after every pre-v1 transcript row.
    _state.pop("reply_variants_migrated_at", None)
    _ensure_reply_schema_boundary()
    # Older replies (2026-09-10): the card carries its own count of final
    # replies, so a page can draw the history arrows in the frame the card
    # appears in rather than after reading the transcript. reply_kind says what
    # wrote the text the card is showing, which is what decides whether the
    # newest final reply is the page you are on or a page behind you.
    # Cards answered before this are counted once, from the transcript, and
    # their reply_kind is the kind of the last row that wrote them, in file
    # order, which is the same thing the routes record from here on.
    if _state.get("history_counts_version", 0) < HISTORY_COUNTS_VERSION:
        counted = _scan_transcript_replies()
        for b in _state["boxes"]:
            count, kind = counted.get(b["id"], (0, ""))
            b["full_replies"] = count
            b["reply_kind"] = kind
        _state["history_counts_version"] = HISTORY_COUNTS_VERSION
    else:
        # a box added by an older helper or by hand carries neither field, and
        # no older page can be walked on a card the board knows no replies of
        for b in _state["boxes"]:
            b.setdefault("full_replies", 0)
            b.setdefault("reply_kind", "")
    # Answered batches (2026-09-11): the messages one completed reply was given,
    # kept beside the reply itself. None of it can be worked out after the fact,
    # so every card answered before now starts with the association unknown and
    # keeps it until that card is answered again. The box a card draws over its
    # answer is only ever filled from a batch the board itself recorded.
    #   handed     the messages the claim in force handed over, written whole by
    #              each claim and emptied when that claim is let go
    #   batch      what the progress notes on the way have already consumed
    #              toward the completed reply still to come
    #   batch_gap  a hand-over reached the agent that this board has no record
    #              of, so the batch cannot be stated and the reply that follows
    #              says unknown rather than offering a part of itself as the
    #              whole. It is cleared by that reply, and the card records
    #              exactly from there on
    #   answered   what the last completed reply was given: a list, or None for
    #              unknown. An empty list is a reply that was handed nothing,
    #              which is a different fact and stays one. It is never capped
    #              or trimmed, however many messages one answer covers
    #   reply_id   that reply's own name, unique for the life of the board, so
    #              repeated words and one second holding two replies still name
    #              two pages
    #   reply_ts   when it was completed. agent_ts moves on progress notes too,
    #              so it cannot mean this and is left alone
    if _state.get("answered_batches_version", 0) < ANSWERED_BATCH_VERSION:
        for b in _state["boxes"]:
            b["handed"] = []
            b["batch"] = []
            # a claim, or a note's worth of messages, may already stand behind
            # the answer this card is about to be given, and nothing durable
            # says which messages those were: the first completed reply from
            # here says unknown, and every one after it is exact
            b["batch_gap"] = True
            b["answered"] = None
            b["reply_id"] = ""
            b["reply_ts"] = 0
        _state["answered_batches_version"] = ANSWERED_BATCH_VERSION
    else:
        # a box added by an older helper or by hand starts recorded and empty:
        # nothing has ever been handed over on it, and no claim of its own can
        # have stood across the upgrade
        for b in _state["boxes"]:
            b.setdefault("handed", [])
            b.setdefault("batch", [])
            b.setdefault("batch_gap", False)
            if not isinstance(b.get("answered"), list):
                b["answered"] = None
            b.setdefault("reply_id", "")
            b.setdefault("reply_ts", 0)
    _state.setdefault("next_reply_id", 1)
    # quick notes (2026-09-26): the owner's jotted notes, each standing alone or
    # attached to one card. a board from before them simply has none, and the
    # id counter is never reused, like the box and page counters, so a stale
    # page holding a deleted note's id can never land on a newer note
    if not isinstance(_state.get("quicknotes"), list):
        _state["quicknotes"] = []
    _state.setdefault("next_qnid", 1 + max(
        [int(n["id"][2:]) for n in _state["quicknotes"]
         if isinstance(n, dict) and str(n.get("id", "")).startswith("qn")
         and str(n["id"])[2:].isdigit()] or [0]))
    # when each deferred or done card was put there, for the Deferred and Done
    # tabs to list by: cards saved before the board stamped them are filled once
    # from the transcript and from then on the routes keep the stamps
    _backfill_rest_stamps()
    _save()


# the exact bytes of the last state.json this process durably wrote, kept so a
# save that fails can put memory back to what the disk holds. None until the
# first durable write of this run, which is the migration's own save
_last_durable: str | None = None
# ---- what waits for the commit ----------------------------------------------------
# A mutation is one held stretch of _lock: change the state, note the events,
# save. Two kinds of thing must not happen before the save has installed the
# new file, because a save can fail and the state then goes back: the
# transcript row and log line of each event, and the push that tells a phone
# a card turned to its owner. Both are queued here by the routes and helpers
# and written or started by _save once the rename has succeeded; a failed save
# drops them. So the transcript never presents a rolled-back message as
# history, the log never says a rolled-back event happened, and no phone is
# woken for a reply the board does not have.
_transcript_due: list = []   # (event row, kind, box, chars, log fields), under _lock
_push_due: list = []         # box ids whose turn is to be pushed once the save lands, under _lock


def _side_effect_failure(kind: str, box: str = "", **fields) -> None:
    """Record a post-commit failure when logging itself still works. Nothing
    after the state-file rename may raise back into the request and make an
    installed mutation look refused."""
    try:
        _error(kind, box, **fields)
    except Exception:
        pass


def _commit_side_effects() -> None:
    """After a successful rename: append the queued transcript rows in one
    open, write their log lines, and start the pushes. The state is already
    installed, so a transcript that cannot be appended is written down as its
    own failure and never fails the save; the state stays the source of truth
    and the transcript is the record that follows it."""
    global _transcript_due, _push_due
    due, _transcript_due = _transcript_due, []
    pushes, _push_due = _push_due, []
    if due:
        try:
            # Encode the batch before opening the file. A malformed internal
            # event then appends none of the batch instead of a prefix of it.
            encoded = "".join(json.dumps(event) + "\n"
                              for event, _kind, _box, _chars, _fields in due)
            with open(TRANSCRIPT_PATH, "a", opener=_private_opener) as f:
                f.write(encoded)
        except Exception as e:
            _side_effect_failure("transcriptfail", rows=len(due),
                                 reason=getattr(e, "strerror", None) or type(e).__name__)
        for _event, kind, box, chars, fields in due:
            try:
                _info(kind, box, chars=chars, **fields)
            except Exception as e:
                _side_effect_failure("logfail", box, event=kind,
                                     reason=type(e).__name__)
    for bid in pushes:
        try:
            threading.Thread(target=_push_turn, args=(bid,), daemon=True).start()
        except Exception as e:
            _side_effect_failure("pushfail", bid, reason=type(e).__name__)


def _discard_side_effects() -> None:
    """After a failed save: what was queued belongs to changes the board has
    just taken back, so none of it is written or sent."""
    _transcript_due.clear()
    _push_due.clear()


def _restore_last_durable() -> None:
    """Put _state back to the last bytes that reached the disk, and everything
    that lives beside the state back in step with it. Callers hold _lock.
    After this, memory and disk agree again, so a command whose save failed
    did not happen: its retry re-applies from scratch, its receipt is not there
    to answer from, its transcript row and push are dropped, and a lane it
    registered is forgotten. Before the first durable write there is nothing
    to go back to, and the failing start is left to stop."""
    _discard_side_effects()
    if _last_durable is not None:
        restored = json.loads(_last_durable)
        _state.clear()
        _state.update(restored)
        _sync_owner_registries()


def _durable_fsync(fd: int) -> None:
    """Push a file's bytes as far toward the platter as the platform allows.
    On macOS a plain fsync only hands the bytes to the drive, which may still
    reorder them across a power cut; F_FULLFSYNC is the call that waits for the
    drive to actually persist them. Where that control is missing this is an
    ordinary fsync, which is the honest most other platforms give."""
    full = getattr(fcntl, "F_FULLFSYNC", None)
    if full is not None:
        try:
            fcntl.fcntl(fd, full)
            return
        except OSError:
            pass   # not offered on this filesystem; fall back to the ordinary flush
    os.fsync(fd)


def _save() -> None:
    """The board to disk: a temp file beside it, then one rename, so a reader
    never sees half a state, and so a save that cannot finish leaves the last
    good file exactly as it was.

    A failure here used to leave the lock and the whole POST dispatch with no
    answer ever written, so the page's fetch hung until the socket closed. Now
    it says which step failed, puts memory back to what the disk holds, and
    raises itself, and the dispatch answers 500. Putting memory back is what
    keeps the board's memory from ever running ahead of its file: a command
    whose save failed did not happen, so its retry re-applies honestly and its
    receipt is not left behind to answer a repeat from. The reason is the
    operating system's own word for it and never the name of the file it could
    not write: a log line is not the place for a path.

    Every save is a new revision of the board, and the effect, the receipt of
    the command that made it and the revision number are one serialization, so
    a reader or a restart sees all three or none. The revision only advances
    once the rename has installed the new file; a save that fails puts it back.

    What a successful save proves, exactly: the new file's bytes were flushed
    (F_FULLFSYNC where the platform offers it, an ordinary fsync elsewhere) and
    the rename installed it, so a crash after the rename keeps the new state, a
    crash before it the old, and there is no half file either way. The folder
    entry is flushed afterwards on a best effort: a folder that cannot be
    flushed does not undo the commit, since the rename has already happened and
    going back to old memory then would lie about the file that is installed,
    but it is written down as a syncfail line rather than passed over. None of
    this certifies a hardware power cut; it is as far as the calls reach."""
    global _last_durable
    _state["rev"] = int(_state.get("rev", 0)) + 1
    payload = json.dumps(_state, indent=1)
    tmp = STATE_PATH.with_suffix(".tmp")
    try:
        with open(tmp, "w", opener=_private_opener) as f:
            f.write(payload)
            f.flush()
            _durable_fsync(f.fileno())
    except OSError as e:
        _restore_last_durable()   # nothing was installed; memory goes back to the file
        _error("savefail", step="write", reason=e.strerror or type(e).__name__)
        raise SaveFailed("write") from e
    try:
        os.replace(tmp, STATE_PATH)
    except OSError as e:
        tmp.unlink(missing_ok=True)
        _restore_last_durable()   # the rename did not happen; the old file still stands
        _error("savefail", step="replace", reason=e.strerror or type(e).__name__)
        raise SaveFailed("replace") from e
    # the new file is installed: this is the commit point, and nothing past it
    # may undo the save, so the folder sync that follows never fails it. It is
    # not silent either: a folder that cannot be flushed is a durability gap
    # worth a line, even though the commit stands
    _last_durable = payload
    try:
        fd = os.open(STATE_PATH.parent, os.O_RDONLY)
        try:
            _durable_fsync(fd)
        finally:
            os.close(fd)
    except OSError as e:
        _side_effect_failure("syncfail", step="folder",
                             reason=e.strerror or type(e).__name__)
    _commit_side_effects()


def _log(kind: str, box: str, text: str, log_fields: dict | None = None, **fields) -> None:
    """One board event: the transcript keeps it whole, text and all, because the
    transcript is the discussion's durable record. The log gets the same event
    without the text, only its length, since GET /log hands the log to any
    caller on this machine and what was said is not its business. log_fields
    carries what is safe to write down beside it and never reaches the
    transcript row.

    Nothing is written here. The row and the log line are held until the save
    that follows has installed the new state file, and are dropped if it does
    not, so neither the transcript nor the log can say that something happened
    which the board then rolled back. Every caller holds _lock and saves in the
    same held stretch; the save is what writes these out."""
    event = {"ts": time.time(), "kind": kind, "box": box, "text": text}
    event.update(fields)
    _transcript_due.append((event, kind, box, len(str(text or "")), dict(log_fields or {})))


# the window in which a page holds its own write on top of the server's answer,
# TAB_HOLD and SEEN_HOLD in card-logic.js. A second write landing inside it is
# one the losing page never sees, which is the whole reason it is invisible
OVERWRITE_HOLD = 3.0
_last_change: dict = {}   # (record, box, field) -> when that record last changed


def _overwrite(record: str, box: str, field: str, before, after) -> None:
    """A write that changed a record another write had only just changed.

    In memory and never in state.json, because this is diagnosis and must not
    add a write to the write it is diagnosing. Neither route carries any device
    identity, so the line cannot honestly say who lost: it says that a second
    write landed inside the hold window, what it changed, and how far apart the
    two were."""
    if before == after:
        return          # nothing was overwritten; the same record written twice
    now = time.time()
    was = _last_change.get((record, box, field))
    if was is not None and now - was < OVERWRITE_HOLD:
        _info("overwrite", box, record=record, field=field, ms=round((now - was) * 1000))
    _last_change[(record, box, field)] = now


def _box(bid: str) -> dict | None:
    return next((b for b in _state["boxes"] if b["id"] == bid), None)


def _box_has_content(box: dict) -> bool:
    """The persisted conversation test used by every destructive close path."""
    return (box.get("replies", 0) > 0 or
            bool((box.get("reply") or "").strip()) or
            bool(box.get("pending")))


def _stamp_rest(box: dict, now: float) -> None:
    """Keep docked_ts, parked_ts and done_ts in step with their flags: a stamp
    is written the moment its flag turns on, kept while the flag stays on, and
    dropped when it turns off. Docked, Deferred and Done list by these times.
    Callers hold _lock, change the flags first and save after."""
    for flag, stamp in (("docked", "docked_ts"), ("parked", "parked_ts"), ("done", "done_ts")):
        if box.get(flag):
            box.setdefault(stamp, now)
        else:
            box.pop(stamp, None)


def _mark_box_done(box: dict) -> str:
    box["done"] = True
    box["docked"] = False
    box["parked"] = False
    box["testing"] = False   # a closed card is not awaiting a test
    _stamp_rest(box, time.time())
    _log("done", box["id"], "")
    return "done"


def _remove_empty_meta_box(box: dict) -> str:
    """Remove one already-validated empty meta card. Caller holds _lock."""
    bid = box["id"]
    _state["boxes"].remove(box)
    if bid in _state["inbox"]:
        _state["inbox"].remove(bid)
    ow = box.get("owner", "facilitator")
    if _state["busy"][ow] == bid:
        _state["busy"][ow] = None
        _state["claimed"][ow] = []
    # a quick note attached to the card that is going stands alone again,
    # rather than naming a card the board no longer has. with the quick note
    # hidden the stored notes are left exactly as they are
    if QUICK_NOTES_ON:
        for note in _state.get("quicknotes", []):
            if note.get("card") == bid:
                note["card"] = None
    _log("delete", bid, box["title"])
    return "deleted"


def _close_box(box: dict) -> str:
    """Close from current state; only an empty meta card may be destroyed."""
    if box["bucket"] != "meta" or _box_has_content(box):
        return _mark_box_done(box)
    return _remove_empty_meta_box(box)


def _ws(owner: str, wid: str) -> dict | None:
    return next((w for w in _state.get("workspaces", {}).get(owner, [])
                 if w["id"] == wid), None)


# ---- a project's view pages -------------------------------------------------
# The environments one project can be looked at in, in the order the switcher at
# the foot of the workspace draws them. kind is "board" for the page that shows
# the project's own board, the one every project opens with, and "blank" for a
# page added since, which shows an empty canvas in the same project. Nothing a
# project owns hangs off a page, so removing one never takes a card, a chat, a
# workspace or a task with it.
def _page_record(pid: str, kind: str) -> dict:
    return {"id": pid, "kind": kind, "created": time.time()}


def _pages(owner: str) -> list:
    return _state.setdefault("pages", {}).setdefault(owner, [])


# ---- the card's state machine ---------------------------------------------
# One explicit state per box, box["state"], moved only by events; the color is
# a pure read of it (_shown). Three things sit outside the machine and only
# mask that read, each already state of its own: the owner's done and parked
# shelf bits, and the lane's claim slot (busy), all of which show their color
# while the flow keeps moving beneath, so lifting any of them shows exactly
# the card that went in. ball survives as the machine's turn register ("me" =
# the agent owes the reader, "you" = a reply awaits the reader): the page reads whose-turn
# off it, so it ships as written, but no color is ever computed from it.
#
# state (color)   new       untouched card (grey; yellow when born the reader's, ball
#                           "you": a seeded or standing card)
#                 queued    a message from the reader waits on the agent (grey)
#                 working   the flag's heartbeat is beating (green)
#                 note      an interim progress note while its heartbeat is
#                           beating (green; no turn waits on the reader)
#                 deferred  working, plus a reply that becomes the reader's turn the
#                           moment the work ends (green)
#                 yours     an unanswered reply awaits the reader (yellow)
#                 rest      nothing pending either way (grey)
# event           /send                    -> clears parked, then queued; a
#                                          beating flag keeps its
#                                          green, and a deferred turn dies:
#                                          the reader has answered
#                 /reply                   -> yours; flag still beating ->
#                                          deferred; leftover msgs -> queued
#                 /note                    -> note, starts heartbeat, consumes
#                                          and releases a claim, ball stays me
#                 /progress                no turn handed over; claim stays held
#                 /working v=1, /ping      -> working (note/deferred stay)
#                 flag drop or 75s expiry  -> deferred hands its turn over and
#                                          lands yours; working/note land at _rest
#                 /dismiss                 -> _rest, a beating flag excepted
# _rest, the landing rule: pending -> queued, never touched -> new, ball
# "you" -> yours, else rest. Expiry is swept lazily at /state and /wait,
# beside the unacked-claim clock, and by /working itself.

GREEN = ("working", "note", "deferred")


def _hb_live(b: dict) -> bool:
    """The flag's heartbeat is fresh: hb (0 = no flag registered) was beaten
    within BG_STALE. A registered flag gone quiet greys out but stays
    registered, so a late /ping turns the card green again; only /working
    v=0 unregisters."""
    return (time.time() - b.get("hb", 0)) < BG_STALE


def _green(b: dict) -> None:
    """A beating flag turns the card green; semantic green states such as note
    and deferred stay exactly what they were."""
    if b["state"] not in GREEN:
        b["state"] = "working"


def _rest(b: dict) -> str:
    """Where a card lands when no work holds it green."""
    if b["pending"]:
        return "queued"
    if not b.get("agent_ts", 0) and not b["replies"]:
        return "new"
    return "yours" if b.get("ball", "you") == "you" else "rest"


def _shown(b: dict) -> str:
    """The one value a card's color and sort come from: the masks first (the
    owner's shelf, then the lane's held claim), then the machine state. deferred
    wears working's green, rest wears queued grey, and note stays explicit for
    the page to paint with working's green. Docked adds no mask: it keeps these
    colors, and an older page that ignores the flag still puts it in Doing."""
    s = ("done" if b["done"] else "parked" if b.get("parked", False)
         else "working" if _state["busy"].get(b.get("owner", "facilitator")) == b["id"]
         else b["state"])
    return {"deferred": "working", "rest": "queued"}.get(s, s)


def _await_reader_test(b: dict) -> bool:
    """The one condition a card may be flagged ready-to-test in: a completed
    reply is waiting on the reader and no work is in flight. It reads the machine
    state through the same facts _shown does, but ignores the parked shelf so a
    deferred (shelved) card still awaiting the reader qualifies. Excluded: a done
    card, a live job, a held claim, and every state still owed to the agent
    (queued, new, working, note, the green deferred, and the quiet rest). This
    guards the set path so the marker can never declare active, queued or done
    work available."""
    if b.get("done"):
        return False
    if _hb_live(b):
        return False
    if _state["busy"].get(b.get("owner", "facilitator")) == b["id"]:
        return False
    return b.get("state") == "yours"


def _turn_to_you(b: dict) -> None:
    """The one move that makes a card the owner's turn. The turn register
    flips, the moment is kept so the phone can tell which card turned last,
    and a push is queued for every phone subscribed. Callers hold _lock and
    save right after: the push starts only once that save has installed the
    turn, so a phone is never woken for a reply the board then rolled back. The
    bridge check and the push run on their own thread, so no request waits on
    either. Exactly two events lead here: a plain reply with no live working
    flag, and a deferred turn handed over when its flag drops or expires. A
    progress note never does."""
    b["ball"] = "you"
    b["turn_ts"] = time.time()
    if _state.get("push_subs"):
        _push_due.append(b["id"])


def _handover(b: dict) -> None:
    """A deferred card leaving green: the reply recorded under the flag is
    finally waiting on the reader, so the turn register flips as the state moves."""
    if b["state"] == "deferred":
        _turn_to_you(b)
        _log("handover", b["id"], "working flag down, deferred turn handed over")


def _release_claim(b: dict, for_answer: bool = False) -> str:
    """Consume this box's handed-over messages and free its lane. Messages sent
    while the agent was composing were not in the claim, so they stay pending
    and return to the queue exactly once. Callers hold _lock.

    for_answer says what becomes of the messages that claim handed over. The
    agent writing about them passes it: a progress note keeps them for the
    completed reply still to come, and that reply takes them. Every other way of
    letting a claim go is discarding them unanswered, which is exactly what
    dismissing a card does -- drop what is queued and clear the claim -- so the
    default drops them from the answer as well as from the queue, and no later
    reply can inherit them.

    Nothing else here changes with it. The queue, the lane and the inbox are
    handled exactly as they always were either way, so a caller that knows
    nothing about answered batches keeps the behaviour it has always had and
    gets the safe reading of its own intent."""
    ow = b.get("owner", "facilitator")
    claimed = set(_state["claimed"][ow]) if _state["busy"][ow] == b["id"] else set()
    b["pending"] = [m for m in b["pending"] if m["mid"] not in claimed]
    _consume_claim(b, claimed, for_answer)
    if _state["busy"][ow] == b["id"]:
        _state["busy"][ow] = None
        _state["claimed"][ow] = []
    if b["pending"] and b["id"] not in _state["inbox"]:
        _state["inbox"].append(b["id"])
    if not b["pending"] and b["id"] in _state["inbox"]:
        _state["inbox"].remove(b["id"])
    return ow


def _handed_record(m: dict) -> dict:
    """One handed-over message, in the shape the answered box draws it."""
    rec = {"mid": m.get("mid"), "text": m.get("text", ""), "ts": m.get("ts", 0)}
    if m.get("via"):
        rec["via"] = m["via"]
    return rec


def _pending_states(b: dict) -> list:
    """Where each of the card's queued messages stands with the agent, one entry
    per pending message in the same order, which is what the pages' sent panel
    draws its delivery marks from. Read only; callers hold _lock.

      "sent"       on the board, and no agent has confirmed receiving it: not yet
                   handed over, or handed over in a claim nobody has acked yet
      "delivered"  in the claim the lane's agent holds, and that claim was
                   confirmed through /ack. A message /fresh folds into a
                   confirmed claim counts from the moment it is handed over:
                   /fresh has no receipt of its own and nothing is ever handed
                   over twice
      "read"       the agent has written back since it was handed over: a
                   /progress note posted while its claim held it. The board
                   cannot see inside an agent, so read means written back about,
                   never merely opened; a message read and not yet written about
                   stays delivered

    All three belong to the claim in force. A claim that ends without an
    answer (dismissed, stolen back, never acked) leaves its messages waiting to
    be handed over again, and they are sent again until the next claim is
    confirmed. What a /note consumed has left the queue and is noted instead
    (_noted_texts); what a /reply answered is the reply's own batch."""
    ow = b.get("owner", "facilitator")
    rec = (_state.get("ack") or {}).get(ow) or {}
    held = _state["busy"].get(ow) == b["id"] and rec.get("box") == b["id"]
    claimed = set(_state["claimed"].get(ow) or []) if held else set()
    read = set(rec.get("read") or []) if held else set()
    out = []
    for m in b["pending"]:
        mid = m.get("mid")
        if mid in claimed and mid in read:
            out.append("read")
        elif mid in claimed and rec.get("confirmed"):
            out.append("delivered")
        else:
            out.append("sent")
    return out


def _noted_texts(b: dict) -> list:
    """The messages a /note has already consumed toward the completed reply still
    to come, in the order they were handed over. They were delivered and written
    back about, so read, and they are no longer queued; the completed reply
    takes them as part of its batch. Empty while the association is unknown.
    Callers hold _lock."""
    if b.get("batch_gap"):
        return []
    batch = b.get("batch")
    return [rec.get("text", "") for rec in batch] if isinstance(batch, list) else []


def _hand_over(b: dict, messages: list) -> None:
    """A claim: these messages, and only these, are what the agent is holding on
    this card now. Callers hold _lock and save in the same held stretch.

    A claim is minted whole, so this is written whole. Whatever an earlier claim
    left here goes with that claim, which is what keeps a claim cleared by any
    other path -- a card dismissed, a hand-off nobody confirmed, a steal-back --
    from leaving anything behind for a later reply to inherit.

    A hand-over is the only thing that writes here: the claim /wait makes, and
    the mid-work delivery /fresh makes. A message that merely landed on the card
    while the agent was composing was handed over by neither, so no reply covers
    it and it stays in the pending box until something actually delivers it."""
    b["handed"] = [_handed_record(m) for m in messages]


def _hand_over_more(b: dict, messages: list) -> None:
    """A mid-work delivery, folded into the claim in force. Callers hold _lock.

    A mid already handed over is never written twice, so a second delivery, a
    retry or a re-claim cannot put one message in a batch twice."""
    held = b.get("handed")
    if not isinstance(held, list):
        held = b["handed"] = []
    seen = {rec.get("mid") for rec in held}
    for m in messages:
        mid = m.get("mid")
        if mid in seen:
            continue
        seen.add(mid)
        held.append(_handed_record(m))


def _consume_claim(b: dict, claimed: set, for_answer: bool) -> None:
    """What becomes of the messages a claim handed over, at the moment that
    claim is let go. This is _release_claim's own step; callers hold _lock.

    Only the lane's actual claim identities are folded in, and only when the
    agent is writing about them. A progress note consumes a claim without
    finishing the answer, so what it consumed waits here for the completed reply
    still to come, and several notes may each consume their own claim toward
    that one reply. Anything else letting a claim go -- a card dismissed above
    all -- discards those messages unanswered, and they are dropped here so no
    later reply can inherit them.

    A record left behind by a claim that was cleared some other way cannot reach
    an answer either: nothing is folded in unless the lane still names the mid.
    So the batch is made of claim identities and never of an inference drawn
    from a message no longer being in the queue, which is a thing a progress
    note and a dismissal do alike and which therefore says nothing.

    A claim naming a mid this board has no record of is a hand-over it never
    saw, which is what a claim standing across the upgrade looks like. The batch
    cannot be stated then and says so, rather than offering a part of itself as
    the whole. What it can state it states entire: nothing here trims, caps or
    summarises a batch, however many messages one answer covers."""
    held = b.get("handed")
    b["handed"] = []
    if not for_answer or not claimed:
        return
    records = [rec for rec in held if rec.get("mid") in claimed] if isinstance(held, list) else []
    if len(records) != len(claimed):
        b["batch_gap"] = True     # handed over, and this board has no record of it
        return
    if b.get("batch_gap"):
        return                    # already unknown; a part of a batch is not the batch
    batch = b.get("batch")
    if not isinstance(batch, list):
        batch = b["batch"] = []
    seen = {rec.get("mid") for rec in batch}
    for rec in records:
        if rec.get("mid") in seen:
            continue
        seen.add(rec.get("mid"))
        batch.append(rec)


def _take_answered(b: dict) -> list | None:
    """The exact messages the reply being recorded answers, and the end of that
    association. Callers hold _lock and have let the claim go for_answer first,
    so the claim in force at the moment of the reply is already folded in.

    Every member is kept. Each message that was handed over stands here with its
    own identity, its own words and its own send time, however many there are,
    and nothing on the way to the card, to the history or to the transcript row
    trims, caps or summarises the list.

    None says the association is unknown: a hand-over reached the agent that
    this board has no record of, which is what a card carried across the upgrade
    looks like for its first answer. It is never the same fact as the empty
    list, which says this reply was handed nothing at all.

    The card starts from nothing again, so the next completed answer opens an
    association of its own and one message is answered exactly once."""
    batch = b.get("batch")
    gap = bool(b.get("batch_gap"))
    b["batch"] = []
    b["batch_gap"] = False
    if gap:
        return None
    return batch if isinstance(batch, list) else []


def _next_reply_id(bid: str) -> str:
    """A completed reply's own name. Callers hold _lock and save.

    Two replies with the same words, and two completed inside one second, are
    two pages of a card's history and every client has to be able to hold them
    apart: a page it is showing, a batch it is drawing and a fold the reader has chosen
    all hang off this name. The counter says what the words and the clock
    cannot."""
    n = int(_state.get("next_reply_id", 1))
    _state["next_reply_id"] = n + 1
    return f"{bid}:{n}"


def _release_unacked() -> None:
    """The short clock behind confirmed delivery: a claim whose token never came
    back through /ack went into a dead connection, so after ACK_GRACE the box
    goes back to the FRONT of its lane's queue, the same move the 15 minute
    steal-back makes. The card falls back to the queued grey the moment the
    claim mask lifts: beneath a claim the state is the "queued" a message from the reader
    put it in, never yellow.

    Only the claim a token was minted for can be released by it: a record left
    behind by a claim that already ended is stale bookkeeping, not a release.
    Callers hold _lock; this both saves and notifies when it moves anything."""
    now = time.time()
    moved = False
    for ow, rec in list(_state.get("ack", {}).items()):
        if not rec or rec.get("confirmed"):
            continue
        if _state["busy"].get(ow) != rec.get("box") or now - rec.get("ts", 0) <= ACK_GRACE:
            continue
        bid = rec["box"]
        _state["busy"][ow] = None
        _state["claimed"][ow] = []
        _state["ack"][ow] = None
        box = _box(bid)
        if box and box["pending"] and bid not in _state["inbox"]:
            _state["inbox"].insert(0, bid)
        _debug("bounce", bid, owner=ow)
        _log("unacked", bid, f"{ow} hand-off unconfirmed after {ACK_GRACE:.0f}s, box re-queued")
        moved = True
    if moved:
        _save()
        _notify()


def _sweep(persist: bool = True) -> bool:
    """The lazy clock behind green: a card whose flag heartbeat has gone stale
    leaves the green states, deferred handing its turn over on the way out (a
    claim still held keeps showing green through _shown's mask regardless).
    Runs at /state and /wait, exactly where the ack clock is swept, and inside
    /working itself, so a drop or an expiry lands within about a second.
    Callers hold _lock. Ordinarily it saves and notifies when it moves anything;
    a route that is already building a larger mutation passes persist=False and
    includes the sweep in its one final save."""
    moved = False
    for b in _state["boxes"]:
        if b["state"] in GREEN and not _hb_live(b):
            _handover(b)
            b["state"] = _rest(b)
            moved = True
    if moved and persist:
        _save()
        _notify()
    return moved


# ---- the phone page and its push notifications ------------------------------
# GET /m is the board for a phone: one card at a time, the project tabs across
# the top, the card list in a drawer off the left edge. The files below are
# what make it installable and let it be told when a card turns to the reader's turn.
PHONE_FILES = {
    "/m": (HERE / "m.html", "text/html; charset=utf-8"),
    "/m-sw.js": (HERE / "m-sw.js", "application/javascript; charset=utf-8"),
    "/m-manifest.json": (HERE / "m-manifest.json", "application/manifest+json; charset=utf-8"),
    "/m-icon-180.png": (HERE / "assets" / "m-icon-180.png", "image/png"),
    "/m-icon-192.png": (HERE / "assets" / "m-icon-192.png", "image/png"),
    "/m-icon-512.png": (HERE / "assets" / "m-icon-512.png", "image/png"),
    # the squid on its own, no background: the phone paints its own home-screen
    # launch image from it, sized to whichever iPhone is asking
    "/m-splash-squid.png": (HERE / "assets" / "m-splash-squid.png", "image/png"),
    # and the painter, shared by the phone page and the sign-in page in front
    # of it, which is the page every new icon is added from
    "/m-splash.js": (HERE / "m-splash.js", "application/javascript; charset=utf-8"),
}
OMNI_FILES = {
    f"/assets/ticket-{number}.webp":
        (HERE / "assets" / f"ticket-{number}.webp", "image/webp")
    for number in range(1, 4)
}
# Web push without a payload: the push service only has to be told "wake the
# phone's worker", and the worker reads /state itself, so nothing here is
# encrypted and the one piece of cryptography left is the VAPID signature, an
# ES256 JWT. The openssl command line does that, so this file stays standard
# library only: openssl makes the key pair once, into a gitignored file beside
# state.json, and signs each token. The DER signature it prints is turned into
# the raw r||s form the JWT wants, which is plain byte handling.
PUSH_KEY_PATH = HERE / "vapid-key.pem"
def _push_contact() -> str:
    """The signed push token's contact, a mailto: or https: address the push
    service may use to reach whoever runs this board. It is read from
    run.config.json (machine-local, gitignored) under "push_contact", so no
    personal address ever sits in the code; Apple's service refuses a token
    whose contact it cannot accept. The placeholder below is what a board with
    no configured contact sends."""
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
        contact = str(cfg.get("push_contact") or "").strip()
        if contact.startswith(("mailto:", "https:")):
            return contact
    except (OSError, ValueError):
        pass
    return "mailto:facilitator@localhost"


PUSH_CONTACT = _push_contact()   # the token's sub claim, a contact push services may use
PUSH_TTL = 86400                                # seconds a push may wait for a phone that is off
PUSH_REASON_CHARS = 200                         # of a refusing service's own words, the first this many
PUSH_BRIDGE_TIMEOUT = 3.0                       # one local Tailscale status command
TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
_push_lock = threading.Lock()
_push_public: bytes | None = None
_push_tokens: dict = {}                         # audience -> (expiry, token), one token serves an hour


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _openssl(args: list, data: bytes = b"") -> bytes:
    """One openssl command with data on its stdin; the bytes it printed.
    Its own words come back as the error when it fails."""
    r = subprocess.run(["openssl", *args], input=data, capture_output=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace").strip() or "openssl failed")
    return r.stdout


def _push_key_file() -> Path:
    """The P-256 key pair, made on first need and kept beside state.json."""
    with _push_lock:
        if not PUSH_KEY_PATH.is_file():
            pem = _openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout"])
            with open(PUSH_KEY_PATH, "wb", opener=_private_opener) as key_file:
                key_file.write(pem)
    return PUSH_KEY_PATH


def _push_public_key() -> bytes:
    """The 65 byte uncompressed point: the last 65 bytes of the DER public
    key openssl prints, which is what the page hands the browser as the
    application server key and what the k= part of the push header carries."""
    global _push_public
    if _push_public is None:
        der = _openssl(["ec", "-in", str(_push_key_file()), "-pubout", "-outform", "DER"])
        point = der[-65:]
        if len(point) != 65 or point[0] != 4:
            raise RuntimeError("unexpected public key shape from openssl")
        _push_public = point
    return _push_public


def _der_to_raw(sig: bytes) -> bytes:
    """An ECDSA signature as openssl prints it (a DER SEQUENCE of two
    INTEGERs) as the 64 raw bytes a JWT carries: r then s, 32 bytes each."""
    if len(sig) < 8 or sig[0] != 0x30:
        raise ValueError("not a DER signature")
    at = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7F)
    out = b""
    for _ in range(2):
        if sig[at] != 0x02:
            raise ValueError("not a DER signature")
        n = sig[at + 1]
        value = sig[at + 2:at + 2 + n].lstrip(b"\x00")
        if len(value) > 32:
            raise ValueError("not a P-256 signature")
        out += value.rjust(32, b"\x00")
        at += 2 + n
    return out


def _vapid_token(aud: str) -> str:
    """The signed token for one push service origin, twelve hours long and
    reused for an hour so a burst of pushes does not spawn a burst of
    openssl processes."""
    now = int(time.time())
    hit = _push_tokens.get(aud)
    if hit and hit[0] > now:
        return hit[1]
    dumps = lambda obj: _b64url(json.dumps(obj, separators=(",", ":")).encode())
    signing = (dumps({"typ": "JWT", "alg": "ES256"}) + "." +
               dumps({"aud": aud, "exp": now + 12 * 3600, "sub": PUSH_CONTACT}))
    der = _openssl(["dgst", "-sha256", "-sign", str(_push_key_file())], signing.encode())
    token = signing + "." + _b64url(_der_to_raw(der))
    _push_tokens[aud] = (now + 3600, token)
    return token


def _push_one(sub: dict, payload: bytes) -> tuple:
    """One encrypted push to one subscription: the status the service
    answered and whatever it said about it, or 0 and the reason it could not be
    reached at all. The body is where a push service explains a refusal, and
    throwing it away is why a whole day of 403s could not be explained."""
    endpoint = sub["endpoint"]
    u = urlparse(endpoint)
    aud = f"{u.scheme}://{u.netloc}"
    keys = sub["keys"]
    body = http_ece.encrypt(
        payload,
        private_key=ec.generate_private_key(ec.SECP256R1()),
        dh=base64.urlsafe_b64decode(keys["p256dh"] + "=" * (-len(keys["p256dh"]) % 4)),
        auth_secret=base64.urlsafe_b64decode(keys["auth"] + "=" * (-len(keys["auth"]) % 4)),
        version="aes128gcm",
    )
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "TTL": str(PUSH_TTL),
        "Authorization": f"vapid t={_vapid_token(aud)}, k={_b64url(_push_public_key())}",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Content-Length": str(len(body)),
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        try:
            said = e.read().decode("utf-8", "replace")
        except OSError:
            said = ""
        return e.code, " ".join(said.split())   # one line, whatever it sent
    except (urllib.error.URLError, OSError) as e:
        return 0, " ".join(str(getattr(e, "reason", "") or e).split())


def _tailscale_command() -> str | None:
    """The same Tailscale command the bridge uses: PATH first, then the Mac
    app. Finding it afresh means installing or removing it takes effect on the
    next turn without restarting the board."""
    found = shutil.which("tailscale")
    if found:
        return found
    if os.access(TAILSCALE_APP, os.X_OK):
        return TAILSCALE_APP
    return None


def _tailscale_json(ts: str, args: list[str]) -> dict | None:
    """One bounded, read-only Tailscale query. No command output or exception
    text escapes this helper because either may contain private machine data."""
    try:
        result = subprocess.run([ts, *args], capture_output=True, text=True,
                                encoding="utf-8",
                                timeout=PUSH_BRIDGE_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None
    if result.returncode != 0:
        return None
    try:
        answer = json.loads(result.stdout)
    except (TypeError, ValueError):
        return None
    return answer if isinstance(answer, dict) else None


def _proxy_targets_board(proxy) -> bool:
    """True only for the IPv4 loopback target used by facilitator bridge."""
    if not isinstance(proxy, str):
        return False
    try:
        target = urlparse(proxy)
        return (target.scheme == "http" and
                target.hostname == "127.0.0.1" and
                target.port == BRIDGE_PORT and target.path in ("", "/") and
                not target.params and not target.query and not target.fragment and
                target.username is None and target.password is None)
    except ValueError:
        return False


def _serve_config_targets_board(config: dict) -> bool:
    """Whether a background or live foreground Serve config exposes this
    board at the root of HTTPS port 443."""
    configs = [config]
    foreground = config.get("Foreground")
    if isinstance(foreground, dict):
        configs.extend(c for c in foreground.values() if isinstance(c, dict))
    for candidate in configs:
        tcp = candidate.get("TCP")
        web = candidate.get("Web")
        if not isinstance(tcp, dict) or not isinstance(web, dict):
            continue
        https = tcp.get("443")
        if not isinstance(https, dict) or https.get("HTTPS") is not True:
            continue
        for host_port, server in web.items():
            if not isinstance(host_port, str) or not isinstance(server, dict):
                continue
            try:
                public = urlparse("//" + host_port)
                on_https = public.hostname is not None and public.port == 443
            except ValueError:
                on_https = False
            handlers = server.get("Handlers")
            root = handlers.get("/") if isinstance(handlers, dict) else None
            if (on_https and isinstance(root, dict) and
                    _proxy_targets_board(root.get("Proxy"))):
                return True
    return False


def _push_bridge_available() -> tuple[bool, str]:
    """A fresh, fail-closed check that this board's phone bridge is usable."""
    ts = _tailscale_command()
    if ts is None:
        return False, "tailscale unavailable"
    status = _tailscale_json(ts, ["status", "--json"])
    if status is None:
        return False, "tailscale status unavailable"
    if status.get("BackendState") != "Running":
        return False, "tailscale disconnected"
    serve = _tailscale_json(ts, ["serve", "status", "--json"])
    if serve is None:
        return False, "serve status unavailable"
    if not _serve_config_targets_board(serve):
        return False, "bridge not serving this board"
    return True, ""


def _push_rec(endpoint: str) -> str:
    """A short stable name for one stored subscription, so a phone's link can be
    followed through the log over days. It is a hash of the endpoint and the
    endpoint itself is never written; the same endpoint always gives the same
    name, a new subscription a new one."""
    return hashlib.sha256(endpoint.encode("utf-8", "replace")).hexdigest()[:8]


def _push_turn(bid: str) -> None:
    """Every subscribed phone is told once that a card turned to the reader's turn.
    Runs on its own thread: it reads the subscriptions under the lock, checks
    that Tailscale is connected and serving this board before each send, talks
    to push services with the lock released, and takes it again only to keep
    successes or drop subscriptions the services report gone."""
    with _lock:
        subs = list(_state.get("push_subs", []))
        box = _box(bid)
        payload = json.dumps({"box": bid, "title": (box or {}).get("title") or "facilitator"},
                             separators=(",", ":")).encode()
    gone = []
    gone_status = {}
    worked = None
    for sub in subs:
        # A sign-out or password change invalidates delivery as well as HTTP
        # access. Pre-upgrade subscriptions have no session and are skipped.
        if _BRIDGE_AUTH is None or not _BRIDGE_AUTH.has_session_digest(sub.get("session")):
            _info("pushsession", bid, rec=_push_rec(sub.get("endpoint", "")),
                  reason="no live session", count=len(subs))
            continue
        # Probe immediately before every service call. A bridge can go down
        # while an earlier phone's push service is answering, and that must
        # close the gate for every subscription still waiting in this turn.
        available, reason = _push_bridge_available()
        if not available:
            _info("pushskip", bid, reason=reason)
            break
        # the host, never the endpoint: the endpoint is the phone's own address
        # and identifies the device, so it is on the keep-out list
        host = urlparse(sub.get("endpoint", "")).netloc
        rec = _push_rec(sub.get("endpoint", ""))
        try:
            code, said = _push_one(sub, payload)
        except Exception as e:   # a signing failure: reported, never fatal
            _error("pushfail", bid, host=host, rec=rec, reason=str(e))
            continue
        reason = said[:PUSH_REASON_CHARS] if code else ("unreachable " + said).strip()
        _info("push", bid, host=host, rec=rec, status=code or None, reason=reason or None)
        if 200 <= code < 300:
            worked = host
        if code in (404, 410):
            gone.append(sub["endpoint"])
            gone_status[sub["endpoint"]] = code
    if gone or worked:
        with _lock:
            if worked:
                # what the next start line reads, so a board coming back up can
                # say when a phone was last actually reached
                _state["push_last_ok"] = {"ts": time.time(), "host": worked}
            dropped = []
            if gone:
                held = _state.get("push_subs", [])
                dropped = [s["endpoint"] for s in held if s.get("endpoint") in gone]
                _state["push_subs"] = [s for s in held if s.get("endpoint") not in gone]
            _save()
            for endpoint in dropped:
                _info("pushgone", bid, rec=_push_rec(endpoint), status=gone_status[endpoint],
                      count=len(_state["push_subs"]))


# ---- operations: a receipt kept beside the effect ----------------------------
# A phone a room and a radio away from this server can lose a reply after the
# server has already done what it asked. It cannot tell a lost reply from a
# lost request, so it sends its command again, and without a receipt the
# board would carry the same message twice. A command may therefore name an
# operation id, minted by the caller before the first try and reused on every
# retry. The first try's result is written into state.json in the same rename
# that writes the effect, so a reader can never see one without the other, and
# a retry answers with the stored result and changes nothing. A used id with a
# different payload is refused rather than quietly applied. Callers that send
# no id, the desktop and the agents, land exactly as they always did.
#
# What is promised: a retry within OP_RETENTION of an id the board has
# committed returns the committed result and applies nothing. What is not: an
# id older than that is forgotten and would apply again, so a client stops
# retrying long before the window closes; and the transcript row is written
# only after the state is installed, so a crash between the two loses the row
# rather than duplicating it, and a replay writes none. Every row still carries
# the id and /thread reads each id once, as a guard for rows written by older
# code or by hand.

def _op_id_ok(op: str) -> bool:
    return 8 <= len(op) <= 64 and set(op) <= OP_ID_CHARS


def _fingerprint(*parts: str) -> str:
    """What a payload looks like to the receipt, so a reused id carrying other
    words is caught. A digest and never the words: the receipt outlives the
    request by days and message text has no business in it twice."""
    return hashlib.sha256("\x1f".join(parts).encode("utf-8", "surrogatepass")).hexdigest()[:32]


def _op_record(op: str) -> dict | None:
    """The receipt for an id, or None once it has aged past OP_RETENTION: a
    receipt past the window is forgotten whether or not the prune has run,
    so the answer to a client never depends on what else the board did."""
    rec = _state.get("ops", {}).get(op)
    if rec is None or time.time() - rec.get("ts", 0) > OP_RETENTION:
        return None
    return rec


def _op_lookup(op: str, fp: str) -> tuple[str, dict | None]:
    """"none" for an id the board has not seen, "same" with the stored record
    for a genuine retry, "mismatch" for the same id under other words."""
    rec = _op_record(op)
    if rec is None:
        return "none", None
    return ("same" if rec.get("fp") == fp else "mismatch"), rec


def _op_commit(op: str, fp: str, kind: str, box: str, result: dict) -> None:
    """The receipt, written into the state the caller is about to save, and the
    old receipts let go here rather than on a clock of their own.

    Two rules, so an eviction can never turn a live retry into a fresh action.
    A receipt past the retention window is dropped, always. If the store is
    still over the soft cap, the oldest are dropped toward it, but only ones
    already older than the floor: a receipt young enough that a phone could
    still be sending its id is kept whatever the count, so a retry always finds
    it and answers from it instead of landing twice. Under one person's use the
    count never nears the cap, so in practice only the retention rule ever runs."""
    ops = _state.setdefault("ops", {})
    now = time.time()
    ops[op] = {"kind": kind, "box": box, "fp": fp, "result": result, "ts": now}
    for k in [k for k, r in ops.items() if now - r.get("ts", 0) > OP_RETENTION]:
        del ops[k]
    if len(ops) > OP_KEEP:
        evictable = sorted((r.get("ts", 0), k) for k, r in ops.items()
                           if now - r.get("ts", 0) > OP_EVICT_FLOOR)
        for _ts, k in evictable[:len(ops) - OP_KEEP]:
            del ops[k]


def _op_status(op: str) -> dict:
    """What a phone asks on waking: did this land. unknown means the board has
    no receipt within the window, which within the window means it did not."""
    rec = _op_record(op)
    if rec is None:
        return {"status": "unknown"}
    return {"status": "applied", "kind": rec["kind"], "box": rec.get("box"), "result": rec["result"]}


# ---- what the phone reads ------------------------------------------------------
# The desktop reads the whole board every second and that is right for a page
# on the same machine. The phone reads through a tunnel, so it names the
# revision it has and gets a short answer when nothing has changed, and when
# something has, the cards with the fields the phone draws and none of the
# rest. The live section rides on every answer because it is not part of the
# saved state and so never moves the revision.
#
# Those fields for 700 cards are about 800 KB, and every save sent all of it
# again, over a link that takes seconds for it. So the board remembers, for its
# last PHONE_KEPT readings, a fingerprint of each card exactly as it was sent,
# and a phone that names a reading this run made gets only the cards whose
# fingerprint has moved since. The fingerprint is of the bytes sent and not of
# the saved card, so no change the phone would see can be missed whatever made
# it. A card read twice at one revision that did not read the same both times
# (a heartbeat going quiet moves no revision) is sent to every phone holding
# that revision. A restart forgets the readings, and a phone holding one from
# before it gets the whole board.

PHONE_KEPT = 32          # readings whose cards are remembered, the newest kept
PHONE_GZIP_MIN = 256     # a shorter answer goes as it is: gzip saves little on it
# this run's name for its readings: a phone names it back beside the revision
# it holds, and a reading made by any other run is never built on
PHONE_EPOCH = secrets.token_hex(4)
# rev -> (the card ids in board order, {id: fingerprint, or None once the card
# has read two ways at that revision}), or None for a revision never built on
_phone_kept: dict = {}


def _phone_box(b: dict) -> dict:
    ow = b.get("owner", "facilitator")
    return {
        "id": b["id"], "bucket": b["bucket"], "title": b["title"],
        "replyFull": b.get("reply_full", b.get("reply", "")),
        "done": b["done"], "replies": b["replies"], "olderReplies": _older_replies(b),
        "ball": b.get("ball", "you"),
        "docked": b.get("docked", False), "dockedTs": b.get("docked_ts", 0),
        "parked": b.get("parked", False), "ts": b.get("ts", 0), "owner": ow,
        "parkedTs": b.get("parked_ts", 0), "doneTs": b.get("done_ts", 0),
        "pending": len(b["pending"]),
        "pendingTexts": [m["text"] for m in b["pending"]],
        "pendingStamps": [m.get("ts", 0) for m in b["pending"]],
        # the operation id each queued message was sent under, or null for a
        # message that came without one: the phone matches its own rows by it
        "pendingOps": [m.get("op") for m in b["pending"]],
        # where each queued message stands with the agent, and what a note has
        # already taken toward the answer still to come (_pending_states)
        "pendingStates": _pending_states(b),
        "notedTexts": _noted_texts(b),
        "agentTs": b.get("agent_ts", 0), "seen": b.get("seen", 0), "turnTs": b.get("turn_ts", 0),
        # the card's last COMPLETED reply: its own name, when it was completed,
        # and the messages it was given, which is what the box above the answer
        # is drawn from. replyKind says what wrote the words the card is
        # showing, so a page knows whether that reply is the text on the card or
        # a page standing behind a progress note. answered is null when the
        # board recorded no association, which is never a batch of none
        "replyKind": b.get("reply_kind", ""),
        "replyId": b.get("reply_id", ""),
        "replyTs": b.get("reply_ts", 0),
        "answered": _answered_out(b.get("answered")),
        "writing": _state["busy"].get(ow) == b["id"],
        "bg": _hb_live(b), "state": _shown(b),
        # the ready-to-test marker, a durable per-card flag; the page paints it
        # only while the card is actually awaiting the reader
        "testing": bool(b.get("testing", False)),
    }


def _live_section() -> dict:
    now = time.time()
    return {
        "listening": {ow: _waiters.get(ow, 0) > 0 for ow in OWNERS},
        "listenerGap": {ow: round(now - _last_wait.get(ow, 0.0), 1) for ow in OWNERS},
        "agents": {ow: {
            "name": _agent_names.get(ow) or "claude",
            "alive": _waiters.get(ow, 0) > 0 or (now - _last_wait.get(ow, 0.0)) < 900 or bool(_state["busy"].get(ow)),
        } for ow in OWNERS},
    }


def _phone_state(since: int | None, ops: list[str], epoch: str = "") -> bytes:
    """The reading, as the bytes that are sent. Callers hold _lock and have
    swept the clocks. epoch is the run the phone's held reading came from,
    named by a phone that can take the changed cards alone."""
    rev = _state.get("rev", 0)
    out = {"rev": rev, "changed": since is None or since != rev, "now": time.time(), "incidentSchema": INCIDENT_SCHEMA,
           "live": _live_section()}
    cards: list[str] = []
    if out["changed"]:
        qpos, seen = {}, {ow: 0 for ow in OWNERS}
        for i in _state["inbox"]:
            ow = (_box(i) or {}).get("owner", "facilitator")
            seen[ow] += 1
            qpos[i] = seen[ow]
        ids, texts, marks = [], [], {}
        for b in _state["boxes"]:
            one = _phone_box(b)
            one["queuePos"] = qpos.get(b["id"], 0)
            text = json.dumps(one)
            ids.append(b["id"])
            texts.append(text)
            marks[b["id"]] = hashlib.blake2b(text.encode(), digest_size=16).digest()
        base = _phone_kept.get(since) if epoch == PHONE_EPOCH else None
        _phone_keep(rev, ids, marks)
        out.update({
            "title": _state.get("title", "facilitator"),
            "tabs": _state.get("tabs", {"order": [], "closed": []}),
            "pwds": _lane_pwds(), "projects": _state.get("projects", []),
            "epoch": PHONE_EPOCH,
        })
        if base is None:
            cards = texts
        else:
            out.update(_phone_delta(since, base, ids))
            cards = [t for i, t in zip(ids, texts) if base[1].get(i) != marks[i]]
    if ops:
        out["ops"] = {op: _op_status(op) for op in ops if _op_id_ok(op)}
    body = json.dumps(out)
    if out["changed"]:
        # the cards are JSON already, made once for their fingerprints, and go in
        # as the last field exactly as json.dumps would have written them
        body = body[:-1] + ', "boxes": [' + ", ".join(cards) + "]}"
    return body.encode()


def _phone_keep(rev: int, ids: list[str], marks: dict) -> None:
    """What was sent at this revision, kept for the phones that come to hold it.
    Read again at the same revision, a card that no longer reads the same is
    marked as unknown there, so every phone holding that revision is sent it;
    the board's order cannot move without a save, but if it ever did, nothing
    would be built on that revision again."""
    if rev not in _phone_kept:
        _phone_kept[rev] = (ids, marks)
        while len(_phone_kept) > PHONE_KEPT:
            del _phone_kept[next(iter(_phone_kept))]
        return
    kept = _phone_kept[rev]
    if kept is None:
        return
    if kept[0] != ids:
        _phone_kept[rev] = None
        return
    for i, mark in marks.items():
        if kept[1][i] != mark:
            kept[1][i] = None


def _phone_delta(since: int, base: tuple, ids: list[str]) -> dict:
    """Everything but the cards a phone holding the reading at since needs: the
    ids gone since, where each new card sits, and the count it checks its board
    by. The page's own rebuild (mergeReading in m.html) is played here first,
    and when it would not come out in the board's order the whole order is sent
    instead."""
    held, held_marks = base
    now = set(ids)
    out = {"delta": since, "count": len(ids)}
    gone = [i for i in held if i not in now]
    if gone:
        out["gone"] = gone
    after, prev = {}, ""
    for i in ids:
        if i not in held_marks:
            after[i] = prev
        prev = i
    order = [i for i in held if i in now]
    for i, before in after.items():
        order.insert(order.index(before) + 1 if before else 0, i)
    if order != ids:
        out["ids"] = ids
    elif after:
        out["after"] = after
    return out


def _takes_gzip(accept: str) -> bool:
    """Whether an Accept-Encoding header takes gzip: named with a weight above
    zero, or not named and covered by a * above zero. A request with no such
    header takes the bytes as they are."""
    star = False
    for part in accept.split(","):
        name, *params = [p.strip() for p in part.split(";")]
        weight = 1.0
        for p in params:
            key, _, value = p.partition("=")
            if key.strip().lower() == "q":
                try:
                    weight = float(value)
                except ValueError:
                    weight = 0.0
        if name.lower() == "gzip":
            return weight > 0
        if name == "*":
            star = weight > 0
    return star


def _phone_answer(body: bytes, gzip_ok: bool) -> Response:
    """The phone's reading, gzip compressed when the phone takes it and it is
    long enough to be worth it. Vary says the bytes depend on what was
    accepted, so nothing between the board and the phone keeps one for another."""
    headers = {"Cache-Control": "no-store", "Vary": "Accept-Encoding"}
    if gzip_ok and len(body) >= PHONE_GZIP_MIN:
        body = gzip.compress(body, compresslevel=6, mtime=0)
        headers["Content-Encoding"] = "gzip"
    return Response(body, status_code=200, media_type="application/json", headers=headers)


def _ui_state() -> dict:
    """The whole board, for the desktop pages and any older caller. Callers hold _lock."""
    st = _state
    qpos, seen = {}, {ow: 0 for ow in OWNERS}  # queue position within each owner's lane
    for i in st["inbox"]:
        ow = (_box(i) or {}).get("owner", "facilitator")
        seen[ow] += 1
        qpos[i] = seen[ow]
    return {
        "boxes": [
            {
                "id": b["id"], "bucket": b["bucket"], "title": b["title"],
                # reply remains the full-text compatibility field for older
                # clients. Current surfaces consume the explicit variants.
                "reply": b.get("reply_full", b.get("reply", "")),
                "replyFull": b.get("reply_full", b.get("reply", "")),
                "replyShort": b.get("reply_short", b.get("reply_full", b.get("reply", ""))),
                "done": b["done"], "replies": b["replies"],
                # how many older pages the card's reply history holds, the
                # live one excluded: exactly what the arrows in the card's top
                # bar walk. It rides in with the card so the marks are right in
                # the frame the card first draws in, rather than a thread
                # request later. replies above counts progress notes too and
                # is no answer to this
                "olderReplies": _older_replies(b),
                "ball": b.get("ball", "you"),
                "docked": b.get("docked", False),
                "parked": b.get("parked", False),
                # Each resting section lists by when the card entered it;
                # its time is 0 while the card is outside that section.
                "dockedTs": b.get("docked_ts", 0),
                "parkedTs": b.get("parked_ts", 0),
                "doneTs": b.get("done_ts", 0),
                "ts": b.get("ts", 0),
                "context": b.get("context", ""),
                "owner": b.get("owner", "facilitator"),
                "pending": len(b["pending"]),
                "pendingTexts": [m["text"] for m in b["pending"]],
                # send times matching pendingTexts one to one; 0 for
                # entries queued before times were recorded, which the
                # page shows unstamped
                "pendingStamps": [m.get("ts", 0) for m in b["pending"]],
                # where each queued message stands with the agent, one entry per
                # pendingTexts entry: sent, delivered or read, and the messages a
                # note has already taken toward the answer still to come, which
                # are read and no longer queued (_pending_states, _noted_texts)
                "pendingStates": _pending_states(b),
                "notedTexts": _noted_texts(b),
                "ws": b.get("ws"), "task": b.get("task"),
                # the card's own worktree, empty for a card that has never
                # been moved; the bar reads the lane's standing branch then
                "worktree": b.get("worktree", ""),
                "agentTs": b.get("agent_ts", 0),
                # the card's last COMPLETED reply, which is what the box over
                # the answer is drawn from: the board's own name for it, when
                # it was completed, and the exact messages it was given. the
                # agent stamp above moves on a progress note as well and so
                # cannot mean any of this. replyKind says what wrote the words
                # the card is showing, so a page can tell a reply standing on
                # the card from one standing behind a note, and answered is
                # null when the board recorded no association at all, which is
                # never the same fact as a reply that was handed nothing
                "replyKind": b.get("reply_kind", ""),
                "replyId": b.get("reply_id", ""),
                "replyTs": b.get("reply_ts", 0),
                "answered": _answered_out(b.get("answered")),
                # replies already read, the board's record rather than one
                # browser's: the page bolds a card whose reply count has
                # passed this, on whichever device is looking
                "seen": b.get("seen", 0),
                # when the card last turned to the reader's turn: the phone's push
                # handler reads the board and names the card that turned last
                "turnTs": b.get("turn_ts", 0),
                "engine": b.get("engine", "claude"),
                "writing": st["busy"].get(b.get("owner", "facilitator")) == b["id"],
                # green only while the job's heartbeat is fresh: a job
                # that stopped pinging cannot keep a card green
                "bg": _hb_live(b),
                # the single source of truth for color and sort: the
                # machine's state through the shelf mask, beside the raw
                # flags above so the page never has to reconcile them
                "state": _shown(b),
                # the ready-to-test marker, a durable per-card flag; the page
                # paints it only while the card is actually awaiting the reader
                "testing": bool(b.get("testing", False)),
                "queuePos": qpos.get(b["id"], 0),
            }
            for b in st["boxes"]
        ],
        # the revision this snapshot is of: every saved change moves it, so a
        # reader holding one can tell whether a later answer is newer
        "rev": st.get("rev", 0),
        # the settings' own revision, apart from the board's: a page that sees
        # it move reads /settings again, so a box arranged in one window
        # reaches the others without the board itself changing
        "settingsRev": _settings_rev(),
        # the board's own clock when this reading was made, the way the phone's
        # readings already carry it: a page names the moment of a click by it,
        # so the times it sends back are the board's and not the browser's
        "now": time.time(),
        "pwd": str(HERE),
        "pwds": _lane_pwds(),
        "projects": st.get("projects", []),
        "busy": st["busy"],
        "queued": len(st["inbox"]),
        "title": st.get("title", "facilitator"),
        # the lane whose own internal folder feeds the image panel, read
        # from run.config.json; empty leaves the panel off on every tab
        "imagePanelLane": IMAGE_PANEL_LANE,
        # the Spotify app client id the player signs in with, read from
        # run.config.json; empty turns the connect stub into a create prompt
        "spotifyClientId": SPOTIFY_CLIENT_ID,
        # the lanes the file navigator mounts on, read from run.config.json;
        # empty leaves the panel off on every tab
        "navigatorLanes": list(NAV_LANES),
        # the one tab bar both pages draw: the lane order and the lanes that
        # are closed. An empty order means no arrangement has been saved
        "tabs": st.get("tabs", {"order": [], "closed": []}),
        "listening": {ow: _waiters.get(ow, 0) > 0 for ow in OWNERS},
        "everListened": st.get("ever_listened", {}),
        "workspaces": st.get("workspaces", {}),
        # each project's view pages, in the order the foot of the workspace
        # draws them. A lane with an empty list has had all of its pages
        # removed; a lane absent from the map has never been migrated
        "pages": st.get("pages", {}),
        # the quick notes without their words: enough for a card to show that a
        # note is attached to it. the words travel only on the note routes, so
        # a reading taken every second never carries them
        **({"quicknotes": [_quicknote_meta(n) for n in st.get("quicknotes", [])]} if QUICK_NOTES_ON else {}),
        "listenerGap": {ow: round(time.time() - _last_wait.get(ow, 0.0), 1) for ow in OWNERS},
        # the row tag's truth: the lane's last stated agent name, and alive
        # meaning connected now, seen within the steal window, or holding a card
        "agents": {ow: {
            "name": _agent_names.get(ow) or "claude",
            "alive": _waiters.get(ow, 0) > 0
                     or (time.time() - _last_wait.get(ow, 0.0)) < 900
                     or bool(st["busy"].get(ow)),
            # alive but absent from the listening call for over a minute,
            # holding nothing and with no live job registered: the agent is
            # working off the record and the bar says so
            "offrecord": _waiters.get(ow, 0) == 0 and st["busy"].get(ow) is None
                         and 60 < (time.time() - _last_wait.get(ow, 0.0)) < 900
                         and not any(
                             _hb_live(b)
                             for b in st["boxes"] if b.get("owner", "facilitator") == ow),
        } for ow in OWNERS},
    }


# ---- the routes' locked work --------------------------------------------------
# Each function below is one route's whole answer: it takes the parsed query
# and the body, does its work under _lock where the board is touched, and hands
# back a status and a payload. A dict is answered as JSON; bytes come with
# their content type. None of them writes a socket, so none of them can be
# held up by one. The lines read as the old handler read, one route after
# another, because that is the order anyone looking for a route will use.

class Query(dict):
    """The query string parsed the way it always was, plus the raw string for
    the one route that has to tell a blank value from an absent one, the
    request path for the routes that read a name out of it, the encodings
    the caller takes, for the one route whose answer is compressed, and
    whether the request is a local page's and names its own origin, for the
    routes only a page on this Mac may use (_local_request)."""
    raw: str = ""
    path: str = ""
    accept_encoding: str = ""
    local: bool = False
    same_origin: bool = False

    def one(self, name: str, default: str = "") -> str:
        values = self.get(name)
        return values[0] if values else default


def _snapshot(payload: dict) -> tuple[bytes, str]:
    """A dict that points into the live state, made into bytes while the lock
    is still held, so the answer is one consistent reading of the board."""
    return json.dumps(payload).encode(), "application/json"


def _file(p: Path, ctype: str):
    if p.is_file():
        return 200, p.read_bytes(), ctype
    return 404, {"error": "not found"}


def _get_root(q: Query, _):
    return 200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8"


def _get_page(q: Query, _):
    # the second UI: the same lanes and the same cards drawn as one typed
    # page, in its own file so editing it can never touch the card board
    return 200, (HERE / "page.html").read_bytes(), "text/html; charset=utf-8"


def _get_compose_format(q: Query, _):
    # the composer's file with the board's default written in front of it on the
    # same line, so every page knows it before its first composer is built and
    # the file's line numbers stay the file's own
    p = HERE / "compose-format.js"
    if not p.is_file():
        return 404, {"error": "not found"}
    lead = b"globalThis.COMPOSE_FORMAT_DEFAULT=" + (b"true" if COMPOSE_FORMAT_DEFAULT else b"false") + b";"
    return 200, lead + p.read_bytes(), "application/javascript; charset=utf-8"


def _sweep_clocks() -> None:
    """The two lazy clocks a reading runs before it answers: the unconfirmed
    hand-off clock and the working-flag heartbeat. Callers hold _lock. Either
    can move a card and save; if that save fails, the state has already been
    put back to the file and the failure written down, and the reading answers
    that restored board rather than failing too. A reader must not be blacked
    out by a disk the commands are already refusing; the clock runs again on
    the next reading and lands when the disk is back."""
    try:
        _release_unacked()
        _sweep()
    except SaveFailed:
        pass


def _get_state(q: Query, _):
    with _lock:
        # the board polls this about once a second, so the 90 second ack
        # clock gets swept even when no /wait is running to sweep it,
        # and an expired working flag drops out of green (handing over
        # a deferred turn) within about that same second
        _sweep_clocks()
        return 200, *_snapshot(_ui_state())


def _get_phone_state(q: Query, _):
    since_raw = q.one("since")
    try:
        since = int(since_raw) if since_raw else None
    except ValueError:
        return 400, {"error": "bad revision"}
    ops = [op for op in q.one("ops").split(",") if op][:OP_ASK_MAX]
    # the reading is made under the lock as one transaction, as a stateful
    # route's always is; compressing it, the longest step on a whole board,
    # waits until the lock is let go
    body = _run_state_request(_phone_reading, since, ops, q.one("delta"))
    return _phone_answer(body, _takes_gzip(q.accept_encoding))


def _phone_reading(since: int | None, ops: list[str], epoch: str) -> bytes:
    _sweep_clocks()
    return _phone_state(since, ops, epoch)


def _get_op(q: Query, _):
    op = q.one("id")
    if not _op_id_ok(op):
        return 400, {"error": "bad operation id"}
    with _lock:
        return 200, {**_op_status(op), "rev": _state.get("rev", 0)}


def _get_worktrees(q: Query, _):
    # the names the card's top bar offers, straight out of git. no lock:
    # nothing here reads or writes the board's state, it only asks the
    # lane's own folder what worktrees it has
    owner = q.one("owner", "facilitator")
    if owner not in OWNERS:
        return 400, {"error": "unknown owner"}
    return 200, _lane_worktrees(owner)


def _get_unread(q: Query, _):
    # a lane's unread count in one line, for a Stop hook deciding
    # whether the agent may go idle and for a human checking a lane
    # without reading the whole board. Read only: it claims nothing,
    # releases nothing and sweeps nothing
    owner = q.one("owner", "facilitator")
    if owner not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        held = set(_state["claimed"].get(owner) or [])
        # anything not already in the claim is still waiting, including
        # messages that landed on a held card after it was claimed
        queued = sum(1 for b in _state["boxes"]
                     if b.get("owner", "facilitator") == owner
                     for m in b["pending"] if m["mid"] not in held)
        return 200, {"queued": queued, "claimed": len(held)}


def _get_fresh(q: Query, _):
    # mid-work delivery: while an agent holds a card, hand over anything
    # that landed on that card after the claim and fold it into the
    # claim, so the one reply covers it and nothing arrives twice
    owner = q.one("owner", "facilitator")
    if owner not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        fbid = _state["busy"].get(owner)
        fbox = _box(fbid) if fbid else None
        if fbox is None:
            return 200, {"messages": [], "message_via": []}
        have = set(_state["claimed"][owner])
        fresh = [m for m in fbox["pending"] if m["mid"] not in have]
        if fresh:
            _state["claimed"][owner].extend(m["mid"] for m in fresh)
            # handed over, so the reply that follows covers them: folded into
            # the claim's own note in the same held stretch the claim itself is
            # extended in, and written durably by the save below
            _hand_over_more(fbox, fresh)
            _log("fresh", fbid, f"{len(fresh)} mid-work message(s) handed over")
            _save()
        # the same marker /wait hands over, in the same shape and order:
        # "mini" for the small card, null for the big one. A mini
        # message that lands mid-work becomes the newest claimed one
        # and brings /reply's 100 word cap with it, so an agent that
        # never sees the marker gets its reply refused out of nowhere
        return 200, *_snapshot({"box": fbid, "messages": [m["text"] for m in fresh],
                                "message_via": [m.get("via") for m in fresh]})


def _get_thread(q: Query, _):
    tbid = q.one("box")
    try:
        n = int(q.one("n", "60"))
    except ValueError:
        return 400, {"error": "bad count"}
    out = []
    legacy_reply_rows = True
    seen_ops: set = set()
    try:
        with TRANSCRIPT_PATH.open() as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(e, dict):
                    continue
                if _is_reply_schema_boundary(e):
                    legacy_reply_rows = False
                    continue
                if e.get("box") == tbid and e.get("kind") in ("user", "agent", "note"):
                    # a row written twice under one operation id is one event
                    # that a crash between the append and the save made the
                    # retry append again; it is read once
                    op = e.get("op")
                    if isinstance(op, str) and op:
                        if (e["kind"], op) in seen_ops:
                            continue
                        seen_ops.add((e["kind"], op))
                    item = {"kind": e["kind"], "text": e.get("text", ""), "ts": e.get("ts", 0)}
                    if e.get("kind") in ("agent", "note"):
                        # Only rows physically before the persisted schema
                        # marker get legacy compatibility. Timestamps never
                        # decide data representation.
                        full = _row_reply_full(e, legacy_reply_rows)
                        if "reply_full" in e or "reply_short" in e:
                            short = e.get("reply_short", full)
                        elif legacy_reply_rows:
                            short = _legacy_reply_variants(e.get("text", ""))[0]
                        else:
                            short = full
                        item.update({"text": full, "replyFull": full, "replyShort": short})
                    out.append(item)
    except FileNotFoundError:
        pass
    return 200, {"messages": out[-n:]}


def _get_history(q: Query, _):
    """One card's older replies, oldest first: what the history arrows walk.

    Only final replies are pages of a card's history, and the one the card is
    showing is left out here rather than guessed at by the page. Both of those
    decisions are the ones _older_replies counts with, so the number sent with
    the card and the length of this list are the same fact stated twice.

    The two things a page cannot do for itself are exactly why this exists
    beside /thread. /thread answers the last n rows of the whole conversation,
    so a card with a long run of progress notes since its last answer can hand
    a page a window with no reply in it at all; the filter here runs before the
    cap, so the cap counts replies. And a page can only tell which reply is the
    live one by comparing text, which gets it wrong when a progress note
    repeats the answer under it word for word; the card's own reply_kind says
    it outright.

    Beside the replies, in the same order and at the same length, replyMeta
    names each page: its own reply id, when it was completed, and the exact
    messages it was given. replies stays a plain list of strings, so a caller
    that only walks the words is untouched by it, and the two lists are trimmed
    and capped together so neither can promise a page the other cannot reach. A
    page written before the board kept batches carries a null id and a null
    batch, which says unknown; nothing is rebuilt for it out of the rows that
    happen to stand near it in the file."""
    hbid = q.one("box")
    with _lock:
        box = _box(hbid)
        if box is None:
            return 400, {"error": "bad box"}
        # read under the lock, scan the file outside it: the transcript is the
        # one thing here big enough that reading it must not hold the board
        live_is_reply = box.get("reply_kind") == "agent"
    replies: list = []
    # one entry per reply above, written in the same step so the two lists can
    # never fall out of step with each other
    meta: list = []
    legacy_reply_rows = True
    seen_ops: set = set()
    try:
        with TRANSCRIPT_PATH.open(errors="replace") as transcript:
            for line in transcript:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(e, dict):
                    continue
                if _is_reply_schema_boundary(e):
                    legacy_reply_rows = False
                    continue
                if e.get("box") != hbid or e.get("kind") != "agent":
                    continue
                # a row written twice under one operation id is one event that
                # a crash between the append and the save made the retry append
                # again; it is read once, the way /thread reads it
                op = e.get("op")
                if isinstance(op, str) and op:
                    if op in seen_ops:
                        continue
                    seen_ops.add(op)
                replies.append(_row_reply_full(e, legacy_reply_rows))
                meta.append(_row_reply_meta(e))
                if len(replies) > HISTORY_MAX + 1:
                    del replies[0]
                    del meta[0]
    except FileNotFoundError:
        pass
    if live_is_reply and replies:
        replies.pop()   # the newest final reply is the page the card is on
        meta.pop()      # and its entry goes with it, or the two would be a page apart
    return 200, {"replies": replies[-HISTORY_MAX:] if replies else [],
                 "replyMeta": meta[-HISTORY_MAX:] if meta else []}


def _get_log(q: Query, _):
    try:
        n = int(q.one("lines", "120"))
    except ValueError:
        return 400, {"error": "bad count"}
    try:
        lines = _log_file().read_text(errors="replace").splitlines()[-n:]
    except OSError:
        lines = []
    return 200, {"lines": lines}


# the token counter is its own file beside this one, loaded the first time the
# home page asks, so a board nobody opens the home page on never reads a log.
# its counts are kept in tokens-cache.json beside state.json (gitignored), so a
# restart reads only what the logs gained while the board was down
TOKENS_CACHE = HERE / "tokens-cache.json"
TOKENS_MAX_DAYS = 3660
_token_ledger = None
_token_ledger_lock = threading.Lock()


def _ledger():
    import tokens
    try:
        cfg = json.loads((HERE / "run.config.json").read_text())
    except Exception:
        cfg = {}
    folders = tokens.roots(cfg)
    global _token_ledger
    with _token_ledger_lock:
        # the folders are read fresh like every other config key, and a change
        # to them starts a ledger over them from the same cache
        if _token_ledger is None or _token_ledger.roots != folders:
            _token_ledger = tokens.TokenLedger(folders, TOKENS_CACHE)
        return _token_ledger


def _get_tokens_daily(q: Query, _):
    days = q.one("days", "365")
    if not re.fullmatch(r"[0-9]{1,4}", days) or not 1 <= int(days) <= TOKENS_MAX_DAYS:
        return 400, {"error": f"days must be a whole number from 1 to {TOKENS_MAX_DAYS}"}
    return 200, _ledger().daily(int(days))


# the limits box on the home page: the 5-hour and weekly windows of Claude Code
# and of Codex as a percent used, for the tools that have a number to show.
# Claude's come from the file claude-statusline.py writes beside this one
# (gitignored); Codex's from its own app server, at most once in five minutes,
# or from its session logs. limits.py is loaded when the page first asks. The
# first ask waits for Codex; every later one is answered at once from the last
# reading, with the time it was taken, while a stale reading is renewed in the
# background (`refreshing` says so).
CLAUDE_LIMITS = HERE / "claude-limits.json"
_limits = None
_limits_lock = threading.Lock()


def _get_limits(q: Query, _):
    import limits
    global _limits
    with _limits_lock:
        if _limits is None:
            _limits = limits.Limits(CLAUDE_LIMITS, lambda: _ledger().latest_limits())
        reader = _limits
    shown = reader.answer()
    _debug("limits", source=reader.source,
           tools=sum(1 for tool in ("claude", "codex") if tool in shown))
    return 200, shown


def _get_dirs(q: Query, _):
    # the page's folder chooser: one folder's subdirectories, rooted at
    # and fenced to the user's home; hidden folders stay out of sight
    home = Path.home()
    raw = q.one("path").strip()
    try:
        p = (Path(raw).expanduser() if raw else home).resolve()
    except OSError:
        return 400, {"error": "bad path"}
    if p != home and home not in p.parents:
        return 400, {"error": "outside the home directory"}
    if not p.is_dir():
        return 400, {"error": "not a directory"}
    try:
        subs = sorted((c for c in p.iterdir()
                       if c.is_dir() and not c.name.startswith(".")),
                      key=lambda c: c.name.lower())
    except OSError:
        return 400, {"error": "unreadable directory"}
    return 200, {"path": str(p),
                 "parent": str(p.parent) if p != home else None,
                 "dirs": [{"name": c.name, "path": str(c)} for c in subs]}


def _get_pickdir(q: Query, _):
    # tests must never open the dialog: FACILITATOR_PICKDIR_STUB set on
    # the server process answers with its value instead of the chooser
    stub = os.environ.get("FACILITATOR_PICKDIR_STUB")
    if stub:
        return 200, {"path": stub}
    try:
        # activate the chooser first so it opens frontmost and its
        # sidebar and search take clicks; restore the prior front app
        # after. (osascript dialogs open unfocused otherwise.)
        r = subprocess.run(
            ["osascript",
             "-e", 'tell application "System Events"',
             "-e", 'set prior to first process whose frontmost is true',
             "-e", 'activate',
             "-e", 'set picked to POSIX path of (choose folder with prompt "Open a new folder")',
             "-e", 'set frontmost of prior to true',
             "-e", 'return picked',
             "-e", 'end tell'],
            capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        # a chooser left unanswered closes with the subprocess; to the
        # page that is the same quiet non-choice as a cancel
        return 200, {"cancelled": True}
    except OSError as e:
        return 200, {"error": str(e)}
    if r.returncode != 0:
        # the chooser exits nonzero on cancel (-128); anything else
        # nonzero is a real failure and says so
        err = (r.stderr or "").strip()
        if not err or "-128" in err:
            return 200, {"cancelled": True}
        return 200, {"error": err}
    return 200, {"path": r.stdout.strip()}


def _get_upload(q: Query, _):
    fn = q.path[len("/uploads/"):]
    if not fn or "/" in fn or "\\" in fn or fn in (".", ".."):
        return 404, {"error": "not found"}
    for base in (INTERNAL_UPLOADS, HERE / "uploads"):
        p = base / fn
        if p.is_file() and p.resolve().parent == base.resolve() and p.suffix.lower() in UPLOAD_TYPES:
            disposition = "attachment" if q.one("download") == "1" or p.suffix.lower() in (".doc", ".docx") else "inline"
            return FileResponse(p, media_type=UPLOAD_TYPES[p.suffix.lower()], filename=re.sub(r"^\d{13,19}-", "", fn),
                                content_disposition_type=disposition,
                                headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                         "Content-Security-Policy": "sandbox"})
    return 404, {"error": "not found"}


def _get_laneimg(q: Query, _):
    # a picture out of the lane's own internal folder, so an agent
    # working in another project writes next to its own code instead of
    # reaching into this repo. one lane, one plain file name, images only
    lane, _sep, fn = q.path[len("/laneimg/"):].partition("/")
    base = _lane_internal(lane) if lane else None
    # a name with a separator in it is never a file in this folder, and
    # refusing it here kills nested and absolute paths before pathlib
    # gets a chance to be clever about them
    if base is None or not fn or "/" in fn or fn in (".", ".."):
        return 404, {"error": "not found"}
    try:
        # resolve both sides and check containment before reading a
        # byte: .. segments and symlinks pointing out of the folder
        # land somewhere that is not under base, and stop right here
        base = base.resolve()
        p = (base / fn).resolve()
        inside = p != base and base in p.parents
    except OSError:
        inside = False   # unreadable or a symlink loop: same as missing
    if inside and p.is_file() and p.suffix.lower() in IMG_TYPES:
        # the headers /uploads and /navimg use: an SVG here can carry script, and
        # opened by itself it would run in the board's origin without them
        return Response(p.read_bytes(), media_type=IMG_TYPES[p.suffix.lower()],
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                 "Content-Security-Policy": "sandbox"})
    return 404, {"error": "not found"}


# the one sheet the phone page links that its first frame is drawn with. /m is
# served with the sheet's own text in place of this link, so the startup
# curtain is painted from the page's bytes alone instead of after a second
# request. the file stays the one copy: the desktop page and the phone's worker
# still ask for it by name, and a sheet that cannot be read leaves the link,
# which asks for it the way the page always did
PHONE_SHEET_LINK = b'<link rel="stylesheet" href="/card-tokens.css">'


def _get_phone_page(q: Query, _):
    p, ctype = PHONE_FILES["/m"]
    if not p.is_file():
        return 404, {"error": "not found"}
    page = p.read_bytes()
    try:
        sheet = (HERE / "card-tokens.css").read_bytes()
    except OSError:
        return 200, page, ctype
    if b"</style" in sheet.lower():
        return 200, page, ctype   # it would close the element it is put in
    inline = b'<style data-sheet="/card-tokens.css">\n' + sheet + b"</style>"
    return 200, page.replace(PHONE_SHEET_LINK, inline, 1), ctype


def _app_name(title: str) -> str:
    # a board that was never given a title carries the tool's lowercase lane
    # name, which the board and its lane keep. as the name under a home screen
    # icon it is the app's own name and is capitalised like one; a title the
    # owner chose is used exactly as written. the phone page's appNameFor
    # makes the same one exception for its home screen tag
    return "Facilitator" if title == "facilitator" else title


def _get_manifest(q: Query, _):
    # the install prompt reads the app's name from here and the page
    # reads its own from the board title, so a name written into the
    # file could only ever disagree with it. That one field is answered
    # from the saved title; every other field is the file's own, and a
    # board with no title leaves even that alone
    p, ctype = PHONE_FILES["/m-manifest.json"]
    if not p.is_file():
        return 404, {"error": "not found"}
    raw = p.read_bytes()
    try:
        manifest = json.loads(raw)
    except ValueError:
        manifest = None
    if isinstance(manifest, dict):
        with _lock:
            title = (_state.get("title") or "").strip()
        if title:
            manifest["name"] = _app_name(title)
            manifest["short_name"] = _app_name(title)
        raw = json.dumps(manifest, indent=2).encode()
    return 200, raw, ctype


def _get_push_key(q: Query, _):
    try:
        key = _b64url(_push_public_key())
    except Exception as e:
        return 500, {"error": f"push key unavailable: {e}"}
    return 200, {"key": key}


def _get_navfiles(q: Query, _):
    # what the navigator lists: the two folders this lane owns, for the tabs, and
    # the immediate children of ONE directory under one of them. Bounded on
    # purpose. The old panel walked every folder's whole tree on every poll,
    # which is fine for a handful of notes but freezes on an internal folder that
    # holds large archived builds and reports; one directory per request reads
    # only what is on screen and costs nothing for a folder nobody has opened.
    # A directory that is missing or empty, or a lane the panel is not mounted
    # on, comes back present-and-empty so the panel can say so, not look broken.
    lane = q.one("lane")
    roots = _nav_roots(lane)
    meta = [{"root": base.name, "kind": kind, "exists": base.is_dir()}
            for kind, base in roots]
    kind = q.one("kind") or (roots[0][0] if roots else "")
    base = next((p for k, p in roots if k == kind), None)
    rel = q.one("rel")
    out = {"roots": meta, "kind": kind,
           "root": base.name if base is not None else "",
           "dir": rel, "exists": False, "entries": []}
    if base is None:
        return 200, out
    # the directory this listing is of: the root itself for a blank rel, else a
    # path under it, resolved and contained exactly like a file path. .. segments
    # and a symlinked directory pointing out of the root both land outside and
    # are refused here, before a single child is read
    try:
        target = (base / rel).resolve() if rel else base
    except OSError:
        return 200, out
    if not (target == base or base in target.parents) or not target.is_dir():
        return 200, out
    entries = []
    try:
        with os.scandir(target) as it:
            for e in it:
                entries.append(_nav_entry(e, base))
    except OSError:
        return 200, out
    # folders first, then files, each case-insensitively by name: the order the
    # panel used to build for itself, done once here so every reader agrees
    entries.sort(key=lambda x: (x["type"] != "dir", x["name"].casefold()))
    out["exists"] = True
    out["entries"] = entries
    return 200, out


def _get_navfile(q: Query, _):
    # one file's whole text for the editor, with the stamp the save guard will
    # want back. The path is resolved and contained like every navigator path;
    # then _read_capped opens it as a regular file only (never a directory, fifo,
    # socket or device, and without blocking or following a link swapped in at the
    # path), reading at most the cap plus one byte so the allocation is bounded.
    # A file that decodes as utf-8 but carries NUL or other control bytes, or that
    # is a known non-text media/document type, is refused, so the editor is never
    # handed bytes a later save would then write back over the real file.
    root, rel = q.one("root"), q.one("rel")
    p = _nav_path(q.one("lane"), root, rel)
    if p is None:
        return 400, {"error": "outside the navigator folders"}
    data = _read_capped(p, MAX_TEXT_BODY)
    if data is None:
        return 404, {"error": "no such file"}
    if len(data) > MAX_TEXT_BODY:
        return 413, {"error": "file is too large to open in the editor"}
    # both the requested name and the resolved target's name are checked: an
    # in-root alias named notes.txt pointing at doc.pdf must not slip a recognized
    # binary past the deny-list on its text-looking alias name. An in-root text
    # alias (its target a plain text file) still passes, since neither name is one
    if _binary_ext(rel) or _binary_ext(p.name):
        return 415, {"error": "this file type is not opened as text"}
    if not _looks_text(data):
        return 415, {"error": "not a text file"}
    text = data.decode("utf-8")
    # windows line endings are carried to the page rather than silently
    # flattened: the editor is told to keep them so a save writes the
    # file back in the endings it arrived in
    return 200, {"root": root, "rel": rel,
                 "text": text, "mtime": _nav_stamp(p), "crlf": "\r\n" in text}


def _get_navimg(q: Query, _):
    # one in-root image, for the navigator's inline preview. The same resolve and
    # containment as every navigator path, then a regular file whose extension is
    # one of the image types, read through the same bounded reader so a file that
    # grows after a size check can never be served past the cap. Served with the
    # exact headers /uploads uses: nosniff so the type cannot be reinterpreted, and
    # a sandbox CSP so even an SVG is dropped into an opaque origin where its
    # script, if any, cannot run. The bytes are a resource the browser loads into
    # an <img>, never markup injected into the board.
    p = _nav_path(q.one("lane"), q.one("root"), q.one("rel"))
    if p is None:
        return 400, {"error": "outside the navigator folders"}
    suffix = p.suffix.lower()
    if suffix not in IMG_TYPES:
        return 415, {"error": "not an image"}
    data = _read_capped(p, MAX_IMG_PREVIEW)
    if data is None:
        return 404, {"error": "no such file"}
    if len(data) > MAX_IMG_PREVIEW:
        return 413, {"error": "image is too large to preview"}
    return Response(data, media_type=IMG_TYPES[suffix],
                    headers={"Cache-Control": "no-store",
                             "X-Content-Type-Options": "nosniff",
                             "Content-Security-Policy": "sandbox"})


# -- the agent's long poll, in three locked steps ------------------------------
# The waiting itself happens on the event loop (WaitRoute below), so a hundred
# agents waiting would cost a hundred coroutines and no threads at all. What
# needs the lock is short: entering, one attempt to claim, and leaving.

def _wait_enter(owner: str, agent: str | None) -> None:
    """Count one more listener on this lane. The first ever listen for an owner
    records ever_listened and saves it, and the count is bumped only once that
    save has gone through: a save that fails raises before the bump and rolls
    _state back, so a lane can never be left showing a listener that a failed
    first wait never really had. Callers reach _wait_leave only when this
    returned, so the bump and the later decrement stay balanced."""
    with _lock:
        if agent:
            _agent_names[owner] = agent[:24]
        ev = _state.setdefault("ever_listened", {})
        if not ev.get(owner):
            ev[owner] = True
            _save()   # raises SaveFailed on failure, before the count is touched
        _waiters[owner] += 1


def _wait_leave(owner: str) -> None:
    with _lock:
        _waiters[owner] -= 1
        _last_wait[owner] = time.time()


def _wait_poll(owner: str):
    """One pass over the lane: the clocks, the steal-back, then a claim if a
    box is waiting. Answers the claim, or None when there is nothing to say
    yet."""
    with _lock:
        # the short clock first: a hand-off nobody confirmed comes back
        # after 90 seconds, long before the steal-back below notices
        _release_unacked()
        # and a working flag that stopped pinging drops its card out of
        # green, handing over a turn deferred under it
        _sweep()
        # a claim older than 15 min with no reply is a dead listener: steal it back
        for ow in OWNERS:
            stale = _state["busy"].get(ow)
            if stale is not None and time.time() - _state["busy_ts"].get(ow, 0) > 900:
                _state["busy"][ow] = None
                _state["claimed"][ow] = []
                if _box(stale) and _box(stale)["pending"] and stale not in _state["inbox"]:
                    _state["inbox"].insert(0, stale)
                _save()
        if _state["busy"][owner] is None:
            bid = next((i for i in _state["inbox"]
                        if (_box(i) or {}).get("owner", "facilitator") == owner), None)
            if bid is not None:
                _state["inbox"].remove(bid)
                box = _box(bid)
                _state["busy"][owner] = bid
                _state["claimed"][owner] = [m["mid"] for m in box["pending"]]
                # the hand-over itself, which is the one moment that can say
                # what a reply was given: this claim's own messages are noted
                # right here where the delivery happens. the claim is minted
                # whole and the note is written whole with it, so nothing an
                # earlier claim left behind can reach a later answer. a message
                # landing on this card after this line was handed over by
                # nothing, and nothing covers it until /fresh or a later claim
                # delivers it
                _hand_over(box, box["pending"])
                _state["busy_ts"][owner] = time.time()
                # every claim is provisional: the token below is what
                # POST /ack has to name, and until it does this claim is
                # on the 90 second clock. A lane holds one claim, so one
                # record per lane says everything about it
                token = secrets.token_hex(6)
                _state["ack"][owner] = {"box": bid, "token": token,
                                        "ts": time.time(), "confirmed": False}
                # that a receipt was minted, never the receipt itself
                _debug("claim", bid, owner=owner, token=bool(token))
                _save()
                payload = {
                    "box": bid, "title": box["title"],
                    "messages": [m["text"] for m in box["pending"]],
                    # where each message was typed, one entry per
                    # message in the same order: "mini" for the small
                    # card, null for the big one. It rides beside
                    # messages instead of inside it because agent
                    # loops elsewhere read messages as plain strings
                    "message_via": [m.get("via") for m in box["pending"]],
                    "queued_after": sum(1 for i in _state["inbox"]
                                        if (_box(i) or {}).get("owner", "facilitator") == owner),
                    # the receipt this hand-off has to come back with
                    "ack": token,
                }
                return payload
        return None


def _rollback_claim(owner: str, bid: str, token: str) -> bool:
    """A hand-off that never reached its listener is undone: the box goes back
    to the FRONT of its lane's queue, exactly as a dead-socket write always
    did. Only the claim this token was minted for is touched. If the token has
    since been confirmed, the listener did get it and the claim stands; if the
    lane holds another claim or another token, that claim is somebody else's
    and stands too. True when something was rolled back."""
    with _lock:
        rec = _state.get("ack", {}).get(owner)
        if (not rec or rec.get("token") != token or rec.get("confirmed")
                or rec.get("box") != bid or _state["busy"].get(owner) != bid):
            return False
        _state["busy"][owner] = None
        _state["claimed"][owner] = []
        _state["ack"][owner] = None
        if bid not in _state["inbox"]:
            _state["inbox"].insert(0, bid)
        _log("dropped", bid, f"{owner} hand-off died on the wire, box re-queued")
        _save()
        _notify()
        return True


# -- POST -----------------------------------------------------------------------

# ---- attachments ----------------------------------------------------------------
# What an upload is allowed to be. The name only says which kind of file the
# sender means; the first bytes say which kind arrived, and the two have to
# agree, so a page renamed as a picture never reaches the uploads folder. The
# checks are loose within a kind on purpose (any of the box names a QuickTime
# file may open with, a bare frame as well as a tag for MP3, RTF as well as the
# Word binary for .doc), because a real file turned away is the worse mistake:
# what keeps an odd file harmless is how /uploads serves it, with nosniff and a
# sandbox, and this is the layer in front of that. The words are the phone's:
# it shows them to the owner as they are.
UPLOAD_HEAD = 4096              # bytes of the start of a file its kind is read from
_ISO_BOXES = (b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot")
UPLOAD_KINDS = {
    ".png": ("a PNG picture", lambda h: h.startswith(b"\x89PNG\r\n\x1a\n")),
    ".jpg": ("a JPEG picture", lambda h: h.startswith(b"\xff\xd8\xff")),
    ".jpeg": ("a JPEG picture", lambda h: h.startswith(b"\xff\xd8\xff")),
    ".gif": ("a GIF picture", lambda h: h.startswith((b"GIF87a", b"GIF89a"))),
    ".webp": ("a WebP picture", lambda h: h[:4] == b"RIFF" and h[8:12] == b"WEBP"),
    ".svg": ("an SVG picture", lambda h: b"<svg" in h.lower()),
    ".mp4": ("an MP4 video", lambda h: h[4:8] in _ISO_BOXES),
    ".m4v": ("an M4V video", lambda h: h[4:8] in _ISO_BOXES),
    ".mov": ("a QuickTime video", lambda h: h[4:8] in _ISO_BOXES),
    ".webm": ("a WebM video", lambda h: h.startswith(b"\x1a\x45\xdf\xa3")),
    ".ogv": ("an Ogg video", lambda h: h.startswith(b"OggS")),
    ".mp3": ("an MP3 recording", lambda h: h.startswith(b"ID3") or (len(h) > 1 and h[0] == 0xFF and h[1] & 0xE0 == 0xE0)),
    ".m4a": ("an M4A recording", lambda h: h[4:8] in _ISO_BOXES),
    ".aac": ("an AAC recording", lambda h: h.startswith((b"ID3", b"ADIF")) or (len(h) > 1 and h[0] == 0xFF and h[1] & 0xF0 == 0xF0)),
    ".wav": ("a WAV recording", lambda h: h[:4] == b"RIFF" and h[8:12] == b"WAVE"),
    ".ogg": ("an Ogg recording", lambda h: h.startswith(b"OggS")),
    ".oga": ("an Ogg recording", lambda h: h.startswith(b"OggS")),
    ".opus": ("an Opus recording", lambda h: h.startswith(b"OggS")),
    ".weba": ("a WebM recording", lambda h: h.startswith(b"\x1a\x45\xdf\xa3")),
    ".pdf": ("a PDF", lambda h: b"%PDF-" in h[:1024]),
    ".doc": ("a Word document", lambda h: h.startswith((b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", b"{\\rtf"))),
    ".docx": ("a Word document", lambda h: h.startswith(b"PK\x03\x04")),
}
# what an SVG may not carry: script in any of the ways a document can hold it,
# an event handler on any element, a javascript: link, or HTML embedded in it.
# /uploads already serves an SVG where none of this could run; refusing it here
# means the folder never holds one that would run anywhere else
_SVG_SCRIPT = re.compile(rb"<script|<handler|<foreignobject|<iframe|<embed|<object|javascript:"
                         rb"|<[^<]{0,4096}?[\s\"'/]on[a-z]+\s*=", re.IGNORECASE)
_SVG_OVERLAP = 8192             # longer than any match above, so a read boundary never splits one
UPLOAD_WORDS = {
    "type": "That kind of file cannot be attached. Choose an image, video, audio, PDF or Word file.",
    "large": "The file is larger than 100 MiB, so it was not attached.",
    "empty": "The file is empty, so it was not attached.",
    "script": "That SVG carries script, so it was not attached.",
    "stalled": "The upload stopped arriving for a minute, so it was not saved.",
    "late": "The upload took longer than an hour, so it was not saved.",
    "op": "That upload id is not one this board can use.",
    "other": "That upload id belongs to another file.",
    "arriving": "That upload is still arriving.",
}
# the operation ids of finished uploads, oldest first, and the ones still
# coming in. Both are this server run's alone and touched only on the loop: an
# upload changes no board state, so a receipt lost to a restart costs a second
# copy of one file, never a second message
_upload_receipts: dict[str, dict] = {}
_uploads_arriving: set[str] = set()


def _upload_name(name: str) -> str:
    """The name a file is kept under after its stamp: letters, digits, dot,
    dash, underscore and space, the last 100 of them."""
    return "".join(c for c in name if c.isalnum() or c in "._- ").strip()[-100:] or "file"


def _upload_kind_error(ext: str, head: bytes) -> str | None:
    """Plain words when the start of a file is not the kind its name says."""
    kind = UPLOAD_KINDS.get(ext)
    if kind is None:
        return UPLOAD_WORDS["type"]
    words, matches = kind
    return None if matches(head) else f"That file is not {words}, whatever its name says, so it was not attached."


def _svg_carries_script(path: Path) -> bool:
    """The whole file is read for it, a MiB at a time with an overlap so a
    marker cut in two by the read is still seen whole."""
    tail = b""
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            window = tail + chunk
            if _SVG_SCRIPT.search(window):
                return True
            tail = window[-_SVG_OVERLAP:]
    return False


def _sweep_upload_parts() -> None:
    """Part files an upload left behind when the server stopped under it. One
    still younger than an upload may take could belong to a server starting
    beside this one, so only older ones go."""
    try:
        for part in INTERNAL_UPLOADS.glob(".*.part"):
            try:
                if time.time() - part.stat().st_mtime > UPLOAD_TIME_LIMIT:
                    part.unlink()
            except OSError:
                pass
    except OSError:
        pass


# The files the board keeps about its owner's work, by name, for the sweep
# below. server.py, the pages and run.config.json are not among them.
PRIVATE_FILES = ("state.json", "state.json.bak-*", "state.tmp", "transcript.jsonl", "settings.json",
                 "settings.json.tmp", "settings.json.bad-*", "vapid-key.pem", "bridge-auth.json",
                 "tokens-cache.json", "tokens-cache.json.tmp", "claude-limits.json",
                 "claude-limits.json.tmp", "usage-counts.json", "usage-counts.json.tmp", "server.lock")
PRIVATE_LOGS = ("server-*.log", "client-*.jsonl", "bridge-*.log")


def _tighten_private_files() -> None:
    """Files an earlier board, or an earlier version of this one, left readable
    by other accounts on the machine lose the group and other permissions.
    Only regular files under the board's own names are touched: never a link,
    a folder, or anything else that happens to sit in the same place."""
    places = ((HERE, PRIVATE_FILES), (LOG_DIR, PRIVATE_LOGS),
              (INTERNAL_UPLOADS, ("*",)), (HERE / "uploads", ("*",)))
    narrowed = 0
    for folder, patterns in places:
        for pattern in patterns:
            try:
                found = list(folder.glob(pattern))
            except OSError:
                continue
            for path in found:
                try:
                    seen = path.lstat()
                    if stat.S_ISREG(seen.st_mode) and seen.st_mode & 0o077:
                        os.chmod(path, stat.S_IMODE(seen.st_mode) & ~0o077)
                        narrowed += 1
                except OSError:
                    pass
    if narrowed:
        _info("private", files=narrowed)


def _post_clientlog(q: Query, raw: bytes):
    # what a page noticed and has no other way to say: a thrown error, a
    # rejected promise, a fetch or a render that failed, a timer that ran
    # late. The size cap is applied to the body before it is read at all
    try:
        batch = json.loads(raw.decode("utf-8", "replace")) if raw else None
    except ValueError:
        batch = None
    page = batch.get("page") if isinstance(batch, dict) else None
    reports = batch.get("reports") if isinstance(batch, dict) else None
    who = _client_who(batch) if isinstance(batch, dict) else None
    if (page not in CLIENT_PAGES or who is None or not isinstance(reports, list) or not reports
            or not all(isinstance(r, dict) and r.get("kind") in CLIENT_KINDS
                       for r in reports)):
        # nothing of a batch this board cannot read is stored, the way
        # every other record-taking route on here already refuses
        return 400, {"error": "bad report batch"}
    if len(reports) > CLIENT_MAX_REPORTS:
        return 400, {"error": "too many reports in one batch"}
    if any(r["kind"] == "incident" and not _incident_valid(page, r) for r in reports):
        return 400, {"error": "bad incident history"}
    if any(r["kind"] in NOTICE_FIELDS and not _notice_valid(page, r) for r in reports):
        return 400, {"error": "bad notification report"}
    try:
        written, dropped = _client_batch(page, reports, who)
    except OSError:
        return 503, {"error": "the diagnostic log could not be written"}
    return 200, {"ok": True, "written": written, "dropped": dropped}


def _post_navsave(q: Query, raw: bytes):
    # the body is taken raw because the shared text read strips it: a file's
    # trailing newline is content and losing it would break the round trip on the
    # very first save. The navigator never creates files, so the target has to
    # already exist as a regular file; what is there now has to itself be text, so
    # a binary is never overwritten through an arbitrary utf-8 body; and the new
    # body has to be text too. The endpoint has already capped the body at
    # MAX_TEXT_BODY before these bytes were kept.
    root, rel = q.one("root"), q.one("rel")
    p = _nav_path(q.one("lane"), root, rel)
    if p is None:
        return 400, {"error": "outside the navigator folders"}
    if not _looks_text(raw):
        return 415, {"error": "refusing to save non-text content"}
    # the resolved target's name too, so an alias name cannot hide a binary target
    if _binary_ext(rel) or _binary_ext(p.name):
        return 415, {"error": "this file type is not editable as text"}
    # what is on disk right now, through the same bounded regular-file reader: None
    # when the target is missing or not a regular file (the navigator creates
    # nothing and never writes a directory or a special file), and refused if it is
    # too large or is itself binary. This is the guard that stops a POST straight at
    # a binary path from clobbering it with a text body.
    current = _read_capped(p, MAX_TEXT_BODY)
    if current is None:
        return 404, {"error": "no such file"}
    if len(current) > MAX_TEXT_BODY or not _looks_text(current):
        return 415, {"error": "refusing to overwrite a non-text file"}
    # the stale-write guard: the stamp the page was handed on read comes
    # back here, and a file whose stamp has moved since is one somebody
    # else has written. Refused with the current stamp so the page can
    # say plainly what happened; the reader's text is never merged or dropped for
    # the reader, it stays in the editor where it can still be seen
    try:
        now = _nav_stamp(p)
    except OSError:
        return 400, {"error": "unreadable file"}
    was = q.one("mtime")
    if was and was != now:
        return 409, {"error": "changed on disk", "mtime": now}
    # the temp is a fresh, exclusive descriptor in the target's own directory:
    # mkstemp opens with O_CREAT|O_EXCL|O_NOFOLLOW, so it can neither reuse a real
    # neighbour (no data loss) nor follow a symlink planted at a predictable
    # <name>.tmp (no write or chmod outside the root), which the old fixed name
    # could. The permission bits are copied onto that descriptor with fchmod, then
    # one atomic rename puts it in place. Only the temp this request itself made is
    # ever cleaned up on failure; no pre-existing neighbour is touched.
    try:
        mode = os.stat(p).st_mode & 0o777
    except OSError:
        mode = None
    try:
        fd, tmpname = tempfile.mkstemp(dir=str(p.parent), prefix=p.name + ".", suffix=".tmp")
    except OSError as e:
        return 400, {"error": str(e)}
    tmp = Path(tmpname)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
            if mode is not None:
                os.fchmod(fh.fileno(), mode)
        os.replace(tmp, p)
    except OSError as e:
        tmp.unlink(missing_ok=True)
        return 400, {"error": str(e)}
    return 200, {"ok": True, "mtime": _nav_stamp(p)}


def _post_send(q: Query, text: str):
    bid = q.one("box")
    via = "mini" if q.one("via") == "mini" else ""
    op = q.one("op")
    if op and not _op_id_ok(op):
        return 400, {"error": "bad operation id"}
    with _lock:
        fp = _fingerprint("send", bid, via, text) if op else ""
        if op:
            # the receipt is read before the box is even looked at: a message
            # that landed on a card since closed still landed
            found, rec = _op_lookup(op, fp)
            if found == "mismatch":
                return 409, {"error": "operation id reused with a different payload"}
            if found == "same":
                return 200, {**rec["result"], "rev": _state.get("rev", 0), "replayed": True}
        box = _box(bid)
        if box is None or not text:
            return 400, {"error": "bad box or empty text"}
        msg = {"mid": _state["next_mid"], "text": text, "ts": time.time()}
        # where it was typed: via=mini means the small card in the corner.
        # Only that literal is kept, so a caller that passes nothing (the
        # big card, any older sender) stores exactly what it always did
        if via:
            msg["via"] = "mini"
        if op:
            msg["op"] = op
        box["pending"].append(msg)
        box["docked"] = False
        box["parked"] = False
        _stamp_rest(box, msg["ts"])
        # fresh feedback lowers the ready-to-test marker: the reader has answered,
        # so any earlier "ready to try" no longer stands. This sits past the op
        # receipt above, so a deduplicated retry of an already-accepted send
        # returns without reaching here and cannot clear a later fresh marker.
        box["testing"] = False
        box["ball"] = "me"  # the message is sent: the ball is in the agent's court
        # the message queues the card; a beating flag keeps its green,
        # and a deferred turn dies here, since the reader has read and
        # answered: it must not resurface when the flag goes down
        box["state"] = "working" if _hb_live(box) else "queued"
        box["ts"] = time.time()
        _state["next_mid"] += 1
        # untitled user-created meta box: its first message names it
        if box["bucket"] == "meta" and box["id"] != "0" and box["title"] == "…":
            first = text.splitlines()[0].strip()
            box["title"] = (first[:48] + "…") if len(first) > 48 else first
        if bid not in _state["inbox"] and _state["busy"][box.get("owner", "facilitator")] != bid:
            _state["inbox"].append(bid)
        result = {"ok": True, "mid": msg["mid"], "box": bid}
        if op:
            _op_commit(op, fp, "send", bid, result)
        # the row is queued and written by the save once the new file is
        # installed, so a save that failed and rolled the message back leaves
        # no row for a message the board never durably had
        _log("user", bid, text, log_fields={"op": op} if INCIDENT_OP.fullmatch(op) else None,
             **({"op": op} if op else {}))
        _save()
        _notify()
        return 200, {**result, "rev": _state["rev"]}


def _post_ack(q: Query, text: str):
    # the other half of the hand-off: the token /wait handed out
    # comes back here and the provisional claim becomes a real one.
    # Nothing else about the claim changes, so a confirmed claim is
    # exactly what /fresh, /reply and the steal-back always saw
    ow = q.one("owner", "facilitator")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    token = q.one("token")
    with _lock:
        rec = _state.get("ack", {}).get(ow)
        if not token or not rec or rec.get("token") != token:
            return 409, {"error": "unknown or stale token"}
        if rec.get("confirmed"):
            # idempotent: a resent ack is the same ack, never a 409
            return 200, {"ok": True, "box": rec["box"]}
        if _state["busy"].get(ow) != rec.get("box"):
            # the claim this token names is already over: released by
            # the 90 second clock, stolen back, replied to or dismissed
            return 409, {"error": "claim no longer held"}
        rec["confirmed"] = True
        _debug("ackok", rec["box"], owner=ow, token=bool(token))
        _log("ack", rec["box"], f"{ow} confirmed delivery")
        _save()
        return 200, {"ok": True, "box": rec["box"]}


def _post_reply(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        if "quiet" in q:
            return 400, {"error": "quiet replies were removed; use /note for progress"}
        # the summary strip is optional as of 20260821: the owner had
        # the summary box taken off the card, so nothing displays it and
        # the agent no longer writes one. a ctx that is passed is still
        # stored and still size checked, so older callers keep working
        ctx = q.one("ctx").strip()
        if ctx and len(ctx.split()) > 50:
            # refused outright, never silently chopped
            return 400, {"error": "context strip over 50 words"}
        ow = box.get("owner", "facilitator")
        # The compact version is data, not punctuation inside the full
        # prose. keep_blank_values distinguishes an intentionally empty
        # small card from an omitted version, which mirrors the full one.
        short_values = parse_qs(q.raw, keep_blank_values=True).get("short")
        short = short_values[0].strip() if short_values is not None else None
        # a message typed in the small card gets a small answer back:
        # that card is a few lines tall and a long reply is unreadable
        # in it. The newest message the claim covers is the one being
        # answered, so that one decides. Refused outright like the
        # context strip above, never silently chopped
        held = _state["claimed"][ow] if _state["busy"][ow] == bid else []
        answering = next((m for m in box["pending"] if m["mid"] == held[-1]), None) if held else None
        if answering is not None and answering.get("via") == "mini":
            words = len((text if short is None else short).split())
            if words > 100:
                return 400, {"error": f"small card reply over 100 words: {words} words"}
        _last_wait[ow] = time.time()  # a reply proves that agent is alive too
        _set_reply_variants(box, text, short)
        box["replies"] += 1
        # and the count the history arrows walk, which the aggregate above
        # cannot be: it counts progress notes too. The card is showing this
        # reply now, so it is the page you are on rather than one behind you
        box["full_replies"] = box.get("full_replies", 0) + 1
        box["reply_kind"] = "agent"
        # The machine's sole answer move, taken once the claim is let
        # go below. While a working flag beats, the final turn waits in
        # deferred and is handed over when that work ends.
        now = time.time()
        box["agent_ts"] = now  # when the agent last replied
        box["ts"] = now
        if ctx:
            box["context"] = ctx
        _release_claim(box, for_answer=True)
        # What this reply answers, recorded with the reply itself. It is made of
        # the board's own claim identities and of nothing else: what the
        # progress notes on the way consumed, and what the claim in force at
        # this moment handed over, which the release above has just folded in.
        # A claim that was dismissed unanswered is in neither, so this reply
        # cannot inherit it; a message that arrived after the claim was handed
        # over by nothing and waits in the queue for a reply that is given it.
        # Every member is kept, however many there are.
        # The card starts from nothing again, so the next completed answer opens
        # its own association and no message is ever answered twice. A hand-over
        # this board has no record of records null here, which says unknown and
        # is not the same as a reply that was handed nothing.
        box["answered"] = _take_answered(box)
        box["reply_id"] = _next_reply_id(bid)
        # when this reply was completed. agent_ts above cannot mean that: a
        # progress note moves that stamp and leaves this one standing, which is
        # what lets a card opened later age the box over its answer by the
        # answer's own clock
        box["reply_ts"] = now
        if _hb_live(box):
            box["state"] = "deferred"
        else:
            _turn_to_you(box)
            box["state"] = _rest(box)
        # the row carries the same three facts, so an older page of the history
        # states what it answered and when it was completed exactly as the card
        # states them for the live one. they ride on the transcript row and not
        # on the log line, like the words themselves, since what was said is not
        # the log's business
        _log("agent", bid, text, reply_full=text,
             reply_short=box["reply_short"],
             reply_variants_version=REPLY_VARIANTS_VERSION,
             reply_id=box["reply_id"], reply_ts=now,
             answered=box["answered"], agent_kind=_agent_kind(ow))
        _save()
        _notify()
        return 200, {"ok": True}


def _post_note(q: Query, text: str):
    # The sole background-progress action. It releases a held claim,
    # owns an explicit note state and keeps the turn with the agent,
    # so it can never turn yellow when its heartbeat ends.
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        ctx = q.one("ctx").strip()
        if ctx and len(ctx.split()) > 50:
            return 400, {"error": "context strip over 50 words"}
        ow = box.get("owner", "facilitator")
        _last_wait[ow] = time.time()  # a note proves that agent is alive too
        _set_reply_variants(box, text)
        box["replies"] += 1
        # a note is not a page of the reply history: it adds none and hides
        # none, so the final reply it was written over becomes an older page
        box["reply_kind"] = "note"
        box["agent_ts"] = time.time()
        box["ts"] = time.time()
        if ctx:
            box["context"] = ctx
        # the claim goes, and the messages it covered leave the pending list
        # with it. but a note is not an answer, so the claim is let go FOR the
        # answer: what it consumed is kept for the completed reply still to
        # come, and several notes may each consume their own claim toward that
        # one reply. nothing here writes answered, reply_id or reply_ts either,
        # so the last completed reply keeps its own name, its own completion
        # time and its own batch while this note stands over it, and no page can
        # present this note as an answer to anything
        _release_claim(box, for_answer=True)
        box["ball"] = "me"
        box["hb"] = time.time()
        box["state"] = "note"
        _log("note", bid, text, reply_full=text, reply_short=text,
             reply_variants_version=REPLY_VARIANTS_VERSION)
        _save()
        _notify()
        return 200, {"ok": True}


def _post_done(q: Query, text: str):
    bid = q.one("box")
    try:
        order = _park_order_read(q)
    except ValueError:
        return 400, {"error": "bad done order"}
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        if _section_order_stale(box, order):
            return 200, {"ok": False, "stale": "superseded", **_section_fields(box)}
        box["done"] = q.one("v", "1") == "1"
        if box["done"]:
            box["docked"] = False
            box["parked"] = False
            box["testing"] = False   # a done card is not awaiting a test
        _stamp_rest(box, time.time())
        _log("done" if box["done"] else "undone", bid, "")
        _save()
        _notify()
        return 200, {"ok": True}


def _post_working(q: Query, text: str):
    # a job runs behind this card: green without a claim, so the
    # lane stays free. Registration starts a heartbeat clock; the
    # job (or agent) must /ping while it runs, or green expires.
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        box["hb"] = time.time() if q.one("v", "1") == "1" else 0
        if box["hb"]:
            _green(box)
        # v=0 is one of the two ways out of green, so the sweep runs
        # right here and a deferred turn is handed over at once. v=1
        # re-registers and the flag beats again, so a deferred card
        # just keeps waiting, which is what re-registering should mean. This
        # route saves once below, including anything this sweep moves.
        _sweep(persist=False)
        _log("working" if box["hb"] else "workdone", bid, "")
        _save()
        _notify()
        return 200, {"ok": True}


def _post_ping(q: Query, text: str):
    # heartbeat for a registered job; keeps the card's green alive
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        if box.get("hb"):
            box["hb"] = time.time()
            _green(box)  # a registered job beating again takes back its green
        return 200, {"ok": True, "bg": bool(box.get("hb"))}


def _post_testing(q: Query, text: str):
    # The ready-to-test marker: an explicit per-card flag the agent raises once a
    # delivered change is actually available for the reader to try, and lowers by
    # hand. v=1 marks, v=0 clears. Marking is refused unless the card is genuinely
    # awaiting the reader (see _await_reader_test), so the flag can never claim
    # that active, queued or done work is ready; clearing is always allowed. This
    # route touches only the flag: it adds no reply or history row, consumes no
    # claim, marks nothing seen and moves no card. The reader answering the card,
    # and the card being closed or marked done, lower the flag on their own paths.
    # The pages lower it here when the reader unfolds the ticket.
    bid = q.one("box")
    want = q.one("v", "1") == "1"
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        held = bool(box.get("testing", False))
        if want and not held and not _await_reader_test(box):
            # nothing changes: a card not awaiting the reader stays as it is, and
            # the caller is told why rather than left to guess
            return 409, {"error": "card is not awaiting the reader", "testing": held}
        if held == want:
            # already in the asked-for state: no revision and no notice
            return 200, {"ok": True, "testing": want, "unchanged": True}
        box["testing"] = want
        _log("testmark" if want else "testclear", bid, "")
        _save()
        _notify()
        return 200, {"ok": True, "testing": want}


# ---- the order of each page's own section commands ----------------------------
# Dock, park, done and close share a stream so a late request cannot undo a
# newer move to a different section. The _park names are retained for callers
# and tests that inspect the original ordering guard.
# A page can stop waiting for an answer; it cannot recall the request. An abort
# there drops the answer, not the bytes already on their way here. So a snooze
# the phone gave up on can still arrive after the unsnooze that replaced it,
# and absolute values applied in arrival order would leave the board holding
# the value that was undone. Only this side sees the arrivals, so only this side can
# refuse them.
#
# The contract. A page names its own command stream (sid) and numbers every
# attempt in it (seq), rising and never reused. This remembers, for a card and
# a stream TOGETHER, the highest place already judged from that stream, and
# refuses anything from that same stream at or below it: a command the page
# that sent it has already replaced.
#
# One fact per stream, not one per card, and that distinction is the whole of
# it. A single fact per card fails this sequence: page A place 2 unsnoozes;
# page B place 1 unsnoozes, which is B's first command and so is applied; then
# A's abandoned place 1 snooze arrives. It is obsolete inside A's own stream,
# but B had taken the card's only slot, so it was applied and the card snoozed
# itself again behind the reader. Keeping A's fact beside B's answers that with no
# comparison of clocks or of tap times between devices: both newer commands
# agree, and the last one is simply behind A's own high water mark.
#
# Identity: sid names one page load. It is not a person, a device or a card, it
# is never logged and never saved, and nothing else reads it.
# Lifetime: this process only, and a finite time within it. A restart begins
# with no facts at all, so a command that crosses a restart is ordered against
# nothing. What becomes of requests already in transit across a restart is not
# something this code establishes, and nothing here relies on it.
# Limits: a name is at most _PARK_ID_MAX characters of letters, digits, dash
# and underscore; a place is a whole number in range. Accepting a newer ordered
# command prunes pairs older than _PARK_ORDER_TTL seconds and removes the oldest
# pairs once more than _PARK_ORDER_MAX are held. A pair that has been
# forgotten orders nothing, which is exactly where this route began.
# The record is read and written only under _lock, with the board it belongs to.
#
# What it is not. It is not a receipt: it answers "is this obsolete", not "has
# this been done before", and it keeps no results to replay. It orders nothing
# BETWEEN pages: a command that is not obsolete within its own stream is
# applied, so two devices stay last writer wins, exactly as they were.
_PARK_ORDER: dict[tuple[str, str], dict] = {}   # (card, stream) -> place, when
_PARK_ORDER_TTL = 900.0
_PARK_ORDER_MAX = 1024
_PARK_ID_MAX = 64
_PARK_ID_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def _park_order_read(q: Query):
    """The stream and place a section move names itself by, or None from a caller that
    names none. A pair half given or malformed raises instead: that is a broken
    caller rather than an older one, and saying so is better than guessing."""
    sid, seq = q.one("sid", ""), q.one("seq", "")
    if not sid and not seq:
        return None
    if not sid or not seq:
        raise ValueError("half an order")
    if len(sid) > _PARK_ID_MAX or not set(sid) <= _PARK_ID_CHARS:
        raise ValueError("stream name")
    place = int(seq)   # anything that is not a whole number raises here
    if not 0 <= place <= 2 ** 53:
        raise ValueError("place out of range")
    return sid, place


def _park_order_keep(bid: str, sid: str, place: int, now: float) -> None:
    """This stream's place for this card, kept beside whatever other streams
    hold for the same card, and the record kept small: pairs go on age first,
    then the oldest go when there are more of them than the limit."""
    _PARK_ORDER[(bid, sid)] = {"seq": place, "at": now}
    for old in [k for k, v in _PARK_ORDER.items() if now - v["at"] > _PARK_ORDER_TTL]:
        del _PARK_ORDER[old]
    while len(_PARK_ORDER) > _PARK_ORDER_MAX:
        del _PARK_ORDER[min(_PARK_ORDER, key=lambda k: _PARK_ORDER[k]["at"])]


def _section_fields(box: dict) -> dict:
    """The authoritative sections and times, including in a refused command."""
    return {"docked": box.get("docked", False), "parked": box.get("parked", False),
            "done": box["done"], "dockedTs": box.get("docked_ts", 0),
            "parkedTs": box.get("parked_ts", 0), "doneTs": box.get("done_ts", 0),
            "rev": _state.get("rev", 0)}


def _section_order_stale(box: dict, order) -> bool:
    """Judge and remember a move in its page's stream. Caller holds _lock."""
    if order is None:
        return False
    sid, place = order
    prior = _PARK_ORDER.get((box["id"], sid))
    if prior is not None and place <= prior["seq"]:
        return True
    # A message refusal still consumes the position: this page already sent it.
    _park_order_keep(box["id"], sid, place, time.time())
    return False


def _post_shelf(q: Query, flag: str, event: str):
    bid = q.one("box")
    want = q.one("v", "1") == "1"
    try:
        order = _park_order_read(q)
    except ValueError:
        return 400, {"error": f"bad {event} order"}
    # What docking or deferring was decided on: the board's own clock at the
    # tap, which the page can name because every reading carries the
    # board's time. A move that crossed one of the reader's messages on the way here
    # was decided before that message existed, and a card the reader has just written to
    # is not a card the reader is snoozing, so the board keeps what it has and says so
    # rather than burying the message under a defer.
    #
    # The guard is deliberately the narrowest one that answers that: only a
    # move into Docked or Deferred, only against the reader's own queued messages,
    # and only when a basis is given. Undock/unpark, an older page that sends no
    # basis and an agent's progress note all behave exactly as they always did, and
    # a basis that will not read as a number is no basis at all.
    try:
        basis = float(q.one("after", "") or 0)
    except ValueError:
        basis = 0.0
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        # the card as it stands, for any answer that keeps it that way
        kept = _section_fields(box)
        if _section_order_stale(box, order):
            return 200, {"ok": False, "stale": "superseded", **kept}
        if want and basis:
            newest = max((m.get("ts", 0) for m in box["pending"]), default=0)
            if newest > basis:
                # nothing was written and nothing is being retried: the page is
                # told plainly which state the card is actually in
                return 200, {"ok": False, "stale": "message", **kept}
        box[flag] = want
        if want:
            box["done"] = False
            box["parked" if flag == "docked" else "docked"] = False
        _stamp_rest(box, time.time())
        _log(event if want else "un" + event, bid, "")
        _save()
        _notify()
        return 200, {"ok": True, **_section_fields(box)}


def _post_park(q: Query, text: str):
    return _post_shelf(q, "parked", "park")


def _post_dock(q: Query, text: str):
    return _post_shelf(q, "docked", "dock")


def _post_worktree(q: Query, text: str):
    # the card's own worktree, held on the card and not guessed from
    # a text convention. empty means the lane's standing branch,
    # which is what the bar falls back to, so a card that has never
    # been moved carries nothing and still shows a true name
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        name = q.one("name")
        if name and name not in _lane_worktrees(box.get("owner", "facilitator"))["names"]:
            return 400, {"error": "unknown worktree"}
        box["worktree"] = name
        _log("worktree", bid, name)
        _save()
        _notify()
        return 200, {"ok": True}


def _post_context(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        if len(text.split()) > 50:
            return 400, {"error": "context strip over 50 words"}
        box["context"] = text  # agent-maintained; refused over 50 words
        _save()
        _notify()
        return 200, {"ok": True}


def _omni_number(title: str) -> int | None:
    """The title is the whole v0 Omni contract; cards keep normal ids/state."""
    match = OMNI_TITLE_RE.fullmatch(title or "")
    if not match:
        return None
    number = int(match.group(1))
    return number if number <= OMNI_MAX else None


def _omni_entry(text: str) -> bool:
    """Whether a typed title asks for an Omni ticket. Its first line, cut at
    80 characters the way a stored title is, is split on white space,
    lowercased and read as a set of words, and it asks only when that set is
    exactly {omni}, {omni, card} or {omni, ticket}, or one of the last two with
    one number, written N or #N. Order and repeats do not matter, so "ticket
    omni" asks too; any other word, a second number or a bare {omni, N} does not."""
    line = _OMNI_BREAK.split(text or "")[0][:80]
    words = {w for w in _OMNI_SPACE.split(line.lower()) if w}
    if "omni" not in words:
        return False
    words.discard("omni")
    kinds = numbers = 0
    for word in words:
        match = _OMNI_NUMBER.fullmatch(word)
        if word in ("card", "ticket"):
            kinds += 1
        elif match and int(match.group(1)) <= OMNI_MAX:
            numbers += 1
        else:
            return False
    return kinds <= 1 and numbers <= (1 if kinds else 0)


def _next_omni_number(owner: str) -> int:
    """Allocate within one lane while the caller holds _lock."""
    used = [_omni_number(b.get("title", "")) for b in _state["boxes"]
            if b.get("owner", "facilitator") == owner]
    return max((number for number in used if number is not None), default=0) + 1


def _entered_title(owner: str, text: str) -> str:
    """Turn a title that asks for an Omni ticket (see _omni_entry) into the
    lane's next canonical one. A number typed with it is not honoured: the
    ticket takes the lane's highest number plus one, as every Omni ticket does."""
    title = (text or "").splitlines()[0][:80]
    if _omni_entry(title):
        return f"Omni Ticket #{_next_omni_number(owner)}"
    return title


def _create_box_record(owner: str, title: str) -> dict:
    """Install one ordinary data-contract card; callers save and notify."""
    # the card's number is made here: m plus the counter, and the pages show the
    # figure after the m (ticketNum in card-logic.js). quick notes attach by that
    # figure, so a change to the numbering has to be carried into the quick note
    # system as well: card-logic.js quickNoteRef and QUICK_NOTE_REF (the
    # "card N" / "cN" parser), quickNoteCard and quickNoteAttachStep; in this
    # file _post_quicknote_new and _post_quicknote_attach (the attach routes)
    # and _remove_empty_meta_box; parked/quick-note.js syncQuickNoteChip (the
    # note chip)
    bid_new = f"m{_state['next_bid']}"  # never reused, even after deletes
    _state["next_bid"] += 1
    # keep each meta section grouped: insert after its last same-owner meta box
    idx = max([i for i, b in enumerate(_state["boxes"])
               if b["bucket"] == "meta" and b.get("owner") == owner] or [-1]) + 1
    ws0 = (_state.get("workspaces", {}).get(owner) or [{}])[0].get("id")
    made = {
        "id": bid_new, "bucket": "meta", "title": title, "reply": "",
        "reply_full": "", "reply_short": "",
        "pending": [], "done": False, "docked": False, "parked": False, "replies": 0,
        "full_replies": 0, "reply_kind": "",
        "state": "new", "hb": 0,
        "ball": "me", "ts": time.time(), "owner": owner,
        "ws": ws0, "task": None, "agent_ts": 0, "seen": 0, "testing": False,
    }
    _state["boxes"].insert(idx, made)
    return made


def _post_title(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None or (not text and box["title"]):
            return 400, {"error": "bad box or empty title"}
        if not text:
            # naming was abandoned: hand out a whimsical name no live
            # card is already wearing
            used = {b["title"] for b in _state["boxes"]}
            free = [n for n in FAIRY_NAMES if n not in used]
            box["title"] = random.choice(free or FAIRY_NAMES)
        else:
            box["title"] = _entered_title(box.get("owner", "facilitator"), text)
        _log("title", bid, box["title"])
        _save()
        _notify()
        return 200, {"ok": True, "title": box["title"]}


def _post_create(q: Query, text: str):
    owner = q.one("owner", "facilitator")
    op = q.one("op")
    if op and not _op_id_ok(op):
        return 400, {"error": "bad operation id"}
    with _lock:
        fp = _fingerprint("create", owner, text) if op else ""
        if op:
            found, rec = _op_lookup(op, fp)
            if found == "mismatch":
                return 409, {"error": "operation id reused with a different payload"}
            if found == "same":
                made = _box(rec["result"].get("id", ""))
                return 200, {**rec["result"], "rev": _state.get("rev", 0), "replayed": True,
                             "card": _phone_box(made) if made else None}
        if owner not in OWNERS:
            return 400, {"error": "unknown owner"}
        # born nameless; a whimsical name lands only if naming is walked
        # away from (the empty-body /title call below)
        title = _entered_title(owner, text) if text else ""
        made = _create_box_record(owner, title)
        bid_new = made["id"]
        result = {"ok": True, "id": bid_new}
        if op:
            _op_commit(op, fp, "create", bid_new, result)
        # the row is queued and written by the save once the card is
        # installed, so a rolled-back save leaves none
        _log("create", bid_new, title, log_fields={"op": op} if INCIDENT_OP.fullmatch(op) else None,
             **({"op": op} if op else {}))
        _save()
        _notify()
        # the card itself rides back, so a phone can draw it from this answer
        # instead of waiting for its next reading of the board
        return 200, {**result, "rev": _state["rev"], "card": _phone_box(made)}


def _post_project(q: Query, text: str):
    # a new project lane from the page's plus tab: slug the name,
    # store {id, name, dir} so restarts keep it, give the lane its
    # per-owner slots; the tab appears with its one general-purpose Omni card
    name = q.one("name").strip()
    slug = "".join(c if c.isalnum() else "-" for c in name.lower())
    while "--" in slug:
        slug = slug.replace("--", "-")
    slug = slug.strip("-")
    if not name or not slug:
        return 400, {"error": "empty name"}
    with _lock:
        # a taken id walks numbered suffixes until free; built-in owner
        # ids (hidden internal lanes included) and stored project ids
        # both count as taken, so no folder name is ever refused for
        # colliding with a lane the page never shows
        taken = set(OWNERS) | {p["id"] for p in _state.get("projects", [])}
        if slug in taken:
            n = 2
            while f"{slug}-{n}" in taken:
                n += 1
            slug = f"{slug}-{n}"
        home = Path.home()
        try:
            d = Path(text).expanduser().resolve() if text else None
        except OSError:
            d = None
        if d is None or not d.is_dir() or (d != home and home not in d.parents):
            return 400, {"error": "body must be a folder under home"}
        _state.setdefault("projects", []).append({"id": slug, "name": name, "dir": str(d)})
        _state["busy"].setdefault(slug, None)
        _state["claimed"].setdefault(slug, [])
        _state["busy_ts"].setdefault(slug, 0.0)
        _state.setdefault("ack", {}).setdefault(slug, None)
        _state.setdefault("workspaces", {})[slug] = [{
            "id": "w1", "name": "main", "started": time.time(),
            "goal": "", "tasks": [], "current": None}]
        # the lane opens on its board page, the same one migration gives every
        # project that predates the switcher
        _state.setdefault("pages", {})[slug] = [_page_record("pg1", "board")]
        # A newly added project begins with one ordinary-contract card whose
        # canonical title gives it the Omni presentation. This happens only in
        # this creation transaction, never in migration, so restart and old
        # projects cannot gain duplicates or be backfilled.
        _create_box_record(slug, "Omni Ticket #1")
        # the folder's own name is written down, never the path to it:
        # a lane's directory is one line away from a home directory
        _log("project", slug, f"{name} -> {d}", log_fields={"folder": d.name})
        _save()
        # the lane joins the runtime owner set only once its save has landed:
        # everything the lane needs in the state was saved above, and a save
        # that failed has put the state back without it, so registering it
        # earlier would have left a lane the reads and waits index that the
        # state does not know, until a restart
        _register_owner(slug)
        _notify()
        return 200, {"ok": True, "id": slug, "name": name, "dir": str(d)}


def _post_close(q: Query, text: str):
    bid = q.one("box")
    try:
        order = _park_order_read(q)
    except ValueError:
        return 400, {"error": "bad close order"}
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "bad box"}
        if _section_order_stale(box, order):
            return 200, {"ok": False, "stale": "superseded", **_section_fields(box)}
        action = _close_box(box)
        _save()
        _notify()
        return 200, {"ok": True, "action": action}


def _post_delete(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None or box["bucket"] != "meta":
            return 400, {"error": "only meta boxes can be deleted"}
        # Compatibility for already-open pages and other old clients:
        # the current persisted record decides, never their stale copy.
        action = _close_box(box)
        _save()
        _notify()
        return 200, {"ok": True, "action": action}


def _post_ws_goal(q: Query, text: str):
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        w = _ws(ow, q.one("ws"))
        if w is None:
            return 400, {"error": "unknown workspace"}
        w["goal"] = text
        _log("goal", w["id"], text)
        _save()
        return 200, {"ok": True}


def _post_ws_task(q: Query, text: str):
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        w = _ws(ow, q.one("ws"))
        if w is None:
            return 400, {"error": "unknown workspace"}
        tid = q.one("id")
        status = q.one("status")
        if not tid:  # create; body names it
            tid = f"t{_state['next_tid']}"
            _state["next_tid"] += 1
            w["tasks"].append({"id": tid, "text": text, "status": "pending"})
            _log("task+", tid, text)
        else:
            t = next((t for t in w["tasks"] if t["id"] == tid), None)
            if t is None:
                return 400, {"error": "unknown task"}
            if q.one("del") == "1":
                w["tasks"].remove(t)
                for b in _state["boxes"]:
                    if b.get("task") == tid:
                        b["task"] = None
                _log("task-", tid, t["text"])
            else:
                if status in ("pending", "ongoing", "done"):
                    t["status"] = status
                if text:
                    t["text"] = text
                _log("task", tid, f"{t['status']} {t['text']}")
        _save()
        return 200, {"ok": True, "id": tid}


def _post_ws_current(q: Query, text: str):
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        w = _ws(ow, q.one("ws"))
        if w is None:
            return 400, {"error": "unknown workspace"}
        tid = q.one("id") or None
        w["current"] = tid
        _log("current", tid or "", "")
        _save()
        return 200, {"ok": True}


def _post_pages_new(q: Query, text: str):
    # one more environment for this project, blank: the switcher at the foot of
    # the workspace shows it as a new dot and opens it. No card, no chat and no
    # workspace is touched, here or anywhere this route leads
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        pages = _pages(ow)
        if len(pages) >= PAGE_LIMIT:
            return 400, {"error": "too many pages"}
        pid = f"pg{_state['next_pgid']}"
        _state["next_pgid"] += 1
        pages.append(_page_record(pid, "blank"))
        # the page has no words of its own, so the id and the lane are the whole
        # event and there is nothing in it to keep out of the file
        _log("page+", pid, "", log_fields={"owner": ow}, owner=ow)
        _save()
        _notify()
        return 200, {"ok": True, "id": pid, "pages": pages, "rev": _state["rev"]}


def _post_pages_del(q: Query, text: str):
    # any page may go, the board page included. What goes is the view record and
    # only that: the project's cards, their conversations, its internal
    # workspaces and their tasks are all somewhere else and stay exactly as they
    # were. A project left with no pages keeps an empty list, so nothing here
    # hands it a new page on the next reading
    ow = q.one("owner")
    if ow not in OWNERS:
        return 400, {"error": "unknown owner"}
    with _lock:
        pages = _pages(ow)
        pid = q.one("id")
        page = next((p for p in pages if isinstance(p, dict) and p.get("id") == pid), None)
        if page is None:
            return 400, {"error": "unknown page"}
        pages.remove(page)
        _log("page-", pid, "", log_fields={"owner": ow}, owner=ow)
        _save()
        _notify()
        return 200, {"ok": True, "pages": pages, "rev": _state["rev"]}


def _post_assign(q: Query, text: str):
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "unknown box"}
        box["task"] = q.one("task") or None
        _log("assign", bid, box["task"] or "none")
        _save()
        return 200, {"ok": True}


def _post_progress(q: Query, text: str):  # interim note during a build: keeps
    bid = q.one("box")                     # the claim (card stays green) and
    with _lock:                            # heartbeats
        box = _box(bid)
        ow = box.get("owner", "facilitator") if box else None
        if box is None or _state["busy"].get(ow) != bid:
            return 400, {"error": "not holding this box"}
        _set_reply_variants(box, text)
        box["reply_kind"] = "progress"   # interim words, not a page of the history
        box["ts"] = time.time()
        _state["busy_ts"][ow] = time.time()   # resets the 15-min steal
        # the agent has written back about everything its claim holds so far, so
        # those messages are read (_pending_states). a message /fresh folds in
        # after this is delivered and not read until the next note. the record
        # belongs to this claim and goes with it
        rec = _state.get("ack", {}).get(ow)
        if rec and rec.get("box") == bid:
            rec["read"] = list(_state["claimed"][ow])
        _log("progress", bid, text, reply_full=text, reply_short=text,
             reply_variants_version=REPLY_VARIANTS_VERSION)
        _save()
        _notify()
        return 200, {"ok": True}


def _post_dismiss(q: Query, text: str):  # drop a box's queued messages, unanswered
    bid = q.one("box")
    with _lock:
        box = _box(bid)
        if box is None:
            return 400, {"error": "unknown box"}
        n = len(box["pending"])
        box["pending"] = []
        if bid in _state["inbox"]:
            _state["inbox"].remove(bid)
        ow = box.get("owner", "facilitator")
        if _state["busy"].get(ow) == bid:
            _state["busy"][ow] = None
            _state["claimed"][ow] = []
        # a beating flag keeps its green through a dismissal; anything
        # else lands where the card rests, an unanswered reply beneath
        # the dropped queue showing again
        if not _hb_live(box):
            _handover(box)
            box["state"] = _rest(box)
        _log("dismiss", bid, f"{n} queued dropped")
        _save()
        _notify()
        return 200, {"ok": True, "dropped": n}


def _post_push_subscribe(q: Query, text: str):
    # the phone's push subscription, kept whole so a push can be
    # addressed to it; one record per endpoint, the newest wins
    try:
        sub = json.loads(text) if text else None
    except ValueError:
        sub = None
    endpoint = sub.get("endpoint") if isinstance(sub, dict) else None
    if (not isinstance(endpoint, str) or len(endpoint) > 2048
            or not endpoint.startswith(("https://", "http://"))):
        return 400, {"error": "bad subscription"}
    keys = sub.get("keys") if isinstance(sub.get("keys"), dict) else {}
    rec = {"endpoint": endpoint,
           "keys": {k: str(v) for k, v in keys.items() if k in ("p256dh", "auth")},
           "ts": time.time()}
    rec["session"] = _BRIDGE_AUTH.current_session_digest() if _BRIDGE_AUTH else ""
    with _lock:
        held = _state.get("push_subs", [])
        subs = [s for s in held if s.get("endpoint") != endpoint]
        replaced = len(subs) != len(held)
        subs.append(rec)
        _state["push_subs"] = subs
        _save()
        # whether this is a new link or the same one posted again, never the
        # endpoint or the keys; session says whether a live sign-in was named
        _info("pushsub", action="replaced" if replaced else "new", rec=_push_rec(endpoint),
              session=bool(rec["session"]), count=len(subs))
        return 200, {"ok": True, "count": len(subs)}


def _post_push_unsubscribe(q: Query, text: str):
    try:
        body = json.loads(text)
        endpoint = body.get("endpoint")
    except (ValueError, AttributeError):
        endpoint = None
    if not isinstance(endpoint, str) or len(endpoint) > 2048:
        return 400, {"error": "bad subscription"}
    with _lock:
        held = _state.get("push_subs", [])
        subs = [s for s in held if s.get("endpoint") != endpoint]
        _state["push_subs"] = subs
        _save()
        _info("pushunsub", rec=_push_rec(endpoint), removed=len(subs) != len(held), count=len(subs))
        return 200, {"ok": True}


def _post_tabs(q: Query, text: str):
    # the tab bar's whole record in one write, so a reorder can
    # never half land: the lane order and the lanes that are closed
    # arrive together and replace what was stored
    try:
        rec = json.loads(text) if text else None
    except ValueError:
        rec = None
    if (not isinstance(rec, dict) or not isinstance(rec.get("order"), list)
            or not isinstance(rec.get("closed"), list)):
        return 400, {"error": "bad tab record"}
    with _lock:
        # every id is checked before anything is stored, so a record
        # naming a lane this board does not have changes nothing
        clean = {}
        for field in ("order", "closed"):
            ids = []
            for ow in rec[field]:
                if not isinstance(ow, str) or ow not in OWNERS:
                    return 400, {"error": "unknown owner"}
                if ow not in ids:   # a repeat is the same tab twice; keep the first
                    ids.append(ow)
            clean[field] = ids
        stored = _state.get("tabs") or {}
        for field in ("order", "closed"):
            _overwrite("tabs", "", field, stored.get(field), clean[field])
        _state["tabs"] = clean
        _save()
        _notify()
        return 200, {"ok": True, "tabs": clean}


def _post_seen(q: Query, text: str):
    # the read marks: for each card named, how many of its replies
    # have been read. One record per card on the board itself, so the
    # phone and the board can never disagree about what is unread
    try:
        rec = json.loads(text) if text else None
    except ValueError:
        rec = None
    if not isinstance(rec, dict) or not rec:
        return 400, {"error": "bad seen record"}
    with _lock:
        marks = []
        for bid_, n in rec.items():
            box = _box(bid_)
            if box is None:
                return 400, {"error": "bad box"}
            # a bool is an int in this language and is not a count
            if isinstance(n, bool) or not isinstance(n, int) or n < 0:
                return 400, {"error": "bad count"}
            marks.append((box, n))
        out = {}
        for box, n in marks:
            _overwrite("seen", box["id"], "count", box.get("seen", 0), n)
            box["seen"] = n
            out[box["id"]] = n
        _save()
        _notify()
        return 200, {"ok": True, "seen": out}


# ---- the board's settings ---------------------------------------------------------
# What the reader arranges on the desktop pages: where each box sits and how
# big it is, which boxes are put away, the background colour, the outline's
# width, formatting while typing, the home chart, the typed page's tasks, and
# the one-time layout passes that go with them. They lived in each browser's
# own storage, filed under the board's address, so the board opened at another
# address (a port it moved to) started from nothing. Now they are the board's,
# kept under the browsers' own key names and text values so the pages read
# them exactly as before. In a file of their own and not in state.json: every
# state.json save moves the board's revision, and a box dragged on the desktop
# must not send every phone the board again.
#
# The Spotify sign-in is kept in the same file, under "spotify", and never
# travels on these routes: /spotify/session alone answers it, to a local page.
SETTINGS_PATH = HERE / "settings.json"
SETTINGS_VALUE_MAX = 65536      # characters in one value; a box's place is a few dozen
SETTINGS_KEYS_MAX = 4000        # keys in the whole store
# the keys a page may keep here, the same list as SETTINGS_KEY in
# board-settings.js. A lane is any printable text (a lane id keeps the letters
# of its folder's name), a box is one of the page's element ids
SETTINGS_KEY = re.compile(
    r"(?:(?:layoutbak\.)?(?:pos|size)|hide|show)\.[^\x00-\x1f\x7f]{1,200}\.[A-Za-z0-9_-]{1,64}"
    r"|doc\.tasks\.[^\x00-\x1f\x7f]{1,200}"
    r"|bgcolor|tocw|composeformat|chimemuted|usagecounts|home\.chart"
    r"|magicrename\.1|layoutsync\.1|hideseed\.1|layoutvisibility\.[12]|navrestore\.1")
SPOTIFY_FIELDS = frozenset({"access", "refresh", "expires", "scopes"})
SPOTIFY_VALUE_MAX = 4096
_settings_lock = threading.Lock()
_settings: dict | None = None   # the file as last written, read the first time it is asked for


def _settings_file() -> dict:
    """The settings as kept: {rev, values, spotify}. Callers hold
    _settings_lock. A file that cannot be read as settings is moved aside
    under a dated name rather than written over, and the board starts with
    none beside it."""
    global _settings
    if _settings is not None:
        return _settings
    try:
        raw = json.loads(SETTINGS_PATH.read_text())
        values = raw.get("values", {})
        spotify = raw.get("spotify", {})
        if not isinstance(values, dict) or not isinstance(spotify, dict):
            raise ValueError("not a settings file")
        _settings = {"rev": int(raw.get("rev", 0)),
                     "values": {k: v for k, v in values.items() if isinstance(k, str) and isinstance(v, str)},
                     "spotify": {k: v for k, v in spotify.items() if k in SPOTIFY_FIELDS and isinstance(v, str)}}
    except FileNotFoundError:
        _settings = {"rev": 0, "values": {}, "spotify": {}}
    except (OSError, ValueError, TypeError, AttributeError) as e:
        kept = SETTINGS_PATH.with_name(f"settings.json.bad-{time.strftime('%Y%m%dT%H%M%S')}")
        try:
            SETTINGS_PATH.replace(kept)
            _error("settingsbad", kept=kept.name, error=type(e).__name__)
        except OSError as moved:
            _error("settingsbad", error=type(e).__name__, reason=moved.strerror or type(moved).__name__)
        _settings = {"rev": 0, "values": {}, "spotify": {}}
    return _settings


def _settings_rev() -> int:
    with _settings_lock:
        return _settings_file()["rev"]


def _save_settings(store: dict) -> None:
    """settings.json the way state.json is written: a temp file beside it,
    flushed to the disk, then one rename. Owner-only, since it holds the
    Spotify sign-in. The caller installs the new store in memory only after
    this returns, so a save that fails leaves memory as the file still is."""
    global _settings
    payload = json.dumps(store, indent=1)
    tmp = SETTINGS_PATH.with_name("settings.json.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(payload)
            f.flush()
            _durable_fsync(f.fileno())
        os.replace(tmp, SETTINGS_PATH)
    except OSError as e:
        tmp.unlink(missing_ok=True)
        _error("savefail", step="settings", reason=e.strerror or type(e).__name__)
        raise SaveFailed("settings") from e
    _settings = store


def _settings_answer(store: dict) -> dict:
    """What a page is told of the settings: never the Spotify sign-in."""
    return {"rev": store["rev"], "values": dict(store["values"])}


def _get_settings(q: Query, _):
    with _settings_lock:
        return 200, _settings_answer(_settings_file())


def _get_board_settings_js(q: Query, _):
    # the store's file with the board's settings written in front of it on the
    # same line, the way /compose-format.js carries its default: every value is
    # there before a page's first line runs, so nothing is drawn twice, and the
    # file's line numbers stay the file's own
    p = HERE / "board-settings.js"
    if not p.is_file():
        return 404, {"error": "not found"}
    with _settings_lock:
        lead = "globalThis.BOARD_SETTINGS=" + json.dumps(_settings_answer(_settings_file())) + ";"
    if BACKGROUND_DEFAULT:
        lead += "globalThis.BOARD_BGCOLOR_DEFAULT=" + json.dumps(BACKGROUND_DEFAULT) + ";"
    return 200, lead.encode() + p.read_bytes(), "application/javascript; charset=utf-8"


def _post_settings(q: Query, text: str):
    # set or remove the named keys and keep every other one: two windows
    # arranging different boxes both keep theirs, and of two writes to the
    # same key the one that lands last stands, as it did in a browser
    try:
        changes = json.loads(text) if text else None
    except ValueError:
        changes = None
    if not isinstance(changes, dict) or not changes:
        return 400, {"error": "bad settings"}
    # every key and value is checked before anything is kept
    for key, value in changes.items():
        if not SETTINGS_KEY.fullmatch(key):
            return 400, {"error": "unknown setting"}
        if value is not None and (not isinstance(value, str) or len(value) > SETTINGS_VALUE_MAX):
            return 400, {"error": "bad setting value"}
    seed = q.one("seed") == "1"
    with _settings_lock:
        store = _settings_file()
        if seed and store["values"]:
            # a browser's one-time copy lands only on an empty store: the
            # first browser to load this code keeps its arrangement, and any
            # later one takes the board's
            return 200, {"ok": True, "seeded": False, **_settings_answer(store)}
        values = dict(store["values"])
        for key, value in changes.items():
            if value is None:
                values.pop(key, None)
            else:
                values[key] = value
        if len(values) > SETTINGS_KEYS_MAX:
            return 400, {"error": "too many settings"}
        new = {**store, "rev": store["rev"] + 1, "values": values}
        _save_settings(new)
        return 200, {"ok": True, **({"seeded": True} if seed else {}), **_settings_answer(new)}


def _get_spotify_session(q: Query, _):
    if not q.local:
        return 404, {"error": "not found"}
    with _settings_lock:
        return 200, dict(_settings_file()["spotify"])


def _post_spotify_session(q: Query, text: str):
    if not q.local:
        return 404, {"error": "not found"}
    if not q.same_origin:
        return 403, {"error": "origin refused"}
    try:
        rec = json.loads(text) if text else None
    except ValueError:
        rec = None
    if not isinstance(rec, dict) or any(
            key not in SPOTIFY_FIELDS or not isinstance(value, str) or len(value) > SPOTIFY_VALUE_MAX
            for key, value in rec.items()):
        return 400, {"error": "bad sign-in"}
    with _settings_lock:
        store = _settings_file()
        if q.one("seed") == "1" and store["spotify"]:
            return 200, {"ok": True, "seeded": False, **store["spotify"]}
        _save_settings({**store, "spotify": rec})
        return 200, {"ok": True, **rec}


# ---- the daily usage counts -------------------------------------------------------
# Once a day the board sends one small message of counts about the day before
# to the Facilitator project in PostHog: usage_counts.py says what, and the
# README's "Usage counts" lists every field. It runs on a thread of its own,
# never on a request. The switch is one of the board's settings, usagecounts,
# on unless it says "0", so the Mac's settings page and the phone's drawer both
# turn it off. usage-counts.json holds only the last day already dealt with.
# usage_counts.py is imported only here, so a copy of the board without it, as
# the tests' fixtures make, sends nothing at all.
USAGE_MARKER = HERE / "usage-counts.json"
USAGE_SETTING = "usagecounts"


def _usage_sharing() -> bool:
    with _settings_lock:
        return _settings_file()["values"].get(USAGE_SETTING) != "0"


def _start_usage_counts() -> None:
    try:
        import usage_counts
    except ImportError:
        return
    sender = usage_counts.Sender(transcript=TRANSCRIPT_PATH, log_dir=LOG_DIR, marker=USAGE_MARKER,
                                 index_html=HERE / "index.html", sharing=_usage_sharing, log=_info)
    threading.Thread(target=sender.run, args=(_STOPPING,), name="usage-counts", daemon=True).start()


# hidden in v0: False refuses the quick note routes, drops quicknotes from /state, leaves stored notes alone
QUICK_NOTES_ON = False

# ---- quick notes ------------------------------------------------------------------
# a few lines the owner jots down without leaving what they are doing: plain
# text, standing alone unless it names a card, and then attached to that card.
# one record per note in state.json under quicknotes, oldest first:
#   id       qn1, qn2...: never reused, like the box and page counters
#   text     the whole note as typed, unstripped, since its own blank lines and
#            indents are part of it the way they are part of a file
#   created  when it was first saved
#   updated  when its text or its card last changed
#   card     the id of the card it is attached to, or None while it stands alone
# a note attached to a card is the record that card's scratchpad is meant to
# grow from: the scratchpad is the card's newest attached note, found through
# the card field and drawn beside the card, and whoever keeps it current, the
# owner or later an agent, writes it through the same save route.
# the text is never written anywhere but state.json: no transcript row and no
# log line carries it, only the note's id, its card and its length. and no
# note route wakes the agents' long polls, since nothing they wait on is a note
# and an autosave would otherwise wake every one of them as the owner types
def _quicknote(nid: str) -> dict | None:
    return next((n for n in _state.get("quicknotes", []) if n.get("id") == nid), None)


def _quicknote_meta(note: dict) -> dict:
    """what /state carries of one note: never its text"""
    return {"id": note["id"], "card": note.get("card"),
            "created": note.get("created", 0), "updated": note.get("updated", 0)}


def _quicknote_text(raw: bytes) -> str:
    # kept as typed, where every other text route strips its body
    return raw.decode("utf-8", "replace")


def _get_quicknotes(q: Query, _):
    with _lock:
        return 200, *_snapshot({"notes": _state.get("quicknotes", []), "rev": _state.get("rev", 0)})


def _post_quicknote_new(q: Query, raw: bytes):
    text = _quicknote_text(raw)
    card = q.one("card") or None
    with _lock:
        if card is not None and _box(card) is None:
            return 400, {"error": "unknown card"}
        nid = f"qn{_state['next_qnid']}"
        _state["next_qnid"] += 1
        now = time.time()
        note = {"id": nid, "text": text, "created": now, "updated": now, "card": card}
        _state["quicknotes"].append(note)
        _save()
        # written once the save has landed, so a note the board could not keep
        # is never said to exist
        _info("quicknote+", card or "", note=nid, length=len(text))
        return 200, {"ok": True, "note": note, "rev": _state["rev"]}


def _post_quicknote_save(q: Query, raw: bytes):
    text = _quicknote_text(raw)
    with _lock:
        note = _quicknote(q.one("id"))
        if note is None:
            return 400, {"error": "unknown note"}
        if note["text"] != text:
            note["text"] = text
            note["updated"] = time.time()
            _save()
            # an autosave lands every pause in the typing, which is noise at the
            # default level and worth seeing only while hunting
            _debug("quicknote", note.get("card") or "", note=note["id"], length=len(text))
        return 200, {"ok": True, "note": note, "rev": _state["rev"]}


def _post_quicknote_attach(q: Query, text: str):
    card = q.one("card") or None
    with _lock:
        note = _quicknote(q.one("id"))
        if note is None:
            return 400, {"error": "unknown note"}
        if card is not None and _box(card) is None:
            return 400, {"error": "unknown card"}
        was = note.get("card")
        if was != card:
            note["card"] = card
            note["updated"] = time.time()
            _save()
            _info("quicknote@", card or was or "", note=note["id"], attached=card is not None)
        return 200, {"ok": True, "note": note, "rev": _state["rev"]}


def _post_quicknote_del(q: Query, text: str):
    with _lock:
        note = _quicknote(q.one("id"))
        if note is None:
            return 400, {"error": "unknown note"}
        _state["quicknotes"].remove(note)
        _save()
        _info("quicknote-", note.get("card") or "", note=note["id"])
        return 200, {"ok": True, "id": note["id"], "rev": _state["rev"]}


# ---- the transport --------------------------------------------------------------
# One process, one worker, one owner of the board's state: uvicorn accepts the
# connections and speaks HTTP, a small Starlette application routes them, and
# every answer is made in a worker thread and sent from the event loop after
# the lock is let go. The pieces below are the whole of the transport: how a
# request is read and bounded, how an answer is written down and sent, how
# long a peer may sit on the line, and what the board does when too many ask
# at once. Nothing here decides what the board says; that is the routes above.

class _TooLarge(Exception):
    """A body past the route's cap, caught before the bytes are kept."""


def _query(scope: dict) -> Query:
    raw = scope.get("query_string", b"").decode("latin-1")
    q = Query(parse_qs(raw))
    q.raw = raw
    q.path = scope.get("path", "")
    q.accept_encoding = next((v.decode("latin-1") for k, v in scope.get("headers") or ()
                              if k == b"accept-encoding"), "")
    q.local, q.same_origin = _local_request(scope)
    return q


LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})


def _local_request(scope: dict) -> tuple[bool, bool]:
    """(local, same origin) for one request. Local means a page on this Mac
    asked the board's own port straight: not the phone's socket, not through
    Tailscale Serve (which adds X-Forwarded-For), with a loopback Host (a name
    some other site points at this machine is not one), and not a fetch
    another site set off. Same origin means it also names its own loopback
    address as its Origin, which a page writing anything has to. The phone's
    socket answers nobody here, however signed in: the bridge gate refuses
    these routes before they are reached, and this is the second wall."""
    server = scope.get("server") or (None, None)
    headers = {k.lower(): v for k, v in scope.get("headers") or ()}
    if server[1] != PORT or b"x-forwarded-for" in headers or b"tailscale-headers-info" in headers:
        return False, False
    if headers.get(b"sec-fetch-site", b"").strip().lower() == b"cross-site":
        return False, False
    host = headers.get(b"host", b"").decode("latin-1").strip().lower()
    try:
        name, port = urlparse("//" + host).hostname, urlparse("//" + host).port
    except ValueError:
        return False, False
    if name not in LOOPBACK_HOSTS or port not in (None, PORT):
        return False, False
    origin = headers.get(b"origin", b"").decode("latin-1").strip().lower()
    return True, origin == "http://" + host


def _answer(status: int, payload, ctype: str | None = None, *,
            route: str = "", box: str = "", close: bool = False,
            retry_after: int | None = None) -> Response:
    """The one door every answer leaves through. A dict is JSON; bytes carry
    the type they were handed with. A refusal is written down here, once, so
    one added a year from now is written down without anybody remembering to
    write it down: it is the server working correctly and saying no, so it is
    INFO and not an error, and the reason is the sentence the caller already
    wrote for the page."""
    if isinstance(payload, (dict, list)):
        body = json.dumps(payload).encode()
        ctype = "application/json"
    else:
        body = payload
    if status >= 400:
        _info("refusal", box, route=route, code=status,
              reason=payload.get("error") if isinstance(payload, dict) else None)
    headers = {"Cache-Control": "no-store"}
    if close:
        headers["Connection"] = "close"
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return Response(body, status_code=status, media_type=ctype, headers=headers)


async def _read_body(request: Request, cap: int) -> bytes:
    """The body, whole, or nothing: a body past the cap is refused before its
    bytes are kept, and one that stops arriving is given BODY_READ_TIMEOUT and
    no longer, so a peer that opens a request and goes quiet holds nothing."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > cap:
        raise _TooLarge()
    chunks: list[bytes] = []
    size = 0
    async with asyncio.timeout(BODY_READ_TIMEOUT):
        async for chunk in request.stream():
            size += len(chunk)
            if size > cap:
                raise _TooLarge()
            chunks.append(chunk)
    return b"".join(chunks)


def _run_state_request(fn, *args):
    """Run one state-touching request as one held-lock transaction.

    The route functions keep their own lock blocks, which are reentrant. This
    outer hold exists for the failure edge: if an unexpected exception escapes
    after a route changed memory or queued a transcript row but before its save,
    restore the latest installed snapshot before another worker can enter and
    commit the abandoned work. If a rename already succeeded, `_last_durable`
    already names that new snapshot, so cleanup never rolls an installed commit
    back. No response or unrelated file route passes through this hold."""
    with _lock:
        try:
            return fn(*args)
        except Exception:
            _restore_last_durable()
            raise


def _endpoint(fn, body: str = "none", cap: int = MAX_TEXT_BODY,
              too_large: str = "body too large", stateful: bool = False):
    """One route: read the request on the loop, do its work in a thread,
    answer from the loop. body is none for a GET, text for the plain text
    bodies most POSTs carry (utf-8, replacement characters for anything else,
    stripped, as always) and raw for the routes whose bytes are the content."""
    async def endpoint(request: Request) -> Response:
        q = _query(request.scope)
        route, box = q.path, q.one("box")
        payload = None
        if body != "none":
            try:
                raw = await _read_body(request, cap)
            except _TooLarge:
                return _answer(413, {"error": too_large}, route=route, box=box, close=True)
            except TimeoutError:
                return _answer(408, {"error": "the request body did not arrive in time"},
                               route=route, box=box, close=True)
            except ClientDisconnect:
                # the peer left mid-body: routine, never a crash, and there is
                # nobody to answer; the empty answer below goes nowhere
                _debug("hungup", box, route=route)
                return Response(status_code=400)
            payload = raw if body == "raw" else raw.decode("utf-8", "replace").strip()
        try:
            if stateful:
                outcome = await run_in_threadpool(_run_state_request, fn, q, payload)
            else:
                outcome = await run_in_threadpool(fn, q, payload)
        except SaveFailed:
            # The failed save already restored the board to its installed
            # snapshot. This answer is the difference between a page that can
            # say something went wrong and one that hangs on a socket.
            return _answer(500, {"error": "the board could not save its state"}, route=route, box=box)
        if isinstance(outcome, Response):
            return outcome
        return _answer(*outcome, route=route, box=box)
    return endpoint


def _post_open_in_browser(q: Query, text: str):
    """Only an explicit action from the local page may open a Mac window."""
    if not q.local or not q.same_origin:
        return 403, {"error": "Open in browser needs the local Mac page."}
    try:
        url = urlparse(text)
        valid = (url.scheme in ("http", "https") and url.hostname and
                 not url.username and not url.password and
                 not re.search(r"[\x00-\x20\x7f\\]", text))
        url.port  # reject malformed ports too
    except ValueError:
        valid = False
    if not valid:
        return 400, {"error": "This link is not a web address."}
    if sys.platform != "darwin":
        return 501, {"error": "Open in browser needs macOS. Try Copy link."}
    try:
        # A fresh Chrome invocation forwards --new-window to the running
        # browser. No --app flag: this requests a normal window outside the app.
        result = subprocess.run(["/usr/bin/open", "-na", "Google Chrome", "--args",
                                 "--new-window", text], capture_output=True, timeout=10)
        if result.returncode:
            return 502, {"error": "Could not open Chrome. Try Copy link."}
    except (OSError, subprocess.TimeoutExpired):
        return 502, {"error": "Could not open Chrome. Try Copy link."}
    return 200, {"ok": True}


def _state_endpoint(fn, body: str = "none", cap: int = MAX_TEXT_BODY,
                    too_large: str = "body too large"):
    """An endpoint whose route may change the board or its lazy clocks."""
    return _endpoint(fn, body, cap, too_large, stateful=True)


# -- the attachment upload ---------------------------------------------------------
# The one body that is not read whole into memory: up to MAX_UPLOAD_BODY of it
# goes straight to a hidden part file beside the uploads, created for the owner
# alone, and is linked into place under its kept name only once all of it has
# come and its first bytes are the kind its name says. Every way out before
# that removes the part, so a cut, a refusal or a stop leaves nothing that could
# be served. The receipts below are what make a retry safe: the phone names
# each upload with an operation id, and the same id asked again is answered with
# the file already stored rather than a second copy.

UPLOAD_WRITE = 1024 * 1024      # bytes gathered before each write to the part file


class _UploadRefused(Exception):
    def __init__(self, status: int, words: str) -> None:
        super().__init__(words)
        self.status, self.words = status, words


async def _upload_to_part(request: Request, part: Path, got: dict) -> bytes:
    """The body into the part file, counted into got["bytes"] as it comes;
    answers the first UPLOAD_HEAD bytes. One clock is moved on with every
    chunk that arrives, to the silence limit or the whole upload's end,
    whichever is sooner."""
    loop = asyncio.get_running_loop()
    ends = loop.time() + UPLOAD_TIME_LIMIT
    head, gathered = bytearray(), bytearray()
    fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as target:
        try:
            async with asyncio.timeout(min(UPLOAD_STALL_TIMEOUT, UPLOAD_TIME_LIMIT)) as clock:
                async for chunk in request.stream():
                    clock.reschedule(min(loop.time() + UPLOAD_STALL_TIMEOUT, ends))
                    got["bytes"] += len(chunk)
                    if got["bytes"] > MAX_UPLOAD_BODY:
                        raise _UploadRefused(413, UPLOAD_WORDS["large"])
                    if len(head) < UPLOAD_HEAD:
                        head += chunk[:UPLOAD_HEAD - len(head)]
                    gathered += chunk
                    if len(gathered) >= UPLOAD_WRITE:
                        await run_in_threadpool(target.write, bytes(gathered))
                        gathered.clear()
        except TimeoutError:
            raise _UploadRefused(408, UPLOAD_WORDS["late" if loop.time() >= ends - 1 else "stalled"])
        if gathered:
            await run_in_threadpool(target.write, bytes(gathered))
    return bytes(head)


async def _post_upload(request: Request) -> Response:
    q = _query(request.scope)
    route = q.path
    safe = _upload_name(q.one("name", "file"))
    ext = Path(safe).suffix.lower()
    # what can be refused before a byte of the body is asked for is refused
    # first, and the connection is closed with its unread bytes
    if ext not in UPLOAD_TYPES:
        return _answer(415, {"error": UPLOAD_WORDS["type"]}, route=route, close=True)
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_UPLOAD_BODY:
        return _answer(413, {"error": UPLOAD_WORDS["large"]}, route=route, close=True)
    op = q.one("op")
    if op and not INCIDENT_OP.fullmatch(op):
        return _answer(400, {"error": UPLOAD_WORDS["op"]}, route=route, close=True)
    if op and op in _uploads_arriving:
        return _answer(409, {"error": UPLOAD_WORDS["arriving"]}, route=route, close=True)
    kept = _upload_receipts.get(op) if op else None
    if kept is not None and kept["name"] != safe:
        return _answer(409, {"error": UPLOAD_WORDS["other"]}, route=route, close=True)
    INTERNAL_UPLOADS.mkdir(parents=True, exist_ok=True)
    stamp = time.time_ns()
    part = INTERNAL_UPLOADS / f".{stamp}-{secrets.token_hex(4)}.part"
    started = time.monotonic()
    got = {"bytes": 0}
    if op:
        _uploads_arriving.add(op)
    try:
        head = await _upload_to_part(request, part, got)
        size = got["bytes"]
        if kept is not None:
            # the retry of an upload already stored: its bytes are let go and
            # the answer is the one its first try was given
            return _answer(200, {"url": kept["url"], "replayed": True}, route=route)
        if not size:
            raise _UploadRefused(400, UPLOAD_WORDS["empty"])
        wrong = _upload_kind_error(ext, head)
        if wrong:
            raise _UploadRefused(415, wrong)
        if ext == ".svg" and await run_in_threadpool(_svg_carries_script, part):
            raise _UploadRefused(415, UPLOAD_WORDS["script"])
        # the kept name is taken with an exclusive create, so two uploads
        # stamped alike stay two files, and the part is then renamed over it
        # in one step, so no reader ever sees half a file under that name
        for bump in range(8):
            fname = f"{stamp + bump}-{safe}"
            try:
                os.close(os.open(INTERNAL_UPLOADS / fname, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
                break
            except FileExistsError:
                continue
        else:
            raise _UploadRefused(409, "Another upload took that name; try again.")
        try:
            os.replace(part, INTERNAL_UPLOADS / fname)
        except OSError:
            (INTERNAL_UPLOADS / fname).unlink(missing_ok=True)
            raise
        url = "/uploads/" + quote(fname)
        if op:
            _upload_receipts[op] = {"url": url, "name": safe, "size": size}
            while len(_upload_receipts) > UPLOAD_RECEIPTS:
                del _upload_receipts[next(iter(_upload_receipts))]
        _info("upload", route=route, bytes=size, ms=round((time.monotonic() - started) * 1000))
        return _answer(200, {"url": url}, route=route)
    except _UploadRefused as refused:
        return _answer(refused.status, {"error": refused.words}, route=route, close=True)
    except ClientDisconnect:
        # the phone went: out of signal, asleep, or its own clock ran out. Not
        # an error, but the one line a failed phone upload leaves behind, so it
        # says how far the upload got
        _info("uploadcut", route=route, bytes=got["bytes"], ms=round((time.monotonic() - started) * 1000))
        return Response(status_code=400)
    finally:
        if op:
            _uploads_arriving.discard(op)
        part.unlink(missing_ok=True)


async def _get_upload_receipt(request: Request) -> Response:
    """Whether an upload under this operation id is stored, still coming in,
    or unknown to this server run. On the loop, like the upload itself, so the
    two never read the receipts from different threads."""
    q = _query(request.scope)
    op = q.one("op")
    if not INCIDENT_OP.fullmatch(op):
        return _answer(400, {"error": UPLOAD_WORDS["op"]}, route=q.path)
    if op in _uploads_arriving:
        return _answer(200, {"arriving": True}, route=q.path)
    kept = _upload_receipts.get(op)
    if kept is None:
        return _plain(404, {"error": "no upload under that id"})
    return _answer(200, {"url": kept["url"], "size": kept["size"]}, route=q.path)


# -- the agent's long poll ----------------------------------------------------------
# The one route that waits. It waits on the loop, woken by every change to the
# board (_notify) and by the peer hanging up, and it sends its own answer so a
# hand-off can be undone when the listener is known to be gone. Two cases are
# covered for certain. A disconnect the loop has already seen sets the gone
# event, and the claim is rolled back before any bytes are sent (the claim
# suite proves this). A hand-off whose write itself fails is rolled back too,
# on the rare transport that reports the failure. What this cannot see is a
# disconnect that lands only after the bytes are handed over: with the pinned
# uvicorn a completed send never reports back, so that case is not caught here
# and instead rides the 90 second ack lease, which is exactly what the lease is
# for. Bytes handed to the network are not bytes read by the agent, and the ack
# is what finally confirms a delivery; the lease is the honest guarantee, and
# the mid-handoff rollback is a best effort on top of it, never a replacement.

async def _watch_disconnect(receive, gone: asyncio.Event) -> None:
    """Reads the request channel until the peer goes away. Started before the
    claim is attempted and stopped before the answer is sent, since once a
    response is complete the channel reports a disconnect that is not one."""
    try:
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                gone.set()
                return
    except asyncio.CancelledError:
        raise
    except Exception:
        gone.set()


async def _changed(seen: int, timeout: float, gone: asyncio.Event) -> None:
    """Sleeps until the board changes, the peer leaves, or the time runs out,
    whichever is first. A change that landed between the caller's reading of
    the version and this call counts, so no wakeup can be lost."""
    if _change_version != seen or gone.is_set():
        return
    ev = asyncio.Event()
    _wakers.add(ev)
    try:
        if _change_version != seen:
            return
        waits = [asyncio.ensure_future(ev.wait()), asyncio.ensure_future(gone.wait())]
        try:
            await asyncio.wait(waits, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for w in waits:
                w.cancel()
    finally:
        _wakers.discard(ev)


async def _send_response(response: Response, scope, receive, send) -> bool:
    """True when every byte was handed to the network without the peer having
    gone; False when the send could not complete."""
    try:
        await response(scope, receive, send)
    except Exception:
        return False
    return True


class WaitRoute:
    async def __call__(self, scope, receive, send) -> None:
        global _waits_open
        q = _query(scope)
        route = q.path
        try:
            timeout = float(q.one("timeout", "570"))
        except ValueError:
            await _answer(400, {"error": "bad timeout"}, route=route)(scope, receive, send)
            return
        owner = q.one("owner", "facilitator")  # default: the tool's own lane
        if owner not in OWNERS:
            await _answer(400, {"error": "unknown owner"}, route=route)(scope, receive, send)
            return
        # every claim is confirmed delivery, so there is no flag to read; an
        # ack=1 riding along in the query is accepted and ignored, never
        # refused, so a loop that carries the flag keeps working
        agent = q.one("agent") or None
        if _waits_open >= WAIT_SLOTS:
            # the listeners' seats are all taken: a loop that has lost its way
            # and opened many is told to come back, and the seats the real
            # lanes need are never eaten by it. Commands do not sit here at all
            _overload("waits", route)
            await _plain(503, {"error": "too many listeners waiting"}, retry_after=5)(scope, receive, send)
            return
        _waits_open += 1
        gone = asyncio.Event()
        watcher = asyncio.ensure_future(_watch_disconnect(receive, gone))
        try:
            try:
                await run_in_threadpool(_run_state_request, _wait_enter, owner, agent)
            except SaveFailed:
                # the first-ever listen for this owner could not record itself.
                # _wait_enter raised before it counted the listener, so nothing
                # leaks; this answers the same 500 the other routes give rather
                # than letting SaveFailed become a crash line, and _wait_leave
                # is not reached because entering never succeeded
                await _answer(500, {"error": "the board could not save its state"},
                              route=route)(scope, receive, send)
                return
            try:
                deadline = time.monotonic() + min(timeout, 590)
                while True:
                    if gone.is_set():
                        return   # nobody is listening any more: claim nothing, say nothing
                    seen = _change_version
                    try:
                        outcome = await run_in_threadpool(_run_state_request, _wait_poll, owner)
                    except SaveFailed:
                        # a claim, a bounce or a steal-back could not be saved
                        # and has been put back; the listener is told the same
                        # 500 every command gets and asks again
                        await _send_response(_answer(500, {"error": "the board could not save its state"},
                                                     route=route), scope, receive, send)
                        return
                    if outcome is not None:
                        payload = outcome
                        bid, token = payload["box"], payload["ack"]
                        if gone.is_set():
                            # the listener left while the claim was being made
                            await run_in_threadpool(_run_state_request,
                                                    _rollback_claim, owner, bid, token)
                            return
                        watcher.cancel()
                        delivered = await _send_response(
                            _answer(200, payload, route=route, box=bid), scope, receive, send)
                        if not delivered:
                            # the write itself failed, on a transport that says
                            # so: roll the claim back so the message is not
                            # stranded. The rollback checks the token, so an ack
                            # that beat it here, or a claim made since, is left
                            # alone. A disconnect that lands after the bytes are
                            # handed over is not seen here and rides the ack lease
                            await run_in_threadpool(_run_state_request,
                                                    _rollback_claim, owner, bid, token)
                        return
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or _STOPPING.is_set():
                        await _send_response(_answer(200, {"idle": True}, route=route), scope, receive, send)
                        return
                    await _changed(seen, min(remaining, 5), gone)
            finally:
                await run_in_threadpool(_wait_leave, owner)
        finally:
            watcher.cancel()
            _waits_open -= 1


# -- what the board does when too many ask at once ---------------------------------
# The fences, from the outside in, and what each one truly bounds.
#
# CONNECTION_LIMIT is uvicorn's own: past it every request, commands included,
# gets uvicorn's plain 503, which is what stops a runaway from taking the
# process down. It is a hard ceiling on open connections, not a reservation for
# any one kind of request.
#
# READ_SLOTS bounds how many board readings are being built at once, not how
# many peers are slowly reading. A reading holds its slot from admission until
# its answer has been handed to the transport, which is the serialization under
# the lock plus the handover; once the bytes are in the transport buffer the
# slot is released, so a peer that then stops reading holds no slot. That makes
# READ_SLOTS a bound on concurrent serialization work, the expensive part, and
# not a bound on stalled peers. Long polls have WAIT_SLOTS of their own above.
# Commands, the ack, the unread count and the operation lookups are counted
# against neither, so a phone that cannot read the board can still send and an
# agent can still answer.
#
# The bound on a stalled peer is therefore two other things: WRITE_STALL_TIMEOUT
# in the protocol below, which cuts a connection whose write has been stuck that
# long and frees its buffered answer, and CONNECTION_LIMIT, which caps how many
# such connections can exist at all. What none of this promises is a reading
# during a genuine flood: past the slots or the ceiling even polling is refused,
# which the phone shows as reconnecting rather than as a board that is fine, and
# a refused command is retried under its operation id.

_reads_open = 0
_waits_open = 0
_last_overload: dict = {}
# read routes, the ones that share READ_SLOTS: every GET except the small
# answers that a command loop or a waking phone depends on
UNCOUNTED_GETS = frozenset({"/unread", "/op", "/fresh", "/wait", "/push/key", "/worktrees",
                            "/dirs", "/pickdir", "/upload"})


def _overload(which: str, route: str) -> None:
    """One line per kind per few seconds: a flood is worth knowing about and
    not worth a line per refused request."""
    now = time.monotonic()
    if now - _last_overload.get(which, 0) >= 5:
        _last_overload[which] = now
        _info("overload", slots=which, route=route)


DIAGNOSTIC_ROUTES = frozenset(("/send", "/create", "/m/state"))
SLOW_REQUEST_MS = 1000
_slow_requests: dict = {}   # three route keys, never a key from request text


def _slow_request(route: str, q: Query, status: int, ms: int) -> None:
    """Only unusually slow requests reach INFO. Operation ids already used by
    phone sends/creates join these lines to their client history and receipt.
    No arbitrary operation strings or query values are copied to the log."""
    if route not in DIAGNOSTIC_ROUTES or ms < SLOW_REQUEST_MS:
        return
    now = time.monotonic()
    window = _slow_requests.get(route)
    dropped = 0
    if window is None or now - window[0] >= CLIENT_WINDOW:
        dropped = window[2] if window else 0
        window = _slow_requests[route] = [now, 0, 0]
    if window[1] >= CLIENT_PER_MINUTE:
        window[2] += 1
        return
    window[1] += 1
    op = q.one("op")
    box = q.one("box")
    _info("slowrequest", box if _incident_box(box) else "", route=route, status=status, ms=ms,
          op=op if INCIDENT_OP.fullmatch(op) else None, dropped=dropped or None)


class Transport:
    """The outermost layer: the request line for the debug log, the read
    slots, the no-store every answer has always carried and the close that
    ends each connection with its answer. A crash inside is answered and
    written down by the application; this only makes sure the request is
    counted out again whatever happened."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        global _reads_open
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.monotonic()
        route = scope.get("path", "")
        q = _query(scope)
        status = 0
        counted = scope.get("method") in ("GET", "HEAD") and route not in UNCOUNTED_GETS

        async def bounded_send(message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = list(message.get("headers") or [])
                if route in DIAGNOSTIC_ROUTES:
                    # Time to response headers includes the server's queue and
                    # handler, not network transit or streaming the body.
                    ms = min(600000, max(0, round((time.monotonic() - started) * 1000)))
                    headers.append((b"x-facilitator-duration-ms", str(ms).encode("ascii")))
                if not any(name.lower() == b"cache-control" for name, _ in headers):
                    headers.append((b"cache-control", b"no-store"))
                # one request per connection, as the server this replaced
                # always answered. A connection kept open and then closed as
                # idle can be closed under a request the tunnel's proxy has
                # just reused it for, which the proxy answers with a 502 the
                # phone then has to retry; a connection closed with its
                # answer can never be reused at all
                if not any(name.lower() == b"connection" for name, _ in headers):
                    headers.append((b"connection", b"close"))
                message = {**message, "headers": headers}
            await send(message)

        if counted and _reads_open >= READ_SLOTS:
            _overload("reads", route)
            await _plain(503, {"error": "the board is busy answering other readers"},
                         retry_after=2)(scope, receive, bounded_send)
            return
        if counted:
            _reads_open += 1
        try:
            await self.app(scope, receive, bounded_send)
        except Exception:
            # answered and written down inside (_crashed); the exception is
            # re-raised by the application so a server may log it, and this
            # server already has
            pass
        finally:
            if counted:
                _reads_open -= 1
            if route in DIAGNOSTIC_ROUTES:
                try:
                    _slow_request(route, q, status, round((time.monotonic() - started) * 1000))
                except Exception:
                    pass   # diagnostics cannot turn a completed command into a failure
            if LOGGER.isEnabledFor(logging.DEBUG):
                # The request line is DEBUG and not INFO on purpose: the two
                # pages poll about 144,000 times a day between them, and a line
                # for each of those is 22 MB a day of mostly nothing. Switched
                # on, it is the line that says what the board was asked for,
                # what it answered and how long it took
                _debug("request", q.one("box"), method=scope.get("method"), route=route,
                       status=status, ms=round((time.monotonic() - started) * 1000))


def _plain(status: int, payload: dict, retry_after: int | None = None) -> Response:
    """An answer that is not a refusal of what was asked and so writes no
    refusal line: a crash, which has its own line, and a full house, which
    has its rate-limited one."""
    headers = {"Cache-Control": "no-store"}
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return Response(json.dumps(payload).encode(), status_code=status,
                    media_type="application/json", headers=headers)


async def _crashed(request: Request, error: Exception) -> Response:
    """A request that threw. The type, the words when they are safe words, and
    where it happened go in the file; the page gets an answer instead of a
    dropped connection."""
    q = _query(request.scope)
    _error("crash", q.one("box"), route=q.path, **_crash_fields(error))
    return _plain(500, {"error": "the board hit an error answering this request"})


async def _not_found(request: Request, error: Exception) -> Response:
    q = _query(request.scope)
    return _answer(404, {"error": "not found"}, route=q.path, box=q.one("box"))


@contextlib.asynccontextmanager
async def _lifespan(app):
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    # the routes' locked work is short, but a folder chooser or a git listing
    # can hold a thread for a while: room for those and the rest at once
    anyio.to_thread.current_default_thread_limiter().total_tokens = THREAD_POOL_SIZE
    try:
        yield
    finally:
        _LOOP = None


def _static(name: str, ctype: str):
    return _endpoint(lambda q, _: _file(HERE / name, ctype))


ROUTES = [
    Route("/", _endpoint(_get_root), methods=["GET"]),
    Route("/page", _endpoint(_get_page), methods=["GET"]),
    Route("/state", _state_endpoint(_get_state), methods=["GET"]),
    # stateful all the same: the route takes its reading through
    # _run_state_request itself, so the compression runs outside the lock
    Route("/m/state", _endpoint(_get_phone_state), methods=["GET"]),
    Route("/op", _endpoint(_get_op), methods=["GET"]),
    Route("/worktrees", _endpoint(_get_worktrees), methods=["GET"]),
    Route("/unread", _endpoint(_get_unread), methods=["GET"]),
    Route("/wait", WaitRoute(), methods=["GET"]),
    Route("/fresh", _state_endpoint(_get_fresh), methods=["GET"]),
    Route("/thread", _endpoint(_get_thread), methods=["GET"]),
    Route("/history", _endpoint(_get_history), methods=["GET"]),
    Route("/log", _endpoint(_get_log), methods=["GET"]),
    Route("/tokens/daily", _endpoint(_get_tokens_daily), methods=["GET"]),
    Route("/limits", _endpoint(_get_limits), methods=["GET"]),
    Route("/dirs", _endpoint(_get_dirs), methods=["GET"]),
    Route("/pickdir", _endpoint(_get_pickdir), methods=["GET"]),
    Route("/uploads/{rest:path}", _endpoint(_get_upload), methods=["GET"]),
    Route("/laneimg/{rest:path}", _endpoint(_get_laneimg), methods=["GET"]),
    # the vendored editor, one prebuilt file beside index.html. The page
    # asks for it the first time the file navigator is opened and never
    # on boot, so a board nobody opens the file navigator on pays nothing for it
    Route("/cm-markdown.js", _static("cm-markdown.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/card-markdown.js", _static("card-markdown.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/card-tokens.css", _static("card-tokens.css", "text/css; charset=utf-8"), methods=["GET"]),
    Route("/card-logic.js", _static("card-logic.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/mac-phone-view.js", _static("mac-phone-view.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/compose-format.js", _endpoint(_get_compose_format), methods=["GET"]),
    Route("/card-report.js", _static("card-report.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/home-widgets.js", _static("home-widgets.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/home-widgets.css", _static("home-widgets.css", "text/css; charset=utf-8"), methods=["GET"]),
    # the board page's own pair, beside index.html: the manifest Chrome installs
    # it from, and the worker whose scope has to be the root, which is why it is
    # served from the root rather than from a folder
    Route("/manifest.json", _static("manifest.json", "application/manifest+json; charset=utf-8"), methods=["GET"]),
    Route("/sw.js", _static("sw.js", "application/javascript; charset=utf-8"), methods=["GET"]),
    Route("/m-manifest.json", _endpoint(_get_manifest), methods=["GET"]),
    Route("/m", _endpoint(_get_phone_page), methods=["GET"]),
    # the phone page's files that make it installable, each a plain file
    # beside this one (the icons under assets/). Served with the no-store
    # every answer carries, so a changed page or worker is picked up on the
    # next open rather than a cache later
    *[Route(path, _endpoint(lambda q, _, p=p, c=c: _file(p, c)), methods=["GET"])
      for path, (p, c) in PHONE_FILES.items() if path not in ("/m", "/m-manifest.json")],
    *[Route(path, _endpoint(lambda q, _, p=p, c=c: _file(p, c)), methods=["GET"])
      for path, (p, c) in OMNI_FILES.items()],
    Route("/push/key", _endpoint(_get_push_key), methods=["GET"]),
    Route("/navfiles", _endpoint(_get_navfiles), methods=["GET"]),
    Route("/navfile", _endpoint(_get_navfile), methods=["GET"]),
    Route("/navimg", _endpoint(_get_navimg), methods=["GET"]),
    Route("/open-in-browser", _endpoint(_post_open_in_browser, "text", 8192), methods=["POST"]),
    Route("/upload", _post_upload, methods=["POST"]),
    Route("/upload", _get_upload_receipt, methods=["GET"]),
    Route("/clientlog", _endpoint(_post_clientlog, "raw", CLIENT_MAX_BODY, "report batch too large"), methods=["POST"]),
    Route("/navsave", _endpoint(_post_navsave, "raw", MAX_TEXT_BODY), methods=["POST"]),
    Route("/send", _state_endpoint(_post_send, "text"), methods=["POST"]),
    Route("/ack", _state_endpoint(_post_ack, "text"), methods=["POST"]),
    Route("/reply", _state_endpoint(_post_reply, "text"), methods=["POST"]),
    Route("/note", _state_endpoint(_post_note, "text"), methods=["POST"]),
    Route("/done", _state_endpoint(_post_done, "text"), methods=["POST"]),
    Route("/working", _state_endpoint(_post_working, "text"), methods=["POST"]),
    Route("/ping", _state_endpoint(_post_ping, "text"), methods=["POST"]),
    Route("/testing", _state_endpoint(_post_testing, "text"), methods=["POST"]),
    Route("/park", _state_endpoint(_post_park, "text"), methods=["POST"]),
    Route("/dock", _state_endpoint(_post_dock, "text"), methods=["POST"]),
    Route("/worktree", _state_endpoint(_post_worktree, "text"), methods=["POST"]),
    Route("/context", _state_endpoint(_post_context, "text"), methods=["POST"]),
    Route("/title", _state_endpoint(_post_title, "text"), methods=["POST"]),
    Route("/create", _state_endpoint(_post_create, "text"), methods=["POST"]),
    Route("/project", _state_endpoint(_post_project, "text"), methods=["POST"]),
    Route("/close", _state_endpoint(_post_close, "text"), methods=["POST"]),
    Route("/delete", _state_endpoint(_post_delete, "text"), methods=["POST"]),
    Route("/ws/goal", _state_endpoint(_post_ws_goal, "text"), methods=["POST"]),
    Route("/ws/task", _state_endpoint(_post_ws_task, "text"), methods=["POST"]),
    Route("/ws/current", _state_endpoint(_post_ws_current, "text"), methods=["POST"]),
    Route("/pages/new", _state_endpoint(_post_pages_new, "text"), methods=["POST"]),
    Route("/pages/del", _state_endpoint(_post_pages_del, "text"), methods=["POST"]),
    Route("/assign", _state_endpoint(_post_assign, "text"), methods=["POST"]),
    Route("/progress", _state_endpoint(_post_progress, "text"), methods=["POST"]),
    Route("/dismiss", _state_endpoint(_post_dismiss, "text"), methods=["POST"]),
    Route("/push/subscribe", _state_endpoint(_post_push_subscribe, "text"), methods=["POST"]),
    Route("/push/unsubscribe", _state_endpoint(_post_push_unsubscribe, "text"), methods=["POST"]),
    Route("/tabs", _state_endpoint(_post_tabs, "text"), methods=["POST"]),
    Route("/seen", _state_endpoint(_post_seen, "text"), methods=["POST"]),
    # the desktop pages' settings, in settings.json and never in state.json
    Route("/board-settings.js", _endpoint(_get_board_settings_js), methods=["GET"]),
    Route("/settings", _endpoint(_get_settings), methods=["GET"]),
    Route("/settings", _endpoint(_post_settings, "text"), methods=["POST"]),
    Route("/spotify/session", _endpoint(_get_spotify_session), methods=["GET"]),
    Route("/spotify/session", _endpoint(_post_spotify_session, "text"), methods=["POST"]),
    *([
        Route("/quicknotes", _endpoint(_get_quicknotes), methods=["GET"]),
        Route("/quicknote/new", _state_endpoint(_post_quicknote_new, "raw", MAX_TEXT_BODY, "note too large"), methods=["POST"]),
        Route("/quicknote/save", _state_endpoint(_post_quicknote_save, "raw", MAX_TEXT_BODY, "note too large"), methods=["POST"]),
        Route("/quicknote/attach", _state_endpoint(_post_quicknote_attach, "text"), methods=["POST"]),
        Route("/quicknote/del", _state_endpoint(_post_quicknote_del, "text"), methods=["POST"]),
    ] if QUICK_NOTES_ON else []),
]


def build_app():
    """The application: the routes above, a JSON 404 for a route nobody
    serves or the wrong method on one that is served (the answer the old
    dispatch gave both), and a JSON 500 for a crash."""
    app = Starlette(routes=ROUTES, lifespan=_lifespan,
                    exception_handlers={404: _not_found, 405: _not_found, Exception: _crashed})
    app.router.redirect_slashes = False   # /state/ is not /state, as it never was
    return Transport(app)


# -- other websites ---------------------------------------------------------------------
# The board's own port answers a page on this Mac and a caller that is not a
# browser at all, which is every agent: curl and onboard.py send no Origin and
# no fetch metadata. It refuses what a page on another website sent, and what
# arrived under a name another website pointed at this machine. The phone's
# socket and what Tailscale Serve forwards are the bridge gate's, and pass
# through here untouched.

SITE_HOST = re.compile(r"(?:127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?")
# the one thing another site may do to the board is open its page: that is how
# the Spotify sign-in comes back. The page is read and nothing is changed by it
NAVIGATION_PAGES = frozenset({"/", "/m"})
# a page opened straight from a link says document; the same opening, handed
# on by the board's own service worker, says empty. Mode stays navigate in both,
# which no script's fetch can produce
NAVIGATION_DESTS = frozenset({"document", "empty"})
SITE_REFUSAL_WINDOW = 5.0      # seconds: one refusal line per reason and route per window
SITE_REFUSALS_KEPT = 64
SITE_REFUSAL_ROUTE_CHARS = 80
SITE_REFUSAL_FILE_ROUTES = ("/uploads/",)


def _foreign_site(scope: dict) -> str | None:
    """Why this request is not the board's own page or a caller with no
    browser in it, or None when it is one of those. Only the board's own
    port is asked: a request on the phone's port, or one carrying a Serve
    forwarding header, is decided by the bridge gate and is not looked at here.

    A name some other site pointed at this Mac has the wrong Host. A page
    on another site, or on another port of this machine, names itself in
    Origin when it writes and in Sec-Fetch-Site whatever it does, and neither
    of those can be left out or changed by the page. A caller with no
    browser sends neither, which is what lets agents through."""
    headers: dict[bytes, bytes] = {}
    hosts = 0
    for name, value in scope.get("headers") or ():
        name = name.lower()
        hosts += name == b"host"
        headers[name] = value
    if (scope.get("server") or (None, None))[1] == BRIDGE_PORT \
            or b"x-forwarded-for" in headers or b"tailscale-headers-info" in headers:
        return None
    host = headers.get(b"host", b"").decode("latin-1").strip().lower()
    if hosts > 1:
        return "host is not this board's"
    if host:
        named = SITE_HOST.fullmatch(host)
        if named is None or (named.group(1) is not None and int(named.group(1)) != PORT):
            return "host is not this board's"
    fetch = {key: headers.get(b"sec-fetch-" + key.encode(), b"").decode("latin-1").strip().lower()
             for key in ("site", "mode", "dest")}
    if (scope.get("method") in ("GET", "HEAD") and scope.get("path") in NAVIGATION_PAGES
            and fetch["mode"] == "navigate" and fetch["dest"] in NAVIGATION_DESTS):
        return None
    origin = headers.get(b"origin")
    if origin is not None and origin.decode("latin-1").strip().lower() != "http://" + host:
        return "origin is not this board's"
    if fetch["site"] not in ("", "same-origin", "none"):
        return "asked for by another site"
    return None


class SiteGuard:
    """The outermost layer: answers a request from another website with a 403
    before anything under it, the bridge gate included, has seen it."""

    def __init__(self, app) -> None:
        self.app = app
        self._noted: dict[str, list] = {}   # reason and route -> [when its window opened, refusals folded into it]

    def _note(self, scope: dict, reason: str) -> None:
        """One line per reason and route per window, with a count of the ones
        left out, so a page that asks every second writes a line every five.
        Nothing the request carried goes in it, and a failure here never
        changes the answer."""
        try:
            path = scope.get("path", "")
            route = next((p + "*" for p in SITE_REFUSAL_FILE_ROUTES if path.startswith(p)),
                         path[:SITE_REFUSAL_ROUTE_CHARS])
            now, name, table = time.monotonic(), f"{reason} {route}", self._noted
            if name not in table and len(table) >= SITE_REFUSALS_KEPT:
                for stale in [k for k, w in table.items() if now - w[0] >= SITE_REFUSAL_WINDOW]:
                    del table[stale]
            key = name if name in table or len(table) < SITE_REFUSALS_KEPT else ""
            window = table.get(key)
            if window is not None and now - window[0] < SITE_REFUSAL_WINDOW:
                window[1] += 1
                return
            table[key] = [now, 0]
            _info("refusal", route=route, code=403, reason=reason,
                  folded=(window[1] if window else 0) or None)
        except Exception:
            pass

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        send = _unframeable(send, scope)
        reason = _foreign_site(scope)
        if reason is None:
            await self.app(scope, receive, send)
            return
        self._note(scope, reason)
        await Response(json.dumps({"error": "request from another site refused"}).encode(),
                       status_code=403, media_type="application/json",
                       headers={"Cache-Control": "no-store", "Connection": "close"})(scope, receive, send)


def _unframeable(send, scope=None):
    """Only the local board's phone document may be framed by its own origin.
    Root stays unframeable, so another site cannot wrap the parent in a frame.
    The phone bridge and every preexisting policy retain their protections."""
    headers = {name.lower(): value for name, value in (scope or {}).get("headers", ())}
    local_phone = bool(scope and scope.get("path") == "/m"
                       and (scope.get("server") or (None, None))[1] != BRIDGE_PORT
                       and b"x-forwarded-for" not in headers
                       and b"tailscale-headers-info" not in headers
                       and _foreign_site(scope) is None)
    async def framed(message) -> None:
        if message["type"] == "http.response.start":
            held = list(message.get("headers") or ())
            named = {name.lower() for name, _ in held}
            if b"x-frame-options" not in named:
                held.append((b"x-frame-options", b"SAMEORIGIN" if local_phone and message.get("status") == 200 else b"DENY"))
            if b"content-security-policy" not in named:
                held.append((b"content-security-policy", b"frame-ancestors 'self'" if local_phone and message.get("status") == 200 else b"frame-ancestors 'none'"))
            message = {**message, "headers": held}
        await send(message)
    return framed


# -- the wire ---------------------------------------------------------------------------

class BoardProtocol(H11Protocol):
    """uvicorn's HTTP/1.1 protocol with two clocks it does not keep itself.
    A connection that has opened and not yet sent a request is cut after
    FIRST_REQUEST_TIMEOUT: uvicorn's own idle clock only starts after a first
    answer. And a connection whose peer has stopped reading is cut
    WRITE_STALL_TIMEOUT after the write paused: the answer was serialized under
    the lock and the lock let go long before the bytes went out, so the stall
    costs the board one connection and one buffered answer, and this bounds how
    long. The cut has to be forced. Every answer carries Connection: close, so
    uvicorn asks the transport to close the moment the body is handed over; with
    the peer silent that close never finishes, since it is waiting for the very
    bytes the peer will not take. So the deadline does not defer to the closing
    flag: while the write buffer still holds bytes it forces the connection
    down, with a zero linger so the kernel sends a reset rather than queue a
    goodbye behind the unread answer."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._first_timer = None
        self._stall_timer = None
        self._served_one = False

    def connection_made(self, transport) -> None:
        super().connection_made(transport)
        self._first_timer = self.loop.call_later(FIRST_REQUEST_TIMEOUT, self._first_request_late)

    def on_response_complete(self) -> None:
        self._served_one = True
        super().on_response_complete()

    def connection_lost(self, exc) -> None:
        for timer in (self._first_timer, self._stall_timer):
            if timer is not None:
                timer.cancel()
        self._first_timer = self._stall_timer = None
        super().connection_lost(exc)

    def pause_writing(self) -> None:
        super().pause_writing()
        if self._stall_timer is None:
            self._stall_timer = self.loop.call_later(WRITE_STALL_TIMEOUT, self._stalled)

    def resume_writing(self) -> None:
        super().resume_writing()
        if self._stall_timer is not None:
            self._stall_timer.cancel()
            self._stall_timer = None

    def _first_request_late(self) -> None:
        self._first_timer = None
        if not self._served_one and self.conn.their_state is h11.IDLE and not self.transport.is_closing():
            self.transport.close()

    def _stalled(self) -> None:
        self._stall_timer = None
        transport = self.transport
        # the timer only survives to here while the write is paused, since
        # resume_writing cancels it, so the buffer is what decides, not the
        # closing flag. Nothing left to send means the close (or the write)
        # will finish on its own; bytes still buffered mean a peer that stopped
        # reading, and the connection is forced down.
        try:
            buffered = transport.get_write_buffer_size()
        except Exception:
            buffered = 0
        if buffered == 0:
            return
        # a plain abort would leave a goodbye queued behind the unread bytes, so
        # the socket would linger until the peer finally read it. A zero linger
        # makes the kernel send a reset instead, freeing the connection at once
        # and telling the peer, or the tunnel's proxy, plainly that this answer
        # is gone. The option is standard; where a transport hides its socket or
        # refuses it, the abort below still runs.
        sock = transport.get_extra_info("socket")
        if sock is not None:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            except OSError:
                pass
        # the client stopped reading its answer (a phone that went to sleep
        # mid-page, a proxy connection left behind): routine here and never a
        # traceback, but the caller has to be able to find out, so it is
        # reported instead of hidden
        cycle = getattr(self, "cycle", None)
        scope = cycle.scope if cycle is not None else {}
        q = _query(scope)
        _debug("hungup", q.one("box"), route=scope.get("path", ""))
        transport.abort()


class BoardServer(uvicorn.Server):
    """uvicorn's server with its signal capture switched off: this file keeps
    its own handlers, so the stop line can say which signal it was, and so
    SIGHUP, which uvicorn does not watch, ends the run as cleanly as the other
    two rather than killing the process mid-write."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield


class TransportLogHandler(logging.Handler):
    """What uvicorn has to say, in the board's own file and its own shape.
    Its chatter about starting and stopping is dropped, since the board's
    start and stop lines already say that. A warning or an error is kept as
    its type and its plain words, never its traceback, which would carry
    paths. One message is dropped on purpose: the one about an answer that
    was not completed, which is what a connection cut for stalling looks like
    from inside, and which _stalled has already written down properly."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if record.levelno < logging.WARNING:
                return
            words = record.getMessage()
            if words.startswith("ASGI callable returned without completing response"):
                return
            error = record.exc_info[1] if record.exc_info and record.exc_info[1] else None
            fields = {"message": words[:CRASH_MESSAGE_CHARS] if set(words) <= CRASH_PLAIN else None,
                      "error": type(error).__name__ if error else None}
            _event(logging.ERROR if record.levelno >= logging.ERROR else logging.INFO,
                   "transport", **fields)
        except Exception:
            pass


def _quiet_uvicorn() -> None:
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "uvicorn.asgi"):
        log = logging.getLogger(name)
        log.handlers = [TransportLogHandler()]
        log.propagate = False
        log.setLevel(logging.INFO)


def _listen(port: int = PORT) -> socket.socket:
    """The listening socket, bound the way the old server bound it: loopback
    only, address reuse on, so a restart does not wait out a closed socket's
    linger and a second board on the same port is refused."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.listen(LISTEN_BACKLOG)
    return sock


_held_lock: int | None = None   # the descriptor holding SERVER_LOCK, never closed


def _take_lock() -> bool:
    """One server per folder. Once the port could move, the bind stopped being
    enough: a second server from this folder on another pair would bind
    happily and then write the same state.json as the first. So the server
    takes an exclusive lock on SERVER_LOCK and holds it until it exits, when
    the kernel lets go of it whatever ended the process, a kill included.

    False when another process holds it. Once taken, the file says which pid
    and which pair holds it, for the CLI; it is never removed, and a reader
    checks what it names rather than trusting it, so a stale one is harmless."""
    global _held_lock
    fd = os.open(SERVER_LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return False
    record = json.dumps({"pid": os.getpid(), "port": PORT, "bridge": BRIDGE_PORT}) + "\n"
    try:
        os.ftruncate(fd, 0)
        os.pwrite(fd, record.encode(), 0)
    except OSError:
        pass   # the lock is what matters; the CLI falls back to the configured port
    _held_lock = fd
    return True


def _legacy_target_in(config: object) -> bool:
    """Any Serve proxy to the old unguarded socket is unsafe after upgrade."""
    if isinstance(config, dict):
        proxy = config.get("Proxy")
        if isinstance(proxy, str):
            try:
                target = urlparse(proxy)
                if (target.scheme == "http" and target.hostname == "127.0.0.1" and
                        target.port == PORT):
                    return True
            except ValueError:
                pass
        return any(_legacy_target_in(value) for value in config.values())
    if isinstance(config, list):
        return any(_legacy_target_in(value) for value in config)
    return False


def _refuse_legacy_serve() -> None:
    """Keep an existing Serve rule from exposing the old unguarded port.

    The old bridge is persistent, so a freshly installed server must check it
    before it binds. The operator removes that exact rule with `bridge off`,
    then installs the password and turns the guarded bridge on.
    """
    ts = _tailscale_command()
    if ts is None:
        return  # no Serve command is installed on this Mac
    config = _tailscale_json(ts, ["serve", "status", "--json"])
    if config is None:
        raise SystemExit("Cannot inspect Tailscale Serve; the board stayed down so an old bridge cannot expose it.")
    if _legacy_target_in(config):
        raise SystemExit("Old Tailscale Serve rule targets the unguarded board port. Run `facilitator bridge off`, then restart the board and run `facilitator bridge on`.")


_BRIDGE_AUTH = None


def _require_bridge_components():
    """Load the complete gate before either listening socket can be opened."""
    global _BRIDGE_AUTH
    for name in ("bridge_auth.py", "bridge_gate.py", "m-gate.html"):
        if not (HERE / name).is_file():
            raise SystemExit(f"Phone bridge component {name} is missing; the board stayed down. Restore the complete installation before restarting.")
    try:
        import bridge_auth
        from bridge_gate import BridgeGate
    except Exception as error:
        raise SystemExit("Phone bridge authentication could not load; the board stayed down. Restore the complete installation before restarting.") from error
    _BRIDGE_AUTH = bridge_auth
    return BridgeGate


def _make_server(bridge_gate=None) -> BoardServer:
    if bridge_gate is None:
        bridge_gate = _require_bridge_components()
    app = SiteGuard(bridge_gate(build_app(), BRIDGE_PORT, _info))
    config = uvicorn.Config(
        app, host="127.0.0.1", port=PORT,
        log_config=None, access_log=False, server_header=False,
        http=BoardProtocol, ws="none", lifespan="on", loop="asyncio",
        limit_concurrency=CONNECTION_LIMIT, backlog=LISTEN_BACKLOG,
        timeout_keep_alive=KEEP_ALIVE_TIMEOUT,
        timeout_graceful_shutdown=GRACEFUL_STOP_TIMEOUT,
    )
    return BoardServer(config)


# why this process is stopping, set by the signal handler in main and read by
# the stop line on the way out; None until something asks it to stop
_stop_reason: str | None = None


def main() -> None:
    _quiet_uvicorn()
    _warn_legacy_config()

    # Own the listening sockets and the folder's lock before touching durable
    # board data. In particular, a replacement started while the old server
    # still owns the port must not migrate state or append the transcript
    # schema boundary: the old process can still append legacy rows until it
    # has actually stopped.
    bridge_gate = _require_bridge_components()
    _refuse_legacy_serve()
    try:
        sock = _listen()
    except OSError as error:
        _error("bindfail", port=PORT,
               reason=f"facilitator could not listen on 127.0.0.1:{PORT}, the first of "
                      f"its two ports {PORT} and {BRIDGE_PORT}: {error}")
        raise SystemExit(1) from None

    try:
        bridge_sock = _listen(BRIDGE_PORT)
    except OSError as error:
        sock.close()
        _error("bindfail", port=BRIDGE_PORT,
               reason=f"facilitator could not listen on 127.0.0.1:{BRIDGE_PORT}, the phone's "
                      f"port of its two ports {PORT} and {BRIDGE_PORT}: {error}")
        raise SystemExit(1) from None

    # Taken after the bind, so a second server on this same pair still fails
    # there as it always has, and before state.json is read, so a second server
    # from this folder on ANOTHER pair leaves having touched nothing
    if not _take_lock():
        sock.close()
        bridge_sock.close()
        _error("lockfail", port=PORT,
               reason="another server from this folder is already running; this one stayed down")
        raise SystemExit(1) from None
    server = _make_server(bridge_gate)

    def stopping(signum, frame) -> None:
        """Ctrl-C, a kill, or the terminal closing: the reason is remembered and
        the ordinary shutdown runs, so the file gets a stop line to match its
        start line. A start with no matching stop was all the file remembered
        about a restart, which is why one could not be explained. Open
        requests get GRACEFUL_STOP_TIMEOUT to finish; a listener waiting for a
        card is sent home at once."""
        global _stop_reason
        if _stop_reason is None:
            _stop_reason = signal.Signals(signum).name
        _STOPPING.set()
        server.should_exit = True
        _notify()

    for stopper in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(stopper, stopping)

    try:
        INTERNAL_UPLOADS.mkdir(parents=True, exist_ok=True)
        _sweep_upload_parts()
        _tighten_private_files()
        _load()
        with _lock:
            _state["busy"] = {ow: None for ow in OWNERS}  # a restart never resumes mid-claim
            _state["claimed"] = {ow: [] for ow in OWNERS}
            _state["ack"] = {ow: None for ow in OWNERS}   # and no token outlives it
            # re-queue any box that still has unanswered messages
            for b in _state["boxes"]:
                if b["pending"] and b["id"] not in _state["inbox"]:
                    _state["inbox"].append(b["id"])
            _save()
        pushed = _state.get("push_last_ok") or {}
        _info("start", port=PORT, boxes=len(_state["boxes"]), log_level=LOG_LEVEL,
              push_ok=pushed.get("ts"), push_host=pushed.get("host"))
        _start_usage_counts()
        server.run(sockets=[sock, bridge_sock])
    except Exception as error:
        # the last word about a start that died of something rather than being
        # asked to stop: the stop line below says only which type ended it, and
        # the traceback that used to explain it now goes nowhere
        _error("crash", **_crash_fields(error))
        raise
    finally:
        # one stop line for every start line, and it says why: a named signal,
        # the exception that ended it, or the loop simply returning
        ended = sys.exc_info()[0]
        _info("stop", reason=_stop_reason or (ended.__name__ if ended else "end of stream"))
        sock.close()
        bridge_sock.close()


if __name__ == "__main__":
    main()
