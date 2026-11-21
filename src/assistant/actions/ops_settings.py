"""Engine op of the person's own settings (Ф-97, chat-full-control.md phases 2–3):

- `set_user_setting` {values: {field: value}, expect?}: sets settings of the account that are
  safe to change from the line and come back with «Отменить» — the month's budget
  (`expense_budget`, `expense_budget_currency`), quiet hours (`quiet_from`, `quiet_to`, «HH:MM»)
  and the name to address the person by (`display_name`). Its reverse sets the old values back;
  `expect` = what this op left, so an undo after the person changed it on the screen skips it.

Account deletion, consents, logout, the phone number and anything irreversible are never here
(Ф-95 (4)): only their screens change them.
"""

from datetime import datetime, time
from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions.engine import Outcome
from assistant.db.models import User

USER_FIELDS = frozenset({"expense_budget", "expense_budget_currency", "quiet_from", "quiet_to",
                         "display_name"})  # fmt: skip


def user_value(u: User, name: str) -> Any:
    v = getattr(u, name)
    if isinstance(v, time):
        return v.strftime("%H:%M")
    if isinstance(v, Decimal):
        return f"{v:.2f}"
    return v


def _set(u: User, name: str, value: Any) -> None:
    if name in ("quiet_from", "quiet_to"):
        value = time.fromisoformat(str(value))
    elif name == "expense_budget" and value is not None:
        value = Decimal(str(value))
    elif name == "expense_budget_currency":
        value = value or "KZT"
    setattr(u, name, value)


async def _set_user_setting(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                            by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if not values or set(values) - USER_FIELDS:
        raise ValueError("set_user_setting: field not allowed")
    u = await session.get(User, user_id, with_for_update=True)
    if u is None:
        out.skipped += 1
        return
    expect = op.get("expect")
    if check and expect and any(user_value(u, k) != v for k, v in expect.items()):
        out.skipped += 1
        return
    back = {k: user_value(u, k) for k in values}
    for k, v in values.items():
        _set(u, k, v)
    await session.flush()
    left = {k: user_value(u, k) for k in values}
    if left == back:
        return
    out.inverse.append({"op": "set_user_setting", "values": back, "expect": left})


HANDLERS = {"set_user_setting": _set_user_setting}
