"""Account deletion covers every per-user table (week 10 follow-up): every table of `public` and
`analytics` is in `assistant.api.account_data.USER_TABLES`, every `cascade` table really reaches
`users` through ON DELETE CASCADE foreign keys, and `purge_user` leaves nothing of the person —
analytics events included. Skipped without DATABASE_URL."""

import os
import uuid

import pytest
from sqlalchemy import text

from assistant.analytics import pseudo
from assistant.api.account_data import USER_TABLES, purge_user
from assistant.db import queue
from tests.api.conftest import client
from tests.chat.test_chat_db import env, record, signed_in  # noqa: F401  (env is a fixture)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

TABLES = """
SELECT n.nspname || '.' || c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND n.nspname IN ('public', 'analytics')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
"""
CASCADES = """
SELECT cn.nspname || '.' || c.relname, fn.nspname || '.' || f.relname
FROM pg_constraint k
JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
JOIN pg_class f ON f.oid = k.confrelid JOIN pg_namespace fn ON fn.oid = f.relnamespace
WHERE k.contype = 'f' AND k.confdeltype = 'c'
"""


async def test_every_table_is_registered_and_cascades_reach_users(env):  # noqa: F811
    async with env.maker() as s:
        tables = set(await s.scalars(text(TABLES)))
        edges: dict[str, set[str]] = {}
        for child, parent in await s.execute(text(CASCADES)):
            edges.setdefault(child, set()).add(parent)
    missing = sorted(tables - set(USER_TABLES))
    assert not missing, (f"tables not in assistant/api/account_data.py USER_TABLES: {missing}. "
                         "Say how account deletion removes them.")  # fmt: skip

    def reaches_users(t: str, seen: frozenset[str] = frozenset()) -> bool:
        if t == "public.users":
            return True
        return any(p not in seen and reaches_users(p, seen | {t}) for p in edges.get(t, ()))

    broken = sorted(t for t, mode in USER_TABLES.items()
                    if mode == "cascade" and t in tables and not reaches_users(t))
    assert not broken, f"marked cascade but no ON DELETE CASCADE path to users: {broken}"


async def test_purge_user_leaves_nothing(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c)
        await record(c, h, env.maker, "Код домофона 4512")
        me = (await c.get("/v1/me", headers=h)).json()
    async with env.maker() as s:
        uid = await s.scalar(text("SELECT id FROM users WHERE public_id = :p"),
                             {"p": uuid.UUID(me["id"])})  # fmt: skip
        await s.execute(text("INSERT INTO analytics.events (client_id, user_pseudo, name, props) "
                             "VALUES (:c, :u, 'app_opened', '{}')"),
                        {"c": uuid.uuid4(), "u": pseudo("user", uid)})  # fmt: skip
        await queue.enqueue(s, "stacks:rebuild", {"user_id": uid})
        report = await purge_user(s, uid)
        assert await s.scalar(text("SELECT count(*) FROM jobs WHERE payload ->> 'user_id' = :u"),
                              {"u": str(uid)}) == 0  # fmt: skip
        assert report["analytics.events"] == 1 and report["public.jobs"] >= 1
        for table, mode in USER_TABLES.items():
            cols = set(await s.scalars(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema || '.' || table_name = :t"), {"t": table}))
            if "user_id" in cols and mode != "anonymize":
                n = await s.scalar(text(f"SELECT count(*) FROM {table} WHERE user_id = :u"),
                                   {"u": uid})  # fmt: skip
                assert n == 0, table
        assert await s.scalar(text("SELECT count(*) FROM analytics.events WHERE user_pseudo = :p"),
                              {"p": pseudo("user", uid)}) == 0  # fmt: skip
        await s.rollback()
