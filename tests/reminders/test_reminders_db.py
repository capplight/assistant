"""Week 8 end to end against Postgres through HTTP: reminders, fires, phone events, the backup push
at +3 min, `missed` at +30 min, snooze, «Сделано» for the occurrence, the last active phone, quiet
hours, `kind=test`, edits and deletes, repeating top-up, /v1/sync, Ф-1 on/off on /parse, and the
Telegram bot's sender leaving app reminders alone.

Push is a FakePushSender, the model a FakeAdapter. No network. Skipped without DATABASE_URL.
"""

import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from assistant.ai import FakeAdapter
from assistant.api.app import create_app
from assistant.api.sms import FakeSmsSender
from assistant.chat.push import FakePushSender
from assistant.db.models import Reminder
from assistant.db.models_reminders import ReminderEvent, ReminderFire
from assistant.notify import FakeNotifier
from assistant.reminders import ReminderParseOut, worker
from assistant.scheduler import send_due
from tests.api.conftest import client, make_settings, make_storage
from tests.chat.test_chat_db import BASE, fake_router, signed_in

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
TZ = "Asia/Almaty"


class Env:
    def __init__(self, maker: Any, tmp: Path) -> None:
        self.maker = maker
        self.tmp = tmp
        self.apps: list[Any] = []

    def app(self, *, rules_first: bool = False, ai_router: Any = None) -> Any:
        app = create_app(
            make_settings(reminders_rules_first=rules_first),
            sessionmaker=self.maker,
            sms=FakeSmsSender(),
            storage=make_storage(self.tmp),
            ai_router=ai_router,
        )
        self.apps.append(app)
        return app


@pytest.fixture
async def env(tmp_path: Path):  # type: ignore[no-untyped-def]
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        maker = async_sessionmaker(
            bind=conn, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        e = Env(maker, tmp_path)
        try:
            yield e
        finally:
            for app in e.apps:
                await app.state.ctx.chat.drain()
            await trans.rollback()
    await engine.dispose()


# --- helpers ---


def now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value)


async def device(c, h, token: str | None = "tok-a") -> str:  # type: ignore[no-untyped-def]
    body = {"client_id": str(uuid.uuid4()), "platform": "android", "push_provider": "fcm",
            "push_token": token}  # fmt: skip
    r = await c.post("/v1/devices", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def user_pk(c, h, maker) -> int:  # type: ignore[no-untyped-def]
    me = (await c.get("/v1/me", headers=h)).json()
    async with maker() as s:
        return await s.scalar(
            text("SELECT id FROM users WHERE public_id = :p"), {"p": uuid.UUID(me["id"])}
        )


async def remind(c, h, due: datetime, title: str = "Позвонить Ерлану", **kw) -> dict:  # type: ignore[no-untyped-def]  # noqa: E501
    body = {"client_id": str(uuid.uuid4()), "title": title, "due_at": due.isoformat(), "tz": TZ,
            "created_via": "typed", "parse_source": "rules", **kw}  # fmt: skip
    r = await c.post("/v1/reminders", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def send(c, h, *evs: dict) -> dict:  # type: ignore[no-untyped-def]
    body = {"events": [{"client_id": str(uuid.uuid4()), "meta": {}, **e} for e in evs]}
    r = await c.post("/v1/reminders/events", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def main_fire(created: dict) -> dict:
    return next(f for f in created["fires"] if f["offset_min"] == 0)


async def fire_state(maker, fire_id: str) -> str:  # type: ignore[no-untyped-def]
    async with maker() as s:
        return await s.scalar(
            select(ReminderFire.state).where(ReminderFire.public_id == uuid.UUID(fire_id))
        )


# --- create, sync, idempotency ---


async def test_create_plans_fires_syncs_and_repeats_safely(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        dev = await device(c, h)
        due = now() + timedelta(hours=2)
        out = await remind(c, h, due, offsets=[60], level="alarm")
        rem, fires = out["reminder"], out["fires"]
        assert rem["status"] == "scheduled" and rem["kind"] == "normal" and rem["tz"] == TZ
        assert ts(rem["due_at"]) == due
        local = due.astimezone(ZoneInfo(TZ))
        assert rem["local"] == {"date": local.date().isoformat(), "time": local.strftime("%H:%M")}
        assert "Будильник · и за час" in rem["when_text"]
        assert sorted(f["offset_min"] for f in fires) == [0, 60]
        for f in fires:
            assert f["state"] == "planned" and f["target_device_id"] == dev
            assert ts(f["fire_at"]) == due - timedelta(minutes=f["offset_min"])
            assert ts(f["push_fallback_at"]) - ts(f["fire_at"]) == timedelta(minutes=3)
            assert ts(f["missed_at"]) - ts(f["fire_at"]) == timedelta(minutes=30)
            assert f["key"].startswith(rem["id"] + ":") and f["key"].endswith(":0")

        # same client_id from the outbox -> the same reminder, 200
        body = {"client_id": rem["client_id"], "title": "x", "due_at": due.isoformat(), "tz": TZ}
        again = await c.post("/v1/reminders", json=body, headers=h)
        assert again.status_code == 200 and again.json()["reminder"]["id"] == rem["id"]

        # the manual form sends the local clock
        lt = (now() + timedelta(days=2)).astimezone(ZoneInfo(TZ))
        r = await c.post("/v1/reminders", headers=h, json={
            "client_id": str(uuid.uuid4()), "title": "Врач", "created_via": "manual_form",
            "local": {"date": lt.date().isoformat(), "time": "09:00"}})  # fmt: skip
        assert r.status_code == 201, r.text
        got = ts(r.json()["reminder"]["due_at"]).astimezone(ZoneInfo(TZ))
        assert (got.date(), got.hour, got.minute) == (lt.date(), 9, 0)

        sync = (await c.get("/v1/sync", headers=h)).json()
        assert {x["id"] for x in sync["reminders"]} >= {rem["id"]}
        assert {f["id"] for f in fires} <= {f["id"] for f in sync["reminder_fires"]}
        since = sync["next_since"]
        assert (await c.get(f"/v1/sync?since={since}", headers=h)).json()["reminder_fires"] == []


async def test_bad_input(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        r = await c.post("/v1/reminders", headers=h, json={
            "client_id": str(uuid.uuid4()), "title": "x", "tz": TZ,
            "due_at": (now() - timedelta(minutes=1)).isoformat()})  # fmt: skip
        assert r.status_code == 422 and r.json()["code"] == "reminder_in_past"
        assert "ИИ" not in r.json()["message_ru"]
        for extra in ({"offsets": [30]}, {"rrule": "FREQ=HOURLY"}, {"tz": "Mars/Base"}):
            body = {"client_id": str(uuid.uuid4()), "title": "x", "tz": TZ,
                    "due_at": (now() + timedelta(hours=1)).isoformat(), **extra}  # fmt: skip
            r = await c.post("/v1/reminders", headers=h, json=body)
            assert r.status_code == 422, (extra, r.text)
        r = await c.post("/v1/auth/anonymous", json={"device_key": "k" * 40})
        h2 = {"Authorization": f"Bearer {r.json()['access_token']}"}  # no consents yet
        r = await c.get("/v1/reminders", headers=h2)
        assert r.status_code == 403 and r.json()["code"] == "consent_required"


# --- parse: Ф-1 off (default) vs on ---


async def test_parse_flag_off_needs_the_model_and_consent(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)  # «Без ИИ»
        r = await c.post("/v1/reminders/parse", json={"text": "завтра в 10:00 позвонить маме"},
                         headers=h)  # fmt: skip
        body = r.json()
        assert r.status_code == 200 and body["parser"] == "llm"
        assert (body["status"], body["reason"], body["draft"]) == ("form", "no_ai", None)
        assert body["message"] == "Укажите время вручную."

    tomorrow = (now().astimezone(ZoneInfo(TZ)) + timedelta(days=1)).date().isoformat()
    fake = FakeAdapter("anthropic", [ReminderParseOut(understood=True, title="позвонить маме",
                                                      date=tomorrow, time="10:00")])  # fmt: skip
    async with client(env.app(ai_router=fake_router(env.maker, fake))) as c:
        h = await signed_in(c)
        r = await c.post("/v1/reminders/parse", json={"text": "завтра в 10:00 позвонить маме"},
                         headers=h)  # fmt: skip
        body = r.json()
        assert fake.calls == 1
        assert (body["status"], body["source"], body["parser"]) == ("ok", "llm", "llm")
        assert body["draft"]["local"] == {"date": tomorrow, "time": "10:00"}
        assert body["draft"]["saved_text"] == "Напомню завтра в 10:00"
        # nothing is saved by parsing
        assert (await c.get("/v1/reminders", headers=h)).json()["reminders"] == []


async def test_parse_flag_on_reads_simple_phrases_without_the_model(env: Env) -> None:
    fake = FakeAdapter("anthropic", [ReminderParseOut(understood=False)])
    async with client(env.app(rules_first=True, ai_router=fake_router(env.maker, fake))) as c:
        h = await signed_in(c, BASE)  # «Без ИИ» still gets simple phrases
        r = await c.post("/v1/reminders/parse", headers=h,
                         json={"text": "через 2 часа позвонить Ерлану"})  # fmt: skip
        body = r.json()
        assert (body["status"], body["source"], body["parser"]) == ("ok", "rules", "rules_first")
        assert body["draft"]["title"] == "Позвонить Ерлану"
        assert abs(ts(body["draft"]["due_at"]) - (now() + timedelta(hours=2))) < timedelta(
            minutes=2
        )
        r = await c.post("/v1/reminders/parse", headers=h, json={"text": "завтра в 7 зарядка"})
        assert r.json()["status"] == "ambiguous" and len(r.json()["options"]) == 2
        r = await c.post("/v1/reminders/parse", headers=h, json={"text": "после обеда позвонить"})
        assert (r.json()["status"], r.json()["reason"]) == ("form", "no_ai")
        assert fake.calls == 0
        settings = (await c.get("/v1/reminders/settings", headers=h)).json()
        assert settings["parser"] == "rules_first"


# --- the alarm rule: backup push, missed, quiet hours ---


async def test_backup_push_only_without_fired_local_and_missed_at_30(env: Env) -> None:
    push = FakePushSender()
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        # quiet hours all day: reminder pushes still go out (R-13)
        r = await c.patch("/v1/reminders/settings", headers=h,
                          json={"quiet_from": "00:00", "quiet_to": "23:59"})  # fmt: skip
        assert r.status_code == 200 and r.json()["quiet_from"] == "00:00"
        due = now() + timedelta(minutes=5)
        rang, silent = await remind(c, h, due, "Таблетка"), await remind(c, h, due, "Свет")
        f_rang, f_silent = main_fire(rang), main_fire(silent)
        res = await send(c, h, {"fire_id": f_rang["id"], "event": "scheduled_local",
                                "at": now().isoformat(), "meta": {"scheduler": "alarm_clock"}},
                         {"fire_id": f_rang["id"], "event": "fired_local",
                          "at": now().isoformat()})  # fmt: skip
        assert [x["status"] for x in res["results"]] == ["applied", "applied"]
        assert [f["state"] for f in res["fires"]] == ["fired"]

        t3 = due + timedelta(minutes=3, seconds=1)
        assert (await worker.tick(env.maker, push, now=due + timedelta(minutes=2))).backup == 0
        out = await worker.tick(env.maker, push, now=t3)
        assert (out.backup, out.missed) == (1, 0)
        assert len(push.sent) == 1
        targets, title, data = push.sent[0]
        at = due.astimezone(ZoneInfo(TZ))
        assert title == (f"Напоминание на {at.hour}:{at.minute:02d} — откройте. "
                         "Если будильник уже звенел — всё в порядке")  # fmt: skip
        assert data["type"] == "reminder_backup" and data["fire_id"] == f_silent["id"]
        assert "text" not in data and [t.token for t in targets] == ["tok-a"]
        assert (await worker.tick(env.maker, push, now=t3 + timedelta(minutes=1))).backup == 0

        # «Сделано» on the one that rang; the other is never answered
        await send(c, h, {"fire_id": f_rang["id"], "event": "acked",
                          "at": now().isoformat()})  # fmt: skip
        out = await worker.tick(env.maker, push, now=due + timedelta(minutes=30, seconds=1))
        assert out.missed == 1 and len(push.sent) == 2
        assert push.sent[1][1] == f"Вы пропустили напоминание на {at.hour}:{at.minute:02d}"
        assert push.sent[1][2]["type"] == "reminder_missed"
        assert await fire_state(env.maker, f_rang["id"]) == "acked"
        assert await fire_state(env.maker, f_silent["id"]) == "missed"
        rems = {x["id"]: x for x in (await c.get("/v1/reminders?include_done=true",
                                                 headers=h)).json()["reminders"]}  # fmt: skip
        assert rems[rang["reminder"]["id"]]["status"] == "done"
        assert rems[silent["reminder"]["id"]]["status"] == "missed"
        async with env.maker() as s:
            kinds = list(await s.scalars(select(ReminderEvent.event).order_by(ReminderEvent.id)))
        assert kinds.count("push_sent") == 2 and "missed" in kinds
        assert (await worker.tick(env.maker, push, now=due + timedelta(hours=1))).missed == 0
        assert len(push.sent) == 2  # never a second push


async def test_push_text_only_with_push_content_and_never_for_health(env: Env) -> None:
    push = FakePushSender()
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        uid = await user_pk(c, h, env.maker)
        async with env.maker() as s:
            await s.execute(text(
                "INSERT INTO consents (public_id, user_id, kind, version, screen) "
                "VALUES (gen_random_uuid(), :u, 'push_content', 'push-test', 'settings')"),
                {"u": uid})  # fmt: skip
            await s.commit()
        assert (await c.get("/v1/reminders/settings", headers=h)).json()["push_content"] is True
        due = now() + timedelta(minutes=5)
        plain = await remind(c, h, due, "Оплатить свет")
        health = await remind(c, h, due, "Анализ крови", sensitivity="health")
        await worker.tick(env.maker, push, now=due + timedelta(minutes=4))
        by_fire = {d["fire_id"]: (title, d) for _, title, d in push.sent}
        assert by_fire[main_fire(plain)["id"]][1]["text"] == "Оплатить свет"
        assert "text" not in by_fire[main_fire(health)["id"]][1]
        await worker.tick(env.maker, push, now=due + timedelta(minutes=31))
        titles = [t for _, t, d in push.sent if d["type"] == "reminder_missed"]
        assert "Вы пропустили: Оплатить свет" in titles
        assert not any("Анализ" in t for t in titles)


async def test_failed_push_is_journaled_not_retried(env: Env) -> None:
    push = FakePushSender(fail=True)
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        due = now() + timedelta(minutes=5)
        f = main_fire(await remind(c, h, due))
        assert (await worker.tick(env.maker, push, now=due + timedelta(minutes=4))).backup == 1
        push.fail = False
        assert (await worker.tick(env.maker, push, now=due + timedelta(minutes=5))).backup == 0
        assert push.sent == []
        async with env.maker() as s:
            ev = await s.scalar(select(ReminderEvent).join(ReminderFire).where(
                ReminderFire.public_id == uuid.UUID(f["id"]),
                ReminderEvent.event == "push_failed"))  # fmt: skip
        assert ev is not None and "push service down" in ev.meta["error"]


# --- snooze, ack for the occurrence, fire keys ---


async def test_snooze_makes_a_new_fire_and_fire_key_events(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        due = now() + timedelta(minutes=10)
        created = await remind(c, h, due)
        f = main_fire(created)
        snooze_cid = str(uuid.uuid4())
        res = await send(c, h, {"client_id": snooze_cid, "fire_id": f["id"], "event": "snoozed",
                                "at": now().isoformat()})  # fmt: skip
        old, new = res["fires"][0], res["fires"][1]
        assert old["state"] == "snoozed" and new["snooze_n"] == 1 and new["state"] == "planned"
        assert abs(ts(new["fire_at"]) - (now() + timedelta(minutes=10))) < timedelta(seconds=5)
        assert new["key"] == f["key"][:-1] + "1"
        # the phone rang the snooze offline and reports it by key
        res = await send(c, h, {"fire_key": new["key"], "event": "fired_local",
                                "at": now().isoformat()})  # fmt: skip
        assert res["results"][0]["status"] == "applied" and res["fires"][0]["state"] == "fired"
        # retry of the same event, unknown fire, server-only event, far future
        res = await send(
            c, h,
            {"client_id": snooze_cid, "fire_id": f["id"], "event": "snoozed",
             "at": now().isoformat()},
            {"fire_id": str(uuid.uuid4()), "event": "fired_local", "at": now().isoformat()},
            {"fire_id": f["id"], "event": "push_sent", "at": now().isoformat()},
            {"fire_id": f["id"], "event": "shown",
             "at": (now() + timedelta(hours=1)).isoformat()},
        )  # fmt: skip
        assert [x["status"] for x in res["results"]] == ["duplicate", "not_found", "invalid",
                                                         "invalid"]  # fmt: skip
        rem = (await c.get(f"/v1/reminders/{created['reminder']['id']}", headers=h)).json()
        assert rem["reminder"]["status"] == "fired"  # the snooze fire rang


async def test_ack_on_early_alert_closes_the_occurrence(env: Env) -> None:
    push = FakePushSender()
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        due = now() + timedelta(minutes=40)
        created = await remind(c, h, due, offsets=[15])
        early = next(f for f in created["fires"] if f["offset_min"] == 15)
        res = await send(c, h, {"fire_id": early["id"], "event": "acked",
                                "at": now().isoformat()})  # fmt: skip
        assert sorted(f["state"] for f in res["fires"]) == ["acked", "acked"]
        out = await worker.tick(env.maker, push, now=due + timedelta(hours=1))
        assert (out.backup, out.missed, push.sent) == (0, 0, [])
        got = (await c.get(f"/v1/reminders/{created['reminder']['id']}", headers=h)).json()
        assert got["reminder"]["status"] == "done"


async def test_missed_early_alert_is_marked_without_a_push(env: Env) -> None:
    push = FakePushSender()
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        due = now() + timedelta(hours=2)
        created = await remind(c, h, due, offsets=[60])
        early = next(f for f in created["fires"] if f["offset_min"] == 60)
        await send(c, h, {"fire_id": early["id"], "event": "fired_local",
                          "at": ts(early["fire_at"]).isoformat()
                          if ts(early["fire_at"]) <= now() else now().isoformat()})  # fmt: skip
        out = await worker.tick(env.maker, push, now=ts(early["missed_at"]) + timedelta(seconds=1))
        assert out.missed == 1 and push.sent == []
        assert await fire_state(env.maker, early["id"]) == "missed"
        assert await fire_state(env.maker, main_fire(created)["id"]) == "planned"


# --- last active phone, policy «all» ---


async def test_last_active_phone_rings(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        dev_a = await device(c, h)
        uid = await user_pk(c, h, env.maker)
        async with env.maker() as s:  # another phone of the same person, used later
            dev_b = await s.scalar(text(
                "INSERT INTO devices (public_id, user_id, platform, push_provider, push_token, "
                "last_active_at, capabilities) "
                "VALUES (gen_random_uuid(), :u, 'ios', 'apns', 'tok-b', "
                "clock_timestamp(), '{}') RETURNING public_id"), {"u": uid})  # fmt: skip
            await s.commit()
        created = await remind(c, h, now() + timedelta(hours=3), level="alarm")
        assert {f["target_device_id"] for f in created["fires"]} == {str(dev_b)}

        r = await c.post("/v1/reminders/active", headers=h, json={})
        assert r.status_code == 200, r.text
        assert r.json() == {"device_id": dev_a, "retargeted": 1}
        sync = (await c.get("/v1/sync", headers=h)).json()
        assert {f["target_device_id"] for f in sync["reminder_fires"]} == {dev_a}
        win = (await c.get("/v1/reminders/fires", headers=h)).json()
        assert win["device_id"] == dev_a and len(win["fires"]) == 1
        assert win["reminders"][0]["id"] == created["reminder"]["id"]

        r = await c.patch("/v1/reminders/settings", headers=h,
                          json={"alarm_device_policy": "all"})  # fmt: skip
        assert r.json()["alarm_device_policy"] == "all"
        win = (await c.get("/v1/reminders/fires", headers=h)).json()
        assert win["fires"][0]["target_device_id"] is None


async def test_active_without_a_device(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        r = await c.post("/v1/reminders/active", headers=h, json={})
        assert r.status_code == 409 and r.json()["code"] == "device_unknown"


# --- test alarm ---


async def test_test_alarm_in_one_minute_on_this_phone(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        dev = await device(c, h)
        r = await c.post("/v1/reminders/test", headers=h, json={})
        assert r.status_code == 201, r.text
        rem, fires = r.json()["reminder"], r.json()["fires"]
        assert (rem["kind"], rem["level"], rem["title"]) == ("test", "alarm", "Проверка будильника")
        assert len(fires) == 1 and fires[0]["target_device_id"] == dev
        assert abs(ts(fires[0]["fire_at"]) - (now() + timedelta(minutes=1))) < timedelta(seconds=5)
        assert (await c.get("/v1/reminders", headers=h)).json()["reminders"] == []  # hidden


# --- edits, deletes ---


async def test_patch_replans_and_delete_cancels(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        created = await remind(c, h, now() + timedelta(hours=3), offsets=[60])
        rid, old = created["reminder"]["id"], {f["id"] for f in created["fires"]}
        r = await c.patch(f"/v1/reminders/{rid}", headers=h, json={"version": 1, "title": "Ерлан"})
        assert r.status_code == 200 and r.json()["fires"] == []
        assert r.json()["reminder"]["parse_source"] == "rules"
        new_due = now() + timedelta(hours=5)
        r = await c.patch(f"/v1/reminders/{rid}", headers=h,
                          json={"version": 2, "due_at": new_due.isoformat()})  # fmt: skip
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["reminder"]["version"] == 3 and body["reminder"]["parse_source"] == "user_edit"
        states = {f["id"]: f["state"] for f in body["fires"]}
        assert all(states[i] == "cancelled" for i in old)
        fresh = [f for f in body["fires"] if f["id"] not in old]
        assert sorted(ts(f["fire_at"]) for f in fresh) == [new_due - timedelta(hours=1), new_due]
        r = await c.patch(f"/v1/reminders/{rid}", headers=h, json={"version": 1, "title": "x"})
        assert r.status_code == 409 and r.json()["code"] == "conflict"

        assert (await c.delete(f"/v1/reminders/{rid}", headers=h)).status_code == 204
        got = (await c.get(f"/v1/reminders/{rid}", headers=h)).json()
        assert got["reminder"]["status"] == "cancelled" and got["reminder"]["deleted_at"]
        assert {f["state"] for f in got["fires"]} == {"cancelled"}
        assert (await c.get("/v1/reminders", headers=h)).json()["reminders"] == []
        assert (await c.get(f"/v1/reminders/{uuid.uuid4()}", headers=h)).status_code == 404


# --- repeating ---


async def test_repeating_reminder_expands_and_tops_up(env: Env) -> None:
    push = FakePushSender()
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        first = now() + timedelta(hours=1)
        created = await remind(c, h, first, "Витамины", rrule="FREQ=DAILY")
        assert created["reminder"]["when_text"].startswith("Каждый день · ")
        n = len(created["fires"])
        assert 14 <= n <= 15
        later = now() + timedelta(days=5)
        out = await worker.tick(env.maker, push, now=later)
        assert out.topped_up == 1
        async with env.maker() as s:
            last = await s.scalar(select(ReminderFire.fire_at).where(
                ReminderFire.reminder_id == select(Reminder.id).where(
                    Reminder.public_id == uuid.UUID(created["reminder"]["id"]))
                .scalar_subquery()).order_by(ReminderFire.fire_at.desc()).limit(1))  # fmt: skip
        assert last > later + timedelta(days=13)


# --- the Telegram bot's sender leaves app reminders alone ---


async def test_bot_sender_ignores_app_reminders(env: Env) -> None:
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        created = await remind(c, h, now() + timedelta(minutes=5))
        async with env.maker() as s:
            await s.execute(text("UPDATE reminders SET due_at = now() - interval '1 minute' "
                                 "WHERE public_id = :p"),
                            {"p": uuid.UUID(created["reminder"]["id"])})  # fmt: skip
            await s.commit()
        notifier = FakeNotifier()
        assert await send_due(None, notifier, sessionmaker=env.maker) == 0
        assert notifier.sent == []
        async with env.maker() as s:
            row = await s.scalar(select(Reminder).where(
                Reminder.public_id == uuid.UUID(created["reminder"]["id"])))  # fmt: skip
            assert row is not None and row.status == "scheduled" and row.attempts == 0


async def test_snooze_honours_the_time_the_phone_chose(env: Env) -> None:
    push = FakePushSender()
    async with client(env.app()) as c:
        h = await signed_in(c, BASE)
        await device(c, h)
        assert (await c.get("/v1/reminders/settings", headers=h)).json()["snooze_max_hours"] == 48
        due = now() + timedelta(minutes=10)
        f = main_fire(await remind(c, h, due))
        at = now()
        too_far = (at + timedelta(days=3)).isoformat()
        bad = await send(c, h, {"fire_id": f["id"], "event": "snoozed", "at": at.isoformat(),
                                "meta": {"until": too_far}})  # fmt: skip
        assert bad["results"][0]["status"] == "invalid" and bad["fires"] == []
        assert await fire_state(env.maker, f["id"]) == "planned"

        until = at + timedelta(minutes=60)  # «Другое время»: 60 min
        res = await send(c, h, {"fire_id": f["id"], "event": "snoozed", "at": at.isoformat(),
                                "meta": {"until": until.isoformat()}})  # fmt: skip
        assert res["results"][0]["status"] == "applied"
        new = next(x for x in res["fires"] if x["snooze_n"] == 1)
        assert ts(new["fire_at"]) == until
        assert ts(new["push_fallback_at"]) == until + timedelta(minutes=3)
        got = (await c.get("/v1/reminders?include_done=true", headers=h)).json()["reminders"][0]
        assert ts(got["snooze_until"]) == until

        # no backup push at the old +13 min, one at the chosen time + 3 min
        out = await worker.tick(env.maker, push, now=at + timedelta(minutes=13, seconds=1))
        assert out.backup == 0 and push.sent == []
        out = await worker.tick(env.maker, push, now=until + timedelta(minutes=3, seconds=1))
        assert out.backup == 1 and push.sent[0][2]["fire_id"] == new["id"]
