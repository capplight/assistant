"""Step 6: several actions from one phrase — one group, one notice, «Отменить всё», each action
still alone. Fakes only; skipped without DATABASE_URL."""

import os
import uuid

import pytest

from assistant.ai import AIUnavailable
from tests.api.conftest import client
from tests.chat.test_chat_db import _Stub, by_name, env, signed_in  # noqa: F401  (fixture)
from tests.chat.test_week6_db import last, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def test_spends_and_a_reminder_from_one_phrase(env):  # noqa: F811
    # the model is down: code reads every part (rules), nothing waits for it
    async with client(env.make_app(_Stub(AIUnavailable("down")))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "купил хлеб за 400 и молоко за 600, и напомни завтра в 9 утра "
                              "оплатить свет")  # fmt: skip
        actions = [a["action"] for a in by_name(evs, "action")]
        assert [a["kind"] for a in actions] == ["create_expense", "create_expense",
                                                "create_reminder"]  # Ф-95 (1): set at once
        assert by_name(evs, "reminder_draft") == []
        done = last(evs, "done")
        assert done["answer_kind"] == "action"
        group = done["group"]
        assert group["id"] == done["reply_id"] and group["size"] == 3
        assert group["action_ids"] == [a["id"] for a in actions] == done["action_ids"]
        assert group["notice"] == {"text_ru": "Сделал 3 дела", "text_kk": None, "target": None,
                                   "undo_label_ru": "Отменить всё", "undo_label_kk": None,
                                   "ms": 3000}  # fmt: skip
        spends = (await c.get("/v1/expenses", headers=h)).json()["expenses"]
        assert sorted(e["amount"] for e in spends) == ["400.00", "600.00"]
        msg = (await c.get(f"/v1/chat/messages/{done['reply_id']}", headers=h)).json()
        assert "Напомню" in msg["text"]

        # each action alone, in «История»…
        r = await c.post(f"/v1/actions/{actions[0]['id']}/undo", headers=h)
        assert r.status_code == 200
        # …and «Отменить всё»: the rest, newest first; the one already undone is not redone
        cid = str(uuid.uuid4())
        r = await c.post(f"/v1/actions/groups/{group['id']}/undo", json={"client_id": cid},
                         headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        body = r.json()
        assert [u["action"]["id"] for u in body["undone"]] == [actions[2]["id"], actions[1]["id"],
                                                               actions[0]["id"]]
        assert body["undone"][2]["repeated"] is True and body["failed"] == []
        assert (await c.get("/v1/reminders", headers=h)).json()["reminders"] == []
        assert (await c.get("/v1/expenses", headers=h)).json()["expenses"] == []
        again = await c.post(f"/v1/actions/groups/{group['id']}/undo", json={"client_id": cid},
                             headers=h)  # fmt: skip
        assert all(u["repeated"] for u in again.json()["undone"])
        listed = (await c.get(f"/v1/actions/{actions[1]['id']}", headers=h)).json()
        assert listed["group"]["notice"]["text_ru"] == "Отменено: 3 дела"
        assert listed["group"]["notice"]["undo_label_ru"] is None


async def test_code_does_its_parts_and_the_model_the_rest(env):  # noqa: F811
    async with client(env.make_app(_Stub(AIUnavailable("down")))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "купил хлеб за 400, и переложи заметку про ремонт в Дела")
        # the spend by code; the move needs the model, which is down: said honestly
        assert [a["action"]["kind"] for a in by_name(evs, "action")] == ["create_expense"]
        done = last(evs, "done")
        assert done["answer_kind"] == "action" and done["group"] is None
        msg = (await c.get(f"/v1/chat/messages/{done['reply_id']}", headers=h)).json()
        assert "Не успел: «переложи заметку про ремонт в Дела»" in msg["text"]


async def test_group_undo_of_unknown_phrase(env):  # noqa: F811
    async with client(env.make_app(_Stub(AIUnavailable("down")))) as c:
        h = await signed_in(c)
        r = await c.post(f"/v1/actions/groups/{uuid.uuid4()}/undo", headers=h)
        assert r.status_code == 404
