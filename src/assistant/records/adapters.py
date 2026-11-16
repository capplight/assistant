"""Adapters the ingest jobs talk to. Tests (and dev without binaries/keys) use the fakes.

- Ocr: local Tesseract 5 (`rus+kaz+eng`) when `tesseract` is on PATH, else FakeOcr. Runs in KZ,
  so it needs no cross-border consent. The Google VISION_OCR fallback (spec 6.1) is an AI
  provider and belongs to the router (assistant.ai), not here.
- Transcriber: speech-to-text. Every real provider (Groq, OpenAI) is abroad, so `recipient` names
  the provider and the job checks the ai_cross_border consent covers it before sending audio.
  GroqTranscriber (STT_PROVIDER=groq + GROQ_API_KEY or STT_API_KEY): Whisper large-v3-turbo,
  checked live 2026-11-16 on RU. Kazakh stays beta: Whisper is weak on KK and our own KK
  benchmark is pending (docs/spec/proposals/ai-providers-2026-11.md). FakeTranscriber
  (STT_PROVIDER=fake); UnavailableTranscriber when nothing is configured (`stt_unavailable`).
"""

import asyncio
import math
import shutil
from dataclasses import dataclass, field
from typing import Protocol

import httpx


@dataclass(frozen=True)
class OcrResult:
    text: str
    confidence: float  # 0..1, mean word confidence


@dataclass(frozen=True)
class Transcript:
    text: str
    confidence: float  # 0..1
    lang: str | None = None
    segments: list[dict] = field(default_factory=list)  # [{"start": s, "end": s, "text": ...}]


class Ocr(Protocol):
    name: str

    async def recognize(self, image: bytes, *, langs: str) -> OcrResult: ...


class Transcriber(Protocol):
    name: str
    recipient: str | None  # consent provider name ("Groq"); None = stays in KZ

    async def transcribe(self, audio: bytes, *, mime: str, lang_hint: str | None) -> Transcript: ...


class OcrError(Exception):
    pass


class TranscriberUnavailable(Exception):
    """An outage (network, 429, 5xx, timeout): the queue retries until the voice deadline."""


class TranscriberRejected(Exception):
    """The provider refused this audio (broken / unsupported / too big): retrying will not help."""


# --- OCR ---


def parse_tesseract_tsv(tsv: str) -> OcrResult:
    """Tesseract `tsv` output -> text by lines + mean confidence of recognized words."""
    lines: dict[tuple[str, str, str, str], list[str]] = {}
    confs: list[float] = []
    for row in tsv.splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12 or cols[0] != "5":  # level 5 = word
            continue
        word = cols[11].strip()
        try:
            conf = float(cols[10])
        except ValueError:
            continue
        if not word or conf < 0:
            continue
        lines.setdefault((cols[1], cols[2], cols[3], cols[4]), []).append(word)
        confs.append(conf)
    text = "\n".join(" ".join(words) for _, words in sorted(lines.items(), key=_line_key))
    confidence = round(sum(confs) / len(confs) / 100, 3) if confs else 0.0
    return OcrResult(text=text, confidence=confidence)


def _line_key(entry: tuple[tuple[str, str, str, str], list[str]]) -> tuple[int, ...]:
    return tuple(int(x) for x in entry[0])


class TesseractOcr:
    name = "tesseract"

    def __init__(self, binary: str = "tesseract", timeout: float = 60.0) -> None:
        self.binary = binary
        self.timeout = timeout

    async def recognize(self, image: bytes, *, langs: str) -> OcrResult:
        proc = await asyncio.create_subprocess_exec(
            self.binary, "stdin", "stdout", "-l", langs, "tsv",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )  # fmt: skip
        try:
            out, err = await asyncio.wait_for(proc.communicate(image), self.timeout)
        except TimeoutError as exc:
            proc.kill()
            raise OcrError("tesseract timeout") from exc
        if proc.returncode != 0:
            detail = err.decode(errors="replace")[:200]
            raise OcrError(f"tesseract exit {proc.returncode}: {detail}")
        return parse_tesseract_tsv(out.decode("utf-8", errors="replace"))


class FakeOcr:
    """Returns a fixed result (tests; dev machines without Tesseract)."""

    name = "fake"

    def __init__(self, text: str = "", confidence: float = 0.0) -> None:
        self.result = OcrResult(text, confidence)
        self.calls = 0

    async def recognize(self, image: bytes, *, langs: str) -> OcrResult:
        self.calls += 1
        return self.result


def make_ocr(provider: str = "auto") -> Ocr:
    """auto: Tesseract if on PATH, else fake. tesseract: required. fake: always fake."""
    if provider in ("auto", "tesseract"):
        binary = shutil.which("tesseract")
        if binary:
            return TesseractOcr(binary)
        if provider == "tesseract":
            raise RuntimeError("OCR_PROVIDER=tesseract but `tesseract` is not on PATH")
    return FakeOcr()


# --- STT ---


class FakeTranscriber:
    name = "fake"

    def __init__(self, text: str = "Тестовая расшифровка.", confidence: float = 0.9,
                 recipient: str | None = "Groq") -> None:  # fmt: skip
        # Pretends to be abroad like every real STT provider, so the consent gate is exercised.
        self.recipient = recipient
        self.result = Transcript(text=text, confidence=confidence)
        self.calls = 0

    async def transcribe(self, audio: bytes, *, mime: str, lang_hint: str | None) -> Transcript:
        self.calls += 1
        return self.result


class UnavailableTranscriber:
    name = "none"
    recipient = None

    async def transcribe(self, audio: bytes, *, mime: str, lang_hint: str | None) -> Transcript:
        raise TranscriberUnavailable("no speech-to-text provider configured")


# Whisper's `language` comes back as an English name in verbose_json.
_WHISPER_LANGS = {"russian": "ru", "kazakh": "kk", "english": "en", "ru": "ru", "kk": "kk",
                  "en": "en"}  # fmt: skip
_EXT_BY_MIME = {"audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a",
                "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg", "audio/opus": "ogg",
                "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav",
                "audio/wave": "wav", "audio/flac": "flac", "video/mp4": "mp4"}  # fmt: skip


def whisper_confidence(segments: list[dict]) -> float:
    """exp(avg_logprob) x (1 - no_speech_prob), weighted by segment length. 0..1."""
    total = weight = 0.0
    for seg in segments:
        try:
            lp = float(seg.get("avg_logprob", 0.0))
            ns = float(seg.get("no_speech_prob", 0.0) or 0.0)
            w = max(0.01, float(seg.get("end", 0.0)) - float(seg.get("start", 0.0)))
        except (TypeError, ValueError):
            continue
        total += w * math.exp(min(0.0, lp)) * (1.0 - min(1.0, max(0.0, ns)))
        weight += w
    return round(total / weight, 3) if weight else 0.0


class GroqTranscriber:
    """Groq's OpenAI-compatible `POST /audio/transcriptions`, model whisper-large-v3-turbo.

    429 / 5xx / 401-403 / network / timeout -> TranscriberUnavailable (the queue retries until the
    voice deadline, then `stt_timeout`); 400 / 413 / 415 / 422 -> TranscriberRejected."""

    name = "groq"
    recipient = "Groq"
    URL = "https://api.groq.com/openai/v1/audio/transcriptions"
    MODEL = "whisper-large-v3-turbo"

    def __init__(self, api_key: str, *, model: str = MODEL, timeout: float = 60.0,
                 client: httpx.AsyncClient | None = None) -> None:  # fmt: skip
        self._key, self.model = api_key, model
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def transcribe(self, audio: bytes, *, mime: str, lang_hint: str | None) -> Transcript:
        mime = (mime or "").split(";")[0].strip().lower()
        ext = _EXT_BY_MIME.get(mime, "m4a")
        data = {"model": self.model, "response_format": "verbose_json", "temperature": "0"}
        if lang_hint in ("ru", "kk", "en"):
            data["language"] = lang_hint
        try:
            resp = await self._client.post(
                self.URL, headers={"Authorization": f"Bearer {self._key}"}, data=data,
                files={"file": (f"voice.{ext}", audio, mime or "application/octet-stream")},
            )  # fmt: skip
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise TranscriberUnavailable(f"groq stt: {type(exc).__name__}") from exc
        if resp.status_code in (400, 413, 415, 422):
            raise TranscriberRejected(f"groq stt: http {resp.status_code}")
        if resp.status_code >= 300:
            raise TranscriberUnavailable(f"groq stt: http {resp.status_code}")
        try:
            body = resp.json()
        except ValueError as exc:
            raise TranscriberUnavailable("groq stt: not json") from exc
        segments = [s for s in body.get("segments") or [] if isinstance(s, dict)]
        text = (body.get("text") or "").strip()
        lang = _WHISPER_LANGS.get(str(body.get("language") or "").strip().lower())
        if segments:
            confidence = whisper_confidence(segments)
        else:
            confidence = 0.5 if text else 0.0
        return Transcript(
            text=text, confidence=confidence, lang=lang,
            segments=[{"start": s.get("start"), "end": s.get("end"),
                       "text": (s.get("text") or "").strip()} for s in segments],
        )  # fmt: skip


def make_transcriber(provider: str, *, api_key: str = "") -> Transcriber:
    """fake | groq (needs a key) | anything else or no key -> unavailable."""
    if provider == "fake":
        return FakeTranscriber()
    if provider == "groq" and api_key:
        return GroqTranscriber(api_key)
    return UnavailableTranscriber()
