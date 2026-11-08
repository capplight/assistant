# Reminders API: alarms, fires, ack events, push backup (week 8)

Spec: `docs/spec/final/3-engineering.md` 3.x (`reminders`, `reminder_fires`, `reminder_events`),
4.5, 6.6; `02-resolutions.md` 2.5, R-05, R-09…R-14; design S12, S13, S14, S15, flow 6.4.
Base path `/v1`. Every endpoint needs `Authorization: Bearer` and the base consents
(`pd_processing` + `terms`), else `403 consent_required`. Errors: `{code, message_ru, message_kk,
details?}`. All timestamps are ISO 8601 with offset, UTC on output (`...+00:00`).

**Who does what.** The server is the source of truth for reminders and their fires. The phone
plans the nearest fires as local alarms, rings, makes the 3 repeats (+5/+10/+15 min) itself and
reports what happened as events. The server sends a backup push when no phone reported
`fired_local` within 3 min, and marks the fire `missed` at +30 min (push «Вы пропустили…»).

## Objects

### Reminder

```json
{
  "id": "0194...", "client_id": "5f0c...",
  "title": "Выпить таблетку", "body": null,
  "due_at": "2026-11-09T02:00:00+00:00", "tz": "Asia/Almaty",
  "local": {"date": "2026-11-09", "time": "07:00"},
  "rrule": null,
  "offsets": [60],
  "level": "alarm",
  "kind": "normal",
  "created_via": "typed", "parse_source": "rules",
  "sensitivity": null,
  "status": "scheduled",
  "snooze_until": null,
  "item_id": null,
  "when_text": "Завтра, понедельник, 9 ноября · 7:00 · Будильник · и за час",
  "version": 1, "seq": 812,
  "created_at": "...", "updated_at": "...", "deleted_at": null
}
```

| Field | Notes |
|---|---|
| `due_at` + `tz` | The event moment (UTC) and the IANA zone it was set in. `local` is the same moment on that zone's clock — show it, don't recompute. For `rrule` it is the first occurrence (DTSTART). |
| `rrule` | RFC 5545 rule without DTSTART, or null. Accepted: `FREQ=DAILY`, `FREQ=WEEKLY;BYDAY=MO,TU,...`, `FREQ=MONTHLY;BYMONTHDAY=1..31`, optional `INTERVAL=n` (1..12). Anything else → 422. Expanded on the zone's local clock. |
| `offsets` | Extra alerts, minutes **before** the event: `15`, `60`, `1440` («накануне»). The event moment itself always rings too. At most 3. |
| `level` | `alarm` («Будильник») or `notification` («Уведомление»). Two levels only. |
| `kind` | `normal` or `test` (S15 «Проверить будильник»). Hide `test` from lists and «Сегодня». |
| `created_via` | `voice`, `typed`, `agent_suggestion`, `manual_form`. |
| `parse_source` | `rules` (code), `llm` (the model), `user_edit` (the person set or changed the time), null. |
| `sensitivity` | `health` or null. A `health` reminder's text never goes into a push, even with `push_content`. |
| `status` | `scheduled`, `fired`, `snoozed`, `done` («Сделано»), `missed`, `cancelled`. A repeating reminder stays `scheduled`; its occurrences live in fires. |
| `when_text` | Ready S13 line. |
| `version` | Pass back in PATCH (`409 conflict` when it moved on). |
| `deleted_at` | Set on DELETE (`status=cancelled`). Rows are never hard-deleted: no tombstones. |

### Fire

One planned alert: one per occurrence × (event moment + each offset), plus one per «Отложить».

```json
{
  "id": "0194...", "reminder_id": "0194...",
  "key": "0194...:2026-11-09T02:00:00Z:60:0",
  "occurrence_at": "2026-11-09T02:00:00+00:00",
  "fire_at": "2026-11-09T01:00:00+00:00",
  "offset_min": 60, "snooze_n": 0, "repeat_n": 0,
  "state": "planned",
  "target_device_id": "0193...",
  "push_fallback_at": "2026-11-09T01:03:00+00:00",
  "missed_at": "2026-11-09T01:30:00+00:00",
  "push_sent_at": null, "fired_at": null, "acked_at": null,
  "seq": 815, "updated_at": "..."
}
```

| Field | Notes |
|---|---|
| `key` | Stable: `reminder_id:occurrence(UTC, Z):offset_min:snooze_n`. Use it as the local alarm id, so a re-plan never makes a second alarm. |
| `state` | `planned` → `fired` (some phone reported `fired_local`/`shown`/`dismissed`) → `acked` («Сделано») / `snoozed` («Отложить») / `missed` (no `acked`/`snoozed` by `missed_at`). `cancelled`: the reminder was changed or deleted — **remove the local alarm**. `acked` and `missed` are final for the fire, except that a late `acked` (phone was offline) turns `missed` into `acked`. |
| `target_device_id` | The phone that rings as an alarm (R-13). **How to ring**: `alarm` when `reminder.level == "alarm"` and (`target_device_id` is null or equals your own device id); otherwise a plain notification. Null when the person chose «звонить на всех» or no phone is known. |
| `repeat_n` | Always 0 on the server: the phone makes repeats 1–3 itself; report them in event `meta.repeat_n`. |

## Last active phone

The last active phone is the non-revoked device with the newest `devices.last_active_at`.
It is updated by `POST /v1/devices` (upsert; also retargets fires to that phone), by
`DELETE /v1/devices/{id}` (fires move off the revoked phone), and by:

### `POST /v1/reminders/active`

Call on every app start and return to foreground (at most once a minute). Body: `{}`.
Needs the session to be bound to a device (`POST /v1/devices` first), else `409 device_unknown`.
Sets this device's `last_active_at = now` and, with policy `last_active`, moves every future
`planned` fire to this device (their `seq` changes, so the other phone sees it on next sync and
turns its local alarms into notifications).

```json
{"device_id": "0193...", "retargeted": 4}
```

## Sync

`GET /v1/sync` (see `items.md`) has two more arrays, in the same `seq` stream:

- `reminders`: Reminder objects changed since `since` (incl. `deleted_at`, `kind=test`).
- `reminder_fires`: Fire objects changed since `since` (state changes, retargets, new snooze
  fires, `cancelled`).

The phone keeps fires with `fire_at` in the next 14 days (the server expands repeating reminders
14 days ahead and tops up daily), plans the local alarms from them, and re-plans on every sync.
iOS: plan at most the nearest 48 (the 64-notification limit), refill on open / background.

### `GET /v1/reminders/fires?from=&to=`

Explicit window for local planning (e.g. after reinstall). `from` default now − 1 h, `to` default
now + 14 days, window ≤ 31 days. Returns `planned`, `fired` and `snoozed` fires of live reminders,
ordered by `fire_at`, with their reminders:

```json
{"device_id": "0193...", "fires": [Fire...], "reminders": [Reminder...]}
```

## Parse a phrase: `POST /v1/reminders/parse`

Nothing is saved. The phone shows the result on S13 («как понял»); the reminder exists only after
the person taps [Сохранить] and the phone calls `POST /v1/reminders` with the draft. A reminder
from a phrase is never created without that tap.

Body: `{"text": "Напомни завтра в 7 выпить таблетку", "created_via": "typed", "tz": "Asia/Almaty"}`
(`tz` optional, default the user's, unknown zone → `422 validation_error`; `text` ≤ 500 chars).
`level` in the draft is decided by code: `alarm` for «разбуди», «обязательно», «не дай забыть»,
«будильник», and for `created_via: "voice"` with a said time; otherwise `notification`.

```json
{
  "status": "ok",
  "source": "rules",
  "reason": null,
  "message": null,
  "draft": {
    "title": "Выпить таблетку", "due_at": "2026-11-09T02:00:00+00:00", "tz": "Asia/Almaty",
    "local": {"date": "2026-11-09", "time": "07:00"}, "rrule": null, "offsets": [],
    "level": "notification", "time_assumed": false,
    "when_text": "Завтра, понедельник, 9 ноября · 7:00 · Уведомление",
    "saved_text": "Напомню завтра в 7:00"
  },
  "options": [],
  "parser": "llm"
}
```

| `status` | Meaning / what the phone does |
|---|---|
| `ok` | One reading. Show S13 with `draft`. `time_assumed=true`: no time was said, 9:00 was put in — highlight the time. |
| `ambiguous` | «в 7» — `options` has 2 drafts (7:00, 19:00), likelier first; `message` = «В 7 утра или в 7 вечера?». The tap picks the draft. |
| `form` | Open the manual form S12 («Ввести вручную»), prefilled from `draft` when not null. `reason` + `message` say why. |

| `reason` (only with `form`) | `message` |
|---|---|
| `not_understood` | «Не совсем понял. Укажите время вручную.» |
| `no_ai` | «Укажите время вручную.» — no `ai_cross_border` consent («Без ИИ») and code could not read it |
| `ai_unavailable` | «Сейчас не получилось разобрать. Укажите время вручную.» (provider down / budget) |
| `check_failed` | «Проверьте время — я мог ошибиться.» — the model's date/time failed our check |
| `past` | «Это время уже прошло. Выберите другое.» |

`source`: `rules` (read by code, instant, free), `llm` (by the model), null.
`parser`: the server setting — `rules_first` or `llm` (see below). A `draft` with
`source: "llm"` → send `parse_source: "llm"`; if the person changed the time on S13 → `user_edit`.

### Rules first (founder decision Ф-1, **off by default**)

Setting `REMINDERS_RULES_FIRST` (server) → `parser`:

- `llm` (default, Ф-1 not taken): every phrase goes to the model (task `reminder_parse`), only with
  `ai_cross_border` consent. Without it («Без ИИ») → `form/no_ai`. **Offline the phone has no
  parser: show the manual form S12.**
- `rules_first` (Ф-1 taken): code reads simple phrases first («завтра в 10», «через 2 часа»,
  «каждый понедельник», «15-го», «за час», «накануне»…) — instant, works in «Без ИИ»; what code
  does not understand goes to the model (or `form/no_ai` without consent). The phone may run the
  same parser offline: shared test vectors in `docs/api/reminder-parse-vectors.json` (fixed `now`,
  `tz`; per phrase `expect: null` = code gives up, or `readings` with `title`, local `date`/`time`,
  `rrule`, `offsets`, `loud`, `time_assumed`; 2 readings = ambiguous hour, likelier first).
  Russian only: Kazakh phrases go to the model. Bare hours 1–11 («в 7», «завтра в 10») are always
  ambiguous (7:00 / 19:00); «7:30», «07:00», «в 7 утра», «в 19» are not. The phone reads `parser`
  from `GET /v1/reminders/settings` and uses its local parser only when it is `rules_first`.

## Create, change, delete

### From the assistant line (week 9)

The phone no longer needs to route reminder phrases to `/reminders/parse`: send every online
phrase to `POST /v1/chat/messages` (`chat.md`). «Напомни завтра в 7 выпить таблетку», «разбуди в
6:30», «не дай забыть оплатить свет в пятницу», «поставь будильник на 7» are read the same way as
`/reminders/parse` (same `parser` setting, same consent rule), and the reply stream carries:

- `reminder_draft`: `{"reply_id", "status", "source", "reason", "message", "draft", "options",
  "parser", "created_via"}` — exactly the `/reminders/parse` result plus `created_via` (`voice` for
  `input_kind: "voice"`, else `typed`). Show S13 («Понял так»), or S12 for `status: "form"`.
  Nothing is saved: [Сохранить] → `POST /v1/reminders` with that draft, `created_via`, and
  `message_id` = `reply_id` (so «Что я сделал» links the action to the line).
- then `banner` with the text («Понял так: завтра, понедельник, 9 ноября · 7:00 — выпить
  таблетку. Сохранить?», for `form` the `message`) and `done` with `answer_kind: "text"`.
- A question («напомни, как зовут мастера?», «когда мне к врачу?») is a question as before.
- After a resume from the database (`snapshot`) the draft is not repeated: show the banner text;
  the person says it again.

`/reminders/parse` stays for S13 «Изменить время» typed in the form and for older builds.

### `POST /v1/reminders` → `201 {reminder, fires, action}`

```json
{"client_id": "5f0c...", "title": "Выпить таблетку", "body": null,
 "due_at": "2026-11-09T02:00:00+00:00", "tz": "Asia/Almaty", "rrule": null, "offsets": [60],
 "level": "alarm", "created_via": "typed", "parse_source": "rules",
 "sensitivity": null, "item_id": null}
```

Instead of `due_at` the manual form may send `"local": {"date": "2026-11-09", "time": "07:00"}`
(read on `tz`'s clock). Repeat with the same `client_id` → `200` with the existing reminder
(offline outbox is safe). `title` 1–200 chars. Errors: `422 reminder_in_past` (a non-repeating
event moment not in the future), `422 validation_error` (bad `rrule`/`offsets`/`tz`).
Fires whose `fire_at` is already past are not created (e.g. «накануне» for an event in 3 hours).
Optional `message_id` (the chat reply the draft came from). `action` (week 9): `create_reminder`,
«Напомню завтра в 7:00: выпить таблетку», «Отменить» = the reminder is deleted and its fires
`cancelled` (remove the local alarms from sync). A repeat with the same `client_id` returns the
same `action`. `kind=test` reminders have no action (`action: null`).

### `PATCH /v1/reminders/{id}` → `200 {reminder, fires, action}`

Body: `version` (required) + any of `title`, `body`, `due_at` | `local`, `tz`, `rrule`, `offsets`,
`level`, `sensitivity`. A time change re-plans: future fires that no longer match become
`cancelled`, new ones are added; fires that still match keep their id/key. `409 conflict` when
`version` is stale. A change the agent proposes goes through a pending action (S25), not here.
`action` (week 9): `edit_reminder` (the person's edit, R-33, «Вы перенесли напоминание на 8:00»),
«Отменить» puts the old fields back and re-plans; if the reminder was changed again since, it
keeps the newer version (`partial`). Null when nothing changed.

### `DELETE /v1/reminders/{id}` → `200 {reminder, fires, action}` (was `204` until week 9)

`status=cancelled`, `deleted_at` set, all `planned`/`fired`/`snoozed` fires → `cancelled`.
`action` (week 9): `edit_reminder`, «Удалил напоминание «…»», «Отменить» brings it back with new
fires (a one-off whose time has passed cannot come back: `partial`). Repeat on a deleted one:
`action: null`. Treat any 2xx as success.

### `GET /v1/reminders?include_done=false` / `GET /v1/reminders/{id}`

List of live (not deleted) `normal` reminders, newest `due_at` first, without fires; one reminder
with its fires from 1 day ago on.

## Test alarm: `POST /v1/reminders/test` → `201 {reminder, fires}`

S15 «Проверить будильник». Body `{}`. Creates `kind=test`, `level=alarm`, title «Проверка
будильника», due in 1 minute, one fire targeted at **this** device (session device). Events and
the push backup work as for a normal one, so S15 can show «Сработал вовремя» from the phone's own
`fired_local`, or «Не сработал» when the server's backup push arrives.

## Events from the phone: `POST /v1/reminders/events`

Batch from the outbox (offline-safe; send in order of `at`). ≤ 200 per call.

```json
{"events": [
  {"client_id": "a1b2...", "fire_id": "0194...", "event": "fired_local",
   "at": "2026-11-09T01:00:02+00:00",
   "meta": {"scheduler": "alarm_clock", "fsi": true, "repeat_n": 0}}
]}
```

| `event` | When the phone sends it | Effect on the fire |
|---|---|---|
| `scheduled_local` | the local alarm was set (and on every re-plan) | none (journal) |
| `schedule_failed` | the OS refused (no exact alarms etc.) | none (journal, metrics) |
| `fired_local` | it started ringing / was delivered | `planned` → `fired`: **no backup push** |
| `shown` | the alarm screen / notification was shown | same as `fired_local` |
| `dismissed` | swiped away without a button | same as `fired_local` (still `missed` at +30 min without «Сделано»/«Отложить») |
| `acked` | «Сделано» | → `acked`; the other `planned` fires of the same occurrence → `acked` too (cancel them locally); a non-repeating reminder → `done`. No push ever after this. |
| `snoozed` | «Отложить на 10 минут» / «Другое время» | → `snoozed`; a new fire (`snooze_n + 1`, same occurrence/offset) at `meta.until` when sent, else at `at + 10 min`, is returned in `fires`; its backup push is at its own `fire_at + 3 min`. The phone rings it from the same key rule. Reminder `status=snoozed`, `snooze_until`. |

`meta`: free object ≤ 2 KB; known keys: `scheduler` (`alarmkit`, `alarm_clock`, `exact`,
`inexact`, `notification`), `fsi` (bool), `repeat_n` (0–3), `error`, `until` (on `snoozed` only:
ISO 8601 with offset, the moment the person chose in «Другое время» — 5/30/60 min, tomorrow).
`until` must be from `at + 1 min` to `at + 48 h` (`snooze_max_hours` in settings); otherwise the
event is `invalid` and nothing changes on the server (keep the local alarm, fix and resend with a
new `client_id`). It is counted from the event's `at`, so an offline phone's snooze stays right; if
that moment is already past when the event arrives, the backup push follows at once unless the
same batch also reports `fired_local` for the new fire (by `fire_key`).
`push_sent`, `push_failed`, `missed` are written by the server only (`invalid` if sent).
`at` more than 5 min in the future → `invalid`.

Response:

```json
{"results": [{"client_id": "a1b2...", "status": "applied"}],
 "fires": [Fire...]}
```

`status`: `applied`, `duplicate` (this `client_id` already came — safe retry), `not_found` (no
such fire for this user: drop it), `invalid`. `fires`: every fire the batch changed or created.
`actions` (week 9): one Action per `acked` that came for a fire in state `missed` (a late
«Сделано»), with «Отменить» (`actions.md`); an `applied` repeat never makes a second one.
Each of these actions also has `event_client_id`: the `client_id` of the `acked` event that made
it (match on this, not on order). Its `changes` row has `kind: "reminder"`, `item_id: null` and
`reminder_id` = the reminder.

```json
{"results": [{"client_id": "a1b2...", "status": "applied"}], "fires": [Fire...],
 "actions": [{"id": "0194...", "kind": "edit_reminder", "event_client_id": "a1b2...",
              "changes": [{"kind": "reminder", "item_id": null, "reminder_id": "0193...", "...": "..."}],
              "...": "the rest of Action"}]}
```

### «Перенести» a missed occurrence (S06 red row)

- Within 48 h: send `snoozed` for that missed fire with `meta.until` = the new moment. It moves
  **only this occurrence** (also of a repeating reminder: the series stays as it is): a new fire
  for the same occurrence rings at `until`, and the red row goes (the fire is `snoozed`).
- Later than 48 h, or a new time for **every** occurrence: a one-off is `POST /v1/reminders` (new
  `client_id`, same title, `created_via: "manual_form"`) and the whole series is `PATCH`. There is
  no «this occurrence only» beyond 48 h (no exceptions in `rrule`); for a repeating reminder the
  phone saves a one-off and the missed row leaves «Сегодня» after 24 h or with [Сделано].

## Settings: `GET /v1/reminders/settings`, `PATCH /v1/reminders/settings`

```json
{"parser": "llm", "quiet_from": "22:00", "quiet_to": "08:00",
 "alarm_device_policy": "last_active", "push_content": false,
 "snooze_minutes": 10, "snooze_max_hours": 48, "repeat_minutes": [5, 10, 15], "push_fallback_minutes": 3,
 "missed_minutes": 30, "offsets_allowed": [15, 60, 1440], "horizon_days": 14}
```

PATCH accepts `quiet_from`, `quiet_to` (`HH:MM`), `alarm_device_policy` (`last_active` | `all`).
Changing the policy retargets every future `planned` fire at once (`all` → `target_device_id`
null), visible in the next sync.
`push_content` mirrors the `push_content` consent (change it in «Согласия»).

**Quiet hours** (R-13): alarms and reminders ring and their pushes (backup, missed) are sent
inside quiet hours too; other pushes (answers, suggestions) wait. The phone does not silence
reminder alarms in quiet hours.

## Pushes the server sends (backup only)

Data payload, no body text unless `push_content` (and not `health`):

| When | Title | `data` |
|---|---|---|
| `fire_at + 3 min`, no `fired_local`/`shown`/`dismissed`/`acked`/`snoozed` from any phone | «Напоминание на 7:00 — откройте. Если будильник уже звенел — всё в порядке» | `{"type": "reminder_backup", "fire_id", "reminder_id"}` (+ `"text"` with `push_content`) |
| `fire_at + 30 min`, not `acked`/`snoozed` | «Вы пропустили напоминание на 7:00» / with `push_content`: «Вы пропустили: Выпить таблетку» | `{"type": "reminder_missed", "fire_id", "reminder_id"}` |

Each is sent at most once per fire (never retried into a second push; a failed send is only
journaled as `push_failed`). An early alert («за час», «накануне») that nobody answered becomes
`missed` without a «Вы пропустили» push — the event moment still has its own fire. Sent to every phone with a
push token, last active first. `missed` fires show as a red row in «Сегодня» (from sync).
Real APNs/FCM delivery is **not wired yet** (no credentials): the server logs instead.
