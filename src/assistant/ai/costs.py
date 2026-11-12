"""Chat cost dashboards and ops alerts (week 17; spec 3-engineering 5.3, 5.4, 5.10 rule 9, 8, 12).

Report (numbers only, never content):
    python -m assistant.ai.costs report [--days 7] [--json]
per local day (`budget_tz`): chat steps, $ total and per step, median / p95 step cost and
latency, tokens (uncached in, cache read, cache write, out), cache-read share, fallback share,
strong-model share, failed attempts, turns (`usage_counters.chat_turns`) and steps per turn, the
same per user profile, the spend per person per day (p50 / p95 / max) and whether the median step
is within `ops_chat_step_median_target_usd`. Tokens per context layer are not recorded (the
assembler only estimates them), so the report has no per-layer split.

Alerts:
    python -m assistant.ai.costs alerts [--send]
checks and stores in `ops_alerts` (one row per dedup key, so a repeat never fires again):
- `fallback_in_use`: a task whose route starts with the primary has been served only by another
  provider for more than `ai_fallback_alert_minutes` (10) and still is;
- `provider_off`: a provider switched off (quota / 402) until a manual reset;
- `family_daily`: a `family_beta` person over `budget_family_alert_daily_usd` ($0.50) today;
- `chat_steps`: a person over `ops_chat_steps_per_user_day` (60) chat steps today;
- `chat_step_cost`: a chat step dearer than `ops_chat_step_alert_usd` ($0.05) today;
- `chat_median`: yesterday's median step over the target (at least `MEDIAN_MIN_STEPS` steps).
New alerts are committed first, then sent through `notify.Notifier` to `ops_alert_chat_id`
(Telegram, the founder / developer) or, without one, logged; then marked `sent_at`. Texts hold
internal user ids and numbers only (spec 8: no personal data). The router keeps its own
in-process warnings (ai/budget.py `log_alert`); this module is the cross-process check.

The aggregation and the alert rules are pure functions over rows (`summarize`, `evaluate`), so
unit tests need no database; `load_*` read Postgres in short sessions.
"""

import argparse
import asyncio
import json
import logging
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai.routes import RouteTable, load_routes
from assistant.ai.store import period_starts
from assistant.ai.types import LLMTask
from assistant.config import Settings, get_settings
from assistant.notify import Notifier, OutMessage

log = logging.getLogger(__name__)

CHAT_TASKS = (LLMTask.CHAT.value,)
MEDIAN_MIN_STEPS = 20  # fewer steps in a day: the median says nothing yet
FALLBACK_LOOKBACK = timedelta(hours=6)


# --- rows ---


@dataclass(frozen=True)
class StepRow:
    """One provider_usage row of a chat step (any outcome)."""

    created_at: datetime
    user_id: int | None
    profile: str | None
    provider: str
    model: str
    outcome: str
    cost_usd: Decimal
    latency_ms: int | None
    tokens_in: int = 0
    tokens_out: int = 0
    cached_in: int = 0
    cache_write_in: int = 0


def percentile(values: Sequence[float], q: float) -> float | None:
    """Linear interpolation, as Postgres percentile_cont."""
    if not values:
        return None
    s = sorted(values)
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


@dataclass
class Slice:
    """Aggregates of one group of chat steps (a day, or a day x profile)."""

    steps: int = 0  # successful chat calls = steps
    failed: int = 0  # attempts that did not answer (fallback, retry, block)
    users: int = 0
    cost_usd: float = 0.0
    cost_per_step: float | None = None
    cost_median: float | None = None
    cost_p95: float | None = None
    latency_median_ms: float | None = None
    latency_p95_ms: float | None = None
    tokens_in: int = 0
    cached_in: int = 0
    cache_write_in: int = 0
    tokens_out: int = 0
    cache_read_share: float | None = None
    fallback_share: float | None = None
    strong_share: float | None = None


def _slice(rows: list[StepRow], primary: str, strong: frozenset[str]) -> Slice:
    ok = [r for r in rows if r.outcome == "ok"]
    out = Slice(steps=len(ok), failed=len(rows) - len(ok),
                users=len({r.user_id for r in ok if r.user_id is not None}))  # fmt: skip
    # every attempt costs money (a failed one may have used tokens)
    out.cost_usd = round(float(sum((r.cost_usd for r in rows), Decimal(0))), 6)
    for r in rows:
        out.tokens_in += r.tokens_in
        out.cached_in += r.cached_in
        out.cache_write_in += r.cache_write_in
        out.tokens_out += r.tokens_out
    if ok:
        costs = [float(r.cost_usd) for r in ok]
        out.cost_per_step = round(out.cost_usd / len(ok), 6)
        out.cost_median = round(percentile(costs, 0.5) or 0.0, 6)
        out.cost_p95 = round(percentile(costs, 0.95) or 0.0, 6)
        lat = [float(r.latency_ms) for r in ok if r.latency_ms is not None]
        if lat:
            out.latency_median_ms = round(percentile(lat, 0.5) or 0.0, 1)
            out.latency_p95_ms = round(percentile(lat, 0.95) or 0.0, 1)
        out.fallback_share = round(sum(r.provider != primary for r in ok) / len(ok), 4)
        out.strong_share = round(sum(r.model in strong for r in ok) / len(ok), 4)
    prompt = out.tokens_in + out.cached_in + out.cache_write_in
    if prompt:
        out.cache_read_share = round(out.cached_in / prompt, 4)
    return out


@dataclass
class DayReport:
    day: str
    total: Slice
    by_profile: dict[str, Slice] = field(default_factory=dict)
    turns: int | None = None
    steps_per_turn: float | None = None
    user_day_usd_p50: float | None = None  # all AI spend per person that day (budgets)
    user_day_usd_p95: float | None = None
    user_day_usd_max: float | None = None
    median_target_usd: float | None = None
    median_in_target: bool | None = None


def summarize(rows: Iterable[StepRow], *, tz: str, primary: str, strong: frozenset[str],
              turns: dict[str, int] | None = None,
              user_spend: dict[str, list[float]] | None = None,
              median_target: float | None = None) -> list[DayReport]:  # fmt: skip
    """Rows → one report per local day, oldest first."""
    zone = ZoneInfo(tz)
    days: dict[str, list[StepRow]] = defaultdict(list)
    for r in rows:
        days[r.created_at.astimezone(zone).date().isoformat()].append(r)
    for d in (turns or {}):
        days.setdefault(d, [])
    out = []
    for d in sorted(days):
        day_rows = days[d]
        rep = DayReport(day=d, total=_slice(day_rows, primary, strong))
        groups: dict[str, list[StepRow]] = defaultdict(list)
        for r in day_rows:
            groups[r.profile or "unknown"].append(r)
        rep.by_profile = {p: _slice(g, primary, strong) for p, g in sorted(groups.items())}
        if turns is not None:
            rep.turns = turns.get(d, 0)
            if rep.turns:
                rep.steps_per_turn = round(rep.total.steps / rep.turns, 3)
        spend = (user_spend or {}).get(d) or []
        if spend:
            rep.user_day_usd_p50 = round(percentile(spend, 0.5) or 0.0, 6)
            rep.user_day_usd_p95 = round(percentile(spend, 0.95) or 0.0, 6)
            rep.user_day_usd_max = round(max(spend), 6)
        if median_target is not None:
            rep.median_target_usd = median_target
            if rep.total.cost_median is not None:
                rep.median_in_target = rep.total.cost_median <= median_target
        out.append(rep)
    return out


# --- alerts ---


@dataclass(frozen=True)
class AlertOut:
    kind: str
    dedup_key: str
    text: str
    user_id: int | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class Snapshot:
    """What the alert rules look at (all numbers, read by `load_snapshot`)."""

    now: datetime
    day: str  # today, local
    yesterday: str
    # fallback: per provider, first / last ok call since the primary last answered (tasks whose
    # route starts with the primary)
    fallback: dict[str, tuple[datetime, datetime]] = field(default_factory=dict)
    providers_off: dict[str, tuple[str, datetime]] = field(default_factory=dict)
    family_spend: dict[int, float] = field(default_factory=dict)  # family_beta, today
    chat_steps: dict[int, int] = field(default_factory=dict)  # today, per user
    dear_steps: dict[int, tuple[int, float]] = field(default_factory=dict)  # (count, max $)
    yesterday_steps: int = 0
    yesterday_median: float | None = None


def evaluate(snap: Snapshot, s: Settings) -> list[AlertOut]:
    out: list[AlertOut] = []
    minutes = s.ai_fallback_alert_minutes
    for provider, (first, last) in sorted(snap.fallback.items()):
        if (snap.now - first > timedelta(minutes=minutes)
                and snap.now - last <= timedelta(minutes=minutes)):  # fmt: skip
            since = first.astimezone(UTC).strftime("%Y-%m-%dT%H:%M")
            out.append(AlertOut(
                "fallback_in_use", f"fallback_in_use:{provider}:{since}",
                f"Запасной провайдер {provider} отвечает вместо основного больше {minutes:g} мин "
                f"(с {since} UTC).", details={"provider": provider, "since": since,
                                              "minutes": round((snap.now - first)
                                                               .total_seconds() / 60, 1)}))
    for provider, (reason, changed) in sorted(snap.providers_off.items()):
        at = changed.astimezone(UTC).strftime("%Y-%m-%dT%H:%M")
        out.append(AlertOut(
            "provider_off", f"provider_off:{provider}:{at}",
            f"Провайдер {provider} выключен ({reason or 'off'}) до ручного сброса.",
            details={"provider": provider, "reason": reason, "since": at}))
    cap = s.budget_family_alert_daily_usd
    for uid, spent in sorted(snap.family_spend.items()):
        if spent > cap:
            out.append(AlertOut(
                "family_daily", f"family_daily:{uid}:{snap.day}",
                f"Пользователь {uid} (family_beta) потратил ${spent:.2f} за день (порог "
                f"${cap:.2f}).", uid, {"spent_usd": round(spent, 4), "cap_usd": cap}))
    steps_cap = s.ops_chat_steps_per_user_day
    for uid, n in sorted(snap.chat_steps.items()):
        if n > steps_cap:
            out.append(AlertOut(
                "chat_steps", f"chat_steps:{uid}:{snap.day}",
                f"Пользователь {uid}: {n} шагов чата за день (порог {steps_cap}).", uid,
                {"steps": n, "cap": steps_cap}))
    dear = s.ops_chat_step_alert_usd
    for uid, (n, top) in sorted(snap.dear_steps.items()):
        if n and top > dear:
            out.append(AlertOut(
                "chat_step_cost", f"chat_step_cost:{uid}:{snap.day}",
                f"Пользователь {uid}: {n} шаг(ов) чата дороже ${dear:.2f} за день, самый дорогой "
                f"${top:.4f}.", uid, {"count": n, "max_usd": round(top, 6), "cap_usd": dear}))
    target = s.ops_chat_step_median_target_usd
    if (snap.yesterday_median is not None and snap.yesterday_steps >= MEDIAN_MIN_STEPS
            and snap.yesterday_median > target):  # fmt: skip
        out.append(AlertOut(
            "chat_median", f"chat_median:{snap.yesterday}",
            f"Медиана шага чата за {snap.yesterday}: ${snap.yesterday_median:.4f} — выше цели "
            f"${target:.4f} ({snap.yesterday_steps} шагов).",
            details={"median_usd": round(snap.yesterday_median, 6), "target_usd": target,
                     "steps": snap.yesterday_steps}))
    return out


# --- Postgres ---


def primary_first_tasks(routes: RouteTable, primary: str) -> list[str]:
    """Tasks whose route starts with the primary: serving them elsewhere is a fallback."""
    out = []
    for task in LLMTask:
        try:
            chain = routes.route(task).chain
        except KeyError:
            continue
        if chain and chain[0] == primary:
            out.append(task.value)
    return out


async def load_chat_rows(session: AsyncSession, since: datetime, until: datetime) -> list[StepRow]:
    res = await session.execute(text("""
        SELECT pu.created_at, pu.user_id, u.profile, pu.provider, pu.model, pu.outcome,
               pu.cost_usd, pu.latency_ms, pu.tokens_in, pu.tokens_out, pu.cached_in,
               pu.cache_write_in
        FROM provider_usage pu LEFT JOIN users u ON u.id = pu.user_id
        WHERE pu.task = ANY(:tasks) AND pu.created_at >= :since AND pu.created_at < :until
          AND pu.outcome NOT IN ('budget_blocked', 'consent_blocked', 'circuit_open')
    """), {"tasks": list(CHAT_TASKS), "since": since, "until": until})  # fmt: skip
    return [StepRow(r.created_at, r.user_id, r.profile, r.provider, r.model, r.outcome,
                    Decimal(r.cost_usd or 0), r.latency_ms, r.tokens_in or 0, r.tokens_out or 0,
                    r.cached_in or 0, r.cache_write_in or 0) for r in res]  # fmt: skip


async def load_turns(session: AsyncSession, since: datetime, tz: str) -> dict[str, int]:
    res = await session.execute(text("""
        SELECT period_start, sum(value) AS n FROM usage_counters
        WHERE counter = 'chat_turns' AND period_start >= :since GROUP BY period_start
    """), {"since": since})  # fmt: skip
    zone = ZoneInfo(tz)
    return {r.period_start.astimezone(zone).date().isoformat(): int(r.n) for r in res}


async def load_user_spend(session: AsyncSession, since: datetime,
                          tz: str) -> dict[str, list[float]]:  # fmt: skip
    """All AI spend per person per day (the budgets wallet `user / all / day`)."""
    res = await session.execute(text("""
        SELECT period_start, spent_usd FROM budgets
        WHERE scope = 'user' AND class = 'all' AND period = 'day' AND period_start >= :since
    """), {"since": since})  # fmt: skip
    zone = ZoneInfo(tz)
    out: dict[str, list[float]] = defaultdict(list)
    for r in res:
        out[r.period_start.astimezone(zone).date().isoformat()].append(float(r.spent_usd))
    return dict(out)


async def build_report(sessionmaker: async_sessionmaker[AsyncSession], s: Settings, *,
                       days: int = 7, now: datetime | None = None,
                       routes: RouteTable | None = None) -> list[DayReport]:  # fmt: skip
    now = now or datetime.now(UTC)
    routes = routes or load_routes(s)
    today, _ = period_starts(now, s.budget_tz)
    since = today - timedelta(days=max(1, days) - 1)
    # a DST-free zone (Asia/Almaty) keeps this exact; elsewhere a day may be off by an hour
    async with sessionmaker() as session:
        rows = await load_chat_rows(session, since, now + timedelta(seconds=1))
        turns = await load_turns(session, since, s.budget_tz)
        spend = await load_user_spend(session, since, s.budget_tz)
        await session.commit()
    return summarize(rows, tz=s.budget_tz, primary=s.ai_primary_provider,
                     strong=routes.strong_models(), turns=turns, user_spend=spend,
                     median_target=s.ops_chat_step_median_target_usd)  # fmt: skip


async def load_snapshot(session: AsyncSession, s: Settings, now: datetime,
                        routes: RouteTable) -> Snapshot:  # fmt: skip
    zone = ZoneInfo(s.budget_tz)
    today, _ = period_starts(now, s.budget_tz)
    yday = today - timedelta(days=1)
    snap = Snapshot(now=now, day=today.astimezone(zone).date().isoformat(),
                    yesterday=yday.astimezone(zone).date().isoformat())  # fmt: skip
    primary = s.ai_primary_provider
    tasks = primary_first_tasks(routes, primary)
    res = await session.execute(text("""
        WITH last_primary AS (
            SELECT max(created_at) AS at FROM provider_usage
            WHERE provider = :p AND outcome = 'ok' AND created_at >= :since
              AND task = ANY(:tasks))
        SELECT provider, min(created_at) AS first_at, max(created_at) AS last_at
        FROM provider_usage, last_primary
        WHERE provider <> :p AND outcome = 'ok' AND task = ANY(:tasks)
          AND created_at >= greatest(:since, coalesce(last_primary.at, :since))
        GROUP BY provider
    """), {"p": primary, "since": now - FALLBACK_LOOKBACK, "tasks": tasks})  # fmt: skip
    snap.fallback = {r.provider: (r.first_at, r.last_at) for r in res}
    res = await session.execute(text(
        "SELECT provider, reason, changed_at FROM ai_provider_state WHERE state = 'off'"))
    snap.providers_off = {r.provider: (r.reason or "", r.changed_at) for r in res}
    res = await session.execute(text("""
        SELECT u.id, b.spent_usd FROM budgets b JOIN users u ON u.id::text = b.key
        WHERE b.scope = 'user' AND b.class = 'all' AND b.period = 'day'
          AND b.period_start = :day AND u.profile = 'family_beta'
    """), {"day": today})  # fmt: skip
    snap.family_spend = {r.id: float(r.spent_usd) for r in res}
    res = await session.execute(text("""
        SELECT user_id, count(*) AS n,
               count(*) FILTER (WHERE cost_usd > :dear) AS dear, max(cost_usd) AS top
        FROM provider_usage
        WHERE task = ANY(:tasks) AND outcome = 'ok' AND created_at >= :day
          AND user_id IS NOT NULL
        GROUP BY user_id
    """), {"tasks": list(CHAT_TASKS), "day": today,
           "dear": s.ops_chat_step_alert_usd})  # fmt: skip
    for r in res:
        snap.chat_steps[r.user_id] = int(r.n)
        if r.dear:
            snap.dear_steps[r.user_id] = (int(r.dear), float(r.top))
    row = (await session.execute(text("""
        SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd) AS med
        FROM provider_usage
        WHERE task = ANY(:tasks) AND outcome = 'ok' AND created_at >= :y AND created_at < :t
    """), {"tasks": list(CHAT_TASKS), "y": yday, "t": today})).one()  # fmt: skip
    snap.yesterday_steps = int(row.n)
    snap.yesterday_median = float(row.med) if row.med is not None else None
    return snap


async def record_alerts(session: AsyncSession, alerts: list[AlertOut]) -> int:
    """Store; a known dedup key only bumps hits. Returns how many are new."""
    new = 0
    for a in alerts:
        inserted = await session.scalar(text("""
            INSERT INTO ops_alerts (kind, dedup_key, user_id, details)
            VALUES (:k, :key, :u, CAST(:d AS jsonb))
            ON CONFLICT (dedup_key) DO UPDATE SET hits = ops_alerts.hits + 1,
                last_at = now(), details = EXCLUDED.details
            RETURNING (xmax = 0)
        """), {"k": a.kind, "key": a.dedup_key, "u": a.user_id,
               "d": json.dumps({**a.details, "text": a.text}, ensure_ascii=False)})  # fmt: skip
        new += bool(inserted)
    return new


async def deliver(sessionmaker: async_sessionmaker[AsyncSession], notifier: Notifier | None,
                  chat_id: int | None) -> int:  # fmt: skip
    """Send what was not sent yet (outside any transaction), then mark it. A failed send is
    retried next run; it never undoes anything."""
    async with sessionmaker() as session:
        rows = (await session.execute(text(
            "SELECT id, kind, details FROM ops_alerts WHERE sent_at IS NULL ORDER BY id LIMIT 50"
        ))).all()  # fmt: skip
        await session.commit()
    sent = []
    for r in rows:
        body = f"⚠️ {r.kind}: {(r.details or {}).get('text', '')}"
        if notifier is not None and chat_id is not None:
            try:
                await notifier.send(OutMessage(chat_id=chat_id, text=body[:3500]))
            except Exception as exc:  # noqa: BLE001 - delivery problems are retried
                log.warning("ops alert not sent: %s", type(exc).__name__)
                continue
        else:
            log.warning("OPS ALERT %s", body)
        sent.append(r.id)
    if sent:
        async with sessionmaker() as session, session.begin():
            await session.execute(text(
                "UPDATE ops_alerts SET sent_at = now() WHERE id = ANY(:ids)"), {"ids": sent})
    return len(sent)


async def check_alerts(sessionmaker: async_sessionmaker[AsyncSession], s: Settings, *,
                       now: datetime | None = None, routes: RouteTable | None = None,
                       notifier: Notifier | None = None, send: bool = True
                       ) -> list[AlertOut]:  # fmt: skip
    now = now or datetime.now(UTC)
    routes = routes or load_routes(s)
    async with sessionmaker() as session:
        snap = await load_snapshot(session, s, now, routes)
        await session.commit()
    alerts = evaluate(snap, s)
    async with sessionmaker() as session, session.begin():
        await record_alerts(session, alerts)
    if send:
        await deliver(sessionmaker, notifier, s.ops_alert_chat_id)
    return alerts


# --- output ---


def _fmt(v: float | None, kind: str = "usd") -> str:
    if v is None:
        return "-"
    if kind == "usd":
        return f"${v:.4f}"
    if kind == "pct":
        return f"{v * 100:.0f}%"
    if kind == "ms":
        return f"{v:.0f}"
    return f"{v:g}"


def render_table(reports: list[DayReport]) -> str:
    head = ("day         steps  fail  turns st/turn   $total   $/step   $p50     $p95     "
            "ms p50  ms p95  cache  fallb  strong  user$p50 user$p95 user$max  target")
    lines = [head, "-" * len(head)]
    for r in reports:
        t = r.total
        ok = {True: "ok", False: "OVER", None: "-"}[r.median_in_target]
        lines.append(
            f"{r.day}  {t.steps:5d} {t.failed:5d} {r.turns if r.turns is not None else '-':>6} "
            f"{_fmt(r.steps_per_turn, 'n'):>7} {_fmt(t.cost_usd):>8} {_fmt(t.cost_per_step):>8} "
            f"{_fmt(t.cost_median):>8} {_fmt(t.cost_p95):>8} {_fmt(t.latency_median_ms, 'ms'):>7} "
            f"{_fmt(t.latency_p95_ms, 'ms'):>7} {_fmt(t.cache_read_share, 'pct'):>6} "
            f"{_fmt(t.fallback_share, 'pct'):>6} {_fmt(t.strong_share, 'pct'):>6} "
            f"{_fmt(r.user_day_usd_p50):>8} {_fmt(r.user_day_usd_p95):>8} "
            f"{_fmt(r.user_day_usd_max):>8}  {ok}")  # fmt: skip
        for profile, p in r.by_profile.items():
            lines.append(f"  · {profile:<12} steps {p.steps:4d}  ${p.cost_usd:.4f}  "
                         f"p50 {_fmt(p.cost_median)}  p95 {_fmt(p.cost_p95)}  "
                         f"users {p.users}")  # fmt: skip
    if reports and reports[-1].median_target_usd is not None:
        lines.append(f"target: median chat step <= ${reports[-1].median_target_usd:.4f} "
                     "(spec 5.10 estimate $0.0007-0.003 per step)")  # fmt: skip
    return "\n".join(lines)


def reports_json(reports: list[DayReport]) -> str:
    return json.dumps([asdict(r) for r in reports], ensure_ascii=False, indent=2)


def _telegram_notifier(s: Settings) -> Notifier | None:
    token = s.bot_token.get_secret_value()
    if not token or s.ops_alert_chat_id is None:
        return None
    from aiogram import Bot

    from assistant.notify import TelegramNotifier

    return TelegramNotifier(Bot(token))


async def _main(argv: list[str] | None = None) -> int:
    from assistant.db.session import get_sessionmaker

    parser = argparse.ArgumentParser(prog="python -m assistant.ai.costs")
    sub = parser.add_subparsers(dest="cmd", required=True)
    rep = sub.add_parser("report", help="chat cost per day (numbers only)")
    rep.add_argument("--days", type=int, default=7)
    rep.add_argument("--json", action="store_true")
    al = sub.add_parser("alerts", help="check, store and send ops alerts")
    al.add_argument("--no-send", action="store_true", help="store only, do not send")
    args = parser.parse_args(argv)
    s = get_settings()
    maker = get_sessionmaker()
    if args.cmd == "report":
        reports = await build_report(maker, s, days=args.days)
        print(reports_json(reports) if args.json else render_table(reports))
        return 0
    notifier = None if args.no_send else _telegram_notifier(s)
    alerts = await check_alerts(maker, s, notifier=notifier, send=not args.no_send)
    for a in alerts:
        print(f"{a.kind}\t{a.dedup_key}")
    return 0


def main(argv: list[str] | None = None) -> int:
    from assistant.logs import configure_logging

    configure_logging()
    return asyncio.run(_main(argv))


if __name__ == "__main__":
    raise SystemExit(main())
