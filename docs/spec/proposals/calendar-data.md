# Calendar data — what the calendar (Ф-89) needs from the server

Status: proposal for the architect (2026-11-20). **Implemented the same day** after the founder
approved direction A — migration 0035, contract `docs/api/calendar.md` (which is the source of
truth now; the differences: occurrences of repeats live in `task_occurrences`, `created_by` marks
the assistant's to-dos, the range is ≤ 61 days, free windows are computed on the phone).

## What there is today

- **«Дела»** (`tasks`): `due_date DATE` only — a day, no time, no duration (`docs/api/today.md`:
  «a time makes it a reminder»).
- **Reminders** (`reminders` + `reminder_fires`): a moment (`due_at`, `tz`, `rrule`, `offsets`),
  no duration and no end. «Дела» rows with a time are rows whose record has a live reminder
  (`pages.timed_items`).
- So a block on an hour grid («Встреча 15:00–16:30») cannot be stored: there is no start for a
  to-do and no length for anything. The assistant's «свободно до …» (Ф-89 part 3, `chat/now.py`)
  therefore runs only until the next reminder's moment.
- Phone: the local SQLite (`mobile/src/db/outbox.ts`) keeps records, pages and page links and the
  outbox; tasks and reminders come from the API (and reminders' fires for alarms), not from a
  local table.

## Proposal

### 1. Fields on `tasks` (migration 0035, frozen SQL)

| Column | Type | Meaning |
|---|---|---|
| `start_at` | `timestamptz NULL` | The block's start (UTC). Null = an all-day / undated to-do, as today. |
| `duration_min` | `int NULL`, `CHECK (duration_min BETWEEN 5 AND 1440)` | Length. Null with `start_at` = a point (shown as a default 30-min block, drawn thinner). |
| `tz` | `text NULL` | IANA zone the time was set in (Almaty default), like reminders; local day = `start_at AT TIME ZONE tz`. |
| `all_day` | — (derived) | `start_at IS NULL AND due_date IS NOT NULL`. No column. |

- Invariant: when `start_at` is set, `due_date` = its local date (code keeps both; old clients that
  read only `due_date` keep working).
- Index `ix_tasks_user_start (user_id, start_at) WHERE deleted_at IS NULL AND start_at IS NOT
  NULL` for day / 3-day / week / month windows.
- No overlap constraint: two blocks may overlap (shown side by side).
- A reminder for a timed to-do stays a separate row (`reminders.item_id` = the task's record),
  default `offsets` from the person's habit; moving the block moves the reminder (one action, one
  «Отменить»).

### 2. API

- `GET /v1/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` (max 42 days): `{days: [{date, all_day: [Task],
  blocks: [{kind: "task" | "reminder", id, title, start_at, end_at, duration_min, tz, done,
  page_id}]}], free: [{start_at, end_at}]}` — the free windows computed by code (working hours
  from a setting, default 08:00–22:00). Reminders without a task are blocks of `duration_min`
  null.
- `POST /v1/tasks` / `PATCH /v1/tasks/{id}`: accept `start_at`, `duration_min`, `tz` (with
  `version` as today). A move on the grid = `PATCH` with the new `start_at` → `action`
  `edit_task` with `inverse` («Отменить»). Delete as today.
- `POST /v1/tasks` from an empty slot: `{title, start_at, duration_min}`.
- The assistant line: `create_task` / `move_task` tools get `start_at` / `duration_min`, filled by
  code from the phrase (`assistant.timewords`: «завтра с 15 до 16:30», «на час», «в обед на 40
  минут»); a past start is asked like reminders (`reason: "past"`).
- `chat/now.py`: «свободно до …» then uses the end of the current block and the start of the next
  one (today it only knows moments).

### 3. Sync with the phone

- `GET /v1/sync` already carries `tasks` by `seq`; the new columns come with the row (old phones
  ignore unknown fields).
- If the calendar must work offline: a local `tasks` table on the phone (id, title, list_key,
  due_date, start_at, duration_min, tz, done_at, version, seq, deleted_at), filled from sync, and
  grid moves through the outbox as `PATCH /v1/tasks/{id}` with `version` (409 → reload the row,
  show «Изменено на другом устройстве»). Reminders' fires stay as they are (alarms).

### 4. Open questions for the architect / founder

1. Do reminders get a duration too, or does a timed thing on the grid always become a task with a
   reminder? (Proposal: the latter; a reminder alone is a point.)
2. Working hours for «свободно» — a setting per person, or the defaults in
   `timewords.TIME_DEFAULTS` («после работы» 18:30)?
3. Repeating blocks («каждый вторник с 10 до 11»): an `rrule` on tasks, or only on reminders for
   now? (Proposal: later; v1 = single blocks.)
