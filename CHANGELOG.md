# Changelog

## v0.3.72

October 30, 2026

<img src="https://raw.githubusercontent.com/AsteroidHunter/facilitator/main/docs/images/person.svg" width="14" height="14" alt="Person icon"> `The section below is human-written`

## Notes from the dev

Minor update with one feature worth checking out and a range of security updates and bug fixes. 

**The one feature first**: interactive widgets. Now, the *magic box*, i.e., the custom box that an agent can create and attach to a particular card, can show interactive artifacts that talk back: what you pick or type in them reaches the agent. 

Really helpful when designing frontend mocks and you wish to fine-tune certain parts of a UI or get a feel for the UX. 

Also helpful for building one-off to-do lists or splitting a part of a conversation into several parts (this is how I could triage the 100+ deferred cards on my workspace and isolate the relevant 46 as GitHub issues).

**W.r.t. security updates**, I am slowly decreasing the surface area of exploits, i.e., ensuring that only your agents and you can access content on the board. 

**Another key improvement** is a slow march towards token efficiency. Currently, how the agent polls and interacts with the board, and how subagents and your orchestrator interact, are two key sources of token waste. Repeated unnecessary polling before a response is posted should now drop to ~0 most of the time (discovered that a bug led to three turns before the orchestrator posted a response). [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) integration, once finished, will massively reduce polling-related token overconsumption.

**Curse away** is the fun addition. Curse words are replaced with a `[expletive]` tag before they reach the board and the agent. Managing many tasks/subagents is inherently stressful and overwhelming, plus the jagged frontier: agents are weirdly superhuman but also dumb, so it is natural to get frustrated. I am tired of seeing some devs (like me) frantically scroll to avoid showing the random `[expletive]` or `[expletive] [expletive]` on my chats.

Lastly, a series of smaller bug fixes and improvements, but you can read those below.

---

<img src="https://raw.githubusercontent.com/AsteroidHunter/facilitator/main/docs/images/agent-robot.svg" width="14" height="14" alt="Robot icon"> `The write-up below was generated but reviewed by a human, albeit in haste`

### Release highlights
- **Faster:** changes are pushed live instead of checked every 1.2 seconds, new replies show at once, and switching projects and opening the magic box are quicker.
- **Widgets:** an agent can put an interactive page in the magic box; what you type there reaches the agent and stays off the card.
- **A locked board:** only agents holding the board's key, and the Chrome window `facilitator run` opens, can reach it, so no agent can post as you.
- **Signed updates:** updates install only versions signed with the maintainer's key.

### Updating
Answer yes to the board's "Update Facilitator?" question, or run `facilitator update`.

### Security and privacy
- The board's port now answers only agents holding its key and the window `facilitator run` opens, so other Mac accounts and programs are shut out.
- The board opens its own Chrome window and keeps its one-time code to itself, so no agent can take a code and post as you.
- An agent's message is always saved as the agent's, and a link in card text cannot claim another project's card.
- Magic box pages can no longer reach the internet by moving their own frame.
- A box picture opened in its own tab can no longer read the board's storage.
- Wrong phone passwords are counted per device, so one device cannot lock everyone out.
- A phone sign-in unused for 30 days ends, along with that phone's notifications.
- A paired server checks the board's key before saving it.
- `facilitator remote pair` needs `--name NAME`, so one server cannot take over another's record.

### Updates and install
- Signed updates: `facilitator update` and the board's "Update Facilitator?" question install only versions signed with the maintainer's key in `app/update-signers`; anything else changes nothing.
- After an update or a restart, open board tabs reload by themselves.
- `facilitator run --attach`, `--spawn` and `--force` are gone; old `tmux`, `instruction` and `prompt` lane entries are ignored.
- A board unused for three days stops itself (a temporary measure for the Chrome-window version), and the next `facilitator run` or `facilitator status` says so once.
- If Chrome will not open, `facilitator run` says to open Chrome and run it again.
- `facilitator uninstall` asks whether to keep your board's data; only a no and then a yes to "Are you sure?" deletes it. `--keep-data` keeps it without asking, and `--delete-data` asks only "Are you sure?".

### Mac board
- Changes are pushed live instead of being checked every 1.2 seconds, so replies show sooner and an idle window uses far less CPU.
- A new reply shows at once, even while you type or scroll (Mac and phone).
- The cross and the done key close a card and its ticket together (Mac and phone).
- Switching projects is faster.
- The gap under the grey answered panel is even on every card.
- A hidden quick chat panel that checked for messages every 2.5 seconds is gone.
- A board window that dies (goes white) leaves one log line on its next load.

### Phone app
- A message that cannot be sent stops retrying after 15 minutes (it was 12 hours) and shows "not delivered"; the arrow sends it again.
- The launch screen's first frame no longer waits on a stylesheet.
- A refused sign-in reloads the app onto the password page.
- On a slow link the sent panel no longer sticks at "Delivered".
- The phone no longer zooms in when you tap a small field in an expanded box.

### Magic box and widgets
- Widgets: an agent can put an interactive page in the box (`--widget NAME`); what you type there reaches the agent and stays off the card.
- Control + Shift + Left and Right reach an expanded widget (Mac and phone).
- Box pages appear at once: they stay loaded, and muted, after you leave a card.
- On the Mac, one solid middle line replaces the two dashed lines joining the box and the card.

### Agents
- `onboard.py wait --reply CARD` answers a card and listens again in one step.
- The skill tells a blocked connection apart from a stopped board, and retries with permission.
- The runbook's curl lines carry the board's key (`-K "$KEY"`).
- `facilitator magic CARD answer ID` answers a widget message; a widget message is never approval for a push, merge or deletion.
- The runbook asks for replies that are quick to read, with bold only where it helps.
- Agent text says "the person", not "the owner", and uses your name sparingly.
- `facilitator bridge` help says when a phone sign-in ends by itself.

### Settings added
- Replace curse words (Settings, Editor; Mac and phone): off by default. Curse words in your messages are saved as `[expletive]`; links are left alone.
- New layout (Settings, Appearance): off by default, Mac only, and shown only in Mac developer mode (seven clicks on the home page's version label). Experimental.

### Fixes
- Daily usage counts no longer include agents' messages.
- A window refused by the lock no longer shows a stuck "No available project owner" error.
- Settings no longer takes the focus from an update question over it.
- A New layout or waiting order change made in another window now redraws at once.
- The command says when the key was refused or a sandbox blocked a call, instead of calling the board down.
- With Replace curse words on, sends keep their animation and swapped words roll in smoothly.
- The tests that need no browser now run on GitHub for every push to main and premain.

### Upgrade notes (from v0.3.27)
- This first update is installed by v0.3.27's own update code, unchecked; every later update is signature-checked and needs git 2.34 or newer.
- The update restarts a running board with the new lock on, and open board tabs reload themselves. If macOS has not yet let Terminal control Chrome, an update started from the board opens a second board window; the first works again once reloaded.
- A board page showing "Open the board with facilitator run" needs one `facilitator run`.
- An agent listening during the update may get a refused call from the listener it started before; the next `onboard.py` call carries the board's key by itself. An agent making its own curl calls is refused until it runs `onboard.py inspect` again (or is onboarded again).
- A server paired before this keeps the skill copy it was given; pairing it again (now with `--name`) gives it the new one.
- Reopen the phone app. No phone is signed out; each sign-in's 30 days start from its first use after the update.
- Take `--attach`, `--spawn` and `--force` out of anything that calls `facilitator run` (they are now ignored without a word).
