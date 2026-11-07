"""Fixtures for the AI layer: settings without .env, a small route table, fake clocks."""

from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest
from pydantic import BaseModel

from assistant.ai import FakeAdapter, MemoryAIStore, Router, RouteTable
from assistant.ai.breaker import CircuitBreaker
from assistant.config import Settings

NOW = datetime(2026, 11, 7, 6, 0, tzinfo=UTC)  # 11:00 in Almaty


class Note(BaseModel):
    title: str
    phone: str | None = None
    confidence: float = 0.5


def make_settings(**kw) -> Settings:
    base = dict(
        anthropic_api_key="", openai_api_key="", google_api_key="", groq_api_key="",
        ai_primary_provider="anthropic", ai_fallback_provider="openai",
        ai_provider_monthly_usd={"anthropic": 100.0},
        ai_fallback_share_of_primary=0.5, ai_fallback_emergency_daily_usd=15.0,
    )  # fmt: skip
    base.update(kw)
    return Settings(_env_file=None, **base)


ROUTES = {
    "models": {
        "anthropic": {"light": "claude-haiku-5-5", "strong": "claude-sonnet-5-5"},
        "openai": {"light": "gpt-5-mini", "strong": "gpt-5"},
        "google": {"light": "gemini-2.5-flash", "strong": "gemini-2.5-pro"},
    },
    "prices": {
        "claude-haiku-5-5": {"in": 1.0, "out": 5.0, "cached_in": 0.1, "cache_write": 1.25},
        "claude-sonnet-5-5": {"in": 2.0, "out": 10.0, "cached_in": 0.2, "cache_write": 2.5},
        "gpt-5-mini": {"in": 0.25, "out": 2.0, "cached_in": 0.025, "cache_write": 0.25},
        "gpt-5": {"in": 1.25, "out": 10.0, "cached_in": 0.125, "cache_write": 1.25},
        "gemini-2.5-flash": {"in": 0.3, "out": 2.5, "cached_in": 0.03, "cache_write": 0.3},
        "default": {"in": 5.0, "out": 25.0, "cached_in": 5.0, "cache_write": 5.0},
    },
    "defaults": {"tier": "light", "timeout_s": 0.2, "max_tokens": 1000, "mask_contacts": True,
                 "chain": ["primary", "fallback"]},
    "tasks": {
        "enrich": {"budget_class": "background", "escalate": "strong", "mask_contacts": False},
        "dup_judge": {"budget_class": "background"},
        "answer": {"budget_class": "answers", "escalate": "strong"},
        "chat": {"budget_class": "answers", "escalate": "strong"},
        "kp_extract": {"budget_class": "documents", "tier": "strong"},
        "import_summarize": {"budget_class": "import"},
        "vision_ocr": {"budget_class": "background", "chain": ["google", "primary"]},
    },
}  # fmt: skip


class Clock:
    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t


@dataclass
class Env:
    router: Router
    store: MemoryAIStore
    adapters: dict[str, FakeAdapter]
    alerts: list[str]
    sleeps: list[float]
    mono: Clock
    settings: Settings
    now: list[datetime] = field(default_factory=lambda: [NOW])


def make_env(adapters: dict[str, FakeAdapter], *, settings: Settings | None = None,
             user_id: int | None = 1, profile: str = "regular",
             consent: frozenset[str] | None = frozenset({"anthropic", "openai", "google",
                                                         "groq"})) -> Env:  # fmt: skip
    settings = settings or make_settings()
    store = MemoryAIStore()
    if user_id is not None:
        store.profiles[user_id] = profile
        store.consents[user_id] = consent
    alerts: list[str] = []
    sleeps: list[float] = []
    mono = Clock()

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    now = [NOW]
    router = Router(
        settings=settings, routes=RouteTable(ROUTES, settings), adapters=dict(adapters),
        store=store, alert=alerts.append, clock=lambda: now[0], monotonic=mono,
        sleep=fake_sleep,
        breaker=CircuitBreaker(failures=settings.ai_breaker_failures,
                               window_s=settings.ai_breaker_window_s,
                               open_s=settings.ai_breaker_open_s, clock=mono),
    )  # fmt: skip
    return Env(router, store, adapters, alerts, sleeps, mono, settings, now)


@pytest.fixture
def settings() -> Settings:
    return make_settings()
