import httpx
import pytest
import respx

from assistant.db.models import ItemSource
from assistant.pipeline.errors import is_permanent, is_transient
from assistant.pipeline.oembed import LinkMetadataClient, parse_oembed, parse_page_meta
from assistant.pipeline.places import (
    FIELD_MASK,
    GooglePlacesClient,
    normalize_query,
    parse_search_response,
    pick_hit,
    query_hash,
)
from assistant.pipeline.stt import NullTranscriber, WhisperTranscriber, build_transcriber
from assistant.pipeline.telegram_files import FileTooBigError, TelegramFiles


async def public(host):
    return ["93.184.216.34"]


async def private(host):
    return ["10.0.0.5"]


def links(resolver=public, **kw):
    return LinkMetadataClient(httpx.AsyncClient(), resolver=resolver, **kw)


# ---------------------------------------------------------------- oEmbed / pages


@respx.mock
async def test_tiktok_oembed_parsed():
    route = respx.get("https://www.tiktok.com/oembed").mock(
        return_value=httpx.Response(200, json={
            "title": "Где поесть на Фукуоке 🍜 #phuquoc",
            "author_name": "travel.kz",
            "thumbnail_url": "https://p16.tiktokcdn.com/x.jpeg",
        })
    )  # fmt: skip
    meta = await links().fetch("https://www.tiktok.com/@a/video/1", ItemSource.TIKTOK)
    assert route.called
    assert route.calls[0].request.url.params["url"] == "https://www.tiktok.com/@a/video/1"
    assert meta.title.startswith("Где поесть") and meta.author == "travel.kz"
    assert meta.thumbnail_url.endswith("x.jpeg")


@respx.mock
async def test_instagram_oembed_failure_returns_none():
    respx.get(url__regex=r"https://graph\.facebook\.com/.*/instagram_oembed.*").mock(
        return_value=httpx.Response(400, json={"error": {"message": "token required"}})
    )
    assert await links().fetch("https://instagram.com/reel/x", ItemSource.INSTAGRAM) is None


@respx.mock
async def test_instagram_network_error_returns_none():
    respx.get(url__regex=r"https://graph\.facebook\.com/.*").mock(
        side_effect=httpx.ConnectError("boom")
    )
    assert await links().fetch("https://instagram.com/reel/x", ItemSource.INSTAGRAM) is None


@respx.mock
async def test_instagram_token_is_optional_and_passed_when_set():
    route = respx.get(url__regex=r"https://graph\.facebook\.com/v23\.0/instagram_oembed.*").mock(
        return_value=httpx.Response(200, json={"author_name": "a", "html": "<blockquote>"
                                    "<p>Кафе на пляже</p></blockquote>"})
    )  # fmt: skip
    await links().fetch("https://instagram.com/reel/x", ItemSource.INSTAGRAM)
    assert "access_token" not in route.calls[0].request.url.params
    meta = await links(instagram_access_token="T").fetch(
        "https://instagram.com/reel/x", ItemSource.INSTAGRAM
    )
    assert route.calls[1].request.url.params["access_token"] == "T"
    assert meta.title == "Кафе на пляже"  # caption recovered from embed html


@respx.mock
async def test_web_page_title_and_og_description():
    html = ("<html><head><title>Sao Beach</title><meta property='og:description' "
            "content='Лучший пляж острова'></head><body>x</body></html>")  # fmt: skip
    route = respx.get("https://93.184.216.34/a").mock(
        return_value=httpx.Response(200, html=html)
    )
    meta = await links().fetch("https://example.com/a", ItemSource.WEB)
    assert meta.title == "Sao Beach" and meta.description == "Лучший пляж острова"
    # Connection pinned to the vetted IP; Host and TLS SNI/cert name stay the real host.
    req = route.calls[0].request
    assert req.headers["Host"] == "example.com"
    assert req.extensions["sni_hostname"] == "example.com"


@respx.mock
async def test_page_fetch_never_resolves_twice():
    """DNS rebinding: the first answer is public, any later one private. Only the first
    lookup happens per hop, and the request goes to that address."""
    answers = iter([["93.184.216.34"], ["127.0.0.1"]])
    lookups = []

    async def rebinding(host):
        lookups.append(host)
        return next(answers)

    route = respx.get("http://93.184.216.34/p").mock(
        return_value=httpx.Response(200, html="<title>ok</title>")
    )
    meta = await links(rebinding).fetch("http://example.com/p", ItemSource.WEB)
    assert meta.title == "ok" and route.called and lookups == ["example.com"]
    assert "sni_hostname" not in route.calls[0].request.extensions


async def test_non_web_ports_blocked():
    calls = []

    async def resolver(host):
        calls.append(host)
        return ["93.184.216.34"]

    with respx.mock(assert_all_called=False) as mock:
        route = mock.get(url__regex=r".*").mock(return_value=httpx.Response(200))
        for url in ("http://example.com:6379/", "https://example.com:8443/x",
                    "ftp://example.com/", "http://user:pw@example.com/"):  # fmt: skip
            assert await links(resolver).fetch(url, ItemSource.WEB) is None
        assert not route.called and calls == []
    ok = await links(resolver)._pin("https://example.com:443/a")
    assert str(ok[0]) == "https://93.184.216.34/a"


async def test_mapped_and_mixed_private_addresses_blocked():
    async def mixed(host):
        return ["93.184.216.34", "10.0.0.1"]

    async def mapped(host):
        return ["::ffff:127.0.0.1"]

    for r in (mixed, mapped):
        with pytest.raises(ValueError):
            await links(r)._pin("http://example.com/")


@respx.mock
async def test_page_redirect_to_private_network_blocked():
    respx.get("https://93.184.216.34/a").mock(
        return_value=httpx.Response(302, headers={"location": "http://internal/"})
    )
    calls = []

    async def resolver(host):
        calls.append(host)
        return ["93.184.216.34"] if host == "example.com" else ["127.0.0.1"]

    assert await links(resolver).fetch("https://example.com/a", ItemSource.WEB) is None
    assert calls == ["example.com", "internal"]


async def test_private_address_never_fetched():
    with respx.mock(assert_all_called=False) as mock:
        route = mock.get("http://10.0.0.5/").mock(return_value=httpx.Response(200))
        assert await links(private).fetch("http://10.0.0.5/", ItemSource.WEB) is None
        assert not route.called


def test_parsers_tolerate_garbage():
    assert parse_oembed({}) is None
    assert parse_oembed("nope") is None  # type: ignore[arg-type]
    assert parse_page_meta("<html><body>nothing</body></html>") is None


# ---------------------------------------------------------------- places

GOOGLE_RESPONSE = {
    "places": [
        {
            "id": "ChIJabc",
            "displayName": {"text": "Bánh Mì Phượng", "languageCode": "vi"},
            "formattedAddress": "2B Phan Châu Trinh, Hội An, Quảng Nam, Вьетнам",
            "location": {"latitude": 15.8775, "longitude": 108.3271},
            "addressComponents": [
                {"longText": "Хойан", "shortText": "Хойан", "types": ["locality", "political"]},
                {"longText": "Куангнам", "shortText": "Куангнам",
                 "types": ["administrative_area_level_1", "political"]},
                {"longText": "Вьетнам", "shortText": "VN", "types": ["country", "political"]},
            ],
        },
        {"id": "no-location", "displayName": {"text": "x"}},
    ]
}


def test_parse_places_response():
    hits = parse_search_response(GOOGLE_RESPONSE)
    assert len(hits) == 1
    h = hits[0]
    assert (h.provider_place_id, h.name, h.city, h.country) == (
        "ChIJabc", "Bánh Mì Phượng", "Хойан", "VN"
    )
    assert (h.lat, h.lon) == (15.8775, 108.3271)


def test_pick_hit_rejects_other_country():
    hits = parse_search_response(GOOGLE_RESPONSE)
    assert pick_hit(hits, "VN") is hits[0]
    assert pick_hit(hits, "TH") is None
    assert pick_hit(hits, None) is hits[0]


def test_query_cache_key_normalized():
    assert normalize_query("  Bánh Mì   Phượng,  HỘI AN ") == "bánh mì phượng, hội an"
    assert query_hash("Bánh Mì Phượng, Hội An") == query_hash("bánh mì  phượng, hội an")


@respx.mock
async def test_google_places_request_and_errors():
    route = respx.post("https://places.googleapis.com/v1/places:searchText").mock(
        return_value=httpx.Response(200, json=GOOGLE_RESPONSE)
    )
    client = GooglePlacesClient("KEY", httpx.AsyncClient())
    hits = await client.search("Bánh Mì Phượng, Hội An")
    req = route.calls[0].request
    assert req.headers["X-Goog-Api-Key"] == "KEY"
    assert req.headers["X-Goog-FieldMask"] == FIELD_MASK
    assert FIELD_MASK == ("places.id,places.displayName,places.formattedAddress,"
                          "places.location,places.addressComponents")  # fmt: skip
    assert hits[0].provider == "google"

    route.mock(return_value=httpx.Response(400, json={"error": {}}))
    assert await client.search("x") == []
    route.mock(return_value=httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError) as e:
        await client.search("x")
    assert is_transient(e.value)


# ---------------------------------------------------------------- STT


@respx.mock
async def test_groq_transcription():
    route = respx.post("https://api.groq.com/openai/v1/audio/transcriptions").mock(
        return_value=httpx.Response(200, json={"text": " Привет, это Фукуок "})
    )
    stt = WhisperTranscriber("gk", client=httpx.AsyncClient())
    assert await stt.transcribe(b"audio", "a.ogg") == "Привет, это Фукуок"
    req = route.calls[0].request
    assert req.headers["Authorization"] == "Bearer gk"
    assert b"whisper-large-v3-turbo" in req.content

    route.mock(return_value=httpx.Response(400, json={"error": "bad audio"}))
    assert await stt.transcribe(b"audio", "a.ogg") is None
    route.mock(return_value=httpx.Response(429))
    with pytest.raises(httpx.HTTPStatusError):
        await stt.transcribe(b"audio", "a.ogg")


async def test_stt_noop_without_key():
    assert isinstance(build_transcriber("groq", ""), NullTranscriber)
    assert isinstance(build_transcriber("none", "k"), NullTranscriber)
    assert await NullTranscriber().transcribe(b"x", "a.ogg") is None


# ---------------------------------------------------------------- Telegram files


@respx.mock
async def test_telegram_download_and_custom_base():
    respx.post("http://bot-api:8081/botT/getFile").mock(return_value=httpx.Response(
        200, json={"ok": True, "result": {"file_id": "F", "file_size": 3,
                                          "file_path": "photos/f.jpg"}}))  # fmt: skip
    respx.get("http://bot-api:8081/file/botT/photos/f.jpg").mock(
        return_value=httpx.Response(200, content=b"abc")
    )
    f = await TelegramFiles("T", "http://bot-api:8081/", httpx.AsyncClient()).download("F")
    assert f.data == b"abc" and f.filename == "f.jpg"


@respx.mock
async def test_telegram_public_api_too_big():
    respx.post("https://api.telegram.org/botT/getFile").mock(return_value=httpx.Response(
        400, json={"ok": False, "error_code": 400, "description": "Bad Request: file is too big"}
    ))  # fmt: skip
    with pytest.raises(FileTooBigError):
        await TelegramFiles("T", "", httpx.AsyncClient()).download("F")


@respx.mock
async def test_telegram_size_over_limit_from_metadata():
    respx.post("https://api.telegram.org/botT/getFile").mock(return_value=httpx.Response(
        200, json={"ok": True, "result": {"file_size": 25 * 1024 * 1024,
                                          "file_path": "videos/v.mp4"}}))  # fmt: skip
    with pytest.raises(FileTooBigError):
        await TelegramFiles("T", "", httpx.AsyncClient()).download("F")


def test_error_classification():
    req = httpx.Request("GET", "https://x")
    assert is_transient(httpx.ConnectError("x"))
    assert is_transient(httpx.HTTPStatusError("x", request=req, response=httpx.Response(502)))
    assert is_permanent(httpx.HTTPStatusError("x", request=req, response=httpx.Response(404)))


TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"


@respx.mock
async def test_telegram_http_errors_never_contain_the_token():
    respx.post(f"https://api.telegram.org/bot{TOKEN}/getFile").mock(
        return_value=httpx.Response(502, text="Bad Gateway")
    )
    with pytest.raises(httpx.HTTPStatusError) as e:
        await TelegramFiles(TOKEN, "", httpx.AsyncClient()).download("F")
    assert TOKEN not in str(e.value) and "502" in str(e.value)
    assert is_transient(e.value)  # still retried by the queue


@respx.mock
async def test_telegram_file_download_error_has_no_token():
    respx.post(f"https://api.telegram.org/bot{TOKEN}/getFile").mock(return_value=httpx.Response(
        200, json={"ok": True, "result": {"file_size": 3, "file_path": "photos/f.jpg"}}))
    respx.get(f"https://api.telegram.org/file/bot{TOKEN}/photos/f.jpg").mock(
        return_value=httpx.Response(404)
    )
    with pytest.raises(httpx.HTTPStatusError) as e:
        await TelegramFiles(TOKEN, "", httpx.AsyncClient()).download("F")
    assert TOKEN not in str(e.value) and is_permanent(e.value)
