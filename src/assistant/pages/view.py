"""`set_view`: one function for every change of a page's view (week 11; R-51 extended, Ф-30, Ф-31,
proposal template-screens §2.8). S38 «Настроить страницу» (by hand) and the assistant's `set_view`
tool both plan their change here, so the white list, the ★ rule and «ваше — ваше» are checked in
one place, in code.

What is a view: layout (from the template's list; `list` = «Простой список» everywhere), the
rows / board mode of «Заметки», sorting, grouping and filters by field, the period of «Расходы»,
the «Сегодня» tile, the visible fields and their order, the page's own fields (≤5), sticker
colours and «приколоть», the page name and icon. Records, sums and dates are not a view.

Who set what (`set_by`: user | agent | template; missing = template):
- `view_state.set_by[<name>]` for the layout and the `view_state` keys;
- `field_prefs[].set_by` per field; `custom_fields[].set_by`;
- `screen_items.appearance.color_set_by` / `pinned_set_by` per row.

The plan never writes. It returns engine ops (`set_view_key`, `set_appearance`) and the rows of
«Что изменилось»; the caller applies them in its transaction and writes one action. For the
assistant (`by="agent"`) it also says what needs the person's «Да»:
- `manual`: settings the person set by hand (and a sort that would hide their manual order);
  `confirm_manual=None` asks, `True` includes them, `False` («Оставить мои») leaves them;
- `count` (more than 150 records), `remove_field`, `reset`: one «Да» (`confirmed=True`).
Never: hiding a ★ field, a layout outside the template's list. The person by hand is never asked
by the server (S38 shows S25 itself before «Вернуть как было»).
"""

import re
import secrets
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item
from assistant.db.models_pages import (
    MAX_CUSTOM_FIELDS,
    NOTE_COLORS,
    Screen,
    ScreenItem,
    ScreenKind,
    ScreenTemplate,
)

COUNT_ASK_ABOVE = 150
VIEW_KEYS = ("board", "sort", "sort_dir", "group_by", "filters", "period", "today_tile")
CUSTOM_TYPES = ("text", "number", "money", "date", "bool")
SORT_DIRS = ("asc", "desc")
PERIODS = ("week", "month", "year")
TODAY_TILES = ("auto", "pinned", "hidden")
FILTER_OPS = ("eq", "empty", "not_empty")
MAX_FILTERS = 5
FIELD_TITLE_CHARS = 40
CLIENT_FIELD_ID = re.compile(r"c_[0-9a-z_-]{4,40}")  # an own field id the phone made offline
NOT_SORTABLE = ("long_text",)
NOT_GROUPABLE = ("long_text", "number", "money", "datetime", "link")
ICONS = ("people", "documents", "shopping", "money", "health", "home", "work", "other")

LAYOUT_RU = {"list": "Простой список", "checklist": "Чек-лист", "table": "Таблица",
             "stacks": "Пачки", "builtin:notes_board": "Стикеры", "builtin:tasks": "Дела",
             "builtin:planner": "Ежедневник", "builtin:shopping": "Список покупок",
             "builtin:kp": "Картотека", "builtin:expenses": "Расходы",
             "builtin:today": "Сегодня"}  # fmt: skip
TYPE_RU = {"text": "Текст", "number": "Число", "money": "Сумма ₸", "date": "Дата",
           "bool": "Галочка"}  # fmt: skip
COLOR_RU = {"yellow": "жёлтый", "pink": "розовый", "green": "зелёный", "blue": "голубой",
            "peach": "персиковый", "white": "белый"}  # fmt: skip
PERIOD_RU = {"week": "неделя", "month": "месяц", "year": "год"}
TILE_RU = {"auto": "само", "pinned": "всегда показывать", "hidden": "не показывать"}


class ViewError(Exception):
    """A change outside the white list: `code` is the API error code."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


@dataclass
class ViewChange:
    """What to change; everything optional. `view` holds the `view_state` keys that were given
    (None = back to the template's value). Records are named by public id (str)."""

    layout: str | None = None
    view: dict[str, Any] = field(default_factory=dict)
    title: str | None = None
    icon: str | None = None
    fields: list[dict[str, Any]] | None = None  # the whole order: [{field_id, visible}]
    show: list[str] = field(default_factory=list)
    hide: list[str] = field(default_factory=list)
    order_first: list[str] = field(default_factory=list)  # these fields first, in this order
    add_fields: list[dict[str, Any]] = field(default_factory=list)  # [{title, type}]
    rename_fields: list[dict[str, Any]] = field(default_factory=list)  # [{field_id, title}]
    remove_fields: list[str] = field(default_factory=list)
    colors: dict[str, str | None] = field(default_factory=dict)  # item id -> colour (None: none)
    pins: dict[str, bool] = field(default_factory=dict)
    reset: bool = False

    def empty(self) -> bool:
        return not (self.layout or self.view or self.title or self.icon or self.fields is not None
                    or self.show or self.hide or self.order_first or self.add_fields
                    or self.rename_fields or self.remove_fields or self.colors or self.pins
                    or self.reset)  # fmt: skip


@dataclass
class Plan:
    ops: list[dict[str, Any]] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    asks: dict[str, int] = field(default_factory=dict)  # manual | count | remove_field | reset
    manual_kinds: set[str] = field(default_factory=set)  # color | order | setting
    kept_mine: int = 0  # «Оставить мои»: settings of the person left as they are
    removed_titles: list[str] = field(default_factory=list)
    sentence: str = ""
    records: int = 0  # rows whose colour / pin changes

    def needs(self, *, confirm_manual: bool | None, confirmed: bool) -> str | None:
        """What to ask first, or None when the plan may run as it is."""
        if not confirmed:
            for kind in ("reset", "remove_field", "count"):
                if self.asks.get(kind):
                    return kind
        if confirm_manual is None and self.asks.get("manual"):
            return "manual"
        return None


# --- fields ---


def effective_fields(template_fields: list[dict[str, Any]], custom_fields: list[dict[str, Any]],
                     prefs: list[dict[str, Any]]) -> list[dict[str, Any]]:  # fmt: skip
    """The page's fields in display order: template fields, then its own. ★ always visible.
    A field the prefs don't name (new in a template version) goes last with its default."""
    base = []
    for f in template_fields:
        required = bool(f.get("required"))
        title = f.get("title") or {}
        base.append({"id": str(f["id"]), "title": title.get("ru") if isinstance(title, dict)
                     else str(title), "type": f.get("type", "text"), "required": required,
                     "visible": required or bool(f.get("default_visible", True)),
                     "custom": False, "set_by": "template"})  # fmt: skip
    for c in custom_fields:
        base.append({"id": str(c["id"]), "title": c.get("title", ""), "type": c.get("type", "text"),
                     "required": False, "visible": True, "custom": True,
                     "set_by": c.get("set_by") or "user"})  # fmt: skip
    if not prefs:
        return base
    by_id = {f["id"]: f for f in base}
    out = []
    for p in prefs:
        f = by_id.pop(str(p.get("field_id")), None)
        if f is None:
            continue
        out.append({**f, "visible": f["required"] or bool(p.get("visible", True)),
                    "set_by": p.get("set_by") or f["set_by"]})  # fmt: skip
    return [*out, *by_id.values()]


def prefs_of(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"field_id": f["id"], "visible": f["visible"], "set_by": f["set_by"]} for f in fields]


def _shape(fields: list[dict[str, Any]]) -> list[tuple[str, bool]]:
    return [(f["id"], f["visible"]) for f in fields]


def _norm(text: str) -> str:
    return " ".join(str(text).lower().replace("ё", "е").split())


def find_field(fields: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    """By id, then by title (case and «ё» ignored), then by the start of a title."""
    key = _norm(name)
    for f in fields:
        if f["id"] == name or _norm(f["id"]) == key:
            return f
    for f in fields:
        if _norm(f["title"] or "") == key:
            return f
    hits = [f for f in fields if key and _norm(f["title"] or "").startswith(key)]
    return hits[0] if len(hits) == 1 else None


def _q(text: str) -> str:
    return f"«{text}»"


def _sort_ru(value: Any, fields: list[dict[str, Any]]) -> str:
    if value in (None, "position"):
        return "ваш порядок"
    if value == "date":
        return "по дате"
    f = find_field(fields, str(value))
    return f"по полю {_q(f['title'])}" if f else str(value)


def _group_ru(value: Any, fields: list[dict[str, Any]]) -> str:
    if not value:
        return "нет"
    f = find_field(fields, str(value))
    return f"по полю {_q(f['title'])}" if f else str(value)


# --- planning ---


def _check_view_value(name: str, value: Any, template: ScreenTemplate, layout: str,
                      fields: list[dict[str, Any]]) -> Any:  # fmt: skip
    """The value to store (normalized), or ViewError. None = back to the template."""
    if value is None:
        return None
    if name == "board":
        if template.key != "notes" or not isinstance(value, bool):
            raise ViewError("validation_error", "board: only «Заметки», true or false")
        return value
    if name == "sort":
        if value in ("position", "date"):
            return value
        f = find_field(fields, str(value))
        if f is None:
            raise ViewError("field_unknown", f"sort: no field {value}")
        if f["type"] in NOT_SORTABLE:
            raise ViewError("validation_error", "sort: this field cannot be sorted")
        return f["id"]
    if name == "sort_dir":
        if value not in SORT_DIRS:
            raise ViewError("validation_error", "sort_dir: asc or desc")
        return value
    if name == "group_by":
        f = find_field(fields, str(value))
        if f is None:
            raise ViewError("field_unknown", f"group_by: no field {value}")
        if f["type"] in NOT_GROUPABLE:
            raise ViewError("validation_error", "group_by: this field cannot group")
        return f["id"]
    if name == "filters":
        if not isinstance(value, list) or len(value) > MAX_FILTERS:
            raise ViewError("validation_error", "filters: a list of at most 5")
        out = []
        for flt in value:
            f = find_field(fields, str((flt or {}).get("field", "")))
            op = (flt or {}).get("op", "eq")
            if f is None:
                raise ViewError("field_unknown", "filters: unknown field")
            if op not in FILTER_OPS:
                raise ViewError("validation_error", "filters: op eq | empty | not_empty")
            item: dict[str, Any] = {"field": f["id"], "op": op}
            if op == "eq":
                v = flt.get("value")
                ok = isinstance(v, str | int | float | bool)
                if not ok or isinstance(v, str) and len(v) > 100:
                    raise ViewError("validation_error", "filters: value")
                item["value"] = v
            out.append(item)
        return out or None
    if name == "period":
        if template.key != "expenses" or value not in PERIODS:
            raise ViewError("validation_error", "period: «Расходы» only, week | month | year")
        return value
    if name == "today_tile":
        if value not in TODAY_TILES:
            raise ViewError("validation_error", "today_tile: auto | pinned | hidden")
        return value
    raise ViewError("validation_error", f"unknown view key {name}")


def _view_text(name: str, old: Any, new: Any, fields: list[dict[str, Any]]) -> str:
    if name == "board":
        return f"Стикеры: {'Доска' if old else 'Ряды'} → {'Доска' if new else 'Ряды'}"
    if name == "sort":
        return f"Сортировка: {_sort_ru(old, fields)} → {_sort_ru(new, fields)}"
    if name == "sort_dir":
        word = {"asc": "по возрастанию", "desc": "по убыванию", None: "как было"}
        return f"Порядок сортировки: {word.get(old, old)} → {word.get(new, new)}"
    if name == "group_by":
        return f"Группировка: {_group_ru(old, fields)} → {_group_ru(new, fields)}"
    if name == "filters":
        return "Фильтр убран" if not new else "Фильтр изменён"
    if name == "period":
        return f"Период: {PERIOD_RU.get(old, 'как было')} → {PERIOD_RU.get(new, 'как было')}"
    return f"На «Сегодня»: {TILE_RU.get(old, 'само')} → {TILE_RU.get(new, 'само')}"


async def plan_view(session: AsyncSession, page: Screen, template: ScreenTemplate,
                    change: ViewChange, *, by: str, confirm_manual: bool | None = None,
                    confirmed: bool = False) -> Plan:  # fmt: skip
    """Check `change` against the white list and turn it into engine ops. Raises ViewError."""
    if page.kind == ScreenKind.SYSTEM_TODAY:
        raise ViewError("page_system")
    agent = by == "agent"
    plan = Plan()
    pid = str(page.public_id)
    vs = dict(page.view_state or {})
    set_by = dict(vs.get("set_by") or {})
    cur_fields = effective_fields(template.fields or [], page.custom_fields or [],
                                  page.field_prefs or [])  # fmt: skip
    new_fields = [dict(f) for f in cur_fields]

    def row(key: str, text: str, kind: str = "view") -> None:
        plan.changes.append({"item_id": None, "key": f"{pid}:{key}", "title": page.title,
                             "kind": kind, "page_id": pid, "text": text})  # fmt: skip

    def keep(manual: bool, n: int = 1, kind: str = "setting") -> bool:
        """False: leave this part out («Оставить мои»)."""
        if not (agent and manual):
            return True
        plan.manual_kinds.add(kind)
        if confirm_manual is False:
            plan.kept_mine += n
            return False
        if confirm_manual is None:
            plan.asks["manual"] = plan.asks.get("manual", 0) + n
        return True

    def key_op(key: str, value: Any, text: str, kind: str = "view") -> None:
        who = "template" if change.reset else by  # «Вернуть как было»: nobody set it now
        plan.ops.append({"op": "set_view_key", "page": pid, "key": key, "value": value,
                         "set_by": who, "change": f"{pid}:{key}"})  # fmt: skip
        row(key, text, kind)

    if change.reset:
        if not change.empty() and any((change.layout, change.view, change.title, change.icon,
                                       change.fields is not None, change.show, change.hide,
                                       change.add_fields, change.remove_fields, change.colors,
                                       change.pins)):  # fmt: skip
            raise ViewError("validation_error", "reset goes alone")
        if agent:
            plan.asks["reset"] = 1
        if page.layout != template.default_layout:
            key_op("layout", template.default_layout,
                   f"Вид: {LAYOUT_RU.get(page.layout, page.layout)} → "
                   f"{LAYOUT_RU.get(template.default_layout, template.default_layout)}")
        default = dict(template.default_view or {})
        for name in VIEW_KEYS:
            if vs.get(name) != default.get(name):
                key_op(f"view.{name}", default.get(name),
                       _view_text(name, vs.get(name), default.get(name), cur_fields))
        for c in page.custom_fields or []:
            plan.removed_titles.append(c.get("title", ""))
            key_op(f"custom.{c['id']}", None,
                   f"Скрыл поле {_q(c.get('title', ''))}. Значения сохранились", "field")
        if page.field_prefs:
            key_op("fields", [], "Поля — как в шаблоне", "field")
        plan.sentence = f"Вернул страницу {_q(page.title)} как было."
        return plan

    # name and icon: at once, also from the assistant (proposal 2.8)
    if change.title is not None:
        title = " ".join(change.title.split())[:60]
        if not title:
            raise ViewError("validation_error", "title: 1-60 characters")
        if title != page.title:
            key_op("title", {"title": title, "title_kk": None},
                   f"Название: {_q(page.title)} → {_q(title)}")
    if change.icon is not None:
        if change.icon not in ICONS:
            raise ViewError("validation_error", "icon: one of the 8")
        if change.icon != page.icon:
            key_op("icon", change.icon, "Иконка изменена")

    layout = page.layout
    if change.layout is not None and change.layout != page.layout:
        if change.layout not in (template.layouts or []) or change.layout.startswith(
                "builtin:today"):  # fmt: skip
            raise ViewError("layout_not_allowed")
        if keep(set_by.get("layout") == "user"):
            layout = change.layout
            key_op("layout", change.layout, f"Вид: {LAYOUT_RU.get(page.layout, page.layout)} → "
                   f"{LAYOUT_RU.get(change.layout, change.layout)}")  # fmt: skip

    # own fields: add / rename / remove (values are never deleted)
    titles = {_norm(f["title"] or "") for f in cur_fields}
    customs = [dict(c) for c in page.custom_fields or []]
    for rid in change.remove_fields:
        f = find_field(new_fields, rid)
        if f is None:
            raise ViewError("field_unknown", f"no field {rid}")
        if not f["custom"]:  # a template field cannot go: it is hidden instead
            change.hide.append(f["id"])
            continue
        if agent:
            plan.asks["remove_field"] = plan.asks.get("remove_field", 0) + 1
        plan.removed_titles.append(f["title"])
        customs = [c for c in customs if str(c["id"]) != f["id"]]
        new_fields = [x for x in new_fields if x["id"] != f["id"]]
        key_op(f"custom.{f['id']}", None,
               f"Убрал поле {_q(f['title'])}. Значения сохранились", "field")
    for ren in change.rename_fields:
        f = find_field(new_fields, str(ren.get("field_id", "")))
        title = " ".join(str(ren.get("title") or "").split())[:FIELD_TITLE_CHARS]
        if f is None:
            raise ViewError("field_unknown", "rename: no such field")
        if not f["custom"] or not title:
            raise ViewError("validation_error", "only own fields are renamed, 1-40 characters")
        if title == f["title"]:
            continue
        c = next(c for c in customs if str(c["id"]) == f["id"])
        if not keep(c.get("set_by") == "user"):
            continue
        c.update(title=title, set_by=by)
        f["title"] = title
        key_op(f"custom.{f['id']}", dict(c), f"Поле {_q(ren.get('old') or f['title'])} → "
               f"{_q(title)}", "field")  # fmt: skip
    for new in change.add_fields:
        title = " ".join(str(new.get("title") or "").split())[:FIELD_TITLE_CHARS]
        ftype = new.get("type") or "text"
        if not title or ftype not in CUSTOM_TYPES:
            raise ViewError("validation_error", "own field: a title and one of 5 types")
        given = new.get("id")
        if given is not None:
            if not CLIENT_FIELD_ID.fullmatch(str(given)):
                raise ViewError("validation_error", "own field id: c_ + 4-40 of [0-9a-z_-]")
            if any(str(c["id"]) == given for c in customs):
                continue  # the outbox repeating the phone's own field: added once
        elif _norm(title) in titles:
            continue  # already there: «добавь поле телефон» twice adds one field
        if len(customs) >= MAX_CUSTOM_FIELDS:
            raise ViewError("fields_limit", "Можно до 5 своих полей")
        fid = str(given) if given is not None else "c_" + secrets.token_hex(4)
        cdef = {"id": fid, "title": title, "type": ftype, "set_by": by}
        customs.append(cdef)
        titles.add(_norm(title))
        new_fields.append({"id": fid, "title": title, "type": ftype, "required": False,
                           "visible": True, "custom": True, "set_by": by})  # fmt: skip
        key_op(f"custom.{fid}", cdef, f"Новое поле {_q(title)} ({TYPE_RU[ftype]})", "field")

    # visibility and order of fields
    def set_visible(name: str, visible: bool) -> None:
        f = find_field(new_fields, name)
        if f is None:
            raise ViewError("field_unknown", f"no field {name}")
        if f["required"] and not visible:
            raise ViewError("field_required", "Без этого поля страница не работает")
        if f["visible"] == visible:
            return
        if not keep(f["set_by"] == "user"):
            return
        f.update(visible=visible, set_by=by)

    if change.fields is not None:
        order = []
        for p in change.fields:
            f = find_field(new_fields, str(p.get("field_id", "")))
            if f is None:
                raise ViewError("field_unknown", f"no field {p.get('field_id')}")
            if f not in order:
                order.append(f)
            set_visible(f["id"], bool(p.get("visible", True)))
        rest = [f for f in new_fields if f not in order]
        if [f["id"] for f in order + rest] != [f["id"] for f in new_fields]:
            for f in order:
                f["set_by"] = by
            new_fields = order + rest
    for name in change.show:
        set_visible(name, True)
    for name in change.hide:
        set_visible(name, False)
    if change.order_first:
        first = []
        for name in change.order_first:
            f = find_field(new_fields, name)
            if f is None:
                raise ViewError("field_unknown", f"no field {name}")
            if f not in first:
                first.append(f)
        moved = first + [f for f in new_fields if f not in first]
        if [f["id"] for f in moved] != [f["id"] for f in new_fields]:
            if keep(any(f["set_by"] == "user" for f in first)):
                for f in first:
                    f["set_by"] = by
                new_fields = moved
    if _shape(new_fields) != _shape(cur_fields) or (
            page.field_prefs and [f["id"] for f in new_fields] != [f["id"] for f in cur_fields]):
        before = {f["id"]: f for f in cur_fields}
        texts = []
        for f in new_fields:
            old = before.get(f["id"])
            if old is not None and old["visible"] != f["visible"]:
                texts.append(f"{'Показал' if f['visible'] else 'Скрыл'} поле {_q(f['title'])}")
        same = [x for x in [f["id"] for f in new_fields] if x in before]
        if same != [f["id"] for f in cur_fields if f["id"] in {x["id"] for x in new_fields}]:
            texts.append("Порядок полей изменён")
        if texts or [f["id"] for f in new_fields] != [f["id"] for f in cur_fields]:
            plan.ops.append({"op": "set_view_key", "page": pid, "key": "fields",
                             "value": prefs_of(new_fields), "set_by": by,
                             "change": f"{pid}:fields"})  # fmt: skip
            for t in texts:
                row("fields", t, "field")

    # view_state keys
    for name, raw in change.view.items():
        if name not in VIEW_KEYS:
            raise ViewError("validation_error", f"unknown view key {name}")
        value = _check_view_value(name, raw, template, layout, new_fields)
        default = (template.default_view or {}).get(name)
        if value is None:
            value = default
        if value == vs.get(name) or (value == default and name not in vs):
            continue
        manual = set_by.get(name) == "user"
        held = 0
        if agent and name == "sort" and value not in (None, "position") \
                and vs.get("sort", "position") == "position":  # fmt: skip
            # sorting by a field hides the order the person set by hand (R-54)
            held = await _manual_rows(session, page.id)
        if not keep(manual or held > 0, max(held, 1), "order" if held else "setting"):
            continue
        key_op(f"view.{name}", value, _view_text(name, vs.get(name), value, new_fields))

    # sticker colours and «приколоть»: rows of this page
    wanted = set(change.colors) | set(change.pins)
    if wanted:
        if change.colors and template.key != "notes":
            raise ViewError("validation_error", "colours are for «Заметки»")
        for c in change.colors.values():
            if c is not None and c not in NOTE_COLORS:
                raise ViewError("validation_error", "colour: one of the 6")
        rows = (await session.execute(
            select(ScreenItem, Item.public_id, Item.title, Item.text)
            .join(Item, Item.id == ScreenItem.item_id)
            .where(ScreenItem.screen_id == page.id, ScreenItem.removed_by_user_at.is_(None),
                   Item.public_id.in_([_uuid(i) for i in wanted]))
        )).all()  # fmt: skip
        found = {str(r[1]): r for r in rows}
        if set(found) != wanted:
            raise ViewError("not_found", "a record is not on this page")
        appear_ops = []
        for iid in sorted(wanted):
            link, _pub, title, text = found[iid]
            name = " ".join((title or text or "запись").split())[:60]
            app = dict(link.appearance or {})
            values: dict[str, Any] = {}
            texts = []
            if iid in change.colors and change.colors[iid] != app.get("color"):
                if keep(app.get("color_set_by") == "user", 1, "color"):
                    values.update(color=change.colors[iid], color_set_by=by)
                    texts.append(f"Цвет: {_q(name)} → "
                                 f"{COLOR_RU.get(change.colors[iid] or '', 'без цвета')}")
            if iid in change.pins and change.pins[iid] != link.pinned:
                pinned_by = app.get("pinned_set_by") or ("user" if link.pinned else None)
                if keep(pinned_by == "user", 1, "pin"):
                    values.update(pinned=change.pins[iid], pinned_set_by=by)
                    texts.append(f"{'Приколол' if change.pins[iid] else 'Открепил'} {_q(name)}")
            if values:
                appear_ops.append({"op": "set_appearance", "page": pid, "item": iid,
                                   "values": values})  # fmt: skip
                for t in texts:
                    plan.changes.append({"item_id": iid, "title": name,
                                         "kind": "color" if t.startswith("Цвет") else "pin",
                                         "page_id": pid, "text": t})  # fmt: skip
        plan.records = len(appear_ops)
        if agent and plan.records > COUNT_ASK_ABOVE:
            plan.asks["count"] = plan.records
        plan.ops += appear_ops
    plan.sentence = _sentence(page, plan)
    return plan


async def _manual_rows(session: AsyncSession, screen_id: int) -> int:
    return int(await session.scalar(
        select(func.count()).select_from(ScreenItem)
        .where(ScreenItem.screen_id == screen_id, ScreenItem.manual_order.is_(True),
               ScreenItem.removed_by_user_at.is_(None))) or 0)  # fmt: skip


def _uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError as exc:
        raise ViewError("validation_error", "a record id") from exc


def _sentence(page: Screen, plan: Plan) -> str:
    texts = [c["text"] for c in plan.changes]
    if not texts:
        return ""
    if len(texts) == 1:
        return texts[0] + "."
    if plan.records and len(texts) == plan.records:
        return f"Изменил {plan.records} {_plural(plan.records)} на странице {_q(page.title)}."
    return f"Изменил вид страницы {_q(page.title)}: {len(texts)} {_changes(len(texts))}."


def _plural(n: int) -> str:
    n100, n10 = n % 100, n % 10
    if n10 == 1 and n100 != 11:
        return "запись"
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return "записи"
    return "записей"


def _changes(n: int) -> str:
    n100, n10 = n % 100, n % 10
    if n10 == 1 and n100 != 11:
        return "изменение"
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return "изменения"
    return "изменений"


def question(plan: Plan, kind: str, page: Screen) -> str:
    """The «Да» question for the assistant (S25 / confirm_manual)."""
    if kind == "reset":
        return (f"Вернуть страницу {_q(page.title)} как было? Ваши поля скроются, записи и "
                "значения в них сохранятся.")  # fmt: skip
    if kind == "remove_field":
        names = ", ".join(_q(t) for t in plan.removed_titles) or "поле"
        return f"Убрать поле {names}? Значения сохранятся."
    if kind == "count":
        return f"Изменить {plan.records} {_plural(plan.records)}?"
    n = plan.asks.get("manual", 0)
    if plan.manual_kinds == {"color"}:
        return f"Вы сами покрасили {n} {_sticker(n)}. Перекрасить и их?"
    if plan.manual_kinds == {"order"}:
        return f"Вы сами расставили {n} {_plural(n)}. Сортировать и их?"
    return "Это вы настроили на странице сами. Изменить и это?"


def _sticker(n: int) -> str:
    n100, n10 = n % 100, n % 10
    if n10 == 1 and n100 != 11:
        return "стикер"
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return "стикера"
    return "стикеров"


def is_customized(page: Screen, template: ScreenTemplate) -> bool:
    default = dict(template.default_view or {})
    vs = page.view_state or {}
    return bool(page.field_prefs or page.custom_fields or page.layout != template.default_layout
                or any(vs.get(k) != default.get(k) for k in VIEW_KEYS))  # fmt: skip


async def template_of(session: AsyncSession, page: Screen) -> ScreenTemplate:
    t = await session.get(ScreenTemplate, (page.template_key, page.template_version))
    assert t is not None
    return t


async def describe(session: AsyncSession, screen_id: int) -> str | None:
    """One context line for the assistant: the current page's layout, allowed layouts and
    fields (★ = cannot be hidden), so `set_view` names real ones."""
    page = await session.get(Screen, screen_id)
    if page is None or page.kind == ScreenKind.SYSTEM_TODAY:
        return None
    template = await template_of(session, page)
    fields = effective_fields(template.fields or [], page.custom_fields or [],
                              page.field_prefs or [])  # fmt: skip
    names = ", ".join(f"{f['title']}{'★' if f['required'] else ''}"
                      f"{'' if f['visible'] else ' (скрыто)'}"
                      f"{' (своё)' if f['custom'] else ''}" for f in fields)  # fmt: skip
    vs = page.view_state or {}
    extra = []
    if vs.get("board"):
        extra.append("доска")
    if vs.get("sort") not in (None, "position"):
        extra.append(f"сортировка {vs['sort']}")
    if vs.get("group_by"):
        extra.append(f"группировка {vs['group_by']}")
    return (f"Вид страницы: {page.layout} (можно: {', '.join(template.layouts or [])})"
            f"{'; ' + ', '.join(extra) if extra else ''}; поля: {names}; своих полей "
            f"{len(page.custom_fields or [])} из {MAX_CUSTOM_FIELDS}")
