"""Week 10 against a real database: exact repeats on save with «Отменить», groups of similar
records («Объединить?» / «Это разные»), the cleanup plan «37 → 1» behind one «Да», stacks as groups
on a page, the Telegram import from an export file, product events. Providers are fakes; nothing
touches the network. Skipped without DATABASE_URL."""

import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from assistant.ai import FakeAdapter
from assistant.ai.types import AdapterRequest
from assistant.api.app import create_app
from assistant.api.sms import FakeSmsSender
from assistant.db.models import Item, Job, Reminder
from assistant.db.models_dedup import AnalyticsEvent, DuplicateCandidate, Import
from assistant.db.models_pages import ScreenItem
from assistant.db.models_v2 import ConsentKind, File, Upload
from assistant.dedup import scan_user
from assistant.dedup.judge import DupVerdict
from assistant.imports import run_enrich_wave, run_import
from assistant.stacks import rebuild_user
from assistant.stacks.service import StackName
from tests.api.conftest import client, make_settings, make_storage
from tests.chat.test_chat_db import fake_router, signed_in
from tests.imports.fixtures import export_json, export_zip, message, saved_chat

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
BASE = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS)
AI = (*BASE, ConsentKind.AI_CROSS_BORDER)


@dataclass
class Env:
    maker: Any
    storage: Any
    make_app: Any


@pytest.fixture
async def env(tmp_path: Path):
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        maker = async_sessionmaker(bind=conn, expire_on_commit=False,
                                   join_transaction_mode="create_savepoint")  # fmt: skip
        async with maker() as s:
            await s.execute(text("DELETE FROM jobs"))
            await s.commit()
        storage = make_storage(tmp_path)
        apps = []

        def make_app(ai_router: Any = None, **kw: Any):  # type: ignore[no-untyped-def]
            app = create_app(make_settings(**kw), sessionmaker=maker, sms=FakeSmsSender(),
                             storage=storage, ai_router=ai_router)  # fmt: skip
            apps.append(app)
            return app

        try:
            yield Env(maker, storage, make_app)
        finally:
            for app in apps:
                await app.state.ctx.chat.drain()
            await trans.rollback()
    await engine.dispose()


class Judge:
    """Answers DUP_JUDGE and STACK_NAME; counts the calls."""

    def __init__(self, verdict: str = "different", stack: str = "Ремонт") -> None:
        self.verdict, self.stack = verdict, stack
        self.calls: dict[str, int] = {}

    def __call__(self, req: AdapterRequest) -> Any:
        self.calls[req.schema_name] = self.calls.get(req.schema_name, 0) + 1
        if req.schema_name == "DupVerdict":
            return DupVerdict(verdict=self.verdict)  # type: ignore[arg-type]
        if req.schema_name == "StackName":
            return StackName(title=self.stack)
        raise AssertionError(req.schema_name)


async def note(c, h, body: str) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "text": body}, headers=h)
    assert r.status_code in (200, 201), r.text
    return r.json()


async def uid_of(env: Env, item_id: str) -> int:
    async with env.maker() as s:
        return await s.scalar(select(Item.user_id).where(Item.public_id == uuid.UUID(item_id)))


async def notes_page(c, h) -> str:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/pages", json={"client_id": str(uuid.uuid4()), "template_key": "notes"},
                     headers=h)  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["page"]["id"]


NEAR = [
    "Позвонить в управляющую компанию насчёт протечки в ванной. Спросить, когда придёт "
    "сантехник и нужно ли быть дома весь день.",
    "Позвонить в управляющую компанию насчёт протечки в ванной. Спросить когда придёт "
    "сантехник и нужно ли быть дома весь день. Не забыть.",
    "Позвонить в управляющую компанию насчет протечки в ванной, спросить, когда придёт "
    "сантехник и нужно ли быть дома весь день",
]


async def test_exact_repeat_on_save_has_a_group_and_an_undoable_action(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        first = await note(c, h, "Купить краску для забора")
        dup = await note(c, h, "купить  краску для забора!")
        assert dup["auto_merged"] is True and dup["duplicate"]["action_id"]
        a = (await c.get(f"/v1/actions/{dup['duplicate']['action_id']}", headers=h)).json()
        assert a["kind"] == "auto_merge_exact" and a["undoable"] is True
        u = await c.post(f"/v1/actions/{a['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        got = (await c.get(f"/v1/items/{dup['item']['id']}", headers=h)).json()
        assert got["hidden_reason"] is None and got["source_meta"]["unmerged"] is True
        canon = (await c.get(f"/v1/items/{first['item']['id']}", headers=h)).json()
        assert canon["merged_fragments"] == []
        undone = (await c.get("/v1/duplicates/groups?status=undone&kind=exact",
                              headers=h)).json()["groups"]  # fmt: skip
        assert len(undone) == 1
        # the old path still works and closes the group and the action
        third = await note(c, h, "Купить краску для забора.")
        assert third["auto_merged"]
        r = await c.post(f"/v1/items/{third['item']['id']}/unmerge", headers=h)
        assert r.status_code == 200
        a3 = (await c.get(f"/v1/actions/{third['duplicate']['action_id']}", headers=h)).json()
        assert a3["undoable"] is False


async def test_similar_records_group_merge_and_undo(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        page = await notes_page(c, h)
        made = [await note(c, h, t) for t in NEAR]
        other = await note(c, h, "Рецепт плова: рис девзира, морковь жёлтая, баранина и зира.")
        uid = await uid_of(env, made[0]["item"]["id"])
        ids = [m["item"]["id"] for m in made]
        async with env.maker() as s:  # a reminder on a repeat follows the record kept
            s.add(Reminder(user_id=uid, kind="normal", title="Сантехник", tz="Asia/Almaty",
                           due_at=func.now() + text("interval '1 day'"),
                           item_id=await s.scalar(select(Item.id).where(
                               Item.public_id == uuid.UUID(ids[0])))))  # fmt: skip
            await s.commit()
        res = await scan_user(env.maker, None, uid)
        assert res.groups == 1 and res.sure >= 2
        groups = (await c.get("/v1/duplicates/groups", headers=h)).json()["groups"]
        assert len(groups) == 1 and groups[0]["member_count"] == 3
        g = groups[0]
        assert other["item"]["id"] not in {m["item_id"] for m in g["members"]}
        keep = g["keep_item_id"]
        assert keep == ids[1]  # most complete: it has «Не забыть.»
        r = await c.post(f"/v1/duplicates/groups/{g['id']}/merge", json={}, headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["group"]["status"] == "merged" and out["action"]["kind"] == "merge_group"
        assert out["action"]["summary"]["ru"] == "Объединил 3 записи в одну"
        kept = (await c.get(f"/v1/items/{keep}", headers=h)).json()
        assert len(kept["merged_fragments"]) == 2
        for rid in (ids[0], ids[2]):
            it = (await c.get(f"/v1/items/{rid}", headers=h)).json()
            assert it["hidden_reason"] == "duplicate_merged" and it["canonical_id"] == keep
        rows = (await c.get(f"/v1/pages/{page}/items", headers=h)).json()["entries"]
        assert {e["item"]["id"] for e in rows} == {keep, other["item"]["id"]}
        async with env.maker() as s:
            rem = await s.scalar(select(Reminder).where(Reminder.user_id == uid))
            keep_pk = await s.scalar(select(Item.id).where(Item.public_id == uuid.UUID(keep)))
            assert rem.item_id == keep_pk
        again = await c.post(f"/v1/duplicates/groups/{g['id']}/merge", json={}, headers=h)
        assert again.json()["repeated"] is True
        u = await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        assert u.status_code == 200 and u.json()["partial"] is False, u.text
        for rid in ids:
            it = (await c.get(f"/v1/items/{rid}", headers=h)).json()
            assert it["hidden_reason"] is None
        assert (await c.get(f"/v1/items/{keep}", headers=h)).json()["merged_fragments"] == []
        async with env.maker() as s:
            rem = await s.scalar(select(Reminder).where(Reminder.user_id == uid))
            assert rem.item_id != keep_pk
        undone = (await c.get("/v1/duplicates/groups?status=undone", headers=h)).json()["groups"]
        assert [x["id"] for x in undone] == [g["id"]]
        # undone means «they are different»: not suggested again
        assert (await scan_user(env.maker, None, uid)).groups == 0


async def test_dismissed_group_is_not_suggested_again(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        made = [await note(c, h, t) for t in NEAR[:2]]
        uid = await uid_of(env, made[0]["item"]["id"])
        await scan_user(env.maker, None, uid)
        g = (await c.get("/v1/duplicates/groups", headers=h)).json()["groups"][0]
        r = await c.post(f"/v1/duplicates/groups/{g['id']}/dismiss", headers=h)
        assert r.json()["group"]["status"] == "dismissed"
        assert (await scan_user(env.maker, None, uid)).groups == 0
        r = await c.post(f"/v1/duplicates/groups/{g['id']}/merge", headers=h)
        assert r.status_code == 409


async def test_numbers_differ_goes_to_the_judge_once(env):
    judge = Judge("different")
    router = fake_router(env.maker, FakeAdapter("anthropic", [judge]))
    async with client(env.make_app(router)) as c:
        h = await signed_in(c, kinds=AI)
        a = await note(c, h, "Встреча с Арманом 12 марта в 15:00 в кофейне на Абая, обсудить сайт.")
        await note(c, h, "Встреча с Арманом 13 марта в 15:00 в кофейне на Абая, обсудить сайт.")
        uid = await uid_of(env, a["item"]["id"])
        res = await scan_user(env.maker, router, uid)
        assert res.judged == 1 and res.groups == 0 and judge.calls == {"DupVerdict": 1}
        res = await scan_user(env.maker, router, uid)
        assert res.judged == 0 and judge.calls == {"DupVerdict": 1}  # the verdict is kept
        async with env.maker() as s:
            v = await s.scalar(select(DuplicateCandidate.verdict))
            assert v == "different"


async def test_judge_needs_consent(env):
    judge = Judge("same")
    router = fake_router(env.maker, FakeAdapter("anthropic", [judge]))
    async with client(env.make_app(router)) as c:
        h = await signed_in(c, kinds=BASE)  # no ai_cross_border
        a = await note(c, h, "Код от домофона у тёти Розы 4521, квартира на пятом этаже налево.")
        await note(c, h, "Код от домофона у тёти Розы 7713, квартира на пятом этаже налево.")
        res = await scan_user(env.maker, router, await uid_of(env, a["item"]["id"]))
        assert judge.calls == {} and res.groups == 0 and res.judge_skipped == 1


async def _raw_items(env: Env, uid: int, texts: list[str]) -> list[int]:
    """Records saved before repeats were checked (e.g. legacy or offline on two phones)."""
    from assistant.records import content_hash

    ids = []
    async with env.maker() as s:
        for t in texts:
            it = Item(user_id=uid, kind="note", source="typed", status="ready", text=t,
                      content_hash=content_hash(t))  # fmt: skip
            s.add(it)
            await s.flush()
            ids.append(it.id)
        await s.commit()
    return ids


async def test_cleanup_plan_37_to_1_one_yes_one_undo(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        first = await note(c, h, "Список дел: помыть машину")
        uid = await uid_of(env, first["item"]["id"])
        await _raw_items(env, uid, ["Список дел: помыть машину"] * 36
                         + ["Пароль от вайфая на холодильнике"] * 3)  # fmt: skip
        r = await c.post("/v1/duplicates/cleanup/plan", json={"client_id": str(uuid.uuid4())},
                         headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        plan = r.json()
        assert plan["exact"] == {"copies": 38, "records_before": 40, "records_after": 2,
                                 "groups": 2}  # fmt: skip
        assert plan["pending_action"]["preview"]["title_ru"] == "Убрать 38 повторов?"
        pid = plan["pending_action"]["id"]
        listed = (await c.get("/v1/pending-actions", headers=h)).json()["pending_actions"]
        assert [p["id"] for p in listed] == [pid]
        ok = await c.post(f"/v1/pending-actions/{pid}/confirm", json={}, headers=h)
        assert ok.status_code == 200, ok.text
        act = ok.json()["action"]
        assert act["kind"] == "cleanup_batch" and act["summary"]["ru"] == "Убрал 38 повторов"
        visible = (await c.get("/v1/items?limit=200", headers=h)).json()["items"]
        assert len(visible) == 2
        assert (await c.post(f"/v1/pending-actions/{pid}/confirm", headers=h)).json()["repeated"]
        u = await c.post(f"/v1/actions/{act['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        assert len((await c.get("/v1/items?limit=200", headers=h)).json()["items"]) == 40
        rej = await c.post(f"/v1/pending-actions/{pid}/reject", headers=h)
        assert rej.status_code == 409


async def _upload(env: Env, uid: int, data: bytes, mime: str = "application/zip") -> str:
    import hashlib

    key = f"u/test/{uuid.uuid4()}"
    await env.storage.put(key, data)
    async with env.maker() as s:
        f = File(user_id=uid, role="original", storage_key=key, mime=mime, bytes=len(data),
                 sha256=hashlib.sha256(data).hexdigest())  # fmt: skip
        s.add(f)
        await s.flush()
        up = Upload(user_id=uid, role="original", storage_key=key, mime=mime, bytes=len(data),
                    sha256=f.sha256, state="completed", expires_at=func.now(), file_id=f.id)
        s.add(up)
        await s.commit()
        return str(up.public_id)


async def test_telegram_import_from_a_zip(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        page = await notes_page(c, h)
        old = await note(c, h, "Рецепт плова: рис девзира, морковь жёлтая")  # already here
        uid = await uid_of(env, old["item"]["id"])
        up = await _upload(env, uid, export_zip())
        body = {"client_id": str(uuid.uuid4()), "upload_id": up}
        r = await c.post("/v1/imports/telegram/file", json=body, headers=h)
        assert r.status_code == 403 and r.json()["details"]["missing"] == ["telegram_import"]
        from tests.chat.test_chat_db import consent_texts

        t = consent_texts.current(ConsentKind.TELEGRAM_IMPORT, "ru")
        g = await c.post("/v1/consents", json={"consents": [{"kind": "telegram_import",
                         "version": t.version, "text_hash": t.text_hash, "locale": "ru"}],
                         "screen": "import"}, headers=h)  # fmt: skip
        assert g.status_code == 200, g.text
        r = await c.post("/v1/imports/telegram/file", json=body, headers=h)
        assert r.status_code == 202, r.text
        imp = r.json()["import"]
        assert imp["status"] == "created"
        assert (await c.post("/v1/imports/telegram/file", json=body, headers=h)).status_code == 200
        async with env.maker() as s:
            pk = await s.scalar(select(Import.id).where(Import.public_id == uuid.UUID(imp["id"])))
        assert await run_import(env.maker, env.storage, pk) == "done"
        got = (await c.get(f"/v1/imports/{imp['id']}", headers=h)).json()["import"]
        # 10 messages: 1 service, 2 media without text, 1 sticker, 1 repeat inside the export,
        # 1 repeat of a record already here -> 4 brought
        assert got["created"] == 4 and got["skipped_dups"] == 2, got
        assert got["skipped_media"] == {"photo": 1, "video": 2, "sticker": 1}
        assert got["summary_ru"] == ("Принёс 4 записи, 2 повтора убрал, видео (2), фото (1), "
                                     "стикеры (1) не перенёс — только подписи.")
        rows = (await c.get(f"/v1/pages/{page}/items", headers=h)).json()["entries"]
        brought = [e for e in rows if e["item"]["source"] == "import_telegram"]
        assert len(brought) == 4 and all(e["link"]["added_by"] == "rule" for e in brought)
        assert all(e["item"]["kind"] == "tg_message" for e in brought)
        async with env.maker() as s:
            f = await s.scalar(select(File).join(Import, Import.file_id == File.id)
                               .where(Import.id == pk))
            assert f.state == "trash"  # the export is not kept
            kinds = set(await s.scalars(select(Job.kind)))
            assert {"dedup:scan", "import:enrich", "stacks:rebuild"} <= kinds
        # the same messages again: nothing new, not counted
        up2 = await _upload(env, uid, export_zip())
        r2 = await c.post("/v1/imports/telegram/file",
                          json={"client_id": str(uuid.uuid4()), "upload_id": up2}, headers=h)
        async with env.maker() as s:
            pk2 = await s.scalar(select(Import.id).where(
                Import.public_id == uuid.UUID(r2.json()["import"]["id"])))
        await run_import(env.maker, env.storage, pk2)
        again = (await c.get(f"/v1/imports/{r2.json()['import']['id']}", headers=h)).json()
        assert again["import"]["created"] == 0 and again["import"]["seen_before"] == 6
        # «Отменить» on the import: what it brought goes to «Удалённые записи»
        u = await c.post(f"/v1/actions/{got['action_id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        trash = (await c.get("/v1/items/trash", headers=h)).json()["items"]
        assert len(trash) == 4


async def test_import_enrichment_waves_and_bad_files(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=(*BASE, ConsentKind.TELEGRAM_IMPORT))
        first = await note(c, h, "первая заметка")
        uid = await uid_of(env, first["item"]["id"])
        msgs = [message(i, f"Заметка номер {i} про разное и важное") for i in range(1, 121)]
        import json

        up = await _upload(env, uid, json.dumps(saved_chat(msgs)).encode(), "application/json")
        r = await c.post("/v1/imports/telegram/file",
                         json={"client_id": str(uuid.uuid4()), "upload_id": up}, headers=h)
        async with env.maker() as s:
            pk = await s.scalar(select(Import.id).where(
                Import.public_id == uuid.UUID(r.json()["import"]["id"])))
        await run_import(env.maker, env.storage, pk)
        # no ai_cross_border: every wave marks records `no_consent` (queued when it is granted)
        sent = [await run_enrich_wave(env.maker, pk, w) for w in range(4)]
        assert sent == [50, 50, 20, 0]
        async with env.maker() as s:
            states = set(await s.scalars(select(Item.enrich_state).where(
                Item.source == "import_telegram")))
            assert states == {"no_consent"}
        bad = await _upload(env, uid, b"<html>not an export</html>", "text/plain")
        r = await c.post("/v1/imports/telegram/file",
                         json={"client_id": str(uuid.uuid4()), "upload_id": bad}, headers=h)
        async with env.maker() as s:
            pk = await s.scalar(select(Import.id).where(
                Import.public_id == uuid.UUID(r.json()["import"]["id"])))
        assert await run_import(env.maker, env.storage, pk) == "failed"
        got = (await c.get(f"/v1/imports/{r.json()['import']['id']}", headers=h)).json()
        assert got["import"]["error"] == "import_bad_file"
        full = await _upload(env, uid, export_json(full=True), "application/json")
        r = await c.post("/v1/imports/telegram/file",
                         json={"client_id": str(uuid.uuid4()), "upload_id": full}, headers=h)
        assert r.status_code == 202


async def test_stack_shows_as_a_group_on_notes_with_undo(env):
    judge = Judge(stack="Ремонт дома")
    router = fake_router(env.maker, FakeAdapter("anthropic", [judge]))
    async with client(env.make_app(router)) as c:
        h = await signed_in(c, kinds=AI)
        page = await notes_page(c, h)
        made = [await note(c, h, f"Ремонт: заметка {i} про плитку и краску") for i in range(6)]
        uid = await uid_of(env, made[0]["item"]["id"])
        env_ = {"type": "note", "topics": ["ремонт"], "entities": {"orgs": []}}
        async with env.maker() as s:
            await s.execute(text("UPDATE items SET envelope = CAST(:e AS jsonb) "
                                 "WHERE user_id = :u"),
                            {"e": __import__("json").dumps(env_), "u": uid})
            # one row the person placed by hand: it stays out of the group (R-54)
            await s.execute(text(
                "UPDATE screen_items SET manual_order = true, manual_at = now(), "
                "updated_by = 'user' WHERE item_id = "
                "(SELECT id FROM items WHERE public_id = :i)"),
                {"i": uuid.UUID(made[0]["item"]["id"])})
            await s.commit()
        out = await rebuild_user(env.maker, router, uid)
        assert out["created"] == 1 and judge.calls == {"StackName": 1}
        cols = (await c.get(f"/v1/collections?page_id={page}", headers=h)).json()["collections"]
        assert len(cols) == 1 and cols[0]["title"] == "Ремонт дома" and cols[0]["item_count"] == 6
        rows = (await c.get(f"/v1/pages/{page}/items", headers=h)).json()["entries"]
        grouped = {e["item"]["id"] for e in rows if e["link"]["group_key"] == "Ремонт дома"}
        assert len(grouped) == 5 and made[0]["item"]["id"] not in grouped
        pg = (await c.get(f"/v1/pages/{page}", headers=h)).json()
        assert "Ремонт дома" in pg["view_state"]["groups"]
        # a second rebuild changes nothing and asks nothing
        assert (await rebuild_user(env.maker, router, uid))["created"] == 0
        cid = cols[0]["id"]
        rm = await c.delete(f"/v1/collections/{cid}/items/{made[1]['item']['id']}", headers=h)
        assert rm.status_code == 200 and rm.json()["collection"]["item_count"] == 5
        await rebuild_user(env.maker, router, uid)  # never comes back by itself
        opened = (await c.get(f"/v1/collections/{cid}", headers=h)).json()
        assert made[1]["item"]["id"] not in {i["item_id"] for i in opened["items"]}
        ren = await c.patch(f"/v1/collections/{cid}", json={"title": "Дача"}, headers=h)
        assert ren.json()["collection"]["title"] == "Дача"
        rows = (await c.get(f"/v1/pages/{page}/items", headers=h)).json()["entries"]
        assert sum(e["link"]["group_key"] == "Дача" for e in rows) == 4
        create_action = cols[0]["action_id"]
        u = await c.post(f"/v1/actions/{ren.json()['action']['id']}/undo", headers=h)
        assert u.status_code == 200
        d = await c.delete(f"/v1/collections/{cid}", headers=h)
        assert d.status_code == 200
        rows = (await c.get(f"/v1/pages/{page}/items", headers=h)).json()["entries"]
        assert all(e["link"]["group_key"] is None for e in rows)
        assert (await c.get("/v1/collections", headers=h)).json()["collections"] == []
        u = await c.post(f"/v1/actions/{d.json()['action']['id']}/undo", headers=h)
        assert u.status_code == 200
        assert len((await c.get("/v1/collections", headers=h)).json()["collections"]) == 1
        assert create_action is not None


async def test_events_need_the_analytics_consent_and_keep_no_content(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        ev = {"client_id": str(uuid.uuid4()), "name": "capture_created",
              "props": {"channel": "voice", "type": "note", "text": "секрет"}}
        r = await c.post("/v1/events", json={"events": [ev], "platform": "android"}, headers=h)
        assert r.status_code == 202 and r.json() == {"accepted": 0, "dropped": 1}
        h2 = await signed_in(c, kinds=(*BASE, ConsentKind.ANALYTICS))
        bad = {"client_id": str(uuid.uuid4()), "name": "made_up_event", "props": {}}
        free = {"client_id": str(uuid.uuid4()), "name": "duplicate_decided",
                "props": {"decision": "Мама сказала +77011234567"}}
        r = await c.post("/v1/events", json={"events": [ev, bad, free], "platform": "android",
                                             "app_version": "1.0.3"}, headers=h2)  # fmt: skip
        assert r.json() == {"accepted": 2, "dropped": 1}
        again = await c.post("/v1/events", json={"events": [ev]}, headers=h2)
        assert again.json()["accepted"] == 1
        async with env.maker() as s:
            rows = list(await s.scalars(select(AnalyticsEvent).order_by(AnalyticsEvent.id)))
        assert [r.name for r in rows] == ["capture_created", "duplicate_decided"]
        assert rows[0].props == {"channel": "voice", "type": "note"}
        assert rows[1].props == {}  # free text never gets in
        assert rows[0].platform == "android" and len(rows[0].user_pseudo) == 32


async def test_merge_moves_a_record_on_a_custom_page_to_the_kept_one(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        r = await c.post("/v1/pages", json={"client_id": str(uuid.uuid4()),
                                            "template_key": "custom", "title": "Дом"},
                         headers=h)  # fmt: skip
        home = r.json()["page"]["id"]
        made = [await note(c, h, t) for t in NEAR[:2]]
        await c.post(f"/v1/pages/{home}/items", json={"item_id": made[0]["item"]["id"]},
                     headers=h)  # fmt: skip
        uid = await uid_of(env, made[0]["item"]["id"])
        await scan_user(env.maker, None, uid)
        g = (await c.get("/v1/duplicates/groups", headers=h)).json()["groups"][0]
        out = (await c.post(f"/v1/duplicates/groups/{g['id']}/merge",
                            json={"keep_item_id": made[1]["item"]["id"]}, headers=h)).json()
        rows = (await c.get(f"/v1/pages/{home}/items", headers=h)).json()["entries"]
        assert [e["item"]["id"] for e in rows] == [made[1]["item"]["id"]]
        await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        rows = (await c.get(f"/v1/pages/{home}/items", headers=h)).json()["entries"]
        assert [e["item"]["id"] for e in rows] == [made[0]["item"]["id"]]
        async with env.maker() as s:
            n = await s.scalar(select(func.count()).select_from(ScreenItem).join(
                Item, Item.id == ScreenItem.item_id).where(Item.user_id == uid))
            assert n >= 1


async def test_dismiss_has_undo_and_many_groups_merge_in_one_action(env):
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        a = [await note(c, h, t) for t in NEAR[:2]]
        b = [await note(c, h, t) for t in (
            "Рецепт бешбармака от мамы: мясо варить три часа на медленном огне, тесто тонко.",
            "Рецепт бешбармака от мамы: мясо варить три часа на медленном огне, тесто тонко. "
            "Не забыть.")]
        d = [await note(c, h, t) for t in (
            "Пароль от вайфая на даче записан на холодильнике, роутер стоит в шкафу у входа.",
            "Пароль от вайфая на даче записан на холодильнике, роутер стоит в шкафу у входа. "
            "Не забыть.")]
        uid = await uid_of(env, a[0]["item"]["id"])
        await scan_user(env.maker, None, uid)
        groups = (await c.get("/v1/duplicates/groups", headers=h)).json()["groups"]
        assert len(groups) == 3
        of = {m["item_id"]: g["id"] for g in groups for m in g["members"]}
        ga, gb, gd = of[a[0]["item"]["id"]], of[b[0]["item"]["id"]], of[d[0]["item"]["id"]]
        r = (await c.post(f"/v1/duplicates/groups/{gd}/dismiss", json={}, headers=h)).json()
        assert r["group"]["status"] == "dismissed" and r["action"]["kind"] == "dismiss_group"
        assert r["action"]["undoable"] is True
        u = await c.post(f"/v1/actions/{r['action']['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        again = (await c.get(f"/v1/duplicates/groups/{gd}", headers=h)).json()["group"]
        assert again["status"] == "suggested"
        cid = str(uuid.uuid4())
        m = await c.post("/v1/duplicates/merge", json={"client_id": cid, "groups": [
            {"id": ga}, {"id": gb, "keep_item_id": b[0]["item"]["id"]}]}, headers=h)
        assert m.status_code == 200, m.text
        out = m.json()
        assert {g["id"] for g in out["groups"]} == {ga, gb}
        assert out["action"]["summary"]["ru"] == "Объединил повторы: 2 группы, убрал 2 повтора"
        hidden = (await c.get(f"/v1/items/{b[1]['item']['id']}", headers=h)).json()
        assert hidden["canonical_id"] == b[0]["item"]["id"]
        rep = await c.post("/v1/duplicates/merge", json={"client_id": cid, "groups": [
            {"id": ga}, {"id": gb}]}, headers=h)
        assert rep.json()["repeated"] is True
        u = await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        assert u.status_code == 200 and u.json()["partial"] is False
        for x in (*a, *b):
            assert (await c.get(f"/v1/items/{x['item']['id']}", headers=h)).json()[
                "hidden_reason"] is None


async def test_old_tombstones_go_and_an_old_cursor_resyncs_from_scratch(env):
    from datetime import UTC, datetime, timedelta

    from assistant.records.store import purge_old_tombstones

    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        first = await note(c, h, "запись, которую потом удалят навсегда")
        uid = await uid_of(env, first["item"]["id"])
        since = (await c.get("/v1/sync?limit=500", headers=h)).json()["next_since"]
        async with env.maker() as s:
            await s.execute(text("DELETE FROM items WHERE user_id = :u"), {"u": uid})
            await s.execute(text("UPDATE sync_tombstones "
                                 "SET deleted_at = now() - interval '91 days'"
                                 " WHERE user_id = :u"), {"u": uid})
            await s.commit()
            assert await purge_old_tombstones(s, datetime.now(UTC) + timedelta(seconds=1)) >= 1
            await s.commit()
        old = (await c.get(f"/v1/sync?since={max(since - 1, 1)}", headers=h)).json()
        assert old["full_resync"] is True and old["next_since"] == 0 and old["items"] == []
        page1 = (await c.get("/v1/sync?since=0&limit=1", headers=h)).json()
        assert page1["has_more"] is True
        page2 = (await c.get(f"/v1/sync?since={page1['next_since']}&full=true&limit=500",
                             headers=h)).json()  # paging a fresh sync: no loop
        assert page2["full_resync"] is False and page2["has_more"] is False
        fresh = page2
        newer = (await c.get(f"/v1/sync?since={fresh['next_since']}", headers=h)).json()
        assert newer["full_resync"] is False
