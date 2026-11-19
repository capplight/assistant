"""`auto_rule`: which items land on a page. Pure code, no model call (spec 3.10).

    {"any": [condition, ...]}   holds when any condition holds; {"any": []} never does
    {"any": [...], "none": [condition, ...]}   (week 10) ... unless one of `none` holds and some
                                               other page of the person takes the record

Conditions: {"always": true} · {"kinds": [...]} · {"envelope_types": [...]} · {"aspects": [...]} ·
{"words": [...]} · {"task_record": true} (week 10: the record of a «Дела» / «Покупки» line;
week 12: also of a «Расходы» line).
A rule with an unknown condition never matches, so an old server reading a newer template places
too little rather than too much.

A "receipt" (2026-11-20) is only a record with a photo or a file behind it: a receipt photo or
screenshot, a PDF, a shared file, an OFD link. A typed or spoken expense («потратил 5000 на донер»)
is a «Расходы» line, never a document: whatever its envelope says, rules read it as a note
(`envelope_type`), and enrichment stores it as one (`records/enrich.py`).
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

_WORD = re.compile(r"\w+", re.UNICODE)
_CONDITIONS = frozenset({"always", "kinds", "envelope_types", "aspects", "words", "task_record"})
# Record kinds that carry a photo / file / link (legacy `photo`, `document` included).
FILE_KINDS = frozenset({"image", "screenshot", "pdf", "docx", "xlsx", "file_other", "link",
                        "photo", "document"})  # fmt: skip
FILE_ONLY_TYPES = frozenset({"receipt"})  # envelope types that need a file behind the record


def file_backed(kind: str | None, source_meta: Mapping[str, Any] | None = None) -> bool:
    """The record has a photo, a file or a fiscal (OFD) link behind it."""
    meta = source_meta if isinstance(source_meta, Mapping) else {}
    return str(kind) in FILE_KINDS or bool(meta.get("fiscal_url") or meta.get("file_name"))


def envelope_type(envelope: Mapping[str, Any] | None, kind: str | None,
                  source_meta: Mapping[str, Any] | None = None) -> str | None:  # fmt: skip
    """The envelope's type as code reads it: a file-less «receipt» is a note."""
    t = (envelope or {}).get("type")
    if not isinstance(t, str):
        return None
    if t in FILE_ONLY_TYPES and not file_backed(kind, source_meta):
        return "note"
    return t


@dataclass(frozen=True)
class ItemFacts:
    """What a rule may look at. Item text is matched as data, it never instructs anything."""

    kind: str
    envelope: Mapping[str, Any] | None = None
    title: str | None = None
    summary: str | None = None
    text: str | None = None
    is_task: bool = False  # a tool row's own record: a task (tasks.item_id), an expense (week 12)
    source_meta: Mapping[str, Any] | None = None  # `fiscal_url` / `file_name`: see file_backed

    @property
    def envelope_type(self) -> str | None:
        return envelope_type(self.envelope, self.kind, self.source_meta)


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
    if name == "task_record":
        return value is True and facts.is_task
    if not isinstance(value, list):
        return False
    if name == "kinds":
        return str(facts.kind) in value
    if name == "envelope_types":
        return bool(facts.envelope) and facts.envelope_type in value
    if name == "aspects":
        return bool(aspects_of(facts.envelope) & set(value))
    if name == "words":
        return _has_word(value, facts)
    return False


def _any(conditions: Any, facts: ItemFacts) -> bool:
    if not isinstance(conditions, list):
        return False
    return any(isinstance(c, Mapping) and _holds(c, facts) for c in conditions)


def excluded(rule: Mapping[str, Any] | None, facts: ItemFacts) -> bool:
    """One of the rule's `none` conditions holds (the record belongs to another kind of page)."""
    return bool(rule) and _any(rule.get("none") or [], facts)  # type: ignore[union-attr]


def matches(rule: Mapping[str, Any] | None, facts: ItemFacts, *, elsewhere: bool = True) -> bool:
    """`elsewhere`: some other page of the person takes the record. Only then does `none` keep it
    off this page, so a record is never left on no page at all (a receipt without «Расходы» stays
    on «Заметки»)."""
    if not rule or not _any(rule.get("any"), facts):
        return False
    return not (elsewhere and excluded(rule, facts))


def is_valid_rule(rule: Any) -> bool:
    """For code that writes `screens.rule` or a new template version."""
    if not isinstance(rule, Mapping) or "any" not in rule or not set(rule) <= {"any", "none"}:
        return False
    return all(isinstance(conditions, list) and all(
        isinstance(c, Mapping) and len(c) == 1 and next(iter(c)) in _CONDITIONS
        for c in conditions) for conditions in rule.values())
