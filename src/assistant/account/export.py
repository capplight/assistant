"""«Скачать мои данные» (F-26, US-19, spec 4.9; contract docs/api/account.md): one ZIP of all the
person's data in readable formats — JSON, Markdown, CSV and the originals still kept.

Built by the `account:export` job: read everything in one short transaction, fetch the stored
files with no transaction open, put the ZIP in storage under the person's prefix, then mark the
export ready (24 h). Nothing goes to any model; the archive is made from the database alone.
"""

import csv
import io
import json
import logging
import re
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Protocol

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db.models import User
from assistant.db.models_account import DataExport, ExportStatus
from assistant.logs import error_text

log = logging.getLogger(__name__)

JOB_EXPORT = "account:export"
ORIGINAL_ROLES = ("original", "company_logo", "company_template", "signature", "stamp",
                  "price_list")  # fmt: skip
README = """Ваши данные из приложения-помощника
====================================

Здесь всё, что вы сохранили. Файлы можно открыть на компьютере.

account.json        — ваш аккаунт: имя, язык, часовой пояс, согласия.
items.jsonl         — все записи (по одной в строке), также удалённые (поле deleted_at).
items/              — те же записи как обычный текст, по одному файлу.
pages.json          — ваши страницы: какие записи где и в каком порядке, ваши поля.
reminders.json      — напоминания и будильники.
tasks.json          — дела и покупки.
expenses.csv        — траты (открывается в Excel).
documents/          — КП: данные всех версий (JSON) и PDF отправленных версий.
company.json        — «Моя компания» и прайс.
conversation.jsonl  — вся Переписка с помощником.
drafts.json         — черновики сообщений.
stacks.json         — стопки.
habits.json         — «Что я для вас настроил».
originals/          — сохранённые оригиналы (фото, файлы, логотип, подпись, печать).

Номер телефона в архиве не указан: мы храним его только в зашифрованном виде.
Ссылка на этот архив действует 24 часа.
"""


class ObjectStore(Protocol):
    async def get(self, key: str) -> bytes | None: ...

    async def put(self, key: str, data: bytes) -> None: ...

    async def delete(self, key: str) -> None: ...


class Cipher(Protocol):
    def open(self, user_id: int, name: str, blob: bytes | None) -> Any: ...


def plain(value: Any) -> Any:
    """A DB value as JSON."""
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, bytes | memoryview):
        return None
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [plain(v) for v in value]
    return value


def _json(data: Any) -> bytes:
    return json.dumps(plain(data), ensure_ascii=False, indent=2).encode()


def _jsonl(rows: list[dict[str, Any]]) -> bytes:
    return "".join(json.dumps(plain(r), ensure_ascii=False) + "\n" for r in rows).encode()


_SLUG = re.compile(r"[^0-9A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]+")


def slug(value: str | None, limit: int = 40) -> str:
    s = _SLUG.sub("-", (value or "").strip()).strip("-")[:limit].strip("-")
    return s or "zapis"


def item_markdown(row: dict[str, Any]) -> str:
    title = (row.get("title") or "").strip() or "Запись"
    lines = [f"# {title}", ""]
    when = row.get("occurred_at") or row.get("created_at")
    meta = [f"Дата: {plain(when)}" if when else "", f"Вид: {row.get('kind')}",
            f"Откуда: {row.get('source')}"]  # fmt: skip
    if row.get("url"):
        meta.append(f"Ссылка: {row['url']}")
    if row.get("deleted_at"):
        meta.append(f"В удалённых с {plain(row['deleted_at'])}")
    lines += [m for m in meta if m] + [""]
    if row.get("summary"):
        lines += [f"Кратко: {row['summary']}", ""]
    lines.append(row.get("text") or "")
    return "\n".join(lines).rstrip() + "\n"


@dataclass
class Snapshot:
    """Everything read from the DB in one transaction; files are fetched afterwards."""

    files: dict[str, bytes] = field(default_factory=dict)  # archive path -> bytes
    to_fetch: list[tuple[str, str]] = field(default_factory=list)  # (archive path, storage key)
    counts: dict[str, int] = field(default_factory=dict)


async def _rows(s: AsyncSession, sql: str, uid: int) -> list[dict[str, Any]]:
    return [dict(r._mapping) for r in await s.execute(text(sql), {"u": uid})]


async def snapshot(s: AsyncSession, user: User, cipher: Cipher | None) -> Snapshot:
    uid = user.id
    snap = Snapshot()
    put = snap.files.__setitem__

    consents = await _rows(s, "SELECT kind, version, providers, locale, granted_at, revoked_at, "
                              "screen FROM consents WHERE user_id = :u ORDER BY id", uid)
    put("account.json", _json({
        "id": user.public_id, "display_name": user.display_name, "locale": user.locale,
        "tz": user.tz, "country": user.country, "created_at": user.created_at,
        "onboarding_path": user.onboarding_path, "consents": consents}))  # fmt: skip

    items = await _rows(s, """
        SELECT public_id AS id, kind, source, status, title, coalesce(text, raw_text) AS text,
               summary, url, envelope, review_fields, ai_generated, hidden_reason,
               occurred_at, created_at, updated_at, deleted_at
        FROM items WHERE user_id = :u
          AND hidden_reason IS DISTINCT FROM 'voice_fragment' ORDER BY id""", uid)
    put("items.jsonl", _jsonl(items))
    for r in items:
        when = r.get("occurred_at") or r.get("created_at")
        day = when.date().isoformat() if isinstance(when, datetime) else "bez-daty"
        put(f"items/{day}-{slug(r.get('title') or r.get('text'))}-{str(r['id'])[:8]}.md",
            item_markdown(r).encode())
    snap.counts["items"] = len(items)

    pages = await _rows(s, """
        SELECT public_id AS id, kind, template_key, title, title_kk, icon, position, layout,
               view_state, field_prefs, custom_fields, created_by, created_at, deleted_at
        FROM screens WHERE user_id = :u ORDER BY (kind = 'system_today') DESC, position, id""",
        uid)  # fmt: skip
    rows = await _rows(s, """
        SELECT sc.public_id AS page_id, i.public_id AS item_id, si.position, si.group_key,
               si.manual_order, si.pinned, si.removed_by_user_at AS removed_at, si.appearance,
               si.done_at
        FROM screen_items si JOIN screens sc ON sc.id = si.screen_id
        JOIN items i ON i.id = si.item_id
        WHERE si.user_id = :u ORDER BY sc.id, si.position, i.id""", uid)
    facets = await _rows(s, """
        SELECT i.public_id AS item_id, sc.public_id AS page_id, f.data
        FROM item_facets f JOIN items i ON i.id = f.item_id
        LEFT JOIN screens sc ON sc.id = f.screen_id WHERE f.user_id = :u ORDER BY f.id""", uid)
    by_page: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_page.setdefault(str(r.pop("page_id")), []).append(r)
    for p in pages:
        p["records"] = by_page.get(str(p["id"]), [])
    put("pages.json", _json({"pages": pages, "field_values": facets}))
    snap.counts["pages"] = len(pages)

    reminders = await _rows(s, """
        SELECT r.public_id AS id, r.title, coalesce(r.body, r.text) AS text, r.due_at, r.tz,
               r.rrule, r.offsets, r.level, r.status, r.created_via, i.public_id AS item_id,
               r.created_at, r.deleted_at
        FROM reminders r LEFT JOIN items i ON i.id = r.item_id
        WHERE r.user_id = :u ORDER BY r.id""", uid)
    put("reminders.json", _json(reminders))
    tasks = await _rows(s, """
        SELECT public_id AS id, list_key, title, qty, where_text, due_date, done_at, created_at,
               deleted_at FROM tasks WHERE user_id = :u ORDER BY id""", uid)
    put("tasks.json", _json(tasks))
    snap.counts["reminders"], snap.counts["tasks"] = len(reminders), len(tasks)

    spent = await _rows(s, """
        SELECT e.spent_on, e.amount, e.currency, c.title AS category, e.payee, e.method,
               e.direction, e.note, e.source, i.public_id AS item_id, e.deleted_at
        FROM expense_entries e LEFT JOIN expense_categories c ON c.id = e.category_id
        LEFT JOIN items i ON i.id = e.item_id
        WHERE e.user_id = :u ORDER BY e.spent_on, e.id""", uid)
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Дата", "Сумма", "Валюта", "Категория", "Где / на что", "Способ", "Вид",
                "Заметка", "Откуда", "Запись", "Удалена"])  # fmt: skip
    for r in spent:
        w.writerow([plain(r["spent_on"]), plain(r["amount"]), r["currency"], r["category"] or "",
                    r["payee"] or "", r["method"] or "", r["direction"] or "", r["note"] or "",
                    r["source"] or "", plain(r["item_id"]) or "",
                    plain(r["deleted_at"]) or ""])  # fmt: skip
    put("expenses.csv", ("﻿" + buf.getvalue()).encode())
    snap.counts["expenses"] = len(spent)

    docs = await _rows(s, """
        SELECT id AS pk, public_id AS id, kind, title, number, client, status, deal_status,
               current_version_n, sent_version_n, request_text, ai_generated, created_at,
               updated_at, sent_at, deleted_at FROM documents WHERE user_id = :u ORDER BY id""",
        uid)  # fmt: skip
    versions = await _rows(s, """
        SELECT v.document_id AS doc_pk, v.n, v.data, v.totals, v.vat_rate, v.vat_mode,
               v.changed_paths, v.author, v.request_text, v.sent_at, v.sent_channel,
               v.ai_generated, v.created_at, f.storage_key AS pdf_key
        FROM document_versions v LEFT JOIN files f ON f.id = v.render_file_id
          AND f.state IN ('active', 'pinned')
        WHERE v.user_id = :u ORDER BY v.document_id, v.n""", uid)
    for d in docs:
        pk = d.pop("pk")
        name = f"documents/{slug(d.get('number') or d.get('title'))}-{str(d['id'])[:8]}"
        mine = [v for v in versions if v["doc_pk"] == pk]
        for v in mine:
            v.pop("doc_pk")
            key = v.pop("pdf_key")
            if key and v.get("sent_at"):
                snap.to_fetch.append((f"{name}-v{v['n']}.pdf", key))
        put(f"{name}.json", _json({**d, "versions": mine}))
    snap.counts["documents"] = len(docs)

    company: dict[str, Any] = {}
    prof = (await s.execute(text("""
        SELECT name, legal_form, bin_iin_enc, address, bank_enc, contacts, signer, vat_payer,
               default_terms, license, created_at, updated_at
        FROM company_profiles WHERE user_id = :u"""), {"u": uid})).mappings().first()
    if prof is not None:
        p = dict(prof)
        bin_blob, bank_blob = p.pop("bin_iin_enc"), p.pop("bank_enc")
        if cipher is not None:
            p["bin_iin"] = cipher.open(uid, "bin_iin", bin_blob)
            p["bank"] = cipher.open(uid, "bank", bank_blob)
        company["profile"] = p
    company["price_lists"] = await _rows(s, """
        SELECT pl.title, pl.source, pl.active, pl.uploaded_at, pl.deleted_at,
               coalesce(json_agg(json_build_object('name', pi.name, 'unit', pi.unit,
                        'price', pi.price, 'currency', pi.currency, 'sku', pi.sku))
                        FILTER (WHERE pi.id IS NOT NULL AND pi.deleted_at IS NULL), '[]') AS items
        FROM price_lists pl LEFT JOIN price_list_items pi ON pi.price_list_id = pl.id
        WHERE pl.user_id = :u GROUP BY pl.id ORDER BY pl.id""", uid)
    put("company.json", _json(company))

    convo = await _rows(s, """
        SELECT public_id AS id, role, content, answer_kind, citations, ai_generated, created_at
        FROM conversation_messages WHERE user_id = :u AND deleted_at IS NULL ORDER BY id""", uid)
    put("conversation.jsonl", _jsonl(convo))
    snap.counts["conversation"] = len(convo)
    put("drafts.json", _json(await _rows(s, """
        SELECT public_id AS id, channel, recipient_name, subject, text, status, ai_generated,
               sent_at, created_at, deleted_at FROM drafts WHERE user_id = :u ORDER BY id""",
        uid)))  # fmt: skip
    put("stacks.json", _json(await _rows(s, """
        SELECT c.public_id AS id, c.title, c.icon, c.item_count, c.created_at, c.deleted_at,
               coalesce(array_agg(i.public_id) FILTER (WHERE i.id IS NOT NULL
                        AND ci.removed_by_user_at IS NULL), '{}') AS items
        FROM collections c LEFT JOIN collection_items ci ON ci.collection_id = c.id
        LEFT JOIN items i ON i.id = ci.item_id
        WHERE c.user_id = :u GROUP BY c.id ORDER BY c.id""", uid)))
    put("habits.json", _json(await _rows(s, """
        SELECT kind, key, value, status, evidence_count, created_at, updated_at
        FROM user_habits WHERE user_id = :u ORDER BY id""", uid)))

    files = await _rows(s, f"""
        SELECT f.public_id, f.role, f.mime, f.storage_key, i.public_id AS item_id
        FROM files f LEFT JOIN items i ON i.id = f.item_id
        WHERE f.user_id = :u AND f.state IN ('active', 'pinned')
          AND f.role IN ({", ".join(f"'{r}'" for r in ORIGINAL_ROLES)}) ORDER BY f.id""", uid)
    for f in files:
        ext = _EXT.get(str(f["mime"]).lower(), "bin")
        snap.to_fetch.append((f"originals/{f['role']}-{str(f['public_id'])[:8]}.{ext}",
                              f["storage_key"]))  # fmt: skip
    snap.counts["originals"] = len(files)
    put("README.txt", README.encode())
    return snap


_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp",
        "application/pdf": "pdf", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/ogg": "ogg",
        "audio/aac": "aac", "text/plain": "txt",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/zip": "zip", "application/json": "json"}  # fmt: skip


def zip_bytes(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(files):
            z.writestr(path, files[path])
    return buf.getvalue()


def export_key(user_public_id: uuid.UUID, export_public_id: uuid.UUID) -> str:
    return f"u/{user_public_id}/exports/{export_public_id}.zip"


async def build_export(maker: async_sessionmaker[AsyncSession], storage: ObjectStore,
                       cipher: Cipher | None, export_id: int, *, link_hours: int,
                       now: datetime | None = None) -> bool:  # fmt: skip
    """`account:export`. Returns True when the archive is ready (False: nothing to do)."""
    now = now or datetime.now(UTC)
    async with maker() as s:
        exp = await s.get(DataExport, export_id, with_for_update=True)
        if exp is None or exp.status not in (ExportStatus.QUEUED, ExportStatus.RUNNING):
            await s.commit()
            return False
        exp.status = ExportStatus.RUNNING
        uid, export_public_id = exp.user_id, exp.public_id
        await s.commit()
    async with maker() as s:
        user = await s.get(User, uid)
        assert user is not None  # FK, cascade
        snap = await snapshot(s, user, cipher)
        key = export_key(user.public_id, export_public_id)
        await s.commit()
    missing = 0
    for path, storage_key in snap.to_fetch:  # no transaction open across storage calls
        data = await storage.get(storage_key)
        if data is None:
            missing += 1
            continue
        snap.files[path] = data
    blob = zip_bytes(snap.files)
    await storage.put(key, blob)
    async with maker() as s:
        exp = await s.get(DataExport, export_id, with_for_update=True)
        if exp is None:  # the account went meanwhile
            await s.commit()
            await storage.delete(key)
            return False
        exp.status, exp.storage_key, exp.bytes = ExportStatus.READY, key, len(blob)
        exp.counts = {**snap.counts, "files_missing": missing}
        exp.ready_at, exp.expires_at = now, now + timedelta(hours=link_hours)
        exp.error = None
        await s.commit()
    return True


async def mark_failed(maker: async_sessionmaker[AsyncSession], export_id: int,
                      error: str) -> None:  # fmt: skip
    async with maker() as s:
        exp = await s.get(DataExport, export_id, with_for_update=True)
        if exp is not None and exp.status != ExportStatus.READY:
            exp.status, exp.error = ExportStatus.FAILED, error[:500]
        await s.commit()


async def expire_exports(maker: async_sessionmaker[AsyncSession], storage: ObjectStore,
                         now: datetime | None = None) -> int:  # fmt: skip
    """Archives older than their 24 h: the object goes, the row stays `expired`."""
    now = now or datetime.now(UTC)
    async with maker() as s:
        due = list(await s.scalars(select(DataExport).where(
            DataExport.status == ExportStatus.READY, DataExport.expires_at <= now)
            .with_for_update(skip_locked=True).limit(100)))  # fmt: skip
        keys = [(e.id, e.storage_key) for e in due]
        for e in due:
            e.status = ExportStatus.EXPIRED
        await s.commit()
    gone = 0
    for export_id, key in keys:
        if not key:
            continue
        try:
            await storage.delete(key)
            gone += 1
        except Exception as exc:  # the row says expired; a stray object goes with the account
            log.warning("export %s: delete failed: %s", export_id, error_text(exc))
    return gone
