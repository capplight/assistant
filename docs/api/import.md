# Import API: Telegram «Избранное» from an export file (week 10); AI-chat exports (step 7)

Spec: `docs/spec/final/3-engineering.md` 3.7 `imports`, 4.9, 6.10; decision №5, R-28. Base path
`/v1`. Needs `Authorization: Bearer` and the base consents; starting an import also needs the
`telegram_import` consent (screen `import`), else `403 consent_required` with
`details.missing: ["telegram_import"]`. Its text is in `GET /v1/consents/text?kind=telegram_import`
(placeholder until the lawyer; the KK line awaits review).

## What the person does

1. Telegram Desktop → «Избранное» → ⋮ → «Экспорт истории чата», format **JSON** (media may be
   unticked: only text is carried). Or a full «Экспорт данных» in JSON: only «Избранное» is read,
   other chats are never taken.
2. The phone uploads `result.json` or a `.zip` of the export folder through the usual flow:
   `POST /v1/uploads` (`mime`: `application/json`, `application/zip`,
   `application/x-zip-compressed`, `application/octet-stream` or `text/plain`; ≤ 50 MB) → PUT →
   `POST /v1/uploads/{id}/complete`.
3. `POST /v1/imports/telegram/file`, then poll `GET /v1/imports/{id}` (every 2–3 s) until `done`,
   `failed` or `cancelled`, and show the summary.

## `POST /v1/imports/telegram/file`

```json
{"client_id": "0194...", "upload_id": "0194..."}
```
`202 {"import": Import, "created": true}`; the same `client_id` again: `200`, `created: false`.

Errors: `404 upload_not_found` · `409 upload_not_ready` · `409 upload_in_use` (this upload was
already imported or attached) · `409 import_running` (wait for the one in progress) ·
`422 import_bad_file` (wrong type) · `403 consent_required`.

**Placement: by the page rules, on purpose — there is no page list.** Brought records are placed
like any new record, by each page's `auto_rule` (`added_by: "rule"`, spec 6.10: «раскладываются по
выбранным страницам по auto_rule»): notes land on «Заметки», a receipt on «Расходы», a shopping
list on «Покупки» — on the pages the person already chose. The phone does not send pages; a picker
on the import screen is not needed. If the founder wants «put everything on this page», it would be
an additive `page_id` later.

## Import

```json
{
  "id": "0194...", "client_id": "0194...", "source": "telegram_export_file",
  "status": "done", "error": null,
  "total": 640, "processed": 640, "created": 420, "skipped_dups": 212, "seen_before": 0,
  "skipped_media": {"video": 34, "photo": 12, "sticker": 9},
  "failed": 1,
  "summary_ru": "Принёс 420 записей, 212 повторов убрал, видео (34), фото (12), стикеры (9) не перенёс — только подписи, 1 сообщение не прочитал.",
  "action_id": "0194...",
  "seq": 1234, "created_at": "...", "started_at": "...", "finished_at": "..."
}
```

| Field | Notes |
|---|---|
| `status` | `created` → `running` → `done`; or `failed` (`error` says why) or `cancelled`. |
| `total` / `processed` | Messages with text found / written so far: progress «Перенёс 120 из 640». |
| `created` | Records brought (`kind: "tg_message"`, `source: "import_telegram"`). |
| `skipped_dups` | Exact repeats not brought, before anything is read by a model: a message whose normalised text is already a visible record, or repeats inside the export. |
| `seen_before` | Messages an earlier import already brought: never duplicated, not counted again (R-28). Re-importing the same export is safe. |
| `skipped_media` | Media not carried over, by kind: `photo`, `video`, `voice`, `audio`, `sticker`, `animation`, `video_message`, `file`, `poll`, `location`, `contact`. A caption comes as the record's text. |
| `failed` | Messages that could not be read. |
| `summary_ru` | Ready to show. |
| `action_id` | The `import_batch` action: «Отменить» moves every brought record to «Удалённые записи» (30 days). |

`error` codes: `import_bad_file` (not a Telegram export, broken JSON or zip), `import_no_result_json`
(a zip without `result.json`), `import_not_saved_messages` (an export of another chat),
`import_too_large` (`result.json` over 64 MB, or a zip packed suspiciously tightly),
`import_too_many` (over 50 000 messages), `import_file_missing`.

## `GET /v1/imports/{id}` → `{"import": Import}` · `GET /v1/imports?limit=10` → `{"imports": [Import]}`

## `POST /v1/imports/{id}/cancel` → `{"import": Import}`
Stops after the batch in progress. What was brought stays, with its summary and «Отменить».

## After the import

- The exported file is not kept (decision 8): it goes to storage purge right after reading; only the
  text stays. Links in messages are kept as text and **never opened** by the server.
- Repeats: a scan for similar records runs at once; its groups have `origin: "import"` and appear in
  `GET /v1/duplicates/groups` («Объединить?»), and `POST /v1/duplicates/cleanup/plan` covers what
  was there before (`duplicates.md`).
- Understanding the records (titles, topics, stacks) runs later, 50 at a time, on the one-off import
  budget ($1), and only with `ai_cross_border`. The records are usable before it and without it.
  Message text is data for the model, never instructions.
- Events (with the `analytics` consent): the server writes `import_completed`
  (`method: file`, `items`, `skipped`).

## AI-chat exports: ChatGPT, Claude, Gemini (step 7)

The person's own chats with ChatGPT, Claude or Gemini, brought from the provider's export file, so
«что мне советовали про кафе в Стамбуле?» is found here. One import for all three: the server
recognises the format. No login to their accounts, no OAuth (providers have none for chats).

### What the person does

| Provider | Where the file comes from | What to upload |
|---|---|---|
| ChatGPT | Settings → Data controls → Export data → link in the e-mail | the `.zip` (or `conversations.json` from it) |
| Claude | Settings → Privacy → Export data → link in the e-mail | the `.zip` (or `conversations.json`) |
| Gemini | Google Takeout → only «My Activity», filter «Gemini Apps» (JSON or the default HTML) | the Takeout `.zip` (or `MyActivity.json` / `.html`) |

Upload through `/v1/uploads` as usual (`mime`: `application/zip`, `application/x-zip-compressed`,
`application/json`, `text/html`, `text/plain` or `application/octet-stream`; ≤ 50 MB). A ChatGPT
zip with many pictures can be over 50 MB: then upload `conversations.json` alone (pictures are not
carried anyway). Then:

`POST /v1/imports/ai-chats/file` `{"client_id": "...", "upload_id": "..."}` → `202 {"import": Import,
"created": true}` (same `client_id` again: `200`, `created: false`). Base consents only: the file
is the person's own, like any upload. Errors as for Telegram (`404 upload_not_found`,
`409 upload_not_ready` / `upload_in_use` / `import_running`), and `422 import_not_chats_file`
(wrong file type). Poll `GET /v1/imports/{id}` every 2–3 s.

### Import fields for AI chats

Same `Import` object, `source: "ai_chat_export_file"`, plus:

| Field | Notes |
|---|---|
| `provider` | `chatgpt` · `claude` · `gemini` (known once the file is read; `null` before). |
| `total` / `processed` | Conversations to bring / done: «Перенёс 120 из 312 разговоров». |
| `conversations` | Conversations brought (the number in the summary). |
| `created` | Records made (a long conversation is several records). |
| `skipped_dups` | Exact repeats of a record already here, not brought. |
| `seen_before` | Already brought by an earlier import: re-importing the same export is safe. |
| `skipped_media` | Not carried: `image`, `file`, `audio` (counts). Only text is. |
| `failed` | Conversations that could not be read (the others still are). |
| `summary_ru` | «Принёс 312 разговоров из ChatGPT. Повторов не взял: 3. Старые (40) не перенёс: за раз беру 5 000 самых новых.» |
| `action_id` | «Удалить импорт» = `POST /v1/actions/{action_id}/undo`: every brought record goes to «Удалённые записи» (30 days, restorable). |

`error` codes: `import_bad_file` (broken JSON / zip), `import_no_chats_file` (a zip without
`conversations*.json` or a Gemini activity file), `import_unknown_format` (JSON or HTML, but not a
chats export), `import_too_large` (chats files over 128 MB unpacked, or packed suspiciously
tightly), `import_file_missing`. `POST /v1/imports/{id}/cancel` works the same.

### The records

- One conversation = one record: `kind: "ai_chat"`, `source: "import_ai_chat"`, `title` = the
  chat's title (or its first question), `occurred_at` = when the chat started, `text` compact:
  ```
  Я: Посоветуй кафе в Стамбуле с видом на Босфор

  ChatGPT: Попробуйте кафе «Чайка» у набережной.
  ```
  Only the person's questions and the answers shown: edited/regenerated branches, tool calls,
  hidden context and reasoning are left out; one turn is cut at 6 000 characters (« …»). A chat
  over 30 000 characters is split into parts («Название (часть 2)»), at most 10 per chat.
  Gemini has no conversations in Takeout: turns less than 30 minutes apart make one.
- `source_meta`: `{"tag": "из ChatGPT", "title_source": "import", "import_id": …, "ai_chat":
  {"provider", "provider_name", "conversation_id", "part", "parts", "turns", "updated_at"}}`.
  The app shows `source_meta.tag` as the chip «из ChatGPT / Claude / Gemini».
- **Page: «Заметки», by the page rules** — no new page. «Заметки» takes every record (its rule),
  so the chats land there without the person choosing (Ф-47), and no extra page appears beside the
  default ones (Ф-35). A filter is `GET /v1/search?q=…&kind=ai_chat` or `source_meta.tag`. A page
  «Чаты ИИ» can be added later as a template with rule `{"kinds": ["ai_chat"]}` if the founder
  wants one.
- Search: by words at once (`GET /v1/search`, the assistant's search); by meaning when embeddings
  are on and allowed (`ai_cross_border`), chunked like any long record.
- Limits: at most 5 000 conversations per import, the newest; the older ones are counted in the
  summary (import again later is not a way to get them: the newest are taken again). 128 MB of
  chats JSON/HTML unpacked.
- Repeats: a conversation part already brought (same chat, same text) is never brought again.
  A chat continued since the last export comes as a new record; the repeat scan then proposes
  «Объединить?» with the older one (`origin: "import"`).
- **No model reads them here**: enrichment is not run (`enrich_state: "skipped"`): the export has
  titles already, and reading thousands of chats would cost and could file the assistant's advice
  as the person's tasks or expenses. Memory facts «из материала» from imported chats are
  **deferred**: the background memory reader (`chat:memory`) reads shares only; adding
  `import_ai_chat` there would need a per-day cap of a few chats.
- Privacy: the uploaded file goes to storage purge right after reading (only the text stays);
  links in chats are never opened; chat text is data for a model, never instructions.
- Events: `import_completed` with `method: "ai_chats"`.

## Bank statements

A bank statement PDF is not an import of records: it is a plan of expenses with one «Да» and one
«Отменить», in `expenses.md` (`POST /v1/expenses/statements`, week 13).
