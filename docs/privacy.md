# Privacy and what the board keeps

## Usage counts

Once a day the board sends one message of counts about the day before to the Facilitator project in PostHog (in the US), under a random id made for this install. The board's own counts come from what it already keeps, never read for their words: messages sent, cards made and closed, projects added, agent replies (split into Claude, Codex or other), minutes used and whether the phone app was opened. The token counts come from the logs Claude Code and Codex already keep on this Mac, the same ones the home page's token chart reads: the tokens each tool used that day, split into fresh input, cache writes, cache re-reads and output, and the day's tokens split into sessions that worked a board lane, other sessions, and sessions counted before the board kept that answer. A session works a board lane when it ran the board's wait helper; the board keeps only that yes or no for each log, never the command. The message also says how many days it is since the board's first day. A day is sent if the board was used or Claude Code or Codex used tokens that day, and only once. The switch is "Share daily usage counts" in Settings, Improvements, on the Mac or the phone; a day that ends while it is off is never sent.

Once per install, while the switch is on, one more message goes: the token use of up to 8 weeks before the board's first day, as each week's tokens without cache re-reads and its number of days with any use, and how many days back each tool's logs reach. It is sent once and never again.

What leaves the Mac, exactly:

- Every day the board or the agents were used, unless the switch is off: one message of counts and token numbers, the app version and the main macOS version number, under the install id. Never a word anybody typed, a name, a card title, a folder, a path or a command.
- Once per install, unless the switch is off: one message of weekly token numbers from the 8 weeks before the board's first day, under the same id. Numbers only.
- Only after a yes to feedback emails (an email given, in the onboarding or in Settings, Profile; there is no switch for it), and only while the "Share daily usage counts" switch is on: your email, name, what you will mostly use Facilitator for and your time zone, each only if given. They go once, at the yes; after that, an answer you change goes again on its own, and one you clear is removed there.
- Taking the yes back, by clearing the email in Settings, Profile, sends nothing more, and the Mac forgets your email and answers; what PostHog already holds stays there. A later yes sends them all again.
- With the switch off nothing leaves, the profile included, except a message you write in the feedback box and send.
- Without the yes, the profile never leaves the Mac, except the first word of your name, which an agent on one of your own servers is given when it joins (see [Agents on your own servers](servers.md)).
- When the board starts and once a day, while "Check for updates" in Settings, Improvements, is on and only on a folder that can update: one request to GitHub for the app's page on main, read only as far as its version number. Nothing is sent with it, no id and no token. A folder on another branch, or with changes of its own, never makes it.
- A message from the feedback box in Settings, Improvements: the one thing sent with words. Only when you press send and let the three seconds to cancel pass (text only, at most 5000 characters), as one "feedback sent" event under the install id with your name and email attached to it. It goes whether or not the switch is on, because sending feedback is its own choice, and its words are never written to a log.

## Who can reach the board

Only your own Mac can use the board: its address works only on this Mac, and it refuses any request another website sets off. Another site may open the board's page but cannot change anything or show the board inside its own page. The phone reaches the board only through the phone link, which needs the phone password. A magic box can be filled only from the Mac itself; a signed-in phone can see one and close it. An agent on one of your own servers reaches the board only by connecting out to its agent door, which listens on the Mac's Tailscale addresses alone, and only with its own key, which opens its own project's cards and nothing else; the board never logs in to a server (see [Agents on your own servers](servers.md)). The files the board keeps about your work, attachments and logs included, can be read only by your Mac account.

## Search

The search index (`data/search-index.sqlite`) holds the words of your cards so the board can search them, and it never leaves the Mac. The model that searches by meaning, once you set one up, runs on this Mac too: the board sends text only to a model at a `127.0.0.1` or `localhost` address. See [Searching cards and messages](search.md).

## The log

The board writes its own dated log files into `data/logs`, which never goes into the repository, and they record only what the board did, never anyone's words, keys, file paths or email addresses.

A new install logs errors only (`"log_level": "error"` in `run.config.example.json`), so for the server, bridge and phone logs the folder gains a file only when something goes wrong; a `run.config.json` with no `log_level` keeps logging at info, and `FACILITATOR_LOG_LEVEL` or `"log_level": "debug"` turns on full diagnostics.
