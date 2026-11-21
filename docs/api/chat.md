# Chat API: the assistant line, answers, changes, «Переписка», feedback (weeks 5-6)

Spec: `docs/spec/final/3-engineering.md` 3.7 (feedback), 3.13, 4.12, 5.6, 5.7, 5.10, 6.9, 6.11,
6.12; `03-persistent-chat-decisions.md` 3.5; R-14, R-31, R-36, R-41, R-52...R-56; US-22, US-24,
US-25, US-26, US-28, US-30. Actions and undo: `actions.md`.
Base path `/v1`. Every endpoint needs `Authorization: Bearer`. Errors before a stream starts have
the usual shape `{code, message_ru, message_kk, retry_after?, details?}`.

One conversation per person, across all pages. The line on any page posts here; the answer is
about **all** pages (sources may come from another page than the one the person is on).

Week 5: questions and text answers with sources. Week 6: changes on the page («разложи по
темам», «перенеси это в Расходы», «удали это», «запиши…», «сделай страницу Ремонт») with one
«Отменить», questions back («Какую?»), «Да» with a number, «Оставить мои». `pending_action`
(sending outside) and `general_answer_offer` are later weeks: ignore unknown events. `action` may
carry `tasks: [Task]` (week 9, `today.md`).

**Where things go (Ф-47, week 19).** The person never picks the page they talk about: there is
no «Про: …» chip. A new record goes where the server's page rules put it (`auto_rule` and kind:
«Заметки», «Дела», «Покупки», «Расходы», «Документы», incl. pages made on first use,
`features.md`), never onto the open page by itself; questions search all records. `page_id`,
`visible_item_ids` and `selected_item_id` are only context: they resolve «это / здесь / эту
запись» (and page actions such as «разложи по темам» on the open page) and an explicit «сюда / на
эту страницу», which is the person's own choice and is honoured. A page named in the phrase
(«запиши в Ремонт») is used too. Records the phone saves offline (`POST /v1/items`, no page) are
placed by the same rules when they arrive.

**Plain notes.** A phrase that only states something to keep («купить хлеб», a phone number,
«Мастер Ерлан, плитка») is saved as a record in the person's words where the page rules put it
(the open page only with «сюда»), with «Отменить»: `action` with `kind: "save_item"`,
`summary.ru` «Записал.» (when it is on the open page) or «Записал в «Заметки».» (where it went),
`done.answer_kind: "action"`. «запиши …» / «сохрани …» / «добавь …»
(without a page name) save the rest of the phrase the same way. The text is never rewritten by a
model. A question («где ключи?»), one word («плитка») or an order goes the usual way. When the
answering service is down, a phrase of 3+ words or with a long number is still saved; a shorter
one gets `deferred`. Since 2026-11-16 (Ф-69) such a note is marked to be read later: see
«Steps 3–4» below.

**Tasks, shopping and reminders (week 9).** On any page: «купить хлеб, молоко и лекарства маме»,
«добавь в покупки молоко», «позвонить маме завтра» become tasks on «Покупки» / «Дела и
напоминания» (one `action`, `kind: "save_item"`, «Добавил в Покупки: хлеб, молоко, лекарства
маме.», the `action` event also has `"tasks": [Task]`; details and who reads the phrase:
`today.md`). Not a list → a plain note as above. When the reader model is down, in «Без ИИ» or
without consent, code reads spends and lists (`expenses.parse.rules_parse`,
`tasks.parse.rules_parse`), so «Я потратил 2000 на мороженое» is an expense and «купить хлеб на
завтра, и напомни в 10 утра» a to-do for tomorrow, never a note (phone QA 1). «Напомни …», «разбуди …», «не дай забыть …»,
«поставь будильник …» give a `reminder_draft` event for S13 (nothing saved until [Сохранить]:
`reminders.md`). The phone should send these phrases here, not to `/reminders/parse`.

**When the line changes something.** Only when the person's own phrase asks for a change (code
checks the phrase first; a short model check only when the words are unclear). Text inside
records, files and shared text (`input_kind: "share"`) never makes a change, whatever it says.
Week 17: shared text goes to the model inside the data block, like a record, never as the
person's question; in later turns (history, conversation summary) it is replaced by
«[поделился текстом; он не повторяется]».
New records follow «Where things go» above; changes to existing records act on the records named
(«это» = the selected one) wherever they are; the answer says where («Добавил в «Покупки»»). Records placed by hand (`manual_order`) are never
moved without the person's «Да» (`confirm_manual`).

**The view of a page (week 11, `views.md`).** «покажи таблицей», «включи доску», «сделай простым
списком», «сгруппируй по магазинам», «добавь поле телефон мастера», «спрячь источник», «сделай
жёлтой», «приколи код домофона», «назови страницу Дача», «верни страницу как было»: tool
`set_view`, the same planner as «Настроить страницу». Done at once with «Отменить» (`action`
`screen_view_change` + `page_patch` with `page_view`), or asked first: `confirm` for «Вернуть как
было», removing an own field and >150 records; `confirm_manual` for what the person set by hand.
A ★ field is never hidden. Only when the person's own words are about the view.
Week 11а: «раскрась по темам» on «Заметки» colours the stickers by topic (`views.md` →
«Раскрась по темам»; `status` `arranging` «Раскрашиваю… 12 заметок» while topics are found) and
«сначала аптека, потом Магнум» sets the group order (`view_state.group_order`).

## Consent and «Без ИИ»

- `POST /chat/messages` and the resume stream need `pd_processing` + `terms` + `ai_cross_border`
  (`403 consent_required`, `details.missing`). Nothing leaves the country without it. Also `403
  consent_required` with `details.missing = ["ai_cross_border"]` when the consent exists but names
  none of the providers that answer chat. In «Без ИИ» the line is search (`GET /v1/search`) plus
  quick capture; it does not call this endpoint.
- Reading history, delivery marks, `DELETE /chat/history` and `POST /feedback` need only the base
  consents (`pd_processing` + `terms`).

## Send a message: `POST /v1/chat/messages` (SSE)

Request (`application/json`):

```json
{
  "client_id": "0193f0aa-...",
  "text": "Сколько стоила плитка?",
  "page_id": "0193...",
  "visible_item_ids": ["0193...", "0193..."],
  "view_version": 3,
  "selected_item_id": null,
  "lang": "ru",
  "input_kind": "typed"
}
```

| Field | Type | Notes |
|---|---|---|
| `client_id` | uuid, required | Idempotency key. Sending the same `client_id` again does not ask twice: you get the stream of the first reply (as a resume from the start, see below). |
| `text` | string, 1...2000 chars after trim | Required. Voice goes through STT on the phone's record path for now; `upload_id` is not accepted yet (week 6). |
| `page_id` | uuid or null | The page the line is on: context for «это / здесь / сюда» only (Ф-47), never where a new record goes by itself. Unknown or removed page: treated as null (no error: the question still gets answered). |
| `visible_item_ids` | uuid[], ≤40, default `[]` | Records on screen now, top first. Ids that are not this person's, or not visible, are dropped. |
| `view_version` | int or null | The page's `view_version` the phone is showing. |
| `selected_item_id` | uuid or null | «это / здесь»: the open or selected record. Without it, «удали это» on a page with more than one record gets `needs_choice`, never a change. |
| `choice` | object or null | The person tapped an option of an earlier `needs_choice` / `confirm` / `confirm_manual`: `{"reply_id": uuid, "option": "<option id>"}`. Send the option's label as `text` (it is shown in «Переписка»). See Proposal below. |
| `lang` | `ru` or `kk`, optional | Language of the phrase. Default: the account locale. The answer is in this language. |
| `input_kind` | `typed` (default), `voice`, `share` | How the phrase was entered (for «Переписка»). |

Errors before the stream: `401`, `403 consent_required`, `422 validation_error`,
`429 chat_rate_limited` / `429 chat_daily_limit` (below).

### Message limit (week 18, founder 2026-11-12)

Per person, by `users.profile` (settings `CHAT_RATE_PER_MINUTE`, `CHAT_RATE_PER_DAY`, JSON maps;
the numbers are a proposal):

| Profile | Per minute | Per day |
|---|---|---|
| `regular`, `work` (and any other) | 10 | 300 |
| `family_beta` | 30 | 2000 |

- Counted: phrases the person sent (`POST /v1/chat/messages` without `choice`) in the last 60 s
  and since local midnight in `BUDGET_TZ` (Asia/Almaty). Not counted, never refused: taps on a
  proposal (`choice`), a resend of the same `client_id` (it gets the first reply), and everything
  the server does by itself (resumes, deferred answers, jobs, imports).
- Over a limit: `429`, header `Retry-After` and body `retry_after` (seconds), nothing is saved.
  `chat_rate_limited`: «Слишком много сообщений подряд. Подождите немного и напишите снова.»
  (≤60 s); `chat_daily_limit`: «На сегодня сообщений достаточно — продолжим завтра.» (until
  midnight). `message_kk` comes too. The phone keeps the phrase in the line (or the outbox) and
  shows the message; it does not retry by itself before `retry_after`.

### Page views (Ф-39, beta)

While `assistant_views` is off (`features.md`) the model step has no `set_view` tool and code does
not run «раскрась по темам»: a phrase about a page's look (layout, fields, sort, groups, colours,
board) gets «Так пока не умею — вид страницы меняется в «⋯».» and changes nothing. Renaming a page
or changing its icon («переименуй страницу в Дача») still works: the step gets `rename_page`
(name, icon only), which writes the same `screen_view_change` action with «Отменить».

Response: `200`, `Content-Type: text/event-stream`. Each event:

```
id: 4
event: token
data: {"text":"Плитка стоила 48 000 ₸. "}

```

- `id` grows by 1 inside one reply, from 1. Keep the last one for resume.
- `data` is always one line of JSON.
- Lines starting with `:` are keep-alives (about every 15 s). Ignore them.
- Unknown event names: ignore them.

### Events, in order

| Event | When | `data` |
|---|---|---|
| `accepted` | always first | `{"message_id", "reply_id", "created_at"}` — `message_id` is the person's message, `reply_id` the answer being written. Store `reply_id`: resume and «Открыть ответ» use it. |
| `status` | 0...n | `{"stage": "thinking" \| "searching" \| "writing" \| "arranging", "text": "Смотрю записи…"}` — show `text` in the line (`arranging`: «Раскладываю… 40 записей»). |
| `tool_activity` | 0...n | `{"tool": "search" \| "list_page" \| "create" \| "update" \| "move" \| "reorder" \| "create_page_from_template" \| "set_view" \| "make_plan" \| "plan_tasks", "text": "Раскладываю…", "page_id": uuid \| null}` (step 8: «Составляю план…», «Делаю делами…») |
| `sources` | 0...n, before the first `token` of the text that uses them | `{"sources": [Source]}` — **new** sources only; append by `ref`. Show as «Нашёл…» cards while the answer is written. |
| `token` | 0...n | `{"text": "..."}` — append to the answer. Pieces are whole sentences: each sentence is checked (numbers and dates) before it is sent, so nothing shown is taken back. |
| `web_sources` | 0...1, before `citations`, only with `web_search_enabled` (Ф-86, off by default) | `{"sources": [{"url", "title"}]}` — pages a web search returned for this answer. The answer text already ends with a line «Источники: zakon.kz, …», so a phone that ignores the event still shows them; a phone that knows it may show tappable links instead. |
| `citations` | once | `{"citations": [Citation]}` — the chips under the answer. Only records the answer is based on. May be empty. |
| `checked` | once | `{"ok": bool, "removed": int}` — `removed` sentences had a number or a date not found in the sources and were not sent (R-36). Ф-86 (chat.v4): only sentences about the person's own data are checked; an answer from general knowledge (advice, a plan, small talk) is not cut, except its sentences that speak about the person's records («у вас в записях…», «вы потратили…»), and a phrase that asks about the person's data («сколько я потратил», «где мой…») keeps every sentence checked. Numbers our **code** computed this turn (a count of a page, and from week 12 the totals and remainders of `aggregate`) are allowed too (founder 2026-11-09); a number the model works out itself is still removed. `ok=false` means the text ends with the note «Часть чисел не нашёл в записях — не стал их писать.» Nothing to do beyond showing the text. Ф-89 (2026-11-20): the context has a code line about «сейчас» (the person's local time, how many timed things of today are past, the next reminder and the minutes until it, the free window until it, «Дела» due today) and a data block «Расписание на сегодня» with the titles; those times and minutes are code's facts the answer may state («что у меня сейчас?», «когда я свободен?», «успею до встречи?» are personal questions: every sentence checked). A sentence that proposes a clock time of today already past («давайте в 10:00» at 14:20, no other day named) is removed too. |
| `action` | 0...n, a change was made (already saved) | `{"reply_id", "action": Action, "changed_item_ids": [uuid], "page_id": uuid \| null}` — Action as in `actions.md`. Several in one reply = the same action growing: replace by `action.id`. Show `action.summary.ru` in the line with [Что изменилось] (`action.changes`) and [Отменить] (`POST /v1/actions/{id}/undo`). Highlight `changed_item_ids` 600 ms. |
| `plan` | 0...1, step 8: a plan was made or changed (already saved), after its `action` | `{"reply_id", "action_id", "removed", "plan": PlanCard}` (`plans.md`): show the «План» card instead of text. `done` follows with `answer_kind: "action"`; the answer text is the card's `lead`. |
| `reminder_draft` | 0...1, a reminder phrase (week 9) | The `/v1/reminders/parse` result + `reply_id`, `created_via` (`reminders.md`): open S13 (or S12 for `status: "form"`). Followed by `banner` + `done` (`answer_kind: "text"`). Nothing was saved. |
| `page_patch` | after each `action` that touched page rows | PagePatch (below): apply at once (move the cards); hold it while the person is dragging a card. |
| `needs_choice` | instead of a change, when «это» is unclear | Proposal (below), `kind: "choice"`: «Какую?» with 2-3 options. Nothing was changed. |
| `confirm` | instead of a big change (a delete: no more since Ф-66, 2026-11-16 — it is done at once) | Proposal, `kind: "count"`: «Переставить 212 записей?» / «Удалить 8 записей?» / «Удалить «Купить хлеб»?» (`count: 1`) [Да] [Не сейчас]. Nothing was changed yet. A record picked in the answer to «Какую?» of a delete counts as the «Да». Deletes from the UI (`DELETE /v1/items/{id}`) are unchanged. An explicit move («перенеси это в Покупки») needs no «Да», also for a row placed by hand. |
| `confirm_manual` | instead of a reorder that would move records placed by hand | Proposal, `kind: "manual"`: «Вы сами расставили 4 записи. Переставить и их?» [Да] [Оставить мои]; focus «Оставить мои» (`default`). Nothing was changed yet. |
| `banner` | once, for a text answer | `{"reply_id", "text", "preview", "short", "ai_label", "citations": [Citation]}` — the full checked answer (same as the tokens joined), a ≤140-char `preview` cut at a word, `short=true` when `text` fits in the preview. The phone decides «≤2 строк» by its font; `short` is only a hint. `ai_label` is set when the text was written by the assistant: show it (R-06). |
| `done` | last, success | `{"reply_id", "state": "done", "answer_kind": "text" \| "action" \| "choice", "action_id": uuid \| null, "delivery", "limited": bool}` — sent **after** the answer is saved. `action`: a change was made (no `banner`: the line shows `action.summary`). `choice`: a Proposal waits for a tap (no `banner`). `limited=true`: the person's monthly limit is reached; the answer is search results without a written answer (the banner says «На сегодня достаточно — продолжу завтра…»). |
| `deferred` | last, instead of `done` | `{"reply_id", "state": "deferred", "reason": "unavailable", "text": "Сейчас не получается ответить. Попробуйте чуть позже."}` — the answering service is down. The message stays in «Переписка». The server finishes it later by itself (then it waits in `GET /chat/pending-banner`, with a push «Ответ готов»). Since week 10 (founder 2026-11-09) this also holds for a **change** the person asked for: it is made later with its action and «Отменить» (`answer_kind: "action"`, the action is in «Что я сделал»); anything that needs «Да» or «Какую?» is saved as a `choice` answer and waits for the tap — nothing is deleted or moved by hand-placed rows without it. A change already committed when the server stopped is delivered, never made twice. Still `not_done`: a reminder phrase (its form needs the person). |
| `error` | last, instead of `done` | `{"reply_id" \| null, "code", "message_ru", "message_kk", "retry": bool}` — `retry=true`: show «Попробуйте ещё раз» and send a **new** `client_id`. Codes: `stream_interrupted`, `consent_required` (`retry=false`), `stale` (resume found it stuck), `not_done` (a reminder phrase the server does not set up later), `internal`. |
| `snapshot` | only on resume, see below | `{"message": ChatMessage}` — the saved state of the reply; replace what you showed. Followed by `done`, `deferred` or `error`. |

Source:

```json
{
  "ref": "s2",
  "item_id": "0193...",
  "title": "Плитка для ванной",
  "snippet": "…купили 16 м² плитки по 3 000 ₸…",
  "kind": "note",
  "occurred_at": "2026-10-12T09:00:00Z",
  "created_at": "2026-10-12T09:00:03Z",
  "page": {"id": "0193...", "title": "Заметки", "icon": "documents"},
  "pages": [{"id": "0193...", "title": "Заметки", "icon": "documents"}]
}
```

- `ref` is the source's id inside this reply (`s1`, `s2`, …). Citations point to it.
- `page`: where the chip opens the record: the current page if the record is on it, otherwise its
  first visible page; `null` when the record is on no page (open the record card).
- `snippet`: plain text, up to about 200 chars. Show as text, never as markup.

Citation:

```json
{
  "ref": "s2",
  "item_id": "0193...",
  "chunk_id": null,
  "page": {"id": "0193...", "title": "Заметки", "icon": "documents"},
  "title": "Плитка для ванной",
  "label": "Заметки · Плитка для ванной, 12 окт",
  "occurred_at": "2026-10-12T09:00:00Z"
}
```

`label` is ready for the chip («Страница · Запись, дата»), date in the person's time zone. Tap:
open `item_id` on `page`.

PagePatch (also in `POST /v1/actions/{id}/undo`):

```json
{
  "page_id": "0194...",
  "view_version": 7,
  "view_state": {"sort": "position", "groups": ["Ремонт", "Здоровье", "Остальное"]},
  "rows": [Link],
  "removed_item_ids": ["0193..."]
}
```

- `rows`: the changed links of the page, the same object as `link` in `GET /v1/pages/{id}/items`
  (`docs/api/pages.md`). Upsert by `(page_id, item_id)`. A record created by the line comes with
  its link here; fetch the record itself through `/v1/sync` (or `GET /v1/items/{id}`).
- `removed_item_ids`: links that are gone from the page (deleted, not «убрано»): drop them.
- After «Разложи по темам» rows have `group_key` = the group's title and `view_state.groups` is
  the groups in order, «Остальное» last. Show the page as stacks by `group_key` in that order;
  inside a group, page order. A sort («сначала новые») removes `groups` and clears `group_key`.

Proposal (in `needs_choice`, `confirm`, `confirm_manual` and on the message):

```json
{
  "reply_id": "0194...",
  "kind": "choice",
  "question": "Какую?",
  "count": null,
  "item_ids": [],
  "options": [
    {"id": "o1", "label": "Последнюю: «Чек Magnum»", "kind": "item", "item_id": "0193..."},
    {"id": "pick", "label": "Выбрать", "kind": "pick", "item_id": null},
    {"id": "cancel", "label": "Отмена", "kind": "cancel", "item_id": null}
  ],
  "default": null,
  "expires_at": "2026-11-08T14:20:00+00:00",
  "state": "open"
}
```

- `kind`: `choice` (which record), `count` («Да» with a number), `manual` (records placed by hand).
- `options[].kind`: `item` (this record), `pick` (let the person tap a record on the page, then
  send the **original phrase again** with that `selected_item_id` and a new `client_id`), `yes`,
  `no`, `keep_mine`, `cancel`, `time` (Ф-89, see below), `mode` (Ф-96: «По дню одним делом» /
  «Каждый пункт отдельно»), `date` (a first day for a plan on the
  calendar, `plans.md` «A plan on the calendar»: «С завтра, 21 ноября»; send it back as any tap).
- Ф-89 (2026-11-20) «когда?»: a reminder phrase whose time is unclear (a bare «в 7», or a time
  already past today) also ends as a `choice`: `question` is the `reminder_draft` message («В 7
  утра или в 7 вечера?», «Это время уже прошло. Сегодня в 11:00 или завтра в 9:00?»), `options` =
  two `time` buttons labelled «Сегодня в 19:00» / «Завтра в 7:00» / «Во вторник в 9:00» and
  `cancel`. A tap (`choice.option` = `t1` / `t2`) answers with a `reminder_draft` of `status: ok`
  for that moment and the banner «Понял так: … Сохранить?»; nothing is saved until [Сохранить]
  (S13). The `reminder_draft` of the first turn still carries both `options` (older phones).
  A part of a longer phrase keeps only its `reminder_draft` options (no proposal).
- 0035 (calendar.md «From the assistant line»): «добавь встречу завтра в 15:00 на час» is made
  by code at once (`action`, `tasks[]` with `start_at` / `duration_min`); an unclear hour or a
  past time is the same `choice` with `time` options (`plan.tool: "task_time"`), the tap makes
  the to-do.
- Any other tap: `POST /v1/chat/messages` with `choice: {"reply_id", "option": id}` and the
  label as `text`. The answer streams like any other (`action`, `done`, ...). `cancel` / `no`:
  «Хорошо, ничего не менял.»
- `state`: `open`, `answered`, `expired` (24 h). A tap on an answered or expired one gets a text
  answer «Это уже неактуально — скажите ещё раз, пожалуйста.»
- `count` (`count` / `manual`) and `item_ids` (`manual`: the records placed by hand) are for
  display; `question` already has the number.

### Delivery (6.11)

- The answer is written on the server whether or not the phone stays connected. Leaving the page
  does not stop it.
- If the stream is still open at the end: `delivery = "streamed"`.
- If the phone was gone at the end: `delivery = "banner_pending"`; the answer waits for
  `GET /chat/pending-banner` (show it on «Сегодня»). This holds for every answer kind: a text
  answer (banner), a change (`action` on the message, with [Отменить]) and a question back
  (`proposal`).
- Push «Ответ готов» (no text, ever — R-14): sent when the answer finished at least 5 s after
  the phone left (or was finished later by the server), at most one per 10 minutes, never in the
  person's quiet hours, only to devices with a push token. Payload `data`:
  `{"type": "chat_reply", "reply_id": uuid}`. Tap → «Переписка» on `reply_id`
  (`GET /chat/messages?around=`). **Not live yet**: push credentials are not configured on the
  server, so nothing is delivered until they are.
- The phone reports what it showed: `POST /chat/messages/{id}/delivery`.

### Resume a dropped stream: `GET /v1/chat/messages/{reply_id}/events`

Send `Last-Event-ID: <last id you got>` (or `?after=<id>`; `0` = from the start). Same consent as
`POST`. `404 not_found` for an unknown id or another person's message.

- Answer still being written, on this server: the events after that id, then live until the end.
- Answer finished (or written by another server): `accepted`, then `snapshot` with the saved
  message, then `done` / `deferred` / `error`. Replace the text you have with the snapshot's.
- Answer being written by another server: keep-alives until it is saved, then the snapshot.
- Answer stuck (the server restarted while writing, nothing for 2 min): the server finishes it
  by itself (a question is answered again; a change is made, or waits as a proposal when it needs
  «Да»; a reminder phrase: `failed`, `not_done`). Meanwhile
  the stream sends keep-alives; you may close it and wait for `pending-banner` / the push. When
  nothing will finish it any more: `snapshot` + `error` (`code: "stale"`, `retry=true`).

Reconnect with a short backoff (1 s, 2 s, 4 s, then every 10 s). `GET /chat/messages/{id}` is the
plain JSON alternative.

**Steps 3–4 of the vision plan (2026-11-16, Ф-64…Ф-73).**
- **Notices.** Every `action` event's Action has `notice` (`actions.md`): show it as the 3-second
  top notice instead of a big card; a tap opens `notice.target`, the button is
  `notice.undo_label_ru` («Восстановить» after a delete).
- **Delete without «Да» (Ф-66).** «удали плитку», «удали все покупки»: done at once
  (`action` `delete_item`, notice «Удалил «…» · Восстановить»); no `confirm` event for a delete
  any more. A phrase without a delete word («перенеси …») can never trash, whatever a record
  says. `confirm` stays for >150 records in a reorder and `confirm_manual`; irreversible things
  (delete for good, sending to a client) keep their own confirmations.
- **Undo by phrase, any action (Ф-67, Ф-73).** «верни как было», «верни всё как было»,
  «отмени», «отмени последнее», «отмени всё», «не туда», «верни запись про хлеб», «отмени то, что
  ты сделал с плиткой» (Kazakh «қайтар», «болдырма»). Code only, no model:
  - no words about what → the assistant's newest change of the last 24 h, with every action of
    that same phrase («отмени всё»);
  - with words → the newest undoable action of the last 30 days (the person's or the assistant's)
    whose summary or «Что изменилось» rows contain them (by stem: «хлебом» finds «Хлеб»);
  - it runs `POST /v1/actions/{id}/undo`'s undo. Events: `tool_activity` (`tool: "undo"`,
    «Возвращаю…»), one `action` per undone action with **`undone`** (the undone Action as it is
    now: `undone_at` set — mark it «отменено»), `page_patch`, `done` (`answer_kind: "action"`).
    Answer text: «Вернул как было: записал в «Дела».» (+ «Часть вы уже изменили сами — её
    оставил.» when partial). Nothing found: a text answer «Не нашёл, что отменить. В «Истории»
    можно отменить любое действие.» / «Не нашёл недавнего действия про «…». …».
  - «верни страницу как было», «верни вид / поле» are still the page view reset (`set_view`).
- **Without the model (Ф-69).** When the model is down, a phrase the line would keep is saved as a
  note at once: `action` `save_item` with `payload` `parse_later`, summary and notice
  «Сохранил как заметку, разберу позже»; the record has `parse_later: {"state": "waiting", …}`
  (`items.md`). The chat worker (`chat:parse_later`) reads it once the model is back — code
  rules first, then the model; while the model is down it waits with backoff (and is retried for
  7 days). A spend → an expense on «Расходы», a to-do → a task on «Дела», the note leaves
  «Заметки»: one agent action with `parsed_later: true`, notice «Разобрал: перенёс в «Расходы»»,
  «Отменить» as usual, the record gets «изменил помощник». Anything else stays a note
  (`parse_later.state: "done"`, «Разобрал: оставил заметкой»). Questions and reminder phrases are
  never acted on in the background this way. An order («перенеси…») or a question while the model
  is down is still `deferred` and finished later (as before). The phone, offline, saves the
  phrase with `POST /v1/items` `source_meta.from_line` (`items.md`): what code cannot read there
  gets the same `parse_later` (only with the `ai_cross_border` consent).

**Step 5 of the vision plan (2026-11-16, Ф-59…Ф-61, Ф-70): memory and the whole conversation.**
No screen of its own (Ф-59): all of it is by phrase in the line, answered by code (no model),
`done.answer_kind: "text"` with a `banner`:
- «Что ты обо мне помнишь?» / «что ты знаешь обо мне» — the facts by kind («Люди: …»,
  «Текущие дела: …»), «(из материала)» on those taken from saved materials.
- «запомни: я не ем свинину», «запомни, что мой брат Ерлан» — stored at once: «Запомнил: …».
  Never kept, with an honest answer: document / card / ИИН numbers and long numbers, health,
  religion, politics, intimate life, nationality, passwords.
- «забудь про ремонт» — the matching facts are deleted for good: «Забыл: «…»». Nothing matched:
  «Такого в памяти не нашёл…».
- «забудь всё» — it cannot be undone, so a compact `confirm` (Proposal `kind: "count"`, options
  «Забыть» / «Не сейчас»); «Забыть» → «Забыл всё, что помнил о вас.».
Automatic (Ф-61): every 4 new phrases (or 4 new shared / forwarded records) the chat worker
(`chat:memory`, light model, background budget, ≤6 reads per person a day) keeps short facts:
people, places, preferences, routines, ongoing projects with an end date, agreements. From the
person's words (`said`) and from materials (`material`, «из материала», Ф-70); the same
never-kept list is checked by code after the model, and a fact the model attributes to the
person must have the person's words in it. One row per fact (deduped by its words), ≤150 per
person; an ended project goes 30 days after its date. Facts are in the data export
(`memory.json`) and go with the account. «Очистить переписку» does not clear the memory (that is
«забудь всё»).
Every answer gets the memory as a data block «Память о человеке» (≤500 tokens: ongoing projects,
then facts about the phrase — by words, by meaning when embeddings are on — then the most
mentioned). The phone shows nothing new for it.
**Whole conversation (Ф-60).** New read tool `search_chat` (`tool_activity` «Ищу в переписке…»):
the model may look up any earlier turn; a phrase that points to the past («как в прошлый раз»,
«что ты мне советовал про …», «мы обсуждали») also gets up to 4 such turns in its context.
By words now, by meaning when the embedder is on (`search.md`). Shared text is never searched as
the person's words. These turns are not records: no citation chips for them; the answer says the
date («вы писали 3 марта»).

**Step 6: several things in one phrase (2026-11-16).**
- Code first: a phrase is split at «,» / «;» / «и» before an order word («напомни», «запиши»,
  «купи», «потратил», «переложи»…), and a spend with several amounts at «и» / «,» («купил хлеб за
  400 и молоко за 600» → two spends). Every part code reads (a spend, a to-do / shopping list, a
  «запиши …» note, a «напомни …» reminder) is done by code; a reminder part sends its
  `reminder_draft` (set only after «Сохранить»). Parts code cannot read go to the model in the
  same turn, which may call several change tools; the intent rule still decides on the person's
  own phrase. If the model cannot be reached, the answer says «Не успел: «…» — скажите это ещё
  раз чуть позже.»; a part nobody understood: «Не понял: «…».». A phrase mixing a reminder with a
  part for the model is not split. Not split either: questions, more than 8 parts.
- Each change is its own `action` event (replace by `action.id` as before); from the second one on,
  `action.group` is set (`actions.md` «Groups»). `done` has **`action_ids`** (all of them) and
  **`group`** (null for one action): show `group.notice` («Сделал 3 дела · Отменить всё») once,
  instead of one notice per action. The ChatMessage's `action` is the first one, with `group`.
- «отмени» / «верни как было» without words undoes the whole last phrase (all its actions).
- Irreversible things still ask: «Да» rules are unchanged.

**Ф-88 (2026-11-19): no claimed changes, mixed phrases, follow-ups.** No new events or fields;
what the phone sees changes as follows.
- **Mixed phrases.** «потом» / «затем» / «после этого» and a new sentence also split a phrase,
  whatever word follows (each side keeps 2+ words). «Мне завтра надо поехать в сто, ходовку машины
  посмотреть, потом я сегодня купил кофе за 1000 тенге» → a to-do «Поехать в сто, ходовку машины
  посмотреть» due tomorrow + a spend 1 000 ₸ with `note` «кофе» today: two `action` events, one
  `group` («Сделал 2 дела · Отменить всё»). A spend phrase that also says something else (a day
  ahead, «надо», an errand verb, a second sentence) never takes the instant spend path with the
  whole phrase as its name: when code cannot split it, the strong model cuts it into parts (task
  `phrase_split`), code checks every word and number of each part against the phrase and reads
  each part as usual; a part with a word the person did not say → nothing is split (the phrase
  goes the usual way, no spend is made of it). To-do titles stay in the person's words (code
  checks that), so «поехать», not «съездить».
- **Changes run on the strong model.** A turn that may change something (the intent rule says
  change, or a follow-up below) runs on task `chat_change` (Sonnet first, then the fallback
  provider's strong model; `routes.yaml`); questions and conversation stay on `chat` (Haiku).
  Cost per answer is recorded as before (`cost_usd`, `provider_usage`).
- **No «Создаю…» without an action.** The first step of a change turn asks for a tool call
  (forced on Gemini / OpenAI; Anthropic models reject a forced choice, so it is checked in code).
  If the answer says a change is made or being made («создаю», «записал», «перенёс»…, Kazakh
  «жасадым», «жаздым»…) and no change ran, code asks the model once more with a tool required. If
  still nothing ran, the answer is a code text «Не получилось — ничего не изменил. Скажите,
  пожалуйста, ещё раз.» (`answer_kind: "text"`, not AI-labelled), never a made-up «Готово».
- **Follow-ups.** «Ну и где эта страница?», «давай», «создай», «сделай это», «да» within 30
  minutes after a change request that did not happen (no action under its answer) get the change
  tools; the model is told the earlier request, and code's checks (a page only on a direct
  request, delete words, view words) read both of the person's phrases. With nothing pending, such
  a phrase is a question as before.

**Week 20 (Ф-50).**
- Every save from the line carries `action.saved_to` (`actions.md`): «Сохранил в «…» · Переложить
  · Отменить».
- **Answer as a value.** `banner` and ChatMessage have `value`: `{"text": "4512", "source":
  Citation}` when a short checked text answer (≤80 chars) gives exactly one value and has a
  citation; else `null`. Show the value big with «Скопировать» and the source chip. Code only.
- **A КП from the line.** «сделай КП для ТОО Ромашка: 20 светильников, монтаж», «составь КП …»,
  «сделать документ / КП из этого» (code reads the order; never from shared text): a new КП as
  `POST /v1/documents/kp` does (same checks, daily limit). The rest of the phrase is saved as the
  person's record (the ТЗ); «из этого» = `selected_item_id` (or the only visible record). Event
  `kp_started` `{"reply_id", "document_id", "from_this"}` → open the КП and follow
  `GET /v1/documents/{id}/progress`; the answer is a text «Готовлю КП — открою, когда будет
  готово.» (`answer_kind: "text"`). Without a ТЗ: «Что войдёт в КП? …»; «из этого» with nothing
  selected: «Из какой записи? …»; limit: «На сегодня КП достаточно — продолжу завтра.».
  `tool_activity.tool` may be `kp`.

## «История» (week 20, Ф-50): `GET /v1/history?only=&before=&limit=`

«Переписка» + «Что я сделал» in one feed: what the person said → what was done. Newest first.

| Param | Notes |
|---|---|
| `only` | `all` (default) · `changes` (phrases that changed something + changes without a phrase) · `questions` (phrases answered with text) · `waiting` (a question back waits for a tap). |
| `before` | the `id` of the last entry shown; unknown: `404 not_found`. |
| `limit` | 1...50, default 30. |

`{"entries": [Entry], "has_more": bool}`. Entry:

```json
{"id": "0194...", "kind": "turn", "status": "done", "at": "2026-11-13T12:41:00Z",
 "said": ChatMessage, "answer": ChatMessage, "action": Action}
```

- `kind: "turn"`: a phrase the person sent (`id` = that message); `answer` = the assistant's reply
  (null while none); `action` = what the phrase did (the same as `answer.action`).
- `kind: "action"`: a change made without a phrase (a tick, a move by hand, «Отменить», a form, a
  phrase whose message was cleared); `id` = the action, `said` / `answer` null.
- `status`: `done` · `undone` (show «Отменено · Вернуть» = undo of the undo, see `actions.md`) ·
  `waiting` («Ждёт · Ответить»: open `answer.proposal`) · `answered` · `pending` · `deferred` ·
  `failed`.
- «Отменить» = `POST /v1/actions/{action.id}/undo`. «Очистить переписку» removes the phrases; their
  changes then show as `kind: "action"`.

## History («Переписка», S36)

ChatMessage:

```json
{
  "id": "0193...",
  "client_id": "0193f0aa-...",
  "role": "user",
  "reply_to": null,
  "page": {"id": "0193...", "title": "Расходы", "icon": "wallet"},
  "input_kind": "typed",
  "text": "Сколько стоила плитка?",
  "answer_kind": null,
  "state": "done",
  "citations": [],
  "checked": null,
  "delivery": null,
  "ai_label": null,
  "action": null,
  "proposal": null,
  "choice": null,
  "error_code": null,
  "value": null,
  "seq": 4560,
  "created_at": "2026-11-07T14:20:00Z"
}
```

- `role`: `user` or `assistant`. `reply_to`: on an answer, the id of the person's message.
- `page`: the page it was said on («— на странице Расходы, 14:20 —»); null = unknown/removed page.
- `state`: `pending` (being written), `done`, `deferred`, `failed`. `text` of a `pending` answer is
  empty.
- `answer_kind`: `text`, `action` (a change: see `action`), `choice` (see `proposal`),
  `deferred`.
- `citations`, `checked`, `delivery`, `ai_label`: as in the stream; only on answers.
- `action`: the Action of a change answer (as in `actions.md`), else null.
- `proposal`: the Proposal of a `choice` answer, with its current `state`, else null.
- `choice`: on the person's message that was a tap: `{"reply_id", "option"}`, else null.
- `error_code`: on a `failed` answer (`stream_interrupted`, `stale`, `not_done`, ...), else null.
- `seq`: position in the `/v1/sync` stream.

### `GET /v1/chat/messages`

| Param | Notes |
|---|---|
| `before` | message id: older messages than this one. |
| `around` | message id: open «Переписка» on this answer (from the banner or a push): up to `limit/2` before it, it, and the rest after. |
| `limit` | 1...50, default 30. |

No `before`/`around`: the newest messages. Response:
`{"messages": [ChatMessage], "has_more_before": bool, "has_more_after": bool}`, oldest first.
`around` / `before` with an unknown id: `404 not_found`.

### `GET /v1/chat/messages/{id}` → ChatMessage

### `GET /v1/chat/pending-banner` → `{"message": ChatMessage | null}`

The newest finished answer with `delivery = "banner_pending"` (state `done`, `deferred` or
`failed`). It may be a text answer, a change (`action`) or a question back (`proposal`).

### Sync

`GET /v1/sync` has a new array `conversation_messages: [ChatMessage]`: the messages changed since
`since` among the newest 50 of the conversation (the phone keeps the last 50 for offline
«Переписка»). Tombstones may have `entity: "conversation_message"` («Очистить переписку»): drop
them by `id`.

### `POST /v1/chat/messages/{id}/delivery`

`{"delivery": "banner_shown" | "opened" | "dismissed"}` → ChatMessage. Only on answers (else
`404 not_found`). Marks never go back: `opened` or `dismissed` after `banner_shown` are kept;
`banner_shown` after `opened` changes nothing. Showing a banner from `pending-banner` → send
`banner_shown`; «Открыть ответ» → `opened`; «Закрыть» or a new request → `dismissed`.

### `DELETE /v1/chat/history` → `204`

«Очистить переписку»: every message goes, the conversation's summary is reset. Records created from
messages stay records; changes stay in «Что я сделал» with their «Отменить». An answer still being
written is dropped.

## Feedback: `POST /v1/feedback` (R-41, US-22)

```json
{
  "client_id": "0193...",
  "target": "answer",
  "target_ref": "0193...",
  "reason": "wrong",
  "comment": "Сумма не та",
  "allow_anonymized_example": false
}
```

| Field | Notes |
|---|---|
| `client_id` | uuid, optional. Repeat with the same one: `200` with the first result, nothing new is stored. |
| `target` | `answer` (an answer in «Переписка»), `kp`, `item`, `reminder`. |
| `target_ref` | uuid of the target. `answer`: an assistant message of this person, `item`: a record of this person; otherwise `404 not_found`. `kp`, `reminder`: stored as given (those objects arrive in later weeks). |
| `reason` | `wrong` («Неправильно»), `offensive` («Обидно / недопустимо»), `other` («Другое»). |
| `comment` | optional, ≤1000 chars. |
| `allow_anonymized_example` | default `false` (the box is unchecked by default). `true` = the person allows an anonymised example for quality checks. |

Response `201` (or `200` on a repeat): `{"id": uuid, "created_at": "..."}`. Stored in KZ.

## Notes for the phone

- After `action`, run `/v1/sync` to get new or changed records themselves; `page_patch` is enough
  to move the cards at once.

- Show the local FTS result («Нашёл у себя») first; the stream's `sources` are «Нашёл ещё…».
- A new request replaces the banner: mark the old one `dismissed`.
- Text in `token`, `banner.text`, `snippet`: plain text. Never render as HTML or markdown links.


## An ordinary assistant (Ф-95, chat-full-control.md §4, 2026-11-21)

A request to the assistant itself — «переведи на английский: …», «напиши поздравление маме»,
«посчитай 1 250 000 × 12 %», «сколько будет 15% от …», «исправь ошибки: …», «сократи текст: …»,
«объясни …», «как сказать …», «составь письмо …» (and «аударып бер», «есептеп бер», «түсіндір»,
«жазып бер») — is a **question** by code (`intent.asks_assistant`), whatever its length or digits:
none of the code's save / spend / to-do / reminder paths run, nothing is saved, the model answers
(`mode: general`). The status is «Думаю…» (not «Смотрю записи…»), and records are not searched for
it unless the phrase names the person's own («мои», «в записях», «сохранённые»). Not such a
request: «запиши …» (a note), «напиши в заметку …», «исправь ошибки в этой заметке» (an edit,
Ф-73), «переведи 5000 маме». INTENT prompt `intent.v2` adds the same class.

## The line runs the screens' operations (Ф-95 phase 1, chat-full-control.md §3, 2026-11-21)

What the screens do to to-dos, the calendar, reminders and expenses the line now does through the
same operations (`assistant.operations`, actions.md «Operations»): one action with «Отменить»,
the reply says only what really happened (Ф-88).

**Code first, no model** (`chat/ops_line.read_code`), only when exactly one object fits (else
the usual model turn):

| Phrase | Does |
|---|---|
| «хлеб купил», «купила молоко», «я позвонил маме», «оплатил интернет», «отметь корм коту купленным», «вычеркни батарейки», «молоко куплено» | `tasks.set_done` (the verb's stem picks between «Позвонить маме» and «Купить маме подарок»; a repeat: today's occurrence) |
| «не купил хлеб» | untick (`done: false`) |
| «купил хлеб за 400» | the spend as before **and** the open purchase «Хлеб» ticked — one group, «Отменить всё» (Ф-95 (2)); no such purchase: just the spend |
| «перенеси встречу с Ерланом на 16:00 / на пятницу / на 3 декабря в 11:00 / на час позже», «передвинь созвон на полчаса позже» | `tasks.reschedule` (a day only keeps the time, a time only keeps the day; a bare «на 4» takes the hour nearer the entry's own; a repeat: that occurrence only); an all-day to-do moves its day (`tasks.update`) |
| «сдвинь всё завтра на час» | `confirm` «Сдвинуть N дел?» [Да] [Не сейчас], then `calendar.shift_many` as one action |
| «не напоминай про свет», «отмени напоминание о таблетке» | `reminders.delete` («Больше не напомню: …»); not an undo by phrase any more |
| «перенеси напоминание про таблетку на 8 утра» | `reminders.update` |

An unclear time («на завтра в 9»: 9:00 or 21:00; a time already past) is a `needs_choice` with
the moments (Ф-89); the tap runs the operation. Nothing is done in the background that would ask.

**Reminders are set at once (Ф-95 (1)).** «Напомни завтра в 7:30 выпить таблетку» no longer sends
`reminder_draft`: the reminder is created (`reminders.create`, `initiated_by: agent`), the answer is
an `action` («Напомню завтра в 7:30: выпить таблетку · Отменить»). The S13 form (`reminder_draft`)
stays only when the time is unclear: no time («напомни позвонить маме»), an assumed time, or the
model could not read it. A tap on a time choice («Послезавтра в 21:00») now sets it at once too.

**The model's tools, by domain** (`ops_line`): one tool per domain — `tasks` (done, undone, move,
rename, delete), `calendar` (move, set_duration, delete, shift), `reminders` (create, move, rename,
cancel), `expenses` (fix, delete) — with `op` as an enum; descriptions are built from the
registry, irreversible operations are never offered (Ф-95 (4)). Code picks the domains of a change
turn from the phrase (`напомин` → reminders, `встреч` / a day / an hour → calendar + tasks,
`трат` / `сумм` / `₸` → expenses, `отметь` / `купил` → tasks; nothing → tasks + calendar), adds a
one-line catalogue «Ещё умею менять: …» and `need_tools(domain)` (the domain is there on the next
step). `lookup(domain, words, date_from, date_to)` reads more objects.

- **Refs.** The objects the phrase names are shown by code before the first step, as a data block
  «Дела, события, напоминания и траты» with refs `t1` (to-do), `c1` (calendar entry: a to-do with
  its time, one occurrence of a repeat), `r1` (reminder), `e1` (expense). The model names objects
  only by these; an unknown ref is an error, nothing changes. Their times / amounts may be said
  back (the number check allows them).
- **Times by code.** The model passes the person's own words (`when: "на пятницу в 16:00"`);
  code computes the moment (`timewords`, the person's zone).
- **«Да» (Ф-95 (3)).** More than 10 objects, or «все / всё» in the phrase over several → `confirm`
  with the count first, then one action. One object: at once.
- **Words guard.** A delete / cancel needs a delete word in the person's phrase («удали», «убери»,
  «отмени», «не напоминай»); an expense is fixed only when the phrase says so («исправь», «не 500, а
  5000», «это было вчера», «сумма», «категория»), with the amount the person said. A phrase that
  fixes a spend never makes a new one.
- **Questions.** «Что у меня в пятницу?», «я свободен завтра?», «какие у меня напоминания?» —
  code reads that day's calendar (or the reminders) into the turn and offers `lookup`; no change
  tool is offered on a question.

`tool_activity.tool` may be `tasks`, `calendar`, `reminders`, `expenses`, `lookup`, `op` (code),
`reminder`. The proposal of an operation has `plan.tool: "op"` (a tap / «Да» runs the stored
operations). Cost guard: actions.md / ops `change_turn_cost` alert (Ф-95 (6), costs.md).

## The line runs the rest of the screens (Ф-97, chat-full-control.md phases 2–3, 2026-11-21)

Same scheme as phase 1: code reads the frequent phrases, the model gets small domain tools built
from the registry, every change is one action with «Отменить», the reply says only what happened.

**Code first, no model** (`ops_line.read_more`; kk patterns are basics, pending native review):

| Phrase | Does |
|---|---|
| «убери купленное», «удали сделанные дела», «сатып алынғандарды өшір» | `tasks.clear_done` (bulk: «Да» first above 10 or with «все»); nothing done: «Купленного нет — ничего не убирал.» With «Покупки» off (Ф-49) «купленное» = the done «Купить …» to-dos |
| «верни из корзины заметку про шины», «восстанови удалённое дело купить шины» | `trash.restore` (a to-do's record with its to-do, an expense's with its expense, a КП with its document); exactly one in the trash must fit, else the model asks. A plain «верни запись про хлеб» stays an undo by phrase |
| «восстанови страницу Ремонт» | `pages.restore` |
| «удали страницу Ремонт», «удали эту страницу» | `pages.delete` — reversible (records stay, «Отменить» / `/restore`), so no «Да» (Ф-66); «Сегодня» never |
| «бюджет 300 000 в месяц», «поставь бюджет 250 тыс», «айлық бюджет 300 000» / «убери бюджет» | `expenses.set_budget` / `expenses.clear_budget`, with «Отменить» (the screen's own budget stays a setting without one) |
| «тихие часы с 23 до 7», «не беспокой меня с 10 до 7» (→ 22:00–07:00), «тыныш уақыт 23-тен 7-ге дейін» | `settings.quiet_hours` |
| «зови меня Али», «мені Али деп ата» / «не называй меня по имени» | `settings.name` (`display_name`, as `PATCH /v1/me`) |
| «почисти повторы», «удали дубли» | the «Повторы» cleanup plan (`dedup.plan_cleanup`), `confirm` «Убрать N повторов? Оставлю по одной записи.», then `duplicates.cleanup` (one `cleanup_batch`); none: «Повторов не нашёл» |
| «молоко и хлеб купил», «купил молоко, хлеб и сыр» | each named thing must be exactly one open to-do / purchase; all ticked in one action |
| «молоко не 2, а 3» | `tasks.update` qty (with «Покупки» off: the title «Купить молоко, 2» → «…, 3»); only if it said 2 (or nothing), else it may be a spend fix |
| «цену светильников 4 500», «убери доставку» on an open КП (`selected_item_id`) | the КП screen's phrase edit: KP_EDIT reads it, `kp.edit.check_ops` checks every number against the phrase, `kp.edit` writes one version, `edit_kp` with «Отменить». Sending stays on the screen (Ф-95 (4)) |

**New model tools.** `tasks` gets `update` (title, `qty`, `where`, `list_key`) and `clear_done`
(`list_key`); new `pages` (`delete_page` by `p` ref; `restore_page`, `restore` by `x` refs of the
trash) and `settings` (`budget`, `clear_budget`, `quiet_hours`, `name`, `rule_off` by `h` refs of
the learned rules). `lookup` reads `trash` (`x` refs) and `rules` (`h` refs) too. Offered only when
the phrase's words pick them (`страниц`, `корзин`, `верни`, `бюджет`, `тихие часы`, `правил`, …)
or by `need_tools`. Guards: a page goes only with a delete word, the trash only with «верни /
восстанови», a rule only with «убери / отключи / больше не клади»; a budget, quiet hours, a
quantity, a shop and a name only as the person said them (code reads them from the phrase where it
can). Never from the line: delete forever, account, consents, logout, the phone number, sending a
КП without «Да», imports, page views (Ф-39).

**Offline edits are not overwritten.** Each call on a to-do / expense / reminder carries the
`version` the line saw; if the phone changed it meanwhile (an outbox edit, or before a «Да»), nothing
is done and the answer says «Это только что изменили на телефоне — ничего не менял…».

**Background (Ф-97 (1)).** A reminder phrase finished in the background (after a restart) with a
clear time is set at once with «Отменить» (banner + push), like a to-do; an unclear time is not set
(alone: `not_done`, retry; inside a longer phrase: «Напоминание «…» не поставил: время непонятно»).

**«Когда я свободен завтра?»** Code reads the named days' calendar and adds «Свободно чт 13.11
(посчитано кодом…): 8:00–10:00, 11:00–22:00» (8:00–22:00, windows ≥ 30 min; an entry without a
length counts an hour; the past part of today is not free); its times are facts the number check
accepts.

`tool_activity.tool` may also be `pages`, `settings`, `kp_edit`.
