"""Q&A orchestration with fakes: shared clients and the user's calendar day (no network/DB)."""

from datetime import UTC, datetime
from types import SimpleNamespace

from assistant.embeddings import NullEmbedder
from assistant.qa import service
from assistant.qa.compose import NOTHING_FOUND
from assistant.qa.filters import QueryFilters
from assistant.qa.llm import SDK_TIMEOUT_SECONDS, AnthropicQALLM, get_anthropic_client


class _Result:
    def all(self):
        return []


class FakeSession:
    def __init__(self, user):
        self.user = user

    async def get(self, model, ident):
        return self.user

    async def scalars(self, stmt):
        return _Result()


class RecordingLLM:
    def __init__(self):
        self.contexts = []

    async def extract_filters(self, question, context):
        self.contexts.append(context)
        return QueryFilters(keywords=["pho"])

    async def compose(self, question, data_block):
        raise AssertionError("no entries: compose must not be called")


async def test_today_is_the_users_calendar_day(monkeypatch):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 12, 1, 20, 30, tzinfo=UTC)  # Dec 2, 01:30 in Almaty

    monkeypatch.setattr(service, "datetime", FixedDatetime)
    user = SimpleNamespace(id=1, tz="Asia/Almaty", consent_at=datetime(2026, 1, 1, tzinfo=UTC))
    llm = RecordingLLM()
    ans = await service.answer(FakeSession(user), 1, "где фо?", llm=llm, embedder=NullEmbedder())
    assert ans.text == NOTHING_FOUND
    assert llm.contexts[0].startswith("Today: 2026-12-02")


def test_default_clients_are_cached_per_process(monkeypatch):
    created = []

    class FakeLLM:
        def __init__(self):
            created.append(self)

    service.default_llm.cache_clear()
    monkeypatch.setattr(service, "AnthropicQALLM", FakeLLM)
    try:
        assert service.default_llm() is service.default_llm()
        assert len(created) == 1
    finally:
        service.default_llm.cache_clear()

    embedders = []
    service.default_embedder.cache_clear()
    monkeypatch.setattr(service, "get_embedder", lambda: embedders.append(1) or NullEmbedder())
    try:
        assert service.default_embedder() is service.default_embedder()
        assert len(embedders) == 1
    finally:
        service.default_embedder.cache_clear()


def test_sdk_client_is_shared_and_has_timeout():
    get_anthropic_client.cache_clear()
    try:
        client = get_anthropic_client()  # constructing does no network I/O
        assert client is get_anthropic_client()
        assert client.timeout == SDK_TIMEOUT_SECONDS
        assert AnthropicQALLM()._client is client
    finally:
        get_anthropic_client.cache_clear()
