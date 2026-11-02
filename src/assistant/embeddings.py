"""Text embeddings, shared by the pipeline (documents) and Q&A (queries)."""

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


def get_embedder() -> Embedder:
    s = get_settings()
    key = s.embeddings_api_key.get_secret_value()
    if s.embeddings_provider == "voyage" and key:
        return VoyageEmbedder(key, s.embeddings_model, s.embeddings_dim)
    return NullEmbedder()
