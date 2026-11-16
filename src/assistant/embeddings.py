"""Text embeddings, shared by the pipeline (documents) and Q&A (queries).

Two families. `get_embedder` serves the legacy bot (`items.embedding`). `make_chunk_embedder` serves
`chunks` and search (spec 5.5), always BAAI/bge-m3 (1024 dims):
- `tei`: our own TEI server in KZ, no data leaves the country, no AI consent (spec 5.3);
- `deepinfra` (Ф-76, until we have the server): the same model abroad. It has `recipient`, so
  callers send text only for people whose ai_cross_border grant lists DeepInfra (version
  ai-2026-11-v2, R-02), and it masks the text first.
An embedder with `recipient = None` stays in the country.
"""

import asyncio
import hashlib
import logging
import math
import re
import time
from collections.abc import Awaitable, Callable
from typing import Literal, Protocol

import httpx

from assistant.ai.masking import Masker
from assistant.config import Settings, get_settings

log = logging.getLogger(__name__)

InputType = Literal["document", "query"]


class Embedder(Protocol):
    dim: int

    async def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]: ...


class VoyageEmbedder:
    URL = "https://api.voyageai.com/v1/embeddings"

    def __init__(self, api_key: str, model: str, dim: int, client: httpx.AsyncClient | None = None):
        self._key, self._model, self.dim = api_key, model, dim
        self._client = client or httpx.AsyncClient(timeout=30)

    async def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        if not texts:
            return []
        resp = await self._client.post(
            self.URL,
            headers={"Authorization": f"Bearer {self._key}"},
            json={
                "input": texts,
                "model": self._model,
                "input_type": input_type,
                "output_dimension": self.dim,
            },
        )
        resp.raise_for_status()
        data = sorted(resp.json()["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in data]


class NullEmbedder:
    """No provider configured: callers skip vector search and rely on full-text search."""

    dim = 0

    async def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        return []


class ChunkEmbedder(Embedder, Protocol):
    model: str  # stored as chunks.embedding_model


def recipient_of(embedder: object) -> str | None:
    """Consent provider name of an embedder abroad ("DeepInfra"); None = stays in KZ."""
    return getattr(embedder, "recipient", None)


def embedder_available(embedder: object) -> bool:
    """False while an embedder switched itself off (no balance, bad key): don't call it."""
    check = getattr(embedder, "available", None)
    return bool(getattr(embedder, "dim", 0)) and (check() if check is not None else True)


class TeiEmbedder:
    """Text Embeddings Inference (`POST /embed`) with BAAI/bge-m3. UNVERIFIED against a real server:
    the request and response follow TEI's documented API; tests use a mock."""

    BATCH = 32  # TEI's default --max-client-batch-size

    def __init__(self, base_url: str, *, model: str, dim: int, timeout: float = 60.0,
                 client: httpx.AsyncClient | None = None) -> None:  # fmt: skip
        self._url = base_url.rstrip("/") + "/embed"
        self.model, self.dim = model, dim
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        """bge-m3 has no document/query prefixes, so `input_type` changes nothing."""
        out: list[list[float]] = []
        for start in range(0, len(texts), self.BATCH):
            resp = await self._client.post(
                self._url,
                json={"inputs": texts[start:start + self.BATCH], "normalize": True,
                      "truncate": True},
            )  # fmt: skip
            resp.raise_for_status()
            out.extend(resp.json())
        return out


class EmbedderUnavailable(Exception):
    """The embedder can't serve now (no balance, bad key, outage). `reason`: no_balance | auth |
    unreachable. Callers degrade: search runs on words, chunks wait in the queue."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class DeepInfraEmbedder:
    """BAAI/bge-m3 on DeepInfra (OpenAI-compatible `POST /v1/openai/embeddings`): the same model
    and vectors as the planned local TEI, so moving to our own server needs no re-embed.

    DeepInfra is abroad (US): `recipient` makes callers check the person's ai_cross_border
    consent lists it (consent text ai-2026-11-v2), and texts are masked (spec 5.7) first.
    Batched by `BATCH`; 429 / 5xx / network are retried `RETRIES` times. 402 (no balance) and
    401/403 switch it off for `DOWN_SECONDS`: every call meanwhile raises EmbedderUnavailable at
    once, without the network, and only the switch is logged (one warning, then one info when
    it works again)."""

    URL = "https://api.deepinfra.com/v1/openai/embeddings"
    BATCH = 64
    RETRIES = 2
    DOWN_SECONDS = {"no_balance": 900.0, "auth": 900.0, "unreachable": 30.0}
    recipient = "DeepInfra"

    def __init__(self, api_key: str, *, model: str = "BAAI/bge-m3", dim: int = 1024,
                 timeout: float = 30.0, client: httpx.AsyncClient | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:  # fmt: skip
        self._key, self.model, self.dim = api_key, model, dim
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._clock, self._sleep = clock, sleep
        self._down_until = 0.0
        self.down_reason: str | None = None

    def available(self) -> bool:
        return self._clock() >= self._down_until

    def _down(self, reason: str) -> EmbedderUnavailable:
        if self.down_reason is None:
            log.warning("embedder %s unavailable (%s): search runs on words, chunks wait",
                        self.recipient, reason)  # fmt: skip
        self.down_reason = reason
        self._down_until = self._clock() + self.DOWN_SECONDS.get(reason, 30.0)
        return EmbedderUnavailable(reason)

    async def _post(self, batch: list[str]) -> list[list[float]]:
        for attempt in range(self.RETRIES + 1):
            if attempt:
                await self._sleep(0.5 * 3 ** (attempt - 1))
            try:
                resp = await self._client.post(
                    self.URL, headers={"Authorization": f"Bearer {self._key}"},
                    json={"model": self.model, "input": batch, "encoding_format": "float"},
                )  # fmt: skip
            except (httpx.TimeoutException, httpx.TransportError):
                continue
            if resp.status_code == 402:
                raise self._down("no_balance")
            if resp.status_code in (401, 403):
                raise self._down("auth")
            if resp.status_code == 429 or resp.status_code >= 500:
                continue
            resp.raise_for_status()  # another 4xx: a bug in the request, not an outage
            data = sorted(resp.json()["data"], key=lambda d: d["index"])
            return [_normalized(d["embedding"]) for d in data]
        raise self._down("unreachable")

    async def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        """bge-m3 has no document/query prefixes, so `input_type` changes nothing."""
        if not texts:
            return []
        if not self.available():
            raise EmbedderUnavailable(self.down_reason or "unreachable")
        masker = Masker()  # placeholders only; nothing is unmasked from a vector
        masked = [masker.mask(t) for t in texts]
        out: list[list[float]] = []
        for start in range(0, len(masked), self.BATCH):
            out.extend(await self._post(masked[start:start + self.BATCH]))
        if self.down_reason is not None:
            log.info("embedder %s works again", self.recipient)
            self.down_reason = None
        return out


def _normalized(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm else vector


class NullChunkEmbedder(NullEmbedder):
    """Not configured: no chunks are made and search runs on words and typos (spec 8.1)."""

    model = ""


class FakeEmbedder:
    """For tests and measurements, no model and no network: a normalized bag of hashed words. Shared
    words make texts close, nothing else does. `same_meaning` maps a word to another to act out a
    match by meaning. Says nothing about bge-m3's quality or speed."""

    def __init__(self, *, model: str = "fake-embedder", dim: int = 1024,
                 same_meaning: dict[str, str] | None = None) -> None:  # fmt: skip
        self.model, self.dim = model, dim
        self._same = same_meaning or {}
        self.calls: list[list[str]] = []

    def _vector(self, text: str) -> list[float]:
        vector = [0.0] * self.dim
        for word in re.findall(r"\w+", text.lower()):
            word = self._same.get(word, word)
            digest = hashlib.blake2b(word.encode(), digest_size=4).digest()
            vector[int.from_bytes(digest) % (self.dim - 1) + 1] += 1.0
        if not any(vector):
            vector[0] = 1.0  # a zero vector has no cosine distance
        norm = math.sqrt(sum(v * v for v in vector))
        return [v / norm for v in vector]

    async def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self._vector(t) for t in texts]


def make_chunk_embedder(provider: str, *, url: str, model: str, dim: int,
                        timeout: float = 60.0, api_key: str = "") -> ChunkEmbedder:  # fmt: skip
    """tei (+ url) | deepinfra (+ api_key) | none. Not configured -> NullChunkEmbedder."""
    if provider == "tei" and url:
        return TeiEmbedder(url, model=model, dim=dim, timeout=timeout)
    if provider == "deepinfra" and api_key:
        return DeepInfraEmbedder(api_key, model=model, dim=dim, timeout=max(timeout, 5.0))
    return NullChunkEmbedder()


def chunk_embedder_from_settings(s: Settings, *, timeout: float = 60.0) -> ChunkEmbedder:
    return make_chunk_embedder(s.chunk_embedder, url=s.tei_url, model=s.chunk_embedding_model,
                               dim=s.embeddings_dim, timeout=timeout,
                               api_key=s.deepinfra_api_key.get_secret_value())  # fmt: skip


def get_embedder() -> Embedder:
    s = get_settings()
    key = s.embeddings_api_key.get_secret_value()
    if s.embeddings_provider == "voyage" and key:
        return VoyageEmbedder(key, s.embeddings_model, s.embeddings_dim)
    return NullEmbedder()
