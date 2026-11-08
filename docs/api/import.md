# Import API: Telegram «Избранное» from an export file (week 10)

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
