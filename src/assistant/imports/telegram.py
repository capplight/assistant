"""Reading a Telegram Desktop export («Экспорт данных» / «Экспорт истории чата»), spec 6.10.

Pure code, no I/O, no network: links in messages are kept as text and never fetched. The export is
untrusted data from the phone:

- A zip is never unpacked to disk. Only one entry is read, the shallowest `result.json`; its size
  is checked against the header and again while reading (a header can lie), as is the packing
  ratio (zip bomb). Encrypted entries, too many entries and broken archives are refused. Names
  are never used as paths, so `../` in an entry name changes nothing.
- `result.json` is bounded in bytes before parsing; a nesting bomb (RecursionError) is refused.
- Only «Избранное» (`saved_messages`) is read: a full account export holds other people's chats,
  which are not ours to take. Media without text is not carried over (counted by kind); a caption
  is carried as the record's text.
"""

import io
import json
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from assistant.records.textnorm import find_links, normalize_text

MAX_TEXT_CHARS = 20_000
SAVED = "saved_messages"
MEDIA_TYPES = {"video_file": "video", "voice_message": "voice", "audio_file": "audio",
               "sticker": "sticker", "animation": "animation",
               "video_message": "video_message"}  # fmt: skip


class ExportError(Exception):
    """`code` goes to `imports.error` and the API (docs/api/import.md)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Limits:
    max_json_bytes: int
    max_zip_members: int
    max_zip_ratio: int
    max_messages: int


@dataclass(frozen=True)
class Message:
    external_id: str  # "<chat id>:<message id>": import_seen
    text: str
    occurred_at: datetime
    media: str | None
    forwarded_from: str | None
    urls: tuple[str, ...]


@dataclass
class Export:
    messages: list[Message] = field(default_factory=list)
    skipped_media: Counter[str] = field(default_factory=Counter)
    service: int = 0  # «X joined», pinned, …: not messages of the person
    empty: int = 0
    failed: int = 0
    total: int = 0


def json_bytes(data: bytes, limits: Limits) -> bytes:
    """`result.json` from the upload: as is, or out of a zip."""
    if data[:4] != b"PK\x03\x04":
        if len(data) > limits.max_json_bytes:
            raise ExportError("import_too_large")
        return data
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError) as exc:
        raise ExportError("import_bad_file") from exc
    with zf:
        infos = zf.infolist()
        if len(infos) > limits.max_zip_members:
            raise ExportError("import_too_large")
        found = [i for i in infos if not i.is_dir()
                 and i.filename.replace("\\", "/").rsplit("/", 1)[-1] == "result.json"]
        if not found:
            raise ExportError("import_no_result_json")
        info = min(found, key=lambda i: (i.filename.replace("\\", "/").count("/"), i.filename))
        if info.flag_bits & 0x1:
            raise ExportError("import_bad_file")
        if info.file_size > limits.max_json_bytes:
            raise ExportError("import_too_large")
        if info.compress_size and info.file_size > info.compress_size * limits.max_zip_ratio:
            raise ExportError("import_bad_file")
        out = bytearray()
        try:
            with zf.open(info) as fh:
                while chunk := fh.read(1 << 20):
                    out += chunk
                    if len(out) > limits.max_json_bytes or (
                            info.compress_size
                            and len(out) > info.compress_size * limits.max_zip_ratio):
                        raise ExportError("import_too_large")  # fmt: skip
        except (zipfile.BadZipFile, EOFError, OSError, NotImplementedError) as exc:
            raise ExportError("import_bad_file") from exc
        return bytes(out)


def _text_of(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for p in value:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict) and isinstance(p.get("text"), str):
                parts.append(p["text"])
        return "".join(parts)
    return ""


def _media(m: dict) -> str | None:
    mt = m.get("media_type")
    if isinstance(mt, str):
        return MEDIA_TYPES.get(mt, "file")
    if "photo" in m:
        return "photo"
    if "file" in m:
        return "file"
    if "poll" in m:
        return "poll"
    if "location_information" in m:
        return "location"
    if "contact_information" in m:
        return "contact"
    return None


def _when(m: dict, tz: ZoneInfo) -> datetime | None:
    unix = m.get("date_unixtime")
    try:
        if unix is not None:
            return datetime.fromtimestamp(int(unix), UTC)
        raw = m.get("date")
        if isinstance(raw, str):
            d = datetime.fromisoformat(raw)
            return (d if d.tzinfo else d.replace(tzinfo=tz)).astimezone(UTC)
    except (ValueError, OverflowError, OSError):
        return None
    return None


def _saved_chats(root: dict) -> list[dict]:
    if isinstance(root.get("messages"), list):
        if root.get("type") != SAVED:
            raise ExportError("import_not_saved_messages")
        return [root]
    chats = root.get("chats")
    lst = chats.get("list") if isinstance(chats, dict) else None
    if isinstance(lst, list):
        saved = [c for c in lst if isinstance(c, dict) and c.get("type") == SAVED
                 and isinstance(c.get("messages"), list)]  # fmt: skip
        if saved:
            return saved
        raise ExportError("import_not_saved_messages")
    raise ExportError("import_bad_file")


def parse(raw: bytes, limits: Limits, tz: str = "Asia/Almaty") -> Export:
    try:
        root = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ExportError("import_bad_file") from exc
    if not isinstance(root, dict):
        raise ExportError("import_bad_file")
    zone = ZoneInfo(tz)
    out = Export()
    for chat in _saved_chats(root):
        chat_id = str(chat.get("id") or "saved")[:40]
        for m in chat["messages"]:
            if out.total >= limits.max_messages:
                raise ExportError("import_too_many")
            out.total += 1
            if not isinstance(m, dict) or "id" not in m:
                out.failed += 1
                continue
            if m.get("type") != "message":
                out.service += 1
                continue
            media = _media(m)
            if media is not None:
                out.skipped_media[media] += 1
            text = normalize_text(_text_of(m.get("text")))[:MAX_TEXT_CHARS]
            if not text:
                if media is None:
                    out.empty += 1
                continue
            when = _when(m, zone)
            if when is None:
                out.failed += 1
                continue
            fwd = m.get("forwarded_from")
            out.messages.append(Message(
                external_id=f"{chat_id}:{str(m['id'])[:40]}", text=text, occurred_at=when,
                media=media, forwarded_from=fwd[:200] if isinstance(fwd, str) else None,
                urls=tuple(find_links(text)[:20]),
            ))  # fmt: skip
    return out
