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


@lru_cache
def get_settings() -> Settings:
    return Settings()
