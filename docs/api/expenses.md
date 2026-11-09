# «Расходы»: траты, категории, итоги (week 12, «Расходы 1»)

Spec: `docs/spec/final/3-engineering.md` 3.12, 4.11, 6.13; `docs/spec/proposals/template-screens.md`
§2.2 (калькулятор трат), §4; product F-40, US-31, R-36, R-59; founder decisions (8 categories).
Base path `/v1`. Every endpoint needs `Authorization: Bearer` and the base consents (`pd_processing`
+ `terms`), else `403 consent_required`. Errors: `{code, message_ru, message_kk, details?}`.
Timestamps: ISO 8601 with offset, UTC on output. Dates (`spent_on`, `from`, `to`): `YYYY-MM-DD` on
the person's clock (`users.tz`, Almaty by default).

**Money is text.** Every amount is a decimal string with two places, dot separator, no grouping:
`"5000.00"`, `"1550.50"`. Never parse it into a float. The phone formats it («5 000 ₸»).

**Totals are computed by code only** (R-59): `GET /v1/expenses/aggregate` on the server, the TS port
of `expenses/calc.py` on the phone (offline). Both follow `docs/spec/vectors/calc.json` byte for byte:
`Decimal`, `ROUND_HALF_UP` to 0.01, per currency, no conversion.

Every change is an **action** (`actions.md`) with one «Отменить»: the response carries it,
`/v1/sync` brings it, «Что я сделал» lists it. The phone never computes an undo itself. Every
write takes a `client_id` (outbox-safe): a repeat returns the first result with `repeated: true`.

## Expense

```json
{
  "id": "0194...", "client_id": "5f0c...", "item_id": "0194...",
  "amount": "1550.00", "currency": "KZT", "expression": "1200+350",
  "spent_on": "2026-11-09", "spent_at": null,
  "category_id": "0194...", "category_key": "groceries",
  "payee": null, "method": "kaspi", "direction": "expense",
  "note": "Магнум",
  "source": "form", "parse_source": null,
  "review_fields": [],
  "ai_generated": false,
  "version": 1, "seq": 1201,
  "created_at": "...", "updated_at": "...", "deleted_at": null
}
```

| Field | Notes |
|---|---|
| `amount` | > 0, at most `999999999999.99`. What the totals add. |
| `currency` | ISO 4217, 3 letters. `KZT` by default; `USD`, `RUB`, `EUR`, `KGS`… are kept as said, never converted. |
| `expression` | What was typed on the keys («1200+350»), or null. Only `+` and `−`. `amount` is what code computed from it; shown in S09 «из чего сложилось». |
| `spent_on` | The day of the expense on the person's clock. Periods and «Итого за день» use it. |
| `category_id` / `category_key` | The person's category (see below), or null («без категории», counted in totals). `category_key` is the system key, or `own_<12 hex>` for an own category (icons). |
| `payee` | Where («Магнум»), or null. |
| `method` | `cash` · `card` · `kaspi` · `transfer` · `other` · null. |
| `direction` | `expense` (default) · `refund` (subtracted from the total) · `income` (own line, not in the spend) · `transfer_own` (between own accounts: not in any total). |
| `note` | What it was on, in the person's words («бензин»), ≤200, or null. Line title in the feed: `note` → `payee` → category title. |
| `source` | `form` (keys / form) · `typed` (a typed phrase) · `voice` · later `receipt_ocr`, `receipt_qr`, `shared_receipt`, `statement_pdf`, `pasted_text`. |
| `parse_source` | Who read a phrase: `rules` (code, only with Ф-1 on) · `llm` (the model, amount checked by code) · `user_edit` (the person changed the amount) · null (keys / form). |
| `review_fields` | Fields to show with «Проверьте» (R-36). `["amount"]` whenever `source` is not `form` / `typed`; cleared only by «Верно» (`PATCH {confirm: ["amount"]}`) or by the person editing the amount. |
| `deleted_at` | Set when the expense went to the trash (its record too). Hide it; it is in no total. |
| `version` | Pass back in PATCH (`409 conflict` when stale). |

Each expense has its own record (`item_id`, kind `note`, text = the person's phrase, or
«Бензин — 5 000 ₸» for keys / form), so it shows on the «Расходы» page as a usual row, is found by
search and goes to the trash with «Отменить». Show an expense only while its record is live
(`items[].deleted_at` null).

### Where an expense shows

- On the page «Расходы» (`template_key: "expenses"`, layout `builtin:expenses`). Rows are the usual
  `screen_items`; the feed groups them by `spent_on` (newest day first). Inside a day the person may
  reorder rows (the page's own row moves, `pages.md`); moving to another day = changing `spent_on`.
- `GET /v1/pages/{id}/items` on «Расходы» adds `entries[].expense` (Expense or null) and fills
  `fields`: `amount` (decimal string), `date` (= `spent_on`), `category` (title), `merchant`
  (`payee` or `note`), `method`.
- With no «Расходы» page an expense is still saved (search, «Заметки»); no page is made for it.

## Categories

Eight system categories (founder decision; no «Ещё» layer), in this default order, plus the hidden
service category «Переводы»:

| key | title | icon |
|---|---|---|
| `groceries` | Продукты | `cart` |
| `home` | Дом и ремонт | `home` |
| `transport` | Транспорт | `car` |
| `health` | Здоровье | `health` |
| `family` | Дети и семья | `family` |
| `cafe_gifts` | Кафе и подарки | `gift` |
| `utilities` | Коммуналка и связь | `bolt` |
| `other` | Другое | `dots` |
| `transfers` | Переводы (`service: true`: not a chip, its expenses are in no total) | `transfer` |

Each person gets their own copy of these rows on first use, so the order, pins, names and hiding
are theirs. Own categories (S38 «Настроить страницу») come after the eight.

```json
{
  "id": "0194...", "client_id": null, "key": "transport",
  "title": "Транспорт", "title_kk": "Көлік", "icon": "car",
  "system": true, "service": false,
  "position": "a0", "manual": false, "pinned": false,
  "hidden": false, "hidden_at": null,
  "version": 1, "seq": 1190, "updated_at": "..."
}
```

**Order of the chips** (the same rule on the phone, offline):
1. If any of the person's categories has `manual: true`, the person ordered them by hand: sort by
   `position` (byte order of the string). The assistant never changes this order without «Да».
2. Else by frequency: live expenses of the last 90 days per category, most first; ties by
   `position`. Own categories always after the eight system ones.
3. Hidden (`hidden: true`) and service (`service: true`) are not chips. More than 10 chips: the rest
   under «Ещё ›».

### `GET /v1/expense-categories` → `200 {order, categories}`

`order`: `manual` | `frequency`. `categories`: all of the person's categories in chip order, then
hidden, then service.

### `POST /v1/expense-categories` → `201 {category, action, repeated}`

`{"client_id": "...", "title": "Одежда", "icon": null}`. Title 1–40, unique among the person's live
categories (`409 category_exists`). Goes after the last chip. «Отменить» hides it (its expenses stay,
with no category shown). `action.kind` `user_edit`. Errors: `409 category_exists`, `422
validation_error`, `422 too_many` (at most 30 own).

### `PATCH /v1/expense-categories/{id}` → `200 {category, action, repeated}`

`{"client_id": "...", "version": 1, "title"?: "...", "icon"?: "...", "hidden"?: true, "pinned"?: true}`.
A reorder bumps every category's `version`: send the one you last got.
`other` and `transfers` cannot be hidden (`422 validation_error`). Errors: `404`, `409 conflict`
(`details.version`), `409 category_exists`.

### `PATCH /v1/expense-categories/reorder` → `200 {categories, action, repeated}`

`{"client_id": "...", "ids": ["<id>", "..."]}`: the chips in the person's new order (S38 ↑ ↓). Ids
not listed keep their relative order after the listed ones. Sets `manual: true` on every category
(from now on the order is the person's). «Отменить» restores the previous positions and the
frequency order if that was in force. `action.kind` `user_edit`.

## Writing an expense

### `POST /v1/expenses` → `201 {expense, action, page_patches, repeated}`

```json
{"client_id": "5f0c...", "expression": "1200+350", "amount": null, "currency": "KZT",
 "spent_on": "2026-11-09", "category_id": "0194...", "note": null, "payee": null,
 "method": null, "direction": "expense", "source": "form"}
```

- `expression` (keys) **or** `amount` (decimal string). With `expression`, code evaluates it (only
  digits, `,`/`.` decimals, `+`, `-`/`−`; never `eval`); with both, they must agree (`422
  amount_mismatch`). Result ≤ 0 → `422 amount_not_positive`; unreadable → `422 expression_invalid`;
  too big → `422 amount_too_large`.
- `spent_on` default: today on the person's clock. `currency` default `KZT`.
- `source`: `form` (default) or `typed`. A phrase from the line uses `/v1/chat/messages`.
- «Отменить» = the expense and its record go to the trash. `action.kind` `create_expense`,
  `summary.ru` «Записал 1 550 ₸ · Продукты».
- Repeat with the same `client_id` → `200`, the first expense and action, `repeated: true`.

### `PATCH /v1/expenses/{id}` → `200 {expense, action, repeated}`

`{"client_id": "...", "version": 1, ...any of amount | expression, currency, spent_on, category_id,
note, payee, method, direction, "confirm": ["amount"]}`. `confirm: ["amount"]` = «Верно» (clears
«Проверьте» without changing the value). Changing the amount by hand clears «Проверьте» too and sets
`parse_source: user_edit`. `action.kind` `edit_expense`; «Отменить» puts the old values back (a
field changed again since keeps the person's version: `partial`). `client_id` optional but the
outbox should send it: a repeat returns the first action. Errors: `404 not_found`, `409 conflict`
(`details.version`), `422 …` as in POST.

### `DELETE /v1/expenses/{id}?client_id=` → `200 {expense, action, repeated}`

To the trash with its record. `action.kind` `delete_item`, «Отменить» brings both back.

### `GET /v1/expenses?from=&to=&category_id=&limit=&before=` → `200 {expenses, next_before}`

Live expenses, newest `spent_on` first (then newest created). `limit` 1–500 (200). `before`: the
`id` of the last one seen (paging).

### `POST /v1/expenses/parse` → `200 {status, source, parser, draft, message}`

A phrase → a draft for the form, **nothing saved** («как понял»). `{"text": "потратил 5000 на
бензин", "input_kind": "typed"}`.

- Default (Ф-1 open, `expenses_rules_first` off): the light model reads the phrase, behind the
  consent gate (needs `ai_cross_border`). Code checks the reading: the amount must be one of the
  amounts code finds in the person's own words (digits or number words, RU/KK), else no draft; the
  note's words must be in the phrase; the day becomes a date by code, only when the phrase names it.
- With Ф-1 (`expenses_rules_first` on) code reads the phrase first (the same parser and vectors as
  the phone, `docs/spec/vectors/amounts.json`); what code does not read goes to the model.
- `status: "form"` (no consent, no network, not understood): show the empty form with
  `message` («Не понял сумму — наберите её на клавишах.»).

```json
{"status": "ok", "source": "llm", "parser": "llm",
 "draft": {"amount": "5000.00", "currency": "KZT", "spent_on": "2026-11-09",
           "category_id": "0194...", "category_key": "transport", "method": null,
           "direction": "expense", "note": "бензин", "payee": null,
           "review_fields": []},
 "message": null}
```

`review_fields` is `["amount"]` for `input_kind: voice`.

### From the line (`/v1/chat/messages`)

«потратил 5000 на бензин» (any page), or a bare «5000 бензин» on «Расходы», is saved at once (one
action, «Отменить»), read the same way as `/expenses/parse`. The SSE `action` event carries
`expenses: [Expense]`; `page_patch` updates the «Расходы» page. Voice → `review_fields:
["amount"]`. Not understood → saved as a plain note, as before.

A question («сколько ушло на бензин в этом месяце?») is answered with the `aggregate` tool: code
computes the numbers (same `calc.py`), and only numbers code computed or found in records pass the
number check. The model never adds anything up.

## Totals

### `GET /v1/expenses/aggregate` → `200`

Query: `period` = `week` (Mon–Sun) | `month` (default) | `year` | `all` | `custom` (needs `from`,
`to`, inclusive); `date` = a day inside the period (default today); `group_by` = `category` |
`month` | `payee` | `method` (optional); `currency` (optional: only that one); `category_id`
(optional: only that category).

```json
{
  "calc_version": "calc.v1",
  "period": {"kind": "month", "from": "2026-11-01", "to": "2026-11-30"},
  "group_by": "category",
  "totals": [
    {"currency": "KZT", "total": "214600.00", "expense": "216000.00", "refund": "1400.00",
     "income": "0.00", "count": 23}
  ],
  "groups": [
    {"key": "0194...", "title": "Дом и ремонт", "currency": "KZT", "total": "186400.00",
     "count": 4}
  ],
  "review_count": 2,
  "basis_ids": ["0194...", "..."]
}
```

- `totals`: one row per currency (KZT first, then by code). `total` = `expense` − `refund`;
  `income` is its own line; `transfer_own` and category «Переводы» are in nothing; trashed
  expenses are in nothing. `count` = expenses + refunds counted. Empty period → `totals: []`
  (show «0 ₸ · Пока трат нет»).
- `groups`: per (`key`, currency), biggest `total` first. `key`: category id (null = no category),
  `YYYY-MM`, the payee text (null = none), the method (null = none).
- `review_count`: how many of the counted ones still have «Проверьте» («⚠ 2 проверить»).
- `basis_ids`: the expenses counted (S09 «из чего сложилось»), at most 1000.

## Sync

`/v1/sync` adds two arrays, rows in `seq` order like the rest:

- `expenses`: Expense (including trashed ones, `deleted_at` set).
- `expense_categories`: Category.

A record purged after 30 days in the trash takes its expense with it: tombstone `entity: "expense"`.
Categories are hidden, never deleted (no tombstone). `tombstones[].entity` can now also be `task`
(that value was missing from the response schema before week 12).

## Shared vectors

- `docs/spec/vectors/amounts.json`: phrase → amount, currency, and (where the phrase says it) day,
  method, category, direction. The server's `assistant.expenses.amounts` / `parse.rules_parse` and
  the phone's port run the same file. `expect: null` = code must not guess (hand over to the model
  or the form). The vectors are synthetic (written by the team, not real people's phrases).
- `docs/spec/vectors/calc.json`: keypad expressions and aggregate cases for `calc.py` and its TS
  port.
