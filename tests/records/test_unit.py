"""Records: text normalization, hash vectors, review fields, adapters, extractors (no DB)."""

import hashlib

import pytest

from assistant.records.adapters import (
    FakeOcr,
    FakeTranscriber,
    UnavailableTranscriber,
    make_ocr,
    make_transcriber,
    parse_tesseract_tsv,
)
from assistant.records.extract import ExtractError, extract_docx, extract_pdf, extract_xlsx
from assistant.records.textnorm import (
    content_hash,
    detect_lang,
    detect_review_fields,
    find_links,
    hash_basis,
    normalize_text,
    title_from_text,
)
from tests.records.fixtures import make_docx, make_pdf, make_xlsx

# Shared with the phone (same vectors in the mobile test suite).
HASH_VECTORS = [
    ("Купить хлеб!", "купить хлеб"),
    ("  КУПИТЬ   хлеб 🍞 ", "купить хлеб"),
    ("Позвонить Ерлану, в 10:30.", "позвонить ерлану в 10 30"),
    ("Сәлем, әлем!", "сәлем әлем"),
    ("ＦＵＬＬ　ｗｉｄｔｈ", "full width"),
    ("tab\tand\nnewline", "tab and newline"),
]


@pytest.mark.parametrize(("raw", "basis"), HASH_VECTORS)
def test_hash_basis_vectors(raw, basis):
    assert hash_basis(raw) == basis
    assert content_hash(raw) == hashlib.sha256(basis.encode()).hexdigest()


def test_content_hash_equal_for_cosmetic_differences_and_empty_is_none():
    assert content_hash("Купить хлеб!") == content_hash("купить   ХЛЕБ")
    assert content_hash("Купить хлеб") != content_hash("Купить хлеба")
    assert content_hash("") is None
    assert content_hash("!!! 🍞") is None
    assert content_hash(None) is None


def test_normalize_text():
    assert normalize_text("  a​  b \r\n\r\n\r\n\r\nc  ") == "a b\n\nc"
    assert normalize_text("é") == "é"  # NFC


def test_detect_lang():
    assert detect_lang("Купить хлеб и молоко") == "ru"
    assert detect_lang("Нан мен сүт сатып алу") == "kk"
    assert detect_lang("Buy bread and milk") == "en"
    assert detect_lang("12345") is None
    assert detect_lang(None) is None


def test_find_links_and_title():
    assert find_links("см. https://example.kz/a?b=1, и http://x.y/z).") == [
        "https://example.kz/a?b=1", "http://x.y/z"]  # fmt: skip
    assert title_from_text("\n\nПервая строка\nвторая") == "Первая строка"
    long = "слово " * 30
    title = title_from_text(long)
    assert title is not None and title.endswith("…") and len(title) <= 81


def test_review_fields_detect_numbers():
    text = ("Тел: +7 701 123-45-67, ИИН 900101300123, IBAN KZ86125KZT5004100100, "
            "сумма 12 500 ₸, договор № AB-123/24, KG +996 555 123 456")  # fmt: skip
    fields = detect_review_fields(text)
    kinds = sorted(v["kind"] for v in fields.values())
    assert kinds == ["amount", "doc_number", "iban", "iin_bin", "phone", "phone"]
    assert all(v["state"] == "unverified" for v in fields.values())
    assert fields["iban_1"]["value"] == "KZ86125KZT5004100100"
    assert fields["phone_1"]["value"] == "+7 701 123-45-67"
    assert detect_review_fields("просто текст") == {}


def test_parse_tesseract_tsv():
    tsv = "\n".join([
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
        "1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t",
        "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90\tКупить",
        "5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t80\tхлеб",
        "5\t1\t1\t1\t2\t1\t0\t0\t10\t10\t70\tмолоко",
        "5\t1\t1\t1\t2\t2\t0\t0\t10\t10\t-1\t ",
    ])  # fmt: skip
    result = parse_tesseract_tsv(tsv)
    assert result.text == "Купить хлеб\nмолоко"
    assert result.confidence == 0.8
    assert parse_tesseract_tsv("").confidence == 0.0


async def test_adapters_factories_and_fakes():
    assert isinstance(make_ocr("fake"), FakeOcr)
    assert isinstance(make_transcriber("fake"), FakeTranscriber)
    assert isinstance(make_transcriber("groq"), UnavailableTranscriber)  # no keys yet
    with pytest.raises(Exception, match="no speech-to-text"):
        await UnavailableTranscriber().transcribe(b"x", mime="audio/aac", lang_hint=None)
    ocr = FakeOcr("текст", 0.9)
    assert (await ocr.recognize(b"img", langs="rus")).text == "текст"
    assert ocr.calls == 1


def test_extract_pdf_text_and_scanned_pages():
    line = "Invoice number 42 for cement delivery to Almaty, total due in December."
    ex = extract_pdf(make_pdf([line, ""]))
    assert line in ex.text
    assert ex.meta["pages_total"] == 2 and ex.meta["scanned_pages"] == [2]
    assert [n for n, _ in ex.ocr_pages] == [2]
    assert ex.ocr_pages[0][1][:8] == b"\x89PNG\r\n\x1a\n"


def test_extract_pdf_garbage_is_unreadable():
    with pytest.raises(ExtractError) as err:
        extract_pdf(b"not a pdf at all")
    assert err.value.code == "pdf_unreadable"


def test_extract_docx_paragraphs_headings_tables():
    ex = extract_docx(make_docx())
    assert "Договор поставки" in ex.text and "Цемент | 2500" in ex.text
    assert ex.meta["headings"] == ["Договор поставки"]
    assert ex.tables[0]["rows"][1] == ["Цемент", "2500"]


def test_extract_xlsx_cells_json():
    ex = extract_xlsx(make_xlsx())
    sheet = ex.tables[0]
    assert sheet["name"] == "Прайс"
    assert sheet["headers"] == ["Товар", "Цена", "Ед."]
    assert sheet["rows"][0] == ["Цемент М500", 2500, "мешок"]
    assert sheet["rows"][1][1] == 12000  # whole floats become ints
    assert "Цемент М500 | 2500 | мешок" in ex.text
    with pytest.raises(ExtractError):
        extract_xlsx(b"nope")


def test_extract_docx_garbage():
    with pytest.raises(ExtractError) as err:
        extract_docx(b"nope")
    assert err.value.code == "docx_unreadable"
