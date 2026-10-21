<p align="center">
  <img alt="Facilitator" src="app/tools/readme-header/facilitator-header.svg" width="460">
</p>

## About 

Facilitator is a natural language development environment. It is an interface built to resolve *the* bottleneck when coding with agents: [understanding](https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck).

**Facilitator makes it super easy to atomize your asks and orchestrate dozens of subagents.** The interface speeds up your development and helps you ship faster and better in following ways:
1. If you are working on a large spec, you can develop different parts of the spec independently, quickly delegating the portions that are simple, and spending more time on parts that require greater attention
2. If you want to ship *n* features or resolve *n* bugs, you can do so independently on *n* different cards, where the task on each is handled by a subagent in a worktree
3. The tickets on the left show you which cards are waiting for your input and which ones are busy
4. Hotkeys make it easy to triage tasks; you can quickly defer features and bugs that should be dealt with later
5. After iterating a bit on a project using the Facilitator, the cards serve as that project's knowledge bank, owned by you, and easily queryable by agents

Facilitator is meant to complement your existing development workflow. **To make the best of the Facilitator**:
- Atomize your asks
- Learn the hotkeys
- Dispatch subagents
- Triage & ship!

## Installation

**Pre-requisites**:
- Claude Code or Codex
- Google Chrome
- macOS 11 or later (the installer sets up its own Python 3.14 for the board; your own Python is not changed)

Installing the Facilitator is easy:
```
git clone https://github.com/AsteroidHunter/facilitator.git
cd facilitator
./install.sh
```

**Once installed**

1. On your favorite terminal:
`facilitator run`
2. Start a Claude or Codex session, and run `/facilitator onboard` in Claude Code and `$facilitator onboard` in Codex
3. Open a project on the facilitator, press `command + T` to open a new card, and start shipping!

### Mobile version
The Facilitator comes with a mobile version. The mobile version is fun to use when paired with an external keyboard. 

If you have an always on machine (or like to leave your laptop running), you can access your project on the Facilitator and direct agents as long as you have **Tailscale**. 

To use the mobile version:
1. Run `facilitator bridge`
2. Scan the QR code using your phone
3. Follow the steps to set up the web app
4. Continue shipping!

## Updating the Facilitator

Facilitator is still in development and will be constantly updated. When a new version is out, the board asks whether to update; say Yes and it downloads the update, restarts if it needs to and reloads itself. To update from the terminal instead, run:
```
facilitator update
```

## What leaves your Mac

- Once a day, counts about the day before: messages sent, cards made and closed, projects added, agent replies and phone app openings, with the app version and the main macOS version number, under a random id made for your install. Never a word you typed, a card title, a folder or a path.
- Your profile (the email you give when you set up, your name, what you use Facilitator for and your time zone) goes only after you have given an email, and only while the daily counts switch is on.
- The switch is "Share daily usage counts" in Settings, under Improvements. With it off, nothing leaves your Mac, except feedback you send.
- Feedback is the one thing sent with words: a message you write in the feedback box in Settings, under Improvements, goes with your name and email only when you press send, after three seconds in which you can cancel.
- Nothing you type into a card or the magic box is ever sent.
- When the board starts and once a day, it reads the version number of the newest Facilitator on GitHub. Nothing is sent with that request. "Check for updates" in Settings, under Improvements, turns it off.

## License

This project is released under the [Facilitator License 1.0.0](LICENSE.md). Contributions are accepted under the terms in [CONTRIBUTING.md](CONTRIBUTING.md).

The bundled CodeMirror editor (`app/cm-markdown.js`) is included under its own MIT license, and the bundled d3-force (`app/graph-force.js`) under its own ISC license; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
