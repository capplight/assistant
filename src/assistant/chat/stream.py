"""Reads the `answer` string out of a structured answer while its JSON is still streaming.

The model answers with JSON (structured output, never free text). The text the person reads is
the value of one string field; this decodes it incrementally, escapes included, and ignores
everything else in the stream.
"""

import json
import re

_KEY_RE = re.compile(r'"answer"\s*:\s*"')
_SIMPLE_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r",
                   "t": "\t"}  # fmt: skip


class FieldStream:
    def __init__(self, key_re: re.Pattern[str] = _KEY_RE) -> None:
        self.key_re = key_re
        self.raw = ""
        self.pos: int | None = None  # index in raw of the next undecoded char of the value
        self.closed = False
        self.value = ""

    def feed(self, delta: str) -> str:
        """Append raw JSON; return the newly decoded part of the value."""
        self.raw += delta
        if self.closed:
            return ""
        if self.pos is None:
            m = self.key_re.search(self.raw)
            if m is None:
                return ""
            self.pos = m.end()
        out: list[str] = []
        i = self.pos
        raw = self.raw
        while i < len(raw):
            ch = raw[i]
            if ch == '"':
                self.closed = True
                i += 1
                break
            if ch != "\\":
                out.append(ch)
                i += 1
                continue
            if i + 1 >= len(raw):
                break  # escape split across deltas
            esc = raw[i + 1]
            if esc in _SIMPLE_ESCAPES:
                out.append(_SIMPLE_ESCAPES[esc])
                i += 2
                continue
            if esc != "u":
                i += 2  # invalid escape: dropped (the final validated JSON is the truth)
                continue
            if i + 6 > len(raw):
                break
            code = raw[i:i + 6]
            if 0xD800 <= int(code[2:], 16) <= 0xDBFF:  # a surrogate pair needs the second half
                if i + 12 > len(raw):
                    break
                code = raw[i:i + 12]
            try:
                out.append(json.loads(f'"{code}"'))
            except ValueError:
                pass
            i += len(code)
        self.pos = i
        piece = "".join(out)
        self.value += piece
        return piece
