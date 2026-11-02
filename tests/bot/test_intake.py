import pytest

from assistant.bot.intake import Action, classify, is_question, strip_urls
from assistant.db.models import ItemKind, ItemSource
from assistant.links import url_hash

from .conftest import CHANNEL_ORIGIN, USER_ORIGIN, make_message


@pytest.mark.parametrize(
    "text",
    [
        "где поесть в Фукуоке?",
        "Что я сохранял про еду",
        "КОГДА мой рейс",
        "покажи пляжи",
        "найди кафе",
        "Какой отель я бронировал",
        "куда сходить вечером",
        "сколько стоит трансфер",
        "как добраться до пляжа",
        "  где  ",
        "это норм?",
    ],
)
def test_questions(text):
    assert is_question(text)


@pytest.mark.parametrize(
    "text",
    [
        "",
        None,
        "Купить крем от солнца",
        "Кафе Бамбук — вкусный фо",
        "Чтобы не забыть: паспорт",
        "Какао на завтрак",
        "Гдето там",
    ],
)
def test_not_questions(text):
    assert not is_question(text)


def test_text_with_two_urls_makes_two_link_items_with_rest_text():
    msg = make_message(
        text="смотри https://www.instagram.com/reel/C1abc/?igsh=x и https://vt.tiktok.com/ZS1/ топ"
    )
    intake = classify(msg)
    assert intake.action is Action.SAVE
    assert [d.kind for d in intake.drafts] == [ItemKind.LINK, ItemKind.LINK]
    assert [d.source for d in intake.drafts] == [ItemSource.INSTAGRAM, ItemSource.TIKTOK]
    assert intake.drafts[0].url_hash == url_hash("https://instagram.com/reel/C1abc")
    assert all(d.raw_text == "смотри и топ" for d in intake.drafts)


def test_same_url_twice_in_message_is_one_item():
    msg = make_message(text="https://instagram.com/reel/X/ https://www.instagram.com/reel/X/?igsh=1")
    intake = classify(msg)
    assert len(intake.drafts) == 1
    assert intake.drafts[0].raw_text is None


def test_question_with_url_is_saved_not_answered():
    intake = classify(make_message(text="где это? https://t.me/travelkz/1"))
    assert intake.action is Action.SAVE
    assert intake.drafts[0].source is ItemSource.TELEGRAM


def test_plain_question_goes_to_qa():
    intake = classify(make_message(text="Где поесть фо?"))
    assert intake.action is Action.QUESTION
    assert intake.question == "Где поесть фо?"


def test_plain_note_is_text_item():
    intake = classify(make_message(text="Взять адаптер для розеток"))
    assert intake.action is Action.SAVE
    (d,) = intake.drafts
    assert (d.kind, d.source, d.raw_text) == (
        ItemKind.TEXT,
        ItemSource.USER,
        "Взять адаптер для розеток",
    )


def test_forwarded_channel_text_is_telegram_text_item_even_if_question_like():
    intake = classify(
        make_message(text="Где поесть на Фукуоке? Топ-5 мест", forward_origin=CHANNEL_ORIGIN)
    )
    assert intake.action is Action.SAVE
    (d,) = intake.drafts
    assert d.kind is ItemKind.TEXT
    assert d.source is ItemSource.TELEGRAM


def test_forwarded_from_user_with_photo():
    msg = make_message(
        forward_origin=USER_ORIGIN,
        photo=[
            {"file_id": "small", "file_unique_id": "s", "width": 90, "height": 90},
            {"file_id": "big", "file_unique_id": "b", "width": 1280, "height": 1280},
        ],
        caption="Бронь отеля",
    )
    (d,) = classify(msg).drafts
    assert (d.kind, d.source, d.telegram_file_id, d.raw_text) == (
        ItemKind.PHOTO,
        ItemSource.TELEGRAM,
        "big",
        "Бронь отеля",
    )


def test_own_photo_with_url_in_caption():
    msg = make_message(
        photo=[{"file_id": "p", "file_unique_id": "p", "width": 10, "height": 10}],
        caption="скрин https://booking.com/hotel/x",
    )
    drafts = classify(msg).drafts
    assert [(d.kind, d.source) for d in drafts] == [
        (ItemKind.PHOTO, ItemSource.USER),
        (ItemKind.LINK, ItemSource.WEB),
    ]
    assert drafts[0].raw_text == "скрин"
    assert drafts[1].url == "https://booking.com/hotel/x"


_F = {"file_id": "v", "file_unique_id": "v"}


@pytest.mark.parametrize(
    ("field", "value", "kind"),
    [
        ("video", {**_F, "width": 1, "height": 1, "duration": 3}, ItemKind.VIDEO),
        ("video_note", {**_F, "length": 1, "duration": 3}, ItemKind.VIDEO),
        ("document", {**_F, "file_name": "ticket.pdf"}, ItemKind.DOCUMENT),
        ("voice", {**_F, "duration": 3}, ItemKind.VOICE),
        ("audio", {**_F, "duration": 3}, ItemKind.VOICE),
    ],
)
def test_media_kinds(field, value, kind):
    (d,) = classify(make_message(**{field: value})).drafts
    assert d.kind is kind
    assert d.source is ItemSource.USER
    assert d.telegram_file_id == "v"
    assert d.raw_text is None


def test_location_goes_to_nearby():
    intake = classify(make_message(location={"latitude": 10.2, "longitude": 103.96}))
    assert intake.action is Action.LOCATION
    assert (intake.lat, intake.lon) == (10.2, 103.96)


def test_sticker_is_ignored():
    sticker = {
        **_F,
        "type": "regular",
        "width": 1,
        "height": 1,
        "is_animated": False,
        "is_video": False,
    }
    assert classify(make_message(sticker=sticker)).action is Action.IGNORE


def test_strip_urls():
    assert strip_urls("https://a.com") is None
    assert strip_urls("а https://a.com б\n\n\n\nв") == "а б\n\nв"
