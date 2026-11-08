"""Pages against a real Postgres migrated to head. Skipped unless DATABASE_URL is set."""

import asyncio
import os
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from assistant.api import consent_texts
from assistant.api.app import create_app
from assistant.api.sms import FakeSmsSender
from assistant.db.models import Item, User
from assistant.db.models_pages import Screen, ScreenItem
from assistant.db.models_v2 import ConsentKind
from assistant.pages import lexorank, place_item, rebalance_page
from assistant.records import purge_trashed_items
from tests.api.conftest import client, make_settings, make_storage

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

BASE = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS)


async def _signed_in(c, *, consent: bool = True) -> dict[str, str]:
    r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
    assert r.status_code == 200, r.text
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    if consent:
        items = []
        for kind in BASE:
            t = consent_texts.current(kind, "ru")
            assert t is not None
            items.append({"kind": kind, "version": t.version, "text_hash": t.text_hash,
                          "locale": "ru"})  # fmt: skip
        body = {"consents": items, "screen": "S05", "age_confirmed_18": True}
        r = await c.post("/v1/consents", json=body, headers=h)
        assert r.status_code == 200, r.text
    return h


def _cid() -> str:
    return str(uuid.uuid4())


async def _add_page(c, h, key: str, **kw) -> dict:
    r = await c.post("/v1/pages", json={"client_id": _cid(), "template_key": key, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["page"]


async def _note(c, h, body: str, **kw) -> str:
    r = await c.post("/v1/items", json={"client_id": _cid(), "text": body, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["item"]["id"]


async def _ids_on(c, h, page_id: str) -> list[str]:
    r = await c.get(f"/v1/pages/{page_id}/items?limit=200", headers=h)
    assert r.status_code == 200, r.text
    return [e["item"]["id"] for e in r.json()["entries"]]


async def _sync_all(c, h, since: int = 0) -> dict:
    out: dict = {"items": [], "screens": [], "screen_items": [], "tombstones": []}
    while True:
        page = (await c.get(f"/v1/sync?since={since}&limit=500", headers=h)).json()
        for key in out:
            out[key].extend(page[key])
        since = page["next_since"]
        if not page["has_more"]:
            out["next_since"] = since
            return out


async def _item(s, public_id: str) -> Item:
    item = await s.scalar(select(Item).where(Item.public_id == uuid.UUID(public_id)))
    assert item is not None
    return item


async def _page_row(s, public_id: str) -> Screen:
    page = await s.scalar(select(Screen).where(Screen.public_id == uuid.UUID(public_id)))
    assert page is not None
    return page


async def _link(s, page_id: str, item_id: str) -> ScreenItem:
    page, item = await _page_row(s, page_id), await _item(s, item_id)
    link = await s.scalar(
        select(ScreenItem)
        .where(ScreenItem.screen_id == page.id, ScreenItem.item_id == item.id)
        .execution_options(populate_existing=True)
    )
    assert link is not None
    return link


async def _mark_manual(s, page_id: str, item_id: str, position: str | None = None) -> None:
    """What week 7's `items/move` will do to a row."""
    link = await _link(s, page_id, item_id)
    link.manual_order, link.manual_at = True, datetime.now(UTC)
    link.updated_by = "user"
    if position is not None:
        link.position = position
    await s.commit()


# --- schema and catalogue ---


async def test_schema_after_migration(db_app):
    _, _, s = db_app
    triggers = set(await s.scalars(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")))
    assert {"screens_sync_seq", "screen_items_sync_seq", "screens_sync_tombstone",
            "screen_items_sync_tombstone", "users_today_screen"} <= triggers  # fmt: skip
    collation = await s.scalar(text(
        "SELECT collation_name FROM information_schema.columns "
        "WHERE table_name = 'screen_items' AND column_name = 'position'"
    ))  # fmt: skip
    assert collation == "C"


async def test_catalogue_with_etag(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        r = await c.get("/v1/page-templates", headers=h)
        assert r.status_code == 200
        templates = r.json()["templates"]
        assert [t["key"] for t in templates] == ["custom", "notes", "tasks", "shopping",
                                                 "documents", "expenses"]  # fmt: skip
        notes = templates[1]
        assert notes["title"] == {"ru": "Заметки", "kk": "Жазбалар"}
        assert notes["version"] == 2 and notes["auto_rule"] == {
            "any": [{"always": True}],
            "none": [{"task_record": True}, {"envelope_types": ["task", "reminder_request",
                                                                "shopping_list", "receipt"]}]}
        assert {"id": "text", "required": True}.items() <= notes["fields"][0].items()
        assert "ai_hints_ref" not in notes

        etag = r.headers["etag"]
        again = await c.get("/v1/page-templates", headers={**h, "If-None-Match": etag})
        assert again.status_code == 304 and again.content == b""
        stale = await c.get("/v1/page-templates", headers={**h, "If-None-Match": '"old"'})
        assert stale.status_code == 200


async def test_every_page_route_needs_base_consent(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c, consent=False)
        pid = uuid.uuid4()
        for method, path in (("GET", "/v1/page-templates"), ("GET", "/v1/pages"),
                             ("POST", "/v1/pages"), ("GET", f"/v1/pages/{pid}"),
                             ("PATCH", f"/v1/pages/{pid}"), ("DELETE", f"/v1/pages/{pid}"),
                             ("POST", f"/v1/pages/{pid}/restore"),
                             ("GET", f"/v1/pages/{pid}/items"),
                             ("POST", f"/v1/pages/{pid}/items")):  # fmt: skip
            r = await c.request(method, path, headers=h, json={})
            assert r.status_code in (403, 422), (method, path, r.text)
            if r.status_code == 403:
                assert r.json()["code"] == "consent_required"
        assert (await c.get("/v1/pages")).status_code == 401


# --- «Сегодня» ---


async def test_new_account_has_exactly_one_today_that_stays(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        pages = (await c.get("/v1/pages", headers=h)).json()["pages"]
        assert [p["kind"] for p in pages] == ["system_today"]
        today = pages[0]
        assert today["title"] == "Сегодня" and today["title_kk"] == "Бүгін"
        assert today["layout"] == "builtin:today" and today["client_id"] is None

        tid = today["id"]
        for r in (await c.delete(f"/v1/pages/{tid}", headers=h),
                  await c.patch(f"/v1/pages/{tid}", json={"title": "x"}, headers=h),
                  await c.post(f"/v1/pages/{tid}/items", json={"item_id": _cid()},
                               headers=h)):  # fmt: skip
            assert r.status_code == 403 and r.json()["code"] == "page_system"
        r = await c.post("/v1/pages", json={"client_id": _cid(), "template_key": "today"},
                         headers=h)  # fmt: skip
        assert r.status_code == 422 and r.json()["code"] == "template_unknown"

    with pytest.raises(Exception, match="ck_screens_today_permanent"):
        async with s.begin_nested():
            await s.execute(
                update(Screen).where(Screen.public_id == uuid.UUID(tid))
                .values(deleted_at=datetime.now(UTC))
            )  # fmt: skip
    with pytest.raises(Exception, match="uq_screens_one_today"):
        async with s.begin_nested():
            row = await _page_row(s, tid)
            await s.execute(text(
                "INSERT INTO screens (user_id, kind, template_key, template_version, singleton, "
                "title, icon, position, layout) VALUES (:u, 'system_today', 'today', 1, true, "
                "'x', 'today', '2', 'builtin:today')"
            ), {"u": row.user_id})  # fmt: skip


async def test_user_created_any_way_gets_today(db_app):
    _, _, s = db_app
    user = User(locale="ru", language="ru")
    s.add(user)
    await s.flush()
    kinds = list(await s.scalars(select(Screen.kind).where(Screen.user_id == user.id)))
    assert kinds == ["system_today"]


# --- create, limits, idempotency ---


async def test_create_is_idempotent_by_client_id(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        body = {"client_id": _cid(), "template_key": "notes"}
        first = await c.post("/v1/pages", json=body, headers=h)
        assert first.status_code == 201 and first.json()["created"] is True
        page = first.json()["page"]
        assert page["title"] == "Заметки" and page["title_kk"] == "Жазбалар"
        assert page["layout"] == "stacks" and page["icon"] == "documents"
        assert page["view_version"] == 1 and page["created_by"] == "user"
        again = await c.post("/v1/pages", json=body, headers=h)
        assert again.status_code == 200 and again.json()["created"] is False
        assert again.json()["page"]["id"] == page["id"]

        other = await _signed_in(c)  # the client_id belongs to one user only
        third = await c.post("/v1/pages", json=body, headers=other)
        assert third.status_code == 201 and third.json()["page"]["id"] != page["id"]


async def test_singleton_one_per_topic_custom_as_many_as_wanted(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        shop = await _add_page(c, h, "shopping")
        r = await c.post("/v1/pages", json={"client_id": _cid(), "template_key": "shopping"},
                         headers=h)  # fmt: skip
        assert r.status_code == 409 and r.json()["code"] == "singleton_exists"
        assert r.json()["details"]["page_id"] == shop["id"]

        a = await _add_page(c, h, "custom", title="Ремонт", icon="home", layout="checklist")
        b = await _add_page(c, h, "custom")
        assert (a["title"], a["icon"], a["layout"]) == ("Ремонт", "home", "checklist")
        assert a["title_kk"] is None
        assert (b["title"], b["icon"], b["layout"]) == ("Моя страница", "other", "list")

        pages = (await c.get("/v1/pages", headers=h)).json()["pages"]
        assert [p["title"] for p in pages] == ["Сегодня", "Покупки", "Ремонт", "Моя страница"]


async def test_validation_and_limit_of_twenty(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)

        async def post(**kw):
            return await c.post("/v1/pages", json={"client_id": _cid(), **kw}, headers=h)

        r = await post(template_key="nope")
        assert r.status_code == 422 and r.json()["code"] == "template_unknown"
        r = await post(template_key="custom", layout="builtin:kp")
        assert r.status_code == 422 and r.json()["code"] == "layout_not_allowed"
        for bad in ({"title": ""}, {"title": "   "}, {"title": "я" * 61}, {"icon": "today"}):
            r = await post(template_key="custom", **bad)
            assert r.status_code == 422 and r.json()["code"] == "validation_error", bad

        for n in range(19):  # + «Сегодня» = 20
            await _add_page(c, h, "custom", title=f"Страница {n}")
        r = await post(template_key="custom")
        assert r.status_code == 422 and r.json()["code"] == "pages_limit"

        victim = (await c.get("/v1/pages", headers=h)).json()["pages"][-1]["id"]
        await c.delete(f"/v1/pages/{victim}", headers=h)
        await _add_page(c, h, "custom")  # a removed page frees its place
        r = await c.post(f"/v1/pages/{victim}/restore", headers=h)
        assert r.status_code == 422 and r.json()["code"] == "pages_limit"


async def test_parallel_requests_on_real_connections(tmp_path):
    """Not in one rolled-back transaction: the user's lock has to work between connections."""
    engine = create_async_engine(os.environ["DATABASE_URL"])
    maker = async_sessionmaker(engine, expire_on_commit=False)
    app = create_app(make_settings(), sessionmaker=maker, sms=FakeSmsSender(),
                     storage=make_storage(tmp_path))  # fmt: skip
    user_id = None
    try:
        async with client(app) as c:
            h = await _signed_in(c)
            today = (await c.get("/v1/pages", headers=h)).json()["pages"][0]["id"]
            async with maker() as s:
                user_id = (await _page_row(s, today)).user_id

            async def post(client_id: str, key: str):
                body = {"client_id": client_id, "template_key": key}
                return await c.post("/v1/pages", json=body, headers=h)

            same = _cid()
            codes = [r.status_code for r in await asyncio.gather(
                *(post(same, "notes") for _ in range(6)))]  # fmt: skip
            assert sorted(codes) == [200] * 5 + [201]  # a retry race, not a conflict

            codes = [r.status_code for r in await asyncio.gather(
                *(post(_cid(), "shopping") for _ in range(6)))]  # fmt: skip
            assert sorted(codes) == [201] + [409] * 5

            results = await asyncio.gather(*(post(_cid(), "custom") for _ in range(25)))
            codes = [r.status_code for r in results]
            assert codes.count(201) == 17 and codes.count(422) == 8  # 20 with the 3 above
            pages = (await c.get("/v1/pages", headers=h)).json()["pages"]
            assert len(pages) == 20 and len({p["position"] for p in pages}) == 20

            shop = next(p for p in pages if p["template_key"] == "shopping")
            await c.delete(f"/v1/pages/{shop['id']}", headers=h)
            codes = [r.status_code for r in await asyncio.gather(
                *(post(_cid(), "shopping") for _ in range(6)))]  # fmt: skip
            assert sorted(codes) == [200] + [409] * 5  # one revival; the rest see it live

            notes = next(p for p in pages if p["template_key"] == "notes")
            await asyncio.gather(*(_note(c, h, f"запись {n}") for n in range(12)))
            body = (await c.get(f"/v1/pages/{notes['id']}/items", headers=h)).json()
            keys = [e["link"]["position"] for e in body["entries"]]
            assert len(keys) == 12 and len(set(keys)) == 12 and keys == sorted(keys)

            seqs = [row["seq"] for row in (await _sync_all(c, h))["screen_items"]]
            assert seqs == sorted(seqs) and len(seqs) == 12
    finally:
        if user_id is not None:
            async with maker() as s:  # jobs have no foreign key: they would stay behind
                await s.execute(text(
                    "DELETE FROM jobs WHERE (payload ->> 'item_id')::bigint IN "
                    "(SELECT id FROM items WHERE user_id = :u) "
                    "OR (payload ->> 'user_id')::bigint = :u"), {"u": user_id})  # fmt: skip
                await s.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
                await s.commit()
        await engine.dispose()


# --- edit, remove, restore ---


async def test_patch_title_icon_layout_and_view_version(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        path = f"/v1/pages/{page['id']}"

        r = await c.patch(path, json={"title": "Мои мысли", "icon": "people"}, headers=h)
        assert r.status_code == 200
        assert r.json()["title"] == "Мои мысли" and r.json()["title_kk"] is None
        assert r.json()["view_version"] == 1 and r.json()["seq"] > page["seq"]

        r = await c.patch(path, json={"layout": "list", "base_view_version": 1}, headers=h)
        assert r.json()["layout"] == "list" and r.json()["view_version"] == 2
        assert r.json()["customized"] is True

        r = await c.patch(path, json={"layout": "stacks", "base_view_version": 1}, headers=h)
        assert r.status_code == 409 and r.json()["code"] == "conflict"
        assert r.json()["details"]["view_version"] == 2
        r = await c.patch(path, json={"title": "Ещё", "base_view_version": 1}, headers=h)
        assert r.status_code == 200  # a stale base doesn't block a rename

        r = await c.patch(path, json={"layout": "table"}, headers=h)
        assert r.status_code == 422 and r.json()["code"] == "layout_not_allowed"
        r = await c.patch(path, json={"title": " "}, headers=h)
        assert r.status_code == 422

        other = await _signed_in(c)
        assert (await c.patch(path, json={"title": "x"}, headers=other)).status_code == 404
        assert (await c.get(path, headers=other)).status_code == 404
        assert (await c.get(f"{path}/items", headers=other)).status_code == 404


async def test_removing_a_page_keeps_the_items_and_restore_brings_all_back(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        a = await _note(c, h, "первая")
        b = await _note(c, h, "вторая")
        before = await _ids_on(c, h, page["id"])
        assert before == [b, a]
        await _mark_manual(s, page["id"], a, "0V")  # the person put «первая» on top
        assert await _ids_on(c, h, page["id"]) == [a, b]

        r = await c.delete(f"/v1/pages/{page['id']}", headers=h)
        assert r.status_code == 200 and r.json()["deleted_at"] is not None
        assert (await c.delete(f"/v1/pages/{page['id']}", headers=h)).status_code == 200
        assert (await c.get(f"/v1/pages/{page['id']}", headers=h)).status_code == 404
        assert (await c.get(f"/v1/pages/{page['id']}/items", headers=h)).status_code == 404
        titles = [p["title"] for p in (await c.get("/v1/pages", headers=h)).json()["pages"]]
        assert titles == ["Сегодня"]
        assert (await c.get(f"/v1/items/{a}", headers=h)).status_code == 200  # memory untouched

        d = await _note(c, h, "пока страницы не было")

        r = await c.post(f"/v1/pages/{page['id']}/restore", headers=h)
        assert r.status_code == 200 and r.json()["deleted_at"] is None
        # Manual order survives; what came in between takes its place by date.
        assert await _ids_on(c, h, page["id"]) == [a, d, b]
        s.expire_all()
        assert (await _link(s, page["id"], a)).manual_order is True


async def test_adding_a_removed_topic_again_revives_its_page(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        old = await _add_page(c, h, "notes", title="Мои заметки", layout="list")
        tasks = await _add_page(c, h, "tasks")
        kept, gone = await _note(c, h, "оставить"), await _note(c, h, "убрать со страницы")
        await s.execute(update(ScreenItem).where(
            ScreenItem.screen_id == (await _page_row(s, old["id"])).id,
            ScreenItem.item_id == select(Item.id).where(Item.public_id == uuid.UUID(gone))
            .scalar_subquery(),
        ).values(removed_by_user_at=datetime.now(UTC)))  # fmt: skip
        await s.commit()
        await c.delete(f"/v1/pages/{old['id']}", headers=h)
        since = (await c.get(f"/v1/pages/{tasks['id']}", headers=h)).json()["seq"]
        later = await _note(c, h, "пока страницы не было")

        client_id = _cid()
        body = {"client_id": client_id, "template_key": "notes", "title": "Другое"}
        r = await c.post("/v1/pages", json=body, headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["created"] is False and out["revived"] is True
        page = out["page"]
        assert page["id"] == old["id"] and page["position"] == old["position"]
        assert (page["title"], page["layout"]) == ("Мои заметки", "list")  # as it was
        assert page["deleted_at"] is None and page["client_id"] == client_id

        tabs = [p["id"] for p in (await c.get("/v1/pages", headers=h)).json()["pages"]]
        assert tabs[1:] == [old["id"], tasks["id"]]  # its old place in the tabs
        on_page = await _ids_on(c, h, old["id"])
        assert kept in on_page and later in on_page and gone not in on_page  # R-54

        synced = await _sync_all(c, h, since)
        assert synced["screens"][-1]["id"] == old["id"]
        assert synced["screens"][-1]["deleted_at"] is None

        # A retry of that request is the same page, not a conflict.
        retry = await c.post("/v1/pages", json=body, headers=h)
        assert retry.status_code == 200 and retry.json()["page"]["id"] == old["id"]
        assert retry.json()["revived"] is False
        # The «Отменить» of the removal, tapped late: it is already back.
        undo = await c.post(f"/v1/pages/{old['id']}/restore", headers=h)
        assert undo.status_code == 200 and undo.json()["id"] == old["id"]
        # While it is live, one more add is the same 409 as ever.
        r = await c.post("/v1/pages", json={"client_id": _cid(), "template_key": "notes"},
                         headers=h)  # fmt: skip
        assert r.status_code == 409 and r.json()["details"]["page_id"] == old["id"]


async def test_revival_is_for_singletons_and_respects_the_limit(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        mine = await _add_page(c, h, "custom", title="Ремонт")
        await c.delete(f"/v1/pages/{mine['id']}", headers=h)
        another = await _add_page(c, h, "custom", title="Ремонт")  # as many as wanted
        assert another["id"] != mine["id"]

        shop = await _add_page(c, h, "shopping")
        await c.delete(f"/v1/pages/{shop['id']}", headers=h)
        for n in range(18):  # + «Сегодня» and «Ремонт» = 20
            await _add_page(c, h, "custom", title=f"Страница {n}")
        r = await c.post("/v1/pages", json={"client_id": _cid(), "template_key": "shopping"},
                         headers=h)  # fmt: skip
        assert r.status_code == 422 and r.json()["code"] == "pages_limit"
        assert (await c.get(f"/v1/pages/{shop['id']}", headers=h)).status_code == 404


async def test_old_duplicates_revive_the_last_removed_and_restore_can_still_refuse(db_app):
    """Accounts from before revival can hold several removed rows of one topic."""
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        old = await _add_page(c, h, "shopping")
        await c.delete(f"/v1/pages/{old['id']}", headers=h)
        row = await _page_row(s, old["id"])
        await s.execute(text(
            "INSERT INTO screens (user_id, template_key, template_version, singleton, title, icon, "
            "position, layout, created_by, deleted_at) "
            "SELECT user_id, template_key, template_version, singleton, 'Вторая', icon, 'zz', "
            "layout, created_by, now() + interval '1 minute' FROM screens WHERE id = :id"),
            {"id": row.id})  # fmt: skip
        await s.commit()
        r = await c.post("/v1/pages", json={"client_id": _cid(), "template_key": "shopping"},
                         headers=h)  # fmt: skip
        assert r.status_code == 200 and r.json()["page"]["title"] == "Вторая"
        new = r.json()["page"]
        r = await c.post(f"/v1/pages/{old['id']}/restore", headers=h)
        assert r.status_code == 409 and r.json()["details"]["page_id"] == new["id"]


async def test_notes_shows_every_note(db_app):
    """«Заметки»: any note, from before or after adding (receipts, tasks and shopping go to their
    own pages when the person has them: test below)."""
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        before = await _note(c, h, "до страницы")
        page = await _add_page(c, h, "notes")
        after = await _note(c, h, "после страницы")
        link = (await c.post("/v1/items", json={"client_id": _cid(), "url": "https://example.com/a"},
                             headers=h)).json()["item"]["id"]  # fmt: skip
        assert set(await _ids_on(c, h, page["id"])) == {before, after, link}


async def test_notes_leaves_out_receipts_and_tasks_another_page_takes(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        receipt = await _note(c, h, "Чек Magnum 4 500")
        lonely = await _note(c, h, "Чек аптека 1 200")
        for pid in (receipt, lonely):
            row = await _item(s, pid)
            row.envelope = {"type": "receipt"}
            await s.flush()
            await place_item(s, row)
        await s.commit()
        # no «Расходы» yet: a receipt is not left on no page
        assert {receipt, lonely} <= set(await _ids_on(c, h, notes["id"]))
        expenses = await _add_page(c, h, "expenses")  # takes the receipts
        assert set(await _ids_on(c, h, expenses["id"])) == {receipt, lonely}
        assert not {receipt, lonely} & set(await _ids_on(c, h, notes["id"]))
        idea = await _note(c, h, "Идея: полка над столом")
        assert idea in await _ids_on(c, h, notes["id"])
        shop = await _add_page(c, h, "shopping")
        r = await c.post("/v1/tasks", json={"client_id": _cid(), "list_key": "shopping",
                                            "title": "Хлеб"}, headers=h)  # fmt: skip
        assert r.status_code in (200, 201), r.text
        on_shop = set(await _ids_on(c, h, shop["id"]))
        assert on_shop and not on_shop & set(await _ids_on(c, h, notes["id"]))


async def test_a_new_page_does_not_link_hidden_voice_fragments(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        visible = await _note(c, h, "обычная запись")
        hidden = await _note(c, h, "кусок записи")
        await s.execute(update(Item).where(Item.public_id == uuid.UUID(hidden))
                        .values(hidden_reason="voice_fragment", fragment_no=1))  # fmt: skip
        await s.commit()
        page = await _add_page(c, h, "notes")
        linked = set(await s.scalars(
            select(Item.public_id)
            .join(ScreenItem, ScreenItem.item_id == Item.id)
            .where(ScreenItem.screen_id == (await _page_row(s, page["id"])).id)
        ))  # fmt: skip
    assert linked == {uuid.UUID(visible)}


# --- placement (auto_rule) ---


async def test_new_page_is_filled_from_memory_newest_first(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        now = datetime.now(UTC)
        old = await _note(c, h, "давно", occurred_at=(now - timedelta(days=3)).isoformat())
        recent = await _note(c, h, "вчера", occurred_at=(now - timedelta(days=1)).isoformat())
        middle = await _note(c, h, "два дня", occurred_at=(now - timedelta(days=2)).isoformat())
        page = await _add_page(c, h, "notes")
        assert await _ids_on(c, h, page["id"]) == [recent, middle, old]
        assert await _ids_on(c, h, (await _add_page(c, h, "custom"))["id"]) == []  # nothing by rule


async def test_new_items_land_by_date_and_one_item_is_on_several_pages(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        docs = await _add_page(c, h, "documents")
        shop = await _add_page(c, h, "shopping")

        first = await _note(c, h, "первая")
        late = await _note(c, h, "старая, принесли только сейчас", occurred_at=(
            datetime.now(UTC) - timedelta(days=30)).isoformat())  # fmt: skip
        last = await _note(c, h, "третья")
        assert await _ids_on(c, h, notes["id"]) == [last, first, late]
        assert await _ids_on(c, h, docs["id"]) == [] and await _ids_on(c, h, shop["id"]) == []

        # The envelope arrives later; placing again only adds what newly matches.
        receipt = await _item(s, first)
        receipt.envelope = {"type": "receipt"}
        await s.flush()
        assert await place_item(s, receipt) == 1  # «Документы», not «Заметки» again
        await s.commit()
        assert await place_item(s, receipt) == 0  # safe to repeat
        await s.commit()
        # Founder 2026-11-09: «Заметки» is notes only; a receipt another page takes leaves it.
        assert first not in await _ids_on(c, h, notes["id"])
        assert await _ids_on(c, h, docs["id"]) == [first]


async def test_screen_rule_replaces_the_template_rule(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "custom", title="Ремонт")
        row = await _page_row(s, page["id"])
        row.rule = {"any": [{"words": ["ремонт"]}]}
        await s.commit()
        yes = await _note(c, h, "Смета на ремонт кухни")
        await _note(c, h, "Купить хлеб")
        assert await _ids_on(c, h, page["id"]) == [yes]


async def test_placement_never_moves_manual_rows(db_app):
    """R-54: the person's order is theirs; new rows go around it."""
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        a, b, d = [await _note(c, h, f"запись {n}") for n in "abd"]
        assert await _ids_on(c, h, page["id"]) == [d, b, a]
        # The person: oldest record first, on top.
        await _mark_manual(s, page["id"], a, "0V")
        snapshot = ((await _link(s, page["id"], a)).position,
                    (await _link(s, page["id"], b)).position)  # fmt: skip

        new = await _note(c, h, "новая")
        ids = await _ids_on(c, h, page["id"])
        assert ids == [a, new, d, b]  # the manual head stays on top of anything new
        s.expire_all()
        row_a, row_b = await _link(s, page["id"], a), await _link(s, page["id"], b)
        assert (row_a.position, row_b.position) == snapshot
        assert row_a.manual_order is True and row_a.updated_by == "user"

        # A manual row in the middle isn't used as a reference and doesn't move either.
        await _mark_manual(s, page["id"], d)
        newer = await _note(c, h, "ещё новее")
        assert await _ids_on(c, h, page["id"]) == [a, newer, new, d, b]


async def test_removed_row_is_not_returned_by_rule_but_person_can_add_it(db_app):
    """R-54.5: «Убрать с этой страницы» sticks for the agent, not for the person."""
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        nid = await _note(c, h, "запись")
        link = await _link(s, page["id"], nid)
        link.removed_by_user_at, link.updated_by = datetime.now(UTC), "user"
        await s.commit()
        assert await _ids_on(c, h, page["id"]) == []

        assert await place_item(s, await _item(s, nid)) == 0  # rule matches, marker wins
        await s.commit()
        assert await _ids_on(c, h, page["id"]) == []
        synced = await _sync_all(c, h)
        assert [row["removed_at"] is not None for row in synced["screen_items"]] == [True]

        r = await c.post(f"/v1/pages/{page['id']}/items", json={"item_id": nid}, headers=h)
        assert r.status_code == 200 and r.json()["created"] is False
        assert r.json()["link"]["removed_at"] is None and r.json()["link"]["added_by"] == "user"
        assert r.json()["link"]["updated_by"] == "user"
        assert await _ids_on(c, h, page["id"]) == [nid]


async def test_add_item_to_a_custom_page(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "custom", title="Дача")
        nid = await _note(c, h, "Посадить яблоню")
        path = f"/v1/pages/{page['id']}/items"
        r = await c.post(path, json={"item_id": nid}, headers=h)
        assert r.status_code == 201 and r.json()["created"] is True
        link = r.json()["link"]
        assert (link["added_by"], link["updated_by"]) == ("user", "user")
        assert link["manual_order"] is False
        assert lexorank.is_valid(link["position"])
        r = await c.post(path, json={"item_id": nid}, headers=h)  # idempotent
        assert r.status_code == 200 and r.json()["created"] is False
        assert r.json()["link"]["id"] == link["id"]

        entry = (await c.get(path, headers=h)).json()["entries"][0]
        assert entry["item"]["id"] == nid and entry["link"]["id"] == link["id"]
        assert entry["fields"]["text"] == "Посадить яблоню" and "date" in entry["fields"]

        assert (await c.post(path, json={"item_id": _cid()}, headers=h)).status_code == 404
        await c.delete(f"/v1/items/{nid}", headers=h)
        r = await c.post(path, json={"item_id": nid}, headers=h)
        assert r.status_code == 409 and r.json()["code"] == "item_deleted"

        other = await _signed_in(c)
        theirs = await _add_page(c, other, "custom")
        r = await c.post(f"/v1/pages/{theirs['id']}/items", json={"item_id": nid}, headers=other)
        assert r.status_code == 404  # someone else's item
        await s.commit()


# --- contents ---


async def test_contents_hide_trashed_merged_and_paginate(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        ids = [await _note(c, h, f"запись номер {n}") for n in range(5)]
        ordered = list(reversed(ids))

        path = f"/v1/pages/{page['id']}/items"
        got, cursor = [], None
        for _ in range(5):
            url = f"{path}?limit=2" + (f"&cursor={cursor}" if cursor else "")
            body = (await c.get(url, headers=h)).json()
            got += [e["item"]["id"] for e in body["entries"]]
            cursor = body["next_cursor"]
            if cursor is None:
                break
        assert got == ordered
        assert (await c.get(f"{path}?cursor={_cid()}", headers=h)).status_code == 404

        await c.delete(f"/v1/items/{ids[0]}", headers=h)
        dup = await c.post("/v1/items", json={"client_id": _cid(), "text": "запись номер 1"},
                           headers=h)  # fmt: skip
        assert dup.json()["auto_merged"] is True
        assert await _ids_on(c, h, page["id"]) == ordered[:4]

        await c.post(f"/v1/items/{ids[0]}/restore", headers=h)  # back to where it was
        assert await _ids_on(c, h, page["id"]) == ordered
        await c.post(f"/v1/items/{dup.json()['item']['id']}/unmerge", headers=h)
        assert dup.json()["item"]["id"] in await _ids_on(c, h, page["id"])


async def test_rows_without_position_go_last_by_date_and_cursor_passes_them(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        now = datetime.now(UTC)
        a = await _note(c, h, "запись a", occurred_at=(now - timedelta(days=2)).isoformat())
        b = await _note(c, h, "запись b", occurred_at=(now - timedelta(days=1)).isoformat())
        d = await _note(c, h, "запись d")
        for nid in (a, b):
            (await _link(s, page["id"], nid)).position = None
        await s.commit()
        assert await _ids_on(c, h, page["id"]) == [d, b, a]
        path = f"/v1/pages/{page['id']}/items"
        got, cursor = [], None
        for _ in range(3):
            url = f"{path}?limit=1" + (f"&cursor={cursor}" if cursor else "")
            body = (await c.get(url, headers=h)).json()
            got += [e["item"]["id"] for e in body["entries"]]
            cursor = body["next_cursor"]
        assert got == [d, b, a] and cursor is None


async def test_filter_by_group(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        a = await _note(c, h, "в группе")
        await _note(c, h, "без группы")
        (await _link(s, page["id"], a)).group_key = "g1"
        await s.commit()
        body = (await c.get(f"/v1/pages/{page['id']}/items?group=g1", headers=h)).json()
        assert [e["item"]["id"] for e in body["entries"]] == [a]


# --- rebalance ---


async def test_rebalance_keeps_order_flags_and_authorship(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        ids = [await _note(c, h, f"запись {n}") for n in range(6)]
        await _mark_manual(s, page["id"], ids[2], "0" + "0" * 70 + "V")  # a very long key
        before = await _ids_on(c, h, page["id"])
        row = await _link(s, page["id"], ids[2])
        stamp = row.updated_at, row.updated_by, row.manual_at

        internal = (await _page_row(s, page["id"])).id
        assert await rebalance_page(s, internal) == 6
        await s.commit()

        assert await _ids_on(c, h, page["id"]) == before
        s.expire_all()
        row = await _link(s, page["id"], ids[2])
        assert row.manual_order is True and len(row.position) <= 3
        assert (row.updated_at, row.updated_by, row.manual_at) == stamp


async def test_long_gap_triggers_rebalance_without_changing_order(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        a, b = await _note(c, h, "нижняя"), await _note(c, h, "верхняя")
        # A manual head with almost no room right under it: the next key would overflow.
        low = "1" + "0" * 63 + "1"
        await _mark_manual(s, page["id"], b, low)
        (await _link(s, page["id"], a)).position = "1" + "0" * 63 + "2"
        await s.commit()
        new = await _note(c, h, "новая")
        assert await _ids_on(c, h, page["id"]) == [b, new, a]
        s.expire_all()
        assert len((await _link(s, page["id"], b)).position) <= 3


# --- sync ---


async def test_sync_carries_pages_links_and_removals_in_seq_order(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        first = await _sync_all(c, h)
        assert [p["kind"] for p in first["screens"]] == ["system_today"]
        assert first["items"] == [] and first["screen_items"] == []
        assert first["next_since"] >= first["screens"][0]["seq"]  # a summary may come after it

        page = await _add_page(c, h, "notes")
        nid = await _note(c, h, "запись")
        delta = await _sync_all(c, h, first["next_since"])
        assert [p["id"] for p in delta["screens"]] == [page["id"]]
        assert [i["id"] for i in delta["items"]] == [nid]
        link = delta["screen_items"][0]
        assert (link["page_id"], link["item_id"]) == (page["id"], nid)
        assert link["seq"] > delta["items"][0]["seq"]
        assert delta["next_since"] >= link["seq"]  # a summary may come after it

        none = (await c.get(f"/v1/sync?since={delta['next_since']}", headers=h)).json()
        assert none == {"items": [], "screens": [], "screen_items": [], "screen_summaries": [],
                        "actions": [], "conversation_messages": [],
                        "reminders": [], "reminder_fires": [], "tasks": [], "suggestions": [],
                         "pending_actions": [], "habits": [],
                        "tombstones": [], "next_since": delta["next_since"],
                        "has_more": False, "full_resync": False}  # fmt: skip

        await c.delete(f"/v1/pages/{page['id']}", headers=h)
        gone = await _sync_all(c, h, delta["next_since"])
        assert gone["screens"][0]["deleted_at"] is not None and gone["tombstones"] == []

        other = await _signed_in(c)
        theirs = await _sync_all(c, other)
        assert len(theirs["screens"]) == 1 and theirs["screen_items"] == []


async def test_sync_pages_across_entities_loses_nothing(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        await _add_page(c, h, "notes")
        for n in range(4):
            await _note(c, h, f"запись {n}")
        everything = await _sync_all(c, h)

        got: dict[str, list] = {"items": [], "screens": [], "screen_items": []}
        since, last_seq = 0, 0
        for _ in range(30):
            body = (await c.get(f"/v1/sync?since={since}&limit=2", headers=h)).json()
            seqs = [row["seq"] for key in got for row in body[key]]
            assert len(seqs) <= 2 and (not seqs or min(seqs) > last_seq)
            last_seq = max(seqs, default=last_seq)
            for key in got:
                got[key] += [row["id"] for row in body[key]]
            since = body["next_since"]
            if not body["has_more"]:
                break
        for key, ids in got.items():
            assert ids == [row["id"] for row in everything[key]], key


async def test_purging_an_item_leaves_a_link_tombstone(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "notes")
        nid = await _note(c, h, "запись")
        link_id = str((await _link(s, page["id"], nid)).public_id)
        await c.delete(f"/v1/items/{nid}", headers=h)
        since = (await _sync_all(c, h))["next_since"]

        future = datetime.now(UTC) + timedelta(days=31)
        assert await purge_trashed_items(s, now=future) >= 1
        await s.commit()

        delta = await _sync_all(c, h, since)
        tombs = {(t["entity"], t["id"]) for t in delta["tombstones"]}
        assert ("item", nid) in tombs and ("screen_item", link_id) in tombs
        assert await _ids_on(c, h, page["id"]) == []


async def test_trigger_tombstone_for_a_hard_deleted_screen(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _add_page(c, h, "custom")
        since = (await _sync_all(c, h))["next_since"]
        await s.execute(text("DELETE FROM screens WHERE public_id = :p"),
                        {"p": uuid.UUID(page["id"])})  # fmt: skip
        await s.commit()
        tombs = (await _sync_all(c, h, since))["tombstones"]
        assert [(t["entity"], t["id"]) for t in tombs] == [("screen", page["id"])]
