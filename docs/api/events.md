# Events API: product analytics journal (week 10)

Spec: `docs/spec/final/3-engineering.md` 3.8 `events`, R-40, F-35; event list:
`docs/spec/final/1-product.md` 7.2. Base path `/v1`. Needs `Authorization: Bearer` and the base
consents.

Our own journal in the KZ database (schema `analytics`); no third-party analytics. Written only
when the person has the `analytics` consent. **Never content**: no record text, names, sums, phone
numbers, file names.

## `POST /v1/events`

```json
{"platform": "android", "app_version": "1.0.3",
 "events": [{"client_id": "0194...", "name": "capture_created",
             "props": {"channel": "voice", "type": "note", "offline_queued": false},
             "client_ts": "2026-11-09T10:00:00+05:00"}]}
```
1…200 events per call. `202 {"accepted": 2, "dropped": 1}`.

- Without the `analytics` consent everything is `dropped` (send nothing then; keep nothing queued).
- `name` must be in the registry (product spec 7.2); unknown names are dropped.
- `props`: only the keys listed for that event in 7.2, plus `lang_ui`, `autonomy_mode`, `profile`,
  `os_version`. A value is a number, `true/false`, a short code `^[A-Za-z0-9_.:-]{1,40}$`, or a list
  of such codes (≤12). Anything else (free text, Cyrillic, spaces, 7+ digits in a row, numbers ≥ 10⁹) is dropped
  silently, key by key.
- `client_id`: one per event; a resent batch is counted once (safe to retry the outbox).
- `client_ts` more than 10 minutes in the future is dropped (the server keeps `received_at`).
- `platform`: `ios` | `android` | `web`.

The person is stored as an HMAC pseudonym (own key), the device likewise. Kept 13 months
[proposal]. Account deletion (week 16) must call `analytics.delete_for_user` (by pseudonym: no foreign key). The server itself writes `duplicate_decided`,
`cleanup_offered`, `cleanup_done`, `stack_opened`, `import_completed` — do not send those twice.
