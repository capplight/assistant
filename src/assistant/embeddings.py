"""Text embeddings, shared by the pipeline (documents) and Q&A (queries).

Two families. `get_embedder` serves the legacy bot (`items.embedding`). `make_chunk_embedder` serves
`chunks` and search (spec 5.5): only TEI + bge-m3, hosted by us in KZ, so no data leaves the country
and no AI consent is involved (spec 5.3: "не передача"). A foreign provider must not get in here
without a new `ai_cross_border` version (R-02).
"""

import hashlib
import math
import re
from typing import Literal, Protocol

import httpx

from assistant.config import get_settings

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
                        timeout: float = 60.0) -> ChunkEmbedder:  # fmt: skip
    if provider == "tei" and url:
        return TeiEmbedder(url, model=model, dim=dim, timeout=timeout)
    return NullChunkEmbedder()


def get_embedder() -> Embedder:
    s = get_settings()
    key = s.embeddings_api_key.get_secret_value()
    if s.embeddings_provider == "voyage" and key:
        return VoyageEmbedder(key, s.embeddings_model, s.embeddings_dim)
    return NullEmbedder()
