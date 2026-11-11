"""Where a person's data lives, and how account deletion removes it (spec 3.8 `account_deletions`,
7.2, F-27). The deletion flow itself (grace days, web page, `account:purge`) comes in week 16
(Ф-6); this registry and `purge_user` are its core, so nothing added since week 1 is forgotten.

Every table of the `public` and `analytics` schemas is listed here with how it goes:
- `cascade`: rows go with `users` (a chain of `ON DELETE CASCADE` foreign keys reaches it);
- `explicit`: no foreign key; `purge_user` deletes them by the user id;
- `pseudonym`: `analytics.events`, by `user_pseudo` (R-40);
- `anonymize`: kept for accounting without the person (`user_id` set to null);
- `shared`: no personal data (catalogues, queue internals, provider state).
`tests/api/test_account_data_db.py` fails when a table is not listed, or a `cascade` table has no
cascade path to `users`: a new per-user table must be added here in the same change.
"""

from typing import Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

Mode = Literal["cascade", "explicit", "pseudonym", "anonymize", "shared"]

USER_TABLES: dict[str, Mode] = {
    # accounts and devices
    "public.users": "cascade",
    "public.auth_identities": "cascade",
    "public.auth_sessions": "cascade",
    "public.devices": "cascade",
    "public.otp_challenges": "cascade",
    "public.consents": "cascade",
    "public.feedback": "cascade",
    # records, files, search
    "public.items": "cascade",
    "public.files": "cascade",
    "public.uploads": "cascade",
    "public.chunks": "cascade",
    "public.item_places": "cascade",  # via items
    "public.trips": "cascade",
    "public.bookings": "cascade",
    # pages and views
    "public.screens": "cascade",
    "public.screen_items": "cascade",
    "public.screen_summaries": "cascade",  # via screens
    "public.item_facets": "cascade",  # week 11
    # «Расходы» (week 12): user rows cascade; catalogue rows (user_id NULL) hold no personal data
    "public.expense_entries": "cascade",
    "public.expense_categories": "cascade",
    "public.statement_imports": "cascade",  # week 13: a statement plan (rows wait until «Да»)
    "public.expense_duplicates": "cascade",  # week 13: «Похоже, эта трата уже есть»
    # КП (week 14): user rows cascade; the system КП layout (`doc_templates.user_id` NULL) has
    # no personal data
    "public.company_profiles": "cascade",
    "public.doc_templates": "cascade",
    "public.price_lists": "cascade",
    "public.price_list_items": "cascade",
    "public.documents": "cascade",
    "public.document_versions": "cascade",
    "public.drafts": "cascade",  # week 15 (0021)
    "public.kp_price_history": "cascade",
    "public.user_habits": "cascade",
    # chat and actions
    "public.conversations": "cascade",
    "public.conversation_messages": "cascade",
    "public.actions": "cascade",
    "public.pending_actions": "cascade",
    # reminders, tasks, suggestions
    "public.reminders": "cascade",
    "public.reminder_fires": "cascade",
    "public.reminder_events": "cascade",
    "public.tasks": "cascade",
    "public.suggestions": "cascade",
    "public.suggestion_counters": "cascade",
    # repeats, stacks, imports
    "public.duplicate_groups": "cascade",
    "public.duplicate_group_members": "cascade",  # via duplicate_groups / items
    "public.duplicate_candidates": "cascade",
    "public.collections": "cascade",
    "public.collection_items": "cascade",  # via collections / items
    "public.imports": "cascade",
    "public.import_seen": "cascade",
    # AI usage
    "public.ai_batch_requests": "cascade",
    "public.usage_counters": "cascade",
    "public.budgets": "explicit",  # scope 'user', key = user id
    "public.provider_usage": "anonymize",  # cost journal, partitioned; no content
    # sync
    "public.sync_tombstones": "explicit",  # no FK on purpose (written during the cascade)
    "public.jobs": "explicit",  # queued work naming the person in its payload
    # product events (0015)
    "analytics.events": "pseudonym",
    # no personal data
    "public.alembic_version": "shared",
    "public.screen_templates": "shared",
    "public.places": "shared",
    "public.place_queries": "shared",
    "public.processed_updates": "shared",
    "public.ai_batches": "shared",
    "public.ai_provider_state": "shared",
    "public.spatial_ref_sys": "shared",  # PostGIS, when installed
}


async def purge_user(session: AsyncSession, user_id: int) -> dict[str, int]:
    """Remove everything of one account in the caller's transaction. Returns rows touched per
    table that is not `cascade` (the report of `account_deletions`). Files in object storage
    go by their key prefix (`u/<user public id>/`), done by the caller."""
    from assistant.analytics import delete_for_user  # analytics imports the db models

    report: dict[str, int] = {}
    report["analytics.events"] = await delete_for_user(session, user_id)
    res = await session.execute(text(
        "DELETE FROM jobs WHERE payload ->> 'user_id' = :u AND status <> 'running'"),
        {"u": str(user_id)})  # fmt: skip
    report["public.jobs"] = res.rowcount or 0  # type: ignore[attr-defined]
    res = await session.execute(text("DELETE FROM budgets WHERE scope = 'user' AND key = :u"),
                                {"u": str(user_id)})  # fmt: skip
    report["public.budgets"] = res.rowcount or 0  # type: ignore[attr-defined]
    res = await session.execute(text("UPDATE provider_usage SET user_id = NULL WHERE user_id = :u"),
                                {"u": user_id})  # fmt: skip
    report["public.provider_usage"] = res.rowcount or 0  # type: ignore[attr-defined]
    await session.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
    # the cascade wrote tombstones for the rows it deleted: none must stay
    res = await session.execute(text("DELETE FROM sync_tombstones WHERE user_id = :u"),
                                {"u": user_id})  # fmt: skip
    report["public.sync_tombstones"] = res.rowcount or 0  # type: ignore[attr-defined]
    return report
