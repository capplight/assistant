import pytest

from assistant.db.models import ItemKind, ItemSource, ItemStatus
from assistant.pipeline.core import PipelineContext, run_pipeline
from assistant.pipeline.errors import NeedsInputError
from assistant.pipeline.inputs import ASK_SCREENSHOT_BIG, ASK_SCREENSHOT_REEL
from assistant.pipeline.logic import TripInfo
from assistant.pipeline.media import MediaParts
from assistant.pipeline.oembed import LinkMeta
from assistant.pipeline.places import ResolvedPlace
from tests.pipeline.conftest import (
    JPEG,
    NOW,
    FakeExtractor,
    FakeFiles,
    FakeLinks,
    FakeMedia,
    FakeStt,
    item,
    make_booking,
    make_extraction,
    make_gatherer,
)

PLACE = ResolvedPlace(place_id=10, name="Bánh Mì Phượng", city="Хойан", country="VN",
                      tz="Asia/Ho_Chi_Minh")  # fmt: skip


class Resolver:
    def __init__(self, result=PLACE):
        self.result, self.queries = result, []

    async def __call__(self, query, country):
        self.queries.append((query, country))
        return self.result


def ctx(it, trips=None, existing=None):
    return PipelineContext(item=it, user_tz="Asia/Almaty", trips=trips or [],
                           existing_trip_id=existing, now=NOW)  # fmt: skip


async def run(it, *, extractor, gatherer=None, resolver=None, trips=None, zones=None):
    kw = {"zone_loader": zones} if zones else {}
    return await run_pipeline(
        ctx(it, trips), gatherer=gatherer or make_gatherer(), extractor=extractor,
        resolve_place=resolver or Resolver(), threshold=0.6, **kw,
    )  # fmt: skip


# ---------------------------------------------------------------- input routing


async def test_tiktok_link_uses_oembed_never_file_download():
    links = FakeLinks(LinkMeta(title="Лучший бань ми #hoian", author="foodie"))
    files = FakeFiles(JPEG)
    g = make_gatherer(links=links, files=files)
    it = item(kind=ItemKind.LINK, source=ItemSource.TIKTOK,
              url="https://www.tiktok.com/@foodie/video/1")  # fmt: skip
    inputs = await g.gather(it)
    assert links.fetched == [(it.url, ItemSource.TIKTOK)]
    assert files.downloaded == []
    assert ("post caption", "Автор: foodie\nЛучший бань ми #hoian") in inputs.texts


async def test_url_in_user_text_is_routed_by_detected_source():
    links = FakeLinks(LinkMeta(title="caption"))
    it = item(raw_text="смотри https://www.instagram.com/reel/C1abc/ классно")
    inputs = await make_gatherer(links=links).gather(it)
    assert links.fetched == [("https://www.instagram.com/reel/C1abc/", ItemSource.INSTAGRAM)]
    assert inputs.source == "instagram"
    assert inputs.texts[0][0] == "message text"


async def test_reel_without_metadata_asks_for_screenshot():
    it = item(kind=ItemKind.LINK, source=ItemSource.INSTAGRAM,
              url="https://instagram.com/reel/x")  # fmt: skip
    with pytest.raises(NeedsInputError) as e:
        await make_gatherer(links=FakeLinks(None)).gather(it)
    assert e.value.user_text == ASK_SCREENSHOT_REEL


async def test_reel_without_metadata_but_with_caption_is_processed():
    it = item(kind=ItemKind.LINK, source=ItemSource.INSTAGRAM,
              url="https://instagram.com/reel/x", raw_text="Пляж Сао, Фукуок")  # fmt: skip
    inputs = await make_gatherer(links=FakeLinks(None)).gather(it)
    assert inputs.texts == [("message text", "Пляж Сао, Фукуок")]


async def test_photo_becomes_image_block():
    files = FakeFiles(JPEG)
    inputs = await make_gatherer(files=files).gather(
        item(kind=ItemKind.PHOTO, telegram_file_id="F1")
    )
    assert files.downloaded == ["F1"]
    assert inputs.images[0].media_type == "image/jpeg"


async def test_pdf_document_and_unknown_binary():
    g = make_gatherer(files=FakeFiles(b"%PDF-1.7 ...", "documents/ticket.pdf"))
    inputs = await g.gather(item(kind=ItemKind.DOCUMENT, telegram_file_id="F"))
    assert len(inputs.pdfs) == 1
    g = make_gatherer(files=FakeFiles(b"\x00\x01\x02binary", "documents/x.heic"))
    with pytest.raises(NeedsInputError):
        await g.gather(item(kind=ItemKind.DOCUMENT, telegram_file_id="F"))


async def test_video_frames_and_transcript():
    stt = FakeStt("Это кафе на Фукуоке")
    media = FakeMedia(MediaParts(audio=b"wav", frames=[JPEG, JPEG]))
    g = make_gatherer(files=FakeFiles(b"mp4", "videos/v.mp4"), media=media, stt=stt)
    inputs = await g.gather(item(kind=ItemKind.VIDEO, telegram_file_id="V",
                                 raw_text="подпись"))  # fmt: skip
    assert [i.label for i in inputs.images] == ["video frame 1/2", "video frame 2/2"]
    assert ("video speech transcript", "Это кафе на Фукуоке") in inputs.texts
    assert ("message text", "подпись") in inputs.texts


async def test_video_without_ffmpeg_degrades_to_caption():
    g = make_gatherer(files=FakeFiles(b"mp4", "videos/v.mp4"), media=FakeMedia(MediaParts()))
    inputs = await g.gather(item(kind=ItemKind.VIDEO, telegram_file_id="V", raw_text="кафе"))
    assert inputs.images == [] and inputs.texts == [("message text", "кафе")]


async def test_voice_is_transcribed():
    stt = FakeStt("запомни: в Хойане брать велосипед")
    g = make_gatherer(files=FakeFiles(b"OggS", "voice/file.oga"), stt=stt)
    inputs = await g.gather(item(kind=ItemKind.VOICE, telegram_file_id="V"))
    assert stt.calls == ["file.oga"]
    assert inputs.texts == [("voice message transcript", "запомни: в Хойане брать велосипед")]


async def test_too_big_file_needs_input():
    out = await run(
        item(kind=ItemKind.VIDEO, telegram_file_id="V"),
        extractor=FakeExtractor(make_extraction()),
        gatherer=make_gatherer(files=FakeFiles(too_big=True)),
    )
    assert out.status is ItemStatus.NEEDS_INPUT and out.user_text == ASK_SCREENSHOT_BIG


# ---------------------------------------------------------------- pipeline


async def test_confident_place_resolved_with_fast_model_only():
    fx = FakeExtractor(make_extraction(confidence=0.9))
    resolver = Resolver()
    trips = [TripInfo(id=5, title="Вьетнам", destination="Вьетнам")]
    out = await run(item(raw_text="Bánh Mì Phượng"), extractor=fx, resolver=resolver,
                    trips=trips)  # fmt: skip
    assert [strong for _, strong in fx.calls] == [False]
    assert out.status is ItemStatus.DONE and out.place == PLACE
    assert resolver.queries == [("Bánh Mì Phượng, Hội An", "VN")]
    assert out.trip.id == 5


async def test_low_confidence_escalates_to_strong_model():
    fx = FakeExtractor(make_extraction(confidence=0.3), make_extraction(confidence=0.95))
    out = await run(item(raw_text="кафе"), extractor=fx)
    assert [strong for _, strong in fx.calls] == [False, True]
    assert out.escalated and out.extraction.confidence == 0.95


async def test_still_ambiguous_after_escalation_asks_with_options():
    amb = make_extraction(confidence=0.4, place_candidates=["Madam Khanh"])
    resolver = Resolver()
    out = await run(item(raw_text="лучший бань ми"), extractor=FakeExtractor(amb),
                    resolver=resolver)  # fmt: skip
    assert out.status is ItemStatus.NEEDS_INPUT
    assert out.options == ["Bánh Mì Phượng, Hội An", "Madam Khanh"]
    assert resolver.queries == []


async def test_booking_goes_to_strong_model_and_is_validated(zones):
    fast = make_extraction(kind="booking", booking=make_booking(), confidence=0.9,
                           place_query=None, category="transport")  # fmt: skip
    strong = make_extraction(kind="booking", booking=make_booking(), confidence=0.95,
                             place_query=None, category="transport")  # fmt: skip
    fx = FakeExtractor(fast, strong)
    out = await run(item(kind=ItemKind.PHOTO, telegram_file_id="F"), extractor=fx,
                    zones=zones)  # fmt: skip
    assert [s for _, s in fx.calls] == [False, True]
    assert out.decision == "booking" and out.status is ItemStatus.DONE
    assert out.extraction.category == "booking"
    assert out.booking.starts_at.isoformat() == "2026-12-20T02:40:00+00:00"


async def test_tip_saved_without_place_lookup():
    resolver = Resolver()
    ex = make_extraction(kind="tip", category="tip", place_query=None, title="Виза не нужна")
    out = await run(item(raw_text="виза"), extractor=FakeExtractor(ex), resolver=resolver)
    assert out.status is ItemStatus.DONE and out.decision == "save" and resolver.queries == []


async def test_place_not_found_still_saved():
    out = await run(item(raw_text="кафе"), extractor=FakeExtractor(make_extraction()),
                    resolver=Resolver(None))  # fmt: skip
    assert out.status is ItemStatus.DONE and out.place is None
