"""Gather what we can read about an item, by source and kind, before calling the model."""

import logging
from dataclasses import dataclass, field
from datetime import date

from assistant.db.models import ItemKind, ItemSource
from assistant.links import detect_source, extract_urls
from assistant.pipeline.errors import NeedsInputError
from assistant.pipeline.media import MediaExtractor
from assistant.pipeline.oembed import LinkMetadataClient
from assistant.pipeline.stt import Transcriber
from assistant.pipeline.telegram_files import FileTooBigError, TelegramFiles

log = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 5 * 1024 * 1024  # Messages API per-image limit
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_TEXT_DOC_BYTES = 200 * 1024

ASK_SCREENSHOT_BIG = (
    "Файл слишком большой, я не могу его открыть. Пришли, пожалуйста, скриншот "
    "или напиши пару слов, что там."
)
ASK_SCREENSHOT_REEL = (
    "Не получилось открыть ссылку. Пришли, пожалуйста, скриншот или напиши, что там за место."
)
ASK_SCREENSHOT_FILE = "Не могу открыть этот файл. Пришли, пожалуйста, скриншот."
ASK_SOMETHING = "Не вижу, что тут сохранить. Пришли скриншот или напиши пару слов."


@dataclass
class ImageInput:
    media_type: str
    data: bytes
    label: str  # "photo", "video frame 2/4", "link preview"


@dataclass
class TripContext:
    title: str
    destination: str | None
    starts_on: date | None
    ends_on: date | None


@dataclass
class ItemInputs:
    source: str
    kind: str
    url: str | None = None
    texts: list[tuple[str, str]] = field(default_factory=list)  # (label, untrusted text)
    images: list[ImageInput] = field(default_factory=list)
    pdfs: list[bytes] = field(default_factory=list)
    today: date | None = None
    trips: list[TripContext] = field(default_factory=list)

    def add_text(self, label: str, text: str | None) -> None:
        if text and text.strip():
            self.texts.append((label, text.strip()))

    @property
    def has_content(self) -> bool:
        return bool(self.texts or self.images or self.pdfs)


@dataclass
class ItemData:
    """Plain copy of the Item fields the pipeline reads (keeps logic DB-free)."""

    id: int
    kind: ItemKind
    source: ItemSource
    raw_text: str | None
    url: str | None
    telegram_file_id: str | None


def sniff_media_type(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    return None


@dataclass
class Gatherer:
    links: LinkMetadataClient
    files: TelegramFiles | None
    media: MediaExtractor
    stt: Transcriber

    async def gather(
        self, item: ItemData, *, today: date | None = None, trips: list[TripContext] | None = None
    ) -> ItemInputs:
        url = item.url or next(iter(extract_urls(item.raw_text)), None)
        source = detect_source(url) if url and item.source is ItemSource.USER else item.source
        inputs = ItemInputs(
            source=source.value, kind=item.kind.value, url=url, today=today, trips=trips or []
        )
        # Caption / forwarded post / typed note. If the text is only the URL, skip it.
        if item.raw_text and item.raw_text.strip() != (url or ""):
            inputs.add_text("message text", item.raw_text)

        if url:
            await self._link(inputs, url, source)

        if item.telegram_file_id:
            await self._file(inputs, item)

        if not inputs.has_content:
            if source in (ItemSource.INSTAGRAM, ItemSource.TIKTOK):
                raise NeedsInputError(ASK_SCREENSHOT_REEL, "no metadata for reel")
            if not url:
                raise NeedsInputError(ASK_SOMETHING, "empty item")
        return inputs

    async def _link(self, inputs: ItemInputs, url: str, source: ItemSource) -> None:
        meta = await self.links.fetch(url, source)
        if meta is None:
            return
        label = "post caption" if source in (ItemSource.INSTAGRAM, ItemSource.TIKTOK) else "page"
        inputs.add_text(label, meta.text())
        if meta.thumbnail_url:
            img = await self.links.fetch_image(meta.thumbnail_url)
            mt = sniff_media_type(img) if img else None
            if img and mt and mt.startswith("image/") and len(img) <= MAX_IMAGE_BYTES:
                inputs.images.append(ImageInput(mt, img, "link preview"))

    async def _file(self, inputs: ItemInputs, item: ItemData) -> None:
        if self.files is None:
            raise NeedsInputError(ASK_SCREENSHOT_FILE, "telegram files client not configured")
        try:
            f = await self.files.download(item.telegram_file_id or "")
        except FileTooBigError as e:
            raise NeedsInputError(ASK_SCREENSHOT_BIG, f"file too big: {e}") from e

        if item.kind is ItemKind.VOICE:
            inputs.add_text("voice message transcript", await self.stt.transcribe(f.data,
                                                                                  f.filename))
            if not inputs.has_content:
                raise NeedsInputError(ASK_SOMETHING, "voice without transcript")
            return

        if item.kind is ItemKind.VIDEO:
            suffix = "." + f.filename.rsplit(".", 1)[-1] if "." in f.filename else ".mp4"
            parts = await self.media.extract(f.data, suffix)
            if parts.audio:
                inputs.add_text(
                    "video speech transcript", await self.stt.transcribe(parts.audio, "audio.wav")
                )
            n = len(parts.frames)
            for i, frame in enumerate(parts.frames, 1):
                if len(frame) <= MAX_IMAGE_BYTES:
                    inputs.images.append(ImageInput("image/jpeg", frame, f"video frame {i}/{n}"))
            return

        media_type = sniff_media_type(f.data)
        if media_type and media_type.startswith("image/"):
            if len(f.data) > MAX_IMAGE_BYTES:
                raise NeedsInputError(ASK_SCREENSHOT_BIG, "image over 5 MB")
            inputs.images.append(ImageInput(media_type, f.data, "photo or screenshot"))
        elif media_type == "application/pdf" and len(f.data) <= MAX_PDF_BYTES:
            inputs.pdfs.append(f.data)
        elif len(f.data) <= MAX_TEXT_DOC_BYTES and _looks_like_text(f.data):
            inputs.add_text("document", f.data.decode("utf-8", errors="replace"))
        else:
            raise NeedsInputError(ASK_SCREENSHOT_FILE, f"unsupported file {f.filename}")


def _looks_like_text(data: bytes) -> bool:
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return b"\x00" not in data
