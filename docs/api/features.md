# Beta scope: `GET /v1/features` (week 19, Ф-33…Ф-44)

The founder simplified the visible app after the first device test (2026-11-13,
`docs/spec/FOUNDER-DECISIONS.md` Ф-33…Ф-46, `docs/spec/proposals/simplify-scope.md`). Rule Ф-33:
**hide, don't delete.** Every switch is a server setting (env-overridable, defaults = the
founder's decisions), so a feature comes back without a new app build. The app reads them all
from one place and hides what is off.

## `GET /v1/features` → `200`

No sign-in needed (the welcome screen reads it before the account exists); nothing personal.
`Cache-Control: private, max-age=300`. The app keeps the last answer and, without one, treats
every feature as off.

```json
{
  "statements_pdf": false,
  "receipt_qr": false,
  "board": false,
  "assistant_views": false,
  "page_settings_full": false,
  "telegram_login": false,
  "personal_mail": false,
  "setup_for_other": false,
  "shopping": false,
  "consent_screen": "welcome",
  "today": {"tips_days": 7, "tips_per_day": 1, "proposals": false, "tiles": false},
  "pages": {"default": ["today", "notes", "expenses", "tasks"],
            "first_use": ["documents"]}
}
```

| Field | Setting (env) | Default | Decision | Where the server enforces it |
|---|---|---|---|---|
| `statements_pdf` | `FEATURE_STATEMENTS_PDF` | off | Ф-37 | `POST /v1/expenses/statements` → `403 feature_off` (`details.feature = "statements_pdf"`). Reading, confirming, rejecting statements made before stays. |
| `receipt_qr` | `FEATURE_RECEIPT_QR` | off | Ф-37 | `POST /v1/expenses/from-qr` → `403 feature_off` (`details.feature = "receipt_qr"`). Receipt photo / Kaspi receipt stay. |
| `board` | `FEATURE_BOARD` | off | Ф-38 | Report only: the board API (`views.md`, `board` in a view) stays; the app shows «Ряды» only. |
| `assistant_views` | `FEATURE_ASSISTANT_VIEWS` | off | Ф-39 | The line's model step is not offered `set_view`; «раскрась по темам» by code is not run. The answer: «Так пока не умею — вид страницы меняется в «⋯».» (`chat.md`). Renaming a page or changing its icon by asking still works (tool `rename_page`, same action and «Отменить»). Proposals made before still run on «Да». |
| `page_settings_full` | `FEATURE_PAGE_SETTINGS_FULL` | off | Ф-40 | Report only: «Настроить страницу» shows name, icon, view. `PATCH /v1/pages/{id}` / views keep accepting every field. |
| `telegram_login` | `FEATURE_TELEGRAM_LOGIN` | off | Ф-43 | Report only (not built yet). Telegram import from a file stays. |
| `personal_mail` | `FEATURE_PERSONAL_MAIL` | off | Ф-43 | Report only (not built yet). |
| `setup_for_other` | `FEATURE_SETUP_FOR_OTHER` | off | Ф-44 | Report only: no «Настраиваю для другого человека» on the first screen. |
| `shopping` | `FEATURE_SHOPPING` | off | Ф-49 (week 20) | Off: no «Покупки» page and no «Я в магазине». Every new thing to buy (the line «купить молоко, хлеб», `POST /v1/tasks` with `list_key: "shopping"`) is a to-do on «Дела»: `list_key: "todo"`, title «Купить молоко» (qty / where appended: «Купить хлеб, 2 шт»). «Покупки» is never made by the server; `GET /v1/today` has `today.shopping: null`. Shopping tasks made before stay (no data is deleted). «купил молоко за 600» is an expense on «Расходы» as before. |
| `consent_screen` | — | `welcome` | Ф-34 | The `screen` value for `POST /v1/consents` sent by «Начать» (`auth.md`). |
| `today.tips_days` | `TODAY_TIPS_DAYS` | 7 | Ф-42 | No tip once the account is this many days old (0 = no age limit). |
| `today.tips_per_day` | `TODAY_TIPS_PER_DAY` | 1 | Ф-42 | At most this many tips a day (caps the R-35 numbers). |
| `today.proposals` | `FEATURE_TODAY_PROPOSALS` | off | Ф-42 | `GET /v1/today` / `GET /v1/suggestions`: `proposals: []`, none are made (data and page proposals). |
| `today.tiles` | `FEATURE_TODAY_TILES` | off | Ф-42 | `GET /v1/today`: `page_tiles: []` (pinned ones too). `PUT …/today-tile` still saves. |
| `pages.default` | `PAGES_DEFAULT_KEYS` | today, notes, expenses, tasks | Ф-35, Ф-48 | «Сегодня» comes with the account; «Заметки», «Расходы», «Дела» (in this tab order) are made by `POST /v1/pages/batch` `{"path": "skipped"}` (`onboarding.md`). An account made before Ф-48 gets «Расходы» once, lazily: the first `GET /v1/pages`, `/v1/sync` or `/v1/today` after its first launch adds it at the end of the tabs (`created_by: "system"`; it reaches the phone by sync). Never when the person has or had one (removed stays removed). |
| `pages.first_use` | `PAGES_ON_FIRST_USE`, `PAGES_FIRST_USE_KEYS` | documents (+ shopping with `shopping` on) | Ф-35, Ф-36, Ф-49 | See below. A default page is never listed here. Empty when `PAGES_ON_FIRST_USE=false`. |

## Pages made on first use (Ф-35, Ф-36)

Week 20: «Расходы» is a default page (Ф-48) and «Покупки» is hidden (Ф-49), so only «Документы»
(Ф-51: was «Документы и КП») is made this way by default. «Покупки» (with `shopping` on),
«Документы» are not made on the first launch. The server makes one when
its first record arrives, from any path (the line, `POST /v1/tasks`, `POST /v1/expenses`, a
receipt, a КП):

| Page | Its first record |
|---|---|
| `shopping` | the first thing to buy (a task with `list_key: "shopping"`); before, things to buy went to «Дела» |
| `expenses` | the first expense |
| `documents` | the first КП |

- Made once per kind: never when the person has a page of that kind, or had one and removed it
  (`users.pages_first_use`, migration 0025, remembers what the server made), nor over 20 pages.
  Then the record goes where it went before.
- The page is added at the end of the tabs (`created_by: "system"`) and filled by its rule; it
  reaches the phone by sync and `page_patches`.
- The action of that record gets one more `changes` row
  `{"kind": "create_page", "item_id": null, "page_id": …, "title": "Покупки",
  "text": "Новая страница «Покупки»"}`: the app may offer «Показать вкладку?». «Отменить» takes
  the record back, the page stays.

## The message limit

Not a feature switch, but set the same way: see `chat.md` «Message limit».
