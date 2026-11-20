# Plans API: «Составь план» (step 8, 2026-11-19)

VISION §1: «тысяча советов из Instagram → план поездки», «несколько дел → план действий».
Mocks: `docs/design/system/screens-v5-extra.html`, group «Составь план» (selection «Стамбул», the
«План» card in the chat, the open trip plan, the action plan with «Сделать делами», «Дела» after
it).

**Rule «ИИ понимает — скрипт делает».** The chat model decides that the person wants a plan and of
which kind; a light model (`LLMTask.PLAN`, Haiku, the only chat-path task with a bigger output cap:
`max_tokens 7000`, ≈ $0.003 at the cap) structures the saved records; **code** checks the plan,
computes every date, saves it with «Отменить», and makes the tasks. Nothing is labelled «ИИ»
(Ф-63); the card says «составил по вашим записям — проверьте».

## How a plan is asked for (chat)

The person says it in the line or the chat, in their words: «составь план поездки в Стамбул на 4
дня по моим сохранённым», «план поездки в Стамбул, 10–14 декабря», «распиши выходные по дням»,
«разложи мои дела по ремонту кухни», «с чего начать переезд».

1. Code's guard looks only at the person's own phrase (`chat/plan_line.asks_plan`: «план»,
   «спланируй», «распиши», «по дням», «по шагам», «маршрут», «разложи мои дела по …», «с чего
   начать»). Only then the chat model is offered the tool `make_plan`; text inside records can
   never start one. A bare «план поездки в Стамбул» is a request, never saved as a note.
2. The chat model calls `make_plan {kind: trip | actions, topic, title, days, start_date,
   end_date, plan}`. Code keeps `start_date` / `end_date` / `days` only when the phrase says them
   («10–14 декабря» → 5 days, «на 4 дня», «завтра»).
3. Code searches the saved records for `topic` (hybrid search, up to 30) plus the records on
   screen; earlier plans are left out. The plan model gets them as data (`<untrusted_data>`).
4. Code checks the answer (`assistant/plans/build.py`):
   - a point keeps its record only when the record was shown and the point's numbers and dates
     are in that record or the phrase; otherwise it becomes the assistant's own tip (`own: true`);
   - an action step whose title has a number nobody said (an amount, a date) is **dropped** — it
     would go into «Дела»; its note is dropped alone when only the note fails;
   - trip day dates = start date + n; step deadlines = today + `due_in_days` (in the person's time
     zone); a reminder time only as the person or a record said it, else 10:00;
   - at most 14 days × 8 points, 12 steps.
5. The plan is saved as a record (below), placed by the page rules («Заметки»), one action
   `save_item` with «Отменить». The turn ends there (no extra model step); the answer text is the
   card's `lead`.

Events of that turn (see `chat.md`): `tool_activity {tool: "make_plan", text: "Составляю
план…"}` → `action` → `plan` → `done {answer_kind: "action"}`.

```json
event: plan
data: {"reply_id": "<answer id>", "action_id": "<action id>", "removed": 1,
       "plan": PlanCard}
```

`removed`: points that lost their record or steps dropped by the check (nothing to show; for
logs and QA).

### Changing a plan by phrase

With the plan open or selected (`selected_item_id` = the plan's id), «поменяй план: во второй день
Кадыкёй», «добавь в план Принцевы острова». The chat model calls `make_plan` with `plan: "<ref>"`:
the same record is changed (`user_edit` action; title, text and structure). The action's change
row has `diff` (old and new title / text, `items.md` «Inline edit»); the record has
`assistant_edit` for 24 h; «Отменить» brings the old plan back (tasks already made stay linked to
the steps with the same title). The card has `edited: true`, lead «Поменял план.».

## PlanCard (event `plan`, `Action.plan`, `ChatMessage.action.plan`)

```json
{"item_id": "0194…", "kind": "trip", "title": "Стамбул", "subtitle": "5 дней · 23 совета",
 "lead": "Собрал из 23 советов. 3 пункта — мои, не из ваших записей.",
 "rows": [{"n": 1, "date": "2026-12-10", "title": "Султанахмет, Гранд-базар", "points": 4,
           "due_date": null, "after_n": [], "note": null}],
 "start_date": "2026-12-10", "end_date": "2026-12-14",
 "counts": {"points": 23, "from_records": 20, "own": 3, "sources": 23},
 "page": {"page_id": "0194…", "title": "Заметки"},
 "check_note": "составил по вашим записям — проверьте",
 "can_make_tasks": false, "action_id": "0194…", "edited": false}
```

Action plan rows: `{"n": 1, "title": "Вызвать замерщика", "date": null, "points": null,
"due_date": "2026-11-20", "after_n": [], "note": "номер в заметках"}`; `after_n: [1]` = «после
шага 1». `lead` «План из 5 шагов. Сроки — от сегодняшнего дня.»; `can_make_tasks: true`.
Without any saved record: lead «В записях об этом ничего не нашёл — составил сам.»,
`check_note: null`.

The card is also on the action (`Action.plan`), so it comes back in `GET /v1/chat/messages`
(`message.action.plan`) and in «История». Buttons (mock): «Открыть» → `GET /v1/plans/{item_id}`;
«Отменить» (the action's notice) → `POST /v1/actions/{action_id}/undo` (the plan goes to the
trash). «Сделать делами» → below. The mock's «Сохранить» is not needed: the plan is already
saved in «Заметки» (decision for the designer / founder: keep «Открыть» + «Отменить», or a
«Готово» that only closes).

## The plan record

`items.kind = "plan"` (migration 0033), `source: "system"`, `status: "ready"`,
`ai_generated: true`, `title` = plan title, `text` = the plan as readable text (search, export,
the person can still edit it as a note), `source_meta.plan` = the structure below,
`source_meta.asked` = the phrase. It syncs like any record (`/v1/sync`), is found by search
(«найди план по Стамбулу»), goes to the trash and back like a note. Tasks made from it have
`tasks.source_item_id` = the plan record (`TaskOut` does not show it yet: group «Дела» by the
plan through `GET /v1/plans/{id}` steps' `task.id`).

## `GET /v1/plans?limit=30` → `{"plans": [Plan]}`

The person's live plans, newest first.

## `GET /v1/plans/{id}` → Plan

`404 not_found`: not this person's plan record.

```json
{"id": "0194…", "kind": "trip", "title": "Стамбул",
 "start_date": "2026-12-10", "end_date": "2026-12-14",
 "days": [{"n": 1, "date": "2026-12-10", "title": "Султанахмет",
           "points": [{"id": "d1p1", "title": "Голубая мечеть", "note": "до 10 утра",
                       "source_id": "0193…", "own": false, "place": "Голубая мечеть, Стамбул"},
                      {"id": "d1p3", "title": "Обед у Сулеймание", "note": null,
                       "source_id": null, "own": true, "place": null}]}],
 "steps": [],
 "sources": [{"item_id": "0193…", "title": "Балат — цветные дома", "kind": "link",
              "created_at": "…", "available": true, "occurred_at": "…"}],
 "counts": {"points": 23, "from_records": 20, "own": 3, "sources": 23},
 "asked": "составь план поездки в Стамбул по моим сохранённым, 10–14 декабря",
 "text": "Стамбул · 5 дней\n\n10 декабря, чт · Султанахмет\n1. Голубая мечеть — до 10 утра\n…",
 "pages": [{"page_id": "0194…", "title": "Заметки"}],
 "can_make_tasks": false, "check_note": "составил по вашим записям — проверьте",
 "ai_generated": true, "seq": 812, "created_at": "…", "updated_at": "…", "deleted_at": null}
```

- A point: `source_id` = the record it came from (tap → open that record; the source line «видео ·
  3 окт.» from `sources[]` by `item_id`: `kind`, `occurred_at`/`created_at`); `own: true` = the
  assistant's tip («мой совет, не из ваших записей», terracotta label). `place` = a name to look
  up on a map («на карте»: open the maps app with a search for this text; there are no
  coordinates, by rule). `available: false` = that record was trashed or merged since.
- `date: null` when the person gave no dates (show «День 1»).
- An action plan has `days: []` and `steps`:

```json
{"id": "st1", "n": 1, "title": "Вызвать замерщика", "note": "номер в заметках",
 "due_date": "2026-11-20", "after": [], "remind_at": "2026-11-20T10:30",
 "source_id": "0193…", "own": false, "task_id": "0194…", "reminder_id": "0194…",
 "task": {"id": "0194…", "done": false, "due_date": "2026-11-20"}}
```

  `after`: ids of earlier steps («после шага 1»); `remind_at`: local time of the person (their
  `tz`) for the reminder «Сделать делами» will set; `task`: the live task made from the step
  (null: not made yet, or undone / deleted). `can_make_tasks`: some step has no live task.
- Budget («142 000 из 380 000 ₸ потрачено» in the mock) is not in v1: not shown.

## «Сделать делами»: `POST /v1/plans/{id}/tasks`

No «Да» (an internal change with «Отменить», Ф-65). Body (optional):

```json
{"client_id": "0194…", "step_ids": ["st1", "st3"]}
```

`step_ids` null / absent = every step that has no live task. Each step becomes a task on «Дела»
(`list_key: todo`, `due_date` = the step's deadline, `source_item_id` = the plan) and, when it has
`remind_at` in the future, a reminder linked to the task's record (`created_via:
"agent_suggestion"`, a notification at that time). **One action per step** (`save_item`; its
changes: the task row and the reminder row), all in **one group**.

`200`:

```json
{"plan": Plan,
 "group": {"id": "<group id>", "size": 5, "index": 0, "action_ids": ["…"],
           "notice": {"text_ru": "Сделал 5 дел и 2 напоминания", "text_kk": null,
                      "target": null, "undo_label_ru": "Отменить всё", "undo_label_kk": null,
                      "ms": 3000}},
 "actions": [Action], "tasks": [Task], "reminders": [Reminder],
 "page_patches": [PagePatch], "skipped": 0, "repeated": false,
 "message_ru": "Сделал 5 дел и 2 напоминания."}
```

- Show **one** notice: `group.notice` (mock «Сделал 5 дел и 2 напоминания · Отменить»). Its button
  = `POST /v1/actions/groups/{group.id}/undo` (`actions.md` «Groups»): every task goes to the
  trash and every reminder is cancelled, newest first, in one transaction; the plan's steps show
  `task: null` again. Each action stays in «История» with its own «Отменить».
- The new task rows carry the «изменил помощник» mark (outline them 1.5 s, as in the mock).
  Schedule the reminders on the phone as usual (`reminders.md`, fires come from
  `GET /v1/reminders/fires`).
- The same `client_id` again: the first result, `repeated: true`, nothing new.
- Steps that already have a live task are skipped (`skipped`); a step with the same title as an
  open task is that task.
- Errors: `404 not_found`; `409 not_a_plan`; `409 plan_has_no_steps` (a trip plan);
  `409 plan_already_tasks` (every step is a task already).

By phrase: «сделай делами», «сделай это делами», «преврати план в дела» in the chat does the same
for the selected plan or the newest action plan of the last 7 days (code only, no model). The
group is the answer then (`done.group`, `group.id` = the answer's id, same notice text).

## A plan on the calendar (2026-11-20)

Founder: «сделал с помощником план поездки в Стамбул по дням → попросил добавить в календарь — не
может». By phrase in the line, **code only** (no model step, like «сделай делами»); every write is
`assistant.plans.calendar` (`add` / `remove` / `shift`, session-level functions: the same calls
serve a screen button or the future operation registry, `docs/spec/proposals/chat-full-control.md`
`plans.to_calendar`, `calendar.remove_plan`, `calendar.shift_plan`).

| Phrase (examples) | What code does |
|---|---|
| «добавь план в календарь», «поставь поездку в календарь», «перенеси план по дням в календарь», «внеси Стамбул в календарь с 10 декабря», «можешь добавить план в календарь?» | `add` |
| «убери план из календаря», «удали поездку из календаря» | `remove` |
| «перенеси поездку на неделю позже», «сдвинь план на 2 дня раньше», «перенеси поездку на следующую неделю», «перенеси поездку на 17 декабря» | `shift` |

**Which plan.** The selected plan (open plan screen); else a live plan whose title the phrase
names («Стамбул» in «внеси Стамбул в календарь»), newest first; else, when the phrase says «план»,
«поездку», «путешествие», «отпуск», «маршрут» or «его / это», the newest live plan. A calendar
phrase that names no plan («добавь встречу в календарь завтра в 15») is not taken here: it goes on
to the timed to-do path (`calendar.md`). «В календаре» (a question about it) is never a change.

**`add`, trip plan.** Every day becomes an **all-day to-do** of its date, titled «{plan}: {day
title}» («Стамбул: Балат и Фенер»); a point that says its own time in its title or note («Ужин в
19:00», note «утром») is also a **timed to-do** with that time (`timewords`, Ф-91: утром 9:00,
в обед 13:00, днём 14:00, после работы 18:30, вечером 19:00), `duration_min` from
`timewords.default_duration` (60 by default), in the person's `tz`. Never guessed: «до 10 утра»,
«до 23:00», «после 15» are limits (no time); a bare «в 7» (7:00 or 19:00?) stays untimed.
- Dates: the date the phrase says (`с 10 декабря`, `10.12`, `с понедельника`, `со следующей
  недели`, `завтра`), else the plan's `start_date`. Neither → **one question**, nothing written:
  `needs_choice` «В плане «Стамбул» нет дат. С какого дня поставить его в календарь (5 дней)?»,
  options `kind: "date"` («С завтра, 21 ноября», «С субботы, 22 ноября», «С понедельника, 23
  ноября») + `cancel`; `plan.tool: "plan_calendar"`. The tap (`choice.option` `d1`…) — or a typed
  answer with a date («с 10 декабря») while the question is open — puts the plan on the calendar.
  Dates that have all passed → the same question, head «Даты плана «Стамбул» уже прошли (10–14
  ноября).».
- **One action** (`save_item`), one «Отменить»: every to-do of the plan + the plan's new dates
  (`set_item_content`: `start_date`, `end_date`, `days[].date`, `days[].task_ids`, `tz`, and the
  text with the dates). `payload.plan_calendar: "add"`, `payload.plan_id`. Notice «Добавил в
  календарь: 6 дел». Answer (Ф-88, only what was made): «Добавил в календарь «Стамбул»: 5 дней,
  10–14 декабря. Со временем — 1 дело.»
- Each to-do: `list_key: todo`, `source_item_id` = the plan (the calendar entry's `plan` is
  `{id, title}`, tap → the plan), `created_by: "assistant"` (`source: "assistant"`), no reminder.
- Already there (every day has a live to-do): nothing new, «План «Стамбул» уже в календаре: 10–14
  декабря.». A different start said then: «… Чтобы перенести, скажите: «перенеси поездку на 17
  декабря».» (no doubles). Days added to the plan later (or whose to-do was deleted): only those
  are added («ещё 1 день … Остальные дни уже были в календаре.»).

**`add`, action plan.** The same as «Сделать делами» (a group under the answer, one «Отменить
всё»); the answer says honestly what landed where: «Сделал 4 дела из плана «Ремонт кухни»: 3 с
датой — в календаре, 21–26 ноября; 1 без даты — только в «Делах». Напомню о 2 шагах.»

**`remove`.** Exactly the plan's live to-dos (`tasks.source_item_id` = the plan; for an action
plan these are its step to-dos) go to the trash with their linked reminders cancelled, **one
action** `delete_item` («Восстановить» brings them all back). Other to-dos are never touched; the
plan record stays. «Убрал из календаря «Стамбул»: 6 дел, 10–14 декабря. Сам план остался в
«Заметках».» Nothing on the calendar: «Плана «Стамбул» в календаре нет.»

**`shift`.** The plan's live to-dos move by N days (a timed one keeps its clock time; linked
single reminders move along), the plan's dates (and an action plan's step `due_date` /
`remind_at`) with them, **one action** `facet_edit`; undo puts every date back (a to-do the person
moved since keeps theirs: `partial`). «на неделю позже» +7, «на 2 дня раньше» −2, «на следующую
неделю» +7, «на 17 декабря» = the first day becomes that date; «на неделю» without a direction is
later. Into the past → «Так «Стамбул» окажется в прошлом (…) — ничего не менял.»

**Plan** (`GET /v1/plans/{id}`) adds `calendar: {"tasks": 6, "from": "2026-12-10", "to":
"2026-12-14"} | null` (the plan's live to-dos) and `days[].task_ids`.

Events: `tool_activity {tool: "plan_calendar", text: "Ставлю в календарь…"}` → `action` (one, or
the group's) → `done`; or `needs_choice` for the date; or a text answer.

## Tap groups (for `actions.md`)

A group made by one tap has no chat answer: its id is kept in each action's `payload.group_id`.
`Action.group` is set for such actions **whatever the size** (also 1), and
`POST /v1/actions/groups/{id}/undo` accepts it like a phrase's answer id.

## What the phone builds

1. Chat: on `plan` (or `message.action.plan` in history) show the «План» card instead of text:
   colour of the page it lies on (`page`), `title`, `subtitle`, the first 3 `rows`, `lead` above,
   `check_note` small, buttons «Открыть» (and «Сделать делами» when `can_make_tasks`). The
   notice «Отменить» is the usual action notice.
2. Plan screen (`GET /v1/plans/{id}`): trip — days with date, numbered points, source link
   («видео · 3 окт. ›»), «на карте» from `place`, own tips with the terracotta label; action plan —
   steps with deadline and «после шага N», the task state, «Сделать делами». The bottom line
   «Попросите поменять план…» sends a chat phrase with `selected_item_id` = the plan.
3. «Сделать делами»: `POST /v1/plans/{id}/tasks` with a new `client_id`, then one notice from
   `group.notice`, `page_patches` applied, new tasks outlined; «Отменить» →
   `POST /v1/actions/groups/{group.id}/undo`.
4. «Заметки»: a record with `kind: "plan"` opens the plan screen (not the note editor).
5. «Дела»: tasks with the same plan can be grouped under the plan title (match task ids from
   `steps[].task.id`).
