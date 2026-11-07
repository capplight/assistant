"""Local text extraction from documents (spec 2.2 / 6.1). Synchronous and CPU-bound: callers run
these in a thread. Pure-Python libraries only: pdfplumber + pypdfium2 (not PyMuPDF, AGPL),
python-docx, python-calamine. Nothing here leaves the server.
"""

import io
import json
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

PDF_MAX_PAGES = 200  # accepted (spec 6.1)
PDF_READ_PAGES = 30  # read now; the rest after "Читать дальше?"
PDF_MIN_CHARS_PER_PAGE = 50  # fewer -> scanned page -> render 200 dpi -> OCR
PDF_RENDER_DPI = 200
XLSX_MAX_CELLS = 50_000


class ExtractError(Exception):
    """`code` goes to items.error as is (no user content)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class Extracted:
    text: str
    tables: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    # PDF: text per page read, and the pages that need OCR: (page number from 1, PNG bytes)
    pages: list[str] = field(default_factory=list)
    ocr_pages: list[tuple[int, bytes]] = field(default_factory=list)


def _cell(value: object) -> object:
    if value is None:
        return None
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str | int | float | bool):
        return value
    return str(value)


def _row_text(row: list) -> str:
    return " | ".join("" if c is None else str(c).strip() for c in row).strip(" |")


# --- PDF ---


def extract_pdf(data: bytes, *, read_pages: int = PDF_READ_PAGES) -> Extracted:
    import pdfplumber
    from pdfminer.pdfdocument import PDFEncryptionError, PDFPasswordIncorrect

    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except (PDFPasswordIncorrect, PDFEncryptionError) as exc:
        raise ExtractError("pdf_encrypted") from exc
    except Exception as exc:
        if "password" in str(exc).lower() or "encrypt" in type(exc).__name__.lower():
            raise ExtractError("pdf_encrypted") from exc
        raise ExtractError("pdf_unreadable") from exc
    with pdf:
        total = len(pdf.pages)
        if total > PDF_MAX_PAGES:
            raise ExtractError("pdf_too_many_pages")
        texts: list[str] = []
        tables: list[dict] = []
        scanned: list[int] = []
        for number, page in enumerate(pdf.pages[:read_pages], start=1):
            page_text = (page.extract_text() or "").strip()
            for rows in page.extract_tables() or []:
                tables.append({"page": number, "rows": [[_cell(c) for c in r] for r in rows]})
            if len(page_text) < PDF_MIN_CHARS_PER_PAGE:
                scanned.append(number)
            texts.append(page_text)
    ocr_pages = _render_pages(data, scanned) if scanned else []
    meta = {"pages_total": total, "pages_read": min(total, read_pages), "scanned_pages": scanned}
    return Extracted(text="\n\n".join(t for t in texts if t), tables=tables, meta=meta,
                     pages=texts, ocr_pages=ocr_pages)  # fmt: skip


def _render_pages(data: bytes, numbers: list[int]) -> list[tuple[int, bytes]]:
    import pypdfium2 as pdfium

    out: list[tuple[int, bytes]] = []
    doc = pdfium.PdfDocument(data)
    try:
        for number in numbers:
            page = doc[number - 1]
            image = page.render(scale=PDF_RENDER_DPI / 72).to_pil()
            buf = io.BytesIO()
            image.save(buf, format="PNG")
            out.append((number, buf.getvalue()))
            page.close()
    finally:
        doc.close()
    return out


# --- DOCX ---


def extract_docx(data: bytes) -> Extracted:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    try:
        document = docx.Document(io.BytesIO(data))
    except Exception as exc:
        raise ExtractError("docx_unreadable") from exc
    parts: list[str] = []
    headings: list[str] = []
    tables: list[dict] = []
    for element in document.element.body.iterchildren():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "p":
            para = Paragraph(element, document)
            text = para.text.strip()
            if not text:
                continue
            style = (para.style.name if para.style is not None else "") or ""
            if style.startswith(("Heading", "Title")):
                headings.append(text)
            parts.append(text)
        elif tag == "tbl":
            table = Table(element, document)
            rows = [[cell.text.strip() for cell in row.cells] for row in table.rows]
            tables.append({"rows": rows})
            parts.append("\n".join(_row_text(r) for r in rows if any(r)))
    return Extracted(text="\n\n".join(p for p in parts if p), tables=tables,
                     meta={"headings": headings})  # fmt: skip


# --- XLSX ---


def extract_xlsx(data: bytes) -> Extracted:
    from python_calamine import CalamineWorkbook

    try:
        workbook = CalamineWorkbook.from_filelike(io.BytesIO(data))
    except Exception as exc:
        raise ExtractError("xlsx_unreadable") from exc
    sheets: list[dict] = []
    parts: list[str] = []
    cells = 0
    truncated = False
    for name in workbook.sheet_names:
        rows = []
        for raw in workbook.get_sheet_by_name(name).to_python(skip_empty_area=True):
            row = [_cell(c) for c in raw]
            while row and row[-1] in (None, ""):
                row.pop()
            if not row:
                continue
            if cells + len(row) > XLSX_MAX_CELLS:
                truncated = True
                break
            cells += len(row)
            rows.append(row)
        if not rows:
            continue
        sheets.append({"name": name, "headers": rows[0], "rows": rows[1:]})
        parts.append("\n".join([name, *(_row_text(r) for r in rows)]))
        if truncated:
            break
    meta = {"sheets": len(sheets), "cells": cells, "truncated": truncated}
    return Extracted(text="\n\n".join(parts), tables=sheets, meta=meta)


def json_size(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
