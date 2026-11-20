# Calendar (Ф-89, direction A: the calendar is «Дела» in Day · 3 days · Month)

Contract for the phone. Design: `docs/design/system/calendar-time.md` (§3–§5, §10, §11). Data:
migration 0035. Everything here is behind the base consent like `/v1/tasks`. Times on the wire
are ISO 8601 with offset, **UTC on output**; `start` / `end` / `date` are the person's local
clock (`tz`, Asia/Almaty by default) so the grid can be drawn without time-zone math.

## The model

- **A to-do with a time** is a `tasks` row with `start_at` (+ `duration_min`, `tz`). Without
  `start_at` it is a to-do of a day (`due_date`: «весь день») or of no day (only «Список»).
  `all_day` = `start_at == null && due_date != null` (derived, not stored).
  When `start_at` is set, `due_date` is its local date (the server keeps both).
- `duration_min`: 5…1440, or null = a point in time (draw a 30-min block, thinner). Durations
  from phrases: «на час», «на 30 минут», «на полтора часа», «с 15 до 16:30», «до 17:00»; when
  none is said — встреча / визит / приём / урок / тренировка 60, звонок / созвон 30, anything
  else 60 (`timewords.DEFAULT_DURATIONS`).
- **Repeat**: `rrule` on the task (`FREQ=DAILY|WEEKLY|MONTHLY`, `INTERVAL` 1–12, `BYDAY` with
  WEEKLY, `BYMONTHDAY` with MONTHLY, `UNTIL=YYYYMMDDTHHMMSSZ`), counted from `start_at` on the
  `tz` clock. A repeating task needs `start_at`.
- **One occurrence** of a repeating task has its own row only when it differs: `task_occurrences`
  (`occurrence_at` = the original start, UTC) with `start_at` / `duration_min` (moved / resized),
  `done_at` (done), `skipped` (deleted «только это»). `tasks.done_at` is never set on a
  repeating task.
- **Reminders** stay as they are (`reminders.md`) and get an optional `duration_min` (null = a
  point: the capsule). A reminder linked to a timed task's record (`reminders.item_id` = the
  task's `item_id`) is that task's alert: it is **not** a separate calendar entry, it shows in the
  task's `reminder` and moves with the task.
- **Plan steps** (`plans.md`) with `remind_at` and no live task are read-only entries
  (`kind: "plan_step"`); «Сделать делами» turns them into timed tasks (`start_at` = `remind_at`,
  `duration_min` = the step's, if any) and the step entry gives way to the task's.
- `source`: `assistant` when the assistant line made the task, else `user` (the «помощник»
  label; the 24 h mark is the item's `assistant_changed_at` as everywhere).

## `GET /v1/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`

Local dates, both inclusive, `to - from` ≤ 61 days (Month = 42 days of a 6-week grid). `400
range_invalid` otherwise. Repeats are expanded by the server.

```json
{
  "tz": "Asia/Almaty", "from": "2026-11-20", "to": "2026-11-22",
  "now": "2026-11-20T04:41:00+00:00",
  "entries": [
    {"key": "task:0194…:", "kind": "task", "id": "0194…", "occurrence_at": null,
     "title": "Встреча с Ерланом", "date": "2026-11-20", "all_day": false,
     "start_at": "2026-11-20T10:00:00+00:00", "end_at": "2026-11-20T11:00:00+00:00",
     "start": "15:00", "end": "16:00", "duration_min": 60, "rrule": null, "moved": false,
     "done": false, "source": "assistant", "item_id": "0193…", "page_id": "0192…",
     "reminder": {"id": "0195…", "offsets": [15]}, "plan": null, "version": 3},
    {"key": "task:0194…:2026-11-21T04:00:00+00:00", "kind": "task", "id": "0194…",
     "occurrence_at": "2026-11-21T04:00:00+00:00", "title": "Пробежка", "date": "2026-11-21",
     "all_day": false, "start": "9:00", "end": "9:30", "duration_min": 30,
     "rrule": "FREQ=DAILY", "moved": false, "done": true, "…": "…"},
    {"key": "task:0196…:", "kind": "task", "title": "Оплатить свет", "date": "2026-11-20",
     "all_day": true, "start_at": null, "end_at": null, "start": null, "end": null, "…": "…"},
    {"key": "reminder:0197…:2026-11-20T13:00:00+00:00", "kind": "reminder", "id": "0197…",
     "occurrence_at": "2026-11-20T13:00:00+00:00", "title": "Таблетка", "date": "2026-11-20",
     "all_day": false, "start": "18:00", "end": null, "duration_min": null,
     "rrule": "FREQ=DAILY", "done": false, "source": "user", "item_id": null, "page_id": null,
     "reminder": null, "plan": null, "version": 1},
    {"key": "plan_step:0198…:st2", "kind": "plan_step", "id": "st2", "title": "Купить плитку",
     "date": "2026-11-22", "start": "10:30", "end": null, "duration_min": null,
     "plan": {"id": "0198…", "title": "Ремонт ванной"}, "item_id": "0198…", "…": "…"}
  ]
}
```

- Order: by `date`, all-day first, then `start`, then `title`.
- `key` is stable for one entry (use it for animation and the local cache).
- `occurrence_at`: set for every entry of a repeating task / reminder (send it back to change
  only that one); null for a single one.
- `done`: a task's `done_at` (single) or the occurrence's; a reminder occurrence is done when it
  was acked (`acked`) — read-only here.
- `moved`: this occurrence has its own time (`task_occurrences.start_at`).
- Skipped occurrences and trashed tasks are not listed. An entry that runs past midnight is
  listed on its start day.
- `end` / `end_at` null when `duration_min` is null.

## Create a timed to-do: `POST /v1/tasks`

As in `today.md`, plus (all optional):

```json
{"client_id": "…", "list_key": "todo", "title": "Встреча", "start_at": "2026-11-21T10:00:00+05:00",
 "duration_min": 60, "tz": "Asia/Almaty", "rrule": null}
```

`start_at` with an offset (any; stored UTC); `tz` defaults to the person's; `due_date` is set to
the local date of `start_at`. `rrule` without `start_at` → `422 validation_error`. A start in
the past is allowed by hand (the person drew it). The action is `save_item` with «Отменить».

## Move / resize / change: `PATCH /v1/tasks/{id}`

Body as in `today.md` (`version` required), plus `start_at` (null = make it all-day on
`due_date`), `duration_min`, `tz`, `rrule`, and for a repeating task the two fields below. A time
change goes alone: `title` / `qty` / `list_key` in the same body → `422 validation_error` (send
two PATCHes).

| field | meaning |
|---|---|
| `occurrence_at` | the entry's `occurrence_at`: change only that one (default scope `this`). Any ISO form with an offset: `…Z` and `…+00:00` are the same moment (also in the `DELETE` query, URL-encode `+` as `%2B`) |
| `scope` | `this` (only this occurrence) · `following` (this and the next ones) · `all` (the series; default without `occurrence_at`). «Все» for past ones is not offered in the UI. |

- `this`: writes the occurrence's own `start_at` / `duration_min`; `title` / `rrule` cannot be
  changed for one occurrence (`422 validation_error`).
- `following`: the series ends before this occurrence (`UNTIL`) and a new task starts here with
  the changes (and the same repeat unless `rrule` is sent). The response's `task` is the new one;
  `previous_task` is the ended series.
- A linked reminder (single, non-repeating) moves with the task by the same shift, in the same
  action (one «Отменить» / «Вернуть»).
- `200 {"task": Task, "action": Action, "occurrence": Occurrence | null, "previous_task": Task |
  null, "repeated": false}`. `start` / `end` are «H:MM» (no leading zero: «9:00», «15:00»). `409 conflict {version}` on a stale `version` (reload the task).
  The action (`facet_edit`, summary «Перенёс: встреча — 15:00 → 16:00» / «Изменил: …») has the
  inverse: `POST /v1/actions/{id}/undo` puts the time back (the notice «Вернуть»).

## Reminder of a to-do: `reminder_offset_min` (added 2026-11-20, after the first contract)

«Напомнить: за 10 мин / за 30 мин / за час / нет» of the add sheet and the task card.

- `POST /v1/tasks` and `PATCH /v1/tasks/{id}` take `reminder_offset_min`: minutes before
  `start_at`, 0…1440 (0 = at the start; the UI offers 10, 30, 60, 1440), or `null` = no alert.
  Only for a to-do with `start_at`; on an all-day one it is ignored.
- The server keeps **one linked reminder** for it (`reminders.item_id` = the task's `item_id`,
  `due_at = start_at − offset`, `rrule` = the task's repeat, notification level, `created_via:
  "manual_form"`). It is made / moved / cancelled **in the same action** as the task change, so
  «Отменить» / «Вернуть» covers both. Do not create it with `POST /v1/reminders` yourself.
- PATCH with only `reminder_offset_min` (and `version`) changes just the alert. Sent with
  `start_at` / `duration_min` it is one action. Moving the to-do without it keeps the offset (the
  alert moves along); making it all-day (`start_at: null`) leaves an existing alert alone.
- A new alert that would ring in the past (a one-off starting in 5 min with «за час») is not
  made: the response has `reminder_offset_min: null`.
- `Task` (in every payload and sync) and the calendar entry carry `reminder_offset_min` (int or
  null); the entry's `reminder` object has `offset_min` too.
- Repeating to-dos: the alert repeats with the series; moving the whole series moves it; «это и
  следующие» ends the old alert with the old series (`UNTIL`) and gives the new series the same
  offset; deleting the series cancels it. **Limitation:** one occurrence cannot have its own
  alert — `reminder_offset_min` with `occurrence_at` / `scope: "this"` → `422`, and an occurrence
  moved or skipped on its own still rings at the series' time.
- `POST /v1/reminders` already accepted `item_id` (a record's public id); a repeating reminder's
  `rrule` may now end with `UNTIL=YYYYMMDDTHHMMSSZ` (the alert of an ended series).

## Done: `POST /v1/tasks/{id}/done`

`{"client_id", "done": true, "occurrence_at": "…"}` — with `occurrence_at` only that occurrence
is done (its row's `done_at`); without it on a repeating task → `422 validation_error`.
`occurrence_at` that is not a start of the series → `422`. Response: `{"task", "action",
"occurrence"}`.

## Delete: `DELETE /v1/tasks/{id}?client_id=&occurrence_at=&scope=this|following`

- No `occurrence_at`: the task and its record go to the trash (as today), its linked reminders
  are cancelled in the same action.
- `scope=this`: only this occurrence is skipped. `scope=following`: the series ends before it.
- `200 {"task", "action", "occurrence"}`; «Восстановить» = undo of the action.

## Reminders

`POST /v1/reminders` and `PATCH /v1/reminders/{id}` accept `duration_min` (5…1440 or null);
`Reminder` carries it. Undo restores it. Everything else: `reminders.md`.

## Sync (`GET /v1/sync`)

- `tasks[]`: + `start_at`, `duration_min`, `tz`, `rrule`, `all_day`, `source`, `local`
  (`{"date", "start", "end"}` or null), `reminder_offset_min`.
- `task_occurrences[]` (new): `{"id", "task_id", "occurrence_at", "start_at", "duration_min",
  "done_at", "skipped", "version", "seq", "updated_at"}`. Hard deletes → tombstone
  `entity: "task_occurrence"`.
- `reminders[]`: + `duration_min`.
- The phone keeps ±60 days locally: expand repeats with the same rule (`tz` clock, rrule from
  `start_at`, occurrences by `occurrence_at`) or call `/v1/calendar` for the visible range.

## From the assistant line

«добавь встречу завтра в 15:00 на час», «запиши созвон в пятницу в 11», «поставь тренировку
каждый вторник в 19:00»: code reads the title, day, time, duration and repeat
(`assistant.timewords`; Ф-78), the task is made at once with «Отменить» (action `save_item`,
`changes[].kind: "create"`, the change row has `start_at`). The line says «Записал в Дела:
завтра, 15:00–16:00 — «Встреча»». A bare hour («в 7») or a time already past is asked first with
the `choice` proposal (`chat.md`, options `kind: "time"`, `plan.tool: "task_time"`; question
««Стоматолог» — в 9:00 или в 21:00?» / «Это время уже прошло. Сегодня в 11:00 или завтра в
9:00?»); the tap makes the task. A day without a time («добавь встречу с Айгерим на завтра») is an
all-day to-do («запиши …» with only a day stays a note in the person's words, as before; with a
clock time it is a to-do). A repeat whose first time today has passed simply starts with the
next one.
Default times of vague words: `reminders.md` «Time in words» (+ designer's §10.1: рано утром
7:00, до обеда 11:00, перед сном / поздно вечером 22:00, на выходных = the nearest Saturday, all
day; «через N минут» is rounded up to 5 minutes).
