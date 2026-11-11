"""Settings come from environment variables (or .env). See .env.example."""

from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Telegram
    bot_token: SecretStr = Field(default=SecretStr(""))
    # Empty = long polling (local dev); set to a public https URL for webhook mode.
    webhook_base_url: str = ""
    webhook_secret: SecretStr = Field(default=SecretStr(""))
    # Local Bot API server lifts the 20 MB download limit; empty = api.telegram.org.
    telegram_api_base: str = ""

    # Database (must live in Kazakhstan in production: personal data law 94-V, art. 12)
    database_url: str = "postgresql+asyncpg://assistant:assistant@localhost:5432/assistant"

    # Instagram oEmbed: Meta dropped the token requirement on 2026-06-15; set one if that changes.
    instagram_oembed_token: SecretStr = Field(default=SecretStr(""))

    # LLM. Haiku for routine extraction/answers, Sonnet for bookings and escalation.
    anthropic_api_key: SecretStr = Field(default=SecretStr(""))
    model_fast: str = "claude-haiku-5-5"
    model_strong: str = "claude-sonnet-5-5"
    # Below this extraction confidence the worker escalates to model_strong, then asks the user.
    escalate_below_confidence: float = 0.6

    # Speech-to-text (Claude has no audio input)
    stt_provider: str = "groq"  # groq | openai | none
    stt_api_key: SecretStr = Field(default=SecretStr(""))

    # Embeddings (Anthropic has none). Dim must match items.embedding vector(1024).
    embeddings_provider: str = "voyage"  # voyage | none
    embeddings_api_key: SecretStr = Field(default=SecretStr(""))
    embeddings_model: str = "voyage-3.5"
    embeddings_dim: int = 1024

    # Embeddings for chunks and search: local TEI + bge-m3 (spec 5.5), never a foreign provider.
    # Empty URL: no embeddings, search runs on words and typos.
    chunk_embedder: str = "tei"  # tei | none
    tei_url: str = ""
    chunk_embedding_model: str = "BAAI/bge-m3"  # migration 0009's HNSW index is for this one

    # Search (docs/api/search.md). Both numbers are UNVERIFIED until tried on the real model.
    search_embed_timeout_seconds: float = 0.5  # slower than this: answer without meaning (spec 8.1)
    search_vector_min_similarity: float = 0.45  # below this a neighbour is not a result (US-5)

    # Originals (spec 7.1, decision 8, Ф-5)
    storage_trash_days: int = 7
    storage_pin_enabled: bool = True
    storage_keep_while_unsure: bool = True

    # Place resolution
    places_provider: str = "google"  # google | none
    places_api_key: SecretStr = Field(default=SecretStr(""))

    # Free tier
    free_items_per_month: int = 30

    # Workers
    worker_concurrency: int = 4
    worker_poll_seconds: float = 1.0
    scheduler_tick_seconds: float = 60.0

    log_level: str = "INFO"

    # Mobile REST API (python -m assistant.api)
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    # Public base URL of this API; the local storage stub builds upload URLs from it.
    api_public_base_url: str = "http://127.0.0.1:8000"
    # Dev only: fixed fallback secrets, OTP code echoed in the response. Never in prod.
    api_dev_mode: bool = False
    jwt_secret: SecretStr = Field(default=SecretStr(""))
    # HMAC key for device keys, phones, IPs (subject_hash, phone_hash, ip_hash).
    hash_key: SecretStr = Field(default=SecretStr(""))
    access_token_minutes: int = 15
    refresh_token_days: int = 60
    sms_provider: str = "fake"  # fake | mobizon | smsc (only fake exists yet)

    # Object storage (S3 in KZ). "local" = filesystem stub served by the API itself (dev).
    storage_backend: str = "local"  # local | s3 (s3 not implemented yet)
    storage_local_dir: str = ".storage"
    s3_endpoint_url: str = ""
    s3_bucket: str = ""
    s3_region: str = ""
    s3_access_key: SecretStr = Field(default=SecretStr(""))
    s3_secret_key: SecretStr = Field(default=SecretStr(""))
    upload_url_ttl_seconds: int = 600
    upload_max_bytes: int = 50 * 1024 * 1024

    # Ingest worker (python -m assistant.records). OCR runs locally (Tesseract) in KZ.
    ocr_provider: str = "auto"  # auto (tesseract if on PATH, else fake) | tesseract | fake
    ocr_langs: str = "rus+kaz+eng"
    # STT for voice records uses stt_provider above: fake | groq | openai (only fake exists yet;
    # anything else leaves voice jobs retrying until a provider is wired in the AI router).

    # --- AI layer (assistant.ai, spec 3-engineering 5) ---
    # Keys come only from env / local .env (never committed, never logged).
    openai_api_key: SecretStr = Field(default=SecretStr(""))
    google_api_key: SecretStr = Field(default=SecretStr(""))  # Gemini
    groq_api_key: SecretStr = Field(default=SecretStr(""))
    # Kill switch per recipient (spec 5.1 `ai.providers_enabled`); consent filters further.
    ai_providers_enabled: list[str] = ["anthropic", "openai", "google", "groq"]
    ai_primary_provider: str = "anthropic"
    ai_fallback_provider: str = "openai"  # set by the week-0 bake-off
    # Empty = the packaged default src/assistant/ai/routes.yaml.
    ai_routes_file: str = ""
    # Our monthly spend cap per provider, USD [proposal]. 80% -> end of route, 100% -> off.
    # A provider without an entry gets share_of_primary x the primary's cap.
    ai_provider_monthly_usd: dict[str, float] = {"anthropic": 300.0}
    ai_fallback_share_of_primary: float = 0.5
    ai_fallback_emergency_daily_usd: float = 15.0
    ai_fallback_alert_minutes: float = 10.0
    # Legacy bot consents stored no provider list; the bot only ever sent data to Anthropic.
    ai_legacy_consent_providers: list[str] = ["anthropic"]
    # 429 with retry-after below this -> wait and retry the same provider once.
    ai_retry_after_max_s: float = 2.0
    # Circuit breaker per (provider, model): N errors within window -> open, then half-open.
    ai_breaker_failures: int = 5
    ai_breaker_window_s: float = 60.0
    ai_breaker_open_s: float = 120.0

    # Per-user AI budgets by users.profile (02-resolutions 2.2), USD. Day/month boundaries
    # are computed in budget_tz.
    budget_tz: str = "Asia/Almaty"
    budget_family_alert_daily_usd: float = 0.50
    budget_regular_background_daily_usd: float = 0.10
    budget_regular_monthly_usd: float = 3.0
    budget_work_background_daily_usd: float = 0.10
    budget_work_monthly_usd: float = 8.0
    # Work profile: documents (KP, TZ) are a separate wallet, no daily threshold [proposal:
    # the spec gives no number for this wallet].
    budget_work_documents_monthly_usd: float = 8.0
    budget_import_once_usd: float = 1.0
    # At this share of the monthly budget: no escalation to strong models.
    budget_escalation_cutoff: float = 0.8
    # Escalations to the strong model per user per day (ai/policy.py) [proposal]. KP tasks run
    # strong by route and are not counted here. Over the cap the task runs on the light model.
    ai_strong_daily_per_user: int = 20
    # Provider batches (routes.yaml `batch`): how often the worker sends what has queued up.
    ai_batch_flush_seconds: float = 300.0
    ai_batch_flush_min_requests: int = 50  # this many waiting: send without waiting further
    ai_batch_poll_seconds: float = 300.0
    # A user's records per sending. The next ones wait until these are charged, so a big import
    # cannot overrun a wallet before its first results arrive.
    ai_batch_user_requests: int = 200
    # The assistant line (spec 5.10, R-56): input cap per step (estimated tokens), tool steps per
    # phrase, and how long a `pending` answer may sit with nobody writing it (server restart)
    # before a resume marks it failed.
    chat_max_input_tokens: int = 12000
    chat_max_tool_steps: int = 4
    chat_stale_pending_seconds: float = 120.0
    # Big semantic reorders (>150 records, PAGE_GROUP) per person per day (spec 5.10 rule 8,
    # `limits.ai_reorder_per_day`, counter `ai_reorders`).
    chat_big_reorders_per_day: int = 3
    # Reminders (week 8, spec 6.6). Founder decision Ф-1 («сначала код») is open: off = every
    # phrase goes to the model (`reminder_parse`, needs ai_cross_border consent; «Без ИИ» and
    # offline get the manual form). On = code reads simple phrases first (reminders.rules),
    # the model only gets what code did not understand. Env REMINDERS_RULES_FIRST=true.
    reminders_rules_first: bool = False
    reminders_tick_seconds: float = 30.0  # backup push / missed / top-up loop
    # Tasks and shopping from the line (week 9). Ф-1 is open, so off: the light model reads the
    # phrase (`tasks_parse`, behind the consent gate). On = code reads simple lists first
    # («купить хлеб, молоко и сыр», «добавь в покупки …»). Env TASKS_RULES_FIRST=true.
    tasks_rules_first: bool = False
    # Expenses from a phrase (week 12, «потратил 5000 на бензин»). Ф-1 is open, so off: the light
    # model reads the phrase (`expense_parse`, behind the consent gate) and code checks that the
    # amount is in the person's words. On = code reads the phrase first (expenses.parse, the
    # shared vectors docs/spec/vectors/amounts.json). The keypad sum is code always (arithmetic).
    # Env EXPENSES_RULES_FIRST=true.
    expenses_rules_first: bool = False
    # «Расходы 2» (week 13): fiscal receipt QR links are accepted only for these OFD hosts and
    # their subdomains (spec 5.7 rule 7) [проверить список ОФД на нед. 0]; the server fetches the
    # OFD page (SSRF-guarded) only when `expenses_ofd_fetch`. Env EXPENSES_OFD_DOMAINS='["..."]'.
    expenses_ofd_domains: list[str] = ["oofd.kz", "ofd1.kz", "kofd.kz", "wofd.kz"]
    expenses_ofd_fetch: bool = True
    # Suggestions (spec 3.4, R-35, R-08): tips per day, pause after «Не сейчас», data proposals.
    suggestions_tips_per_day_new: int = 2  # the first `suggestions_new_days` days of the account
    suggestions_tips_per_day: int = 1
    suggestions_new_days: int = 14
    suggestions_dismiss_pause_days: int = 30
    suggestions_dismiss_limit: int = 2
    suggestions_proposals_max: int = 2
    suggestions_proposal_hours: int = 24
    # Repeats (week 10, spec 6.3). Similar ones are only ever suggested («Объединить?» per group):
    # `dedup_auto_merge_near` is the spec's switch and stays off (nothing else reads it yet).
    dedup_auto_merge_near: bool = False
    dedup_scan_delay_seconds: float = 60.0  # a scan waits this long after the last change
    dedup_judge_per_scan: int = 50  # DUP_JUDGE calls per scan at most; the rest wait for the next
    # Stacks (week 10, spec 6.4): a stack shows up at this many records with one key.
    stacks_min_records: int = 5
    stacks_per_rebuild: int = 3  # new stacks per rebuild at most, so a big import is not noisy
    # Ф-1 is open, so off: a stack's name is written by the light model (STACK_NAME, behind the
    # consent gate). On = code names it after its key («Ремонт», «Чеки»). Env STACKS_NAMES_BY_CODE.
    stacks_names_by_code: bool = False
    # Telegram import from a Telegram Desktop export (week 10, spec 6.10). The export file comes
    # through /v1/uploads (<= upload_max_bytes); these bound what is read out of it.
    import_max_json_bytes: int = 64 * 1024 * 1024  # result.json, also inside a zip
    import_max_zip_members: int = 20000  # a zip with more entries is refused
    import_max_zip_ratio: int = 100  # result.json packed more tightly than 1:100: refused
    import_max_messages: int = 50000
    import_enrich_wave: int = 50  # records sent to enrichment at a time (IMPORT_SUMMARIZE)
    # Sync tombstones are kept this long (founder 2026-11-09; the spec gives no number). A phone
    # that last synced before the oldest one kept gets `full_resync` (docs/api/sync.md).
    sync_tombstone_days: int = 90
    # Product events (R-40): `user_pseudo` = HMAC(user_id) with this key, not hash_key.
    analytics_hash_key: SecretStr = Field(default=SecretStr(""))
    # The single label on generated content (R-06, spec 5.9), until the lawyer's opinion.
    label_ai_generated: str = "Подготовил помощник (ИИ) по вашим записям — проверьте"

    # КП (week 14, spec 6.7, contract docs/api/kp.md). Sums, VAT and the sum in words are code
    # only (kp/calc.py, kp/words.py). VAT rate by date (Ф-18, founder 2026-11-10: 16% confirmed;
    # the rules for an ИП without VAT are still open, so «без НДС» stays a mode). A new rate is a
    # new row with its own `from`. Env KP_VAT_RATES='[{"rate": "16.00", "from": "2026-01-01"}]'.
    kp_vat_rates: list[dict[str, str]] = [{"rate": "16.00", "from": "2026-01-01"}]
    kp_vat_default_mode: str = "included"  # included («в сумме») | on_top («сверху») | none
    kp_vat_rounding: str = "on_total"  # on_total | per_line
    # Ф-17 (observed in the founder's father's 5 real КП, 2026-11-11; pending his confirmation):
    # the file is not made while one of these is empty. Keys: number, date, outgoing («Исх. № …
    # от …»), validity, seller.name, seller.bin_iin, seller.address, seller.bank (ИИК + БИК + Кбе),
    # buyer.name, buyer.bin, items (a line), items.unit, total, vat, amount_words, signer (name +
    # position), license, subject, signature_stamp (= printed when uploaded; never blocks).
    # Optional by default: buyer.bin, license, subject, conditions, stamp/signature images.
    # Env KP_REQUIRED_FIELDS='["number", ...]'.
    kp_required_fields: list[str] = ["number", "date", "outgoing", "validity", "seller.name",
                                     "seller.bin_iin", "seller.address", "seller.bank",
                                     "buyer.name", "items", "total", "vat", "amount_words",
                                     "signer", "signature_stamp"]  # fmt: skip
    kp_words_langs: list[str] = ["ru"]  # the sum in words on the PDF: ru, kk or both
    kp_number_prefix: str = "КП"  # «КП-2026-014»
    # the father's КП: «действительно 60 календарных дней» (a profile's default_terms wins)
    kp_validity_days: int = 10
    # Spec 5.9: the visible «ИИ» line on the PDF waits for the lawyer; metadata always carry it.
    kp_visible_ai_label: bool = False
    kp_ai_metadata: str = "Подготовлено с помощью ИИ"
    kp_keep_sent_render: bool = True  # week 15 (Ф-5, R-25): the sent version's PDF is kept
    # US-12: <= 5 new КП a day on the strong model, then «продолжу завтра» before a new one starts.
    kp_per_day: int = 5
    kp_single_pass_positions: int = 60  # spec 6.7 step 1: up to 60 positions in one pass
    kp_single_pass_chars: int = 60_000  # ~20 pages of text
    kp_chunk_positions: int = 40  # bigger ТЗ: parts of 40 with «Обработал 120 из 240»
    kp_max_positions: int = 600
    kp_match_candidates: int = 5  # price candidates per position the model may choose from
    # AES-256-GCM key for БИН/ИИН and bank details of the company profile (base64 of 32 bytes).
    kp_field_key: SecretStr = Field(default=SecretStr(""))


@lru_cache
def get_settings() -> Settings:
    return Settings()
