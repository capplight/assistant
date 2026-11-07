"""`auto_rule`: which items land on a page. Pure code, no model call (spec 3.10).

    {"any": [condition, ...]}   holds when any condition holds; {"any": []} never does

Conditions: {"always": true} · {"kinds": [...]} · {"envelope_types": [...]} · {"aspects": [...]} ·
{"words": [...]}. A rule with an unknown condition never matches, so an old server reading a newer
template places too little rather than too much.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

_WORD = re.compile(r"\w+", re.UNICODE)
_CONDITIONS = frozenset({"always", "kinds", "envelope_types", "aspects", "words"})


@dataclass(frozen=True)
class ItemFacts:
    """What a rule may look at. Item text is matched as data, it never instructs anything."""

    kind: str
    envelope: Mapping[str, Any] | None = None
    title: str | None = None
    summary: str | None = None
    text: str | None = None


def _non_empty(value: Any) -> bool:
    return isinstance(value, list | dict | str) and len(value) > 0


def aspects_of(envelope: Mapping[str, Any] | None) -> frozenset[str]:
    """The parts an envelope has. `proposed` and `entities` come from ENRICH (spec 6.2)."""
    if not envelope:
        return frozenset()
    proposed = envelope.get("proposed")
    entities = envelope.get("entities")
    proposed = proposed if isinstance(proposed, Mapping) else {}
    entities = entities if isinstance(entities, Mapping) else {}
    found = set()
    for aspect, value in (
        ("reminder", proposed.get("reminders")),
        ("task", proposed.get("tasks")),
        ("kp", proposed.get("kp")),
        ("amount", entities.get("amounts")),
    ):
        if _non_empty(value):
            found.add(aspect)
    return frozenset(found)


def _has_word(words: list, facts: ItemFacts) -> bool:
    haystack = " ".join(part for part in (facts.title, facts.summary, facts.text) if part)
    tokens = {token.casefold() for token in _WORD.findall(haystack)}
    wanted = [word.casefold() for word in words if isinstance(word, str) and word.strip()]
    # By prefix, so «ремонт» also finds «ремонта» and «ремонту».
    return any(token.startswith(word) for word in wanted for token in tokens)


def _holds(condition: Mapping[str, Any], facts: ItemFacts) -> bool:
    if len(condition) != 1:
        return False
    name, value = next(iter(condition.items()))
    if name == "always":
        return value is True
    if not isinstance(value, list):
        return False
    if name == "kinds":
        return str(facts.kind) in value
    if name == "envelope_types":
        return bool(facts.envelope) and facts.envelope.get("type") in value
    if name == "aspects":
        return bool(aspects_of(facts.envelope) & set(value))
    if name == "words":
        return _has_word(value, facts)
    return False


def matches(rule: Mapping[str, Any] | None, facts: ItemFacts) -> bool:
    if not rule:
        return False
    conditions = rule.get("any")
    if not isinstance(conditions, list):
        return False
    return any(isinstance(c, Mapping) and _holds(c, facts) for c in conditions)


def is_valid_rule(rule: Any) -> bool:
    """For code that writes `screens.rule` or a new template version."""
    if not isinstance(rule, Mapping) or set(rule) != {"any"}:
        return False
    conditions = rule["any"]
    return isinstance(conditions, list) and all(
        isinstance(c, Mapping) and len(c) == 1 and next(iter(c)) in _CONDITIONS
        for c in conditions
    )
