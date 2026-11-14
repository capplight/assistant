# Search API, page summaries, originals (week 4)

Spec: `docs/spec/final/3-engineering.md` 3.3, 3.10, 4.3, 4.4, 6.9, 7.1, 7.2; F-07, US-5. Base path
`/v1`. All endpoints need `Authorization: Bearer` and the base consents (`pd_processing` + `terms`);
otherwise `403 consent_required`. Errors have the usual shape `{code, message_ru, message_kk, details?}`.

The search makes no AI provider calls and sends nothing abroad, so it works in «Без ИИ» mode.

## Search

### `GET /v1/search`

| Param | Type | Notes |
|---|---|---|
| `q` | string, 1...200 chars | Required. A word, a phrase or a whole question. |
| `page_id` | uuid | «Найти на странице»: only this page. Unknown or removed page: `404 not_found`. |
| `kind` | string | `note`, `voice`, `image`, `screenshot`, `pdf`, `docx`, `xlsx`, `link`, `email`, `tg_message`, `kp`, `file_other`. Anything else: `422 validation_error`. |
| `from`, `to` | ISO 8601 date-time | Bounds on the record's date, inclusive. No offset means UTC. |
| `limit` | 1...50, default 20 | No pagination: this is a ranked list. |

```json
{
  "results": [
    {
      "item_id": "0190b1c2-...",
      "kind": "note",
      "status": "ready",
      "title": "Размер обуви сына",
      "snippet": "…купила кроссовки, размер обуви сына 34, в следующий раз…",
      "highlights": [[17, 23], [24, 29]],
      "occurred_at": "2026-11-02T08:15:00Z",
      "created_at": "2026-11-02T08:15:03Z",
      "ai_label": null,
      "pages": [{"id": "0190...", "title": "Заметки", "icon": "documents"}],
      "matched_by": ["words", "meaning"]
    }
  ],
  "semantic": true,
  "answer": {"value": "4512", "item_id": "0190b1c2-...", "title": "Домофон",
             "context": "Код домофона 4512, подъезд 3",
             "pages": [{"id": "0190...", "title": "Заметки", "icon": "documents"}],
             "occurred_at": "2026-03-02T08:15:00Z"}
}
```

- `results`: best first. Empty means «Не нашёл»: nothing is ever made up to fill the list.
- `item_id`: open it with `GET /v1/items/{id}`. The hit has no full text on purpose.
- `snippet`: plain text, up to about 200 characters. Show it as text, never as markup.
- `highlights`: `[start, end)` offsets inside `snippet`, in UTF-16 code units, so JS `slice` works.
  May be empty (a match by meaning has no words to mark).
- `ai_label`: when set, show it as the label next to the title or summary (R-06).
- `pages`: live, visible pages this record is on. May be empty.
- `matched_by`, in any order: `words` (the words or their forms), `typo` (a close spelling),
  `meaning` (by meaning only). Use it to split «Нашёл» from «Нашёл ещё» (US-5): a hit whose only
  value is `meaning` belongs under «Нашёл ещё».
- `answer` (week 20, Ф-50 «ответ значением»): when the question asks for a value («код от
  домофона», «номер окулиста», «размер обуви сына», «пароль от вайфая», «день рождения мамы»)
  and one of the first 3 hits matched by words has a value written next to the words asked about
  (same line, ≤60 chars): `value` as written in the record, its source `item_id` (also in
  `results`), `context` (the record's line). Show `value` big with «Скопировать» and «Источник:
  {pages[0].title} · {date}», `results` under «Ещё нашлось». Code only, no model; `null` = show the
  list as before.
- `semantic`: `false` means the search by meaning did not run this time (service down or slow; the
  answer is words and typos only, spec 8.1). Not an error. Nothing to show the person.

**What can be found:** title, summary, text, a file's caption. A record is found as soon as it has
text, whatever its status, including `needs_review`.
**What is never found:** records in the trash, merged duplicates, hidden voice fragments (the
recording is found through its one visible record), another person's records, and a record the
person took off a page when searching that page.

**Spelling:** case, `ё`/`е` and Kazakh letters typed as Russian ones (`қала` = `кала`, `өнер` = `онер`,
`і` = `и`) are the same letter. Word forms are matched for Russian (`молоком` finds `молоко`); for
Kazakh and other languages a word's beginning is matched (`қала` finds `қалада`). Typos are matched
by similar spelling against the words in the person's own records, vowels that sound alike counted as
one letter (`малако` finds `молоко`). Latin and Cyrillic spellings come close (`Kaspi` finds `Каспи`).

The phone keeps its own local search (FTS5) for instant results and offline; call this endpoint
when online and merge by `item_id`.

Later: `collection_id` (spec 4.4) comes with collections.

## Page summary

### `GET /v1/pages/{id}/summary`

```json
{
  "page_id": "0190...",
  "item_count": 42,
  "last_titles": ["Чек Magnum", "Лекарства маме"],
  "aggregates": {},
  "seq": 1234,
  "updated_at": "2026-11-02T08:15:03Z"
}
```

A cache, counted by code without any model. `item_count` counts what the page shows: no trashed or
merged records, none the person took off the page. `last_titles`: up to 5, newest first, the record's
title or the start of its text. Unknown or removed page: `404 not_found`.

`aggregates` is `{}` for now. It fills in when expenses and tasks arrive (spec 3.10); keys will be
added then. Do not rely on any key yet.

### In `GET /v1/sync`

`/v1/sync` gains a list `screen_summaries` with the same objects. Changes arrive as often as a page's
count or last titles change; `next_since` moves past them as with any other row. A summary is gone
with its page: when a `screen` tombstone arrives, drop its summary too (summaries have no tombstones
of their own).

## Trash

No change to the endpoints: `DELETE /v1/items/{id}`, `POST /v1/items/{id}/restore`,
`GET /v1/items/trash`. 30 days after deletion a record is gone for good: it reaches the phone as a
tombstone (`entity: "item"`), and tombstones of its page links (`entity: "screen_item"`) come along.
Merged duplicates of that record are removed with it; a phone may get tombstones for rows it never
showed. Drop what you have, ignore the rest.

An original no record ever took (uploaded, then no `POST /items`) goes to the file trash after 7 days.
Tombstones are kept without a limit for now, so a phone offline for months still learns what is gone.

## Originals: «Сохранить оригинал»

A file's `state` in `item.files[]` is `active`, `trash` (`trash_until`: «Оригинал удалю через N дн.»),
`pinned`, or `purged` (the object is gone; the text stays).

### `POST /v1/items/{id}/original/pin`
Keep the original. Also brings it back from `trash`. Idempotent. Returns the file object.
`404 not_found`: no such record, or it has no original. `409 original_purged`: too late.
`403 pin_disabled`: the feature is switched off (`storage.pin_enabled`).

### `DELETE /v1/items/{id}/original/pin`
Stop keeping it. It goes to the 7-day trash, unless the text is still unconfirmed, then it stays
`active` (`keep_while_unsure`). Idempotent. Returns the file object.
`409 original_system`: a logo, template, signature or stamp, kept always.

`GET /v1/items/{id}/original` (spec 4.3) is not there yet: it needs presigned GET and `audit_log`.
