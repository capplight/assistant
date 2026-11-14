# КП: «Моя компания», «Мой прайс», КП из ТЗ, правки, PDF, DOCX, отправка, черновики (weeks 14–15)

Spec: `docs/spec/final/3-engineering.md` 3.6, 4.7, 5.9, 6.7, 11.2 (week 14);
`docs/spec/proposals/template-screens.md` §2.5 (картотека); product F-13, F-14, F-34, US-11,
US-12, US-21; design S16, S17, S19, S28; founder decisions Ф-5, Ф-17, Ф-18.
Base path `/v1`. Every endpoint needs `Authorization: Bearer` and the base consents (`pd_processing`
+ `terms`), else `403 consent_required`. Anything that asks the model (a new КП, reading a card or
a price list photo) also needs `ai_cross_border`: `403 consent_required, details.missing`.
Errors: `{code, message_ru, message_kk, details?}`. Timestamps ISO 8601 UTC; dates `YYYY-MM-DD` on
the person's clock.

**Money is text**: a decimal string with two places, dot, no grouping (`"1240000.00"`). Quantities
and percents are decimal strings too (`"2.5"`, `"5"`). Never parse them into floats.

**Every number of a КП is code's** (decision №7, R-27): line sums, totals, VAT and the sum in words
come from `kp/calc.py` and `kp/words.py` on the server. The model gives names, units and
quantities as written in the ТЗ and may only *pick* a price candidate; it never writes a price.
Every line carries `price_source`; a line without a price says «укажите цену». The phone shows
`totals` as given and never adds them up itself.

Every change is an **action** (`actions.md`) with one «Отменить», in the response and in
`/v1/sync`. Every write takes a `client_id` (outbox-safe): a repeat returns the first result with
`repeated: true`.

The single «ИИ» label (R-06, 5.9): a КП has `ai_generated: true`; S17 shows
`labels.ai_generated` («Подготовил помощник (ИИ) по вашим записям — проверьте») under it. The PDF
carries it in its metadata always; the visible line on the PDF is off (`kp_visible_ai_label`)
until the lawyer.

## VAT (Ф-18)

Rate by date from server config `kp_vat_rates` (now `16.00` from 2026-01-01, confirmed by the
founder 2026-11-10). Modes (`data.vat.mode`): `included` («в сумме», default), `on_top`
(«сверху»), `none` («без НДС»: the default when the profile says `vat_payer: false`; the rules for
an ИП without VAT are still open). Each version stores the rate it used (`vat_rate`).

| mode | `net` | `vat` | `total` |
|---|---|---|---|
| `included` | `amount − vat` | `amount × r / (100 + r)` | `amount` |
| `on_top` | `amount` | `amount × r / 100` | `amount + vat` |
| `none` | `amount` | `0.00` | `amount` |

`amount = Σ line amounts − discount_total`; line `amount = qty × unit_price − discount`; all
`ROUND_HALF_UP` to 0.01. `rounding: on_total` (default) or `per_line`.

## «Моя компания» (S19, F-14, US-11)

### `GET /v1/company-profile` → `200 {profile}`

```json
{"profile": {
  "id": "0194...", "name": "Свет-Монтаж", "legal_form": "too",
  "bin_iin": "123456789013", "address": "г. Алматы, ул. Абая 1",
  "bank": {"iban": "KZ...", "bik": "KCJBKZKX", "bank": "АО «Банк»", "kbe": "17"},
  "contacts": {"phone": "+7 701 000 00 00", "email": "...", "website": "..."},
  "signer": {"name": "Иванов И. И.", "title": "Директор"},
  "vat_payer": true,
  "logo_file_id": "0194...", "signature_file_id": null, "stamp_file_id": null,
  "default_terms": {"payment": "100% предоплата", "delivery": "5 рабочих дней",
                    "warranty": "12 месяцев", "validity_days": 10},
  "review_fields": ["bin_iin", "bank.iban"], "source": "extracted",
  "version": 3, "updated_at": "...", "complete": true
}}
```

Week 15 adds `"license": {"number": "00000", "date": "2020-01-15", "category": "II
категория"}` (the state licence line of the intro; optional) and `"outgoing": {"year": 2026,
"next": 119}` (the outgoing-number sequence: each new КП takes `«<year>-<next>-1»`, e.g. «Исх. №
2026-118-1», and moves `next`; a new year starts at 1). `PUT` takes `license` (replaced whole,
`date` ISO) and `outgoing: {"next": 118}` (where the sequence goes on; not part of «Отменить»: a
number once given is never given again). `default_terms.conditions`: the «Условия» lines every new
КП starts with (≤12 strings).

No profile yet: the same shape with nulls, `id: null`, `version: 0`, `complete: false`.
`complete` = name and БИН/ИИН are there. `legal_form`: `ip` (ИП: the PDF says «ИИН») · `too` ·
`ao` · `other`. `review_fields`: «Проверьте» marks left from reading a card (cleared for a field
when the person sets it). БИН/ИИН and bank details are stored encrypted on the server.

### `PUT /v1/company-profile` → `200 {profile, action, repeated}`

Partial: send only the fields that change, plus `client_id` and `base_version` (= `version` the
phone edited; another one → `409 conflict`, `details.profile` = the current one).

```json
{"client_id": "...", "base_version": 2, "name": "Свет-Монтаж", "bin_iin": "123456789013",
 "bank": {"iban": "KZ...", "bik": "KCJBKZKX", "bank": "АО «Банк»", "kbe": "17"},
 "vat_payer": true, "logo_file_id": "<files id>", "default_terms": {"validity_days": 10}}
```

Code checks every number and refuses a wrong one (`422`, `details.field`): `bin_invalid` (12
digits + the control digit), `iban_invalid` (KZ + 18, mod-97), `bik_invalid`, `kbe_invalid`,
`profile_file_invalid`. `bank` / `contacts` / `signer` / `default_terms` are replaced whole.
Logo, signature, stamp: upload first with `POST /v1/uploads {role: "company_logo" | "signature" |
"stamp", mime: "image/png" | "image/jpeg", ...}` → complete → pass the `file_id`. These files are
kept always (Ф-5). `action.kind = "company_profile_edit"`; «Отменить» puts the whole profile back
(or removes a profile that this PUT created).

### `POST /v1/company-profile/extract` → `200 {status, draft, retry_after, message}`

`{"item_id": "<record of a business card photo / an old КП>"}`. Needs `ai_cross_border`. **Saves
nothing**: S19 shows `draft` with «Проверьте» on `draft.review_fields`, and «Верно» sends it to
`PUT` (with `source: "extracted"` and the `review_fields` the person did not confirm).

| `status` | Meaning |
|---|---|
| `ok` | `draft` = `{name?, legal_form?, bin_iin?, address?, bank{}, contacts{}, signer{}, review_fields, source}`: only values code found written in the text and that pass the checks above. |
| `waiting` | The record's text is not read yet: again after `retry_after` (2) s. |
| `form` | Nothing read: `message` «Не получилось прочитать. Введите реквизиты вручную.» |

`422 item_kind` (not a photo / PDF / document / note).

## «Мой прайс» (S28, F-34, US-21)

`PriceListItem`:

```json
{"id": "0194...", "client_id": null, "price_list_id": "0194...", "sku": "ВА47",
 "name": "Автомат ВА47-29 16А", "unit": "шт", "price": "2900.00", "currency": "KZT",
 "review_fields": ["price"], "source_ref": "лист стр.12", "updated_at": "..."}
```

`review_fields: ["price"]`: read from a photo / PDF by the model → «▓18 500 ₸▓ ⚠ проверьте».
Units are normalised (`шт`, `м`, `п.м`, `м²`, `м³`, `кг`, `т`, `л`, `компл`, `упак`, `услуга`,
`час`, …; others as written).

### `GET /v1/price-lists` → `{price_lists: [{id, client_id, title, source, reader, active, items, review_count, uploaded_at, updated_at, deleted_at}]}`

`source`: `upload` · `typed_sequence` («Мои цены», the person's own list) · `voice`. `reader`:
`table` (code read the columns) · `model`.

### `POST /v1/price-lists` → `201 {status, price_list, action, repeated}`

`{"client_id": "...", "item_id": "<the uploaded price list record>", "title": "Прайс 2026"}`.
Excel / PDF / photo shared or picked as usual (`POST /v1/uploads` → `POST /v1/items`). A table with
a «Наименование» and a «Цена» column (also «Ед.», «Артикул») is read by code; anything else by the
model (needs `ai_cross_border`), whose every price must be a number written in the file.
`status: "waiting"` (+ `retry_after`) while the record is still being read. `action.kind =
"price_list_edit"`; «Отменить» removes the whole list. Errors: `422 item_kind`,
`422 price_list_unreadable` (→ «Ввести цены подряд»), `422 price_list_too_long` (a photo/PDF list
over ~600 lines: send Excel).

### `POST /v1/price-lists/items` → `201 {items, action, repeated}` — «Ввести цены подряд», voice, «Обновить в прайсе? — Да»

```json
{"client_id": "...", "source": "typed_sequence",
 "items": [{"name": "Щит ЩРН-24", "unit": "шт", "price": "18500"}]}
```

A position already in a live price list (same name, unit agrees) gets the new price; a new one
goes to «Мои цены». One action; «Отменить» restores the old prices and removes the new rows.

### `GET /v1/price-lists/items?q=&limit=50&offset=0` → `{items, next_offset}`

«🔍 Найти позицию»: trigram + full-text over the normalised name; no `q` = by name.

### `GET /v1/price-lists/history?limit=50` → `{items: [{name, unit, price, currency, price_source, client, created_at}]}`

S28 «ИЗ ПРОШЛЫХ КП»: the last price of each position of past КП that no price list has. «Добавить в
прайс» = `POST /v1/price-lists/items` with them.

### `PATCH /v1/price-lists/items/{id}` → `{item, action, repeated}`

`{"client_id": "...", "price": "19000", "name": "...", "unit": "шт", "checked": true}` — any of
them; `checked: true` («Верно») clears «Проверьте». `DELETE /v1/price-lists/items/{id}?client_id=`
and `DELETE /v1/price-lists/{id}?client_id=` → `{action, repeated}`. All with «Отменить».

## A КП from a ТЗ (S16 → S17, F-13, US-12)

The ТЗ is a record first (shared PDF / Excel / Word / photo, or a typed note): `POST /v1/items`.

### `POST /v1/documents/kp` → `202 {document, version: null, needs_profile, repeated}`

```json
{"client_id": "...", "item_ids": ["<the ТЗ record>"], "wishes": "доставка до объекта"}
```

Week 20 (Ф-50): `item_ids` may be empty when `text` is sent: `{"client_id", "text": "Светильники
LED 20 шт, монтаж"}` (≤4000 chars, the ТЗ typed or said; saved as the person's record first);
neither → `422 validation_error`. «Сделать КП из этого» on a record / a shared file = this call
with that record in `item_ids`. The line starts a КП the same way (`chat.md`, event
`kp_started`).

Queues KP_EXTRACT (worker `python -m assistant.kp`). `needs_profile: true` → S16 first shows «Ваша
компания» → S19 (the КП is still made; the PDF waits for the required fields).

- A ТЗ of ≤60 position-like lines and ≤~20 pages is one pass (≤2 min); a bigger one goes in parts
  of 40 lines with progress «Обработал 120 из 240».
- A started КП is never cut off by the budget (documents wallet, R-18). At most `kp_per_day` (5)
  new КП a day: then `429 kp_daily_limit` «На сегодня достаточно — продолжу завтра…».
- Errors: `403 consent_required` (no `ai_cross_border`), `404 not_found`, `422 item_kind`,
  `409 kp_source_not_ready` (`details.retry_after: 2`: the file is still being read),
  `422 kp_source_empty`.

### `GET /v1/documents/{id}/progress` — SSE (`?once=true`: one JSON object)

`event: progress` with `{document_id, status, state, done, total, parts_done, parts_total,
partial, message, error}` whenever it changes, then `event: end`. `state`: `reading` → `done` |
`failed`. `message`: «Обработал 120 из 240», at the end with `partial: true` «Прочитал 30 из 80 —
остальное добавьте вручную» (a provider failed for good after some parts). `failed` + `error`:
`kp_budget` («продолжу завтра»), `kp_consent`, `kp_source_empty`, `kp_no_positions`,
`kp_unavailable`; `message` has the text to show. When done, `GET /v1/documents/{id}`.

### `GET /v1/documents/{id}` → `200 {document, version, needs_profile}`

`document` = DocumentRow (below). `version` = the current Version (null while `extracting`):

```json
{
  "n": 1, "author": "initial", "created_at": "...", "calc_version": "kp-calc.v2",
  "vat_rate": "16.00", "vat_mode": "included", "changed_paths": [], "patch": [],
  "request_text": null,
  "data": {"number": "КП-2026-014", "date": "2026-11-10", "currency": "KZT",
           "vat": {"mode": "included"}, "discount_total_pct": "0",
           "terms": {"payment": "100% предоплата", "delivery": "5 рабочих дней",
                     "warranty": null, "validity_days": 10},
           "text_blocks": {"intro": null, "outro": null}},
  "client": {"name": "ТОО «Арман»", "bin": "140540012345", "contact": "Ерлан",
             "review": ["client.bin"]},
  "items": [
    {"id": "i1", "name": "Кабель ВВГнг 3х2,5", "unit": "м", "qty": "500",
     "unit_price": "450.00", "discount_pct": "0",
     "price_source": "price_list:0194...#0194...", "price_review": false,
     "matched_name": null, "source_ref": "часть 1, 1",
     "review_fields": [], "price_label": "из прайса «Прайс 2026»",
     "amount": "225000.00", "gross": "225000.00", "discount": "0.00"},
    {"id": "i2", "name": "Автомат 16А", "unit": "шт", "qty": "40", "unit_price": "2900.00",
     "price_source": "price_list:...", "price_review": true, "matched_name": "Автомат ВА47-29 16А",
     "price_label": "из прайса: «Автомат ВА47-29 16А» — та ли позиция?", "review_fields": ["qty"],
     "...": "..."},
    {"id": "i3", "name": "Щит ЩРН-24", "unit": "шт", "qty": "4", "unit_price": null,
     "price_source": "missing", "price_label": "укажите цену", "amount": null, "...": "..."}
  ],
  "totals": {"calc_version": "kp-calc.v2", "lines": [{"id": "i1", "gross": "225000.00",
             "discount": "0.00", "amount": "225000.00", "vat": null}],
             "lines_sum": "341000.00", "discount_total": "0.00", "amount": "341000.00",
             "net": "293965.52", "vat": "47034.48", "total": "341000.00",
             "vat_mode": "included", "vat_rate": "16.00", "rounding": "on_total",
             "priced": 2, "missing": 1, "complete": false},
  "valid_until": "2026-11-20",
  "price_summary": {"price_list": 2, "past_kp": 0, "manual": 0, "missing": 1},
  "missing_required": ["seller.bin_iin", "total", "amount_words"],
  "sent_at": null, "sent_channel": null, "render": null, "ai_generated": true,
  "files": {"pdf": null, "docx": null}, "frozen": false
}
```

- `price_source`: `price_list:<price list id>#<position id>` · `past_kp:<document id>#v<n>` ·
  `manual` (typed by the person) · `missing`. Show `price_label` as is («из прайса», «из КП ТОО
  Арман, 3 окт», «укажите цену»; nothing for `manual` — «цену поставил я» is never written).
- Order: an exact price list position (same name, unit agrees) → the last price of the same
  position in a past КП (this client's first) → a similar price list position the model picked
  (`price_review: true`, `matched_name`: «та ли позиция? ⚠») → `missing`.
- `review_fields` of a line: `qty` (the quantity is not written in the ТЗ like that, or missing:
  then 1) · `unit`. `client.review`: `client.bin`. Show «Проверьте».
- `price_summary` → S16 «ЦЕНЫ: 9 — из прайса · 1 — из КП · 2 — нет цены».
- `missing_required` (Ф-17, configurable `kp_required_fields`; week 15: as observed in the
  founder's father's real КП, pending his confirmation). Keys: `number`, `date`, `outgoing`
  («Исх. № … от …»), `validity`, `seller.name`, `seller.bin_iin`, `seller.address`,
  `seller.bank` (ИИК + БИК + Кбе), `buyer.name`, `buyer.bin`, `items` (a line), `items.unit`,
  `total` / `amount_words` (= every line has a price), `vat`, `signer` (name + position),
  `license`, `subject`, `signature_stamp` (never missing). **Default:** number, date, outgoing,
  validity, seller.name, seller.bin_iin, seller.address, seller.bank, buyer.name, items, total,
  vat, amount_words, signer, signature_stamp. Optional by default: buyer.bin, license, subject,
  the «Условия» lines, stamp and signature images.

### `GET /v1/documents/{id}/versions` → `{versions: [VersionRow], sent_version_n}` (week 15: see «Versions» below)

### `GET /v1/documents/{id}/versions/{n}` → `{document, version, needs_profile}` (that version)

### Tap edits: `POST /v1/documents/{id}/patch` → `200 {document, version, action, change_text, price_offers, repeated}`

No model; the total is recomputed by code at once. JSON Patch (RFC 6902 subset):

```json
{"client_id": "...", "base_version": 1, "save_prices": false,
 "ops": [{"op": "replace", "path": "/items/i3/unit_price", "value": "18500"},
         {"op": "replace", "path": "/items/i2/qty", "value": "42"},
         {"op": "add", "path": "/items/-", "value": {"name": "Доставка", "unit": "рейс",
                                                     "qty": "1", "unit_price": "15000"}},
         {"op": "remove", "path": "/items/i5"},
         {"op": "replace", "path": "/vat/mode", "value": "on_top"},
         {"op": "replace", "path": "/client/bin", "value": "140540012345"}]}
```

Paths: `/number` `/date` `/client/name|bin|contact` `/vat/mode` `/discount_total_pct`
`/terms/payment|delivery|warranty|validity_days` `/text_blocks/intro|outro`
`/items/<id or index>/name|unit|qty|unit_price|discount_pct|volume`, `/items/<id>` (remove a
line), `/items/-` (add). Week 15: `/subject` («на монтаж систем …»), `/outgoing/number`,
`/outgoing/date`, `/terms/conditions` (the «Условия» lines: a list of strings, ≤12, replaced
whole; `remove` clears it). **Lump-sum lines** (the father's КП): add `{"kind": "lump", "name":
"Монтаж систем", "volume": "1 здание", "unit_price": "38635000"}` — `unit_price` is the line's
whole cost, `volume` free text, `qty` is "1" and cannot be patched (`patch_path_not_allowed`);
`calc` takes `amount = unit_price` (no qty × price, `calc_version` `kp-calc.v2`). A version's
`items[]` carry `kind` (`qty` · `lump`) and `volume`; `data` carries `subject` and `outgoing`
`{number, date}`. `remove` on an optional field clears it; on `unit_price` makes it `missing`. Sums
are never patched. A typed price → `price_source: manual`; a touched field loses «Проверьте».

- `base_version` ≠ the current `n` → `409 conflict` with `details` = the current `{document,
  version}`.
- `version.changed_paths` (`/items/i3/unit_price`, `/totals/total`, …) → the 600 ms highlight.
- `change_text`: «Итого: 1 240 000 → 1 178 000 ₸» when the total moved, else «Изменил КП»;
  `action.kind = "edit_kp"`; «Отменить» = back to the version before (a new version, `author:
  revert`). If the КП was edited again since, the undo leaves it («Часть уже изменена вами»).
- `price_offers` (US-21 «Обновить в прайсе?» [Да] [Только здесь]): `[{line_id, name, unit, price,
  price_item_id, old_price}]` for typed prices «Мой прайс» lacks or has differently. «Да» =
  `POST /v1/price-lists/items`. With `save_prices: true` («Ввести цены подряд» → «Сохранить в
  прайс ☑») they are saved in the same action and `price_offers` is empty.
- Errors `422`: `patch_invalid`, `patch_path_not_allowed`, `patch_value_invalid`, `bin_invalid`,
  `kp_last_line`, `kp_qty_invalid`, `kp_price_invalid`, `kp_discount_invalid`; `409 kp_not_ready`.

### `POST /v1/documents/{id}/revert` `{client_id, n}` → `{document, version, action, repeated}`

«Вернуть версию n»: a new version equal to n (its numbers exactly as they were). «Отменить» goes
back.

### The card file: status strip, trash, list

- `POST /v1/documents/{id}/status {client_id, deal_status}` → `{document, action, repeated}`.
  `deal_status`: `draft` («Черновик») · `sent` («Отправлено»; week 15 sets it itself after S18) ·
  `seen` («Видел») · `accepted` («Принято») · `declined` («Не принято»). With «Отменить».
- `DELETE /v1/documents/{id}?client_id=` → the КП and its record to the trash (30 days),
  `action.kind = "delete_item"` with «Отменить». A КП still being read is finished anyway, so the
  undo brings back a whole one.
- `GET /v1/documents?limit=50&before=` → `{documents: [DocumentRow], next_before}`.
- `GET /v1/documents/summary` → the dividers and folders of the «Документы» page, counted by
  code: `{by_type: {kp, contract, receipt, other}, deal_status: {draft, sent, seen, accepted,
  declined}, clients: [{name, count}]}` (`name: null` = «Без клиента», last).

### The PDF: `POST /v1/documents/{id}/render?format=pdf&n=` → `200 {file, version_n, total, document}`

```json
{"file": {"id": "0194...", "mime": "application/pdf", "bytes": 48213, "sha256": "...",
          "url": "/v1/documents/<id>/files/<file id>", "name": "КП_ТОО_Арман_v3.pdf"},
 "version_n": 3, "total": "1218500.00", "document": {"...": "status ready"}}
```

`GET file.url` (with the Bearer) → the PDF bytes (`Content-Disposition: attachment`). PDF is the
default; `format=docx` makes the Word file (week 15, below). The same
version with the same data and profile gives the same file (deterministic: template `kp_v1` +
packaged fonts with Kazakh letters + data). The PDF prints: the seller's requisites (and logo),
«Коммерческое предложение № … от …, действительно до …», the buyer, the lines (№, name, unit,
qty, price, discount, sum), totals by VAT mode, «Всего к оплате: <сумма прописью>» (RU; KK too
when `kp_words_langs` has it), terms, signer with signature and stamp if uploaded. Errors:
`422 kp_prices_missing` (`details.lines`), `422 kp_fields_missing` (`details.fields`, Ф-17),
`409 kp_not_ready`, `503 kp_render_unavailable` (the renderer is down: try again).

## Week 15: phrase edits, versions, DOCX, sending, drafts

Spec: 3-engineering 4.7, 4.8, 6.7 steps 5–7, 6.8, 11.2 (week 15); product F-13, F-15, US-12,
US-13; design S17, S18, S25. Nothing here sends a message: the phone's share sheet, mail
composer or a `wa.me` link do, and the person presses ➤ (decision №6, R-15).

### Phrase edits: `POST /v1/documents/{id}/edit` → `200 {status, document, version, action, change_text, price_offers, message, refused, repeated}`

S17 «Скажите, что изменить»: «убери доставку», «скидка 5% на всё», «цена щита 18500», «срок 7
дней». Needs `ai_cross_border` (`403 consent_required, details.missing`).

```json
{"client_id": "...", "base_version": 3, "text": "скидка 5% на всё"}
```

`text` 1–500 chars (voice: the phone sends the STT text). KP_EDIT (strong model, documents wallet,
masked ИИН/БИН/IBAN/phones; the КП is sent as data, the phrase as the person's request) turns the
phrase into JSON Patch ops on the same white list as tap edits (`/items/<id>/…` incl.
`volume`, `/items/-` incl. a lump-sum line «добавь пусконаладку 500 000 на 1 здание»,
`/items/<id>`, `/vat/mode`, `/discount_total_pct`, `/terms/…`, `/text_blocks/…`, `/subject`,
`/client/name`, `/client/contact`, `/date`; **not** `/number`, `/client/bin`, `/outgoing/…` and
`/terms/conditions`: tap edits only). Code then checks
every op and either applies all of them **at once** (a new version, `author: "agent_request"`,
`request_text` = the phrase, totals by `kp/calc.py`) or none:

- every number the model puts in a price, quantity, percent or days must be **written in the
  phrase** (`numbers_in`): the model never computes («подними цену кабеля на 10%» → `refused`, it
  would have to compute 495). A price set this way is `price_source: "manual"` (the person said it).
- a line the model adds takes its name from the phrase (its words must be in it); without a price
  in the phrase it is `missing` («укажите цену») — a price is never invented.
- the ops then go through the tap edit code (`patch_*` / `kp_*` checks below).

| `status` | Meaning |
|---|---|
| `applied` | New version; `document`, `version` (with `changed_paths` → the 600 ms highlight), `action` (`edit_kp`, `initiated_by: "agent"`, «Отменить» = back to the version before; partial undo «Часть уже изменена вами» as tap edits), `change_text` («Итого: 1 240 000 → 1 178 000 ₸» or «Изменил КП»), `price_offers` (as tap edits). `message: null`, `refused: []`. |
| `not_understood` | Nothing changed (`action: null`, `version` = the current one). `message`: «Не понял, что изменить. Скажите иначе или поправьте поле вручную.» |
| `refused` | Nothing changed. `refused: [{path, reason}]`, `reason`: `number_not_said` (a number not in the phrase), `name_not_said`, `path_not_allowed`, `value_invalid`. `message`: «Не могу посчитать это сам — скажите число, например «цена кабеля 495»» for `number_not_said`, else «Так изменить не получится. Поправьте поле вручную.» |

A repeat of the same `client_id` returns the first result (`repeated: true`, `status: "applied"`
when it applied; a repeat of a call that changed nothing runs again). Errors: `409 conflict`
(`base_version` ≠ the current `n`, before or after the model call; `details` = the current
`{document, version}`), `409 kp_not_ready`, `409 item_deleted`, `503 kp_edit_unavailable` («Не
получилось изменить — попробуйте ещё раз или поправьте поле вручную»), and the tap edit `422`s.
A started КП is never cut off by the budget: edits run as `continuing` (R-18).

### Versions

`GET /v1/documents/{id}` (and `…/versions/{n}`) now also carries `versions` (newest first, at most
50) and `version.files` / `version.frozen`. `GET /v1/documents/{id}/versions?limit=50` →
`{versions: [VersionRow], sent_version_n}`:

```json
{"n": 4, "author": "agent_request", "author_text": "Правка: «скидка 5% на всё»",
 "request_text": "скидка 5% на всё", "created_at": "...", "total": "1178000.00",
 "missing_prices": 0, "changed_paths": ["/discount_total_pct", "/totals/total"],
 "current": true, "sent_at": null, "sent_channel": null, "frozen": false,
 "files": {"pdf": null, "docx": null}}
```

`author_text`: «Первая версия» · «Правка вручную» · «Правка: «…»» · «Вернул версию 2» (also an
«Отменить» of an edit). Show it as the versions sheet («v3 · Отправлено 3 ноя · 1 218 500 ₸»); tap
→ `GET …/versions/{n}`; «Вернуть эту версию» → `POST …/revert {client_id, n}`. `files.pdf` /
`files.docx`: File (`{id, mime, bytes, sha256, url, name}`) made of that version, or null.

**Frozen** (`frozen: true`, `sent_at` set): the version the client got. Versions never change
anyway (every edit is a new one); a frozen version's files are kept for good (Ф-5,
`kp_keep_sent_render`: `files.keep_reason = sent_kp`) and `render` of it returns the stored file,
never a new one (even after the profile changed). An edit after sending makes `n + 1`; the next
`send` says «Клиент видел v3. Отправить новую?».

### The layout (v2, PDF and DOCX): the founder's father's real КП

Five real КП of the father (one template, sent as Word) were reviewed for their structure only;
layout v2 (`builtin:kp_v2` / `builtin:kp_docx_v1`, migration 0021) follows it in both formats:

1. Letterhead: the legal form spelled out («ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ»,
   «ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ», «АКЦИОНЕРНОЕ ОБЩЕСТВО»), the name in «», the address, one
   line «БИН …, ИИК … в АО …, БИК …, Кбе …» (ИП: «ИИН»); the logo if uploaded.
2. «Исх. № 2026-118-1 от 29.10.2026 г.» (`data.outgoing`).
3. The buyer's name (its БИН only if the КП has one).
4. «КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ № N» (`data.number`), the subject line (`data.subject`).
5. The intro: «ТОО «…», государственная лицензия № … от … г., <категория>.» (from the profile, if
   any) + `text_blocks.intro` (city, object, project).
6. The table. All lines lump sums: **№ | Наименование | Объём | Стоимость, ₸**; otherwise № |
   Наименование | Объём («100 м») | Цена | (Скидка) | Стоимость. Last rows by VAT mode: `none`
   «ИТОГО без НДС»; `included` «ИТОГО» + «в т. ч. НДС 16%»; `on_top` «ИТОГО без НДС» + «НДС 16%» +
   «ИТОГО с НДС» (and «Сумма по позициям» / «Скидка N%» first when there is a КП discount).
7. «Общая стоимость: 38 635 000 ₸ (Тридцать восемь миллионов … тенге 00 тиын), без НДС.»
   (`included`: «, в том числе НДС 16% — … ₸»; `on_top`: «, включая НДС 16% — … ₸»). KK words
   below when `kp_words_langs` has `kk`.
8. «Условия:» as a dash list: the VAT line («Цены указаны в тенге без НДС, ТОО «…» не является
   плательщиком НДС.» / «…с учётом НДС 16%.» / «…НДС 16% начисляется сверху.»), then
   `terms.conditions`, «Оплата: …», «Сроки: …», «Гарантия: …», «Предложение действительно N
   календарных дней.».
9. «Будем рады сотрудничеству.» (or `text_blocks.outro`).
10. The signer: position + company, name, «моб.: …», «e-mail: …» (profile contacts); signature
    and stamp images only if uploaded.

### DOCX: `POST /v1/documents/{id}/render?format=docx&n=` → `200 {file, version_n, total, document}`

«Ещё → Сделать в Word». The same data, the same `calc` totals, the same checks and errors as the
PDF (`kp_prices_missing`, `kp_fields_missing`, `kp_not_ready`), the same content (requisites,
logo, buyer, lines, totals by VAT mode, sum in words, terms, signer, signature and stamp). `file`:
`mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"`, `name:
"КП_ТОО_Арман_v3.docx"`. No model. Deterministic: the same version, data and profile give the
same bytes (fixed zip times, core properties dated by the version). The «ИИ» rule is the PDF's:
core properties `subject`, `keywords` and `comments` say `kp_ai_metadata` («Подготовлено с помощью
ИИ») always; the visible line only with `kp_visible_ai_label`. Fonts: Arial (has every Kazakh
letter, present wherever Word is). PDF stays the default everywhere (`format` omitted = pdf).

### Sending (S18): `POST /v1/documents/{id}/send` → `200 {pending_action, file, version_n, resend, message, hint, document, repeated}`

```json
{"client_id": "...", "n": 3, "channel": "whatsapp", "format": "pdf",
 "recipient_name": "Ерлан", "message": null}
```

`n` (default: current), `channel`: `whatsapp` · `email` · `share` (another app), `format`: `pdf`
(default) · `docx`, `recipient_name`: the name the person picked (the phone number never comes
here, R-16), `message`: the cover text if the person edited it. Makes the file if that version
has none (render errors as above) and a pending action (24 h) with a preview made by code:

```json
{"pending_action": {"id": "0194...", "kind": "send_whatsapp_file", "status": "proposed",
   "preview": {"title_ru": "Отправить КП?", "document_id": "...", "version_n": 3,
               "client": "ТОО «Арман»", "recipient_name": "Ерлан", "total": "1218500.00",
               "total_text": "1 218 500 ₸", "file": {"id": "...", "name": "КП_ТОО_Арман_v3.pdf",
               "mime": "application/pdf", "bytes": 48213, "url": "/v1/documents/.../files/..."},
               "channel": "whatsapp", "format": "pdf",
               "message": "Добрый день, Ерлан! Направляю коммерческое предложение № КП-2026-014 на сумму 1 218 500 ₸.",
               "hint": "Откроется WhatsApp — выберите чат «Ерлан» и нажмите ➤",
               "resend": null},
   "expires_at": "...", "...": "..."},
 "file": {"...": "as render"}, "version_n": 3, "resend": null, "message": "…", "hint": "…",
 "document": {"...": "DocumentRow"}, "repeated": false}
```

`kind`: `send_whatsapp_file` · `send_email` · `share_file`. `resend` when another version was
sent before: `{"sent_version_n": 3, "sent_at": "...", "text": "Клиент видел v3. Отправить
новую?"}` (S18 shows it first). `message` default is code's: «Добрый день[, <имя>]! Направляю
коммерческое предложение № … на сумму … ₸.» (sum by `calc`). Hints: email «Откроется почта —
проверьте адрес и нажмите «Отправить»», share «Выберите, куда отправить файл».

**«Открыть WhatsApp» / «Открыть почту»** = `POST /v1/pending-actions/{id}/confirm` →
`{pending_action (status "confirmed"), action: null, execute, repeated}`:

```json
{"execute": {"kind": "share_file", "file": {"url": "...", "name": "КП_ТОО_Арман_v3.pdf",
             "mime": "application/pdf"},
             "text": "Добрый день, Ерлан! …", "subject": "Коммерческое предложение № КП-2026-014",
             "wa_url_template": "https://wa.me/{phone}?text=%D0%94%D0%BE...", "hint": "…"}}
```

`execute.kind`: `share_file` (whatsapp, share: download `file.url` with the Bearer →
`expo-sharing`; «Отправить только текст в чат» = `wa_url_template` with `{phone}` replaced on the
phone by the contact's digits) · `email` (`expo-mail-composer` with the file, `subject`, `text`;
fallback `mailto:`) · `whatsapp_text` (drafts: open `wa_url_template`). Confirming again returns the
same (`repeated: true`). The server sends nothing.

**«Отправили?»** after the phone comes back:

- [Да] → `POST /v1/documents/{id}/versions/{n}/sent` `{client_id, channel, pending_action_id?}` →
  `200 {document, version, action, repeated}`. `channel` (stored as `sent_channel`):
  `whatsapp_share` · `whatsapp_text` · `email` · `share_other`. The version gets `sent_at`,
  becomes frozen (its PDF made now if it had no file: the PDF is what is kept), the document
  `sent_version_n = n`, `status: "sent"`, `deal_status: "sent"` (unless already `accepted` /
  `declined`), past-КП prices of that version get `sent_at`; the pending action (if given)
  `executed`. `action.kind = "send_external"`, `scope: "external"`, **no «Отменить»**
  (`undoable: false`): «Отправил КП ТОО «Арман» (v3) через WhatsApp». A version already sent:
  nothing changes (`action: null`). Works without `send` too (the person shared it from
  elsewhere). Errors: `404`, `409 kp_not_ready`, render errors when the PDF has to be made.
- [Нет] → `POST /v1/pending-actions/{id}/result {outcome: "not_sent"}` → `{pending_action}`
  (status `cancelled_by_user`); nothing is marked. `outcome: "sent"` (+ `channel?`) is the same as
  `…/versions/{n}/sent` for a КП, and marks a draft sent (below):
  `{pending_action, action, document?, draft?}`.
- «Не сейчас» before opening → `POST /v1/pending-actions/{id}/reject` (as before).

### Drafts (F-15, US-13, S25)

A message or a letter the assistant writes and the person sends. Draft:

```json
{"id": "0194...", "client_id": "...", "channel": "whatsapp", "recipient_name": "Арман",
 "subject": null, "text": "Добрый день, Арман! КП будет готово в пятницу.",
 "request_text": "напиши Арману, что КП будет в пятницу", "document_id": null,
 "status": "draft", "review_fields": [], "pending_action_id": "0194...", "ai_generated": true,
 "sent_at": null, "version": 1, "seq": 9200, "created_at": "...", "updated_at": "...",
 "deleted_at": null}
```

`status`: `draft` · `sent` · `discarded`. `review_fields: ["text"]`: the text has a number that is
neither in the request nor in the КП it is about → «Проверьте». The single «ИИ» label
(`labels.ai_generated`) is shown under the text while `ai_generated` is true (an edited text keeps
it: it was still prepared by the assistant).

- `POST /v1/drafts` `{client_id, request, channel: "whatsapp" | "email", recipient_name?,
  document_id?}` → `201 {draft, pending_action, labels, repeated}`. DRAFT (light model, answers
  budget; needs `ai_cross_border`, masked). `document_id`: a КП it is about (number, client,
  total and date given to the model by code). `recipient_name`: from the request («Арману» →
  «Арман») unless given; the phone resolves it to a contact with its own picker (two «Арман» →
  the picker). `pending_action.kind`: `send_whatsapp_text` · `send_email`; preview `{title_ru:
  "Отправить сообщение?", recipient_name, channel, text, subject, hint, draft_id}`. Errors: `403
  consent_required`, `404` (document), `422 draft_empty` (the model wrote nothing usable), `503
  draft_unavailable`.
- `GET /v1/drafts?status=draft&limit=50` → `{drafts}`.
- `PATCH /v1/drafts/{id}` `{text?, subject?, recipient_name?, channel?}` («Изменить») →
  `{draft, pending_action}`: the open pending action is replaced by a new one with the new
  preview (the confirmation is bound to what is shown).
- `DELETE /v1/drafts/{id}` («Не надо») → `{draft}` (`discarded`; its pending action `rejected`).
- «Открыть WhatsApp / почту» → `POST /v1/pending-actions/{id}/confirm` → `execute` (`whatsapp_text`
  or `email`, no file). «Отправили? — Да» → `POST /v1/pending-actions/{id}/result {outcome:
  "sent"}` → the draft `sent`, an action `send_external` (no «Отменить»).

Drafts travel in `/v1/sync` (`drafts`).

## DocumentRow (sync, page rows, lists)

```json
{"id": "0194...", "client_id": "...", "item_id": "0194...", "kind": "kp",
 "title": "КП № 14 · ТОО «Арман»", "number": "КП-2026-014", "date": "2026-11-10",
 "client": {"name": "ТОО «Арман»"}, "currency": "KZT", "total": "1240000.00",
 "vat_mode": "included", "missing_prices": 0, "lines": 12,
 "status": "draft", "deal_status": "draft", "deal_status_text": "Черновик",
 "current_version_n": 1, "sent_version_n": null, "sent_at": null,
 "progress": {"state": "done", "done": 12, "total": 12, "parts_done": 1, "parts_total": 1},
 "error": null, "ai_generated": true, "version": 3, "seq": 9123,
 "created_at": "...", "updated_at": "...", "deleted_at": null}
```

`status`: `extracting` · `draft` · `ready` (a PDF of the current version exists) · `sent` (a
version was sent; `sent_at` = when, «Отправлено 3 ноя») · `archived` · `failed` (`error` + `progress.message`). The mini-sheet of the card is drawn
from `title` / `total` / `deal_status` (no picture).

## Pages: «Документы» (template v2; Ф-51, migration 0026: was «Документы и КП»)

`GET /v1/pages/{id}/items` entries of a КП carry `document` (DocumentRow) and `fields`:
`doc_type: "kp"`, `client`, `amount` (= `total`), `kp_status` (= `deal_status`). Other documents
on the page get `doc_type` from their envelope (`contract` · `receipt` · `other`). Template v2
(0020): `kp_status` options `draft, sent, seen, accepted, declined`; `default_view.group_by:
"client"` (folders by client). The КП record is `items.kind = "kp"`, `ai_generated: true`; it
lands on «Документы» (and not on «Заметки»).

## Sync

`/v1/sync` adds, in `seq` order like the rest:

- `documents`: DocumentRow (incl. trashed, `deleted_at` set) → the card file works offline
  (template-screens §2.5: «картотека, фильтры, статусы и перестановка работают»). A КП's lines and
  versions are fetched online (`GET /v1/documents/{id}`); making a new КП needs the network.
- `statement_imports` (week 13, `expenses.md` Statement) and `expense_duplicates` (week 13,
  ExpenseDuplicate): plans and «Похоже, эта трата уже есть [Объединить?]» reach the phone; an
  undo of the import / merge brings the row again with `status: "undone"`.
- Tombstones: `entity: "document"` (a КП purged with its record), `"expense_duplicate"`.

Week 15 adds:

- `company_profile`: at most one row, the profile as `GET /v1/company-profile` gives it **except
  the secrets**: `bin_iin: null` and `bank.iban: null`, with `bin_iin_hint: "…9013"` and
  `bank.iban_hint: "…0100"` (last 4), `secrets_masked: true`; `complete` is computed from the real
  values. The phone shows «Моя компания» offline from it; S19 editing and the PDF still read the
  full profile online (`GET /v1/company-profile`). Why: an ИП's ИИН is a person's national ID and
  the IBAN is a bank account; they are stored encrypted on the server (БИН/bank `*_enc`), and the
  sync stream lands in the phone's general database on every device, so only a hint travels.
  Tombstone `entity: "company_profile"` when an «Отменить» removes a profile that a PUT created.
- `price_lists`: as `GET /v1/price-lists` rows (incl. removed, `deleted_at`).
- `price_list_items`: PriceListItem rows (incl. removed, `deleted_at`), so «Мой прайс» and «🔍
  Найти позицию» work offline. A list can be thousands of rows: they come in `seq` pages like
  everything else (`has_more`).
- `drafts`: Draft rows (above).
- Tombstones: `"company_profile"`, `"price_list"`, `"price_list_item"`, `"draft"`.

## «Это разные» for expenses (week 13 fix)

`POST /v1/expenses/duplicates/{id}/dismiss {client_id?}` → `{duplicate, action, repeated}`: now
one action `dismiss_expenses` («Оставил траты отдельно») with «Отменить» (the pair is suggested
again).
