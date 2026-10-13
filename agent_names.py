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


# the class a card's ticket names, first match wins. astra is checked before
# codex and gpt so a name carrying both is the more specific one
CLASSES = (("opus", ("opus",)), ("sonnet", ("sonnet",)), ("astra", ("astra",)),
           ("haiku", ("haiku",)), ("codex", ("codex", "gpt")))


def agent_class(name) -> str:
    """The model's class name for an agent's stated name: opus, sonnet, astra,
    haiku or codex when the name says so ("claude-opus" is opus), otherwise the
    name as it was given ("claude-code" stays), lower-cased and trimmed. Empty
    when no name was given."""
    said = str(name or "").strip().lower()
    for agent, words in CLASSES:
        if any(word in said for word in words):
            return agent
    return said
