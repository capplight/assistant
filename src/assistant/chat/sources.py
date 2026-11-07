"""Sources of one chat turn: what the model was shown, under short refs it can cite.

The model never sees database ids or uuids: pages are `p1`, `p2`, ...; records are `s1`, `s2`,
... Citations are accepted only for refs issued here, so a citation always points to a record of
this person that the model really saw. Each source keeps the facts (numbers, dates) of exactly
the text that was shown, for the check in verify.py.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from assistant.chat.verify import Facts, facts_of, short_date

SNIPPET_CHARS = 200


@dataclass
class PageInfo:
    pk: int
    id: uuid.UUID
    ref: str
    title: str
    icon: str
    template_key: str
    item_count: int = 0
    last_title: str | None = None

    def out(self) -> dict[str, Any]:
        return {"id": str(self.id), "title": self.title, "icon": self.icon}


@dataclass
class Source:
    ref: str
    pk: int
    item_id: uuid.UUID
    title: str
    kind: str
    occurred_at: datetime | None
    created_at: datetime
    pages: list[PageInfo]
    shown: list[str] = field(default_factory=list)  # every text of it the model saw
    facts: Facts = field(default_factory=Facts)

    @property
    def when(self) -> datetime:
        return self.occurred_at or self.created_at


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def title_of(title: str | None, body: str | None) -> str:
    if title and title.strip():
        return " ".join(title.split())[:120]
    first = " ".join((body or "").split())
    return (first[:60] + "…") if len(first) > 60 else (first or "Запись")


def snippet_of(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= SNIPPET_CHARS else flat[:SNIPPET_CHARS - 1].rstrip() + "…"


class SourceBook:
    def __init__(self, tz: str, current_page: PageInfo | None = None) -> None:
        self.tz = ZoneInfo(tz)
        self.current = current_page
        self.pages: dict[str, PageInfo] = {}
        self._page_by_pk: dict[int, PageInfo] = {}
        self._by_ref: dict[str, Source] = {}
        self._by_pk: dict[int, Source] = {}
        self._announced: set[str] = set()
        self._next = 1

    # --- pages ---

    def add_page(self, pk: int, public_id: uuid.UUID, title: str, icon: str, template_key: str,
                 item_count: int = 0, last_title: str | None = None) -> PageInfo:  # fmt: skip
        if pk in self._page_by_pk:
            return self._page_by_pk[pk]
        info = PageInfo(pk, public_id, f"p{len(self.pages) + 1}", title, icon, template_key,
                        item_count, last_title)  # fmt: skip
        self.pages[info.ref] = info
        self._page_by_pk[pk] = info
        return info

    def page(self, ref: str | None) -> PageInfo | None:
        return self.pages.get(ref.strip().lower()) if ref else None

    def page_by_pk(self, pk: int) -> PageInfo | None:
        return self._page_by_pk.get(pk)

    # --- sources ---

    def add(self, *, pk: int, item_id: uuid.UUID, title: str | None, body: str, kind: str,
            occurred_at: datetime | None, created_at: datetime,
            page_pks: list[int]) -> Source:  # fmt: skip
        """Register a record and the text of it the model is about to see (merged when the same
        record comes again through another tool)."""
        src = self._by_pk.get(pk)
        if src is None:
            pages = [p for p in (self._page_by_pk.get(x) for x in page_pks) if p is not None]
            src = Source(f"s{self._next}", pk, item_id, title_of(title, body), kind,
                         _aware(occurred_at) if occurred_at else None, _aware(created_at),
                         pages)  # fmt: skip
            self._next += 1
            self._by_ref[src.ref] = src
            self._by_pk[pk] = src
            local = src.when.astimezone(self.tz)
            meta = Facts()
            meta.add_date(local)
            src.facts.update(meta)
        src.shown.append(body)
        src.facts.update(facts_of(src.title, body))
        return src

    def discard(self, ref: str) -> None:
        """Forget a source the model will not see after all (cut by the context budget)."""
        src = self._by_ref.pop(ref, None)
        if src is not None:
            self._by_pk.pop(src.pk, None)
            self._announced.discard(ref)

    def get(self, ref: str) -> Source | None:
        return self._by_ref.get(ref.strip().lower())

    def by_pk(self, pk: int) -> Source | None:
        return self._by_pk.get(pk)

    def __len__(self) -> int:
        return len(self._by_ref)

    def all(self) -> list[Source]:
        return list(self._by_ref.values())

    def facts(self) -> dict[str, Facts]:
        return {ref: s.facts for ref, s in self._by_ref.items()}

    def take_new(self) -> list[Source]:
        """Sources not yet sent to the phone (`sources` event)."""
        new = [s for ref, s in self._by_ref.items() if ref not in self._announced]
        self._announced.update(s.ref for s in new)
        return new

    # --- output ---

    def date_text(self, src: Source) -> str:
        local = src.when.astimezone(self.tz)
        return f"{short_date(local)} {local.year}"

    def open_page(self, src: Source) -> PageInfo | None:
        if self.current is not None and any(p.pk == self.current.pk for p in src.pages):
            return self.current
        return src.pages[0] if src.pages else None

    def label(self, src: Source) -> str:
        page = self.open_page(src)
        when = short_date(src.when.astimezone(self.tz))
        return f"{page.title} · {src.title}, {when}" if page else f"{src.title}, {when}"

    def source_out(self, src: Source) -> dict[str, Any]:
        page = self.open_page(src)
        return {
            "ref": src.ref, "item_id": str(src.item_id), "title": src.title,
            "snippet": snippet_of(src.shown[0] if src.shown else ""), "kind": src.kind,
            "occurred_at": src.occurred_at.isoformat() if src.occurred_at else None,
            "created_at": src.created_at.isoformat(),
            "page": page.out() if page else None, "pages": [p.out() for p in src.pages],
        }  # fmt: skip

    def citation_out(self, src: Source) -> dict[str, Any]:
        page = self.open_page(src)
        return {
            "ref": src.ref, "item_id": str(src.item_id), "chunk_id": None,
            "page": page.out() if page else None, "title": src.title, "label": self.label(src),
            "occurred_at": src.occurred_at.isoformat() if src.occurred_at else None,
        }  # fmt: skip
