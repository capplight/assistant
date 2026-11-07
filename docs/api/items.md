# Records: «Верно» and «Исправить» (S09)

Spec: `docs/spec/final/2-design.md` S09, `3-engineering.md` 4, 5.6; R-36. `review_fields` is on every
`ItemOut`, by key: `{"amount_1": {"kind": "amount", "value": "389 990 ₸", "state": "unverified"}}`.
`state: unverified` is «Проверьте».

### `PATCH /v1/items/{id}`

```json
{"corrections": {"amount_1": "389 900 ₸"}, "base_seq": 1234}
```
`corrections`: key -> what the person entered, up to 500 chars, one line. **`base_seq` is required
with it**: the `seq` of the record they looked at. It can go along with `title`, `text`, `verify`.
Returns `ItemOut`; the change also comes through `/v1/sync` (`seq` goes up).

What happens to a corrected field:
- `value` is the new one and `state` is `verified`. When nothing is left `unverified`, `status` goes
  from `needs_review` to `ready`, same as with `verify`.
- The server takes the value as it is. It does not have to appear in the source and is not checked
  for format: a number or date the person enters is theirs. A later reading of the record does not
  bring the old value back or ask about the new one.
- The first place the old value stands as a whole in `text` and the title gets the new one (the title
  only if the person did not name the record). The `content_hash` follows, `summary` becomes `null`,
  and the record is read again, so `enrich_state` goes to `pending` and a later `seq` follows. If the
  old value is not in the text, the text stays as it was.

Errors:
- `409 conflict`, `details.seq`: the record changed since `base_seq`. Sync, show the current value,
  and let the person decide. Resending an already applied correction with its old `base_seq` is not
  a conflict: it returns `200` and the record, so outbox retries are safe.
- `409 item_deleted`.
- `422 review_field_unknown`, `details.field`: no such key on the record any more.
- `422 review_field_not_editable`, `details.field`: `kind: transcript`, a whole passage. Correct it by
  sending `text` and `verify` for that key.
- `422 validation_error`: no `base_seq`, or an empty value.
