# «Сегодня», дела и покупки, подсказки, «Да» на внешнее (week 9)

Spec: `docs/spec/final/3-engineering.md` 3.x (`tasks`), 3.4 (`suggestions`, `suggestion_counters`),
3.7 (`pending_actions`), 4.5, 4.6, 6.5; product F-12, F-16, F-18, US-10, 6.8, 6.9; design S06,
S12/S37, S25. Base path `/v1`. Every endpoint needs `Authorization: Bearer` and the base consents
(`pd_processing` + `terms`), else `403 consent_required`. Errors: `{code, message_ru, message_kk,
details?}`. Timestamps: ISO 8601 with offset, UTC on output. Dates (`due_date`, `date`): `YYYY-MM-DD`
on the person's clock (`users.tz`).

Every change below is an **action** (`actions.md`) with one «Отменить»: the response carries it,
`/v1/sync` brings it, «Что я сделал» lists it. The phone never computes an undo itself.

## Tasks: «Дела» and «Покупки» (F-12, US-10)

A task is one line of a list: a to-do («Позвонить маме») or a thing to buy («Хлеб»). Each task
has its own record (`item_id`, kind `note`, text = the task's title), so it is on pages like any
record (page = view on the shared memory), found by search and goes to the trash with «Отменить».

### Task

```json
{
  "id": "0194...", "client_id": "5f0c...", "item_id": "0194...",
  "list_key": "shopping",
  "title": "Хлеб", "qty": "2", "where": null,
  "due_date": null,
  "done": false, "done_at": null,
  "version": 1, "seq": 901,
  "created_at": "...", "updated_at": "...", "deleted_at": null
}
```

| Field | Notes |
|---|---|
| `list_key` | `todo` («Дела») or `shopping` («Покупки»). |
| `title` | 1–200 chars. On «Покупки» = ★Что, on «Дела» = ★Что. |
| `qty`, `where` | «Сколько», «Где купить»: free text ≤60, or null. Shopping only (ignored on `todo`). |
| `due_date` | «Когда» for a to-do (no time: a time makes it a reminder). Null = no day. |
| `done` / `done_at` | ★Куплено / ★Сделано. |
| `deleted_at` | Set when the task went to the trash (its record too). Hide it. «Отменить» brings both back. |
| `version` | Pass back in PATCH (`409 conflict` when stale). |

Show a task only while its record is live (`items[].deleted_at` null), like page rows.

### Where a task shows

Week 19 (Ф-35): with no «Покупки» yet, the first thing to buy makes it (once; not when the person
removed one) — see `features.md` «Pages made on first use». Otherwise as below.

- On the page «Покупки» (`template_key: "shopping"`) for `shopping`, on «Дела и напоминания»
  (`tasks`) for `todo`. A `shopping` task goes to «Дела и напоминания» when the person has no
  «Покупки» page (US-10). With neither page it is still saved (in «Заметки», search, «Сегодня»);
  no page is made for it (pages only on request, R-55).
- Page rows are the usual `screen_items` (order, manual moves, «Убрать с этой страницы» work as
  everywhere). `GET /v1/pages/{id}/items` on these pages adds `entries[].task` (Task or null) and
  fills `fields`: «Покупки» `what`, `qty`, `bought`, `where`; «Дела» `what`, `when` (= `due_date`),
  `done`. Show done tasks at the bottom, grey, with «Вернуть» (design S37); the server keeps the
  page order and does not move rows when a task is ticked.
- «Дела и напоминания» also shows the person's reminders (from `/v1/sync` `reminders`, or
  `GET /v1/reminders`); they are not page rows.
- A page made later (`POST /v1/pages`, `template_key: tasks | shopping`) is filled at once with the
  live tasks of its list.

### `GET /v1/tasks?list_key=&include_done=false`

`{"tasks": [Task]}`: live tasks (record live, not trashed), newest first, at most 500.
`list_key` optional (both lists).

### `POST /v1/tasks` → `201`

```json
{"client_id": "5f0c...", "list_key": "shopping", "title": "Хлеб", "qty": null, "where": null,
 "due_date": null}
```

«+ → Вручную» on «Покупки» / «Дела» (also in «Без ИИ»). `client_id` required: a repeat returns
`200` with the first result. Response:

```json
{"task": Task, "action": Action, "page_patches": [PagePatch], "repeated": false}
```

`action.kind` = `save_item`, `summary.ru` «Добавил в Покупки: хлеб.» / «Добавил в дела: позвонить
маме.»; «Отменить» = the task and its record go to the trash. Errors: `422 validation_error`.

### `PATCH /v1/tasks/{id}` → `200 {task, action, repeated}`

Body: `version` (required), `client_id` (optional, week 12: send it from the outbox; a repeat with
the same `client_id` returns the first `task` + `action` with `repeated: true` and skips the version
check, so «− 2 +» and its «Отменить» are safe to retry) + any of `title`, `qty`, `where`,
`due_date`, `list_key`. A change of
`list_key` moves it between «Покупки» and «Дела» (the row on the old page is taken off, a row on the
new page is added). `action.kind` `facet_edit`, «Отменить» puts the old values back (a field the
person changed again since keeps their version: `partial`). Errors: `404 not_found`, `409
conflict`, `422 validation_error`.

### `POST /v1/tasks/{id}/done` → `200 {task, action, repeated}`

```json
{"client_id": "a1b2...", "done": true}
```

One tap = one call (outbox-safe: same `client_id` on retry). `done: false` = «Вернуть». `action`:
`facet_edit`, «Купил: хлеб» / «Сделал: позвонить маме» / «Вернул: хлеб», with «Отменить» (US-10:
the tick is in «Что я сделал»). Already in that state: `action: null`. Errors: `404 not_found`.

### `POST /v1/tasks/clear-done` → `200` (week 11а, «Убрать все купленные»)

```json
{"client_id": "uuid", "list_key": "shopping", "task_ids": ["0194...", "..."]}
```

`client_id` required (outbox-safe: a repeat returns the first result with `repeated: true`).
`list_key` default `shopping` (`todo` = «Убрать сделанное»). `task_ids` (optional, ≤500): only these,
send the ones the person saw as bought, so a line ticked on another phone meanwhile stays. Only
tasks that are done are taken. Response:

```json
{"tasks": [Task], "action": Action, "page_patches": [PagePatch], "repeated": false}
```

The tasks and their records go to the trash in **one** action (`delete_item`, «Убрал купленное:
хлеб, молоко.», up to 5 names then «и ещё N»), one `changes[]` row per task (`kind: "trash"`).
One «Отменить» brings all back; «Вернуть» on a row brings one. Nothing done: `action: null`,
`tasks: []`.

### `DELETE /v1/tasks/{id}?client_id=` → `200 {task, action}`

The task and its record go to the trash (`action.kind` `delete_item`, «Убрал в корзину: хлеб»).
Repeat: `action: null`.

### From the assistant line (finish criterion: «дела и покупки голосом из строки на любой странице»)

`POST /v1/chat/messages` on **any** page: «купить хлеб, молоко и лекарства маме», «надо купить
хлеб», «добавь в покупки молоко», «позвонить маме завтра», «запиши: забрать посылку». Who reads
the phrase:

- default (`TASKS_RULES_FIRST` off, founder decision Ф-1 open): the light model reads the phrase
  alone (task `tasks_parse`, needs `ai_cross_border`, which the line already requires). Code checks
  the reading: every title and quantity must be in the person's words, else it is dropped.
- `TASKS_RULES_FIRST=true` (Ф-1 taken): code reads simple lists first («купить X, Y и Z», «надо
  купить…», «добавь в покупки…», «в список…»); what code does not read goes to the model.
- Not a list (or the model is down): the phrase is saved as a plain note, as before («Записал.»).
  On «Покупки» / «Дела» such a note is a page row with `task: null`: show it as a plain row.
- When the line is on «Покупки» / «Дела», a bare phrase («хлеб», «хлеб, сыр») is read as a line of
  that list. A title already open on the list is not added twice («уже в списке» in the change
  row); a bought one comes back on the list.
- The assistant's own `create` on a list page also makes a task.

The answer is one `action` (`kind: "save_item"`) for the whole phrase:
`summary.ru` «Добавил в Покупки: хлеб, молоко, лекарства маме.» (or «Добавил в дела: …» / with no
list page «Записал: …»), one `changes[]` row per task (`kind: "create"`, `page_id` of the list
page), `page_patch` for that page, and the `action` event has `"tasks": [Task]` for instant
display. `action.page` = the list page: show [Открыть] when it is not the page the person is on
(design 4.4: «Добавил в Покупки: молоко [Открыть] [Отменить]»). One «Отменить» takes all of them
back; «Вернуть» on one row of «Что изменилось» takes back one.

## «Ежедневник» — the planner on «Дела» (week 11а, proposal 2.3)

Layout `builtin:planner` (the default of `tasks` v3). **No new endpoint**: the sheet is built on
the phone from what `/v1/sync` already brings (`reminders`, `reminder_fires`, `tasks`,
`screen_items`), so it works offline the same way. Rules (dates and times on the person's clock,
`users.tz`; a reminder's own `local` is shown as is):

| Part of the sheet | What goes there |
|---|---|
| **Hours** (timed rows) | Occurrences of live normal reminders (`kind: normal`, `deleted_at` null, `status` not `cancelled`) on that date: the fire with `offset_min: 0`, `snooze_n: 0`, by `occurrence_at` → local `HH:MM`, sorted by time. Repeating reminders: the server keeps fires 14 days ahead. A snoozed occurrence keeps its row at its own time and shows «Отложено до HH:MM» (the newest snooze fire). Level: «Будильник» / «Уведомление» from `level`. |
| A page row with a time | A row whose record has such a reminder (`reminder.item_id` = the row's item) is drawn **in its hour** (once — not also among the rows without time). It cannot be dragged and has no «Выше / Ниже»: its menu has «Перенести время» (`PATCH /v1/reminders/{id}`; +15 мин / +1 час / Завтра / Выбрать). The server refuses such a move with `moved: false, reason: "timed"` and «Разложи» leaves these rows in place. |
| **Без времени** (all-day) | To-dos (`list_key: todo`, not done) with `due_date` = that date, and on «Сегодня» also those with no `due_date` and the page's plain rows (`task: null`); in page order — the person's manual order holds here (`POST /pages/{id}/items/move`). |
| **Пропущено** | To-dos not done with `due_date` < today (overdue, oldest first), and `missed` fires of the last 24 h not acked since (as `/v1/today` `missed`: [Сделано] [Перенести]). |
| **Сделано (N)** | To-dos done today (`done_at` on today's date) and occurrences acked today; grey, «Вернуть» (`POST /v1/tasks/{id}/done {"done": false}`). |
| «Сейчас» line | Between the hour rows at the device's current time on today's sheet only; also as text «Сейчас 11:20». |

«Скоро» is the same sheet for the next days (headers «Завтра, среда» / «Пт, 13 ноя»; dates with
nothing are left out). `GET /v1/today` is unchanged (its `today.tasks` lists only to-dos with
`due_date` ≤ today; undated ones are the planner's own «Без времени»).

## «Покупки» — the fridge list and «Я в магазине» (week 11а, proposal 2.4)

Layout `builtin:shopping` (the default of `shopping` v3). Server side it is the existing calls:
tick `POST /v1/tasks/{id}/done`, «− 2 +» `PATCH /v1/tasks/{id} {qty, version}`, groups by
«Где купить» = `view_state.group_by: "where"` («Сгруппируй по магазинам» from the line, or S38),
the person's order of the groups = `view_state.group_order` (`views.md`; the shop walk order),
«Убрать все купленные» = `POST /v1/tasks/clear-done`. Bought lines always at the bottom, in
«Куплено (N)». «Я в магазине» is a phone-only mode (no server state): it works offline from the
local copy, every tick goes through the outbox as usual.

## «Сегодня»: `GET /v1/today` (S06, F-16, 6.9)

Built on request from what the server holds (also in sync): no state of its own. Opening it also
runs the suggestion engine (below), so call it when the tab is shown, not in the background.

```json
{
  "date": "2026-11-08", "tz": "Asia/Almaty", "greeting": "Добрый день",
  "sections": ["banner", "missed", "today", "done_for_you", "proposals", "tip"],
  "today": {
    "reminders": [TodayReminder],
    "tasks": [Task],
    "shopping": {"page_id": "0194...", "count": 3, "titles": ["Хлеб", "Молоко", "Лекарства маме"]}
  },
  "missed": [TodayReminder],
  "done_for_you": {"actions": [Action], "count_today": 4},
  "banner": ChatMessage,
  "proposals": [Suggestion],
  "tip": Suggestion,
  "empty": false,
  "example": null
}
```

| Field | Notes |
|---|---|
| `greeting` | «Добрый день» or «Добрый день, Нурлан» (`display_name`). |
| `sections` | Order to show them in (6.9): `missed` and `today` first when there is anything due or missed; empty sections are left out. Ignore names you don't know. |
| `today.reminders` | Occurrences of live normal reminders on today's local date, by time. |
| `today.tasks` | To-dos not done with `due_date` ≤ today (overdue first), at most 20. |
| `today.shopping` | Null while the shopping list is hidden (`features.shopping`, Ф-49). Otherwise not-bought shopping tasks: count and the first 5 titles («Покупки: хлеб, молоко (3)»); `page_id` of «Покупки» or null. Null when there are none. |
| `missed` | `missed` occurrences of the last 24 h not acked since: a red row «Пропущено 10:00 · Позвонить Ерлану» [Сделано] (= event `acked` on that fire, see `reminders.md`) [Перенести] (S13 → `PATCH /v1/reminders/{id}`). |
| `done_for_you` | Up to 3 newest actions of the assistant (`initiated_by: "agent"`) of the last 24 h, not undone; `count_today` all of them today. «Что я сделал ›» opens the full list. |
| `banner` | The answer waiting for the person (`GET /v1/chat/pending-banner`), or null. |
| `proposals` | ≤2 data proposals (Suggestion, `kind: "data_proposal"`). |
| `tip` | ≤1 tip (Suggestion, `kind: "tip"`) or null. |
| `empty` / `example` | `empty=true`: no records and no reminders yet; `example` = «Например: напомни в пятницу оплатить свет» (the tip `first_reminder` comes in `tip`). |

TodayReminder:

```json
{"reminder": Reminder, "fire": Fire, "occurrence_at": "2026-11-08T05:00:00+00:00",
 "local_time": "10:00", "state": "planned"}
```

`fire` = the occurrence's own fire (`offset_min: 0`, the newest snooze if snoozed); `state` is
that fire's state. Reminder and Fire as in `reminders.md`.

## Suggestions: tips and proposals (F-18, R-35, 6.8)

The assistant never acts by itself: a suggestion only asks, and nothing happens until the person
taps [Да]. Limits are the server's (config `suggestions.*`), the phone just shows what it gets:

- tip: in the first 14 days of the account ≤2 a day, then ≤1 a day; ≤1 on screen; 2× «Не сейчас»
  for the same tip → not shown for 30 days.
- data proposal: ≤2 on «Сегодня» at once; it disappears silently after 24 h (`expired`).
- «Сохраните записи — укажите номер» (`link_phone`, anonymous accounts): from day 3 and the 20th
  record, ≤1 a week, ≤3 times in all (R-08).
- Suggestions never make a push (so nothing in quiet hours either).

**Beta scope (Ф-42, week 19, `features.md`):** one tip a day (`TODAY_TIPS_PER_DAY=1`) and only in
the account's first 7 days (`TODAY_TIPS_DAYS`), then none; data and page proposals are off
(`FEATURE_TODAY_PROPOSALS`: `proposals: []`, none are made); page tiles are off
(`FEATURE_TODAY_TILES`: `page_tiles: []`, pinned ones too). The rules above apply inside these
caps when a switch is on.

### Suggestion

```json
{
  "id": "0194...", "kind": "tip", "key": "arrange_here",
  "text_ru": "Скажите здесь: «разложи по темам»",
  "yes_label": "Попробовать", "no_label": "Не сейчас",
  "do": {"type": "put_phrase", "phrase": "разложи по темам", "page_id": "0194..."},
  "source_item_id": null,
  "status": "shown", "expires_at": null, "seq": 950, "created_at": "..."
}
```

Week 9 keys and what [Да] does (`do.type` — the phone does it, then calls `accept`):

| `key` | Shown when | `text_ru` | `do` |
|---|---|---|---|
| `first_reminder` (tip) | no records and no reminders | «Скажите: „Напомни в пятницу оплатить свет“» | `open_mic` |
| `ask_anything` (tip) | ≥15 records, no question asked yet | «Спросите: „Что я записывал про врача?“» | `open_mic` |
| `arrange_here` (tip) | a page with ≥10 records never arranged | «Скажите здесь: «разложи по темам»» | `put_phrase` + `page_id` (open that page, put the phrase in the line; the person sends it) |
| `photo_paper` (tip) | account ≥3 days, no photo in 3 days | «Сфотографируйте квитанцию — найду её словами» | `open_camera` |
| `share_from_apps` (tip) | account ≥5 days, nothing shared in 5 days | «Делитесь из WhatsApp и браузера — кнопкой „Поделиться“» | `show_share_help` |
| `link_phone` (tip) | anonymous, see the rule above | «Сохраните записи — укажите номер» | `link_phone` (S04b) |
| `task_from_item` (data_proposal) | a new record (≤3 days) proposes a to-do | «Добавить в дела: «Оплатить свет»?» | `accept` adds the task at once (`action` with «Отменить») |
| `reminder_from_item` (data_proposal) | a new record proposes a reminder | «Напомнить: «Оплатить свет» — в пятницу?» | `accept` returns `reminder_draft` (S13, nothing saved; [Сохранить] → `POST /v1/reminders` with `created_via: "agent_suggestion"`) |

Week 16 adds `page_from_stack`, `add_documents_page` (page proposals, R-55), the tip
`add_ready_pages` (`do.type: "open_gallery"`) and `page_tiles` on «Сегодня» (≤2, by a code rule;
the rule shows none in the account's first 7 days, but a tile pinned by hand with
`PUT /pages/{id}/today-tile` shows from day one, and a hidden one never): see `onboarding.md`.

Unknown `key` / `do.type`: show `text_ru` with [Не сейчас] only.

### `GET /v1/suggestions` → `{"proposals": [Suggestion], "tip": Suggestion | null}`

What «Сегодня» shows (same rules). `GET /v1/today` includes it.

### `POST /v1/suggestions/{id}/accept`

Body `{"client_id": "..."}` (optional; repeat → the first result). Response:

```json
{"suggestion": Suggestion, "action": Action, "task": Task, "reminder_draft": ReminderParseResult}
```

`action` / `task` only for `task_from_item`; `reminder_draft` (the `POST /v1/reminders/parse`
result shape, see `reminders.md`) only for `reminder_from_item`; null otherwise. Errors: `404
not_found` · `410 suggestion_expired` («Это предложение уже неактуально»).

### `POST /v1/suggestions/{id}/dismiss` → `{"suggestion": Suggestion}`

«Не сейчас». Counts towards the 30-day pause. Repeat: no change.

## Sync

`GET /v1/sync` has more arrays in the same `seq` stream (counted in `limit`, upsert by `id`):
`tasks: [Task]` (a task purged with its record comes as a tombstone `entity: "task"`),
`suggestions: [Suggestion]` (status changes too: hide `accepted`, `dismissed`, `expired`),
`pending_actions: [PendingAction]` (`actions.md`; always empty in week 9), `habits: [Habit]`
(`pages.md`).

## The briefing: `brief` in `GET /v1/today` (week 20, mocks v2, Ф-55)

«Сегодня» is a morning / day / evening briefing. Everything is counted and worded by code (no
model call); texts in `ru` and `kk` (kk until reviewed).

```json
"brief": {
  "part": "morning",
  "headline": {"ru": "Доброе утро · 5 дел", "kk": "Қайырлы таң · 5 іс"},
  "lines": {"ru": ["Спокойный день.", "Таблетка в 9:00, в 14:30 — забрать Алию.",
                   "Потрачено 18 400 ₸, в бюджете ещё 41 600 ₸."], "kk": ["…"]},
  "metrics": {
    "tasks": {"done": 1, "total": 5, "next_time": "09:00", "next_title": "Таблетка"},
    "spent": {"currency": "KZT", "today": "18400.00", "count_today": 3, "month": "86400.00",
              "budget": Budget | null},
    "reminders": {"today": 2, "next_time": "09:00"},
    "tomorrow": {"count": 3, "first_time": "10:00", "first_title": "Позвонить папе"},
    "new_records": {"count": 4, "since": "2026-11-11T19:00:00Z", "period": "yesterday"}
  },
  "plan": [{"kind": "reminder", "title": "Таблетка", "time": "09:00", "at": "…", "done": true,
            "missed": false, "reminder_id": "0194…", "task_id": null, "item_id": null},
           {"kind": "task", "title": "Купить молоко", "time": null, "at": null, "done": false,
            "missed": false, "reminder_id": null, "task_id": "0194…", "item_id": "0193…"}],
  "waiting": [{"kind": "missed", "title": "Позвонить в банк", "text_ru": "пропущено вчера в 12:00",
               "at": "…", "reminder_id": "0194…", "task_id": null, "item_id": null,
               "message_id": null}]
}
```

| Field | Notes |
|---|---|
| `part` | `morning` (before 12:00 local), `day` (12–18), `evening` (from 18:00). |
| `headline`, `lines` | Ready text: headline + ≤3 lines (mood; what is next / left / tomorrow; money). Only numbers code counted. |
| `metrics.tasks` | The day's things = today's reminder occurrences + to-dos due today (done or not); `next_*` = the next open one. |
| `metrics.spent` | Today and this month in the budget's currency (KZT without a budget); `budget` = Budget (`expenses.md`) or null. |
| `metrics.reminders` / `tomorrow` | Today's occurrences and the next time; tomorrow's reminders + to-dos due tomorrow. |
| `metrics.new_records` | Records added (not to-dos, expenses, КП) since yesterday's start in the morning, since midnight later (`period`). |
| `plan` | The time-ordered day plan: reminders by time, then «без времени» to-dos. «Готово» on a reminder = event `acked`; on a to-do = `POST /v1/tasks/{id}/done`. |
| `waiting` | «Ждёт вас», ≤5: `missed` reminders (24 h; «Перенести» as `missed`), `overdue` to-dos (due before today), `question` (an answer waits for a tap: open `message_id`). |

The older sections (`today`, `missed`, `done_for_you`, …) stay as they were.
