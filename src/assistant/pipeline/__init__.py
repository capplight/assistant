"""Item processing: link/screenshot/forward -> structured meaning -> place -> embedding.

Owned by the pipeline module. The bot only enqueues `process_item` jobs; the worker
(assistant.worker) calls process_item().
"""

from sqlalchemy.ext.asyncio import AsyncSession

from assistant.notify import Notifier

JOB_PROCESS_ITEM = "process_item"


async def process_item(session: AsyncSession, item_id: int, notifier: Notifier) -> None:
    """Process one item end to end and tell the user what was saved (or ask one question).

    Must be idempotent: a retried job for an already DONE item does nothing.
    Raises on transient errors (network, 429) so the queue retries with backoff.
    """
    raise NotImplementedError
