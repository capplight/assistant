# «Расходы»: траты, категории, итоги, чеки, выписки (weeks 12–13, «Расходы 1–2»)

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
  "line_items": null, "statement_id": null,
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
| `source` | `form` (keys / form) · `typed` (a typed phrase) · `voice` · `receipt_ocr` (photo / screenshot of a receipt) · `receipt_qr` (fiscal QR) · `shared_receipt` (a Kaspi / bank receipt shared as PDF or picture) · `statement_pdf` (a row of a bank statement) · later `pasted_text`. |
| `parse_source` | Who read a phrase: `rules` (code, only with Ф-1 on) · `llm` (the model, amount checked by code) · `user_edit` (the person changed the amount) · null (keys / form). |
| `review_fields` | Fields to show with «Проверьте» (R-36): `amount`, `spent_on`, `payee`, `line_items`. `["amount"]` whenever `source` is not `form` / `typed`, with one exception (week 13): a row of a bank statement read by its bank's template **and** whose totals matched the bank's own summary to the tiyn has `[]`. A field is cleared only by «Верно» (`PATCH {confirm: ["amount", "spent_on", …]}`) or by the person editing it. |
| `line_items` | Receipt lines `[{"name": "Молоко 2,5%", "qty": "2", "total": "1100.00"}]` (receipts only), or null. Each `total` was found by code in the receipt text; when the lines do not add up to `amount`, `line_items` is in `review_fields`. |
| `statement_id` | The statement import this row came from, or null. |
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
note, payee, method, direction, "confirm": ["amount"]}`. `confirm` takes any of `amount`, `spent_on`, `payee`, `line_items` (week 13). `confirm: ["amount"]` = «Верно» (clears
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

---

# Week 13 («Расходы 2»): чек, QR, квитанция, выписка, повторы трат

Spec: 3-engineering 3.12 (`statement_imports`), 4.11, 5.7 п. 7, 6.13; §11.2 week 13. All test data
is synthetic: no real bank data anywhere in the repo.

**Who reads what.**

| Input | Read by | Without the model (`ai_cross_border` missing, or provider down) |
|---|---|---|
| Photo / screenshot of a receipt | OCR (ingest, on our server) → the light model (`expense_extract`) → **code checks every number against the OCR text** | `status: "form"` (the empty form); with Ф-1 on, code reads «ИТОГО … 12 400,00» itself |
| Kaspi / bank receipt shared as PDF or picture | the same as a receipt (the PDF's own text, OCR for a picture) | the same; with Ф-1 on, code reads Kaspi's receipt labels |
| Fiscal QR (ОФД) | code: the sum `s` and the time `t` are in the link itself; the OFD page (allowlisted) only adds the shop and lines, read by the model, checked by code | works: amount and day from the link |
| Bank statement PDF (Kaspi Gold, Halyk) | code: the bank's table by its template (`pdfplumber` words by column), checked against the bank's own summary | works fully |
| Statement of an unknown bank | the light model by lines, each amount and day checked against its line | `422 statement_unknown_format` |

Ф-1 (`expenses_rules_first`) stays **off** by default: code does not read receipt text («ИТОГО»,
Kaspi receipt labels) unless it is on. Reading a bank statement's table by its template is not
phrase reading and is always on. The text of a receipt, a page and a statement is **data**, never
instructions; ИИН/БИН, IBAN and card numbers are masked (`⟨IBAN_1⟩`…) before any model call.
Originals follow the usual rule (`search.md`): kept 7 days after the text is read, pinned ones
stay. Nothing here keeps a copy.

## ExpenseDuplicate («Похоже, эта трата уже есть»)

```json
{
  "id": "0194...", "status": "suggested",
  "keep": {"...": "Expense"}, "other": {"...": "Expense"},
  "text_ru": "Похоже, эта трата уже есть (из выписки)",
  "action_id": null, "created_at": "...", "decided_at": null
}
```

- Made by code when two live expenses have the same amount and currency, days at most 1 apart,
  the same direction, and payees that do not contradict (one empty, or a word in common). One
  payment often comes as a receipt and as a statement row.
- `keep`: the one kept on «Объединить» by default: the person's own entry or the receipt over a
  statement row (the receipt has the lines and the person's category); between equals, the older.
  `other`: the one that goes to the trash.
- `status`: `suggested` · `merged` · `dismissed` («Это разные») · `undone` (a merge taken back; not
  suggested again).

### `GET /v1/expenses/duplicates?status=suggested&limit=50` → `200 {"duplicates": [ExpenseDuplicate]}`

Newest first. A `suggested` pair where either expense is no longer live is not listed.

### `POST /v1/expenses/duplicates/{id}/merge` → `200 {duplicate, expense, action, repeated}`

`{"client_id": "...", "keep_id": "<expense id>"}` (`keep_id` optional: one of the two, to keep the
other way round). The kept expense takes what it lacks from the other (payee, note, category,
method); the other goes to the trash with its record. `action.kind` `merge_expenses`,
`summary.ru` «Объединил траты: 2 500 ₸ · Магнум»; «Отменить» brings the other back and the kept
one's fields. Errors: `404`, `409 duplicate_closed`, `409 duplicate_stale` (one of them is gone),
`422 validation_error` (`keep_id` not in the pair).

### `POST /v1/expenses/duplicates/{id}/dismiss` → `200 {duplicate}`

«Это разные». `{"client_id": "..."}` optional. These two are never suggested together again.
`409 duplicate_closed` when not `suggested`.

## Receipt photo, screenshot, shared Kaspi receipt

The phone sends the file as a record first (the usual flow: `POST /v1/uploads` → PUT → complete →
`POST /v1/items {upload_id, source: "camera" | "share"}`), then:

### `POST /v1/expenses/from-item`

```json
{"client_id": "0194...", "item_id": "<the record>", "kind": "receipt", "save": true}
```

`kind`: `receipt` (photo / screenshot → `source: receipt_ocr`) · `shared_receipt` (a PDF or picture
shared from Kaspi or a bank → `source: shared_receipt`). The record must be `image`, `screenshot`
or `pdf` (`422 item_kind`). `save` defaults to `true`.

`201` when an expense was saved, else `200`:

```json
{
  "status": "ok",
  "expense": {"...": "Expense"}, "action": {"...": "Action"}, "page_patches": [],
  "draft": null, "duplicate": null,
  "reader": "llm", "message": null, "retry_after": null, "repeated": false
}
```

| `status` | Meaning / what the phone shows |
|---|---|
| `ok` | `save: true`: saved at once. The receipt record **is** the expense's record (`expense.item_id` = `item_id`); it shows on «Расходы»; strip «Записал 12 400 ₸ · Продукты [Отменить]». `review_fields` has `amount` always (R-36), `spent_on` when the day was not found in the text, `line_items` when the lines do not add up. `save: false`: nothing saved, `draft` = the fields for the form. |
| `waiting` | The record's text is not read yet (OCR still running): ask again after `retry_after` seconds (2). Show «Читаю чек…». |
| `form` | No amount code could confirm in the text (no `ai_cross_border`, provider down, not a receipt, the model's number is not on the receipt). `message` «Не разобрал сумму на чеке — наберите её на клавишах.»; `draft` may still carry a day or a shop that code found. |
| `exists` | This record already has an expense: `expense` = that one, `repeated: true`. |

`draft`: `{"amount": "12400.00" | null, "currency", "spent_on", "category_id", "category_key",
"method", "direction", "note", "payee", "line_items", "review_fields"}`.

`duplicate`: an `ExpenseDuplicate` when the new expense looks like one already there (e.g. the same
payment from a statement): show «Похоже, эта трата уже есть (из выписки) [Объединить?]».
`reader`: `llm` (the model, checked by code) · `rules` (code, Ф-1 on) · null.

Same `client_id` again → the first result, `repeated: true`. Errors: `404 not_found`,
`422 item_kind`.

## Fiscal QR

The phone scans the QR on a receipt and sends the link (it does not open it itself).

### `POST /v1/expenses/from-qr`

```json
{"client_id": "0194...",
 "url": "https://consumer.oofd.kz/?i=1234567890&f=010101012345&s=3400.50&t=20261104T191520",
 "item_id": null}
```

`item_id` (optional): the photo record of the same receipt, if the person also took one; it becomes
the expense's record. Otherwise a record is made («Чек ОФД — 3 400,50 ₸»).

`201`/`200` like `from-item`: `{status: "ok" | "exists" | "form", expense, action, page_patches,
duplicate, fiscal, message, repeated}`.

```json
"fiscal": {"domain": "consumer.oofd.kz", "sign": "1234567890", "register": "010101012345",
           "amount": "3400.50", "at": "2026-11-04T14:15:20+00:00", "page": "read"}
```

- Only links to **official OFD domains** are accepted (allowlist `settings.expenses_ofd_domains`,
  default `oofd.kz`, `ofd1.kz`, `kofd.kz`, `wofd.kz` and their subdomains [проверить список ОФД,
  нед. 0]); anything else → `422 qr_not_fiscal`. `http`/`https` only, ports 80/443, no
  user/password in the link.
- `amount` and `at` come from the link itself (`s`, `t`, the time is on Almaty's clock) by code: no
  model. The expense's day is `t`.
- The OFD page is fetched by the server only for an allowlisted host whose every address is public
  (no private, loopback, link-local, reserved IPs); a redirect only to an allowlisted host (≤3 hops,
  each re-checked); 10 s; 1 MB. `page`: `read` · `failed` · `skipped`. From the page, with
  `ai_cross_border`, the model may add the shop and lines; the page's total must equal `s`.
- No `s` in the link and no amount code could check on the page → `status: "form"`.
- The same fiscal receipt (`register` + `sign`) again while its expense is live → `status:
  "exists"`, that expense.
- `review_fields`: `["amount"]` (R-36: not typed by the person).

## Bank statement → plan → one «Да» → one «Отменить»

The person shares the PDF from the bank app (Kaspi: «Выписка» → «Поделиться» → our app; Halyk the
same). The phone sends it as a record (`POST /v1/items {upload_id, source: "share"}`), then:

### `POST /v1/expenses/statements` → `201 {statement, pending_action, repeated}`

```json
{"client_id": "0194...", "item_id": "<the PDF record>"}
```

Code reads the PDF (from the original, within its 7 days), finds the bank by its template, reads
every operation, checks the sums against the bank's own summary, and compares each row with the
person's expenses. **Nothing is saved as an expense** until «Да».

```json
"statement": {
  "id": "0194...", "client_id": "0194...", "item_id": "0194...",
  "status": "proposed", "bank": "kaspi_gold", "parser": "template", "currency": "KZT",
  "period": {"from": "2026-10-01", "to": "2026-10-31"},
  "rows_found": 86, "rows_new": 82, "rows_existing": 4, "rows_similar": 2,
  "check": {"ok": true, "lines": [
    {"key": "purchases", "title": "Покупки", "bank": "-80000.00", "ours": "-80000.00", "ok": true},
    {"key": "closing", "title": "Остаток на конец", "bank": "90000.00", "ours": "90000.00", "ok": true}
  ]},
  "adds": {"expense": "80000.00", "refund": "0.00", "income": "150000.00",
           "transfers": "20000.00", "transfer_own": "10000.00"},
  "summary_ru": "Нашёл 86 операций за октябрь, 4 уже есть",
  "error": null, "pending_action_id": "0194...", "action_id": null,
  "created_at": "...", "decided_at": null
}
```

| Field | Notes |
|---|---|
| `status` | `proposed` (waits for «Да») · `confirmed` · `undone` (its action was undone) · `rejected` («Не сейчас») · `expired` (24 h, or replaced by a newer plan of the same record). |
| `bank` | `kaspi_gold` · `halyk` · `freedom` (not read by template yet) · `other`. `parser`: `template` (code) · `model` (unknown bank, by lines). |
| `rows_existing` | Rows already there, **not created**: a row of an earlier import of the same statement, or an expense with the same amount, day and payee. |
| `rows_similar` | New rows that look like an expense already there (receipt + statement): created, and each pair comes as an `ExpenseDuplicate` after «Да». |
| `check` | Code's sums per kind of operation against the lines of the bank's summary, to the tiyn (`ok` per line, and for all). `ok: false` → `summary_ru` adds «Суммы не сошлись с выпиской — проверьте», and every row gets «Проверьте» on its amount. `null` for `parser: model` (no summary to check against). |
| `adds` | What «Да» adds, by kind (code, `calc.py`). `expense` − `refund` goes into «Потрачено»; `transfers` (to other people, category «Переводы») and `transfer_own` (cash withdrawals, own accounts) are in no total; `income` is its own line. |

How rows become expenses. Kaspi Gold: «Покупка» → `expense`, method `kaspi` (a «Покупка» with `+`
→ `refund`); «Перевод» `−` → `expense` in category «Переводы» (service: no total), method
`transfer`; «Снятие» → `transfer_own`, method `cash`; «Пополнение» and any other `+` → `income`;
«Разное» `−` → `expense`. Halyk: «Покупка…» / «Оплата…» → `expense`, method `card`; «Перевод…» →
«Переводы»; «Снятие…» → `transfer_own`; credits → `income` (a «Возврат…» credit → `refund`); the
bank's fee column → its own `expense` row «Комиссия банка». An operation in another currency is
recorded in the account currency (what left the account), with the original in `note`
(«10.00 USD»). Category: the one the person used last for the same payee, else none («без
категории»); with Ф-1 on also the payee dictionary. `payee` = the bank's description.
`source: statement_pdf`, `spent_on` = the operation day.

`pending_action`: the usual PendingAction (`duplicates.md`), `kind: "import_statement"`,
`preview: {"title_ru": "Записать 82 операции из выписки?", "text_ru": "Нашёл 86 операций за
октябрь, 4 уже есть. Отменить можно одной кнопкой.", "statement_id": "...", "rows_found": 86,
"rows_new": 82, "rows_existing": 4}`. It also comes in `/v1/sync` and `/v1/pending-actions`.

Errors: `404 not_found` · `422 item_kind` (not a PDF) · `422 statement_unreadable` (broken or
encrypted PDF) · `422 statement_original_gone` (the original was already purged) ·
`422 statement_unknown_format` (no known bank template, and no `ai_cross_border` or the model could
not read it) · `422 statement_empty` (no operations) · `422 statement_too_long` (over 2 000 rows).
Same `client_id` again → the first plan, `repeated: true`. A new plan for the same record replaces
an open one (that one becomes `expired`).

### `GET /v1/expenses/statements/{id}` → `200 {statement, rows}`

`rows` only while `proposed` (cleared after the decision; the expenses hold the data then):

```json
{"n": 1, "date": "2026-10-01", "amount": "2500.00", "currency": "KZT", "sign": "-",
 "kind": "purchase", "direction": "expense", "description": "MAGNUM CASH&CARRY",
 "method": "kaspi", "category_key": null, "note": null,
 "state": "new", "existing_expense_id": null, "review_fields": []}
```

`kind`: `purchase` · `transfer` · `withdrawal` · `topup` · `refund` · `fee` · `other`.
`state`: `new` · `existing` (not created, `existing_expense_id`) · `similar` (created, and suggested
as a repeat of `existing_expense_id`).

### `GET /v1/expenses/statements?limit=10` → `200 {statements: [Statement]}`

### «Да»: `POST /v1/expenses/statements/{id}/confirm` (= `POST /v1/pending-actions/{pending_id}/confirm`)

`{"client_id": "..."}` optional. `200`:

```json
{"statement": {"...": "status confirmed, action_id set"},
 "pending_action": {"...": "status executed"},
 "action": {"...": "Action"}, "created": 82, "duplicates": [], "repeated": false}
```

Every `new` and `similar` row becomes an expense (each with its own record on «Расходы») in **one**
action `bulk_create_expenses`, `summary.ru` «Записал 82 операции из выписки», one «Отменить».
Rows that meanwhile became `existing` (the same expense typed since) are skipped. A repeat returns
the first result with `repeated: true` (via `/v1/pending-actions/…/confirm` the response has the
generic shape `{pending_action, action, repeated}`). Errors: `404` · `409 pending_closed` ·
`410 pending_expired`.

### «Не сейчас»: `POST /v1/expenses/statements/{id}/reject` (= `/v1/pending-actions/{id}/reject`)

`200 {statement, pending_action}`; nothing is saved, the rows are cleared.

### «Отменить»: `POST /v1/actions/{action_id}/undo`

Every expense of that import goes to the trash with its record (30 days, as usual); the statement
shows `status: "undone"`. Importing the same PDF again later makes a fresh plan.
