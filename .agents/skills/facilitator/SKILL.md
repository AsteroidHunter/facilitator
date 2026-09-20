---
name: facilitator
description: Join and operate a local Facilitator board lane when asked to onboard, listen to cards, or work as the board's agent from Claude Code or Codex.
---

# Facilitator onboarding

`onboard` joins the board from this agent conversation. The usual invocation is `/facilitator onboard` in Claude Code or `$facilitator onboard` in Codex. The optional `--board NAME` selects a lane by ID or project name; `--path DIR` selects by project directory. Without either, use the directory where **this agent session** was started. Do not use the owner's separate terminal directory.

From that session directory, run `python3 "$HOME/.agents/skills/facilitator/scripts/onboard.py" inspect` for either host. Set the tool's working directory to the session's starting directory if it has since changed. Pass the user's `--board` or `--path` option unchanged. Its JSON result names the lane, port, and absolute `runbook` path. Read that runbook for the shared board protocol and operating rules; it is the maintained source of those rules. This skill only supplies the joining procedure.

- `ready`: join the named lane now. Keep listening in **this conversation**, including when the queue is empty. Do not launch a separate agent, daemon, hook, server, or another listener to do it.
- `down`, `different_board`, or `different_server`: report the board condition. Do not start or replace the server.
- `ambiguous`, `project_unknown`, or `path_missing`: ask which project or path to use. Do not guess a lane.
- `listener_present` or `claim_held`: avoid a second listener. If this conversation already holds the claim, finish it; otherwise report the occupied lane and let the existing listener work.
- `paused` or `ended`: report that the board is not accepting a new listen cycle right now. Do not change the board state.

For each listen cycle, call `python3 "$HOME/.agents/skills/facilitator/scripts/onboard.py" wait --owner OWNER --agent NAME`, with `NAME` identifying this host. The helper uses production `/wait`, immediately confirms a received claim through `/ack`, and returns the confirmed messages. Give the tool call enough time for the board's long poll (up to 560 seconds), resuming a yielded call as needed. On `idle`, call it again. On connection failure, report the loss of the board instead of starting it. Never answer a claim that the helper reports as unconfirmed.

If a later wait reports an occupied, paused, ended, or unavailable board, use the same handling as during inspection. On `ack_failed` or `protocol_error`, stop and report the failure; do not answer an unconfirmed card.

Before answering a held claim, read `/fresh?owner=OWNER` and include any new messages in the answer. Send a complete, self-contained `/reply?box=ID` with the reply text as the request body. If work continues, set `/working?box=ID&v=1`, keep `/ping?box=ID` current, send a full interim `/reply` while the flag is live, then drop the flag with `v=0` only when that work ends. A `/note` releases a held claim and can hide later messages until a full reply, so do not use it for held-claim progress. Continue listening after each reply. Keep the runbook's delegation, reply, and permission rules in view while doing the work; no skill instruction grants permission beyond the current user and host authorization.
