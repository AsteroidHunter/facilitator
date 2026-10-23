# Agents on your own servers

An agent can run on one of your own servers and work a project's cards on your Mac's board as an agent on the Mac does. The board never logs in to the server: you log in there yourself, the way you always do, and the server connects out to the board over Tailscale. The scripts and folders on the server keep working whether or not the board is connected; only the cards wait for it.

Before you start: Tailscale on the Mac and on the server, both in your tailnet, and the board running on the Mac. The server needs python3 3.7 or newer and curl, as most Linux servers have. Nothing is installed there but the Facilitator skill, in `~/.facilitator`, and nothing on the Mac holds a way to log in anywhere.

Pairing a server, once: on the Mac, run `facilitator remote pair`, with `--name lab` for a shorter name than the server's own. It prints one line and a pairing code that works once, for 10 minutes. Log in to the server as yourself and run that line there; paste the code when it asks. That puts the skill, the runbook and these docs in `~/.facilitator/skill`, links the skill where Claude Code and Codex look for skills (never over something else), keeps the server's own key in `~/.facilitator/server.key`, and starts the server's link: a small program of your account that connects out to the board, keeps trying while the Mac is asleep or away, and comes back by itself. Pair as many servers as you like. To bring a newer skill to a server, pair it again under the same name.

`facilitator remote list` shows each server and whether it is connected. `facilitator remote remove lab` forgets one on the Mac; its link stops at its next try, and `~/.facilitator` and the skill's links on the server stay until you delete them. On the server, `python3 ~/.facilitator/skill/.agents/skills/facilitator/scripts/link.py status` says how the link is doing, and `start` and `stop` in place of `status` start and stop it. If the server ends every program when you log out, the link starts again whenever an agent there onboards, or with `start`.

Adding a project on a server: on the board, choose Open a new folder, pick the server under Machines (a green dot while it is connected), browse to the folder and choose it. The server's link answers the folder picker from inside your home folder there, by the same rules as on the Mac: hidden folders and links that lead out of your home stay out. The project's row shows the server's name before its path, for example `lab:/home/you/app`.

Starting the agent: on the server, start Claude Code or Codex in the project's folder and ask it to onboard (`/facilitator onboard` in Claude Code, `$facilitator onboard` in Codex), as on the Mac. It joins that project and is given a key of its own, which opens only that project's cards. It can show you a picture, a page or a website in a card's magic box, as an agent on your Mac does. If an agent on a server says it has no way to fill the magic box, pair that server again under the same name to bring it the newer skill.

When the connection drops: once the board has heard nothing from a server for 30 seconds, its projects fade on the Mac board and the phone, with one line saying the server is not connected. A shorter drop does not show. You can still type and send: messages wait on the Mac, and the agent gets them as soon as the server is back. Meanwhile the agent goes on working on the server and keeps listening for the board.

Who can reach what: servers reach the board on its agent door, port 8870 on the Mac's Tailscale addresses and nowhere else (`agent_port` in `run.config.json` picks another port). The door is open only while a server is paired or a pairing code waits, so a board with no servers listens on no tailnet address. Nothing outside your tailnet can reach it, and it is never on the open internet. If macOS asks whether Python may accept incoming connections when you first pair, allow it, or servers cannot connect. Every request on the door needs a key, except the setup program itself, which is the skill's own code: a pairing code, once, to get a server's key; the server's key, only to answer the folder picker and to let an agent join; each agent's key, only for its own project's cards. The Mac keeps fingerprints of the keys, never the keys, and no key, code or address is written to a log or a card. On the server everything is in `~/.facilitator`, for your account alone: another user there can reach the door as any program on that server can, but holds no key. An agent on a server cannot read the board's other projects or your Mac's files. Of your profile it is given only the first word of your name, when it joins, to call you by. It can fill the magic box of its own project's cards and no others, and a page it puts there runs sealed off from the board with no network, as one from an agent on your Mac does.

Narrowing it further with Tailscale: while your tailnet's access rules allow everything, which is how a new tailnet starts, every machine in it can reach the door, though none gets anything there without a key. To let only your servers reach it, give the servers a tag and allow that tag alone to the Mac's port 8870 in the tailnet's access controls, keeping the rule that lets your phone reach the Mac on 443. For example, with the Mac named `my-mac` under `hosts`:

```json
"grants": [
  {"src": ["tag:agents"], "dst": ["my-mac"], "ip": ["tcp:8870"]},
  {"src": ["autogroup:member"], "dst": ["my-mac"], "ip": ["tcp:443"]}
]
```

Not yet: the file panel and the pictures from a server project's notes folder.
