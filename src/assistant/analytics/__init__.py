"""Product events (spec 3.8 `events`, R-40, F-35; product spec 7.2): our own journal in the KZ
database, schema `analytics`. Only with the `analytics` consent. No content ever: event names and
property keys come from the registry below (product spec 7.2); unknown names and keys are dropped,
and a value is a number, a bool, or a short code (`^[A-Za-z0-9_.:-]{1,40}$`), so text, names, sums
and phone numbers have no way in. People are `user_pseudo` = HMAC(user_id) with its own key.

Public: `REGISTRY`, `clean`, `pseudo`, `write_batch`, `server_event`, `delete_for_user`.
"""

import hashlib
import hmac
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.config import get_settings
from assistant.db.models_dedup import AnalyticsEvent
from assistant.db.models_v2 import Consent, ConsentKind

_CODE = re.compile(r"^[A-Za-z0-9_.:\-]{1,40}$")
_DIGITS = re.compile(r"\d{7,}")  # a phone, an ИИН, a card number
MAX_LIST = 12
FUTURE_SKEW = timedelta(minutes=10)
COMMON = ("lang_ui", "autonomy_mode", "profile", "os_version")

# event -> property keys (product spec 7.2). Some events are paired («a / b»): both are listed.
REGISTRY: dict[str, tuple[str, ...]] = {
    "app_first_open": ("install_source",),
    "onboarding_step": ("step", "action", "ms_on_step"),
    "onboarding_path_chosen": ("path", "is_default", "ms_from_open"),
    "pages_selected": ("templates", "changed_from_default", "skipped", "ms_on_step", "source"),
    "consent_decision": ("kind", "choice", "version"),
    "setup_for_other": (),
    "first_value": ("kind", "seconds_from_open", "seconds_from_path", "path"),
    "app_active": (),
    "capture_created": ("channel", "type", "offline_queued"),
    "voice_recorded": ("duration_s", "lang_detected", "fragments", "stt_ms"),
    "understood_shown": ("intent", "clarify_count"),
    "field_corrected": ("field_type",),
    "verify_confirmed": ("field_type",),
    "search_performed": ("mode", "results_count", "latency_ms"),
    "search_result_opened": ("rank",),
    "ask_answered": ("sources_count", "insufficient", "general_answer", "latency_ms",
                     "numbers_removed"),
    "source_opened": (),
    "problem_reported": ("target", "reason", "example_allowed"),
    "reminder_created": ("level", "source", "parser", "offsets_count"),
    "reminder_fired_local": ("delay_s", "surface"),
    "reminder_push_fallback": (),
    "reminder_acked": ("action", "seconds_after_fire", "repeat_n"),
    "reminder_missed": ("level", "s15_done"),
    "alarm_setup_step": ("step", "result", "vendor"),
    "alarm_test_result": ("fired", "delay_s"),
    "duplicate_merged_auto": (),
    "duplicate_offered": ("decision",),
    "duplicate_decided": ("decision",),
    "cleanup_offered": ("groups", "items_before", "items_after"),
    "cleanup_done": ("groups", "items_before", "items_after"),
    "duplicate_undo": ("kind",),
    "stack_created": ("items_count",),
    "stack_opened": ("items_count",),
    "stack_hidden": ("items_count",),
    "suggestion_shown": ("key", "kind", "dismiss_count"),
    "suggestion_accepted": ("key", "kind", "dismiss_count"),
    "suggestion_dismissed": ("key", "kind", "dismiss_count"),
    "agent_action": ("action_type", "autonomous"),
    "action_undone": ("action_type", "age_h"),
    "habit_learned": ("habit_kind",),
    "habit_changed": ("habit_kind",),
    "habit_violated": ("habit_kind",),
    "kp_started": ("input", "pages", "positions"),
    "kp_generated": ("seconds", "price_source_price_list", "price_source_past_kp",
                     "price_source_missing", "chunked"),
    "kp_edited": ("method", "reverted"),
    "kp_exported": ("format",),
    "send_opened": ("object", "channel"),
    "send_confirmed": ("object", "answer"),
    "price_list_saved": ("items", "method"),
    "import_started": ("method", "items", "skipped", "abandoned_step"),
    "import_completed": ("method", "items", "skipped", "abandoned_step"),
    "limit_reached": ("class",),
    "phone_linked": ("days_since_install",),
    "export_requested": (),
    "account_delete_requested": (),
    "account_delete_cancelled": (),
    "autonomy_changed": ("from", "to", "trigger"),
    "assistant_request": ("page_template", "input", "kind", "cross_page", "context_tokens"),
    "assistant_clarify": ("reason",),
    "answer_banner_shown": ("length_class", "shown_on"),
    "answer_opened": ("length_class", "shown_on"),
    "conversation_opened": ("trigger",),
    "page_added": ("template", "source", "pages_count"),
    "page_removed": ("template", "source", "pages_count"),
    "page_reordered": ("template", "source", "pages_count"),
    "page_suggested": ("template",),
    "page_accepted": ("template",),
    "page_declined": ("template",),
    "page_action_done": ("action", "items_count", "needed_yes"),
    "page_action_undone": ("action", "items_count", "needed_yes"),
    "item_moved_manual": ("method", "scope", "after_agent", "offline"),
    "manual_order_conflict": ("decision", "manual_items"),
    "manual_order_overridden": ("cause",),
    "template_edited": ("template", "change", "method"),
    "template_reset": ("template", "change", "method"),
    "expense_added": ("method", "currencies_count", "offline"),
    "statement_imported": ("rows", "added", "duplicates_skipped", "pages"),
    "expense_corrected": ("field_type", "method"),
}


def _value(v: Any) -> Any:
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, int | float):
        return v if abs(v) < 1e9 else None  # a phone or an ID number is not a measurement
    if isinstance(v, str):
        return v if _CODE.match(v) and not _DIGITS.search(v) else None
    if isinstance(v, list):
        items = [x for x in (_value(x) for x in v[:MAX_LIST]) if isinstance(x, str)]
        return items or None
    return None


def clean(name: str, props: dict[str, Any] | None) -> dict[str, Any] | None:
    """Props with registry keys and safe values only; None for an unknown event."""
    keys = REGISTRY.get(name)
    if keys is None:
        return None
    out = {}
    for k, v in (props or {}).items():
        if k in keys or k in COMMON:
            cv = _value(v)
            if cv is not None:
                out[k] = cv
    return out


def _key() -> bytes:
    st = get_settings()
    own = st.analytics_hash_key.get_secret_value()
    if own:
        return own.encode()
    base = st.hash_key.get_secret_value() or "assistant-dev-hash_key"
    return hmac.digest(base.encode(), b"analytics", "sha256")


def pseudo(kind: str, value: int | str) -> str:
    return hmac.new(_key(), f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()[:32]


async def consented(s: AsyncSession, user_id: int) -> bool:
    return await s.scalar(select(Consent.id).where(
        Consent.user_id == user_id, Consent.kind == ConsentKind.ANALYTICS,
        Consent.revoked_at.is_(None)).limit(1)) is not None  # fmt: skip


@dataclass
class EventIn:
    client_id: uuid.UUID
    name: str
    props: dict[str, Any]
    client_ts: datetime | None


async def write_batch(s: AsyncSession, user_id: int, device_id: int | None,
                      events: list[EventIn], *, platform: str | None,
                      app_version: str | None) -> tuple[int, int]:  # fmt: skip
    """Returns (accepted, dropped). A resent event (same client_id) is accepted once."""
    if not await consented(s, user_id):
        return 0, len(events)
    now = datetime.now(UTC)
    user = pseudo("user", user_id)
    device = pseudo("device", device_id) if device_id is not None else None
    rows = []
    dropped = 0
    for e in events:
        props = clean(e.name, e.props)
        if props is None:
            dropped += 1
            continue
        ts = e.client_ts if e.client_ts is None or e.client_ts <= now + FUTURE_SKEW else None
        rows.append({"client_id": e.client_id, "user_pseudo": user, "device_pseudo": device,
                     "name": e.name, "props": props,
                     "platform": platform if platform in ("ios", "android", "web") else None,
                     "app_version": app_version if app_version and _CODE.match(app_version)
                     else None, "client_ts": ts})  # fmt: skip
    if rows:
        await s.execute(insert(AnalyticsEvent).values(rows)
                        .on_conflict_do_nothing(constraint="uq_events_user_client"))
    return len(rows), dropped


async def server_event(s: AsyncSession, user_id: int, name: str, props: dict[str, Any]) -> None:
    """An event the server sees itself (import done, cleanup done); same rules as the phone's."""
    await write_batch(s, user_id, None, [EventIn(uuid.uuid4(), name, props, None)],
                      platform=None, app_version=None)


async def delete_for_user(s: AsyncSession, user_id: int) -> int:
    """Account deletion: their events go by `user_pseudo` (spec 3.8)."""
    res = await s.execute(delete(AnalyticsEvent).where(
        AnalyticsEvent.user_pseudo == pseudo("user", user_id)))
    return res.rowcount or 0
