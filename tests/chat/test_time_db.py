"""Ф-89 against Postgres: an unclear reminder time is a short question with choices in the line
(the proposal mechanism of «Какую?»); a tap gives the S13 draft of that moment and nothing is
saved; «сейчас» in the context comes from the person's reminders and «Дела». Providers are
fakes. Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from assistant.chat import now as now_mod
from tests.api.conftest import client
from tests.api.test_week9_db import Script9, env9, router9, say  # noqa: F401  (env9: fixture)
from tests.chat.test_chat_db import signed_in
from tests.chat.test_week6_db import last

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

TZ = ZoneInfo("Asia/Almaty")


async def test_unclear_hour_is_a_question_with_choices_then_the_draft(env9):  # noqa: F811
    app = env9.make_app(router9(env9.maker, Script9()), reminders_rules_first=True)
    day = datetime.now(UTC).astimezone(TZ).date() + timedelta(days=2)
    async with client(app) as c:
        h = await signed_in(c)
        evs = await say(c, h, "Напомни послезавтра в 9 к стоматологу")
        d = last(evs, "reminder_draft")  # S13 still gets both options
        assert d["status"] == "ambiguous" and len(d["options"]) == 2
        ask = last(evs, "needs_choice")
        assert ask["kind"] == "choice" and ask["question"] == "В 9 утра или в 9 вечера?"
        assert [o["kind"] for o in ask["options"]] == ["time", "time", "cancel"]
        assert [o["label"] for o in ask["options"][:2]] == ["Послезавтра в 9:00",
                                                            "Послезавтра в 21:00"]
        assert last(evs, "done")["answer_kind"] == "choice"

        evs = await say(c, h, ask["options"][1]["label"],
                        choice={"reply_id": ask["reply_id"], "option": "t2"})
        d = last(evs, "reminder_draft")
        assert d["status"] == "ok" and d["draft"]["local"] == {"date": day.isoformat(),
                                                               "time": "21:00"}
        assert d["draft"]["title"] == "К стоматологу"
        assert last(evs, "banner")["text"].startswith("Понял так:")
        assert (await c.get("/v1/reminders", headers=h)).json()["reminders"] == []
        # a second tap on the same question is stale
        evs = await say(c, h, "x", choice={"reply_id": ask["reply_id"], "option": "t1"})
        assert "reminder_draft" not in [n for _, n, _ in evs]


async def test_now_block_reads_todays_reminders_and_tasks(env9):  # noqa: F811
    app = env9.make_app(router9(env9.maker, Script9()))
    now = datetime.now(UTC).replace(microsecond=0)
    async with client(app) as c:
        h = await signed_in(c)
        soon = now + timedelta(minutes=50)
        body = {"client_id": str(uuid.uuid4()), "title": "Встреча с Ерланом",
                "due_at": soon.isoformat(), "tz": "Asia/Almaty", "rrule": None, "offsets": [],
                "level": "notification", "created_via": "typed", "parse_source": "rules"}
        r = await c.post("/v1/reminders", json=body, headers=h)
        assert r.status_code == 201, r.text
        today = now.astimezone(TZ).date()
        r = await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()), "list_key": "todo",
                                            "title": "Оплатить свет",
                                            "due_date": today.isoformat()}, headers=h)
        assert r.status_code == 201, r.text
    async with env9.maker() as s:
        uid = await s.scalar(text("SELECT user_id FROM reminders ORDER BY id DESC LIMIT 1"))
        view = await now_mod.load(s, uid, now, "Asia/Almaty")
        await s.rollback()
    assert view.next is not None and view.next.title == "Встреча с Ерланом"
    assert view.minutes_to_next in (49, 50)
    assert view.tasks_today == ["Оплатить свет"]
    line, data, _ = now_mod.lines(view)
    assert "Следующее по времени" in line and data is not None and "Оплатить свет" in data
