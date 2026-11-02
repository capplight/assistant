"""Turn an incoming Telegram message into a decision: save items / answer a question / nearby.

Pure functions only (no DB, no network) so they are unit-tested directly.
"""

import enum
import re
from dataclasses import dataclass, field

from aiogram.types import Message

from assistant.db.models import ItemKind, ItemSource
from assistant.links import URL_RE, detect_source, extract_urls, url_hash

QUESTION_WORDS = frozenset(
    {
        "что", "где", "как", "когда", "покажи", "найди", "какой", "какая", "какое", "какие",
        "куда", "сколько",
    }
)  # fmt: skip
_FIRST_WORD_RE = re.compile(r"[\w-]+")


def is_question(text: str | None) -> bool:
    if not text:
        return False
    t = text.strip()
    if not t:
        return False
    if t.endswith("?"):
        return True
    m = _FIRST_WORD_RE.search(t)
    return bool(m and m.start() <= 1 and m.group(0).lower() in QUESTION_WORDS)


class Action(enum.StrEnum):
    SAVE = "save"
    QUESTION = "question"
    LOCATION = "location"
    IGNORE = "ignore"


@dataclass
class ItemDraft:
    kind: ItemKind
    source: ItemSource
    raw_text: str | None = None
    url: str | None = None
    url_hash: str | None = None
    telegram_file_id: str | None = None


@dataclass
class Intake:
    action: Action
    drafts: list[ItemDraft] = field(default_factory=list)
    question: str | None = None
    lat: float | None = None
    lon: float | None = None


def strip_urls(text: str | None) -> str | None:
    if not text:
        return None
    rest = URL_RE.sub(" ", text)
    rest = re.sub(r"[ \t]+", " ", rest)
    rest = "\n".join(line.strip() for line in rest.splitlines())
    rest = re.sub(r"\n{3,}", "\n\n", rest).strip()
    return rest or None


def _media(message: Message) -> tuple[ItemKind, str] | None:
    if message.photo:
        return ItemKind.PHOTO, message.photo[-1].file_id  # largest size is last
    if message.video:
        return ItemKind.VIDEO, message.video.file_id
    if message.video_note:
        return ItemKind.VIDEO, message.video_note.file_id
    if message.animation:
        return ItemKind.VIDEO, message.animation.file_id
    if message.document:
        return ItemKind.DOCUMENT, message.document.file_id
    if message.voice:
        return ItemKind.VOICE, message.voice.file_id
    if message.audio:
        return ItemKind.VOICE, message.audio.file_id
    return None


def classify(message: Message) -> Intake:
    """Decide what to do with a message. Never touches the network or DB."""
    if message.location is not None:
        return Intake(
            Action.LOCATION, lat=message.location.latitude, lon=message.location.longitude
        )

    text = message.text or message.caption
    forwarded = message.forward_origin is not None
    own_source = ItemSource.TELEGRAM if forwarded else ItemSource.USER
    urls = extract_urls(text)
    rest = strip_urls(text) if urls else (text.strip() if text and text.strip() else None)
    media = _media(message)

    drafts: list[ItemDraft] = []
    if media is not None:
        kind, file_id = media
        drafts.append(
            ItemDraft(kind=kind, source=own_source, raw_text=rest, telegram_file_id=file_id)
        )

    seen: set[str] = set()
    for url in urls:
        h = url_hash(url)
        if h in seen:
            continue
        seen.add(h)
        drafts.append(
            ItemDraft(
                kind=ItemKind.LINK, source=detect_source(url), raw_text=rest, url=url, url_hash=h
            )
        )

    if drafts:
        return Intake(Action.SAVE, drafts=drafts)

    if rest is None:
        return Intake(Action.IGNORE)
    if not forwarded and is_question(rest):
        return Intake(Action.QUESTION, question=rest)
    return Intake(
        Action.SAVE, drafts=[ItemDraft(kind=ItemKind.TEXT, source=own_source, raw_text=rest)]
    )
