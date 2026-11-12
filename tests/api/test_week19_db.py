"""Week 19 against a real database: the beta scope (Ф-33...Ф-44) and the message limit.

- «Начать» on the welcome screen writes the consents with `screen = welcome` (Ф-34);
- first launch makes «Заметки» + «Дела»; «Покупки», «Расходы», «Документы и КП» come with their
  first record, once (Ф-35, Ф-36);
- the line is not offered `set_view` and says so (Ф-39);
- «Сегодня»: no proposals, no tiles, a tip only in the first week (Ф-42);
- the per-person message limit: per minute, per day, by profile, taps and retries not counted.
Providers are fakes (no network). Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text

from assistant.ai import ToolCall
from assistant.api import consent_texts
from assistant.chat import ChatReply
from assistant.chat.context import VIEW_OFF_LINE
from assistant.db.models_tasks import Suggestion, SuggestionKind, SuggestionStatus
from assistant.db.models_v2 import ConsentKind
from assistant.suggestions import engine as suggestions
from tests.api.conftest import client, make_settings
from tests.api.test_week9_db import entries
from tests.chat.test_chat_db import (  # noqa: F401  (env is a fixture)
    AI,
    _all_text,
    env,
    events,
    page,
    signed_in,
)
from tests.chat.test_week6_db import Script, by_name, last, router_with

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def _uid(c, maker, h: dict[str, str]) -> int:  # type: ignore[no-untyped-def]
    pid = (await c.get("/v1/me", headers=h)).json()["id"]
    async with maker() as s:
        return int(await s.scalar(text("SELECT id FROM users WHERE public_id = :p"),
                                  {"p": uuid.UUID(pid)}))  # fmt: skip


async def _pages(c, h) -> dict[str, dict]:  # type: ignore[no-untyped-def]
    r = await c.get("/v1/pages", headers=h)
    assert r.status_code == 200, r.text
    return {p["template_key"]: p for p in r.json()["pages"] if p.get("deleted_at") is None}


async def _first_launch(c) -> dict[str, str]:  # type: ignore[no-untyped-def]
    """Ф-34: welcome «Начать» = the consents with screen `welcome`, then the default pages."""
    import secrets

    r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    items = []
    for kind in AI:
        t = consent_texts.current(kind, "ru")
        assert t is not None
        items.append({"kind": kind, "version": t.version, "text_hash": t.text_hash, "locale": "ru"})
    r = await c.post("/v1/consents", json={"consents": items, "screen": "welcome",
                                           "age_confirmed_18": True}, headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["app_enabled"] and r.json()["ai_enabled"]
    r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()), "path": "skipped"},
                     headers=h)  # fmt: skip
    assert r.status_code == 201, r.text
    return h


async def test_welcome_consents_and_default_pages(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        rows = (await c.get("/v1/consents", headers=h)).json()["active"]
        assert {r["screen"] for r in rows} == {"welcome"}
        assert {r["kind"] for r in rows} == {str(k) for k in AI}
        assert all(r["text_hash"] and r["version"] for r in rows)
        assert set(await _pages(c, h)) == {"today", "notes", "tasks"}
        # the gate is as before: «Без ИИ» from welcome too
        import secrets

        r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
        h2 = {"Authorization": f"Bearer {r.json()['access_token']}"}
        assert (await c.get("/v1/pages", headers=h2)).status_code == 403
        base = []
        for kind in (ConsentKind.PD_PROCESSING, ConsentKind.TERMS):
            t = consent_texts.current(kind, "ru")
            assert t is not None
            base.append({"kind": kind, "version": t.version, "text_hash": t.text_hash,
                         "locale": "ru"})  # fmt: skip
        r = await c.post("/v1/consents", json={"consents": base, "screen": "welcome"}, headers=h2)
        assert r.status_code == 422 and r.json()["code"] == "age_confirmation_required"
        r = await c.post("/v1/consents", json={"consents": base, "screen": "welcome",
                                               "age_confirmed_18": True}, headers=h2)
        assert r.status_code == 200 and not r.json()["ai_enabled"]


async def _shop(c, h, title: str) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()), "list_key": "shopping",
                                        "title": title}, headers=h)  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()


async def test_shopping_page_on_the_first_thing_to_buy_once(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        out = await _shop(c, h, "Хлеб")
        pages = await _pages(c, h)
        assert "shopping" in pages
        shop = pages["shopping"]
        assert shop["created_by"] == "system"
        made = [x for x in out["action"]["changes"] if x["kind"] == "create_page"]
        assert made and made[0]["page_id"] == shop["id"] and made[0]["item_id"] is None
        assert out["action"]["summary"]["ru"].startswith("Добавил в Покупки")
        shown = [e["item"]["id"] for e in await entries(c, h, shop["id"])]
        assert shown == [out["task"]["item_id"]]
        # «Отменить» takes the thing back; the page stays
        r = await c.post(f"/v1/actions/{out['action']['id']}/undo",
                         json={"client_id": str(uuid.uuid4())}, headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        assert "shopping" in await _pages(c, h)
        # the second thing: the same page, no new one
        out2 = await _shop(c, h, "Молоко")
        assert not [x for x in out2["action"]["changes"] if x["kind"] == "create_page"]
        # removed by the person: not made again; things to buy go to «Дела» as before
        r = await c.delete(f"/v1/pages/{shop['id']}", headers=h)
        assert r.status_code == 200, r.text
        out3 = await _shop(c, h, "Сыр")
        pages = await _pages(c, h)
        assert "shopping" not in pages
        assert out3["action"]["summary"]["ru"].startswith("Добавил в")
        assert not [x for x in out3["action"]["changes"] if x["kind"] == "create_page"]
        uid = await _uid(c, env.maker, h)
        async with env.maker() as s:
            marks = await s.scalar(text("SELECT pages_first_use FROM users WHERE id = :u"),
                                   {"u": uid})  # fmt: skip
        assert marks == ["shopping"]


async def test_expenses_and_documents_pages_on_first_use(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        r = await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), "amount": "5000",
                                               "note": "Бензин"}, headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        body = r.json()
        pages = await _pages(c, h)
        assert "expenses" in pages
        assert body["expense"]["item_id"] in {
            e["item"]["id"] for e in await entries(c, h, pages["expenses"]["id"])}
        made = [x for x in body["action"]["changes"] if x["kind"] == "create_page"]
        assert made and made[0]["page_id"] == pages["expenses"]["id"]
        # not on «Заметки»: «Расходы» took it before the record was placed
        notes = await entries(c, h, pages["notes"]["id"])
        assert body["expense"]["item_id"] not in {e["item"]["id"] for e in notes}
        # the first КП makes «Документы и КП»
        from assistant.kp import service as kp

        uid = await _uid(c, env.maker, h)
        async with env.maker() as s:
            await kp.create(s, uid, sources=[], wishes=None, client_id=uuid.uuid4(),
                            now=datetime.now(UTC))  # fmt: skip
            await s.commit()
        assert "documents" in await _pages(c, h)


async def test_first_use_switch_off(env, monkeypatch):  # noqa: F811
    import assistant.config as config

    off = make_settings(pages_on_first_use=False)
    monkeypatch.setattr(config, "get_settings", lambda: off)
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        out = await _shop(c, h, "Хлеб")
        assert "shopping" not in await _pages(c, h)
        sentence = out["action"]["summary"]["ru"]
        assert sentence.startswith("Добавил в Дела") and sentence.endswith(": хлеб.")


DONE = ChatReply(answer="Так пока не умею — вид страницы меняется в «⋯».", citations=[],
                 insufficient=False)  # fmt: skip


async def test_the_line_does_not_change_views_in_the_beta(env):  # noqa: F811
    script = Script([DONE])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        pid = await page(c, h, "Ремонт")
        r = await c.post("/v1/chat/messages", json={"client_id": str(uuid.uuid4()),
                                                    "text": "покажи таблицей", "page_id": pid},
                         headers=h)  # fmt: skip
        evs = events(r.text)
        req = script.calls["ChatReply"][0]
        names = {t.name for t in req.tools}
        assert "set_view" not in names and "update" in names
        assert VIEW_OFF_LINE in _all_text(req)
        assert not by_name(evs, "action")
        assert (await c.get(f"/v1/pages/{pid}", headers=h)).json()["layout"] != "table"
        # «раскрась по темам» by code is not run either
        notes = (await _pages(c, h)).get("notes")
        target = notes["id"] if notes else pid
        r = await c.post("/v1/chat/messages", json={"client_id": str(uuid.uuid4()),
                                                    "text": "раскрась по темам",
                                                    "page_id": target}, headers=h)  # fmt: skip
        evs = events(r.text)
        assert not by_name(evs, "action")
        assert "«⋯»" in last(evs, "banner")["text"]


async def test_the_line_still_renames_a_page_with_views_off(env):  # noqa: F811
    from tests.api.test_views_db import sv

    script = Script([
        lambda req: [ToolCall("r1", "rename_page", {"page": None, "title": "Дача",
                                                    "icon": "home"})],
        ChatReply(answer="Готово.", citations=[], insufficient=False),
        # a model that still tries set_view gets an error and changes nothing
        lambda req: [ToolCall("v1", "set_view", sv(layout="table"))],
        ChatReply(answer="Так пока не умею — вид страницы меняется в «⋯».", citations=[],
                  insufficient=False),
    ])  # fmt: skip
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        pid = await page(c, h, "Ремонт")
        r = await c.post("/v1/chat/messages", json={"client_id": str(uuid.uuid4()),
                                                    "text": "переименуй страницу в Дача",
                                                    "page_id": pid}, headers=h)  # fmt: skip
        evs = events(r.text)
        req = script.calls["ChatReply"][0]
        assert "rename_page" in {t.name for t in req.tools}
        action = last(evs, "action")["action"]
        got = (await c.get(f"/v1/pages/{pid}", headers=h)).json()
        assert got["title"] == "Дача" and got["icon"] == "home"
        r = await c.post(f"/v1/actions/{action['id']}/undo", json={}, headers=h)
        assert r.status_code == 200, r.text
        assert (await c.get(f"/v1/pages/{pid}", headers=h)).json()["title"] == "Ремонт"
        r = await c.post("/v1/chat/messages", json={"client_id": str(uuid.uuid4()),
                                                    "text": "покажи таблицей", "page_id": pid},
                         headers=h)  # fmt: skip
        evs = events(r.text)
        assert not by_name(evs, "action")
        result = script.calls["ChatReply"][-1].messages[-1].tool_results[0]
        assert result.is_error and "not available" in result.content
        assert (await c.get(f"/v1/pages/{pid}", headers=h)).json()["layout"] != "table"


async def test_the_line_with_views_on_offers_set_view(env):  # noqa: F811
    from tests.api.test_views_db import sv

    script = Script([lambda req: [ToolCall("v1", "set_view", sv(layout="table"))],
                     ChatReply(answer="Готово.", citations=[], insufficient=False)])
    app = env.make_app(router_with(env.maker, script), feature_assistant_views=True)
    async with client(app) as c:
        h = await signed_in(c)
        pid = await page(c, h, "Ремонт")
        r = await c.post("/v1/chat/messages", json={"client_id": str(uuid.uuid4()),
                                                    "text": "покажи таблицей", "page_id": pid},
                         headers=h)  # fmt: skip
        assert last(events(r.text), "action")["action"]["kind"] == "screen_view_change"


async def _suggest(maker, uid: int, settings: Any, *, age: timedelta) -> tuple[list, Any]:  # type: ignore[no-untyped-def]
    async with maker() as s:
        await s.execute(text("UPDATE users SET created_at = :t WHERE id = :u"),
                        {"t": datetime.now(UTC) - age, "u": uid})
        props, tip = await suggestions.current(s, uid, datetime.now(UTC), settings)
        out = [p.key for p in props], (tip.key if tip else None)
        await s.rollback()
    return out


async def test_today_beta_scope(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        uid = await _uid(c, env.maker, h)
        async with env.maker() as s:  # a live data proposal made before the switch
            s.add(Suggestion(user_id=uid, kind=SuggestionKind.DATA_PROPOSAL, key="task_from_item",
                             payload={"title": "Позвонить"}, status=SuggestionStatus.PENDING,
                             expires_at=datetime.now(UTC) + timedelta(hours=10)))
            await s.commit()
        today = (await c.get("/v1/today", headers=h)).json()
        assert today["proposals"] == [] and "proposals" not in today["sections"]
        assert today["tip"] is not None  # a new account: one tip
        assert today["page_tiles"] == []
        # a pinned tile does not show either
        notes = (await _pages(c, h))["notes"]
        r = await c.put(f"/v1/pages/{notes['id']}/today-tile", json={"mode": "pinned"},
                        headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        assert (await c.get("/v1/today", headers=h)).json()["page_tiles"] == []

    beta = make_settings()
    props, tip = await _suggest(env.maker, uid, beta, age=timedelta(days=8))
    assert props == [] and tip is None  # after the first week: no tips
    props, tip = await _suggest(env.maker, uid, make_settings(today_tips_days=0),
                                age=timedelta(days=8))
    assert tip is not None
    on = make_settings(feature_today_proposals=True, today_tips_days=0)
    props, _ = await _suggest(env.maker, uid, on, age=timedelta(days=8))
    assert props == ["task_from_item"]


async def _send(c, h, text_: str, client_id: str | None = None, **kw):  # type: ignore[no-untyped-def]
    return await c.post("/v1/chat/messages", json={"client_id": client_id or str(uuid.uuid4()),
                                                   "text": text_, **kw}, headers=h)


async def test_message_limit_per_minute(env):  # noqa: F811
    app = env.make_app(router_with(env.maker, Script()),
                       chat_rate_per_minute={"regular": 2, "family_beta": 3},
                       chat_rate_per_day={"regular": 100})  # fmt: skip
    async with client(app) as c:
        h = await signed_in(c)
        first = str(uuid.uuid4())
        assert (await _send(c, h, "Что я записывал про врача?", first)).status_code == 200
        assert (await _send(c, h, "А про плитку?")).status_code == 200
        r = await _send(c, h, "И про дачу?")
        assert r.status_code == 429, r.text
        body = r.json()
        assert body["code"] == "chat_rate_limited" and body["message_kk"]
        assert "Подождите" in body["message_ru"]
        assert 1 <= body["retry_after"] <= 60
        assert r.headers["retry-after"] == str(body["retry_after"])
        # a resend of the same phrase gets its first answer, not a 429
        assert (await _send(c, h, "Что я записывал про врача?", first)).status_code == 200
        await app.state.ctx.chat.drain()
        uid = await _uid(c, env.maker, h)
        async with env.maker() as s:
            n = await s.scalar(text("SELECT count(*) FROM conversation_messages "
                                    "WHERE user_id = :u AND role = 'user'"), {"u": uid})
            assert n == 2  # the refused phrase was not saved
            # family_beta: more, but not unlimited
            await s.execute(text("UPDATE users SET profile = 'family_beta' WHERE id = :u"),
                            {"u": uid})
            await s.commit()
        assert (await _send(c, h, "И про дачу?")).status_code == 200
        assert (await _send(c, h, "И про машину?")).status_code == 429
        # a minute later the window is free again (the rows get older)
        await app.state.ctx.chat.drain()
        async with env.maker() as s:
            await s.execute(text("UPDATE conversation_messages SET created_at = created_at - "
                                 "interval '61 seconds' WHERE user_id = :u"), {"u": uid})
            await s.commit()
        assert (await _send(c, h, "И про машину?")).status_code == 200
        await app.state.ctx.chat.drain()


async def test_message_limit_per_day_and_taps_are_free(env):  # noqa: F811
    app = env.make_app(router_with(env.maker, Script()),
                       chat_rate_per_minute={"regular": 100}, chat_rate_per_day={"regular": 2})
    async with client(app) as c:
        h = await signed_in(c)
        uid = await _uid(c, env.maker, h)
        assert (await _send(c, h, "Что я записывал про врача?")).status_code == 200
        await app.state.ctx.chat.drain()
        async with env.maker() as s:  # yesterday's phrases do not count
            await s.execute(text("UPDATE conversation_messages SET created_at = now() - "
                                 "interval '2 days' WHERE user_id = :u"), {"u": uid})
            reply = await s.scalar(text("SELECT public_id FROM conversation_messages WHERE "
                                        "user_id = :u AND role = 'assistant' LIMIT 1"),
                                   {"u": uid})  # fmt: skip
            await s.commit()
        assert (await _send(c, h, "А про плитку?")).status_code == 200
        assert (await _send(c, h, "А про дачу?")).status_code == 200
        r = await _send(c, h, "А про машину?")
        assert r.status_code == 429 and r.json()["code"] == "chat_daily_limit"
        assert r.json()["retry_after"] <= 24 * 3600
        assert "завтра" in r.json()["message_ru"]
        # a tap on a proposal is not a phrase: not refused (even if that proposal is stale)
        r = await _send(c, h, "Отмена", choice={"reply_id": str(reply), "option": "cancel"})
        assert r.status_code == 200, r.text
        await app.state.ctx.chat.drain()
