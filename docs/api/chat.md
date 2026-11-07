# Chat API: the assistant line, answers, «Переписка», feedback (week 5)

Spec: `docs/spec/final/3-engineering.md` 3.7 (feedback), 3.13, 4.12, 5.6, 5.7, 5.10, 6.9, 6.11;
`03-persistent-chat-decisions.md` 3.5; R-14, R-36, R-41, R-52, R-53, R-56; US-22, US-25, US-26.
Base path `/v1`. Every endpoint needs `Authorization: Bearer`. Errors before a stream starts have
the usual shape `{code, message_ru, message_kk, retry_after?, details?}`.

One conversation per person, across all pages. The line on any page posts here; the answer is
about **all** pages (sources may come from another page than the one the person is on).

Week 5 scope: questions and text answers with sources (read-only). Actions (`action`,
`page_patch`, `needs_choice`, `confirm_manual`, `pending_action`) and `general_answer_offer` are
week 6+: the client should ignore unknown events, so they can be added without a new version.

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
| `view_version` | int or null | The page's `view_version` the phone is showing. Stored; used by actions in week 6. |
| `selected_item_id` | uuid or null | «это / здесь». Stored; used in week 6. |
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
| `status` | 0...n | `{"stage": "thinking" \| "searching" \| "writing", "text": "Смотрю записи…"}` — show `text` in the line. |
| `tool_activity` | 0...n | `{"tool": "search" \| "list_page", "text": "Ищу в Расходах…", "page_id": uuid \| null}` |
| `sources` | 0...n, before the first `token` of the text that uses them | `{"sources": [Source]}` — **new** sources only; append by `ref`. Show as «Нашёл…» cards while the answer is written. |
| `token` | 0...n | `{"text": "..."}` — append to the answer. Pieces are whole sentences: each sentence is checked (numbers and dates) before it is sent, so nothing shown is taken back. |
| `citations` | once | `{"citations": [Citation]}` — the chips under the answer. Only records the answer is based on. May be empty. |
| `checked` | once | `{"ok": bool, "removed": int}` — `removed` sentences had a number or a date not found in the sources and were not sent (R-36). `ok=false` means the text ends with the note «Часть чисел не нашёл в записях — не стал их писать.» Nothing to do beyond showing the text. |
| `banner` | once, for a text answer | `{"reply_id", "text", "preview", "short", "ai_label", "citations": [Citation]}` — the full checked answer (same as the tokens joined), a ≤140-char `preview` cut at a word, `short=true` when `text` fits in the preview. The phone decides «≤2 строк» by its font; `short` is only a hint. `ai_label` is set when the text was written by the assistant: show it (R-06). |
| `done` | last, success | `{"reply_id", "state": "done", "answer_kind": "text", "delivery", "limited": bool}` — sent **after** the answer is saved. `limited=true`: the person's monthly limit is reached; the answer is search results without a written answer (the banner says «На сегодня достаточно — продолжу завтра…»). |
| `deferred` | last, instead of `done` | `{"reply_id", "state": "deferred", "reason": "unavailable", "text": "Сейчас не получается ответить. Попробуйте чуть позже."}` — the answering service is down. The message stays in «Переписка». (Week 6 finishes it in the background and sends a push «Ответ готов».) |
| `error` | last, instead of `done` | `{"reply_id" \| null, "code", "message_ru", "message_kk", "retry": bool}` — `retry=true`: show «Попробуйте ещё раз» and send a **new** `client_id`. Codes: `stream_interrupted`, `consent_required` (`retry=false`), `stale` (resume found it stuck), `internal`. |
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

### Delivery (6.11)

- The answer is written on the server whether or not the phone stays connected. Leaving the page
  does not stop it.
- If the stream is still open at the end: `delivery = "streamed"`.
- If the phone was gone at the end: `delivery = "banner_pending"`; the answer waits for
  `GET /chat/pending-banner` (show it on «Сегодня»). Push «Ответ готов» is week 6.
- The phone reports what it showed: `POST /chat/messages/{id}/delivery`.

### Resume a dropped stream: `GET /v1/chat/messages/{reply_id}/events`

Send `Last-Event-ID: <last id you got>` (or `?after=<id>`; `0` = from the start). Same consent as
`POST`. `404 not_found` for an unknown id or another person's message.

- Answer still being written, on this server: the events after that id, then live until the end.
- Answer finished (or written by another server): `accepted`, then `snapshot` with the saved
  message, then `done` / `deferred` / `error`. Replace the text you have with the snapshot's.
- Answer being written by another server: keep-alives until it is saved, then the snapshot.
- Answer stuck (the server restarted while writing, nothing for 2 min): the reply becomes
  `failed`; you get `snapshot` + `error` (`code: "stale"`, `retry=true`).

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
  "created_at": "2026-11-07T14:20:00Z"
}
```

- `role`: `user` or `assistant`. `reply_to`: on an answer, the id of the person's message.
- `page`: the page it was said on («— на странице Расходы, 14:20 —»); null = unknown/removed page.
- `state`: `pending` (being written), `done`, `deferred`, `failed`. `text` of a `pending` answer is
  empty.
- `answer_kind`: `text` for answers (week 6 adds `action`, `choice`).
- `citations`, `checked`, `delivery`, `ai_label`: as in the stream; only on answers.

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

The newest finished answer with `delivery = "banner_pending"` (state `done` or `deferred`).

### `POST /v1/chat/messages/{id}/delivery`

`{"delivery": "banner_shown" | "opened" | "dismissed"}` → ChatMessage. Only on answers (else
`404 not_found`). Marks never go back: `opened` or `dismissed` after `banner_shown` are kept;
`banner_shown` after `opened` changes nothing. Showing a banner from `pending-banner` → send
`banner_shown`; «Открыть ответ» → `opened`; «Закрыть» or a new request → `dismissed`.

### `DELETE /v1/chat/history` → `204`

«Очистить переписку»: every message goes, the conversation's summary is reset. Records created from
messages stay records. An answer still being written is dropped.

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

- Show the local FTS result («Нашёл у себя») first; the stream's `sources` are «Нашёл ещё…».
- A new request replaces the banner: mark the old one `dismissed`.
- Text in `token`, `banner.text`, `snippet`: plain text. Never render as HTML or markdown links.
