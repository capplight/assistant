"""Item processing: link/screenshot/forward -> structured meaning -> place -> embedding.

Owned by the pipeline module. The bot only enqueues `process_item` jobs; the worker
(assistant.worker) calls process_item(). Button presses on messages the pipeline sent
arrive in the bot, which routes them here by callback_data prefix.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from assistant.notify import Notifier

JOB_PROCESS_ITEM = "process_item"

# callback_data formats (<= 64 bytes):
#   "pick:<item_id>:<option_index>"  user chose one of the candidate places; index -1 = "none"
#   "bk:<booking_id>:ok" | "bk:<booking_id>:no"  user confirmed / rejected extracted booking
CB_PICK = "pick"
CB_BOOKING = "bk"


async def process_item(session: AsyncSession, item_id: int, notifier: Notifier) -> None:
    """Process one item end to end and tell the user what was saved (or ask one question).

    Must be idempotent: a retried job for an already DONE item does nothing.
    Raises on transient errors (network, 429) so the queue retries with backoff.
    """
    from assistant.pipeline.service import process_item as _impl

    await _impl(session, item_id, notifier)


async def handle_choice(
    session: AsyncSession, item_id: int, option_index: int, notifier: Notifier
) -> None:
    """User answered the clarifying question for an item in NEEDS_INPUT."""
    from assistant.pipeline.service import handle_choice as _impl

    await _impl(session, item_id, option_index, notifier)


async def confirm_booking(
    session: AsyncSession, booking_id: int, ok: bool, notifier: Notifier
) -> None:
    """User confirmed (ok) or rejected the extracted booking. On ok, sets confirmed_at and
    calls assistant.scheduler.schedule_for_booking()."""
    from assistant.pipeline.service import confirm_booking as _impl

    await _impl(session, booking_id, ok, notifier)
