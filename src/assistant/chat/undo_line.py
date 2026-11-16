"""Undo by phrase (Ф-67, Ф-73; vision-2026-11-review §5.1): «верни как было», «отмени», «не туда»,
«отмени всё», «верни запись про хлеб» — for any action, not only a page view.

Code only, no model. Which action:
- no words about what: the assistant's newest change of the last 24 hours, with every other
  action of the same phrase (one phrase = one «Отменить всё»; today a phrase writes one action,
  step 6 «несколько действий за фразу» keeps several under one `message_id`, undone together);
- with words («про хлеб», «с плиткой»): the newest undoable action of the last 30 days, the
  person's or the assistant's, whose summary or «Что изменилось» rows have those words (a word
  matches by its stem: «хлебом» finds «Хлеб»).
Each target is undone with `actions.undo` (the same inverse as «Отменить», idempotent per answer:
a rerun of this answer returns the first result). The answer says what was undone.
"""

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import ActionNotFound, UndoExpired, UndoResult, undo
from assistant.chat.intent import UndoPhrase
from assistant.db.models_actions import Action, Initiator

LAST_HOURS = 24  # «отмени» without words: only a fresh change of the assistant
SCAN = 200  # newest actions looked at
_WORD = re.compile(r"\w+")

TEXT_NOTHING = {"ru": "Не нашёл, что отменить. В «Истории» можно отменить любое действие.",
                "kk": "Не нашёл, что отменить. В «Истории» можно отменить любое действие."}
TEXT_NOT_FOUND = {"ru": "Не нашёл недавнего действия про «{about}». В «Истории» можно отменить "
                        "любое действие.",
                  "kk": "Не нашёл недавнего действия про «{about}». В «Истории» можно отменить "
                        "любое действие."}  # fmt: skip  # kk: until reviewed (R-39)
TEXT_PARTIAL = " Часть вы уже изменили сами — её оставил."


def _norm(text: str) -> str:
    return " ".join(text.lower().replace("ё", "е").split())


def _stem(word: str) -> str:
    """A crude Russian stem: «хлебом» → «хлеб», «плитку» → «плит»."""
    return word if len(word) <= 4 else word[:max(4, len(word) - 2)]


def _haystack(a: Action) -> str:
    parts = [(a.summary or {}).get("ru") or ""]
    for c in ((a.payload or {}).get("changes") or [])[:100]:
        parts += [str(c.get("title") or ""), str(c.get("text") or "")]
    return _norm(" ".join(parts))


def score(a: Action, about: tuple[str, ...]) -> float:
    words = [w for w in about if len(w) >= 2]
    if not words:
        return 0.0
    hay = set(_WORD.findall(_haystack(a)))
    hits = sum(any(h.startswith(_stem(w)) for h in hay) for w in words)
    return hits / len(words)


async def find_targets(session: AsyncSession, user_id: int, phrase: UndoPhrase,
                       now: datetime) -> list[Action]:  # fmt: skip
    """The actions to undo, newest first ([] = nothing fits)."""
    rows = list(await session.scalars(
        select(Action).where(Action.user_id == user_id, Action.undone_at.is_(None),
                             Action.undo_of_action_id.is_(None),
                             Action.undoable_until > now)
        .order_by(Action.id.desc()).limit(SCAN)))  # fmt: skip
    rows = [a for a in rows if a.inverse]
    if phrase.about:
        best: Action | None = None
        best_score = 0.0
        for a in rows:  # newest first: a tie keeps the newer one
            sc = score(a, phrase.about)
            if sc > best_score:
                best, best_score = a, sc
        return [best] if best is not None else []
    fresh = [a for a in rows if a.initiated_by == Initiator.AGENT
             and a.created_at >= now - timedelta(hours=LAST_HOURS)]  # fmt: skip
    if not fresh:
        return []
    last = fresh[0]
    if last.message_id is None:
        return [last]
    return [a for a in fresh if a.message_id == last.message_id]


@dataclass
class Undone:
    results: list[UndoResult] = field(default_factory=list)
    partial: bool = False
    pages: set[int] = field(default_factory=set)
    items: set[str] = field(default_factory=set)


async def undo_targets(session: AsyncSession, user_id: int, targets: list[Action], *,
                       reply_id: uuid.UUID, now: datetime) -> Undone:  # fmt: skip
    out = Undone()
    for a in targets:
        try:
            res = await undo(session, user_id, a.public_id, now=now,
                             client_id=uuid.uuid5(reply_id, str(a.public_id)))  # fmt: skip
        except (ActionNotFound, UndoExpired):
            continue
        out.results.append(res)
        out.partial |= res.partial
        out.pages |= res.pages
        out.items |= res.items
    return out


def answer_text(done: Undone, phrase: UndoPhrase, lang: str) -> str:
    if not done.results:
        if phrase.about:
            return TEXT_NOT_FOUND[lang].format(about=" ".join(phrase.about)[:40])
        return TEXT_NOTHING[lang]
    said = []
    for r in done.results:
        ru = ((r.action.summary or {}).get("ru") or "").strip().rstrip(".")
        if ru:
            said.append(ru[:1].lower() + ru[1:])
    text_ = "Вернул как было" + (": " + "; ".join(said) + "." if said else ".")
    return text_ + (TEXT_PARTIAL if done.partial else "")
