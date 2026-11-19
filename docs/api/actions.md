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
Weeks 16а–16б add `screen_reorder_items` for a place on the free board (`views.md` «Доска»:
«Переставил «…» на доске», «Положил «…» наверх доски»; `changes[].kind: "place"`, «Вернуть» by
`item_id` puts that sticker back; a sticker moved again since stays, `partial`).
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

Week 10 adds (same shapes): `auto_merge_exact`, `merge_group`, `dismiss_group`, `cleanup_batch`
(repeats, `duplicates.md`), `create_stack`, `stack_add`, `stack_remove`, `delete_stack`, and
`user_edit` on a stack (`stacks.md`), `import_batch` (a Telegram import: «Отменить» moves what it
brought to the trash, `import.md`). `changes[].kind` adds `merge` and `keep_apart`. From the
assistant line every delete now asks «Да» first (`chat.md`, `confirm`) — replaced by Ф-66
(2026-11-16): no «Да» for a trash, see «Steps 3–4» below.

Week 11 adds (`views.md`): `screen_view_change` (a view setting, by hand or by the assistant),
`screen_reset` («Вернуть как было»), and `facet_edit` for values of a page's own fields
(`PATCH /pages/{id}/items/{item_id}`: own field values and the checklist tick `done`, «Отметил:
…» / «Вернул: …»). `changes[].kind` adds `view`, `field`, `color`, `pin`, `done`. A page rename
(`PATCH /pages/{id}` or `/view` with `title`) is undoable like any view change: its row has
`key: "<page>:title"`. A
view row has `item_id: null` and a **`key`** (the setting); «Вернуть» on it is
`POST /v1/actions/{id}/undo {"keys": [key]}`. `create_screen` is also written by «Сделать стопку
страницей» (`stacks.md`).

The pending «Да» endpoints exist from week 10: `GET /v1/pending-actions`,
`POST /v1/pending-actions/{id}/confirm`, `/reject` (`duplicates.md`; first producer: the cleanup
plan).

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

## Steps 3–4 of the vision plan (2026-11-16, Ф-64…Ф-73)

**`notice`** on every Action (chat `action` event, undo result, `/v1/actions`, `/v1/sync`): the
3-second top notice (Ф-65, Ф-67, Ф-75; design-system §10.2) — show it, do not build texts on the
phone.

```json
"notice": {"text_ru": "Записал в «Дела»", "text_kk": null,
           "target": {"kind": "task", "id": "0194...", "page_id": "0194..."},
           "undo_label_ru": "Отменить", "undo_label_kk": null, "ms": 3000}
```

- `text_ru` examples: «Записал в «Дела»», «Записал трату в «Расходы»», «Записал 3 записи в
  «Заметки»», «Удалил «Шины»», «Удалил 7 записей», «Обновил трату», «Вернул как было» (an undo),
  «Сохранил как заметку, разберу позже» / «Разобрал: перенёс в «Расходы»» (Ф-69), else the
  shortened `summary.ru`. `text_kk` null until reviewed (R-39): fall back to `text_ru`.
- `target`: where a tap goes — `kind` `expense` | `task` | `document` | `reminder` | `item` |
  `page`, `id` of that object, `page_id` to open (null for a record now in the trash). May be null.
- `undo_label_ru`: the button — «Восстановить» after a trash, «Вернуть» after an undo, else
  «Отменить»; null when `undoable` is false (show no button). The button = `POST
  /v1/actions/{id}/undo` as before. `ms`: 3000 for every notice (Ф-75).

**`parsed_later`** (bool): the action was made in the background by reading a note saved while the
model was down (Ф-69, `chat.md`). Such an action arrives only by `/v1/sync` — show its notice
when it arrives.

**«Изменил помощник» (Ф-73).** Every record an **agent** action creates or changes (its
`changes[].item_id`, not trash rows) gets `assistant_changed_at` + `assistant_action_id` on the
record (`items.md`), and so on its task and expense (`today.md`). Cleared when the person changes
the record (any of their own actions naming it, `PATCH /v1/items/{id}`) or undoes that action. The
server sends null once 24 h have passed; the phone hides a mark older than 24 h by itself too.
Tap on the mark → `GET /v1/actions/{assistant_action_id}` («Что изменилось», «Отменить»).

**Trash without «Да» (Ф-66).** A delete from the line is done at once (`delete_item`, notice
«Удалил … · Восстановить»); no `confirm` any more, at any count (≤50 records per call). The guard
is code: only a phrase whose own words ask to delete («удали», «выброси», «убери в корзину»)
can trash — record text never can. «Да» stays only for what cannot be undone (delete for good,
sending a КП to a client) and the existing big-reorder / hand-placed questions.

**Undo by phrase** («верни как было», «отмени», «отмени всё», «не туда», «верни запись про хлеб»):
see `chat.md`. It runs this same undo; the new action has `undo_of` set, the undone one gets
`undone_at`. «Отменить всё» of a multi-change phrase = the whole undo of that phrase's action
(one phrase = one action today; step 6 keeps several actions of a phrase under one `message_id`,
and the phrase undo already takes all actions of the last phrase together).

## Groups: several actions from one phrase (step 6, 2026-11-16)

One phrase may now make several actions («купил хлеб за 400 и молоко за 600, и напомни
оплатить свет» → two `create_expense` + a reminder draft; «сделай страницу Ремонт и перенеси туда
плитку» → `create_screen` + `screen_move_items`). **Each change is its own action** (its own
`summary`, `notice`, «Что изменилось», «Отменить» in «История»); all of them carry the same
`message_id` (the phrase's answer). This replaces «one phrase = one action» (week 6).

`group` on Action (null when the phrase made only one action):

```json
"group": {"id": "<the answer's message id>", "size": 3, "index": 0,
          "action_ids": ["0194...", "0194...", "0194..."],
          "notice": {"text_ru": "Сделал 3 дела", "text_kk": null, "target": null,
                     "undo_label_ru": "Отменить всё", "undo_label_kk": null, "ms": 3000}}
```

- Show **one** notice for the phrase: `group.notice` (not each action's own). Its button
  «Отменить всё» = `POST /v1/actions/groups/{group.id}/undo`. When everything is undone the text is
  «Отменено: 3 дела» and `undo_label_ru` is null.
- In «История» each action stays a row with its own «Отменить».
- At most 8 actions per phrase (`MAX_ACTIONS_PER_PHRASE`); the rest is said, not done.

**Tap groups (step 8, 2026-11-19).** «Сделать делами» on a plan (`plans.md`) makes one action
per step in one group without a chat answer: the group id is a new uuid kept in each action's
`payload.group_id`. For such actions `group` is set **whatever the size** (also 1), its notice
says what was made («Сделал 5 дел и 2 напоминания» / «Отменено: 5 дел и 2 напоминания»), and
`POST /v1/actions/groups/{group.id}/undo` takes that id like an answer id. «сделай делами» said in
the chat makes the same group under the answer (`group.id` = the answer id).

### `POST /v1/actions/groups/{group_id}/undo`

`{"client_id": "0194..."}` (optional; a repeat with the same one changes nothing). Undoes every
action of the phrase, **newest first**, in one transaction; each action in a savepoint, so one
that cannot be undone any more (30 days, nothing left) does not stop the others. An action already
undone alone counts as done (`repeated: true`).

`200`:

```json
{"undone": [UndoOut], "failed": [Action], "partial": false,
 "message_ru": null, "page_patches": [PagePatch]}
```

- `undone`: one `{action, undo, partial, repeated, message_ru: null, page_patches: []}` per action
  (as `POST /v1/actions/{id}/undo`), newest first; `page_patches` of all of them are at the top.
- `failed`: actions that could not be undone; then `message_ru` = «Вернул 2 из 3: остальное уже
  нельзя отменить.». `partial`: some records were changed by the person since (they keep theirs;
  `message_ru` «Часть уже изменена вами — вернул остальное.»).
- Errors: `404 not_found` (not this person's phrase / no actions), `410 undo_expired` (nothing
  could be undone).

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
  "saved_to": [{"page_id": "0194...", "title": "Заметки", "icon": "documents",
                "template_key": "notes", "item_ids": ["0193..."]}],
  "parsed_later": false,
  "notice": {"text_ru": "Записал в «Заметки»", "text_kk": null,
             "target": {"kind": "item", "id": "0193...", "page_id": "0194..."},
             "undo_label_ru": "Отменить", "undo_label_kk": null, "ms": 3000},
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
| `changes` | «Что изменилось»: one row per record, ready text in `text`. `kind`: `group`, `order`, `move`, `show`, `remove`, `trash`, `rename`, `create`, `create_page`, `place` (weeks 16а–16б: a sticker on the free board). `page_id`: the page the row is about, or null (a note placed only by the page rules). `reverted=true`: already returned with «Вернуть». At most 500 rows. |
| `changes[].item_id` null | Only for `kind: "create_page"` (the row is the new page itself, `page_id` = that page). Show the row with its `text` («Новая страница «Ремонт»»), tap opens `page_id`; it has **no** «Вернуть» of its own: the page goes only with «Отменить» of the whole action. Every other row has an `item_id`. |
| `changes[].diff` | Ф-73 inline edit (2026-11-19): on a row where the assistant changed what a record says — `[{"field": "title" \| "text", "before": str \| null, "after": str \| null}]` (each value at most 4000 chars), else absent / null. Set by a rename (`kind: "rename"`), an edit inside a note's text and a changed plan (`kind: "edit"`). Strike out `before`, highlight `after` (design-system §11.8 «правка помощника прямо в тексте»); the record has the same as `assistant_edit` for 24 h (`items.md`). |
| `plan` | Step 8: the «План» card when this action made or changed a plan (`plans.md` «PlanCard»), else null. |
| `changed_item_ids` | Highlight these for 600 ms. |
| `created_page_id` | Set when the action made a page (open it). |
| `saved_to` | Week 20 (Ф-50): the live pages the action's **new** records (`changes[].kind: "create"`) are on **now**, in tab order, each with those `item_ids`; `[]` for other actions, or when they were undone / moved off every page. The toast after a save: «Сохранил в «{saved_to[0].title}» · Переложить · Отменить». «Переложить» = `POST /v1/items/{item_id}/move-to-page` `{"mode": "move", "from_page_id": saved_to[0].page_id, "to_page_ids": [<chosen>]}` (`pages.md`, its own action and «Отменить»); afterwards the save's `saved_to` names the new page. |
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

All optional. `item_ids`: return only these records («Вернуть» on one row of «Что изменилось»);
`keys` (week 11, ≤100): return only these view settings (rows with `key`); without both:
everything («Отменить»). `{"client_id": "...", "keys": ["<page>:layout"]}`. Page-level parts (a page the action made, the page's group
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
