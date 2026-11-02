from datetime import UTC, datetime, timedelta, timezone, tzinfo

import pytest

from assistant.db.models import ItemKind, ItemSource
from assistant.pipeline.geo import load_zone
from assistant.pipeline.inputs import Gatherer, ItemData, ItemInputs
from assistant.pipeline.media import MediaExtractor, MediaParts
from assistant.pipeline.oembed import LinkMeta
from assistant.pipeline.schema import BookingExtract, Extraction
from assistant.pipeline.telegram_files import FileTooBigError, TelegramFile

NOW = datetime(2026, 11, 2, 9, 0, tzinfo=UTC)

# Windows dev boxes may lack the tz database (`tzdata`); both zones have no DST.
_FIXED = {"Asia/Almaty": 5, "Asia/Ho_Chi_Minh": 7, "Asia/Bangkok": 7}


def zone_loader(name: str | None) -> tzinfo | None:
    zone = load_zone(name)
    if zone is None and name in _FIXED:
        return timezone(timedelta(hours=_FIXED[name]), name)
    return zone


def make_extraction(**kw) -> Extraction:
    base = dict(
        kind="place",
        title="Bánh Mì Phượng",
        summary_ru="Знаменитый бань ми в Хойане.",
        category="food",
        city="Hội An",
        country="VN",
        place_query="Bánh Mì Phượng, Hội An",
        place_candidates=[],
        booking=None,
        confidence=0.9,
    )
    base.update(kw)
    return Extraction(**base)


def make_booking(**kw) -> BookingExtract:
    base = dict(
        type="flight",
        title="Алматы — Фукуок",
        confirmation_code="ab12cd",
        start_local="2026-12-20T07:40",
        end_local="2026-12-20T13:10",
        location_city="Алматы",
        location_country="KZ",
        arrival_city="Phu Quoc",
        arrival_country="VN",
        flight_number="KC 925",
        departure_airport="ALA",
        arrival_airport="PQC",
        details=None,
    )
    base.update(kw)
    return BookingExtract(**base)


class FakeExtractor:
    """Returns canned extractions: `fast` for strong=False, `strong` for strong=True."""

    def __init__(self, fast: Extraction, strong: Extraction | None = None) -> None:
        self.fast, self.strong = fast, strong or fast
        self.calls: list[tuple[ItemInputs, bool]] = []

    async def extract(self, inputs: ItemInputs, *, strong: bool) -> Extraction:
        self.calls.append((inputs, strong))
        return self.strong if strong else self.fast


class FakeLinks:
    def __init__(self, meta: LinkMeta | None = None, image: bytes | None = None) -> None:
        self.meta, self.image = meta, image
        self.fetched: list[tuple[str, ItemSource]] = []

    async def fetch(self, url: str, source: ItemSource) -> LinkMeta | None:
        self.fetched.append((url, source))
        return self.meta

    async def fetch_image(self, url: str) -> bytes | None:
        return self.image


class FakeFiles:
    def __init__(self, data: bytes = b"", path: str = "photos/file_1.jpg", too_big=False):
        self.data, self.path, self.too_big = data, path, too_big
        self.downloaded: list[str] = []

    async def download(self, file_id: str) -> TelegramFile:
        self.downloaded.append(file_id)
        if self.too_big:
            raise FileTooBigError("big")
        return TelegramFile(self.data, self.path)


class FakeStt:
    def __init__(self, text: str | None = "транскрипт") -> None:
        self.text = text
        self.calls: list[str] = []

    async def transcribe(self, audio: bytes, filename: str) -> str | None:
        self.calls.append(filename)
        return self.text


class FakeMedia(MediaExtractor):
    def __init__(self, parts: MediaParts | None = None) -> None:
        super().__init__(ffmpeg="ffmpeg")
        self.parts = parts or MediaParts()

    async def extract(self, video: bytes, suffix: str = ".mp4") -> MediaParts:
        return self.parts


JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64


def make_gatherer(links=None, files=None, media=None, stt=None) -> Gatherer:
    return Gatherer(
        links=links or FakeLinks(),
        files=files or FakeFiles(JPEG),
        media=media or FakeMedia(),
        stt=stt or FakeStt(),
    )


def item(**kw) -> ItemData:
    base = dict(
        id=1, kind=ItemKind.TEXT, source=ItemSource.USER, raw_text=None, url=None,
        telegram_file_id=None,
    )  # fmt: skip
    base.update(kw)
    return ItemData(**base)


@pytest.fixture
def zones():
    return zone_loader
