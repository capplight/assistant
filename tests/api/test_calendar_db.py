"""The calendar (Ф-89 direction A, migration 0035, docs/api/calendar.md) against Postgres: to-dos
with a time and a length, all-day ones, repeats with one occurrence moved / done / skipped,
«это и следующие», the linked reminder moving with its to-do, every change undone by its action,
sync of occurrences, and the assistant line making a timed to-do. Providers are fakes. Skipped
without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from tests.api.conftest import client
from tests.api.test_week9_db import Script9, env9, router9, say  # noqa: F401  (env9: fixture)
from tests.chat.test_chat_db import signed_in
from tests.chat.test_week6_db import last

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

TZ = ZoneInfo("Asia/Almaty")


def local_day(k: int):  # type: ignore[no-untyped-def]
    return datetime.now(UTC).astimezone(TZ).date() + timedelta(days=k)


def at(k: int, hh: int, mm: int = 0) -> datetime:
    return datetime.combine(local_day(k), time(hh, mm), TZ)


async def make(c, h, title: str, **kw):  # type: ignore[no-untyped-def]
    body = {"client_id": str(uuid.uuid4()), "list_key": "todo", "title": title}
    for k, v in kw.items():
        body[k] = v.isoformat() if isinstance(v, datetime) else v
    r = await c.post("/v1/tasks", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def cal(c, h, k0: int, k1: int) -> list[dict]:  # type: ignore[no-untyped-def]
    r = await c.get("/v1/calendar", params={"from": local_day(k0).isoformat(),
                                            "to": local_day(k1).isoformat()}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["entries"]


async def undo(c, h, action: dict) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post(f"/v1/actions/{action['id']}/undo", json={}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def test_timed_and_all_day_todos_move_resize_and_undo(env9):  # noqa: F811
    app = env9.make_app(router9(env9.maker, Script9()))
    async with client(app) as c:
        h = await signed_in(c)
        meet = await make(c, h, "Встреча с Ерланом", start_at=at(1, 15), duration_min=60)
        task = meet["task"]
        assert task["start_at"] and task["duration_min"] == 60 and task["all_day"] is False
        assert task["local"] == {"date": local_day(1).isoformat(), "start": "15:00",
                                 "end": "16:00"}
        assert task["due_date"] == local_day(1).isoformat() and task["source"] == "user"
        await make(c, h, "Оплатить свет", due_date=local_day(1).isoformat())
        # its alert: a reminder on the task's record, 15 min before
        r = await c.post("/v1/reminders", json={
            "client_id": str(uuid.uuid4()), "title": "Встреча с Ерланом",
            "due_at": (at(1, 15) - timedelta(minutes=15)).isoformat(), "tz": "Asia/Almaty",
            "offsets": [], "level": "notification", "created_via": "typed",
            "parse_source": "rules", "item_id": task["item_id"]}, headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        rem = r.json()["reminder"]

        entries = await cal(c, h, 1, 1)
        assert [(e["title"], e["all_day"], e["start"], e["end"]) for e in entries] == [
            ("Оплатить свет", True, None, None), ("Встреча с Ерланом", False, "15:00", "16:00")]
        block = entries[1]
        assert block["reminder"]["id"] == rem["id"]  # the alert is not its own entry
        assert block["kind"] == "task" and block["occurrence_at"] is None

        # move to 16:00 and make it 90 min: one action; the reminder moves too
        r = await c.patch(f"/v1/tasks/{task['id']}", json={
            "version": task["version"], "client_id": str(uuid.uuid4()),
            "start_at": at(1, 16).isoformat(), "duration_min": 90}, headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        moved = r.json()
        assert moved["task"]["local"]["start"] == "16:00" and moved["task"]["duration_min"] == 90
        assert moved["action"]["summary"]["ru"] == "Перенёс: встреча с Ерланом — 15:00 → 16:00"
        got = (await c.get(f"/v1/reminders/{rem['id']}", headers=h)).json()["reminder"]
        assert datetime.fromisoformat(got["due_at"]) == at(1, 15, 45)
        stale = await c.patch(f"/v1/tasks/{task['id']}", json={
            "version": task["version"], "start_at": at(1, 17).isoformat()}, headers=h)
        assert stale.status_code == 409

        # «Вернуть»: the time and the reminder come back
        await undo(c, h, moved["action"])
        e = [x for x in await cal(c, h, 1, 1) if not x["all_day"]][0]
        assert (e["start"], e["end"]) == ("15:00", "16:00")
        got = (await c.get(f"/v1/reminders/{rem['id']}", headers=h)).json()["reminder"]
        assert datetime.fromisoformat(got["due_at"]) == at(1, 14, 45)

        # all day: start_at null; the reminder is cancelled with the task's delete
        cur = (await c.get("/v1/tasks", headers=h)).json()["tasks"]
        meet_now = next(t for t in cur if t["id"] == task["id"])
        r = await c.patch(f"/v1/tasks/{task['id']}", json={"version": meet_now["version"],
                                                          "start_at": None}, headers=h)
        assert r.json()["task"]["all_day"] is True and r.json()["task"]["start_at"] is None
        d = await c.delete(f"/v1/tasks/{task['id']}", headers=h)
        assert d.status_code == 200
        got = (await c.get(f"/v1/reminders/{rem['id']}", headers=h)).json()["reminder"]
        assert got["deleted_at"] is not None
        await undo(c, h, d.json()["action"])
        got = (await c.get(f"/v1/reminders/{rem['id']}", headers=h)).json()["reminder"]
        assert got["deleted_at"] is None

        bad = await c.get("/v1/calendar", params={"from": local_day(0).isoformat(),
                                                  "to": local_day(70).isoformat()}, headers=h)
        assert bad.status_code == 400 and bad.json()["code"] == "range_invalid"
        no_start = await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()),
                                                   "list_key": "todo", "title": "x",
                                                   "rrule": "FREQ=DAILY"}, headers=h)
        assert no_start.status_code == 422


async def test_a_repeat_with_one_occurrence_moved_done_skipped_and_following(env9):  # noqa: F811
    app = env9.make_app(router9(env9.maker, Script9()))
    async with client(app) as c:
        h = await signed_in(c)
        run = (await make(c, h, "Пробежка", start_at=at(1, 7), duration_min=30,
                          rrule="FREQ=DAILY"))["task"]  # fmt: skip
        entries = await cal(c, h, 1, 4)
        assert [(e["date"], e["start"]) for e in entries] == [
            (local_day(k).isoformat(), "7:00") for k in range(1, 5)]
        assert all(e["rrule"] == "FREQ=DAILY" and e["occurrence_at"] for e in entries)
        second, third, fourth = entries[1], entries[2], entries[3]
        url = f"/v1/tasks/{run['id']}"

        # done one occurrence only; a repeat without occurrence_at cannot be done
        r = await c.post(f"{url}/done", json={"client_id": str(uuid.uuid4()), "done": True,
                                              "occurrence_at": second["occurrence_at"]},
                         headers=h)  # fmt: skip
        assert r.status_code == 200 and r.json()["occurrence"]["done_at"]
        bad = await c.post(f"{url}/done", json={"client_id": str(uuid.uuid4())}, headers=h)
        assert bad.status_code == 422
        # move only the third to 8:00
        r = await c.patch(url, json={"version": run["version"],
                                     "occurrence_at": third["occurrence_at"],
                                     "start_at": at(3, 8).isoformat()}, headers=h)
        assert r.status_code == 200, r.text
        moved_action = r.json()["action"]
        assert r.json()["occurrence"]["start_at"]
        wrong = await c.patch(url, json={"version": run["version"],
                                         "occurrence_at": at(3, 9).isoformat(),
                                         "start_at": at(3, 10).isoformat()}, headers=h)
        assert wrong.status_code == 422  # not an occurrence of this series
        # skip the fourth
        r = await c.delete(url, params={"occurrence_at": fourth["occurrence_at"],
                                        "scope": "this"}, headers=h)
        assert r.status_code == 200 and r.json()["occurrence"]["skipped"] is True
        skip_action = r.json()["action"]

        entries = await cal(c, h, 1, 4)
        assert [(e["date"], e["start"], e["done"], e["moved"]) for e in entries] == [
            (local_day(1).isoformat(), "7:00", False, False),
            (local_day(2).isoformat(), "7:00", True, False),
            (local_day(3).isoformat(), "8:00", False, True)]
        sync = (await c.get("/v1/sync?since=0&limit=500", headers=h)).json()
        assert len([o for o in sync["task_occurrences"] if o["task_id"] == run["id"]]) == 3

        # undo the skip and the move: back as it was
        await undo(c, h, skip_action)
        await undo(c, h, moved_action)
        entries = await cal(c, h, 1, 4)
        assert [e["start"] for e in entries] == ["7:00"] * 4

        # «это и следующие» from the third: the series ends, a new one starts at 6:30
        cur = next(t for t in (await c.get("/v1/tasks", headers=h)).json()["tasks"]
                   if t["id"] == run["id"])
        r = await c.patch(url, json={"version": cur["version"], "scope": "following",
                                     "occurrence_at": third["occurrence_at"],
                                     "start_at": at(3, 6, 30).isoformat()}, headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["previous_task"]["rrule"].startswith("FREQ=DAILY;UNTIL=")
        assert out["task"]["id"] != run["id"] and out["task"]["rrule"] == "FREQ=DAILY"
        entries = await cal(c, h, 1, 4)
        assert [e["start"] for e in entries] == ["7:00", "7:00", "6:30", "6:30"]
        await undo(c, h, out["action"])
        entries = await cal(c, h, 1, 4)
        assert [e["start"] for e in entries] == ["7:00"] * 4 and {e["id"] for e in entries} == {
            run["id"]}


async def test_reminders_and_their_length_on_the_grid(env9):  # noqa: F811
    app = env9.make_app(router9(env9.maker, Script9()))
    async with client(app) as c:
        h = await signed_in(c)
        r = await c.post("/v1/reminders", json={
            "client_id": str(uuid.uuid4()), "title": "Таблетка", "due_at": at(1, 18).isoformat(),
            "tz": "Asia/Almaty", "rrule": "FREQ=DAILY", "offsets": [], "level": "notification",
            "created_via": "typed", "parse_source": "rules", "duration_min": 15}, headers=h)
        assert r.status_code == 201, r.text
        rem = r.json()["reminder"]
        assert rem["duration_min"] == 15
        entries = await cal(c, h, 1, 2)
        assert [(e["kind"], e["start"], e["end"]) for e in entries] == [
            ("reminder", "18:00", "18:15"), ("reminder", "18:00", "18:15")]
        p = await c.patch(f"/v1/reminders/{rem['id']}", json={"version": rem["version"],
                                                              "duration_min": 30}, headers=h)
        assert p.status_code == 200 and p.json()["reminder"]["duration_min"] == 30
        await undo(c, h, p.json()["action"])
        got = (await c.get(f"/v1/reminders/{rem['id']}", headers=h)).json()["reminder"]
        assert got["duration_min"] == 15


async def test_the_line_makes_a_timed_todo_and_asks_an_unclear_hour(env9):  # noqa: F811
    script = Script9()
    app = env9.make_app(router9(env9.maker, script), tasks_rules_first=True)
    async with client(app) as c:
        h = await signed_in(c)
        evs = await say(c, h, "добавь встречу завтра в 15:00 на час")
        action = last(evs, "action")
        [task] = action["tasks"]
        assert task["title"] == "Встреча" and task["duration_min"] == 60
        assert task["local"] == {"date": local_day(1).isoformat(), "start": "15:00",
                                 "end": "16:00"}
        assert task["source"] == "assistant"
        assert action["action"]["summary"]["ru"] == ("Записал в Дела: завтра в 15:00–16:00 — "
                                                    "«Встреча».")  # fmt: skip
        assert action["action"]["changes"][0]["start_at"]
        entries = await cal(c, h, 1, 1)
        assert [(e["title"], e["start"], e["source"]) for e in entries] == [
            ("Встреча", "15:00", "assistant")]
        await undo(c, h, action["action"])
        assert await cal(c, h, 1, 1) == []

        evs = await say(c, h, "поставь тренировку каждый вторник в 19:00")
        [task] = last(evs, "action")["tasks"]
        assert task["rrule"] == "FREQ=WEEKLY;BYDAY=TU" and task["local"]["start"] == "19:00"

        evs = await say(c, h, "добавь стоматолог послезавтра в 9")
        ask = last(evs, "needs_choice")
        assert [o["label"] for o in ask["options"][:2]] == ["Послезавтра в 9:00",
                                                            "Послезавтра в 21:00"]
        assert ask["question"] == "«Стоматолог» — в 9:00 или в 21:00?"
        assert "action" not in [n for _, n, _ in evs]  # nothing is made before the tap
        evs = await say(c, h, ask["options"][0]["label"],
                        choice={"reply_id": ask["reply_id"], "option": "t1"})
        [task] = last(evs, "action")["tasks"]
        assert task["title"] == "Стоматолог" and task["local"]["start"] == "9:00"
        assert task["local"]["date"] == local_day(2).isoformat() and task["duration_min"] == 60
        assert "ChatReply" not in script.calls  # all by code
