# «Мои данные»: export, account deletion, web deletion page (week 16)

Spec: `docs/spec/final/3-engineering.md` 3.7 `account_deletions`, 4.9, 7.2; `1-product.md` F-26,
F-27, US-19, US-20; `2-design.md` S24, S32, W-01; `4-business-legal.md` 4.3 (App Store
5.1.1(v)), 4.4 (Google Play web deletion); founder Ф-6 (grace days, open: default 7). Base path
`/v1`. Errors have the usual shape `{code, message_ru, message_kk, details?}`.

These endpoints need only `Authorization: Bearer` — **not** the base consents: a person who
withdrew their consents can still take their data and delete the account.

## Export — «Скачать мои данные» (S24, US-19)

### `POST /v1/export`
`{"client_id": "uuid"}` (optional). Starts building the archive in the background.
`202 {"export": Export}`. While one export is `queued` or `running`, a new call returns that one
(`200`). A repeat `client_id` returns its export.

### `GET /v1/export/{id}` → `{"export": Export}`

```json
{
  "id": "uuid",
  "status": "ready",
  "requested_at": "2026-11-11T10:00:00Z",
  "ready_at": "2026-11-11T10:01:10Z",
  "expires_at": "2026-11-12T10:01:10Z",
  "bytes": 1834221,
  "download_url": "https://api.example/v1/export/uuid/file?token=...",
  "error": null
}
```
- `status`: `queued` → `running` → `ready` | `failed`; `ready` → `expired` after 24 h (the file is
  deleted then; ask again).
- `download_url`: only when `ready`. Works **without** the bearer token until `expires_at` (open
  it in the browser or hand it to the share sheet). After that: `410 export_expired`.
- When it is ready the server sends a push «Архив готов» (no text of the data; data
  `{"type": "export_ready", "export_id": "uuid"}`), never in quiet hours. Poll `GET` while the
  screen is open (every 5 s is fine). S24 shows «Готовлю архив…», then «Скачать (до 12 ноября,
  15:01)».
- `GET /v1/export` → `{"exports": [Export]}`: the last 5, newest first.

### `GET /v1/export/{id}/file?token=…`
The ZIP (`application/zip`, `Content-Disposition: attachment; filename="moi-dannye-2026-11-11.zip"`).
Errors: `404 not_found` (bad token or unknown) · `410 export_expired`.

### What is inside
| File | What |
|---|---|
| `README.txt` | what each file is, in Russian |
| `account.json` | name, language, time zone, country, created, consents given and withdrawn |
| `items.jsonl` | every record (also those in «Удалённые записи», with `deleted_at`): kind, source, title, text, summary, link, dates, what the assistant understood |
| `items/*.md` | the same records as readable text, one file each |
| `pages.json` | pages: name, template, view, fields, own fields, tab order, which records in which order, groups, own field values |
| `reminders.json`, `tasks.json` | reminders (time, repeat, how), to-dos and shopping |
| `expenses.csv` | spending: date, amount, currency, category, where, how paid, note, source (`;`-separated, UTF-8 with BOM for Excel) |
| `documents/*.json`, `documents/*.pdf` | each КП with all versions and totals; PDF of versions that were sent |
| `company.json` | «Моя компания» including БИН/ИИН and bank details (decrypted for you), price lists |
| `conversation.jsonl` | the whole «Переписка» |
| `drafts.json`, `stacks.json`, `habits.json` | drafts of messages, stacks, «Что я для вас настроил» |
| `originals/*` | originals still kept (saved by you, logo, signature, stamp, not yet deleted) |

Not inside: the phone number (the server keeps only a keyed hash of it), technical logs, the
product event journal (it has no content and is not linked to you by name).

## Account deletion (S32, US-20, 5.1.1(v))

One way only: «Удалить аккаунт и все данные». Before it, offer «Скачать мои данные».

### `GET /v1/me/deletion`
What S32 shows:
```json
{"status": "active", "needs_sms": true, "grace_days": 7,
 "delete_after": null,
 "points_ru": ["Вход закроется сразу.",
               "7 дней можно передумать — войдите по SMS.",
               "Потом удалю всё за сутки.",
               "Копии на резервных серверах исчезнут не позже 30 дней.",
               "Через поддержку вернуть нельзя."]}
```
`needs_sms`: the account has a phone (confirm by SMS); `false` = anonymous (confirm by the button
«Да, удалить всё»; the second point is then «7 дней можно передумать — откройте приложение.»).
With `grace_days: 0` the points say «Удалю всё за сутки. Отменить будет нельзя.»

### `POST /v1/me/deletion/otp` (accounts with a phone)
`{"phone": "+7 701 123 45 67"}` — the account's own number (the phone app remembers it from S04b;
otherwise the person types it). Sends the SMS code. `200 {"challenge_id", "expires_at",
"dev_code"}` (as `POST /auth/otp/request`). Errors: `422 phone_mismatch` (not this account's
number) · `422 validation_error` (anonymous account: use the button) · `422 phone_unsupported` · `429 otp_rate_limited` · `502 sms_failed`.

### `POST /v1/me/deletion`
- with a phone: `{"challenge_id": "uuid", "code": "123456"}`
- anonymous: `{"confirm": true}`

`202`:
```json
{"status": "deletion_pending", "requested_at": "2026-11-11T10:00:00Z",
 "delete_after": "2026-11-18T10:00:00Z", "grace_days": 7,
 "message_ru": "Аккаунт удаляется. До 18 ноября можно передумать: войдите по SMS."}
```
At once: sign-in is closed, **all sessions of the account are revoked** (this token stops working
too), push tokens are dropped, a Telegram import session is destroyed. The phone should then
cancel its local alarms, clear its local copy and show the message. After `delete_after` the
server deletes everything within 24 h (`account:purge`): every record, file in storage, page,
spending, КП, company profile, «Переписка», reminders, analytics events, tokens. Backups expire
within 30 days. The AI cost journal keeps only amounts without the person (`user_id` cleared).

Errors: `400 otp_invalid` / `otp_expired` · `422 validation_error` (`confirm` on an account with a
phone, or a code on an anonymous one).

### Signing in while the account is being deleted
`POST /auth/anonymous` (same device key) and `POST /auth/otp/verify` (the account's phone) answer
`403 account_deletion_pending`:
```json
{"code": "account_deletion_pending", "message_ru": "Аккаунт удаляется. Восстановить?",
 "details": {"delete_after": "2026-11-18T10:00:00Z", "restore_token": "…",
             "restore_expires_at": "2026-11-11T10:15:00Z"}}
```
Show «Аккаунт удаляется. Восстановить?» [Восстановить] [Нет].

### `POST /v1/me/deletion/cancel`
No bearer: `{"restore_token": "…"}` → `200` `TokenPair` (as `/auth/anonymous`), the account is
active again with all its data; nothing was deleted. Errors: `400 restore_invalid` (unknown or
older than 15 min: sign in again) · `410 deletion_done` (the time is over).

## Web deletion page W-01 (Google Play)

Server-rendered HTML, no scripts. Root path (not `/v1`): **`/account/delete`**, `?lang=kk` for
Kazakh (link on the page).

1. `GET /account/delete` — what will happen (the same points as S32), the phone field, «Получить
   SMS-код». Line: «Если вы не указывали номер, удалить можно только в приложении: Настройки →
   Удалить аккаунт».
2. `POST /account/delete/otp` (form `phone`, `lang`) — sends the code if the number belongs to an
   account (the page looks the same either way: «Если этот номер есть в приложении, мы прислали
   SMS»), then the code field and the button «Удалить аккаунт и все данные».
3. `POST /account/delete/confirm` (form `phone`, `challenge_id`, `code`, `lang`) — the request is
   made exactly as from the app (`via: web`): «Запрос принят. Вход закрыт. До 18 ноября можно
   передумать: войдите в приложение по номеру.»

Limits: 3 SMS an hour per number, 5 code requests an hour per IP (`WEB_DELETE_IP_PER_HOUR`), a
hidden field for bots. A wrong code shows the code form again with «Код не подошёл».
