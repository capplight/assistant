"""Tiny synthetic PDFs for the week 13 tests: bank statements and receipts that never existed.

No PDF library is installed for writing, so this builds the file by hand: one simple font whose
byte codes map to Unicode through a ToUnicode CMap (Cyrillic, ₸, №…), fixed widths (0.5 em) so
pdfplumber splits words on spaces and columns on x. Glyphs do not render nicely; text extraction,
which is all the server does, is exact. Every name, account and amount here is invented.
"""

from dataclasses import dataclass, field

FONT_SIZE = 8.0
CHAR_W = 0.5  # em
PAGE_W, PAGE_H = 595, 842
LINE_H = 12


def _codes(lines: list[str]) -> dict[str, int]:
    chars = sorted({ch for line in lines for ch in line if ord(ch) > 126 or ord(ch) < 32})
    if len(chars) > 128:
        raise ValueError("too many distinct non-ASCII characters for one simple font")
    return {ch: 128 + i for i, ch in enumerate(chars)}


def _escape(raw: bytes) -> bytes:
    out = bytearray()
    for b in raw:
        if b in (0x28, 0x29, 0x5C):  # ( ) \
            out += b"\\" + bytes([b])
        elif b < 32 or b > 126:
            out += f"\\{b:03o}".encode()
        else:
            out.append(b)
    return bytes(out)


def _tounicode(codes: dict[str, int]) -> bytes:
    pairs = [(c, c) for c in range(32, 127)] + [(v, ord(k)) for k, v in codes.items()]
    body = "\n".join(f"<{c:02X}> <{u:04X}>" for c, u in pairs)
    return (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Synth def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\n"
        f"endcodespacerange\n{len(pairs)} beginbfchar\n{body}\nendbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
    ).encode()


@dataclass
class Page:
    """Text placed at (x, y-from-top) in points."""

    cells: list[tuple[float, float, str]] = field(default_factory=list)

    def text(self, x: float, y: float, value: str) -> None:
        self.cells.append((x, y, value))


def build(pages: list[Page]) -> bytes:
    all_text = [t for p in pages for _, _, t in p.cells]
    codes = _codes(all_text)
    objects: list[bytes] = []

    def add(obj: bytes) -> int:
        objects.append(obj)
        return len(objects)

    catalog = add(b"")  # placeholders, filled below
    pages_id = add(b"")
    tounicode = _tounicode(codes)
    cmap_id = add(b"<< /Length %d >>\nstream\n" % len(tounicode) + tounicode + b"\nendstream")
    widths = " ".join(str(int(CHAR_W * 1000)) for _ in range(256))
    desc_id = add(b"<< /Type /FontDescriptor /FontName /SynthMono /Flags 32 "
                  b"/FontBBox [0 -200 600 800] /ItalicAngle 0 /Ascent 800 /Descent -200 "
                  b"/CapHeight 700 /StemV 80 /MissingWidth 500 >>")
    font_id = add(f"<< /Type /Font /Subtype /Type1 /BaseFont /SynthMono /FirstChar 0 "
                  f"/LastChar 255 /Widths [{widths}] /FontDescriptor {desc_id} 0 R "
                  f"/ToUnicode {cmap_id} 0 R >>".encode())
    kids = []
    for page in pages:
        ops = [b"BT", f"/F1 {FONT_SIZE} Tf".encode()]
        for x, y, value in page.cells:
            raw = bytes(codes.get(ch, ord(ch)) for ch in value)
            ops.append(f"1 0 0 1 {x:.2f} {PAGE_H - y:.2f} Tm".encode())
            ops.append(b"(" + _escape(raw) + b") Tj")
        ops.append(b"ET")
        stream = b"\n".join(ops)
        content_id = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        kids.append(add(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                        f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
                        f"/Contents {content_id} 0 R >>".encode()))
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode()
    objects[pages_id - 1] = (f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] "
                             f"/Count {len(kids)} >>").encode()
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n").encode()
    return bytes(out)


def text_pdf(lines: list[str], x: float = 40) -> bytes:
    """One page of plain lines (a shared receipt)."""
    page = Page()
    for i, line in enumerate(lines):
        page.text(x, 60 + i * LINE_H, line)
    return build([page])
