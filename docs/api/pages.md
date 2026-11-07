# Pages API (sprint 3, part B)

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
  `expense.<x>`, `document.<x>`, `facet.<x>`. Only `item.*` and `envelope.*` have values today.
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

`201 {"page": PageOut, "created": true, "revived": false}`; repeating a `client_id` gives `200` and
`created: false`. On creation the page is filled at once from the items already in memory that match
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
not block a rename. Returns `PageOut`. «Сегодня»: `403 page_system`.

### `DELETE /v1/pages/{id}`
«Убрать страницу»: soft delete, items stay. Repeatable. Returns `PageOut` with `deleted_at`.
«Сегодня»: `403 page_system`.

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
Idempotent by page + item, no `client_id`. `201 {"link": PageItemOut, "created": true}`, or `200`
with `created: false` if it is already there. It clears an earlier "removed from page". The item
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
- A tombstone is a hard delete: `screen_item` when the item is purged after 30 days in the trash;
  `screen` only when the account is deleted. Drop them locally by `id`.
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

## Ordering keys (LexoRank)

Shared vectors: `docs/spec/vectors/lexorank.json`; server code: `src/assistant/pages/lexorank.py`.
Alphabet `0-9A-Za-z`, compared by bytes (JS `<` on strings gives the same order; do not use
`localeCompare`). A key is a base-62 fraction and never ends in `0`.

- `between(null, null)` = `"V"`; `between(a, null)` is just after `a`; `between(null, b)` is just
  before `b`; `between(a, b)` is strictly between. `a >= b` or a malformed key is an error.
- `sequence(n)`: `n` evenly spaced keys, for filling a page.
- The phone needs `between` only for optimistic display; the server computes stored keys from the
  neighbours' ids (week 7 `items/move`). Over 64 chars the server re-keys the page without changing
  the visible order, so expect a burst of `screen_items` in sync.

## Not here yet

| What | When |
|---|---|
| `POST /pages/reorder`, `POST /pages/{id}/items/move`, `POST /items/{id}/move-to-page`, `DELETE /pages/{id}/items/{item_id}` | week 7 |
| `PUT /pages/{id}/fields`, `POST /pages/{id}/reset`, sorting and grouping by field | week 11 |
| `POST /pages/batch` (use one `POST /pages` per page) | week 16 |
| `GET /pages/{id}/summary` | week 4 |
| `action` for the «Отменить» strip in responses (the `actions` table does not exist) | week 9 |
| `item_facets` values (`facet.*`, `task.*`, `expense.*`, `document.*` fields stay empty) | weeks 9-14 |
