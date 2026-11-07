"""Page summaries (`screen_summaries`, spec 3.10), counted by code, no model.

Triggers from migration 0009 keep `item_count` and `last_titles` in the transaction that changes the
page. The nightly `rebuild_summaries` repairs them and fills `aggregates`. Aggregates have nothing
to count yet: `expense_entries` and `tasks` don't exist, so each stays {} (spec: «Расходы» month
totals, «Дела» today/missed). Add them to `_aggregates` when those tables come.
"""

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db.models_pages import Screen
from assistant.db.models_search import ScreenSummary

BATCH = 200


async def _aggregates(session: AsyncSession, page: Screen) -> dict:
    return {}


async def rebuild_summaries(maker: async_sessionmaker[AsyncSession]) -> int:
    """Everything, one short transaction per batch. Returns the pages seen. Unchanged rows don't
    change `seq`, so a night's run sends nothing to phones."""
    seen = 0
    after = 0
    while True:
        async with maker() as s:
            pages = list(
                await s.scalars(
                    select(Screen).where(Screen.id > after, Screen.deleted_at.is_(None))
                    .order_by(Screen.id).limit(BATCH)
                )
            )  # fmt: skip
            if not pages:
                await s.commit()
                return seen
            await s.execute(text("SELECT screen_summaries_refresh(:ids)"),
                            {"ids": [p.id for p in pages]})  # fmt: skip
            for page in pages:
                values = await _aggregates(s, page)
                row = await s.get(ScreenSummary, page.id, populate_existing=True)
                if row is not None and row.aggregates != values:
                    row.aggregates = values
            await s.commit()
        seen += len(pages)
        after = pages[-1].id
