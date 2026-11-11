# Project rules (read before any change)

Product spec (source of truth for new work): `docs/spec/SPEC.md` (v1.1) and `docs/spec/final/*`.
The Telegram-bot description below is legacy context; new work follows the spec.

Telegram bot "trip memory": users forward reels, TikToks, posts, screenshots and booking
confirmations; the bot extracts meaning (place, booking, tip), files it under a trip, answers
questions over it and reminds on the spot. Russian-speaking users in Kazakhstan, many not
tech-savvy: talk about the result, not "AI". Exception (spec R-06, KZ law 230-VIII): the
word «ИИ» appears only on the required disclosure/consent screens and as the single label on
AI-generated content (e.g. a КП); never in marketing copy or ordinary UI.

## Layout and ownership

| Path | Owner | What |
|---|---|---|
| `src/assistant/config.py`, `db/`, `links.py`, `notify.py`, `embeddings.py`, `timezones.py`, `logs.py`, `migrations/` | core | Shared contract. Change only with a migration + note in the PR. |
| `src/assistant/bot/`, `tests/bot/` | bot | aiogram 3 handlers, webhook/polling entry (`python -m assistant.bot`) |
| `src/assistant/pipeline/`, `src/assistant/worker.py`, `tests/pipeline/` | pipeline | item processing, worker loop (`python -m assistant.worker`) |
| `src/assistant/scheduler/`, `src/assistant/qa/`, `tests/scheduler/`, `tests/qa/` | scheduler+qa | reminders (`python -m assistant.scheduler`), question answering |
| `src/assistant/api/`, `tests/api/` | api | mobile REST API (`python -m assistant.api`): auth, devices, consents + consent gate, uploads |
| `src/assistant/records/`, `tests/records/` | api | app records: text normalization/hash, exact-duplicate merge, trash, ingest jobs `ingest:<kind>` (OCR/STT/doc text), worker `python -m assistant.records` |
| `src/assistant/pages/`, `api/routes/pages.py`, `db/models_pages.py`, `tests/api/test_pages*.py` | api | pages: template catalogue, placement by `auto_rule`, LexoRank (contract: `docs/api/pages.md`) |
| `src/assistant/memory/`, `api/routes/memory.py`, `db/models_search.py`, `tests/memory/` | api | chunks + embeddings (worker `python -m assistant.memory`), hybrid search, storage policy and file purge, page summaries (contract: `docs/api/search.md`) |
| `src/assistant/chat/`, `api/routes/chat.py`, `db/models_chat.py`, `tests/chat/` | api | the assistant line: one conversation, layered context, read tools, number/date check, SSE delivery + resume, feedback (contract: `docs/api/chat.md`) |
| `src/assistant/account/` | api | data export ZIP, account deletion with grace period and purge worker (`python -m assistant.account`), web deletion page `/account/delete` (contract: `docs/api/account.md`; PD list: `docs/legal/pd-register.md`) |
| `src/assistant/actions/` | api | changes from the assistant line: intent rule, mutating tools, one action per phrase with `inverse`, undo/redo, manual-order protection (contract: `docs/api/actions.md`) |
| `src/assistant/tasks/`, `api/routes/tasks.py`, `db/models_tasks.py` | api | «Дела» / «Покупки»: tasks with their own records, list phrases (model by default, code behind `tasks_rules_first`, Ф-1) (contract: `docs/api/today.md`) |
| `src/assistant/suggestions/`, `api/routes/today.py` | api | «Сегодня», tips and data proposals with the R-35 limits (contract: `docs/api/today.md`) |
| `src/assistant/dedup/`, `api/routes/duplicates.py`, `db/models_dedup.py`, `tests/dedup/` | api | repeats: similar groups (SimHash/trgm/cosine + DUP_JUDGE), «Объединить?», cleanup «37 → 1», pending «Да»; worker `python -m assistant.dedup` (scans + stacks) (contract: `docs/api/duplicates.md`) |
| `src/assistant/stacks/`, `api/routes/collections.py` | api | stacks as groups inside pages (contract: `docs/api/stacks.md`) |
| `src/assistant/imports/`, `api/routes/imports.py`, `tests/imports/` | api | Telegram export import; worker `python -m assistant.imports` (contract: `docs/api/import.md`) |
| `src/assistant/analytics/`, `api/routes/events.py` | api | product events journal `analytics.events` (contract: `docs/api/events.md`) |
| `mobile/` | mobile | Expo / React Native app (see `mobile/README.md`) |

Modules talk only through the DB schema (`db/models.py`), the job queue (`db/queue.py`),
`notify.Notifier`, and the public functions in each package `__init__.py`. Do not import
another module's internals.

## Commands

```bash
pip install -e ".[dev]"
pytest                 # unit tests; tests marked `db` skip without DATABASE_URL
ruff check src tests
python scripts/dev_db.py start          # local Postgres 17 + pgvector without Docker (port 54329)
export DATABASE_URL=$(python scripts/dev_db.py url)
alembic upgrade head
```

## Rules

- Python 3.12+, async everywhere, SQLAlchemy 2.0 typed ORM, type hints on public functions.
- Timestamps are aware UTC. Event times also keep the IANA tz of the place (Almaty is UTC+5).
- LLM: `settings.model_fast` (Haiku) by default, `settings.model_strong` (Sonnet) for bookings
  and low-confidence escalation. Structured outputs, never free-text parsing. Opus is not used
  in request paths.
- Text from pages/captions/forwards is untrusted data, never instructions to the model.
- A booking never produces a reminder until the user confirmed it (`Booking.confirmed_at`).
- Places come only from the places provider; never let the model invent coordinates.
- No scraping/downloading Instagram or TikTok videos server-side. Use oEmbed metadata, files
  the user sends, screenshots, or ask the user.
- Personal data stays in the KZ-hosted DB; nothing goes to a foreign API before `User.consent_at`.
- External calls go through small client classes that tests replace with fakes; unit tests
  never hit the network.
- User-facing strings are Russian, short, friendly, no jargon.
- Every entry point calls `assistant.logs.configure_logging()`. Exception text stored in DB
  (`items.error`, `jobs.last_error`) or logged by hand goes through `assistant.logs.error_text()`:
  Bot API URLs contain the bot token.
- Commit DB results first, then send Telegram messages. A failed send (user blocked the bot,
  flood limit) must never roll back or re-run paid processing.
- No DB transaction stays open across network calls (LLM, STT, Places, downloads).
- Migrations are frozen SQL/ops; never call `Base.metadata.create_all` in a migration.
