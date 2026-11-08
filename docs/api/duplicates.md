# Repeats API: «Уже было», «Объединить?», «Это разные», «37 → 1» (week 10)

Spec: `docs/spec/final/3-engineering.md` 3.3, 4.6, 6.3; R-25, R-31, R-32. Base path `/v1`. Every
endpoint needs `Authorization: Bearer` and the base consents (`pd_processing` + `terms`), else
`403 consent_required`. Errors: `{code, message_ru, message_kk, details?}`. In the UI the word is
«Повторы» (never «дубли»).

What the person decides:
- **Exact repeat on save** (same normalised text, or the same file bytes): merged at once, with
  «Отменить». No «Да» (founder rule 1). See "On save".
- **Similar records** (a typo, a word more, a line added): only ever **suggested** as a group,
  «Объединить?» → [Да] per group, or several groups at once. Never merged without «Да».
- **Cleanup «37 → 1»**: every exact repeat that piled up before (old records, two phones offline)
  behind **one** «Да», with one «Отменить».
- Nothing is deleted: a repeat is hidden behind the record kept (`hidden_reason:
  "duplicate_merged"`, `canonical_id` = the kept one). Its paragraphs the kept one lacks go into
  the kept one's `merged_fragments` («Было в повторах»); the kept text is not changed. Its
  reminders, stacks and pages move to the kept record. «Отменить» brings all of it back.

## Group

```json
{
  "id": "0194...",
  "kind": "near",
  "status": "suggested",
  "origin": "on_save",
  "keep_item_id": "0193...",
  "keep_rule": "most_complete",
  "member_count": 3,
  "members": [
    {"item_id": "0193...", "role": "keep", "score": null, "title": "Сантехник",
     "preview": "Позвонить в управляющую компанию…", "kind": "note", "source": "typed",
     "occurred_at": "2026-11-07T10:00:00+00:00", "words": 24, "visible": true},
    {"item_id": "0193...", "role": "merge", "score": 0.94, "title": null, "preview": "…",
     "kind": "tg_message", "source": "import_telegram", "occurred_at": "...", "words": 22,
     "visible": true}
  ],
  "action_id": null,
  "seq": 812,
  "created_at": "...",
  "decided_at": null
}
```

| Field | Notes |
|---|---|
| `kind` | `near` (similar) or `exact` (same text). |
| `status` | `suggested` (waits), `merged` («Да»), `dismissed` («Это разные»), `undone` (a merge taken back: not suggested again), `auto_merged` (exact, on save). |
| `origin` | `on_save`, `cleanup` (the plan), `import` (found after a Telegram import). |
| `keep_item_id` | The record kept by default: `keep_rule: most_complete` = more words; equal: the newer one. The person may pick another (`keep_item_id` in merge). Members come keep first. |
| `members[].preview` | First 300 chars of the text; open `GET /v1/items/{id}` for the whole. `words`: what «most complete» counted. `visible=false`: trashed or merged meanwhile. |
| `action_id` | The action that merged / dismissed it («Что я сделал»). |

Groups of similar records are found by a background scan (`python -m assistant.dedup`) a minute
after records are saved, changed or imported (code: SimHash ≤3 bits, trigrams >0.8, meaning ≥0.92;
borderline pairs and pairs that differ in a number — a date, a sum, a code — go to a check by the
light model only with `ai_cross_border`; without it they are not suggested). Records of a «Дела» /
«Покупки» line, КП and texts the assistant wrote are left out. A group keeps its `id` while it
grows; an open group that no longer holds goes away (`GET /v1/duplicates/groups/{id}` → 404).

## `GET /v1/duplicates/groups?status=suggested&kind=&limit=50`

`{"groups": [Group]}`, biggest first. `status`: any of the above (default `suggested`), `kind`:
`near` | `exact` | absent (both). `limit` 1…200. Show the «Объединить?» list from
`status=suggested&kind=near`.

## `GET /v1/duplicates/groups/{id}` → `{"group": Group}`

## `POST /v1/duplicates/groups/{id}/merge`

```json
{"keep_item_id": "0193...", "client_id": "0194..."}
```
Both optional. «Да» on one group. `200`:
`{"group": Group, "action": Action, "repeated": false}`. `action.kind` = `merge_group`,
`summary.ru` «Объединил 3 записи в одну», one `changes` row per hidden record (`kind: "merge"`,
««…» → в «…»»). «Отменить» = `POST /v1/actions/{action.id}/undo`; «Вернуть» one row =
`item_ids`. A repeat (same `client_id`, or a group already merged) returns the first result with
`repeated: true`.

Errors: `404 not_found` · `409 group_closed` (dismissed / undone / merged otherwise) ·
`409 group_stale` (fewer than two records left visible: the group is closed) ·
`422 keep_not_in_group`.

## `POST /v1/duplicates/merge` — «Объединить все отмеченные (N)»

```json
{"client_id": "0194...", "groups": [{"id": "0194..."}, {"id": "0194...", "keep_item_id": "0193..."}]}
```
1…100 distinct groups, each with an optional `keep_item_id`. All in **one** `merge_group` action
with one «Отменить» («Объединил повторы: 2 группы, убрал 3 повтора»). `200`:
`{"groups": [Group], "action": Action | null, "skipped_group_ids": ["..."], "repeated": false}`.
A group closed meanwhile is skipped and listed in `skipped_group_ids` (not an error); if every
one was skipped, `action` is null. `422 keep_not_in_group` fails the whole call. Repeat-safe by
`client_id`.

## `POST /v1/duplicates/groups/{id}/dismiss` — «Это разные»

`{"client_id": "..."}` optional. `200`: `{"group": Group, "action": Action, "repeated": false}`.
`action.kind` = `dismiss_group`, «Оставил 2 записи отдельно — это разные», with «Отменить»: the
group is `suggested` again. While dismissed, these records are never suggested together again.
`409 group_closed` when it is not `suggested`.

## `POST /v1/duplicates/cleanup/plan` — «37 → 1»

`{"client_id": "..."}` optional (a repeat returns the same plan). Builds the plan from what is
there now and also starts a fresh scan for similar ones. `200`:

```json
{
  "pending_action": {"id": "0194...", "kind": "cleanup_batch", "status": "proposed",
    "preview": {"title_ru": "Убрать 38 повторов?",
                "text_ru": "Одинаковых записей: 40. Оставлю по одной — станет 2. Отменить можно в «Что я сделал».",
                "copies": 38, "records_before": 40, "records_after": 2, "groups": 2},
    "expires_at": "...", "message_id": null, "action_id": null, "seq": 1, "created_at": "...",
    "decided_at": null},
  "exact": {"copies": 38, "records_before": 40, "records_after": 2, "groups": 2},
  "exact_groups": [Group],
  "near_groups": [Group],
  "near_total": 4
}
```
- `pending_action` null (and `exact` null) when there is no exact repeat. Show `preview.title_ru`
  and `preview.text_ru` with [Да] [Не сейчас]. A new plan replaces an older open one (that one
  becomes `expired`).
- `exact_groups`: up to 20, for «Показать». The oldest copy is kept (as on save).
- `near_groups`: up to 50 open similar groups (`near_total` all of them), each with its own «Да».
  The fresh scan may add more a minute later.

## Pending «Да»

### `GET /v1/pending-actions` → `{"pending_actions": [PendingAction]}`
Open ones only (`proposed`, not expired), newest first. Same shape as in `/v1/sync`.

### `POST /v1/pending-actions/{id}/confirm`
`{"client_id": "..."}` optional. Today only `cleanup_batch`. Runs it: every group of the plan,
copies still exactly the same; a copy changed or removed since is left alone. `200`:
`{"pending_action": PendingAction (status "executed"), "action": Action | null, "repeated": false}`.
`action.kind` = `cleanup_batch`, «Убрал 38 повторов», one «Отменить» for the whole batch.
A second confirm returns the same with `repeated: true`.
Errors: `404` · `409 pending_closed` (rejected / expired before) · `410 pending_expired`
(24 h passed: «Это предложение уже неактуально» [Сделать заново] = a new plan) ·
`422 pending_kind_unknown`.

### `POST /v1/pending-actions/{id}/reject` — «Не сейчас»
`200 {"pending_action": PendingAction}` (status `rejected`; repeat-safe). `409 pending_closed`
after it was executed or expired.

## On save (exact repeats)

`POST /v1/items` with the same normalised text (`content_hash`, see `items.md`) or the same file
(`original_sha256`) as a visible record: `auto_merged: true` and

```json
"duplicate": {"canonical_id": "0193...", "canonical_created_at": "...",
              "undo_path": "/v1/items/0194.../unmerge", "action_id": "0194..."}
```
Show «Уже было — добавил к записи от 12 мар · Отменить». «Отменить» =
`POST /v1/actions/{action_id}/undo` (or the older `undo_path`: same effect). Both make the record
visible again, mark it never to be auto-merged again, and close the `exact` group as `undone`.
The action (`auto_merge_exact`, `initiated_by: agent`) is in «Что я сделал».

## Actions

| Kind | When | `summary.ru` | «Отменить» |
|---|---|---|---|
| `auto_merge_exact` | exact repeat on save | «Уже было — добавил к записи от 12.03» | visible again |
| `merge_group` | «Да» on one group or several | «Объединил 3 записи в одну» | all records back, reminders/stacks/pages back, group `undone` |
| `dismiss_group` | «Это разные» | «Оставил 2 записи отдельно — это разные» | group `suggested` again |
| `cleanup_batch` | «Да» on the plan | «Убрал 38 повторов» | every copy back |

`changes[].kind` adds `merge` (a record hidden behind another) and `keep_apart`.

## `merged_fragments` (on the kept record, `ItemOut`)

```json
[{"item_id": "0193...", "kind": "note", "source": "typed", "occurred_at": "...",
  "merged_at": "...", "title": "Другой заголовок", "paragraphs": ["P.S. Обсудили вечером."]}]
```
One entry per hidden repeat. `title` only when it differs; `paragraphs` only for lines the kept
text does not have (≤20). Show them in «Было в повторах».
