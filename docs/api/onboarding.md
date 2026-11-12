# First launch, choosing pages, page proposals, «Сегодня» tiles (week 16)

Spec: `docs/spec/final/3-engineering.md` 3.11, 4.10, 6.14; `1-product.md` F-19, US-14, US-23,
US-33, US-30, R-55; `2-design.md` S01–S02, S41, S03, S35, 4.5.4; founder Ф-24, Ф-32;
`proposals/template-screens.md` 2.7. Base path `/v1`. All endpoints need `Authorization: Bearer`
and the base consents (`pd_processing` + `terms`), else `403 consent_required`. Errors have the
usual shape `{code, message_ru, message_kk, details?}`.

## Beta first launch (Ф-34, Ф-35, week 19) — replaces the order below for now

`POST /auth/anonymous` → one welcome screen with «Начать» and the privacy-policy line →
«Начать» = `POST /consents` with `"screen": "welcome"` (`auth.md`) → `POST /pages/batch
{"path": "skipped"}` (makes «Заметки» + «Дела»; «Сегодня» comes with the account; marks the first
launch done) → «Сегодня». No S41, S35, S04b, notifications or alarm setup in the first minutes:
those are asked when needed. «Покупки», «Расходы», «Документы и КП» are made by the server on
their first record (`features.md`). The endpoints below stay (gallery and «Новая страница» use
them); page proposals and «Сегодня» tiles are off for the beta (`features.md`).

## The order on the phone (6.14)

`POST /auth/anonymous` → welcome S01–S02 (local, no network, «Пропустить») → S05 consents
(`POST /consents`) → S41 «С чего начнём?» → one of three paths → first result → S04b (phone,
«Позже») → Android 14+: S15.

Nothing reaches the server's model before «Согласен»: the microphone and the line stay off until
the consents are written; the server's consent gate refuses anyway.

| Path (`path`) | S41 card | Then |
|---|---|---|
| `phrase_first` (default, `onboarding.default_path`) | «Скажите одну фразу — я сразу сделаю» | S03 phrase → `POST /chat/messages` (or `POST /items` in «Без ИИ») → S04 result → `POST /onboarding/suggested-pages` → S35 with 2–3 ticks → «Подходит» = `POST /pages/batch` |
| `gallery` | a template card or «Все шаблоны (6)» | S35 (the tapped card ticked, or nothing ticked for «Все шаблоны») → «Подходит» = `POST /pages/batch` → open the first page created |
| `blank` | «Пустая страница» | `POST /pages/batch {"path": "blank"}` → open «Моя страница» |

- **Nothing chosen and the app was closed** (US-33): when the app opens again and
  `GET /onboarding` says `path: null`, call `POST /pages/batch {"path": "skipped"}` and go to
  «Сегодня». S41 is not shown again. «Пропустить» on S35 is the same call.
- «Без ИИ»: all three paths work; path 3 is typed (no microphone).
- Every record is in the shared memory and on «Сегодня»/search even before a fitting page exists.
- Events stay the phone's (`docs/api/events.md`): `onboarding_step`, `onboarding_path_chosen`,
  `pages_selected`, `first_value` (`seconds_from_open`, `seconds_from_path`, `path`). The server
  sends none of these.

## `GET /v1/onboarding`

```json
{
  "default_path": "phrase_first",
  "paths_enabled": ["gallery", "blank", "phrase_first"],
  "path": null,
  "done_at": null,
  "welcome_seen_at": null,
  "default_templates": ["notes", "tasks"],
  "max_marked": 3
}
```
- `default_path` / `paths_enabled`: server flags `ONBOARDING_DEFAULT_PATH`,
  `ONBOARDING_PATHS_ENABLED`. The default path's card is the big `accent` one, on top, focused.
  A path not in `paths_enabled` is not shown. Cache the last answer for offline starts; if there
  is none, use the values above.
- `path`: what this account chose (`gallery | blank | phrase_first | skipped`), `null` until the
  first onboarding `POST /pages/batch`. `done_at`: when that happened.
- `default_templates`: the set S35 ticks on path 3 and what `skipped` adds.

## `PATCH /v1/onboarding`

`{"welcome_seen": true}` → the same object, `welcome_seen_at` set (once; a repeat keeps the first
time). Send it after S05 (before consent the API serves only consents); it is only for metrics.

## `POST /v1/onboarding/suggested-pages`

Which cards S35 ticks on path 3. **Code only, no model call, nothing stored**: the phrase is read
once and dropped, never logged.

```json
{"phrase": "Сделай КП для клиента Ерлана", "intro_marks": ["kp"]}
```
- `phrase` (optional, ≤2000 chars): the first phrase as the person said or typed it (for voice,
  the transcript shown in S04).
- `intro_marks` (optional): lines ticked on the welcome frame 2 (S02): `remind`, `photo_receipt`,
  `find`, `kp`, `expenses`. Unknown values are ignored.

`200`:
```json
{"template_keys": ["notes", "tasks", "documents"],
 "reasons": {"notes": "default", "tasks": "default", "documents": "phrase"}}
```
Rule (3.11, product 4.1), in this order, at most `max_marked` (3) in all:
1. `notes`, `tasks` (always).
2. From the phrase, in this order: «КП», «коммерческое предложение», «клиент…», «смет…»
   (KK «КҰ», «коммерциялық») → `documents`; «купи», «купить», «куплю», «купите», «купим»,
   «докупить», «прикупить», «закупить», «покупк…» («список покупок»), «в магазин» / «до
   магазина» (KK «сатып ал…», «дүкенге», «дүкеннен») → `shopping` — a plan to buy: «купил»,
   «купила» (past) tick nothing by themselves, and a word like «покупатель» or «магазин закрыт»
   does not count; «тенге», «тг», «₸», «потратил…», «заплатил…», «расход…», a number with «тыс» /
   «к» before a currency (KK «теңге», «жұмсадым») → `expenses`. «Купить хлеб на 500 тг» ticks
   `shopping` (a plan beats its price); «купил телевизор за 200 000 тенге» ticks `expenses`.
3. From `intro_marks`: `kp` → `documents`; `expenses`, `photo_receipt` → `expenses`.
Words match at the start of a word, ignoring case and «ё/е». The same cases are in
`docs/spec/vectors/onboarding-marks.json`; the phone may run the rule itself offline and must get
the same answer for every vector.

## `POST /v1/pages/batch`

S35 «Подходит» / «Пропустить», S41 «Пустая страница», and «Мои страницы → Добавить (N)».
One request, **one action** with «Отменить».

```json
{"client_id": "uuid", "path": "phrase_first",
 "template_keys": ["notes", "tasks", "documents"], "title": null}
```
| `path` | `template_keys` | Creates | `created_by` |
|---|---|---|---|
| `phrase_first` | 1–6 keys | those pages | `onboarding_phrase` |
| `gallery` | 1–6 keys | those pages | `onboarding_gallery` |
| `blank` | ignored | one `custom` page, `title` or «Моя страница» | `onboarding_blank` |
| `skipped` | ignored | `default_templates` (Заметки + Дела и напоминания) | `onboarding_skipped` |
| `catalog` | 1–6 keys | those pages (from «Мои страницы»; onboarding state is not touched) | `user` |

- Keys: `notes | tasks | shopping | documents | expenses | custom`; each at most once
  (`custom` gets «Моя страница» or `title`, 1–60 chars). Order of the tabs = order of the keys.
- A topic that already has a live page is not added again: it comes back in `existing` (S35
  «Уже есть ✓ [Открыть]»). A removed one comes back with its old order and rows (as `POST /pages`).
- Each page is filled at once from what memory already holds, so the first phrase's record is
  already on its page.
- The first call with an onboarding `path` (anything but `catalog`) sets `onboarding.path` and
  `done_at`; later calls do not change them.
- Idempotent by `client_id`: a repeat returns the same pages with `repeated: true` and no new
  action.

`201`:
```json
{
  "pages": [PageOut],
  "existing": [{"template_key": "notes", "page_id": "uuid"}],
  "action": Action,
  "repeated": false,
  "onboarding": Onboarding
}
```
- `pages`: the pages created or brought back by this call, in tab order. Open `pages[0]` on path 1
  and 2.
- `action`: `kind: "create_screen"`, `summary.ru` «Добавил 3 страницы» («Добавил страницу
  «Заметки»» for one). «Отменить» = `POST /v1/actions/{action.id}/undo`: every page of this call
  goes away again; records stay. `null` when nothing was created (all already there).
- `200` instead of `201` on a repeat, or when nothing was created.

Errors: `422 template_unknown` (also `today`) · `422 validation_error` (no keys for
`gallery` / `phrase_first` / `catalog`, a key twice, more than 6, `path` not enabled) ·
`422 pages_limit` (the call would pass 20 pages including «Сегодня»; nothing is created).

## Page proposals from the assistant (R-55)

The assistant makes a page only when asked («сделай страницу для ремонта» on the line, `chat.md`,
done at once with «Отменить»), or after «Да» on a proposal. Proposals are `Suggestion`s on
«Сегодня» (`today.md`), inside the R-35 limits (≤2 proposals on screen, 24 h, then silently
`expired`), and besides that:
- **at most one page proposal a week** per account (whatever happened to the last one);
- **never in the first 10 minutes** after the account was created;
- each topic is proposed once, ever.

| `key` (`kind: data_proposal`) | Shown when | `text_ru` | [Да] (`do.type: "accept"`) |
|---|---|---|---|
| `page_from_stack` | a stack (`stacks.md`) has ≥10 live records and no live page of that name exists | «Про «Ремонт» уже 14 записей. Сделать страницу «Ремонт»?» | a new «Своя страница» with the stack's records; the stack leaves its page (records stay there, out of the group) |
| `add_documents_page` | the company profile is filled and there is no live «Документы и КП» page | «Добавить страницу «Документы и КП»?» | adds that page (or brings the removed one back) |

`yes_label`: «Да, сделать» / «Да, добавить»; `no_label`: «Не сейчас». `payload` is not sent.

`POST /v1/suggestions/{id}/accept` on these returns, besides the usual fields,
`"page": PageOut` (open it, highlight the new tab 600 ms) and `action` (`create_screen`,
`initiated_by: "agent"`, «Страница «Ремонт» добавлена»; «Отменить» takes the page away and, for
a stack, brings the stack back). Errors as usual, plus `422 pages_limit`.

New tip (`kind: tip`): `add_ready_pages` — account chose `blank`, from its 2nd day, once:
«Добавить готовые страницы?», `yes_label` «Посмотреть», `do: {"type": "open_gallery"}` (S35 from
«Мои страницы»).

## «Сегодня»: page tiles (Ф-32, template-screens 2.7)

`GET /v1/today` gets `page_tiles` and the section name `page_tiles` (after `today`):
```json
"page_tiles": [
  {"page_id": "uuid", "template_key": "shopping", "title": "Покупки", "icon": "shopping",
   "text_ru": "Осталось 5", "pinned": false},
  {"page_id": "uuid", "template_key": "expenses", "title": "Расходы", "icon": "money",
   "text_ru": "Сегодня 7 500 ₸", "pinned": true}
]
```
Rule (code, no model):
- At most 2. **In the first 7 days of the account the rule picks none**; a tile the person pinned
  by hand shows from day one (what is set by hand is the person's). Hidden by hand stays hidden.
- A page shows a tile by itself only when it has something for today:
  «Покупки» — not-bought items («Осталось 5»); «Расходы» — any spending in the last 7 days
  («Сегодня 7 500 ₸», each currency apart: «Сегодня 7 500 ₸ · 20 $»); «Документы и КП» — КП sent
  and waiting for an answer («КП ждут ответа: 2»). «Дела» are already in the day list, so no tile;
  «Заметки» and «Своя страница» only when pinned.
- Pinned tiles come first (in tab order), then the others in tab order. A hidden page never shows
  a tile. A pinned page with nothing for today still shows its tile («Всё куплено», «Сегодня трат
  нет», «Записей: 12»).
- The phone builds the same from its local data offline.

### `PUT /v1/pages/{id}/today-tile`
«⋯ Ещё → Показывать на Сегодня / Не показывать» (S34 or the tile).
```json
{"mode": "pinned", "client_id": "uuid"}
```
`mode`: `auto` (by the rule) | `pinned` | `hidden`; stored as `page.view_state.today_tile`
(absent = `auto`). Returns `PageOut` + `"action": Action | null` (`screen_customize`,
«Показываю «Покупки» на Сегодня» / «Не показываю «Покупки» на Сегодня» / «Плитка «Покупки» — как
обычно»; «Отменить» puts the old mode back; `null` when nothing changed; a `client_id` repeat
returns the first action). Errors: `403 page_system` («Сегодня») · `404 not_found`.
