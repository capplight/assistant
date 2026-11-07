"""Split a record's text into chunks for embedding. Pure code, no I/O.

Paragraph first, then sentence, then a hard cut; neighbouring chunks overlap so a phrase on a
boundary stays findable. Sizes are in characters, about 350 bge-m3 tokens for Russian. `token_count`
is an estimate (no tokenizer here); bge-m3 takes 8 192 tokens, so a chunk always fits.
"""

import re
from dataclasses import dataclass

TARGET_CHARS = 1200
OVERLAP_CHARS = 150
CHARS_PER_TOKEN = 3.5  # estimate for Russian and Kazakh
_SENTENCE = re.compile(r"(?<=[.!?…])\s+")


@dataclass(frozen=True)
class TextChunk:
    ord: int
    text: str
    token_count: int


def estimate_tokens(text: str) -> int:
    return max(1, round(len(text) / CHARS_PER_TOKEN))


def _pieces(text: str, size: int) -> list[str]:
    """Paragraphs and sentences no longer than `size`."""
    out: list[str] = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(paragraph) <= size:
            out.append(paragraph)
            continue
        for sentence in _SENTENCE.split(paragraph):
            while len(sentence) > size:
                cut = sentence.rfind(" ", size // 2, size)
                cut = size if cut < 0 else cut
                out.append(sentence[:cut].strip())
                sentence = sentence[cut:].strip()
            if sentence:
                out.append(sentence)
    return out


def _tail(text: str, size: int) -> str:
    """The end of a chunk to repeat in the next one, from a word start."""
    if len(text) <= size:
        return text
    tail = text[-size:]
    space = tail.find(" ")
    return tail[space + 1:] if space >= 0 else tail


def chunk_text(text: str | None, *, size: int = TARGET_CHARS,
               overlap: int = OVERLAP_CHARS) -> list[TextChunk]:  # fmt: skip
    if not text or not text.strip():
        return []
    groups: list[str] = []
    current = ""
    fresh = False  # does `current` hold anything beyond the overlap?
    # Pieces leave room for the overlap and its separator, so a chunk stays within `size`.
    for piece in _pieces(text, size - overlap - 2):
        if fresh and len(current) + 2 + len(piece) > size:
            groups.append(current)
            current = _tail(current, overlap)
            fresh = False
        current = f"{current}\n\n{piece}" if current else piece
        fresh = True
    if fresh:
        groups.append(current)
    return [TextChunk(n, g, estimate_tokens(g)) for n, g in enumerate(groups)]
