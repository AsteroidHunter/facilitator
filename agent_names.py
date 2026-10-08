"""Which agent a name belongs to, in one place for the board (server.py, when a
reply is stored) and the daily usage counts (usage_counts.py, when they are
counted), so the two cannot drift apart."""

from __future__ import annotations

# claude is checked first, so a name matching both lists is claude
AGENTS = (("claude", ("claude", "opus", "sonnet", "haiku", "fable")),
          ("codex", ("codex", "gpt", "astra")))


def agent_kind(name) -> str:
    """claude, codex or other, from the name a lane's agent gave on /wait."""
    said = str(name or "").lower()
    for agent, words in AGENTS:
        if any(word in said for word in words):
            return agent
    return "other"
