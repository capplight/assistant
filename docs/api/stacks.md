# Stacks API: groups inside pages (week 10)

Spec: `docs/spec/final/3-engineering.md` 3.3 `collections`, 4.6, 6.4; R-25, R-31, F-09 (changed).
Base path `/v1`. Needs `Authorization: Bearer` and the base consents. Errors as usual.

A **stack** is a group of records with one thing in common (a topic, a client, receipts, documents),
made by the assistant. It is shown **as a group inside a page**, not as a page of its own:

- Its page (`page_id`): «Заметки» if the person has it, else the page holding most of its records.
- On that page its rows have `link.group_key` = the stack's `title`, and the title is in the page's
  `view_state.groups` — the same shape «Разложи по темам» writes (`pages.md`). So the page shows
  the group from what `/v1/sync` (or `GET /v1/pages/{id}/items`) already brings; `/v1/collections`
  adds the name, icon, count and «Отменить».
- Rows the person placed by hand, rows already in another group, pinned rows and rows removed from
  the page are never put into a stack's group (R-54).

When stacks appear: a stack shows up when at least 5 records share a key, unless it would be more
than 80% the same records as a live stack; at most 3 new stacks at a time. It appears at once with
«Отменить» (`create_stack`, `initiated_by: agent`, in «Сегодня» → «Я сделал за вас»). New records
with the key join it later by themselves (no action). A record the person took out of a stack never
comes back into it; a stack the person removed is not made again. A stack nobody opened for 30 days
is hidden (`hidden_at`), nothing else changes; opening it shows it again.

The name: the light model writes it (needs `ai_cross_border`; Ф-1 is open, so naming by code is off:
`STACKS_NAMES_BY_CODE`). Without consent no new stack appears.

## Stack

```json
{"id": "0194...", "kind": "smart", "title": "Ремонт дома", "title_kk": null, "icon": "home",
 "page_id": "0194...", "group_key": "Ремонт дома", "item_count": 6, "created_by": "agent",
 "action_id": "0194...", "hidden_at": null, "last_opened_at": null, "seq": 900,
 "created_at": "...", "updated_at": "..."}
```
`group_key` = `title`: the `link.group_key` of its rows on `page_id` (it follows a rename).
`page_id` null: no page shows it (only this list). `icon`: the page icons (`pages.md`).
`item_count`: visible records in it.

## `GET /v1/collections?page_id=&include_hidden=false&limit=100`
`{"collections": [Stack]}`, biggest first. `page_id`: only the stacks shown on that page.

## `GET /v1/collections/{id}`
Opens it (marks `last_opened_at`, un-hides it). `{"collection": Stack, "items": [{"item_id",
"title", "preview", "added_by": "agent" | "user", "occurred_at"}]}`, newest first.

## `PATCH /v1/collections/{id}`
`{"title": "Дача", "icon": "home", "hidden": true}`, all optional (`title` 1…40). Returns
`{"collection": Stack, "action": Action | null}` (`user_edit`, «Переименовал стопку в «Дача»» /
«Скрыл стопку»; «Отменить» = old name, icon, hidden). A rename also renames the group on its page.
`422 validation_error` for an unknown icon.

## `POST /v1/collections/{id}/items` `{"item_id": "..."}`
`201 {"collection": Stack, "action": Action}` (`stack_add`, «Добавил в стопку «…»»). The record's
free row on the stack's page joins the group. `409 item_deleted`.

## `DELETE /v1/collections/{id}/items/{item_id}`
«Убрать из стопки»: `{"collection": Stack, "action": Action}` (`stack_remove`). The row leaves the
group (stays on the page). The record never comes back into this stack by itself; «Отменить» puts it
back. `404 not_found` when it is not in the stack.

## `DELETE /v1/collections/{id}`
«Удалить стопку»: `{"collection": Stack, "action": Action}` (`delete_stack`, «Убрал стопку «…».
Записи остались»). Records stay where they are, out of the group. «Отменить» brings the stack and
its group back.

All four take the per-person lock like page moves; each action is undone with
`POST /v1/actions/{id}/undo` (`actions.md`).
