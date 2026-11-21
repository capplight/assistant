"""«Сделай КП для ТОО Ромашка на …» and «сделать документ из этого» in the line (Ф-50). Code only:
the person's own order starts a КП, the same as «Новое КП» on the screen; the КП itself is read
by KP_EXTRACT as always (every number is code's). Text inside records never starts one.
"""

import re
from dataclasses import dataclass

_ORDER = (r"(?:сделай(?:те)?|сделать|составь(?:те)?|составить|подготовь(?:те)?|подготовить|"
          r"создай(?:те)?|создать|сформируй(?:те)?|оформи(?:те)?|напиши(?:те)?|нужно|надо|"
          r"жаса(?:шы|ңыз)?|дайында)")  # fmt: skip
_KP = r"(?:кп|к\.п\.|коммерческое(?:\s+предложение)?|комм\.?\s*предложение|кұ)"
_THIS = (r"(?:из\s+(?:этого\s+файла|этой\s+заявки|этого|этой|него|неё|нее)"
         r"|по\s+(?:этому|этой|нему))")
_HEAD = re.compile(
    rf"^\s*(?:пожалуйста,?\s+)?(?:мне\s+)?(?:(?:надо|нужно)\s+)?{_ORDER}\s+(?:мне\s+)?(?:новое\s+)?"
    rf"(?:(?P<kp>{_KP})|(?P<doc>документ))(?=$|[\s,.:;!—-])(?P<rest>.*)$",
    re.IGNORECASE | re.DOTALL,
)
_KK = re.compile(rf"^\s*(?P<kp>{_KP})\s+(?:жаса|дайында)\w*(?P<rest>.*)$", re.IGNORECASE)
_FROM_THIS = re.compile(rf"^[\s,.:;—-]*{_THIS}(?=$|[\s,.:;!])", re.IGNORECASE)


@dataclass(frozen=True)
class KpPhrase:
    request: str  # the ТЗ in the person's words (may be empty)
    from_this: bool  # «из этого»: the selected / shown record is the ТЗ
    phrase: str  # the whole phrase (kept as the КП's wishes)


def read(text: str) -> KpPhrase | None:
    """A КП order, or None. «документ» counts only with «из этого» (Ф-51: the types of documents
    are not built yet, so a «документ» from a record is a КП for now)."""
    t = " ".join((text or "").split())
    if not t or len(t) > 2000 or t.endswith("?"):
        return None
    m = _HEAD.match(t) or _KK.match(t)
    if m is None:
        return None
    rest = m.group("rest") or ""
    this = _FROM_THIS.match(rest)
    if this is not None:
        rest = rest[this.end():]
    elif m.groupdict().get("doc"):
        return None  # «напиши документ» without a source: not a КП order
    rest = re.sub(r"^[\s,.:;—-]+", "", rest).strip()
    return KpPhrase(request=rest, from_this=this is not None, phrase=t)


# Ф-97: an edit of the open КП («цену светильников 4 500», «убери доставку», «скидка 5% на всё»).
# Sending is never an edit (Ф-95 (4): only the screen sends, after «Да»); deleting the whole КП
# is the record's own delete.
_EDIT = re.compile(r"цен[ауые]|стоимост|скидк|колич|доставк|монтаж|итог|ндс|срок|гаранти|"
                   r"оплат|позици|строк|пункт|добав|убер|убрать|замени|поменяй|измени|исправ|"
                   r"поправ|сделай\s+(?:цену|скидку)|\d|баға|жеңілдік", re.I)  # fmt: skip
_NOT_EDIT = re.compile(r"отправ|пошли|скинь|перешли|удали\s+(?:это|кп|документ|всё|все)\b|"
                       r"^удали$|^\s*(?:что|какая|какой|сколько|почему|когда)\b|\?\s*$|жібер|"
                       # another kind of phrase said while a КП is open: not an edit of it
                       r"напомн|запиш|заметк|потрат|перенеси|встреч|завтра|сегодня|ескерт|"
                       r"(?:^|\s)купил|(?:^|\s)купи(?:ть)?\s",
                       re.I)  # fmt: skip


def edits(text: str) -> bool:
    """A phrase that asks to change the open КП (code's first look; KP_EDIT reads it, code checks
    every number against the phrase)."""
    t = " ".join((text or "").split())
    return bool(t) and len(t) <= 500 and read(t) is None and not _NOT_EDIT.search(t) \
        and bool(_EDIT.search(t))  # fmt: skip
