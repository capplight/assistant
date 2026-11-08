# Actions API: «Что я сделал», «Что изменилось», «Отменить» (week 6)

Spec: `docs/spec/final/3-engineering.md` 3.7, 5.10, 6.11, 6.12; R-31, R-33, R-54; US-24, US-30.
Base path `/v1`. Every endpoint needs `Authorization: Bearer` and the base consents
(`pd_processing` + `terms`), else `403 consent_required`. Errors have the usual shape
`{code, message_ru, message_kk, details?}`.

Every change the assistant makes is one **action** with one «Отменить». One phrase in the line =
one action, even when it touched many records («Разложил 23 заметки в 5 групп»). The action keeps
the recipe to undo it; the server runs it, the phone never computes an undo itself.

Week 6 writes actions for the assistant line (`initiated_by: "agent"`) and for undo
(`initiated_by: "user"`). Week 7 adds the person's own moves (`initiated_by: "user"`, see
"Manual order" in `pages.md`): `screen_reorder_items` (moved a row: «Переставил «…»»),
`screen_move_items` («Перенёс «…» в «…»», «Теперь ещё на странице «…»»), `screen_remove_item`
(«Убрал «…» со страницы «…»»), `reorder_screens` («Переставил страницу «…»», no `changes` rows), `habit_change` (a learned rule turned off, no
`changes` rows).
Week 9 adds, on the same objects (the shapes below do not change):

| Where | `kind` | `summary.ru` (examples) | «Отменить» |
|---|---|---|---|
| `POST /v1/reminders` (S13 [Сохранить]) | `create_reminder` | «Напомню завтра в 7:00: выпить таблетку» | cancels it (fires `cancelled`) |
| `PATCH /v1/reminders/{id}` | `edit_reminder` | «Изменил напоминание «Выпить таблетку»» | old title/time/level back, fires re-planned |
| `DELETE /v1/reminders/{id}` | `edit_reminder` | «Удалил напоминание «Выпить таблетку»» | back, fires re-planned (a one-off whose time has passed stays deleted: `partial`) |
| tasks (`today.md`), the line | `save_item`, `facet_edit`, `delete_item` | «Добавил в Покупки: хлеб, молоко.», «Купил: хлеб» | trash / old values / back |
| `POST /v1/pages` | `create_screen` | «Добавил страницу «Покупки»» | the page is removed (records stay) |
| `DELETE /v1/pages/{id}` | `delete_screen` | «Страница «Покупки» убрана. Записи остались» | the page is back with its rows (as `/restore`) |
| `PATCH /v1/pages/{id}` | `screen_customize` | «Переименовал страницу в «Дача»» | old name / icon / layout |
| `POST /v1/pages/{id}/items` | `screen_add_item` | «Показал «…» на странице «…»» | the row goes again |
| `DELETE /v1/habits/{id}` on a `screen_exclusion` | `screen_add_item` | «Снова показываю «…» на странице «…»» | taken off again |
| `POST /v1/suggestions/{id}/accept` (`task_from_item`) | `save_item` | «Добавил в дела: оплатить свет.» | trash |
| `POST /v1/tasks/{id}/done` (a tick) | `facet_edit` | «Купил: хлеб» / «Сделал: …» / «Вернул: хлеб» | the tick goes back |
| `POST /v1/reminders/events` `acked` on a **missed** fire (late «Сделано» from «Сегодня») | `edit_reminder` | «Сделано: свет» | the occurrence is `missed` again (its fires and the reminder's status) |
| `PATCH /v1/habits/{id}` (S30 «Изменить») | `habit_change` | «Теперь: чеки кладу на страницу «Расходы»» | the rule goes back to its page |

**Ticks.** Every tick writes an action. Intended use: the 10-second «Отменить» strip after a tick
= `POST /v1/actions/{id}/undo` of that action (it also works after the tick left the outbox).
Tapping the box again is a new, separate change (`done: false`, «Вернул: …», its own action);
both are fine, neither breaks the other. Ticks are `initiated_by: "user"`: they are in «Что я
сделал», not in «Сегодня» → «Я сделал за вас».

**«Сделано» on reminders.** An on-time «Сделано» from the alarm screen writes no action (nothing to
take back: the moment has passed). A late one on a `missed` fire (the red row on «Сегодня») does:
`POST /v1/reminders/events` returns it in `actions` (matched to the event by `client_id`, which is
also the action's `client_id`); «Отменить» on it = `POST /v1/actions/{id}/undo`. While the event is
still in the outbox, drop it from the outbox instead.

`changes[].kind` adds `edit` (a reminder or a task changed), `done` (ticked / «Вернул»),
`reminder` (a reminder made, changed or removed: `item_id` null, `reminder_id` set; tap opens the
reminder; like `create_page` it has no «Вернуть» of its own, only «Отменить» of the action).
Task rows have `item_id` (the task's record) and `task_id`. Show `text` as before; unknown kinds:
just the text.

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
| `kind` | Weeks 6-7: `reorder_screens` (tabs), `screen_remove_item` (убрал со страницы), `screen_reorder_items` («Разложи», «отсортируй»), `screen_move_items` (перенёс / показал ещё на / убрал со страницы), `save_item` (записал), `delete_item` (в корзину), `user_edit` (переименовал), `create_screen` (страница). An undo has the kind of what it undid. More kinds come in week 9: show `summary`, do not switch on `kind`. |
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

## Pending «Да» (`pending_actions`, S25) — table and sync only in week 9

Everything external (send, delete for good, change an existing reminder on the assistant's
proposal, import) waits for «Да» as a pending action (spec 3.7). Week 9 adds the table and the
`pending_actions` array in `/v1/sync` with this shape; nothing creates one yet, so the array is
empty and there are no endpoints. The confirm/reject calls come with the first producer.

```json
{"id": "0194...", "kind": "change_reminder", "status": "proposed",
 "preview": {"title_ru": "Перенести «Выпить таблетку» с 7:00 на 8:00?"},
 "expires_at": "...", "message_id": null, "action_id": null, "seq": 1, "created_at": "...",
 "decided_at": null}
```
