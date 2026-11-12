"""Engine ops of page views (week 11, `assistant.pages.view` plans them):

- `set_view_key` {page, key, value, set_by, change, expect?}: one setting of a page. `key`:
  `layout`, `title` ({title, title_kk}), `icon`, `view.<name>` (a `view_state` key; null removes
  it), `fields` (`field_prefs`), `custom.<field id>` (an own field; null removes it, its values
  stay in `item_facets`). `set_by` is written next to it (`view_state.set_by`, per field). `change`
  is the «Что изменилось» row key: «Вернуть» on that row undoes just this op.
- `set_appearance` {page, item, values: {color?, color_set_by?, pinned?, pinned_set_by?,
  done_at?}, expect?}: a row's colour, «приколоть» and checklist tick (`done_at` ISO or null).
- `set_facet` {page, item, field, value, expect?}: a value of an own field.
- `set_board` {page, item, values: {x, y, z, manual}, expect?} (weeks 16а–16б): a sticker's place
  on the free board (`board_x`, `board_y`, `board_z`, `board_manual`; x as the stored share).
  Never touches the place's clock (`board_ts`), so a stale offline place still loses after an
  undo. Turning the board on (`set_view_key` `view.board` → true, also as an undo) first gives
  the stickers without a place the first free slots (`pages.fill_board`; no inverse: auto places
  are kept, like the rows order).
Each returns its own reverse with `expect` = what it left, so an undo skips what the person
changed since («Часть уже изменена вами»).
"""

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions.engine import Outcome, _items, _links, _screen
from assistant.db.models_pages import (
    MAX_CUSTOM_FIELDS,
    NOTE_COLORS,
    ItemFacet,
    ScreenKind,
    ScreenTemplate,
)
from assistant.pages import fill_board
from assistant.pages import view as views

BOARD_KEYS = {"x": "board_x", "y": "board_y", "z": "board_z", "manual": "board_manual"}
APPEARANCE_KEYS = frozenset({"color", "color_set_by", "pinned", "pinned_set_by", "done_at"})
SET_BY = frozenset({"user", "agent", "template"})


def _who(value: Any) -> str | None:
    return value if value in SET_BY else None


def _get(page: Any, key: str) -> tuple[Any, str | None]:
    vs = page.view_state or {}
    set_by = vs.get("set_by") or {}
    if key == "layout":
        return page.layout, set_by.get("layout")
    if key == "title":
        return {"title": page.title, "title_kk": page.title_kk}, set_by.get("title")
    if key == "icon":
        return page.icon, set_by.get("icon")
    if key == "fields":
        return list(page.field_prefs or []), None
    if key.startswith("view."):
        name = key[5:]
        return vs.get(name), set_by.get(name)
    if key.startswith("custom."):
        fid = key[7:]
        found = next((dict(c) for c in page.custom_fields or [] if str(c.get("id")) == fid), None)
        return found, None
    raise ValueError(f"set_view_key: key not allowed: {key}")


def _set(page: Any, key: str, value: Any, who: str | None) -> bool:
    vs = dict(page.view_state or {})
    set_by = dict(vs.get("set_by") or {})
    name = key[5:] if key.startswith("view.") else key
    if key == "layout":
        page.layout = value
    elif key == "title":
        page.title, page.title_kk = value["title"], value.get("title_kk")
    elif key == "icon":
        page.icon = value
    elif key == "fields":
        page.field_prefs = list(value or [])
        return True
    elif key.startswith("view."):
        if name not in views.VIEW_KEYS:
            raise ValueError(f"set_view_key: view key not allowed: {name}")
        if value is None:
            vs.pop(name, None)
        else:
            vs[name] = value
    elif key.startswith("custom."):
        fid = key[7:]
        cur = [dict(c) for c in page.custom_fields or []]
        idx = next((i for i, c in enumerate(cur) if str(c.get("id")) == fid), None)
        if value is None:
            if idx is not None:
                cur.pop(idx)
        elif idx is not None:
            cur[idx] = dict(value)
        elif len(cur) >= MAX_CUSTOM_FIELDS:
            return False  # no room any more (the person added fields since)
        else:
            cur.append(dict(value))
        page.custom_fields = cur
        return True
    if who is None or who == "template":
        set_by.pop(name, None)
    else:
        set_by[name] = who
    if set_by:
        vs["set_by"] = set_by
    else:
        vs.pop("set_by", None)
    page.view_state = vs
    return True


async def _set_view_key(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                        by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    if page is None or page.kind == ScreenKind.SYSTEM_TODAY:
        out.skipped += 1
        return
    key = str(op["key"])
    cur, cur_by = _get(page, key)
    if check and "expect" in op and cur != op["expect"]:
        out.skipped += 1  # the person changed this setting since: theirs stays
        return
    value = op.get("value")
    who = _who(op.get("set_by"))
    if cur == value and (None if who == "template" else who) == cur_by:
        return
    if not _set(page, key, value, who):
        out.skipped += 1
        return
    out.inverse.append({"op": "set_view_key", "page": str(page.public_id), "key": key,
                        "value": cur, "set_by": cur_by or "template", "expect": value,
                        **({"change": op["change"]} if op.get("change") else {})})  # fmt: skip
    if key == "view.board" and value and page.template_key == "notes":
        await session.flush()
        out.items.update(await fill_board(session, page))
    template = await session.get(ScreenTemplate, (page.template_key, page.template_version))
    if template is not None:
        page.customized = views.is_customized(page, template)
    page.updated_at = now
    if key not in ("title", "icon"):  # a rename is not a new view (pages.md: view_version)
        out.pages.add(page.id)


async def _set_appearance(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                          by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if not values or set(values) - APPEARANCE_KEYS:
        raise ValueError("set_appearance: fields not allowed")
    if values.get("color") is not None and values["color"] not in NOTE_COLORS:
        raise ValueError("set_appearance: colour not allowed")
    page = await _screen(session, user_id, op["page"])
    item = (await _items(session, user_id, [op["item"]])).get(str(op["item"]))
    link = (await _links(session, page.id, [item.id])).get(item.id) if page and item else None
    if link is None:
        out.skipped += 1
        return
    app = dict(link.appearance or {})

    def cur_of(k: str) -> Any:
        if k == "done_at":  # the checklist tick, ISO text in ops
            return link.done_at.isoformat() if link.done_at else None
        return link.pinned if k == "pinned" else app.get(k)

    cur = {k: cur_of(k) for k in values}
    expect = op.get("expect")
    if check and expect and any(cur_of(k) != v for k, v in expect.items()):
        out.skipped += 1
        return
    changed = {k: v for k, v in values.items() if cur[k] != v}
    if not changed:
        return
    out.inverse.append({"op": "set_appearance", "page": str(page.public_id),  # type: ignore[union-attr]
                        "item": str(item.public_id), "values": {k: cur[k] for k in changed},  # type: ignore[union-attr]
                        "expect": changed})  # fmt: skip
    for k, v in changed.items():
        if k == "pinned":
            link.pinned = bool(v)
        elif k == "done_at":
            link.done_at = datetime.fromisoformat(v) if v else None
        elif v is None:
            app.pop(k, None)
        else:
            app[k] = v
    link.appearance = app
    link.updated_at = now
    out.items.add(str(item.public_id))  # type: ignore[union-attr]
    out.pages.add(page.id)  # type: ignore[union-attr]


async def _set_facet(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                     by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    item = (await _items(session, user_id, [op["item"]])).get(str(op["item"]))
    if page is None or item is None:
        out.skipped += 1
        return
    name = str(op["field"])
    row = await session.scalar(select(ItemFacet).where(ItemFacet.screen_id == page.id,
                                                       ItemFacet.item_id == item.id)
                               .with_for_update())  # fmt: skip
    cur = (row.data or {}).get(name) if row is not None else None
    if check and "expect" in op and cur != op["expect"]:
        out.skipped += 1
        return
    value = op.get("value")
    if cur == value:
        return
    if row is None:
        row = ItemFacet(user_id=user_id, item_id=item.id, screen_id=page.id, data={})
        session.add(row)
    data = dict(row.data or {})
    if value is None:
        data.pop(name, None)
    else:
        data[name] = value
    row.data = data
    row.updated_by = "agent" if by == "agent" else "user"
    row.updated_at = now
    out.inverse.append({"op": "set_facet", "page": str(page.public_id),
                        "item": str(item.public_id), "field": name, "value": cur,
                        "expect": value})  # fmt: skip
    out.items.add(str(item.public_id))


def board_state(link: Any) -> dict[str, Any]:
    return {"x": link.board_x, "y": link.board_y, "z": link.board_z,
            "manual": bool(link.board_manual)}  # fmt: skip


async def _set_board(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                     by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if not values or set(values) - set(BOARD_KEYS):
        raise ValueError("set_board: fields not allowed")
    page = await _screen(session, user_id, op["page"])
    item = (await _items(session, user_id, [op["item"]])).get(str(op["item"]))
    link = (await _links(session, page.id, [item.id])).get(item.id) if page and item else None
    if link is None:
        out.skipped += 1
        return
    cur = board_state(link)
    expect = op.get("expect")
    if check and expect and any(cur.get(k) != v for k, v in expect.items()):
        out.skipped += 1  # the person moved it again since: their place stays
        return
    changed = {k: v for k, v in values.items() if cur[k] != v}
    if not changed:
        return
    out.inverse.append({"op": "set_board", "page": str(page.public_id),  # type: ignore[union-attr]
                        "item": str(item.public_id), "values": {k: cur[k] for k in changed},  # type: ignore[union-attr]
                        "expect": changed})  # fmt: skip
    for k, v in changed.items():
        setattr(link, BOARD_KEYS[k], bool(v) if k == "manual" else v)
    link.updated_at = now
    out.items.add(str(item.public_id))  # type: ignore[union-attr]
    out.pages.add(page.id)  # type: ignore[union-attr]


HANDLERS = {
    "set_board": _set_board,
    "set_view_key": _set_view_key,
    "set_appearance": _set_appearance,
    "set_facet": _set_facet,
}
