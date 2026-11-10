"""The КП file (spec 6.7 step 5): Jinja2 → HTML → PDF with WeasyPrint. PDF is the default (the
cheapest for the model: none is used here at all); DOCX comes in week 15 with the same data and the
same `calc`.

Deterministic: the template (`templates/kp_v1.html.j2`), the fonts (`fonts/DejaVuSans*.ttf`, they
have every Kazakh letter: ә і ң ғ ү ұ қ ө һ, and ₸, №) and the data make the file. WeasyPrint
embeds the fonts (subset) in the PDF; the creation date is the version's own time, not «now».
`doc_templates` (0020) holds the hashes of the template and the fonts; tests/kp checks that the
packaged files still match, so a changed layout must be a new template version.

AI marking (spec 5.9, R-06): the PDF metadata always say it (`Subject` and `Keywords` =
`settings.kp_ai_metadata`). The visible line on the page is `settings.kp_visible_ai_label`, off
until the lawyer says otherwise. XMP `dc:description` is not written yet: WeasyPrint writes XMP
only for PDF/A output [week 15, with DOCX core properties].

The renderer is a small class: `WeasyPdfRenderer` (needs Pango, present on the Linux image),
`FakePdfRenderer` for tests. On a machine without Pango, `WeasyPdfRenderer.render` raises
`RendererUnavailable` (the API answers `503 kp_render_unavailable`).
"""

import asyncio
import base64
import hashlib
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

from assistant.kp import calc, words

HERE = Path(__file__).resolve().parent
TEMPLATES = HERE / "templates"
FONTS = HERE / "fonts"
TEMPLATE_FILE = "kp_v1.html.j2"
TEMPLATE_KEY = "builtin:kp_v1"
FONT_FILES = ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf")
GENERATOR = "Assistant КП kp_v1"
CURRENCY_SIGN = {"KZT": "₸", "RUB": "₽", "USD": "$", "EUR": "€"}
LEGAL_PREFIX = {"ip": "ИП", "too": "ТОО", "ao": "АО"}


CRLF, LF = bytes([13, 10]), bytes([10])


class RendererUnavailable(RuntimeError):
    pass


def template_hash() -> str:
    """Of the text with LF line ends (a Windows checkout with CRLF hashes the same)."""
    raw = (TEMPLATES / TEMPLATE_FILE).read_bytes().replace(CRLF, LF)
    return hashlib.sha256(raw).hexdigest()


def fonts_hash() -> str:
    h = hashlib.sha256()
    for name in FONT_FILES:
        h.update(name.encode() + b"\0" + (FONTS / name).read_bytes())
    return h.hexdigest()


_env = Environment(loader=FileSystemLoader(str(TEMPLATES)), autoescape=select_autoescape(["j2"]),
                   undefined=StrictUndefined, keep_trailing_newline=True)  # fmt: skip


def render_html(context: dict[str, Any]) -> str:
    return _env.get_template(TEMPLATE_FILE).render(**context)


def _day(value: str | None) -> str | None:
    if not value:
        return None
    return date.fromisoformat(value).strftime("%d.%m.%Y")


def _qty(value: str) -> str:
    q = Decimal(value).normalize()
    text = f"{q:f}"
    whole, _, frac = text.partition(".")
    groups = []
    while whole:
        groups.insert(0, whole[-3:])
        whole = whole[:-3]
    return " ".join(groups) + ("," + frac if frac else "")


def data_uri(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def seller_name(profile: dict[str, Any]) -> str | None:
    name = profile.get("name")
    prefix = LEGAL_PREFIX.get(profile.get("legal_form") or "")
    if name and prefix and not name.upper().startswith(prefix):
        return f"{prefix} «{name}»" if prefix != "ИП" else f"ИП {name}"
    return name


def build_context(*, data: dict[str, Any], totals: dict[str, Any], profile: dict[str, Any],
                  images: dict[str, str | None], created_at: str, word_langs: list[str],
                  ai_metadata: str, visible_label: str | None,
                  valid_until: str | None) -> dict[str, Any]:  # fmt: skip
    """Everything the template prints, already formatted by code. `profile` is the decrypted
    profile dict (kp/profile.py `profile_dict`); `totals` is `calc.Totals.as_json()`."""
    currency = data.get("currency") or "KZT"
    by_id = {t["id"]: t for t in totals["lines"]}
    lines = []
    has_discounts = False
    for i, it in enumerate(data.get("items") or [], start=1):
        t = by_id[str(it["id"])]
        disc = Decimal(str(it.get("discount_pct") or "0"))
        has_discounts = has_discounts or disc > 0
        lines.append({"n": i, "name": it["name"], "unit": it.get("unit"), "qty": _qty(it["qty"]),
                      "price": calc.format_amount(it["unit_price"]),
                      "discount": f"{disc.normalize():f}%" if disc > 0 else None,
                      "amount": calc.format_amount(t["amount"])})  # fmt: skip
    bank = profile.get("bank") or {}
    contacts = profile.get("contacts") or {}
    signer = profile.get("signer") or {}
    client = data.get("client") or {}
    terms = data.get("terms") or {}
    validity = None
    if valid_until:
        days = terms.get("validity_days")
        validity = f"до {_day(valid_until)}" + (f" ({days} дн.)" if days else "")
    doc_pct = Decimal(str(data.get("discount_total_pct") or "0"))
    total = Decimal(totals["total"])
    return {
        "doc": {"lang": "ru", "title": f"Коммерческое предложение {data.get('number') or ''}"
                .strip(), "number": data.get("number"), "date": _day(data.get("date")),
                "valid_until": _day(valid_until), "currency_sign": CURRENCY_SIGN.get(currency,
                                                                                     currency)},
        "seller": {"name": seller_name(profile), "bin_iin": profile.get("bin_iin"),
                   "bin_label": "ИИН" if profile.get("legal_form") == "ip" else "БИН",
                   "address": profile.get("address"),
                   "bank": {k: bank.get(k) for k in ("iban", "bank", "bik", "kbe")},
                   "contacts": " · ".join(str(contacts[k]) for k in ("phone", "email", "website")
                                          if contacts.get(k)) or None,
                   "signer_name": signer.get("name"), "signer_title": signer.get("title")},
        "buyer": {"name": client.get("name"), "bin": client.get("bin"),
                  "contact": client.get("contact")},
        "lines": lines, "has_discounts": has_discounts,
        "totals": {"lines_sum": calc.format_amount(totals["lines_sum"]),
                   "discount_total": (calc.format_amount(totals["discount_total"])
                                      if Decimal(totals["discount_total"]) > 0 else None),
                   "discount_pct": f"{doc_pct.normalize():f}",
                   "net": calc.format_amount(totals["net"]),
                   "vat": calc.format_amount(totals["vat"]),
                   "total": calc.format_amount(total), "vat_mode": totals["vat_mode"],
                   "vat_rate": (f"{Decimal(totals['vat_rate']).normalize():f}"
                                if totals.get("vat_rate") else None)},
        "words": [words.amount_in_words(total, currency, lang) for lang in word_langs],
        "terms": {"payment": terms.get("payment"), "delivery": terms.get("delivery"),
                  "warranty": terms.get("warranty"), "validity": validity},
        "blocks": {"intro": (data.get("text_blocks") or {}).get("intro"),
                   "outro": (data.get("text_blocks") or {}).get("outro")},
        "images": {k: images.get(k) for k in ("logo", "signature", "stamp")},
        "meta": {"ai": ai_metadata, "generator": GENERATOR, "created": created_at,
                 "visible_label": visible_label},
    }  # fmt: skip


class PdfRenderer(Protocol):
    async def render(self, html: str) -> bytes: ...


class WeasyPdfRenderer:
    """HTML → PDF in a worker thread. The fonts resolve against `fonts/` (base_url)."""

    async def render(self, html: str) -> bytes:
        def run() -> bytes:
            try:
                import weasyprint  # needs Pango/HarfBuzz (system libraries)
            except (ImportError, OSError) as exc:
                raise RendererUnavailable(str(exc)[:200]) from exc
            return weasyprint.HTML(string=html, base_url=str(FONTS) + "/").write_pdf()

        return await asyncio.to_thread(run)


class FakePdfRenderer:
    """Tests: a stand-in «PDF» that carries the HTML, so a test can read what would be printed."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def render(self, html: str) -> bytes:
        self.calls.append(html)
        return b"%PDF-FAKE\n" + html.encode()


__all__ = ["FONTS", "FakePdfRenderer", "PdfRenderer", "RendererUnavailable", "TEMPLATE_KEY",
           "WeasyPdfRenderer", "build_context", "data_uri", "fonts_hash", "render_html",
           "seller_name", "template_hash"]  # fmt: skip
