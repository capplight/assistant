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
    # The single label on generated content (R-06, spec 5.9), until the lawyer's opinion.
    label_ai_generated: str = "Подготовил помощник (ИИ) по вашим записям — проверьте"


@lru_cache
def get_settings() -> Settings:
    return Settings()
