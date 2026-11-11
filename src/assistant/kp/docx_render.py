"""The КП as a Word file (spec 6.7 step 5, R-27: «Ещё → Сделать в Word»), week 15. The same context
as the PDF (`render.build_context`: data, code's totals, the sum in words, the decrypted profile),
so the numbers are the same by construction; no model. The layout is v2 of the PDF (the founder's
father's real КП, which he sends as Word): letterhead, «Исх. №», the buyer's name, «КОММЕРЧЕСКОЕ
ПРЕДЛОЖЕНИЕ № N», subject, intro with the licence, the table (lump sums: № | Наименование | Объём
| Стоимость), «ИТОГО без НДС», «Общая стоимость: … (прописью), без НДС.», «Условия», «Будем рады
сотрудничеству.», the signer with phone and e-mail.

python-docx (pure Python on lxml: nothing native, unlike WeasyPrint) builds the document. The spec
names `docxtpl`; a packaged .docx template would be a binary file to keep in step with the HTML
one, so the layout is code here and hashed like the HTML template (`doc_templates` row
`builtin:kp_docx_v1`, migration 0021; tests/kp checks the hash).

Deterministic: the zip entries get a fixed time, the core properties are dated by the version
(`meta.created`), and nothing else varies. AI marking (spec 5.9, R-06): core properties
`subject`, `keywords` and `comments` = `settings.kp_ai_metadata` always; the visible line only with
`kp_visible_ai_label` — the single label rule of the PDF. Font: Arial (every Kazakh letter, present
wherever Word is); a Word file does not carry the PDF's packaged fonts.
"""

import asyncio
import base64
import hashlib
import io
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TEMPLATE_KEY = "builtin:kp_docx_v1"
FONT = "Arial"
ZIP_TIME = (2026, 1, 1, 0, 0, 0)
CRLF, LF = bytes([13, 10]), bytes([10])


def template_hash() -> str:
    """Of this builder's source with LF line ends (a changed layout is a new template version)."""
    raw = Path(__file__).read_bytes().replace(CRLF, LF)
    return hashlib.sha256(raw).hexdigest()


def fonts_hash() -> str:
    return hashlib.sha256(FONT.encode()).hexdigest()


def _image(uri: str | None) -> io.BytesIO | None:
    if not uri or not uri.startswith("data:") or ";base64," not in uri:
        return None
    return io.BytesIO(base64.b64decode(uri.split(";base64,", 1)[1]))


def _stable_zip(raw: bytes) -> bytes:
    """The same parts with a fixed time and order: the same version gives the same bytes."""
    src = zipfile.ZipFile(io.BytesIO(raw))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for name in src.namelist():
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            dst.writestr(info, src.read(name))
    return out.getvalue()


def build_docx(context: dict[str, Any]) -> bytes:
    """`context` = `render.build_context(...)` (everything already formatted by code)."""
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.shared import Mm, Pt, RGBColor

    doc_ctx, seller, buyer = context["doc"], context["seller"], context["buyer"]
    blocks, images, meta = context["blocks"], context["images"], context["meta"]

    d = Document()
    sec = d.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.top_margin, sec.bottom_margin = Mm(16), Mm(18)
    sec.left_margin, sec.right_margin = Mm(16), Mm(14)
    style = d.styles["Normal"]
    style.font.name = FONT
    style.font.size = Pt(10)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    style.paragraph_format.space_after = Pt(1)

    def para(text: str = "", *, bold: bool = False, size: float | None = None,
             muted: bool = False, align: Any = None) -> Any:  # fmt: skip
        p = d.add_paragraph()
        if text:
            run = p.add_run(text)
            run.bold = bold
            if size:
                run.font.size = Pt(size)
            if muted:
                run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
        if align is not None:
            p.alignment = align
        return p

    def picture(key: str, height: float) -> bool:
        data = _image(images.get(key))
        if data is None:
            return False
        try:
            d.add_picture(data, height=Mm(height))
        except Exception:  # not an image Word can show (python-docx reads PNG / JPEG / GIF …)
            return False
        return True

    v2 = context["v2"]
    head = v2["letterhead"]
    if picture("logo", 16):
        d.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.LEFT
    center = WD_ALIGN_PARAGRAPH.CENTER
    if head["form"]:
        para(head["form"], bold=True, size=10, align=center)
    para(head["name"], bold=True, size=13, align=center)
    if head["address"]:
        para(head["address"], size=8.5, align=center)
    if head["requisites"]:
        para(head["requisites"], size=8.5, align=center)
    rule = para("_" * 86, muted=True, align=center)
    rule.paragraph_format.space_after = Pt(6)

    out_no = "Исх. №" + (f" {v2['outgoing']['number']}" if v2["outgoing"]["number"] else "") + (
        f" от {v2['outgoing']['date']} г." if v2["outgoing"]["date"] else "")
    para(out_no)
    right = WD_ALIGN_PARAGRAPH.RIGHT
    para(buyer["name"] or "", bold=True, align=right)
    if buyer["bin"]:
        para(f"БИН/ИИН {buyer['bin']}", align=right)

    title = "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ" + (f" № {doc_ctx['number']}" if doc_ctx["number"] else "")
    para(title, bold=True, size=13, align=center).paragraph_format.space_before = Pt(14)
    if v2["subject"]:
        para(v2["subject"], align=center)
    intro = ""
    if v2["license_line"]:
        intro = f"{v2['seller_quoted'] or ''}, {v2['license_line']}."
    if blocks["intro"]:
        intro = f"{intro} {blocks['intro']}".strip()
    if intro:
        p = para(intro, align=WD_ALIGN_PARAGRAPH.JUSTIFY)
        p.paragraph_format.first_line_indent = Mm(10)
        p.paragraph_format.space_before = Pt(6)

    table_ctx = v2["table"]
    sign = table_ctx["sign"]
    lump = table_ctx["lump"]
    discounts = context["has_discounts"] and not lump
    heads = ["№", "Наименование", "Объём"]
    if not lump:
        heads.append(f"Цена, {sign}")
        if discounts:
            heads.append("Скидка")
    heads.append(f"Стоимость, {sign}")
    d.add_paragraph()
    table = d.add_table(rows=1, cols=len(heads))
    table.style = "Table Grid"
    for cell, text in zip(table.rows[0].cells, heads, strict=True):
        cell.text = ""
        run = cell.paragraphs[0].add_run(text)
        run.bold = True
        cell.paragraphs[0].alignment = center
    for ln in context["lines"]:
        values = [str(ln["n"]), ln["name"], ln["volume"]]
        if not lump:
            values.append("" if ln["lump"] else ln["price"])
            if discounts:
                values.append(ln["discount"] or "")
        values.append(ln["amount"])
        cells = table.add_row().cells
        for i, (cell, text) in enumerate(zip(cells, values, strict=True)):
            cell.text = text
            if i >= 3:
                cell.paragraphs[0].alignment = right
            elif i in (0, 2):
                cell.paragraphs[0].alignment = center
    for label, value in table_ctx["rows"]:
        cells = table.add_row().cells
        merged = cells[0].merge(cells[len(heads) - 2])
        merged.text = ""
        merged.paragraphs[0].add_run(label).bold = True
        cells[-1].text = ""
        cells[-1].paragraphs[0].add_run(value).bold = True
        cells[-1].paragraphs[0].alignment = right

    para(v2["total_line"]).paragraph_format.space_before = Pt(8)
    for w in v2["extra_words"]:
        para(w)
    para("Условия:", bold=True).paragraph_format.space_before = Pt(6)
    for c in v2["conditions"]:
        p = para(f"– {c}")
        p.paragraph_format.left_indent = Mm(4)
        p.paragraph_format.first_line_indent = Mm(-4)
    para(v2["closing"]).paragraph_format.space_before = Pt(8)

    signer = v2["signer"]
    p = para(signer["title"] + (f" {signer['company']}" if signer["company"] else ""))
    p.paragraph_format.space_before = Pt(18)
    if signer["name"]:
        para(signer["name"], bold=True)
    if signer["phone"]:
        para(f"моб.: {signer['phone']}")
    if signer["email"]:
        para(f"e-mail: {signer['email']}")
    picture("signature", 16)
    picture("stamp", 30)
    if meta["visible_label"]:
        para(meta["visible_label"], size=7.5, muted=True).paragraph_format.space_before = Pt(12)

    cp = d.core_properties
    created = datetime.fromisoformat(meta["created"]).astimezone(UTC).replace(microsecond=0)
    cp.title = doc_ctx["title"]
    cp.author = seller["name"] or ""
    cp.last_modified_by = seller["name"] or ""
    cp.subject = meta["ai"]
    cp.keywords = meta["ai"]
    cp.comments = meta["ai"]
    cp.category = "Коммерческое предложение"
    cp.created = cp.modified = created.replace(tzinfo=None)
    cp.revision = 1
    buf = io.BytesIO()
    d.save(buf)
    return _stable_zip(buf.getvalue())


class DocxRenderer:
    """In a worker thread (CPU work, no network)."""

    async def render(self, context: dict[str, Any]) -> bytes:
        return await asyncio.to_thread(build_docx, context)


__all__ = ["DOCX_MIME", "DocxRenderer", "TEMPLATE_KEY", "build_docx", "fonts_hash",
           "template_hash"]  # fmt: skip
