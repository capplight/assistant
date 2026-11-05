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


@lru_cache
def get_settings() -> Settings:
    return Settings()
