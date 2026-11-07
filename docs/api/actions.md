# Actions API: «Что я сделал», «Что изменилось», «Отменить» (week 6)

Spec: `docs/spec/final/3-engineering.md` 3.7, 5.10, 6.11, 6.12; R-31, R-33, R-54; US-24, US-30.
Base path `/v1`. Every endpoint needs `Authorization: Bearer` and the base consents
(`pd_processing` + `terms`), else `403 consent_required`. Errors have the usual shape
`{code, message_ru, message_kk, details?}`.

Every change the assistant makes is one **action** with one «Отменить». One phrase in the line =
one action, even when it touched many records («Разложил 23 заметки в 5 групп»). The action keeps
the recipe to undo it; the server runs it, the phone never computes an undo itself.

Week 6 writes actions for the assistant line only (`initiated_by: "agent"`) and for undo
(`initiated_by: "user"`). Week 9 adds the other kinds (reminders, merges, the person's own edits)
on the same objects; the shapes below do not change.

## Action

```json
{
  "id": "0194...",
  "kind": "screen_reorder_items",
  "scope": "internal",
  "initiated_by": "agent",
  "summary": {"ru": "Разложил 23 заметки в 5 групп", "kk": null},
  "page": {"id": "0194...", "title": "Заметки", "icon": "documents"},
  "changes": [
    {"item_id": "0193...", "title": "Плитка, замер", "kind": "group",
     "text": "«Плитка, замер» → Ремонт", "page_id": "0194...", "reverted": false}
  ],
  "changed_item_ids": ["0193..."],
  "created_page_id": null,
  "undoable": true,
  "undoable_until": "2026-12-07T10:00:00+00:00",
  "undone_at": null,
  "undo_of": null,
  "message_id": "0194...",
  "seq": 4567,
  "created_at": "2026-11-07T10:00:00+00:00"
}
```

| Field | Notes |
|---|---|
| `kind` | Week 6: `screen_reorder_items` («Разложи», «отсортируй»), `screen_move_items` (перенёс / показал ещё на / убрал со страницы), `save_item` (записал), `delete_item` (в корзину), `user_edit` (переименовал), `create_screen` (страница). An undo has the kind of what it undid. More kinds come in week 9: show `summary`, do not switch on `kind`. |
| `summary.ru` | Ready to show in the line: «Разложил 23 заметки в 5 групп». `summary.kk` is `null` until reviewed (R-39): fall back to `ru`. |
| `page` | The page it happened on (null: none / removed). |
| `changes` | «Что изменилось»: one row per record, ready text in `text`. `kind`: `group`, `order`, `move`, `show`, `remove`, `trash`, `rename`, `create`, `create_page`. `page_id`: the page the row is about, or null (a note placed only by the page rules). `reverted=true`: already returned with «Вернуть». At most 500 rows. |
| `changes[].item_id` null | Only for `kind: "create_page"` (the row is the new page itself, `page_id` = that page). Show the row with its `text` («Новая страница «Ремонт»»), tap opens `page_id`; it has **no** «Вернуть» of its own: the page goes only with «Отменить» of the whole action. Every other row has an `item_id`. |
| `changed_item_ids` | Highlight these for 600 ms. |
| `created_page_id` | Set when the action made a page (open it). |
| `undoable` | Show «Отменить» only when true: not undone yet, within 30 days, and has something to undo. |
| `undo_of` | On an undo: the action it undid. «Вернуть» right after «Отменено» = undo **this** action. |
| `message_id` | The chat answer that made it (open «Переписка» on it). |

## `GET /v1/actions?before=&limit=`

Newest first. `limit` 1...100 (default 30), `before` = an action id: older ones.
`{"actions": [Action], "has_more": bool}`. `404 not_found` for an unknown `before`.

## `GET /v1/actions/{id}` → Action

`404 not_found` when unknown or another person's.

## `POST /v1/actions/{id}/undo`

```json
{"client_id": "0194...", "item_ids": ["0193..."]}
```

Both optional. `item_ids`: return only these records («Вернуть» on one row of «Что изменилось»);
without it: everything («Отменить»). Page-level parts (a page the action made, the page's group
names) go back only with a whole undo.

**Offline.** The phone may show the old order at once (optimistically) and queue this call in its
outbox; the call is what undoes. Do not replace it with row writes (`items/move` etc.): the server
would then see the rows as moved by the person and keep them, so the queued undo would come back
`partial`. When the call comes back, take the server's rows (`page_patches` / sync) over the
local guess. `client_id`: a repeat with the same one returns the first
result. Undoing an action that is already undone also returns the first result (`repeated: true`)
and changes nothing.

`200`:

```json
{
  "action": Action,
  "undo": Action,
  "partial": false,
  "repeated": false,
  "message_ru": null,
  "page_patches": [PagePatch]
}
```

- `action`: the undone action as it is now (`undoable: false`, or rows `reverted: true`).
- `undo`: the new action. Show «Отменено · Вернуть» for 5 s; «Вернуть» = `POST
  /v1/actions/{undo.id}/undo`.
- `partial=true`: some records were changed by the person after the action; they keep the
  person's version. Show `message_ru` («Часть уже изменена вами — вернул остальное.»).
- `page_patches`: the rows of each page as they are now, to update the screen at once (shape as
  the chat event `page_patch`, see `chat.md`). `/v1/sync` brings the same rows.

Errors: `404 not_found` · `410 undo_expired` (older than 30 days, or nothing to undo) ·
`422 validation_error`.

## Sync

`GET /v1/sync` has a new array `actions: [Action]`: every action created or changed (undone,
rows returned) since `since`, in the same `seq` stream as the other arrays, counted in `limit`.
Upsert by `id`. Tombstones may have `entity: "action"` (only when the account is deleted). The
first sync (`since=0`) brings all of them: keep what «Что я сделал» shows (30 days).
