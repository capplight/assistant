"""The operation registry (Ф-95, docs/spec/proposals/chat-full-control.md §3.1, phase 0).

One operation = one piece of business logic that a REST route **and** the assistant line call,
so a screen and the chat cannot do different things (the trash already had: the line put only
the record in the trash, the screen also the to-do and its reminder).

- `Operation`: `name` («tasks.delete»), `domain`, `risk` (`safe` | `bulk` | `irreversible`: the
  confirmation policy, decided by code), `args` (a strict pydantic model — a REST body or a model
  call), and either `build` (pure engine ops + the action's text; `run` applies and records them)
  or `execute` (an operation that writes in its own way, e.g. a plan onto the calendar).
- `build(name, …)` → `Built`: the ops without writing — the line folds them into its own action
  (one phrase = one action, `chat/mutate._commit`).
- `run(name, …)` → `OpResult`: applied with `engine.apply` and recorded as **one** action with
  its `inverse` (undo, «Что изменилось», Ф-73 marks as everywhere). The caller commits.
"""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine, record
from assistant.db.models_actions import Action

Risk = Literal["safe", "bulk", "irreversible"]


class OpError(ValueError):
    """The operation cannot run: `code` is the API error code («not_found», «validation_error»)."""

    def __init__(self, code: str, status: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass
class Built:
    """What an operation would do: engine ops and the text of its action."""

    ops: list[dict[str, Any]]
    kind: str
    sentence: str
    changes: list[dict[str, Any]] = field(default_factory=list)
    source_item_ids: list[int] = field(default_factory=list)
    touched: tuple[str, ...] = ()  # tasks, calendar, reminders, expenses, records, plans
    extra: dict[str, Any] = field(default_factory=dict)
    data: dict[str, Any] = field(default_factory=dict)  # objects the caller may answer with


@dataclass
class OpResult:
    action: Action | None = None
    actions: list[Action] = field(default_factory=list)
    inverse: list[dict[str, Any]] = field(default_factory=list)
    items: set[str] = field(default_factory=set)
    pages: set[int] = field(default_factory=set)
    sentence: str = ""
    touched: tuple[str, ...] = ()
    data: dict[str, Any] = field(default_factory=dict)


BuildFn = Callable[..., Awaitable[Built]]
ExecuteFn = Callable[..., Awaitable[OpResult]]


@dataclass(frozen=True)
class Operation:
    name: str
    domain: str
    risk: Risk
    args: type[BaseModel]
    build: BuildFn | None = None
    execute: ExecuteFn | None = None
    description: str = ""


REGISTRY: dict[str, Operation] = {}


def register(op: Operation) -> Operation:
    if op.name in REGISTRY:
        raise ValueError(f"operation {op.name} registered twice")
    if (op.build is None) == (op.execute is None):
        raise ValueError(f"operation {op.name}: give build or execute")
    REGISTRY[op.name] = op
    return op


def get(name: str) -> Operation:
    try:
        return REGISTRY[name]
    except KeyError:
        raise OpError("unknown_operation") from None


def names(domain: str | None = None) -> list[str]:
    return sorted(n for n, op in REGISTRY.items() if domain is None or op.domain == domain)


def _args(op: Operation, args: BaseModel | dict[str, Any]) -> BaseModel:
    if isinstance(args, op.args):
        return args
    raw = args.model_dump() if isinstance(args, BaseModel) else args
    try:
        return op.args.model_validate(raw)
    except ValueError as exc:
        raise OpError("validation_error") from exc


async def build(name: str, session: AsyncSession, user_id: int, args: BaseModel | dict[str, Any],
                *, now: datetime) -> Built:  # fmt: skip
    op = get(name)
    if op.build is None:
        raise OpError("not_buildable")
    return await op.build(session, user_id, _args(op, args), now=now)


async def run(name: str, session: AsyncSession, user_id: int, args: BaseModel | dict[str, Any],
              *, by: str, now: datetime, client_id: uuid.UUID | None = None,
              message_pk: int | None = None, **kw: Any) -> OpResult:  # fmt: skip
    """Do the operation in the caller's transaction: one action with its undo."""
    op = get(name)
    parsed = _args(op, args)
    if op.execute is not None:
        return await op.execute(session, user_id, parsed, by=by, now=now, client_id=client_id,
                                message_pk=message_pk, **kw)  # fmt: skip
    assert op.build is not None
    b = await op.build(session, user_id, parsed, now=now)
    out = await engine.apply(session, user_id, b.ops, by=by, check=False, now=now)
    action = None
    if out.inverse:
        action = await record(
            session, user_id=user_id, kind=b.kind, initiated_by=by,
            summary={"ru": b.sentence, "kk": None}, changes=b.changes, inverse=out.inverse,
            now=now, source_item_ids=b.source_item_ids, client_id=client_id,
            message_id=message_pk, extra={**b.extra, "op": name, "touched": list(b.touched)},
        )  # fmt: skip
    await session.flush()
    return OpResult(action=action, actions=[action] if action else [], inverse=out.inverse,
                    items=out.items, pages=out.pages, sentence=b.sentence, touched=b.touched,
                    data=b.data)  # fmt: skip
