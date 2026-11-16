"""Import of AI-chat exports (ChatGPT / Claude / Gemini, step 7): the job `import:ai_chats`.

The same pipeline as the Telegram import (`service.py`): `POST /v1/imports/ai-chats/file` makes an
`imports` row (`source = ai_chat_export_file`); the job reads the upload once (no transaction
open), parses it (`aichats.py`), trashes the file at once (originals are not kept, the text is),
writes records in short transactions of `BATCH` conversations (resumable by `cursor.next`), then
one `import_batch` action («Отменить» = «удалить импорт»: every brought record goes to
«Удалённые записи»), the summary «Принёс 312 разговоров из ChatGPT», a repeat scan and stacks.

Each conversation is one record (`kind = ai_chat`, `source = import_ai_chat`; a long one is split
into parts), placed on NO page (Ф-77, 2026-11-17): imported chats would flood «Заметки»; the app
lists them in «Чаты ИИ» in «Ещё» (`GET /v1/items` / search with kind `ai_chat`) and the
assistant's search finds them.
Found by words at once; chunks with embeddings (`embed:item`) only under the usual consent rule.

Repeats: `import_seen` (family `ai_chat`) keys a conversation part by provider, conversation id,
part and a hash of its text: the same export again brings nothing; a conversation continued since
the last export comes as a new record (the older one stays; the repeat scan proposes
«Объединить?»). An exact repeat of a visible record is not brought (`content_hash`).

No model reads the records here: enrichment is not run (`enrich_state = skipped`): the export
already has titles, and a model reading thousands of chats would cost and could file the
assistant's advice as the person's tasks or expenses. Memory facts «из материала» from imported
chats are deferred (they would be read by `chat:memory`, which reads shares only).
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.actions import record
from assistant.analytics import server_event
from assistant.config import get_settings
from assistant.db import queue
from assistant.db.models import Item, User
from assistant.db.models_actions import ActionKind, Initiator
from assistant.db.models_dedup import DupOrigin, Import, ImportSeen, ImportStatus
from assistant.db.models_v2 import EnrichState, File, RecordKind, RecordSource, RecordStatus
from assistant.dedup import schedule_scan
from assistant.dedup.similarity import simhash
from assistant.dedup.texts import plural
from assistant.imports.aichats import PROVIDERS, ChatExport, ChatRecord, Limits, parse, read_files
from assistant.imports.service import ObjectReader, _drop_file, _fail
from assistant.imports.telegram import ExportError
from assistant.memory import enqueue_embed
from assistant.records import content_hash, detect_lang, find_canonical
from assistant.records.textnorm import detect_review_fields
from assistant.stacks import schedule_rebuild

JOB_AI_IMPORT = "import:ai_chats"
SOURCE = "ai_chat_export_file"
FAMILY = "ai_chat"
BATCH = 50  # conversations per transaction
CONVERSATIONS = ("разговор", "разговора", "разговоров")
MEDIA_RU = {"image": "картинки", "file": "файлы", "audio": "аудио"}


def limits() -> Limits:
    st = get_settings()
    return Limits(st.import_ai_max_json_bytes, st.import_max_zip_members, st.import_max_zip_ratio,
                  st.import_ai_max_conversations)  # fmt: skip


async def enqueue_ai_import(s: AsyncSession, imp: Import) -> None:
    await queue.enqueue(s, JOB_AI_IMPORT, {"import_id": imp.id},
                        idempotency_key=f"import:{imp.id}:ai_chats")  # fmt: skip


def summary_text(provider: str, convs: int, dups: int, again: int, older: int, failed: int,
                 media: dict[str, int], max_convs: int) -> str:  # fmt: skip
    """«Принёс 312 разговоров из ChatGPT.» and what was left out."""
    name = PROVIDERS.get(provider, provider)
    text = f"Принёс {plural(convs, CONVERSATIONS)} из {name}."
    if dups:
        text += f" Повторов не взял: {dups}."
    if again:
        text += f" Уже были раньше: {again}."
    if older:
        text += (f" Старые ({older}) не перенёс: за раз беру {max_convs:,} самых новых."
                 .replace(",", " "))
    if media:
        kinds = ", ".join(f"{MEDIA_RU.get(k, k)} ({n})" for k, n in
                          sorted(media.items(), key=lambda kv: -kv[1]))  # fmt: skip
        text += f" {kinds[:1].upper()}{kinds[1:]} не перенёс — только текст."
    if failed:
        text += f" Не прочитал: {failed}."
    return text


async def run_ai_import(maker: async_sessionmaker[AsyncSession], storage: ObjectReader,
                        import_id: int) -> str:  # fmt: skip
    """Returns the import's status when the job ends."""
    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        if imp is None:
            return "gone"
        if imp.status in (ImportStatus.DONE, ImportStatus.FAILED, ImportStatus.CANCELLED):
            await s.commit()
            return str(imp.status)
        f = await s.get(File, imp.file_id) if imp.file_id else None
        user = await s.get(User, imp.user_id)
        key, tz = (f.storage_key if f else None), (user.tz if user else "Asia/Almaty")
        imp.status = ImportStatus.RUNNING
        imp.started_at = imp.started_at or datetime.now(UTC)
        await s.commit()
    data = await storage.get(key) if key else None
    if data is None:
        await _fail(maker, import_id, "import_file_missing")
        return ImportStatus.FAILED
    try:
        export = parse(read_files(data, limits()), limits(), tz or "Asia/Almaty")
    except ExportError as exc:
        await _fail(maker, import_id, exc.code)
        return ImportStatus.FAILED
    del data

    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        assert imp is not None
        imp.total = len(export.conversations)
        imp.skipped_media = dict(export.media)
        imp.failed = export.failed
        cursor = dict(imp.cursor or {})
        cursor["provider"] = export.provider
        imp.cursor = cursor
        start = int(cursor.get("next", 0))
        await _drop_file(s, imp)
        await s.commit()

    for lo in range(start, len(export.conversations), BATCH):
        status = await _write_batch(maker, import_id, export.conversations[lo:lo + BATCH], lo)
        if status == ImportStatus.CANCELLED:
            break  # what was brought keeps its «Отменить» and its summary
    return await _finish(maker, import_id, export)


async def _write_batch(maker: async_sessionmaker[AsyncSession], import_id: int,
                       batch: list[list[ChatRecord]], lo: int) -> str:  # fmt: skip
    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        assert imp is not None
        if imp.status == ImportStatus.CANCELLED:
            await s.commit()
            return ImportStatus.CANCELLED
        uid = imp.user_id
        ids = [r.external_id for conv in batch for r in conv]
        seen = set(await s.scalars(select(ImportSeen.external_id).where(
            ImportSeen.user_id == uid, ImportSeen.source_family == FAMILY,
            ImportSeen.external_id.in_(ids))))  # fmt: skip
        cur = dict(imp.cursor or {})
        created: list[int] = list(cur.get("created", []))
        again, convs = int(cur.get("seen_before", 0)), int(cur.get("conversations", 0))
        for conv in batch:
            brought = False
            for r in conv:
                if r.external_id in seen:
                    again += 1
                    continue
                h = content_hash(r.text)
                canonical = await find_canonical(s, uid, content_hash=h) if h else None
                item_id = canonical.id if canonical is not None else None
                if canonical is not None:
                    imp.skipped_dups += 1
                else:
                    item = _new_item(uid, import_id, r, h)
                    s.add(item)
                    await s.flush()
                    # Ф-77: imported AI chats live on no page («Чаты ИИ» in «Ещё» + search).
                    await enqueue_embed(s, item)
                    item_id = item.id
                    created.append(item.id)
                    imp.created_count += 1
                    brought = True
                await s.execute(insert(ImportSeen).values(
                    user_id=uid, source_family=FAMILY, external_id=r.external_id,
                    item_id=item_id, import_id=import_id,
                ).on_conflict_do_nothing(constraint="uq_import_seen"))  # fmt: skip
                seen.add(r.external_id)
            convs += brought
        imp.processed = lo + len(batch)
        imp.cursor = {**cur, "next": lo + len(batch), "created": created, "seen_before": again,
                      "conversations": convs}  # fmt: skip
        await s.commit()
    return ImportStatus.RUNNING


def _new_item(user_id: int, import_id: int, r: ChatRecord, h: str | None) -> Item:
    name = PROVIDERS[r.provider]
    meta: dict[str, Any] = {
        "import_id": import_id, "title_source": "import", "tag": f"из {name}",
        "ai_chat": {"provider": r.provider, "provider_name": name, "conversation_id": r.conv_id,
                    "part": r.part, "parts": r.parts, "turns": r.turns,
                    "updated_at": r.updated_at.isoformat() if r.updated_at else None},
    }  # fmt: skip
    now = datetime.now(UTC)
    return Item(user_id=user_id, kind=RecordKind.AI_CHAT, source=RecordSource.IMPORT_AI_CHAT,
                status=RecordStatus.READY, title=r.title, text=r.text,
                text_lang=detect_lang(r.text), content_hash=h, simhash=simhash(r.text),
                review_fields=detect_review_fields(r.text), source_meta=meta,
                occurred_at=r.occurred_at, processed_at=now,
                enrich_state=EnrichState.SKIPPED)  # fmt: skip


async def _finish(maker: async_sessionmaker[AsyncSession], import_id: int,
                  export: ChatExport) -> str:  # fmt: skip
    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        assert imp is not None
        cancelled = imp.status == ImportStatus.CANCELLED
        cur = dict(imp.cursor or {})
        created = list(cur.get("created", []))
        again, convs = int(cur.get("seen_before", 0)), int(cur.get("conversations", 0))
        now = datetime.now(UTC)
        text = summary_text(export.provider, convs, imp.skipped_dups, again, export.older,
                            imp.failed, imp.skipped_media or {}, limits().max_conversations)
        name = PROVIDERS[export.provider]
        if imp.action_id is None and created:
            pubs = dict((await s.execute(select(Item.id, Item.public_id)
                                         .where(Item.id.in_(created)))).all())  # type: ignore[arg-type]
            action = await record(
                s, user_id=imp.user_id, kind=ActionKind.IMPORT_BATCH, initiated_by=Initiator.USER,
                summary={"ru": text, "kk": None},
                changes=[{"item_id": str(pubs[i]), "title": "", "kind": "create",
                          "page_id": None, "text": f"Из {name}"} for i in created if i in pubs],
                inverse=[{"op": "delete_entity_soft", "entity": "items", "id": str(pubs[i])}
                         for i in reversed(created) if i in pubs],
                now=now, source_item_ids=created[:5000],
                extra={"import_id": str(imp.public_id)},
            )  # fmt: skip
            imp.action_id = action.id
        imp.summary = {"text_ru": text, "provider": export.provider, "conversations": convs,
                       "records": imp.created_count, "created": imp.created_count,
                       "skipped_dups": imp.skipped_dups, "seen_before": again,
                       "older": export.older, "cut": export.cut, "empty": export.empty,
                       "found": export.total, "skipped_media": imp.skipped_media,
                       "failed": imp.failed}  # fmt: skip
        imp.cursor = {k: v for k, v in cur.items() if k != "created"}
        if not cancelled:
            imp.status, imp.finished_at = ImportStatus.DONE, now
        if created:
            await schedule_scan(s, imp.user_id, origin=DupOrigin.IMPORT, import_id=imp.id,
                                delay_s=0)  # fmt: skip
            await schedule_rebuild(s, imp.user_id)
        await server_event(s, imp.user_id, "import_completed",
                           {"method": "ai_chats", "items": imp.created_count,
                            "skipped": imp.skipped_dups})  # fmt: skip
        status = str(imp.status)
        await s.commit()
    return status
