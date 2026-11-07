# Auth, phone linking, consent after sign-in

Spec: `docs/spec/final/3-engineering.md` 3.2, 4, 7.5; R-03, R-04, R-08. Base path `/v1`.
Errors have the usual shape `{code, message_ru, message_kk, details?}`.

## Tokens

- `POST /auth/anonymous {device_key, locale, tz}`: account of this device key (`created: true` when
  new). The same key always means the same account.
- `POST /auth/refresh {refresh_token}`: new pair; the old refresh token dies at once. Send one
  refresh at a time: re-sending a used token counts as theft and revokes the sessions.
- `POST /auth/logout`.
- Every pair carries `user`: `{id, display_name, locale, tz, country, is_anonymous, age_confirmed}`.
  `is_anonymous: false` means a verified phone is linked. Keep the last value you saw.

## A rejected refresh

`401 invalid_refresh`, `details.account_linked`:

| `account_linked` | Meaning | What the phone does |
|---|---|---|
| `true` | The token's account has a verified phone | Phone sign-in. Do **not** call `/auth/anonymous`: after an account switch the device key belongs to a different, empty account |
| `false` | The token's account is anonymous | `POST /auth/anonymous` with the device key: same account |
| `null` | The server does not know this token | Use the stored `is_anonymous`; nothing stored: `/auth/anonymous` |

During phone sign-in, send **no `Authorization` header**: an expired or revoked token gets
`401 unauthorized` from `/auth/otp/*`. (A header is checked, not ignored, so that an expired token
cannot turn "link to my account" into "make a new account". While signed in: refresh first.)

`403 account_blocked` from refresh is a different case: the account is being deleted.

## Phone

- `POST /auth/otp/request {phone, purpose?}` → `{challenge_id, expires_at, dev_code?}`.
- `POST /auth/otp/verify {challenge_id, phone, code}` → the pair plus:

```json
{"account_switched": true, "app_enabled": false, "ai_enabled": false}
```

| Caller | Phone | Tokens are for | `account_switched` |
|---|---|---|---|
| signed in | new | the caller's account, now linked | `false` |
| signed in | caller's own | the caller's account | `false` |
| signed in | belongs to another account | that other account | `true` |
| no header | known | its account | `false` |
| no header | new | a new, empty account | `false` |

`app_enabled` (`pd_processing` + `terms`) and `ai_enabled` (those + `ai_cross_border`) are the
consents of **the account the tokens are for**, the same values as `GET /v1/consents`. Use them, not
`account_switched`, to decide about S05: the last two rows of the table are also accounts that may
have no consent.

## Consent on another account

Consents stay with the account that gave them. Nothing is copied on a switch, and the anonymous
account's records stay on it (merging, spec 4 and 7.5, is not built: see "Open").

After `otp/verify`:

1. `app_enabled: false`: show S05 before anything else. Send `POST /v1/consents` only after the
   person accepts there. Never resend what was accepted on the previous account.
2. Until then every other endpoint gives `403 consent_required`, `details.missing`. Hold the outbox;
   a 403 here is not a failure of the queued entry.
3. `app_enabled: true, ai_enabled: false`: that account chose «Без ИИ»; it stays so. AI is off.
4. Replace what the phone remembers about consent, `user`, and the sync cursor: it is a different
   account. Call `POST /v1/devices` again: a switch gives a session with no device.

The server enforces this with no help from the phone: consent checks read the rows of the token's
account (`api/consent_gate.py`, router, ingest, enrichment). Without `ai_cross_border` on it, voice
stays `needs_consent`, records get `enrich_state: no_consent`, no job is queued and no provider is
called. A grant then queues what waited.

## Name (S04b)

- `GET /v1/me` → `user` object.
- `PATCH /v1/me {"display_name": "Али"}` → `user` object. Up to 100 chars, trimmed, one line. `null`
  or blank clears it («Добрый день», R-37). Leaving the field out changes nothing.

Both need the base consents. Other `/me` settings in the spec (language, tz, quiet hours...) come
with their features.

After a sign-in the server's name wins: it is in `user`. Send the name only when the person entered
it, so that a name typed on one account does not land on another.

## Open

| What | State |
|---|---|
| Merging an anonymous account into the phone's account (spec: data and consents move) | Not built. The switch leaves the records on the anonymous account |
| `/auth/anonymous` on a linked account | Still returns tokens by device key alone, without SMS. Awaits a founder decision |
