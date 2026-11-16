"""Reading the person's own AI-chat exports: ChatGPT, Claude, Gemini (step 7). Pure code, no I/O.

Formats (checked 2026-11; none is documented by its provider, so every field is optional and
unknown ones are ignored; a broken conversation is counted, the others are still read):

- ChatGPT (Settings → Data controls → Export): a ZIP with `conversations.json` (newer exports
  may shard it as `conversations-000.json`, …) and `chat.html`. A list of conversations
  `{id|conversation_id, title, create_time, update_time (unix float), current_node, mapping}`;
  `mapping` is a tree `{node id: {message, parent, children}}` (edits and regenerations are
  branches). The shown branch is walked from `current_node` up. A message:
  `{author: {role}, content: {content_type, parts}, create_time, recipient, metadata}`; only
  `user` / `assistant` text (`text`, `multimodal_text`) addressed to `all` is kept: tool calls,
  hidden system context, reasoning and code runs are left out; image parts are counted.
- Claude (Settings → Privacy → Export data): a ZIP with `conversations.json` (+ `users.json`,
  `projects.json`): a list `{uuid, name, created_at, updated_at, chat_messages}`; a message
  `{sender: human|assistant, text, content: [{type: text, text}, …], created_at, attachments,
  files}` (some exports say `messages` / `role`).
- Gemini (Google Takeout → «My Activity» → «Gemini Apps»): `MyActivity.json` (or `.html`, the
  default) inside `Takeout/My Activity/Gemini Apps/` (folder names are localized). One entry per
  turn, no conversation ids: `{header, title: "Prompted <question>", time (ISO), products,
  safeHtmlItem: [{html}]}`. Turns less than `GEMINI_GAP` apart make one conversation.

A zip is never unpacked to disk; only the chats files are read, bounded in bytes (header and
while reading) and packing ratio; names are never used as paths. Other people's data is never
in these exports, but other Takeout products (Search, YouTube) can be: only Gemini entries are
read. Text is data, never instructions.
"""

import hashlib
import html
import io
import json
import re
import zipfile
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any
from zoneinfo import ZoneInfo

from assistant.imports.telegram import ExportError
from assistant.records.textnorm import normalize_text, title_from_text

PROVIDERS = {"chatgpt": "ChatGPT", "claude": "Claude", "gemini": "Gemini"}
MAX_TURN_CHARS = 6_000  # one question or answer; a longer one is cut («…»)
PART_CHARS = 30_000  # a longer conversation is split into parts at turn boundaries
MAX_PARTS = 10  # the rest of a giant conversation is left out (counted in `cut`)
MAX_TITLE = 200
GEMINI_GAP = timedelta(minutes=30)
# ChatGPT citation markers (private-use characters U+E200 cite U+E202 turn0search0 U+E201)
_PRIVATE = re.compile(f"{chr(0xE200)}[^{chr(0xE201)}]{{0,200}}{chr(0xE201)}"
                      f"|[{chr(0xE000)}-{chr(0xF8FF)}]+")
_BLANKS = re.compile(r"\n[ \t\xa0]*(?:\n[ \t\xa0]*)+")  # compact: no empty lines
_CHATS = re.compile(r"^conversations(?:-\d+)?\.json$", re.IGNORECASE)
# The question prefix of a Gemini activity title, by Takeout language.
_PROMPT_PREFIX = re.compile(
    r"^\s*(?:Prompted|Asked|Eingegebener Prompt|Prompt|Запрос|Введенный запрос|Введённый запрос|"
    r"Ваш запрос|Вы спросили|Сұрау)\s*[:\s]\s*", re.IGNORECASE)  # fmt: skip


@dataclass(frozen=True)
class Limits:
    max_json_bytes: int
    max_zip_members: int
    max_zip_ratio: int
    max_conversations: int


@dataclass(frozen=True)
class Turn:
    role: str  # user | assistant
    text: str
    at: datetime | None = None


@dataclass
class Conversation:
    conv_id: str
    title: str | None
    created_at: datetime | None
    updated_at: datetime | None
    turns: list[Turn] = field(default_factory=list)


@dataclass(frozen=True)
class ChatRecord:
    """One record: a conversation, or one part of a long one."""

    external_id: str  # import_seen (family `ai_chat`): provider, conversation, part, text hash
    provider: str
    conv_id: str
    title: str
    text: str
    occurred_at: datetime
    updated_at: datetime | None
    part: int  # 1-based
    parts: int
    turns: int


@dataclass
class ChatExport:
    provider: str
    conversations: list[list[ChatRecord]] = field(default_factory=list)  # newest first
    total: int = 0  # conversations found in the file
    empty: int = 0  # no question or answer with text
    failed: int = 0  # could not be read
    older: int = 0  # over `max_conversations`: the oldest are left out
    cut: int = 0  # conversations longer than MAX_PARTS parts: the end is left out
    media: Counter[str] = field(default_factory=Counter)  # images/files: not carried


# --- reading the upload ---------------------------------------------------------------


def _is_chats_member(name: str) -> int | None:
    """Priority of a zip entry (lower first), or None if it is not a chats file."""
    path = name.replace("\\", "/").lower()
    base = path.rsplit("/", 1)[-1]
    if _CHATS.match(base):
        return 0
    if ("gemini" in path or "bard" in path) and base.endswith(".json"):
        return 1
    if ("gemini" in path or "bard" in path) and base.endswith((".html", ".htm")):
        return 2
    return None


def read_files(data: bytes, limits: Limits) -> list[bytes]:
    """The chats files of the upload: the upload itself, or the right entries of a zip."""
    if data[:4] != b"PK\x03\x04":
        if len(data) > limits.max_json_bytes:
            raise ExportError("import_too_large")
        return [data]
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError) as exc:
        raise ExportError("import_bad_file") from exc
    with zf:
        infos = zf.infolist()
        if len(infos) > limits.max_zip_members:
            raise ExportError("import_too_large")
        found = [(p, i) for i in infos if not i.is_dir()
                 and (p := _is_chats_member(i.filename)) is not None]  # fmt: skip
        if not found:
            raise ExportError("import_no_chats_file")
        best = min(p for p, _ in found)  # conversations*.json, else Gemini json, else html
        chosen = sorted((i for p, i in found if p == best), key=lambda i: i.filename)
        budget, out = limits.max_json_bytes, []
        for info in chosen:
            if info.flag_bits & 0x1:
                raise ExportError("import_bad_file")
            if info.file_size > budget:
                raise ExportError("import_too_large")
            if info.compress_size and info.file_size > info.compress_size * limits.max_zip_ratio:
                raise ExportError("import_bad_file")
            buf = bytearray()
            try:
                with zf.open(info) as fh:
                    while chunk := fh.read(1 << 20):
                        buf += chunk
                        if len(buf) > budget or (
                                info.compress_size
                                and len(buf) > info.compress_size * limits.max_zip_ratio):
                            raise ExportError("import_too_large")  # fmt: skip
            except (zipfile.BadZipFile, EOFError, OSError, NotImplementedError) as exc:
                raise ExportError("import_bad_file") from exc
            budget -= len(buf)
            out.append(bytes(buf))
        return out


# --- small helpers --------------------------------------------------------------------


def when(value: Any) -> datetime | None:
    """Unix seconds (int/float/numeric string) or ISO 8601; aware UTC."""
    try:
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, int | float):
            return datetime.fromtimestamp(float(value), UTC)
        if isinstance(value, str) and value.strip():
            v = value.strip()
            if re.fullmatch(r"\d+(?:\.\d+)?", v):
                return datetime.fromtimestamp(float(v), UTC)
            d = datetime.fromisoformat(v.replace("Z", "+00:00"))
            return (d if d.tzinfo else d.replace(tzinfo=UTC)).astimezone(UTC)
    except (ValueError, OverflowError, OSError):
        return None
    return None


def clean(text: str) -> str:
    text = normalize_text(_PRIVATE.sub("", text))
    if len(text) > MAX_TURN_CHARS:
        cut = text[:MAX_TURN_CHARS].rsplit(" ", 1)[0] or text[:MAX_TURN_CHARS]
        text = cut + " …"
    return text


def _sid(value: Any, fallback: str) -> str:
    return (str(value) if isinstance(value, str | int) and str(value) else fallback)[:80]


class _HtmlText(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "ul", "ol", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
             "pre", "blockquote", "table"}  # fmt: skip

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in ("script", "style"):
            self.skip += 1
        elif tag == "li":
            self.out.append("\n• ")
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.out.append(data)


def html_text(markup: str) -> str:
    p = _HtmlText()
    try:
        p.feed(markup)
        p.close()
    except (AssertionError, ValueError):  # broken markup: whatever was read so far
        pass
    return _BLANKS.sub("\n", "".join(p.out))


# --- ChatGPT --------------------------------------------------------------------------


def _chatgpt_parts(content: dict, media: Counter[str]) -> str:
    parts = content.get("parts")
    texts: list[str] = []
    if isinstance(parts, list):
        for p in parts:
            if isinstance(p, str):
                texts.append(p)
            elif isinstance(p, dict):
                if isinstance(p.get("text"), str):
                    texts.append(p["text"])
                elif "image" in str(p.get("content_type", "")) or p.get("asset_pointer"):
                    media["image"] += 1
                elif "audio" in str(p.get("content_type", "")):
                    media["audio"] += 1
    elif isinstance(content.get("text"), str):
        texts.append(content["text"])
    return "\n".join(t for t in texts if t)


def _chatgpt_branch(mapping: dict, current: Any) -> list[dict]:
    if not isinstance(current, str) or current not in mapping:
        # no pointer: the leaf written last
        leaves = [(k, n) for k, n in mapping.items()
                  if isinstance(n, dict) and not n.get("children")]  # fmt: skip

        def stamp(kn: tuple[str, dict]) -> float:
            m = kn[1].get("message")
            t = when(m.get("create_time")) if isinstance(m, dict) else None
            return t.timestamp() if t else 0.0

        current = max(leaves, key=stamp)[0] if leaves else None
    chain, seen = [], set()
    while isinstance(current, str) and current in mapping and current not in seen:
        seen.add(current)
        node = mapping[current]
        if not isinstance(node, dict):
            break
        chain.append(node)
        current = node.get("parent")
    chain.reverse()
    return chain


def chatgpt(conv: dict, n: int, media: Counter[str]) -> Conversation:
    mapping = conv.get("mapping")
    if not isinstance(mapping, dict):
        raise ValueError("no mapping")
    out = Conversation(_sid(conv.get("id") or conv.get("conversation_id"), f"n{n}"),
                       conv.get("title") if isinstance(conv.get("title"), str) else None,
                       when(conv.get("create_time")), when(conv.get("update_time")))  # fmt: skip
    for node in _chatgpt_branch(mapping, conv.get("current_node")):
        msg = node.get("message")
        if not isinstance(msg, dict):
            continue
        author = msg.get("author") if isinstance(msg.get("author"), dict) else {}
        role = author.get("role")
        meta = msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {}
        content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
        if role not in ("user", "assistant") or meta.get("is_visually_hidden_from_conversation"):
            continue
        if msg.get("recipient") not in (None, "all"):
            continue  # a tool call
        if content.get("content_type") not in ("text", "multimodal_text"):
            continue  # code runs, browsing, reasoning, hidden context
        text = clean(_chatgpt_parts(content, media))
        if text:
            out.turns.append(Turn(role, text, when(msg.get("create_time"))))
    return out


# --- Claude ---------------------------------------------------------------------------


def claude(conv: dict, n: int, media: Counter[str]) -> Conversation:
    msgs = conv.get("chat_messages", conv.get("messages"))
    if not isinstance(msgs, list):
        raise ValueError("no messages")
    out = Conversation(_sid(conv.get("uuid") or conv.get("id"), f"n{n}"),
                       conv.get("name") if isinstance(conv.get("name"), str) else None,
                       when(conv.get("created_at")), when(conv.get("updated_at")))  # fmt: skip
    for m in msgs:
        if not isinstance(m, dict):
            continue
        who = m.get("sender", m.get("role"))
        role = {"human": "user", "user": "user", "assistant": "assistant"}.get(str(who))
        if role is None:
            continue
        content = m.get("content")
        text = ""
        if isinstance(content, list):
            text = "\n".join(c["text"] for c in content if isinstance(c, dict)
                             and c.get("type") == "text" and isinstance(c.get("text"), str))
        if not text and isinstance(m.get("text"), str):
            text = m["text"]
        for key in ("attachments", "files"):
            if isinstance(m.get(key), list) and m[key]:
                media["file"] += len(m[key])
        text = clean(text)
        if text:
            out.turns.append(Turn(role, text, when(m.get("created_at"))))
    return out


# --- Gemini ---------------------------------------------------------------------------


def _is_gemini(entry: dict) -> bool:
    products = entry.get("products")
    marks = [entry.get("header"), *(products if isinstance(products, list) else [])]
    marks = [m for m in marks if isinstance(m, str)]
    return not marks or any("gemini" in m.lower() or "bard" in m.lower() for m in marks)


def _gemini_turn(title: Any, answer: str, at: datetime | None) -> list[Turn] | None:
    """None: not a question (e.g. «Used Gemini Apps», feedback)."""
    if not isinstance(title, str) or at is None:
        return None
    q, prompted = _PROMPT_PREFIX.subn("", title, count=1)
    if not prompted and not answer:
        return None
    turns = []
    if (qt := clean(html.unescape(q))):
        turns.append(Turn("user", qt, at))
    if (at_ := clean(answer)):
        turns.append(Turn("assistant", at_, at))
    return turns


def gemini_json(entries: list, media: Counter[str]) -> tuple[list[Turn], int]:
    turns, failed = [], 0
    for e in entries:
        if not isinstance(e, dict) or not _is_gemini(e):
            continue
        items = e.get("safeHtmlItem")
        answer = "\n".join(html_text(i["html"]) for i in items if isinstance(i, dict)
                           and isinstance(i.get("html"), str)) if isinstance(items, list) else ""
        if isinstance(e.get("attachedFiles"), list):
            media["file"] += len(e["attachedFiles"])
        if e.get("imageFile"):
            media["image"] += 1
        got = _gemini_turn(e.get("title"), answer, when(e.get("time")))
        if got is None:
            if isinstance(e.get("title"), str) and when(e.get("time")) is None:
                failed += 1
            continue
        turns.extend(got)
    return turns, failed


_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
_MONTHS_RU = {"янв": 1, "фев": 2, "мар": 3, "апр": 4, "мая": 5, "май": 5, "июн": 6, "июл": 7,
              "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12}  # fmt: skip
_EN_DATE = re.compile(r"\b([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})"
                      r"\s*([AP]M)\s*([A-Z]{2,5}(?:[+-]\d{1,2}(?::\d{2})?)?)?")
_RU_DATE = re.compile(r"\b(\d{1,2}) ([а-я]{3})[а-я]*\.? (\d{4})(?: г\.)?,? "
                      r"(\d{1,2}):(\d{2}):(\d{2})"
                      r"\s*([A-Z]{2,5}(?:[+-]\d{1,2}(?::\d{2})?)?)?")


def _zone(name: str | None, tz: ZoneInfo) -> Any:
    if not name:
        return tz
    m = re.fullmatch(r"(?:UTC|GMT)([+-])(\d{1,2})(?::(\d{2}))?", name)
    if m:
        delta = timedelta(hours=int(m[2]), minutes=int(m[3] or 0))
        return timezone(delta if m[1] == "+" else -delta)
    return UTC if name in ("UTC", "GMT") else tz


def html_date(line: str, tz: ZoneInfo) -> datetime | None:
    line = line.replace(" ", " ").replace("\xa0", " ")
    try:
        if (m := _EN_DATE.search(line)) and m[1].lower() in _MONTHS:
            hour = int(m[4]) % 12 + (12 if m[7] == "PM" else 0)
            d = datetime(int(m[3]), _MONTHS[m[1].lower()], int(m[2]), hour, int(m[5]), int(m[6]),
                         tzinfo=_zone(m[8], tz))  # fmt: skip
            return d.astimezone(UTC)
        if (m := _RU_DATE.search(line)) and m[2] in _MONTHS_RU:
            d = datetime(int(m[3]), _MONTHS_RU[m[2]], int(m[1]), int(m[4]), int(m[5]), int(m[6]),
                         tzinfo=_zone(m[7], tz))  # fmt: skip
            return d.astimezone(UTC)
    except ValueError:
        return None
    return None


class _ActivityHtml(HTMLParser):
    """Takeout My Activity HTML: `div.outer-cell` > `div.header-cell` (product) and
    `div.content-cell.mdl-typography--body-1` («Prompted …<br>date<br>answer»)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cells: list[dict] = []
        self.stack: list[str] = []  # role of each open div: outer|header|body|other
        self.cur: dict | None = None
        self.text: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "br" and self.text is not None:
            self.text.append("\n")
            return
        if tag != "div":
            if self.text is not None and tag in _HtmlText.BLOCK:
                self.text.append("\n")
            return
        cls = dict(attrs).get("class") or ""
        if "outer-cell" in cls:
            self.cur = {"header": "", "body": None}
            self.cells.append(self.cur)
            self.stack.append("outer")
        elif self.cur is not None and "header-cell" in cls:
            self.stack.append("header")
            self.text = []
        elif (self.cur is not None and self.cur["body"] is None and "content-cell" in cls
              and "body-1" in cls and "text-right" not in cls):
            self.stack.append("body")
            self.text = []
        else:
            if self.text is not None:
                self.text.append("\n")
            self.stack.append("other")

    def handle_endtag(self, tag: str) -> None:
        if tag != "div":
            if self.text is not None and tag in _HtmlText.BLOCK:
                self.text.append("\n")
            return
        if not self.stack:
            return
        role = self.stack.pop()
        if role in ("header", "body") and self.cur is not None and self.text is not None:
            self.cur["header" if role == "header" else "body"] = "".join(self.text)
            self.text = None
        elif role == "outer":
            self.cur = None

    def handle_data(self, data: str) -> None:
        if self.text is not None:
            self.text.append(data)


def gemini_html(raw: str, tz: ZoneInfo) -> tuple[list[Turn], int]:
    p = _ActivityHtml()
    try:
        p.feed(raw)
        p.close()
    except (AssertionError, ValueError):
        pass
    turns, failed = [], 0
    for cell in p.cells:
        header, body = cell.get("header") or "", cell.get("body")
        if not body or (header.strip() and not _is_gemini({"header": header.strip()})):
            continue
        lines = [ln.strip() for ln in body.split("\n")]
        lines = [ln for ln in lines if ln]
        at, idx = None, -1
        for i, ln in enumerate(lines[:6]):
            if (at := html_date(ln, tz)) is not None:
                idx = i
                break
        if at is None:
            failed += 1
            continue
        got = _gemini_turn(" ".join(lines[:idx]), "\n".join(lines[idx + 1:]), at)
        if got:
            turns.extend(got)
    return turns, failed


def gemini_sessions(turns: list[Turn]) -> list[Conversation]:
    turns = sorted((t for t in turns if t.at is not None), key=lambda t: (t.at, t.role != "user"))
    convs: list[Conversation] = []
    last: datetime | None = None
    for t in turns:
        assert t.at is not None
        if last is None or t.at - last > GEMINI_GAP:
            convs.append(Conversation(f"s{t.at.strftime('%Y%m%dT%H%M%S')}", None, t.at, t.at))
        convs[-1].turns.append(t)
        convs[-1].updated_at = t.at
        last = t.at
    return convs


# --- detection and records -------------------------------------------------------------


def _roots(doc: Any) -> list:
    if isinstance(doc, dict):
        for key in ("conversations", "items", "data"):
            if isinstance(doc.get(key), list):
                return doc[key]
        return [doc]
    return doc if isinstance(doc, list) else []


def detect(entries: list) -> str | None:
    for e in entries[:50]:
        if not isinstance(e, dict):
            continue
        if "mapping" in e:
            return "chatgpt"
        if "chat_messages" in e or ("messages" in e and ("uuid" in e or "name" in e)):
            return "claude"
        if "safeHtmlItem" in e or ("header" in e and "time" in e and "title" in e):
            return "gemini"
    return None


def _text_of(c: Conversation, label: str) -> list[str]:
    """Turns as compact lines: «Я: …» / «ChatGPT: …»."""
    return [f"{'Я' if t.role == 'user' else label}: {t.text}" for t in c.turns]


def records(provider: str, c: Conversation) -> tuple[list[ChatRecord], bool]:
    """The conversation as records; True if its end was left out (over MAX_PARTS)."""
    label = PROVIDERS[provider]
    blocks = _text_of(c, label)
    parts: list[list[str]] = [[]]
    size = 0
    for b in blocks:
        if parts[-1] and size + len(b) + 2 > PART_CHARS:
            parts.append([])
            size = 0
        parts[-1].append(b)
        size += len(b) + 2
    cut = len(parts) > MAX_PARTS
    parts = parts[:MAX_PARTS]
    first_q = next((t.text for t in c.turns if t.role == "user"), c.turns[0].text)
    base = " ".join((c.title or "").split())[:MAX_TITLE] or title_from_text(first_q) or label
    at = c.created_at or next((t.at for t in c.turns if t.at), None) or c.updated_at
    assert at is not None
    out = []
    for i, p in enumerate(parts, 1):
        text = "\n\n".join(p)
        sha = hashlib.sha256(text.encode()).hexdigest()[:16]
        title = base if len(parts) == 1 else f"{base} (часть {i})"
        out.append(ChatRecord(
            external_id=f"{provider}:{c.conv_id}:{i}:{sha}", provider=provider,
            conv_id=c.conv_id, title=title[:500], text=text, occurred_at=at,
            updated_at=c.updated_at, part=i, parts=len(parts), turns=len(c.turns)))  # fmt: skip
    return out, cut


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ExportError("import_bad_file") from exc


def parse(files: Iterable[bytes], limits: Limits, tz: str = "Asia/Almaty") -> ChatExport:
    zone = ZoneInfo(tz)
    entries: list = []
    html_docs: list[str] = []
    for raw in files:
        s = _decode(raw)
        if s.lstrip()[:1] in ("[", "{"):
            try:
                entries.extend(_roots(json.loads(s)))
            except (json.JSONDecodeError, RecursionError) as exc:
                raise ExportError("import_bad_file") from exc
        elif "<" in s[:2048]:
            html_docs.append(s)
        else:
            raise ExportError("import_bad_file")
    media: Counter[str] = Counter()
    failed = 0
    if html_docs and not entries:
        provider = "gemini"
        turns: list[Turn] = []
        for doc in html_docs:
            got, bad = gemini_html(doc, zone)
            turns += got
            failed += bad
        if not turns and not failed:
            raise ExportError("import_unknown_format")
        convs = gemini_sessions(turns)
    else:
        provider = detect(entries) or ""
        if not provider:
            raise ExportError("import_unknown_format" if entries else "import_bad_file")
        if provider == "gemini":
            turns, failed = gemini_json(entries, media)
            convs = gemini_sessions(turns)
        else:
            read = chatgpt if provider == "chatgpt" else claude
            convs = []
            for n, conv in enumerate(entries):
                if not isinstance(conv, dict):
                    failed += 1
                    continue
                try:
                    convs.append(read(conv, n, media))
                except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
                    failed += 1
    out = ChatExport(provider=provider, total=len(convs) + failed, failed=failed, media=media)
    full = [c for c in convs if c.turns]
    out.empty = len(convs) - len(full)

    def newest(c: Conversation) -> float:
        t = c.updated_at or c.created_at or max((x.at for x in c.turns if x.at), default=None)
        return t.timestamp() if t else 0.0

    full.sort(key=newest, reverse=True)
    out.older = max(0, len(full) - limits.max_conversations)
    for c in full[:limits.max_conversations]:
        if c.created_at is None and not any(t.at for t in c.turns) and c.updated_at is None:
            out.failed += 1  # no date at all: nowhere to put it in time
            continue
        recs, cut = records(provider, c)
        out.cut += cut
        out.conversations.append(recs)
    return out
