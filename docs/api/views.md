# Views API: «Настроить страницу», the assistant's `set_view`, own fields (week 11, 11а)

Spec: proposal `docs/spec/proposals/template-screens.md` §2.8, §4 (accepted, ТЗ v1.2); R-51
(extended), R-54, R-56; Ф-28, Ф-30, Ф-31; `final/3-engineering.md` 3.10, 4.10; US-29. Base path
`/v1`, `Authorization: Bearer` and the base consents, errors `{code, message_ru, message_kk,
details?}` as everywhere.

**One function.** Every view change — S38 by hand, the assistant line, `PATCH /pages/{id}` — is
planned by the same server code (`pages/view.py`): the same white list, the same ★ rule, the same
«ваше — ваше». Each change is one action with «Отменить» and «Что изменилось».

## What is a view

| Setting | Where it lives | Values |
|---|---|---|
| Layout | `page.layout` | one of the template's `layouts` (catalogue). `list` («Простой список», Ф-30) is allowed on every template except «Сегодня» |
| Rows / board («Заметки») | `view_state.board` | `true` = free board, absent/false = rows. Allowed only on «Заметки»; see «Доска» below |
| Sort | `view_state.sort`, `view_state.sort_dir` | `"position"` (the person's order, default) · `"date"` (record date, newest first unless `asc`) · a field id. `sort_dir`: `asc` / `desc` |
| Group by field | `view_state.group_by` | a field id (not `long_text`, `number`, `money`, `datetime`, `link`) or absent |
| Group order (week 11а) | `view_state.group_order` | the person's order of the groups: ≤30 names of 1…60 chars (spaces trimmed, repeats ignoring case and «ё» dropped), or absent. «Покупки»: the shop walk («Магнум», «Аптека») |
| Filters | `view_state.filters` | ≤5 `{field, op: "eq" \| "empty" \| "not_empty", value?}` |
| Period («Расходы») | `view_state.period` | `week` \| `month` \| `year` |
| Tile on «Сегодня» | `view_state.today_tile` | `auto` (default) \| `pinned` \| `hidden` (the tiles come in week 16) |
| Fields shown and their order | `page.field_prefs` | see below |
| Own fields (≤5) | `page.custom_fields` | see below |
| Checklist tick | the row: `link.done_at` | ISO time or null; any page shown as `checklist` («Своя страница», …). «Дела» / «Покупки» keep their ticks on tasks (`today.md`) |
| Sticker colour, «приколоть» | the row: `link.appearance.color`, `link.pinned` | `yellow` \| `pink` \| `green` \| `blue` \| `peach` \| `white` \| null (`color.note.*`); colours only on «Заметки» |
| Name, icon | `page.title`, `page.icon` | as in `pages.md` |

`view_state.groups` (stack / «Разложи» group names) is not a view setting here and is never reset.

### Tool layouts (week 11а)

The catalogue (`GET /v1/page-templates`) now has the tool as each template's `default_layout`;
new pages get it, and existing pages whose layout was the old default and not set by the
person moved to it (migration 0017). The old layouts stay allowed.

| Template | `layouts` (first = default) | Tool |
|---|---|---|
| `notes` v4 | `builtin:notes_board`, `list`, `stacks` | sticker wall: «Ряды» (`view_state.board` absent/false), «Доска» (`board: true`, see «Доска») |
| `tasks` v3 | `builtin:planner`, `builtin:tasks`, `list` | the day planner (`today.md` → «Ежедневник») |
| `shopping` v3 | `builtin:shopping`, `checklist`, `list` | the fridge list with «Я в магазине» (`today.md` → «Покупки») |

Draw by `page.layout`; an unknown layout falls back to `list` («Простой список»).

### Who set it (`set_by`)

`user` (by hand), `agent` (the assistant), `template` (missing = template).
- `view_state.set_by`: `{"layout": "user", "sort": "agent", ...}` for the layout and every key above.
- `field_prefs[].set_by`, `custom_fields[].set_by`.
- `link.appearance.color_set_by`, `link.appearance.pinned_set_by`.

The phone does not need to read these; they decide when the assistant must ask «Да».

### Fields

The page's fields in display order (the phone computes this the same way):
1. Template fields (catalogue `fields`, order as there, `visible = default_visible`, ★ = `required`
   always visible), then own fields (`custom_fields`, order as there, visible).
2. If `field_prefs` is not empty, it is the order: `[{field_id, visible, set_by}]`. Ids it does not
   name (a field added by a later template version) go last with their default. Ids it names that
   no longer exist are ignored.

`custom_fields`: `[{id, title, type, set_by}]`, `id` like `"c_9f3a1b2c"`, `type`:
`text | number | money | date | bool` (Текст · Число · Сумма ₸ · Дата · Галочка), at most 5.
Values are per record and page in `item_facets` (below).

**A field made offline.** The phone may name the new field itself: `add_fields: [{"id":
"c_<32 hex of a uuid>", "title", "type"}]` (`id`: `c_` + 4…40 of `[0-9a-z_-]`). Queue the
`/view` call first, then the row `values` with that id: they map to the field when they arrive.
A repeat with the same `id` adds nothing (`changed: false`), with or without `client_id`; with
an `id`, a second field of the same title is allowed (without one, the same title is skipped as
a voice repeat). Re-adding an `id` that was removed brings its stored values back. Removing an own field (or «Вернуть как
было») **never deletes values**: they come back with «Отменить» / «Вернуть». A new field with the
same name is a new field (old values stay with the old id).

## `POST /v1/pages/{id}/view` — the S38 call

Every key optional; a key left out stays as it is. `null` on a `view_state` key (`board`, `sort`,
`sort_dir`, `group_by`, `group_order`, `filters`, `period`, `today_tile`) = back to the
template's value.
```json
{
  "client_id": "uuid",
  "layout": "table",
  "board": true,
  "sort": "date", "sort_dir": "desc",
  "group_by": "where",
  "group_order": ["Аптека", "Магнум"],
  "filters": [{"field": "doc_type", "op": "eq", "value": "kp"}],
  "period": "month",
  "today_tile": "pinned",
  "title": "Ремонт", "icon": "home",
  "fields": [{"field_id": "title", "visible": true}, {"field_id": "date", "visible": false}],
  "show_fields": ["source"], "hide_fields": ["topics"],
  "add_fields": [{"id": "c_5f0c…", "title": "Телефон мастера", "type": "text"}],
  "rename_fields": [{"field_id": "c_9f3a1b2c", "title": "Мастер"}],
  "remove_fields": ["c_9f3a1b2c"],
  "colors": [{"item_id": "uuid", "color": "yellow"}],
  "pins": [{"item_id": "uuid", "pinned": true}],
  "reset": false
}
```
- `fields`: the whole order the person sees (S38 ↑ ↓ and the switches); fields not listed keep
  their relative order after the listed ones. `show_fields` / `hide_fields`: by id.
- Field names may be ids or titles (titles are what the assistant uses); send ids.
- `group_order`: send the whole order after the person moved a group (↑ ↓ / drag). Its «Что
  изменилось» row reads «Порядок групп: Аптека → Магнум».
- `reset: true` = «Вернуть как было» (goes alone). Show S25 first; the server does not ask.
- `client_id`: send it from the outbox, same value on every retry: a repeat returns the first
  result with `repeated: true`. Works offline through the outbox. `base_view_version` is accepted
  and never blocks: the person's change wins.
- The person by hand is never asked «Да» by the server.

`200`:
```json
{"page": PageOut, "changed": true, "repeated": false, "action": Action | null,
 "page_patch": PagePatch}
```
- `action`: `screen_view_change` (or `screen_reset`), `initiated_by: "user"`, `summary.ru` like
  «Вид: Список → Таблица.» / «Новое поле «Телефон мастера» (Текст).» / «Вернул страницу «Ремонт»
  как было.»; null when nothing changed (`changed: false`).
- `page_patch` (shape of `chat.md`) + `page_view` (below).

Errors: `404 not_found` (page, or a record not on it) · `403 page_system` («Сегодня») ·
`422 field_required` («Без этого поля страница не работает», hiding a ★) ·
`422 fields_limit` («Можно до 5 своих полей») · `422 layout_not_allowed` · `422 field_unknown` ·
`422 validation_error` (`details.reason` in English for the log).

## Wrappers (spec 4.10)

- `PUT /v1/pages/{id}/fields` `{client_id?, fields?, add_fields?, rename_fields?, remove_fields?}`
  — the fields part of `/view`, same response and errors.
- `POST /v1/pages/{id}/reset` `{client_id?}` — `/view` with `reset: true`.
- **Renaming** (S38 «Название»): `PATCH /v1/pages/{id}` `{"title", "client_id"}` or `/view`
  `{"title", "client_id"}`. Both return an undoable action (`screen_customize` /
  `screen_view_change`) whose row has `key: "<page>:title"`; «Отменить» brings the old name (and
  `title_kk`) back. Send `client_id` from the outbox: a repeat returns the first action.
- `PATCH /v1/pages/{id}` (`pages.md`) is unchanged on the wire (`title`, `icon`, `layout`,
  `base_view_version` with `409 conflict` for a stale layout; `action.kind: screen_customize`) and
  now goes through the same planner, so it writes `set_by: user` too. Title/icon do not raise
  `view_version`; every other setting does.

## `PATCH /v1/pages/{id}/items/{item_id}` — one row

```json
{"client_id": "uuid", "color": "yellow", "pinned": true, "done": true,
 "values": {"c_9f3a1b2c": "+7 701 000 00 00"}}
```
All optional; `color: null` = no colour; leave a key out to keep it. `done`: the checklist tick
(`link.done_at` set to the server's time / null; «Отметил: …» / «Вернул: …», `facet_edit`,
«Отменить» returns it). It is on the row, so every phone gets it in `/v1/sync` `screen_items`. `values`: own field id →
value (`null` clears): `text` ≤500 chars · `number` / `money` a number (or a numeric string) ·
`date` ISO date · `bool` true/false.

`200 {"link": PageItemOut, "values": {...this row's own values...}, "repeated": false,
"action": Action | null, "page_patch": PagePatch}`. `action.kind`: `screen_view_change` for
colour / pin, `facet_edit` when `values` or `done` were sent («Отменить» returns the old values). Errors:
`404 not_found` (row not on the page or removed from it) · `422 field_unknown` ·
`422 validation_error` (`details.field`) · colours on another template: `422 validation_error`.

## Rows and contents

`PageItemOut` (`link`) has new fields (also in `/v1/sync` `screen_items` and `page_patch.rows`):
```json
{"appearance": {"color": "yellow", "color_set_by": "user"}, "board_x": null, "board_y": null,
 "board_z": null, "board_manual": false, "done_at": null}
```
`board_*`: the sticker's place on the free board: see «Доска» below (board space, stacking,
who placed it).

`GET /v1/pages/{id}/items`:
- **Pinned first (week 11а).** In every order, rows with `link.pinned: true` come first (in page
  order among themselves), then the rest («Приколотые всегда идут первыми»). `cursor` paging
  follows the same order. The phone sorts its local copy the same way (`pages.md` → Page order).
- `entries[].fields` now also has the page's own field values (live own fields only).
- When `view_state.sort` is a field / `date` or there are `filters`, the server returns the rows
  filtered and sorted that way: **pinned first**, then by the value (numbers as numbers, text
  case-insensitive, empty values last in both directions), ties in page order. Paging by
  `cursor` works the same. The phone sorts its local copy the same way.
- `group_by` is drawn by the phone from `fields[group_by]` (records without a value: «Без …»
  group last). The server does not group; `?group=` still filters by `link.group_key`.
- Group order (week 11а): the names in `view_state.group_order` first, in that order (match
  ignoring case, «ё»/«е» and extra spaces); groups it does not name follow in the order their
  first row appears; «Без …» last. A name with no rows is skipped. Done / bought rows stay at the
  bottom of the list as before (`today.md`), not inside their group.

## `PagePatch.page_view` (chat event `page_patch`, undo response, the calls above)

```json
{"page_id": "...", "view_version": 8, "view_state": {...}, "rows": [...],
 "removed_item_ids": [],
 "page_view": {"title": "Ремонт", "title_kk": null, "icon": "home", "layout": "table",
               "field_prefs": [...], "custom_fields": [...], "customized": true}}
```
Apply it to the local page at once (the same values come in `/v1/sync` `screens`).

## Sync

`GET /v1/sync` has `item_facets: [{id, page_id, item_id, data: {field_id: value}, updated_by,
seq, updated_at}]` in the same `seq` stream. Upsert by `id` (or `page_id + item_id`). `data` may
hold values of fields no longer in `custom_fields`: keep them, show only live fields. No
tombstones of their own: drop them with their item / page.

## «Отменить» and «Что изменилось»

Each setting is one row in `action.changes`:
```json
{"item_id": null, "key": "0194…page:layout", "kind": "view", "title": "Ремонт",
 "text": "Вид: Список → Таблица", "page_id": "...", "reverted": false}
```
`kind`: `view` (layout and `view_state` keys, name, icon), `field` (fields and own fields),
`color`, `pin`, `done` (these three have `item_id`, `key: null`). «Вернуть» on a row:
- a row with `item_id`: `POST /v1/actions/{id}/undo {"item_ids": [item_id]}` (as before);
- a row with `key`: `POST /v1/actions/{id}/undo {"keys": [key]}` (new). Rows sharing a key
  (several field rows share `<page>:fields`) are returned together.
«Отменить» = the whole action. A setting the person changed again since is kept (`partial`).

## The assistant (`chat.md`)

The line's tool `set_view` uses the same planner (`initiated_by: "agent"`, kinds
`screen_view_change` / `screen_reset`, the usual `action` + `page_patch` events).
- Only when the person's own phrase asks about the view (code checks the words; record text,
  files and shared text never trigger it).
- **At once, with «Отменить»:** layout / mode, sorting, grouping, group order, filters, period,
  showing/hiding fields (not ★), their order, a new own field («добавь поле телефон мастера»),
  colours nobody set by hand, «приколи …», «раскрась по темам», page name and icon.
- **One «Да» first** — chat event `confirm` (Proposal `kind: "count"`, [Да] [Не сейчас]):
  «Вернуть страницу «Ремонт» как было? Ваши поля скроются, записи и значения в них сохранятся.»,
  «Убрать поле «Мастер»? Значения сохранятся.», «Изменить 160 записей?» (>150 rows).
- **Set by hand → `confirm_manual`** (Proposal `kind: "manual"`, [Да] [Оставить мои], focus
  «Оставить мои»): «Вы сами покрасили 4 стикера. Перекрасить и их?», «Вы сами расставили
  12 записей. Сортировать и их?» (a sort by field would hide the person's own order), «Это вы
  настроили на странице сами. Изменить и это?». «Оставить мои» applies the rest and says «Ваше
  оставил как есть.»
- **Never:** hiding a ★ field, a layout outside the template's list, a change nobody asked for.
- A change on another page is made at once and named in the summary («… — на странице «Покупки».»).

### «Раскрась по темам» (week 11а, proposal 2.1, 2.8)

On «Заметки» only (elsewhere the assistant says colours are for «Заметки»). Code understands
«раскрась по темам» / «раскрась заметки по темам» itself (no chat model); other wordings reach the
model, whose `set_view` takes `color_by: "topic"`. Only the person's own phrase starts it.
1. **Topics.** If the page has piles (rows with `link.group_key` from «Разложи по темам» or a
   stack), they are the topics: each pile gets one colour, no model call. Otherwise the light model
   groups the notes (PAGE_GROUP, the same masked untrusted lines as «Разложи»; needs
   `ai_cross_border`, which the line already has). Record text is data, never an instruction.
2. **Colours (code).** Topics biggest first (piles: in `view_state.groups` order) take
   `yellow`, `green`, `blue`, `pink`, `peach` in turn; `white` is never a topic colour. A note
   with no topic («Остальное» / not in a pile) only loses a colour the assistant gave it; a colour
   nobody set stays as it is.
3. **«Ваше — ваше».** A colour the person set by hand (`color_set_by: "user"`) is changed only
   after «Да»: `confirm_manual` «Вы сами покрасили 4 стикера. Перекрасить и их?» [Да]
   [Оставить мои]. The topics found are kept with the question: the tap does not ask the model
   again. More than 150 notes: `confirm` «Раскрасить 160 заметок?» first (and the daily limit of
   big rearrangements applies).
4. **Result.** One action `screen_view_change` (`initiated_by: "agent"`), one «Что изменилось»
   row per sticker (`kind: "color"`, «Цвет: «Код домофона» → жёлтый», «Вернуть» by `item_id`),
   `summary.ru` «Раскрасил 12 стикеров по темам: Ремонт — жёлтый, Мастера — зелёный, Дача —
   голубой.» (≤5 topics named, so the meaning does not rest on colour alone). «Отменить» puts
   every colour back. Rows travel in `page_patch.rows`.

Nothing is coloured by itself: new notes stay white unless a habit says so (S30, later).

## «Доска»: the free sticker board (weeks 16а–16б, Ф-28)

Spec: proposal §2.1 «Режим «Доска»», §4, §5; Ф-28. «Заметки» has two modes: «Ряды» (default, the
one-dimensional `position` order of `pages.md`) and «Доска» (`view_state.board: true`), where a
sticker lies where the person put it, overlapping allowed. **The two layouts are independent and
both are kept**: a place on the board never changes `position`, a move in «Ряды» never changes a
board place, switching modes (by hand, the assistant, «Отменить», «Вернуть как было») loses
neither.

### Board space (the same board on every phone)

The board is **360 board points wide** and grows down; no horizontal scroll. Draw it at scale
`s = board width on screen (pt) / 360`:

| Field | Meaning | Range | Draw at |
|---|---|---|---|
| `board_x` | the sticker's **left edge**, share of the board width | 0 … 220/360 (0.6111…) | `board_x × width` |
| `board_y` | the sticker's **top edge**, board points | 0 … 100 000 | `board_y × s` |
| sticker | 140 × 140 board points | — | `140 × s` square |
| `board_z` | stacking: higher lies on top; `null` lowest; ties by item id (string order) | integer (≤ 2⁵³) | — |
| `board_manual` | `true` = the person put it there by hand | — | — |

- The server keeps whole board points: it stores `round(x × 360) / 360` and `round(y)`, clamped
  into the ranges above (a sticker never hangs off the board). Use the `link` values it returns.
- The 8 pt grid the sticker snaps to on drop is the phone's (snap the board-point value:
  `round(v / 8) × 8`); the server does not snap.
- The board's height: `max(board_y) + 140 + 16` board points (at least the screen).
- `board_z` is the Unix time in ms of the winning place (`client_ts`; a future time counts as the
  server's time). Offline, set it to your own `client_ts` in ms: the server gives the same number.

### Places the server gives (not the person's)

Slots: two columns at board x **24** and **196**, rows at board y **16 + 156·k** (k = 0, 1, …),
read row by row, left then right. A slot is free when no placed, shown sticker of the page
overlaps it (the rectangles share some area).
- **Turning the board on** (any path: `/view` `board: true`, the assistant, an undo that brings
  the board back): every shown sticker **without a place** gets the first free slot, in «Ряды»
  order (pinned first, then `position`). Stickers that have a place keep it («места
  запоминаются»). These places come in `page_patch.rows` / sync with `board_manual: false`,
  `board_z: null`; they have no «Что изменилось» row and stay when the board is turned off.
- **A new sticker** on a page in board mode lies in the first free slot (highlight 600 ms).
- A shown sticker without a place while the board is on (rare: back from the trash): draw it in
  the first free slot by the same rule, after the placed ones, in «Ряды» order. It is stored when
  the person moves it or the board is turned on again.

### `POST /v1/pages/{id}/items/place` — the person's place

```json
{"client_id": "uuid", "client_ts": "2026-11-12T10:00:00+05:00", "base_view_version": 9,
 "item_id": "uuid", "x": 0.0667, "y": 172}
```
or several stickers in one tap (one action, one «Отменить»):
```json
{"client_id": "uuid", "client_ts": "...",
 "places": [{"item_id": "uuid", "x": 0.0667, "y": 172}, {"item_id": "uuid", "x": 0.5444, "y": 16}]}
```
- `x`, `y`: the **absolute** new place in board space, always both (also for the arrows and for
  «Наверх доски»: send the place the phone shows). Every sticker of the call goes on top
  (`board_z`) and becomes the person's (`board_manual: true`).
- `places`: 1…200 stickers, each once. Use it for a **pile** (every sticker of the pile with the
  same `x`, `y`) and for a **swap** (below).
- Gestures, all as absolute places: drag (long press 400 ms, drop, snap to 8 pt) · «⋯ Ещё →
  Подвинуть»: «Левее / Правее / Выше / Ниже» = ±70 board pt (half a sticker) from where it is,
  snapped to 8 pt (so ±72), clamped · «Положить наверх доски» = its current `x`, `y`.
- `client_id` from the outbox, the same on every retry: a repeat returns the first result with
  `repeated: true`. `client_ts`: when the person did it (always send it from the outbox).
- `base_view_version` (optional): never a conflict; `rebased: true` says the page had changed.
- Works offline, in «Без ИИ», in either mode (a place queued in board mode that arrives after the
  page went back to rows is stored for the board). A sticker taken off the page meanwhile takes
  the place but stays off the page. Only «Заметки».

`200`:
```json
{"placed": true, "reason": null, "repeated": false, "rebased": false,
 "links": [PageItemOut], "kept_item_ids": [], "action": Action | null, "page_patch": PagePatch}
```
- `links`: the stickers of the call as they are now (show them there).
- `kept_item_ids`: stickers whose later place (other phone) stands; they are left as they are.
  `placed: false, reason: "newer_move"` when that is every sticker of the call. No dialog.
- `action`: `screen_reorder_items`, `initiated_by: "user"`, `summary.ru` «Переставил «Код
  домофона» на доске» / «Положил «…» наверх доски» / «Переставил 3 стикера на доске»; one
  «Что изменилось» row per sticker (`kind: "place"`, «Вернуть» by `item_id`). `null` when nothing
  changed (already there, on top and the person's).
- Errors: `404 not_found` (page, or a sticker not on it) · `403 page_system` ·
  `422 validation_error` (not «Заметки», no place, a sticker twice, more than 200, `x` / `y` not a
  finite number).

### Two phones offline

Each sticker's place has its own last-writer-wins clock (`client_ts`, ties by the larger
`client_id` as a lowercase string: the rule of `pages.md` «Manual order», on a clock separate from
the rows order). Because the place is absolute and `board_z` comes from the winning time, **every
sticker ends where its latest place put it, whatever order the calls arrive in, with retries**;
both phones converge after `/v1/sync`. A losing call changes nothing for that sticker. Auto places
(above) are the server's: they follow the order new stickers arrive in.

### «Отменить»

`POST /v1/actions/{id}/undo` puts every sticker of the call back (place, stacking, «ваше»); a
sticker moved again since stays where it is (`partial`). The clock does not go back: a stale
offline place of that sticker still loses. If the call is still in the outbox, drop it instead.

### Large font (≥150%) and screen readers: the board as rows

Show the stickers as rows in **reading order** with the strip «При крупном шрифте доска показана
рядами. Места стикеров сохранены». Reading order: by band `floor((board_y + 70) / 140)`, then
`round(board_x × 360)`, then `board_y`, then «Ряды» order; stickers without a place last (in «Ряды»
order). Announce «Стикер 3 из 12». «Выше / Ниже» there = **swap places** with the previous / next
sticker in reading order: one call with two `places`, each sticker getting the other's `x`, `y`.
Custom actions for screen readers: «Выше / Ниже / Левее / Правее / Наверх доски».

### Piles on the board

A pile (rows sharing `group_key`, `stacks.md`) is drawn as one pile at the place of its first
sticker in «Ряды» order; dragging it sends every sticker of the pile with the same `x`, `y`. A
sticker taken out of a pile shows at its own stored place.

### The assistant and the board

- The assistant **never places stickers**. It may switch the mode (`set_view` `board`, the rules
  above: only when the person's own phrase asks; record text never triggers it); that only gives
  places to stickers that have none.
- «Разложи заметки» on a page in board mode counts the stickers the person placed on the board
  (`board_manual`) as theirs: `confirm_manual` «Вы сами расставили 9 стикеров. Переставить и
  их?» [Да] [Оставить мои]. It changes piles and the rows order only; board places stay.
- «Вернуть как было» turns the board off (rows); places are kept.

## Stacks → page (`stacks.md`)

`POST /v1/collections/{id}/to-page {client_id?, title?}` — «Сделать стопку страницей».

## Not here yet

| What | When |
|---|---|
| `page_tiles` on `/today` (reads `today_tile`) | week 16 |
| Habit «всегда раскрашивай новые заметки по теме» | S30, later |
| Category order of «Расходы» | week 12 |
