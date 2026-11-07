"""Adapters the ingest jobs talk to. Tests (and dev without binaries/keys) use the fakes.

- Ocr: local Tesseract 5 (`rus+kaz+eng`) when `tesseract` is on PATH, else FakeOcr. Runs in KZ,
  so it needs no cross-border consent. The Google VISION_OCR fallback (spec 6.1) is an AI
  provider and belongs to the router (assistant.ai), not here.
- Transcriber: speech-to-text. Every real provider (Groq, OpenAI) is abroad, so `recipient` names
  the provider and the job checks the ai_cross_border consent covers it before sending audio.
  No real provider exists yet (no API keys): FakeTranscriber (STT_PROVIDER=fake) or
  UnavailableTranscriber, which fails the job so the item is retried later.
"""

import asyncio
import shutil
from dataclasses import dataclass, field
from typing import Protocol


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
    pass


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


def make_transcriber(provider: str) -> Transcriber:
    if provider == "fake":
        return FakeTranscriber()
    # groq / openai adapters come with the AI router (assistant.ai); no keys exist yet.
    return UnavailableTranscriber()
