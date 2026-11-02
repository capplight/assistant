"""Speech-to-text for voice notes and user-sent videos (Claude has no audio input)."""

import logging
from typing import Protocol

import httpx

log = logging.getLogger(__name__)


class Transcriber(Protocol):
    async def transcribe(self, audio: bytes, filename: str) -> str | None: ...


class NullTranscriber:
    async def transcribe(self, audio: bytes, filename: str) -> str | None:
        return None


class WhisperTranscriber:
    """OpenAI-compatible /audio/transcriptions endpoint (Groq by default)."""

    GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
    GROQ_MODEL = "whisper-large-v3-turbo"

    def __init__(
        self,
        api_key: str,
        *,
        url: str = GROQ_URL,
        model: str = GROQ_MODEL,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._key, self._url, self._model = api_key, url, model
        self._client = client or httpx.AsyncClient(timeout=120)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def transcribe(self, audio: bytes, filename: str) -> str | None:
        """Text, or None when the audio is unusable. Raises on 429/5xx/network (retry)."""
        if not audio:
            return None
        resp = await self._client.post(
            self._url,
            headers={"Authorization": f"Bearer {self._key}"},
            data={"model": self._model, "response_format": "json"},
            files={"file": (filename, audio)},
        )
        if resp.status_code == 429 or resp.status_code >= 500:
            resp.raise_for_status()
        if resp.status_code != 200:
            log.info("transcription rejected: HTTP %s %s", resp.status_code, resp.text[:200])
            return None
        text = (resp.json().get("text") or "").strip()
        return text or None


def build_transcriber(provider: str, api_key: str) -> Transcriber:
    if not api_key:
        return NullTranscriber()
    if provider == "groq":
        return WhisperTranscriber(api_key)
    if provider == "openai":
        return WhisperTranscriber(
            api_key, url="https://api.openai.com/v1/audio/transcriptions", model="whisper-1"
        )
    return NullTranscriber()
