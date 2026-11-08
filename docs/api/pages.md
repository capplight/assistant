# Pages API (sprint 3, part B; manual order: week 7)

Spec: `docs/spec/final/3-engineering.md` 3.10, 4.10, 6.12; R-46...R-51, R-54. Base path `/v1`.
All endpoints need `Authorization: Bearer` and the base consents (`pd_processing` + `terms`);
otherwise `403 consent_required`. Errors have the usual shape
`{code, message_ru, message_kk, details?}`.

A page is a **view on the shared memory, not a folder**. An item lives in `items`; a page only
links to it (`screen_items`). One item can be on several pages. Removing a page never touches
items. Backend names are `screens` / `screen_items`; the REST paths say `pages`.

## Catalogue

### `GET /v1/page-templates`
Latest published version of each template the gallery shows (6, without `today`), in gallery
order (`custom` first). Sends `ETag`; send `If-None-Match` and get `304` with no body. Cache it.

```json
{
  "templates": [
    {
      "key": "notes",
      "version": 1,
      "title": {"ru": "Заметки", "kk": "Жазбалар"},
      "description": {"ru": "Разложу и уберу повторы", "kk": null},
      "icon": "documents",
      "preview_ref": "notes.v1",
      "singleton": true,
      "facet": "note",
      "fields": [
        {"id": "text", "title": {"ru": "Текст", "kk": null}, "type": "long_text",
         "required": true, "default_visible": true, "source": "item.text"}
      ],
      "layouts": ["stacks", "list"],
      "default_layout": "stacks",
      "default_view": {"sort": "position"},
      "aggregates": [],
      "auto_rule": {"any": [{"always": true}]},
      "min_app_version": null
    }
  ]
}
```

- `key`: `custom | notes | tasks | shopping | documents | expenses`. `today` is not here.
- `title.kk` / `description.kk` are `null` until reviewed (R-39): fall back to `ru`.
- `field.required` = ★, cannot be hidden. `field.type`: `text | long_text | number | money | date |
  datetime | enum | tags | bool | person | link`. Enum fields also have `options: ["kp", ...]`.
- `field.source`: where the value comes from: `item.<column>`, `envelope.<key>`, `task.<x>`,
  `expense.<x>`, `document.<x>`, `facet.<x>`. `item.*`, `envelope.*` and, on «Дела» / «Покупки», `task.*` / `facet.*` (from the task, `today.md`) have values.
- `layouts`: `list | checklist | table | stacks | builtin:today | builtin:tasks | builtin:kp |
  builtin:expenses`.
- `auto_rule`: see "Placement". Sent so the phone can place a note offline for display; the
  server decides for real.

## Pages

### Page object (`PageOut`)
```json
{
  "id": "0194f...uuid",
  "client_id": "uuid or null",
  "kind": "page",
  "template_key": "notes",
  "template_version": 1,
  "title": "Заметки",
  "title_kk": "Жазбалар",
  "icon": "documents",
  "position": "2",
  "layout": "stacks",
  "view_state": {"sort": "position"},
  "field_prefs": [],
  "custom_fields": [],
  "customized": false,
  "view_version": 1,
  "created_by": "user",
  "hidden_at": null,
  "last_opened_at": null,
  "seq": 1234,
  "created_at": "2026-11-07T10:00:00Z",
  "updated_at": "2026-11-07T10:00:00Z",
  "deleted_at": null
}
```
- `kind`: `system_today` (template `today`, layout `builtin:today`) or `page`.
- Every account always has exactly one `system_today`, from the moment it is created (DB trigger).
  It cannot be changed or removed.
- Show `title_kk` in Kazakh when it is not null, else `title`. Renaming clears `title_kk`.
- `icon`: `people | documents | shopping | money | health | home | work | other`, plus the system
  `today` and `tasks`.
- `field_prefs` / `custom_fields`: empty means "as in the template" (edited from week 11).
- **Tab order**: `system_today` first, then `position` ascending by bytes, tie-break `id`.

### `GET /v1/pages`
`{"pages": [PageOut, ...]}`: live pages in tab order. Removed pages are not listed.

### `POST /v1/pages`
```json
{"client_id": "uuid", "template_key": "custom", "title": "Ремонт", "icon": "home",
 "layout": "checklist", "created_by": "user"}
```
Only `client_id` and `template_key` are required. `title` is 1-60 chars; default is the template
title (`custom`: «Моя страница»). `created_by`: `user` (default) | `onboarding_gallery` |
`onboarding_blank` | `onboarding_phrase`.

`201 {"page": PageOut, "created": true, "revived": false, "action": Action}`; repeating a
`client_id` gives `200` and `created: false` (`action: null`). `action` (week 9): `create_screen`,
«Добавил страницу «Покупки»», «Отменить» removes the page again (records stay). On creation the page is filled at once from the items already in memory that match
its rule.

**Adding a removed topic again.** Every template except `custom` allows one page. If the account
removed its page of that topic, `POST /v1/pages` brings **that page** back instead of making a new
one: `200 {"page": PageOut, "created": false, "revived": true}`.
- `page.id` is the old page's id: upsert by `id`, and treat your local page with this `client_id`
  and the old removed page as one.
- Its tab position, title, icon, layout, and rows come back as they were, with rows it had by hand
  and rows the person removed untouched. Items saved while it was gone are placed. `title`, `icon`,
  `layout`, and `created_by` in the request are not applied.
- `page.client_id` becomes the one you sent, so retrying this request gives `200`, `created: false`,
  the same page (`revived: false`). Use a new `client_id` for each new tap: repeating a `client_id`
  of a page removed later returns it still removed.

Errors: `409 singleton_exists` when the topic has a live page (`details.page_id` = that page; open it
instead) · `422 pages_limit` (20 pages including «Сегодня»; also when reviving) ·
`422 template_unknown` (also for `today`) · `422 layout_not_allowed` · `422 validation_error`.

### `GET /v1/pages/{id}`
`PageOut`. `404 not_found` when removed or foreign.

### `PATCH /v1/pages/{id}`
```json
{"title": "Дача", "icon": "home", "layout": "table", "base_view_version": 3}
```
All optional. `layout` raises `view_version`; `title` / `icon` do not. If `layout` is sent with a
`base_view_version` that is not current: `409 conflict`, `details.view_version`. A stale base does
not block a rename. Returns `PageOut` plus `"action": Action | null` (week 9: `screen_customize`,
«Переименовал страницу в «Дача»», «Отменить» = the old name, icon and layout; null when nothing
changed). «Сегодня»: `403 page_system`.

### `DELETE /v1/pages/{id}`
«Убрать страницу»: soft delete, items stay. Repeatable. Returns `PageOut` with `deleted_at`, plus
`"action": Action | null` (week 9: `delete_screen`, «Страница «Покупки» убрана. Записи
остались»; null on a repeat). **«Отменить» = `POST /v1/actions/{action.id}/undo`** (it brings the
page back exactly like `/restore`); `/restore` stays for older builds. «Сегодня»: `403
page_system`.

### `POST /v1/pages/{id}/restore`
Undo of the removal: returns `PageOut`, the old links and order are back, and items saved in
between are placed. On a page that is already live (added again meanwhile, see above) it just returns
the page: `200`, no conflict. Errors: `422 pages_limit`; `409 singleton_exists` only for an account
that still holds a second removed page of the topic from before revival.

## Page contents

### `GET /v1/pages/{id}/items?limit=50&cursor=&group=`
Items on the page in page order; trashed, merged and removed-from-page ones are left out.
`limit` is 1-200. `next_cursor` is the `link.id` of the last row, or `null` at the end.

```json
{
  "entries": [
    {
      "link": {
        "id": "uuid",
        "page_id": "uuid",
        "item_id": "uuid",
        "position": "V",
        "group_key": null,
        "manual_order": false,
        "manual_at": null,
        "pinned": false,
        "added_by": "rule",
        "removed_at": null,
        "seq": 1240,
        "updated_at": "2026-11-07T10:00:00Z",
        "updated_by": "agent"
      },
      "item": {"id": "uuid", "...": "the same ItemOut as GET /v1/items/{id}"},
      "fields": {"text": "...", "title": "...", "date": "2026-11-07T10:00:00+00:00"}
    }
  ],
  "next_cursor": null
}
```
`fields`: values by template field id, only those that have a value. «Сегодня» has no links: its
content comes from `/today` (week 9).

**Page order** (the phone must sort the same way): `position` ascending by bytes, `null` last; then
item `occurred_at` newest first (`created_at` if absent); then `item_id` ascending as a lowercase
string. Today `position` is always set; `null` is reserved for pages sorted by a field.

### `POST /v1/pages/{id}/items`
```json
{"item_id": "uuid"}
```
Show an existing item on this page (saving from «Своя страница»: `POST /v1/items`, then this).
Idempotent by page + item, no `client_id`. `201 {"link": PageItemOut, "created": true, "action":
Action}`, or `200` with `created: false` if it is already there (`action` set only when it lifted
an earlier «убрано»). `action` (week 9): `screen_add_item`, «Отменить» takes the row off again. It clears an earlier "removed from page". The item
goes where its date puts it; rows placed by hand keep their places.

Errors: `403 page_system` («Сегодня») · `404 not_found` · `409 item_deleted`.

## Sync

`GET /v1/sync?since=&limit=` gets two new arrays. Existing fields do not change.
```json
{
  "items": [],
  "screens": [PageOut],
  "screen_items": [PageItemOut],
  "tombstones": [{"entity": "item | screen | screen_item", "id": "uuid", "seq": 1, "deleted_at": "..."}],
  "next_since": 1234,
  "has_more": false
}
```
- `limit` counts all arrays together; everything is one stream in `seq` order from the shared
  `sync_seq`.
- `screens` includes removed pages (with `deleted_at`). Hide them, keep them for undo.
- `screen_items` includes rows with `removed_at`: hide them. Upsert by `(page_id, item_id)` or `id`.
- Show a link only when its item is live too. Items travel in `items` with `deleted_at` and
  `hidden_reason`.
- A tombstone is a hard delete: `screen_item` when the item is purged after 30 days in the trash,
  or when «Отменить» takes back a link the assistant added (`actions.md`); `screen` only when the
  account is deleted. Drop them locally by `id`.
- The assistant line changes rows too (week 6): `group_key` (stacks after «Разложи по темам»,
  names in `view_state.groups`), `position`, «убрано» (`removed_at`), new links. Records placed by
  hand (`manual_order`) are moved only after the person's «Да». The chat event `page_patch`
  carries the same rows at once.
- A brand-new account has one row right away: «Сегодня» in `screens`.

## Placement (`auto_rule`)

Code decides, no model call. A rule is
`{"any": [condition, ...]}`; it matches if any condition holds; `{"any": []}` never matches.

| Condition | Holds when |
|---|---|
| `{"always": true}` | always (`notes`: «Заметки» shows every record) |
| `{"kinds": ["pdf", ...]}` | `item.kind` is listed |
| `{"envelope_types": ["receipt", ...]}` | `item.envelope.type` is listed |
| `{"aspects": ["reminder", ...]}` | envelope has that part: `reminder`, `task`, `kp` (from `proposed`), `amount` (from `entities.amounts`) |
| `{"words": ["ремонт", ...]}` | a word in title, summary or text starts with it, ignoring case |

An item is placed when created and when its text is ready. Enrichment must call
`assistant.pages.place_item` after writing the envelope; until it does, rules that read the envelope
(`envelope_types`, `aspects`) match only on page creation and restore. Placing **only adds rows**: it never moves an existing row and never returns a row the person removed
(R-54). A new row goes above the first auto-placed row that is not newer, so a head of rows placed
by hand or pinned stays on top.

Learned placement (`placement_rule`, week 7): after the person moved 2 records of one kind to a page
by hand (`move-to-page`), new records of that kind are placed there too. It only adds rows, like the
rules.

## Ordering keys (LexoRank)

Shared vectors: `docs/spec/vectors/lexorank.json`; server code: `src/assistant/pages/lexorank.py`.
Alphabet `0-9A-Za-z`, compared by bytes (JS `<` on strings gives the same order; do not use
`localeCompare`). A key is a base-62 fraction and never ends in `0`.

- `between(null, null)` = `"V"`; `between(a, null)` is just after `a`; `between(null, b)` is just
  before `b`; `between(a, b)` is strictly between. `a >= b` or a malformed key is an error.
- `sequence(n)`: `n` evenly spaced keys, for filling a page.
- `between` on the phone: for optimistic display **and** for the `position` it sends with a move
  (see "Manual order"). Over 64 chars the server re-keys the page without changing the visible
  order (`sequence`), so expect a burst of `screen_items` in sync; a key the phone computed before
  that re-key is then not used (see `base_seq` below).

## Manual order (week 7)

Spec: `3-engineering.md` 4.10, 6.12; F-41, R-54; US-27, US-28. The person can move anything by
hand, online or offline, also in «Без ИИ». **What the person placed is theirs**: the assistant does
not move it without their «Да» (`confirm_manual` in `chat.md`), page rules and background work never
move it, and a row the person took off a page is never brought back there by the assistant or the
rules. Every call below is safe to queue in the outbox and to repeat: send the same `client_id` on
every retry, a new one for every new tap.

Fields of these calls:
- `client_id` (uuid; required, optional only on `DELETE`): idempotency. A repeat returns the first result with
  `repeated: true` and changes nothing.
- `client_ts` (ISO time with offset; optional, default the server's time, but always send it from
  the outbox, the same value on every retry): when the person did it on the phone. Two phones that moved **the same row** (or the same tab) offline: the later `client_ts`
  wins, equal times by the larger `client_id` (as a lowercase string). The loser gets `200`,
  `moved: false`, `reason: "newer_move"` and the row as it stands: show it there, no dialog. A time
  in the future counts as the server's time. Used by `items/move` and `pages/reorder`; accepted and
  not needed by `move-to-page` (two moves to different pages both stay) and `DELETE` (taking a row
  off a page always stands; a move of it from the other phone changes only its hidden place).

Every change that did something returns an `action` (shape of `actions.md`, `initiated_by: "user"`)
for the «Отменить» strip (10 s; 30 days in «Что я сделал»). «Отменить» = `POST
/v1/actions/{action.id}/undo`. If the move is still in the outbox (never sent), drop it from the
outbox instead: there is nothing to undo on the server. A call that changed nothing has
`action: null`.

### `POST /v1/pages/{id}/items/move`
«Выше / Ниже», drag and drop, the «Порядок» mode.
```json
{"client_id": "uuid", "client_ts": "2026-11-08T10:00:00+05:00",
 "item_id": "uuid", "after_item_id": "uuid or null", "before_item_id": "uuid or null",
 "position": "Vk", "base_seq": 1234, "group_key": "Ремонт", "base_view_version": 7}
```
- `item_id`: the row to move. `after_item_id` / `before_item_id`: the rows right above / right
  below its new place **as the person saw them** (at least one; null = the top / the bottom).
  «Выше» = before the row above it; «Ниже» = after the row below it.
- `position`: the key the phone computed, `between(above.position, below.position)` from its local
  rows, and `base_seq`: the `next_since` of the last `/v1/sync` the phone applied before it. Send
  both whenever you have them. The server stores that very key when it is a valid key of at most 64
  chars and the page was not laid out anew after `base_seq` (a re-key, «Разложи» by the assistant,
  or its «Отменить»: the neighbours then stand elsewhere). That is what makes two phones agree: two
  rows moved on two phones keep both their keys whatever order the calls arrive in, and two rows
  that got the same key are ordered by the page order below. Otherwise (no `position`, or stale)
  the server computes the key right after `after_item_id` (or right before `before_item_id`) among
  the rows as they are now: the person's place next to those rows wins. Only in this case can the
  result of chained moves depend on the order the calls arrive in.
- If the two neighbours have the same key (two phones put rows in one gap), the phone cannot compute
  a key between them: send no `position`; the server re-keys the page and places the row.
- `group_key` (optional): the group (stack) it goes into; `null` = out of any group; leave the field
  out to keep the group.
- `base_view_version` (optional): the page's `view_version` the person looked at. Never a conflict:
  the person's move always applies (human over AI); `rebased: true` says the page had changed.
- The row gets `manual_order: true`, `manual_at` = `client_ts`, `updated_by: "user"`; the page's
  `view_version` goes up. A row removed from the page meanwhile (other phone) takes the new place
  but stays removed.

`200`:
```json
{"moved": true, "reason": null, "repeated": false, "rebased": false,
 "link": PageItemOut, "action": Action, "page_patch": PagePatch}
```
- `reason` when `moved: false`: `newer_move` (a later move of this row won; `link` is where it
  is), `anchor_gone` (neither neighbour is on the page any more and no usable `position`; nothing
  changed).
- `page_patch` (shape of `chat.md`): the moved row; after a re-key, every row of the page.
- Errors: `404 not_found` (page, or the item not on it) · `403 page_system` («Сегодня») ·
  `422 validation_error` (no neighbour given, or the item is its own neighbour).
- A move on a removed page still applies (it comes back with that order on restore).

### `POST /v1/items/{id}/move-to-page`
«Переместить на страницу…» and «Показать ещё на…» (S39).
```json
{"client_id": "uuid", "client_ts": "...", "mode": "move",
 "from_page_id": "uuid", "to_page_ids": ["uuid"]}
```
- `mode: "move"`: shown on the chosen page and taken off `from_page_id` (required; exactly one page
  in `to_page_ids`). The record stays off `from_page_id` the same way as after «Убрать с этой
  страницы». `mode: "also_show"`: shown also on every page in `to_page_ids` (1-19); nothing is taken
  off. A page the person had removed the record from shows it again (they asked).
- A record already on a chosen page stays where it is there; a new row goes where its date puts it.
- A chosen page that was removed meanwhile (other phone) is skipped. With `move`, if no chosen page
  is live, the record is **not** taken off `from_page_id`: a move never leaves it on no page
  (`moved: false`, `reason: "page_removed"`). The same holds the other way round: when a page is
  removed, a record the person moved onto it that is on no other live page goes back on the page it
  was moved from.
- **Learning** (`placement_rule`, F-29): after the person moved or showed 2 different records of
  the same kind (receipt, document, contract, task, ...; not plain notes) on the same page, new
  records of that kind go there too. It only adds: the page rules still place them as before.
  `learned_ru` is set on the call that switched it on: show it after the result («Перенёс в
  Расходы. Похожие положу туда же»). «Отменить» of a move takes that record's count back.

`200`:
```json
{"moved": true, "reason": null, "repeated": false, "links": [PageItemOut],
 "action": Action, "page_patches": [PagePatch], "learned_ru": null}
```
`links`: the record's rows on the pages touched (`removed_at` set on the page it left). `reason`
when `moved: false`: `nothing_to_do` (already so), `page_removed`. Errors: `404 not_found` ·
`403 page_system` («Сегодня» as a source or target) · `409 item_deleted` · `422 validation_error`.

### `DELETE /v1/pages/{id}/items/{item_id}?client_id=`
«Убрать с этой страницы». The record stays in memory, in search and on its other pages; this page
keeps a hidden row (`removed_at`), so neither the rules nor the assistant put it back here. The
person can put it back: «Отменить», «Показать ещё на…», or `POST /v1/pages/{id}/items`.
`client_id` is optional (query); repeating on a removed row changes nothing.

`200`:
```json
{"removed": true, "repeated": false, "link": PageItemOut, "action": Action,
 "page_patch": PagePatch,
 "still_on": [{"id": "uuid", "title": "Документы и КП", "icon": "documents"}]}
```
`still_on`: live pages that still show it («Запись осталась в поиске и на странице …»).
Errors: `404 not_found` · `403 page_system`.

### `POST /v1/pages/reorder`
Tab order in «Мои страницы» (S34: drag, ↑ ↓). Same shape as a row move:
```json
{"client_id": "uuid", "client_ts": "...", "page_id": "uuid",
 "after_page_id": "uuid or null", "before_page_id": "uuid or null", "position": "W"}
```
«Сегодня» always stays first and cannot be moved (`403 page_system`); `after_page_id` = «Сегодня»
means the first place after it. `position`: the key the phone computed from its tab list (without
«Сегодня»); stored as is when valid (≤64 chars), otherwise computed from the neighbours. Same
`client_ts` rule for one page moved on two phones.
After «Отменить» of a tab move the order comes in `/v1/sync` (`screens`): `page_patches` carry rows
only.
`200 {"moved": true, "reason": null, "repeated": false, "page": PageOut, "action": Action}`;
`reason`: `newer_move`, `anchor_gone`. Errors: `404 not_found` · `403 page_system` ·
`422 validation_error`.

### `GET /v1/habits`, `DELETE /v1/habits/{id}?client_id=`
«Что я для вас настроил» (S30; F-29, US-27): the learned rules in use whose page is live, then
(week 9) the records the person took off a page («Убрать с этой страницы», `screen_exclusion`),
newest first, at most 100. An exclusion is not a habit row: it is the hidden page row itself, so
its `id` is that row's `link.id`.
```json
{"habits": [{"id": "uuid", "kind": "placement_rule", "text_ru": "Чеки кладу на страницу «Расходы»",
  "page": {"id": "uuid", "title": "Расходы", "icon": "money"}, "envelope_type": "receipt",
  "evidence_count": 2, "updated_at": "2026-11-08T10:00:00+00:00"}]}
```
```json
{"id": "uuid (link id)", "kind": "screen_exclusion",
 "text_ru": "Не показываю «Хлеб» на странице «Заметки»",
 "page": {"id": "uuid", "title": "Заметки", "icon": "documents"}, "envelope_type": null,
 "item_id": "uuid", "evidence_count": 1, "updated_at": "..."}
```
`item_id` is null on `placement_rule`.

`DELETE` = «Убрать»: new records are no longer placed by the rule, those already placed stay, and
further moves do not switch it on again. On a `screen_exclusion`: the record is shown on that page
again (`action` `screen_add_item`, «Снова показываю «Хлеб» на странице «Заметки»», «Отменить» takes
it off again).

### `PATCH /v1/habits/{id}` (S30 «Изменить», week 9)
`{"page_id": "uuid", "client_id": "uuid"}` on an active `placement_rule`: from now on such
records go to that page; records already placed stay where they are. `200 {"habit": Habit,
"action": Action, "repeated": false}` (`habit_change`, «Теперь: чеки кладу на страницу
«Расходы»», «Отменить» moves the rule back; the same page again: `action: null`). Errors: `404
not_found` (unknown, turned off, or a `screen_exclusion`: those have only «Убрать») · `403
page_system` («Сегодня») · `409 conflict` (`details.reason: "habit_exists"`: that page already
has such a rule).

Sync (week 9): `GET /v1/sync` has `habits: [Habit]` — learned rules (the `placement_rule` shape
above plus `status`: `candidate` | `active` | `disabled` and `seq`; show only `active` ones whose
page is live). Exclusions travel as `screen_items` rows with `removed_at`. `200 {"removed": true, "repeated": false, "action": Action}`
(«Отменить» as usual; `removed: false`, `action: null` when already off). `404 not_found`.

### Conflicts, in short
| Situation | Result |
|---|---|
| Two phones move different rows offline | both moves stay (each row keeps its own key) |
| Two phones move the same row offline | the later `client_ts` wins; the other phone sees it there after sync |
| The person moved a row while the assistant was arranging the page | the person's place stays (the assistant skips it; 6.12 rebase) |
| The assistant arranges a page with rows placed by hand | it asks «Вы сами расставили N записей. Переставить и их?»; «Оставить мои» keeps them |
| One phone took a row off the page, the other moved it | it stays off the page (with the moved place, for «Отменить») |
| Moved a record to a page that the other phone removed | the record stays on (or goes back to) the page it came from |
| «Отменить» after the person changed the row again | `partial: true`, «Часть уже изменена вами — вернул остальное» |

## Not here yet

| What | When |
|---|---|
| `PUT /pages/{id}/fields`, `POST /pages/{id}/reset`, sorting and grouping by field | week 11 |
| `POST /pages/batch` (use one `POST /pages` per page) | week 16 |
| Other kinds of habit (`alias`, `default_time`, `never_do`, ...) | later |
| `expense.*`, `document.*` field values (`task.*` and the shopping `facet.*` fields are filled from tasks since week 9, see `today.md`) | weeks 10-14 |
