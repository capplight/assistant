"""External clients used by the pipeline, built once from settings; tests inject fakes."""

import inspect
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import anthropic

from assistant.config import Settings, get_settings
from assistant.embeddings import Embedder, get_embedder
from assistant.pipeline.geo import load_zone
from assistant.pipeline.inputs import Gatherer
from assistant.pipeline.llm import AnthropicExtractor, Extractor
from assistant.pipeline.logic import ZoneLoader
from assistant.pipeline.media import MediaExtractor
from assistant.pipeline.oembed import LinkMetadataClient
from assistant.pipeline.places import GooglePlacesClient, PlaceResolver
from assistant.pipeline.stt import build_transcriber
from assistant.pipeline.telegram_files import TelegramFiles

log = logging.getLogger(__name__)

# Per LLM request. Worst case per item: 2 models x (1 + retries) x timeout = 12 min, far below
# the queue's 30-minute STALE_AFTER, so a slow job is never reclaimed while still running.
LLM_TIMEOUT = 120.0
LLM_MAX_RETRIES = 2


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass
class Deps:
    gatherer: Gatherer
    extractor: Extractor
    places: PlaceResolver
    embedder: Embedder
    threshold: float = 0.6
    clock: Callable[[], datetime] = _utcnow
    zone_loader: ZoneLoader = load_zone
    _closers: list = field(default_factory=list)

    async def aclose(self) -> None:
        for obj in self._closers:
            try:
                close = getattr(obj, "aclose", None) or obj.close
                result = close()
                if inspect.isawaitable(result):
                    await result
            except Exception:
                log.debug("close failed", exc_info=True)


def build_deps(settings: Settings | None = None) -> Deps:
    s = settings or get_settings()
    anthropic_key = s.anthropic_api_key.get_secret_value()
    llm_opts = {"timeout": LLM_TIMEOUT, "max_retries": LLM_MAX_RETRIES}
    client = anthropic.AsyncAnthropic(api_key=anthropic_key, **llm_opts) if anthropic_key else (
        anthropic.AsyncAnthropic(**llm_opts)
    )
    links = LinkMetadataClient(
        # Meta says instagram_oembed needs no token since 2026-06-15; honor one if provided.
        instagram_access_token=s.instagram_oembed_token.get_secret_value() or None,
    )
    token = s.bot_token.get_secret_value()
    files = TelegramFiles(token, s.telegram_api_base) if token else None
    stt = build_transcriber(s.stt_provider, s.stt_api_key.get_secret_value())
    places_key = s.places_api_key.get_secret_value()
    places_client = (
        GooglePlacesClient(places_key) if s.places_provider == "google" and places_key else None
    )
    embedder = get_embedder()
    closers = [
        c for c in (client, links, files, stt, places_client)
        if c is not None and (hasattr(c, "aclose") or hasattr(c, "close"))
    ]
    return Deps(
        gatherer=Gatherer(links=links, files=files, media=MediaExtractor(), stt=stt),
        extractor=AnthropicExtractor(
            client, model_fast=s.model_fast, model_strong=s.model_strong
        ),
        places=PlaceResolver(places_client),
        embedder=embedder,
        threshold=s.escalate_below_confidence,
        _closers=closers,
    )


_deps: Deps | None = None


def get_deps() -> Deps:
    global _deps
    if _deps is None:
        _deps = build_deps()
    return _deps


def set_deps(deps: Deps | None) -> None:
    """Install deps (worker startup, tests). None resets to lazy defaults."""
    global _deps
    _deps = deps
