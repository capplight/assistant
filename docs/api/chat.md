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

**Plain notes.** A phrase that only states something to keep («купить хлеб», a phone number,
«Мастер Ерлан, плитка») is saved as a record in the person's words on the current page (on
«Сегодня»: only where the page rules put it), with «Отменить»: `action` with `kind: "save_item"`,
`summary.ru` «Записал.», `done.answer_kind: "action"`. «запиши …» / «сохрани …» / «добавь …»
(without a page name) save the rest of the phrase the same way. The text is never rewritten by a
model. A question («где ключи?»), one word («плитка») or an order goes the usual way. When the
answering service is down, a phrase of 3+ words or with a long number is still saved; a shorter
one gets `deferred`.

**Tasks, shopping and reminders (week 9).** On any page: «купить хлеб, молоко и лекарства маме»,
«добавь в покупки молоко», «позвонить маме завтра» become tasks on «Покупки» / «Дела и
напоминания» (one `action`, `kind: "save_item"`, «Добавил в Покупки: хлеб, молоко, лекарства
маме.», the `action` event also has `"tasks": [Task]`; details and who reads the phrase:
`today.md`). Not a list → a plain note as above. «Напомни …», «разбуди …», «не дай забыть …»,
«поставь будильник …» give a `reminder_draft` event for S13 (nothing saved until [Сохранить]:
`reminders.md`). The phone should send these phrases here, not to `/reminders/parse`.

**When the line changes something.** Only when the person's own phrase asks for a change (code
checks the phrase first; a short model check only when the words are unclear). Text inside
records, files and shared text (`input_kind: "share"`) never makes a change, whatever it says.
Changes happen on the page the line is on (`page_id`) unless the phrase names another page; the
answer then says where («Добавил в «Покупки»»). Records placed by hand (`manual_order`) are never
moved without the person's «Да» (`confirm_manual`).

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
| `page_id` | uuid or null | The page the line is on. Unknown or removed page: treated as null (no error: the question still gets answered). |
| `visible_item_ids` | uuid[], ≤40, default `[]` | Records on screen now, top first. Ids that are not this person's, or not visible, are dropped. |
| `view_version` | int or null | The page's `view_version` the phone is showing. |
| `selected_item_id` | uuid or null | «это / здесь»: the open or selected record. Without it, «удали это» on a page with more than one record gets `needs_choice`, never a change. |
| `choice` | object or null | The person tapped an option of an earlier `needs_choice` / `confirm` / `confirm_manual`: `{"reply_id": uuid, "option": "<option id>"}`. Send the option's label as `text` (it is shown in «Переписка»). See Proposal below. |
| `lang` | `ru` or `kk`, optional | Language of the phrase. Default: the account locale. The answer is in this language. |
| `input_kind` | `typed` (default), `voice`, `share` | How the phrase was entered (for «Переписка»). |

Errors before the stream: `401`, `403 consent_required`, `422 validation_error`.

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
| `tool_activity` | 0...n | `{"tool": "search" \| "list_page" \| "create" \| "update" \| "move" \| "reorder" \| "create_page_from_template", "text": "Раскладываю…", "page_id": uuid \| null}` |
| `sources` | 0...n, before the first `token` of the text that uses them | `{"sources": [Source]}` — **new** sources only; append by `ref`. Show as «Нашёл…» cards while the answer is written. |
| `token` | 0...n | `{"text": "..."}` — append to the answer. Pieces are whole sentences: each sentence is checked (numbers and dates) before it is sent, so nothing shown is taken back. |
| `citations` | once | `{"citations": [Citation]}` — the chips under the answer. Only records the answer is based on. May be empty. |
| `checked` | once | `{"ok": bool, "removed": int}` — `removed` sentences had a number or a date not found in the sources and were not sent (R-36). Numbers our **code** computed this turn (a count of a page, and from week 12 the totals and remainders of `aggregate`) are allowed too (founder 2026-11-09); a number the model works out itself is still removed. `ok=false` means the text ends with the note «Часть чисел не нашёл в записях — не стал их писать.» Nothing to do beyond showing the text. |
| `action` | 0...n, a change was made (already saved) | `{"reply_id", "action": Action, "changed_item_ids": [uuid], "page_id": uuid \| null}` — Action as in `actions.md`. Several in one reply = the same action growing: replace by `action.id`. Show `action.summary.ru` in the line with [Что изменилось] (`action.changes`) and [Отменить] (`POST /v1/actions/{id}/undo`). Highlight `changed_item_ids` 600 ms. |
| `reminder_draft` | 0...1, a reminder phrase (week 9) | The `/v1/reminders/parse` result + `reply_id`, `created_via` (`reminders.md`): open S13 (or S12 for `status: "form"`). Followed by `banner` + `done` (`answer_kind: "text"`). Nothing was saved. |
| `page_patch` | after each `action` that touched page rows | PagePatch (below): apply at once (move the cards); hold it while the person is dragging a card. |
| `needs_choice` | instead of a change, when «это» is unclear | Proposal (below), `kind: "choice"`: «Какую?» with 2-3 options. Nothing was changed. |
| `confirm` | instead of a big change, and **every delete** (week 10, founder 2026-11-09) | Proposal, `kind: "count"`: «Переставить 212 записей?» / «Удалить 8 записей?» / «Удалить «Купить хлеб»?» (`count: 1`) [Да] [Не сейчас]. Nothing was changed yet. A record picked in the answer to «Какую?» of a delete counts as the «Да». Deletes from the UI (`DELETE /v1/items/{id}`) are unchanged. An explicit move («перенеси это в Покупки») needs no «Да», also for a row placed by hand. |
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
  `no`, `keep_mine`, `cancel`.
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
