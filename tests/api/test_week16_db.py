"""Week 16 against a real Postgres: first launch (three paths, `POST /pages/batch`, ticks by code),
page proposals (R-55), «Сегодня» tiles (Ф-32), export, account deletion with its grace days, and
the web deletion page. No network: fake SMS, local storage, no model. Skipped without
DATABASE_URL."""

import io
import json
import os
import re
import secrets
import uuid
import zipfile
from datetime import date

import pytest
from sqlalchemy import text

from assistant.account.worker import run_one
from assistant.api.account_data import USER_TABLES
from tests.api.conftest import client
from tests.chat.test_chat_db import BASE, env, record, signed_in  # noqa: F401  (env: fixture)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
# Week 19 (Ф-42): tiles, proposals and tips after the first week are off for the beta; these
# tests check the R-35 / Ф-32 rules themselves, so they switch them back on.
R35 = {"feature_today_tiles": True, "feature_today_proposals": True, "today_tips_days": 0,
       "today_tips_per_day": 2}
PHONE = "+7 701 555 12 34"


async def _uid(maker, h_or_me) -> int:  # type: ignore[no-untyped-def]
    async with maker() as s:
        return int(await s.scalar(text("SELECT id FROM users WHERE public_id = :p"),
                                  {"p": uuid.UUID(h_or_me)}))  # fmt: skip


async def _me(c, h) -> dict:  # type: ignore[no-untyped-def]
    r = await c.get("/v1/me", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _sql(maker, sql: str, **params):  # type: ignore[no-untyped-def]
    async with maker() as s:
        res = await s.execute(text(sql), params)
        rows = res.all() if res.returns_rows else None
        await s.commit()
        return rows


async def _age(maker, uid: int, days: float) -> None:  # type: ignore[no-untyped-def]
    await _sql(maker, "UPDATE users SET created_at = now() - make_interval(secs => :s) "
                      "WHERE id = :u", s=days * 86400, u=uid)


def _titles(r) -> list[str]:  # type: ignore[no-untyped-def]
    return [p["template_key"] for p in r.json()["pages"]]


# --- first launch ---


async def test_onboarding_state_and_ticks_by_code(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c)
        r = await c.get("/v1/onboarding", headers=h)
        assert r.status_code == 200, r.text
        o = r.json()
        assert o["default_path"] == "phrase_first" and o["path"] is None
        assert o["paths_enabled"] == ["gallery", "blank", "phrase_first"]
        assert o["default_templates"] == ["notes", "tasks"] and o["max_marked"] == 3
        r = await c.patch("/v1/onboarding", json={"welcome_seen": True}, headers=h)
        first = r.json()["welcome_seen_at"]
        assert first
        r = await c.patch("/v1/onboarding", json={"welcome_seen": True}, headers=h)
        assert r.json()["welcome_seen_at"] == first
        r = await c.post("/v1/onboarding/suggested-pages",
                         json={"phrase": "Сделай КП для клиента и потратил 5000 тг"}, headers=h)
        assert r.json()["template_keys"] == ["notes", "tasks", "documents"]
        r = await c.post("/v1/onboarding/suggested-pages", json={"phrase": "Купить лекарства маме"},
                         headers=h)  # fmt: skip
        assert r.json()["template_keys"] == ["notes", "tasks", "shopping"]
        r = await c.post("/v1/onboarding/suggested-pages",
                         json={"phrase": "Напомни в пятницу оплатить свет",
                               "intro_marks": ["expenses", "bogus"]}, headers=h)  # fmt: skip
        assert r.json() == {"template_keys": ["notes", "tasks", "expenses"],
                            "reasons": {"notes": "default", "tasks": "default",
                                        "expenses": "intro"}}  # fmt: skip
        # before consent: only the consent endpoints
        r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
        h2 = {"Authorization": f"Bearer {r.json()['access_token']}"}
        assert (await c.get("/v1/onboarding", headers=h2)).status_code == 403


async def test_phrase_path_batch_is_one_action_with_undo(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c, BASE)
        await record(c, h, env.maker, "Потратил 5000 тенге на бензин")
        cid = str(uuid.uuid4())
        body = {"client_id": cid, "path": "phrase_first",
                "template_keys": ["notes", "tasks", "expenses"]}
        r = await c.post("/v1/pages/batch", json=body, headers=h)
        assert r.status_code == 201, r.text
        out = r.json()
        assert _titles(r) == ["notes", "tasks", "expenses"]
        assert {p["created_by"] for p in out["pages"]} == {"onboarding_phrase"}
        assert out["action"]["kind"] == "create_screen"
        assert out["action"]["summary"]["ru"] == "Добавил 3 страницы"
        assert out["onboarding"]["path"] == "phrase_first" and out["onboarding"]["done_at"]
        notes = out["pages"][0]["id"]
        items = (await c.get(f"/v1/pages/{notes}/items", headers=h)).json()["entries"]
        assert len(items) == 1  # the first phrase is already on a page
        # a repeat: same pages, no second action
        again = await c.post("/v1/pages/batch", json=body, headers=h)
        assert again.status_code == 200 and again.json()["repeated"] is True
        assert [p["id"] for p in again.json()["pages"]] == [p["id"] for p in out["pages"]]
        tabs = (await c.get("/v1/pages", headers=h)).json()["pages"]
        assert [p["template_key"] for p in tabs] == ["today", "notes", "tasks", "expenses"]
        # «Отменить»: all three go, «Сегодня» stays, the record stays
        u = await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        tabs = (await c.get("/v1/pages", headers=h)).json()["pages"]
        assert [p["template_key"] for p in tabs] == ["today"]
        assert len((await c.get("/v1/items", headers=h)).json()["items"]) == 1
        # onboarding stays done: the person is not sent back to S41
        assert (await c.get("/v1/onboarding", headers=h)).json()["path"] == "phrase_first"
        # choosing again brings the removed pages back (same ids)
        r = await c.post("/v1/pages/batch", json={**body, "client_id": str(uuid.uuid4()),
                                                   "path": "gallery"}, headers=h)  # fmt: skip
        assert r.status_code == 201 and {p["id"] for p in r.json()["pages"]} == \
            {p["id"] for p in out["pages"]}  # fmt: skip
        assert (await c.get("/v1/onboarding", headers=h)).json()["path"] == "phrase_first"


async def test_gallery_blank_skipped_catalog_and_errors(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c, BASE)
        r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                                   "path": "blank"}, headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        page = r.json()["pages"][0]
        assert (page["template_key"], page["title"], page["created_by"]) == \
            ("custom", "Моя страница", "onboarding_blank")  # fmt: skip
        assert r.json()["action"]["summary"]["ru"] == "Добавил страницу «Моя страница»"
        # later from «Мои страницы»: notes exists after this, then «Уже есть»
        r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                                   "path": "catalog",
                                                   "template_keys": ["notes", "custom"],
                                                   "title": "Дача"}, headers=h)  # fmt: skip
        assert r.status_code == 201 and [p["title"] for p in r.json()["pages"]] == \
            ["Заметки", "Дача"]  # fmt: skip
        assert {p["created_by"] for p in r.json()["pages"]} == {"user"}
        r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                                   "path": "skipped"}, headers=h)  # fmt: skip
        assert r.json()["existing"][0]["template_key"] == "notes"
        assert _titles(r) == ["tasks"] and r.json()["pages"][0]["created_by"] == \
            "onboarding_skipped"  # fmt: skip
        assert r.json()["onboarding"]["path"] == "blank"  # the first choice stays
        r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                                   "path": "gallery",
                                                   "template_keys": ["notes"]}, headers=h)
        assert r.status_code == 200 and r.json()["action"] is None and r.json()["pages"] == []
        for bad, code in ((["today"], "template_unknown"), ([], "validation_error"),
                          (["notes", "notes"], "validation_error")):  # fmt: skip
            r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                                       "path": "gallery",
                                                       "template_keys": bad}, headers=h)
            assert r.status_code == 422 and r.json()["code"] == code, (bad, r.text)
        # 20 pages at most, nothing created past it
        for i in range(15):
            await c.post("/v1/pages", json={"client_id": str(uuid.uuid4()),
                                            "template_key": "custom", "title": f"П{i}"},
                         headers=h)  # fmt: skip
        n = len((await c.get("/v1/pages", headers=h)).json()["pages"])
        assert n == 20
        r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                                   "path": "catalog",
                                                   "template_keys": ["shopping"]}, headers=h)
        assert r.status_code == 422 and r.json()["code"] == "pages_limit"


async def test_a_disabled_path_is_refused(env):  # noqa: F811
    app = env.make_app()
    app.state.ctx.settings.onboarding_paths_enabled = ["gallery", "phrase_first"]
    async with client(app) as c:
        h = await signed_in(c, BASE)
        assert (await c.get("/v1/onboarding", headers=h)).json()["paths_enabled"] == \
            ["gallery", "phrase_first"]  # fmt: skip
        r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                                   "path": "blank"}, headers=h)  # fmt: skip
        assert r.status_code == 422


# --- «Сегодня» tiles ---


async def _shop(c, h, *titles: str) -> None:  # type: ignore[no-untyped-def]
    for t in titles:
        r = await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()), "list_key":
                                            "shopping", "title": t}, headers=h)  # fmt: skip
        assert r.status_code == 201, r.text


async def test_today_tiles_by_rule_pin_and_hide(env):  # noqa: F811
    async with client(env.make_app(**R35)) as c:
        h = await signed_in(c, BASE)
        uid = await _uid(env.maker, (await _me(c, h))["id"])
        r = await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                                   "path": "gallery",
                                                   "template_keys": ["notes", "shopping",
                                                                     "expenses", "tasks"]},
                         headers=h)  # fmt: skip
        pages = {p["template_key"]: p["id"] for p in r.json()["pages"]}
        await _shop(c, h, "Хлеб", "Молоко")
        r = await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), "amount": "7500",
                                               "spent_on": date.today().isoformat()},
                         headers=h)  # fmt: skip
        assert r.status_code in (200, 201), r.text
        t = (await c.get("/v1/today", headers=h)).json()
        assert t["page_tiles"] == [] and "page_tiles" not in t["sections"]  # first 7 days
        # …but what the person pinned by hand shows from day one; hidden stays hidden
        r = await c.put(f"/v1/pages/{pages['notes']}/today-tile", json={"mode": "pinned"},
                        headers=h)  # fmt: skip
        await c.put(f"/v1/pages/{pages['shopping']}/today-tile", json={"mode": "hidden"},
                    headers=h)  # fmt: skip
        t = (await c.get("/v1/today", headers=h)).json()
        assert [(x["template_key"], x["pinned"]) for x in t["page_tiles"]] == [("notes", True)]
        assert "page_tiles" in t["sections"]
        await c.post(f"/v1/actions/{r.json()['action']['id']}/undo", headers=h)
        await c.put(f"/v1/pages/{pages['shopping']}/today-tile", json={"mode": "auto"},
                    headers=h)  # fmt: skip
        assert (await c.get("/v1/today", headers=h)).json()["page_tiles"] == []
        await _age(env.maker, uid, 8)
        t = (await c.get("/v1/today", headers=h)).json()
        tiles = [(x["template_key"], x["text_ru"], x["pinned"]) for x in t["page_tiles"]]
        assert tiles[0] == ("shopping", "Осталось 2", False)
        assert tiles[1][0] == "expenses" and tiles[1][1].startswith("Сегодня 7 500 ₸") \
            or tiles[1][1] == "Сегодня трат нет"  # local day vs UTC at midnight  # fmt: skip
        assert "page_tiles" in t["sections"]
        assert t["sections"].index("page_tiles") > t["sections"].index("today")
        # pin «Заметки» (nothing for today), hide «Покупки»
        r = await c.put(f"/v1/pages/{pages['notes']}/today-tile",
                        json={"mode": "pinned", "client_id": str(uuid.uuid4())}, headers=h)
        assert r.status_code == 200, r.text
        pin_action = r.json()["action"]
        assert pin_action["summary"]["ru"] == "Показываю «Заметки» на Сегодня"
        assert r.json()["view_state"]["today_tile"] == "pinned"
        r = await c.put(f"/v1/pages/{pages['shopping']}/today-tile", json={"mode": "hidden"},
                        headers=h)  # fmt: skip
        again = await c.put(f"/v1/pages/{pages['shopping']}/today-tile", json={"mode": "hidden"},
                            headers=h)  # fmt: skip
        assert again.json()["action"] is None
        t = (await c.get("/v1/today", headers=h)).json()
        assert [(x["template_key"], x["pinned"]) for x in t["page_tiles"]] == \
            [("notes", True), ("expenses", False)]  # fmt: skip
        assert t["page_tiles"][0]["text_ru"] == "Записей: 0"
        # «Отменить» the pin
        await c.post(f"/v1/actions/{pin_action['id']}/undo", headers=h)
        t = (await c.get("/v1/today", headers=h)).json()
        assert [x["template_key"] for x in t["page_tiles"]] == ["expenses"]
        today_id = (await c.get("/v1/pages", headers=h)).json()["pages"][0]["id"]
        r = await c.put(f"/v1/pages/{today_id}/today-tile", json={"mode": "pinned"}, headers=h)
        assert r.status_code == 403


# --- page proposals (R-55) ---


async def _stack(maker, uid: int, title: str, n: int) -> str:  # type: ignore[no-untyped-def]
    rows = await _sql(maker, "INSERT INTO collections (user_id, kind, key, title, icon, "
                             "created_by, rule, before_after, item_count) VALUES (:u, 'smart', "
                             ":k, :t, 'home', 'agent', '{}', '{}', :n) RETURNING public_id",
                      u=uid, k=title.lower(), t=title, n=n)  # fmt: skip
    return str(rows[0][0])


async def test_page_proposal_from_a_stack_needs_yes_and_is_weekly(env):  # noqa: F811
    async with client(env.make_app(**R35)) as c:
        h = await signed_in(c, BASE)
        uid = await _uid(env.maker, (await _me(c, h))["id"])
        await _stack(env.maker, uid, "Ремонт", 14)
        t = (await c.get("/v1/today", headers=h)).json()
        assert not [p for p in t["proposals"] if p["key"] == "page_from_stack"]  # < 10 min
        await _age(env.maker, uid, 1)
        t = (await c.get("/v1/today", headers=h)).json()
        props = [p for p in t["proposals"] if p["key"] == "page_from_stack"]
        assert len(props) == 1
        assert props[0]["text_ru"] == "Про «Ремонт» уже 14 записей. Сделать страницу «Ремонт»?"
        assert props[0]["yes_label"] == "Да, сделать" and props[0]["do"] == {"type": "accept"}
        # nothing made before «Да»
        tabs = (await c.get("/v1/pages", headers=h)).json()["pages"]
        assert "Ремонт" not in [p["title"] for p in tabs]
        # another big stack: not this week
        await _stack(env.maker, uid, "Дача", 20)
        t = (await c.get("/v1/today", headers=h)).json()
        assert [p["key"] for p in t["proposals"]].count("page_from_stack") == 1
        r = await c.post(f"/v1/suggestions/{props[0]['id']}/accept", json={}, headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["page"]["title"] == "Ремонт" and out["page"]["created_by"] == "agent"
        assert out["action"]["initiated_by"] == "agent"
        assert out["action"]["summary"]["ru"] == "Страница «Ремонт» добавлена"
        rep = await c.post(f"/v1/suggestions/{props[0]['id']}/accept", json={}, headers=h)
        assert rep.json()["page"]["id"] == out["page"]["id"]
        u = await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        tabs = (await c.get("/v1/pages", headers=h)).json()["pages"]
        assert "Ремонт" not in [p["title"] for p in tabs]
        # a week later the next topic may be offered, «Ремонт» never again
        await _sql(env.maker, "UPDATE suggestions SET created_at = created_at - interval '8 days'"
                              " WHERE user_id = :u", u=uid)  # fmt: skip
        t = (await c.get("/v1/today", headers=h)).json()
        keys = [(p["key"], p["text_ru"]) for p in t["proposals"]]
        assert ("page_from_stack", "Про «Дача» уже 20 записей. Сделать страницу «Дача»?") in keys


async def test_blank_path_tip_from_day_two(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c, BASE)
        uid = await _uid(env.maker, (await _me(c, h))["id"])
        await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()), "path": "blank"},
                     headers=h)  # fmt: skip
        await record(c, h, env.maker, "Плитка 24 м²")  # no «first_reminder» tip then
        t = (await c.get("/v1/today", headers=h)).json()
        assert not t["tip"] or t["tip"]["key"] != "add_ready_pages"
        await _age(env.maker, uid, 2)
        await _sql(env.maker, "DELETE FROM suggestions WHERE user_id = :u", u=uid)
        t = (await c.get("/v1/today", headers=h)).json()
        assert t["tip"]["key"] == "add_ready_pages"
        assert t["tip"]["do"] == {"type": "open_gallery"}


# --- account deletion ---


async def _phone_account(c):  # type: ignore[no-untyped-def]
    h = await signed_in(c, BASE)
    r = await c.post("/v1/auth/otp/request", json={"phone": PHONE}, headers=h)
    code = r.json()["dev_code"]
    r = await c.post("/v1/auth/otp/verify", json={"phone": PHONE, "challenge_id":
                                                  r.json()["challenge_id"], "code": code},
                     headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_anonymous_deletion_restore_and_purge(env):  # noqa: F811
    app = env.make_app()
    ctx = app.state.ctx
    async with client(app) as c:
        key = secrets.token_urlsafe(32)
        r = await c.post("/v1/auth/anonymous", json={"device_key": key})
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        st = (await c.get("/v1/me/deletion", headers=h)).json()
        assert st["needs_sms"] is False and st["grace_days"] == 7
        assert "7 дней можно передумать — откройте приложение." in st["points_ru"]
        assert (await c.post("/v1/me/deletion", json={}, headers=h)).status_code == 422
        r = await c.post("/v1/me/deletion", json={"confirm": True}, headers=h)
        assert r.status_code == 202, r.text
        assert r.json()["message_ru"].endswith("можно передумать: откройте приложение.")
        assert (await c.get("/v1/me/deletion", headers=h)).status_code in (401, 403)
        r = await c.post("/v1/auth/anonymous", json={"device_key": key})
        assert r.status_code == 403 and r.json()["code"] == "account_deletion_pending"
        token = r.json()["details"]["restore_token"]
        assert (await c.post("/v1/me/deletion/cancel",
                             json={"restore_token": "x" * 20})).status_code == 400
        r = await c.post("/v1/me/deletion/cancel", json={"restore_token": token})
        assert r.status_code == 200, r.text
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        assert (await c.get("/v1/me/deletion", headers=h)).json()["status"] == "active"
        jobs = await _sql(env.maker, "SELECT count(*) FROM jobs WHERE kind = 'account:purge'")
        assert jobs[0][0] == 0  # the purge left with the cancel
        # second request, then the purge after the grace days
        await c.post("/v1/me/deletion", json={"confirm": True}, headers=h)
    async with env.maker() as s:
        uid = await s.scalar(text("SELECT id FROM users WHERE status = 'deletion_pending' "
                                  "ORDER BY id DESC LIMIT 1"))
        await s.execute(text("UPDATE account_deletions SET cancel_until = now() - interval '1 m'"
                             " WHERE user_id = :u"), {"u": uid})
        await s.execute(text("UPDATE jobs SET run_after = now() WHERE kind = 'account:purge'"))
        await s.commit()
    assert await run_one(env.maker, ctx.storage, ctx.kp_cipher, ctx.settings)
    rows = await _sql(env.maker, "SELECT count(*) FROM users WHERE id = :u", u=uid)
    assert rows[0][0] == 0
    d = await _sql(env.maker, "SELECT user_id, executed_at, report FROM account_deletions "
                              "ORDER BY id DESC LIMIT 1")
    assert d[0][0] is None and d[0][1] is not None and "storage.objects" in d[0][2]
    # the device key now makes a brand-new account
    async with client(app) as c:
        r = await c.post("/v1/auth/anonymous", json={"device_key": key})
        assert r.status_code == 200 and r.json()["created"] is True


async def test_phone_deletion_needs_sms_and_purge_takes_everything(env):  # noqa: F811
    app = env.make_app()
    ctx = app.state.ctx
    ctx.settings.account_delete_grace_days = 0
    async with client(app) as c:
        h = await _phone_account(c)
        me = await _me(c, h)
        uid = await _uid(env.maker, me["id"])
        await record(c, h, env.maker, "Код домофона 4512")
        put = await c.post("/v1/uploads", json={"client_id": str(uuid.uuid4()),
                                                "mime": "image/jpeg", "bytes": 4,
                                                "sha256": "88d4266fd4e6338d13b845fcf289579d"
                                                          "209c897823b9217da3e161936f031589"},
                           headers=h)  # fmt: skip
        assert put.status_code in (200, 201), put.text
        r = await c.put(put.json()["put"]["url"].replace("http://test", ""), content=b"abcd",
                        headers={"Content-Type": "image/jpeg"})  # fmt: skip
        assert r.status_code == 200, r.text
        r = await c.post(f"/v1/uploads/{put.json()['id']}/complete", headers=h)
        assert r.status_code == 200, r.text
        await _sql(env.maker, "INSERT INTO provider_usage (user_id, task, budget_class, provider,"
                              " model, cost_usd, outcome, created_at) VALUES (:u, 'enrich', "
                              "'background', 'anthropic', 'm', 0.01, 'ok', now())", u=uid)
        st = (await c.get("/v1/me/deletion", headers=h)).json()
        assert st["needs_sms"] and "Удалю всё за сутки. Отменить будет нельзя." in st["points_ru"]
        assert (await c.post("/v1/me/deletion", json={"confirm": True},
                             headers=h)).status_code == 422
        r = await c.post("/v1/me/deletion/otp", json={"phone": "+7 701 000 00 00"}, headers=h)
        assert r.status_code == 422 and r.json()["code"] == "phone_mismatch"
        r = await c.post("/v1/me/deletion/otp", json={"phone": PHONE}, headers=h)
        assert r.status_code == 200, r.text
        ch = r.json()
        bad = await c.post("/v1/me/deletion", json={"challenge_id": ch["challenge_id"],
                                                    "code": "000000" if ch["dev_code"] !=
                                                    "000000" else "111111"}, headers=h)
        assert bad.status_code == 400
        r = await c.post("/v1/me/deletion", json={"challenge_id": ch["challenge_id"],
                                                  "code": ch["dev_code"]}, headers=h)
        assert r.status_code == 202, r.text
        assert r.json()["grace_days"] == 0
    assert await run_one(env.maker, ctx.storage, ctx.kp_cipher, ctx.settings)
    async with env.maker() as s:
        for table in USER_TABLES:
            cols = set(await s.scalars(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema || '.' || table_name = :t"), {"t": table}))
            if "user_id" in cols:
                n = await s.scalar(text(f"SELECT count(*) FROM {table} WHERE user_id = :u"),
                                   {"u": uid})  # fmt: skip
                assert n == 0, table
        kept = await s.scalar(text("SELECT count(*) FROM provider_usage WHERE user_id IS NULL "
                                   "AND task = 'enrich' AND cost_usd = 0.01"))
        assert kept >= 1  # the cost journal stays, without the person
    left = list((ctx.storage.root / "u").glob(f"{me['id']}*")) \
        if (ctx.storage.root / "u").exists() else []  # fmt: skip
    assert left == []


async def test_signing_in_by_phone_during_grace_offers_restore(env):  # noqa: F811
    app = env.make_app()
    async with client(app) as c:
        h = await _phone_account(c)
        r = await c.post("/v1/me/deletion/otp", json={"phone": PHONE}, headers=h)
        ch = r.json()
        await c.post("/v1/me/deletion", json={"challenge_id": ch["challenge_id"],
                                              "code": ch["dev_code"]}, headers=h)
        r = await c.post("/v1/auth/otp/request", json={"phone": PHONE})
        r = await c.post("/v1/auth/otp/verify", json={"phone": PHONE, "challenge_id":
                                                      r.json()["challenge_id"],
                                                      "code": r.json()["dev_code"]})  # fmt: skip
        assert r.status_code == 403 and r.json()["code"] == "account_deletion_pending"
        assert r.json()["details"]["delete_after"]
        r = await c.post("/v1/me/deletion/cancel",
                         json={"restore_token": r.json()["details"]["restore_token"]})
        assert r.status_code == 200 and r.json()["user"]["is_anonymous"] is False


# --- export ---


async def test_export_archive_has_everything_readable(env):  # noqa: F811
    app = env.make_app()
    ctx = app.state.ctx
    async with client(app) as c:
        h = await signed_in(c, BASE)
        await record(c, h, env.maker, "Код домофона 4512")
        await c.post("/v1/pages/batch", json={"client_id": str(uuid.uuid4()),
                                              "path": "phrase_first",
                                              "template_keys": ["notes", "expenses"]},
                     headers=h)  # fmt: skip
        await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), "amount": "4500",
                                           "spent_on": "2026-11-10", "note": "лекарства маме"},
                     headers=h)  # fmt: skip
        await _shop(c, h, "Хлеб")
        uid = await _uid(env.maker, (await _me(c, h))["id"])
        await _sql(env.maker, "INSERT INTO company_profiles (user_id, name, bin_iin_enc) "
                              "VALUES (:u, 'ТОО Алем', :b)", u=uid,
                   b=ctx.kp_cipher.seal(uid, "bin_iin", "123456789012"))  # fmt: skip
        r = await c.post("/v1/export", json={"client_id": str(uuid.uuid4())}, headers=h)
        assert r.status_code == 202, r.text
        e = r.json()["export"]
        assert e["status"] == "queued" and e["download_url"] is None
        again = await c.post("/v1/export", json={}, headers=h)
        assert again.status_code == 200 and again.json()["export"]["id"] == e["id"]
        assert await run_one(env.maker, ctx.storage, ctx.kp_cipher, ctx.settings)
        e = (await c.get(f"/v1/export/{e['id']}", headers=h)).json()["export"]
        assert e["status"] == "ready" and e["bytes"] > 0 and e["download_url"]
        path = e["download_url"].replace("http://test", "")
        r = await c.get(path)  # no bearer: the link is the permission
        assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
        assert 'filename="moi-dannye-' in r.headers["content-disposition"]
        z = zipfile.ZipFile(io.BytesIO(r.content))
        names = set(z.namelist())
        for f in ("README.txt", "account.json", "items.jsonl", "pages.json", "reminders.json",
                  "tasks.json", "expenses.csv", "company.json", "conversation.jsonl",
                  "drafts.json", "stacks.json", "habits.json"):
            assert f in names, f
        assert any(n.startswith("items/") and n.endswith(".md") for n in names)
        items = [json.loads(line) for line in z.read("items.jsonl").decode().splitlines()]
        assert any(i["text"] == "Код домофона 4512" for i in items)
        csv_text = z.read("expenses.csv").decode("utf-8-sig")
        assert "4500" in csv_text and "лекарства маме" in csv_text
        company = json.loads(z.read("company.json"))
        assert company["profile"]["bin_iin"] == "123456789012"
        pages = json.loads(z.read("pages.json"))["pages"]
        assert [p["template_key"] for p in pages][:3] == ["today", "notes", "expenses"]
        assert "Хлеб" in z.read("tasks.json").decode()
        # a wrong token, then expiry
        assert (await c.get(re.sub(r"token=[^&]+", "token=1.x", path))).status_code == 404
        await _sql(env.maker, "UPDATE data_exports SET expires_at = now() - interval '1 m'")
        assert (await c.get(path)).status_code in (404, 410)
        from assistant.account import expire_exports

        assert await expire_exports(env.maker, ctx.storage) == 1
        e = (await c.get(f"/v1/export/{e['id']}", headers=h)).json()["export"]
        assert e["status"] == "expired" and e["download_url"] is None


# --- web deletion page (W-01) ---


async def test_web_deletion_page(env):  # noqa: F811
    app = env.make_app()
    sms = app.state.ctx.sms
    async with client(app) as c:
        await _phone_account(c)
        r = await c.get("/account/delete")
        assert r.status_code == 200 and "text/html" in r.headers["content-type"]
        assert "Удалить аккаунт и все данные" in r.text and "<script" not in r.text
        assert "только в приложении" in r.text
        kk = await c.get("/account/delete?lang=kk")
        assert "Аккаунтты және барлық деректерді жою" in kk.text and 'lang="kk"' in kk.text
        form = {"Content-Type": "application/x-www-form-urlencoded"}
        # a number without an account: the same page, no SMS
        before = len(sms.sent)
        r = await c.post("/account/delete/otp", content="phone=%2B77010009999&lang=ru",
                         headers=form)  # fmt: skip
        assert r.status_code == 200 and "Если этот номер есть в приложении" in r.text
        assert len(sms.sent) == before
        # a bot filled the hidden field
        r = await c.post("/account/delete/otp", content="phone=%2B77015551234&website=x",
                         headers=form)  # fmt: skip
        assert r.status_code == 400
        r = await c.post("/account/delete/otp", content="phone=%2B77015551234&lang=ru",
                         headers=form)  # fmt: skip
        assert r.status_code == 200 and len(sms.sent) == before + 1
        challenge = re.search(r'name="challenge_id" value="([^"]+)"', r.text).group(1)
        code = sms.last_code_for("+77015551234")
        bad = await c.post("/account/delete/confirm",
                           content=f"phone=%2B77015551234&challenge_id={challenge}&code=1",
                           headers=form)  # fmt: skip
        assert bad.status_code == 400 and "Код не подошёл" in bad.text
        r = await c.post("/account/delete/confirm",
                         content=f"phone=%2B77015551234&challenge_id={challenge}&code={code}",
                         headers=form)  # fmt: skip
        assert r.status_code == 200 and "Запрос принят. Вход закрыт." in r.text
        assert "можно передумать" in r.text
    rows = await _sql(env.maker, "SELECT via FROM account_deletions ORDER BY id DESC LIMIT 1")
    assert rows[0][0] == "web"


async def test_web_page_limits_code_requests_per_ip(env):  # noqa: F811
    app = env.make_app()
    app.state.ctx.settings.web_delete_ip_per_hour = 2
    form = {"Content-Type": "application/x-www-form-urlencoded"}
    async with client(app) as c:
        codes = []
        for n in range(3):
            r = await c.post("/account/delete/otp", content=f"phone=%2B7701000000{n}",
                             headers=form)  # fmt: skip
            codes.append(r.status_code)
        assert codes == [200, 200, 429]
