"""Ф-97: an edit of the open КП from the assistant line («убери доставку») runs the same KP_EDIT
reading, code checks and `kp.edit` operation as «Попросить изменить» on the КП screen: one new
version, one `edit_kp` action with «Отменить»; a number the person did not say is refused.
Providers and the PDF renderer are fakes. Skipped without DATABASE_URL."""

import os

import pytest

from assistant.kp.edit import KpEditReply
from tests.api.conftest import client
from tests.chat.test_chat_db import signed_in
from tests.chat.test_week6_db import last, say
from tests.kp.test_kp_db import get_doc, make_app, undo
from tests.kp.test_kp_w15_db import W15Script, op, ready_kp

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def test_line_edits_the_open_kp_with_undo(env9):
    script = W15Script()
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        doc_id = await ready_kp(c, h, env9, app, script)
        item_id = (await get_doc(c, h, doc_id))["document"]["item_id"]
        script.edit = KpEditReply(understood=True, ops=[op("remove", "/items/i2")])
        evs = await say(c, h, "убери доставку", selected_item_id=item_id)
        action = last(evs, "action")["action"]
        assert action["kind"] == "edit_kp" and action["initiated_by"] == "agent"
        cur = await get_doc(c, h, doc_id)
        assert [i["id"] for i in cur["version"]["items"]] == ["i1"]
        assert cur["version"]["request_text"] == "убери доставку"
        await undo(c, h, action["id"])
        cur = await get_doc(c, h, doc_id)
        assert [i["id"] for i in cur["version"]["items"]] == ["i1", "i2"]

        # a price the person did not say: refused, nothing changes
        n = cur["version"]["n"]
        script.edit = KpEditReply(understood=True, ops=[
            op("replace", "/items/i1/unit_price", "495")])
        evs = await say(c, h, "подними цену кабеля на 10%", selected_item_id=item_id)
        assert "action" not in [x for _, x, _ in evs]
        assert (await get_doc(c, h, doc_id))["version"]["n"] == n
