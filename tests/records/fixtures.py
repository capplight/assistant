"""Small document fixtures built in code (no binary files in the repo)."""

import io


def make_pdf(pages: list[str]) -> bytes:
    """Minimal valid PDF, one Helvetica text line per page ('' = blank page, like a scan)."""
    objects: list[bytes] = []
    n_pages = len(pages)
    font_id = 3 + 2 * n_pages
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n_pages))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())
    for i, text in enumerate(pages):
        content_id = 4 + 2 * i
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>".encode()
        )
        safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 50 700 Td ({safe}) Tj ET".encode() if text else b""
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
              % (len(objects) + 1, xref))  # fmt: skip
    return out.getvalue()


def make_docx() -> bytes:
    import docx

    document = docx.Document()
    document.add_heading("Договор поставки", level=1)
    document.add_paragraph("Поставщик обязуется передать товар до 15 декабря.")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Товар"
    table.cell(0, 1).text = "Цена"
    table.cell(1, 0).text = "Цемент"
    table.cell(1, 1).text = "2500"
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


def make_xlsx() -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Прайс"
    ws.append(["Товар", "Цена", "Ед."])
    ws.append(["Цемент М500", 2500, "мешок"])
    ws.append(["Песок", 12000.0, "т"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
