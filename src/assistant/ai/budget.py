"""Budgets (spec 5.3 / 5.4, 02-resolutions 2.2).

Per user, by users.profile:
- family_beta: no limits; alert when a day passes budget_family_alert_daily_usd.
- regular: background has a soft daily cap ("продолжу завтра"); every class draws on one
  monthly hard wallet ($3).
- work: same soft daily cap for background; monthly hard wallet $8; `documents` is a separate
  monthly wallet with no daily threshold.
- import: one-off wallet ($1) for regular/work.
At budget_escalation_cutoff (80%) of the relevant monthly wallet: no escalation to strong
models. A started document task (`continuing=True`) is never cut off.

Per provider (our money): monthly cap; >= 80% -> moved to the end of the route; >= 100% -> off
until the 1st. Non-primary providers also share a daily emergency cap. Quota/402 switches a
provider off until a manual reset (store.set_provider_off / clear_provider_off).
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from assistant.ai.store import (
    ALL,
    EPOCH,
    AIStore,
    BudgetKey,
    Period,
    Scope,
    SpendAdd,
    period_starts,
)
from assistant.ai.types import BudgetClass, BudgetExceeded
from assistant.config import Settings
from assistant.db.models_v2 import UserProfile

log = logging.getLogger(__name__)

Alert = Callable[[str], None]


def log_alert(message: str) -> None:
    log.warning("AI ALERT: %s", message)


def _d(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(str(value))


@dataclass(frozen=True)
class ProfileLimits:
    background_daily_soft: Decimal | None
    monthly_hard: Decimal | None
    documents_separate: bool
    documents_monthly: Decimal | None
    import_once: Decimal | None
    alert_daily: Decimal | None


@dataclass(frozen=True)
class UserDecision:
    escalation_allowed: bool
    warning: bool  # past the 80% mark of the wallet that applies


@dataclass(frozen=True)
class ProviderPlan:
    order: list[str]
    excluded: dict[str, str]  # provider -> reason


class BudgetPolicy:
    def __init__(self, settings: Settings, store: AIStore, *, alert: Alert = log_alert) -> None:
        self.s = settings
        self.store = store
        self.alert = alert
        self.cutoff = Decimal(str(settings.budget_escalation_cutoff))

    # --- profiles ---

    def limits(self, profile: str | None) -> ProfileLimits:
        s = self.s
        if profile == UserProfile.FAMILY_BETA:
            return ProfileLimits(None, None, False, None, None,
                                 _d(s.budget_family_alert_daily_usd))  # fmt: skip
        if profile == UserProfile.WORK:
            return ProfileLimits(
                _d(s.budget_work_background_daily_usd), _d(s.budget_work_monthly_usd), True,
                _d(s.budget_work_documents_monthly_usd), _d(s.budget_import_once_usd), None,
            )  # fmt: skip
        # regular, and anything unknown: the strictest paid-user rules
        return ProfileLimits(_d(s.budget_regular_background_daily_usd),
                             _d(s.budget_regular_monthly_usd), False, None,
                             _d(s.budget_import_once_usd), None)  # fmt: skip

    def _keys(self, user_id: int, cls: BudgetClass, now: datetime) -> dict[str, BudgetKey]:
        day, month = period_starts(now, self.s.budget_tz)
        uid = str(user_id)
        return {
            "cls_day": BudgetKey(Scope.USER, uid, cls.value, Period.DAY, day),
            "cls_month": BudgetKey(Scope.USER, uid, cls.value, Period.MONTH, month),
            "all_day": BudgetKey(Scope.USER, uid, ALL, Period.DAY, day),
            "all_month": BudgetKey(Scope.USER, uid, ALL, Period.MONTH, month),
            "import": BudgetKey(Scope.USER, uid, BudgetClass.IMPORT.value, Period.ONCE, EPOCH),
        }

    async def check_user(
        self, user_id: int, profile: str | None, cls: BudgetClass, now: datetime,
        *, continuing: bool = False,
    ) -> UserDecision:  # fmt: skip
        lim = self.limits(profile)
        k = self._keys(user_id, cls, now)
        spent = await self.store.spent(list(k.values()))

        if cls is BudgetClass.IMPORT:
            if lim.import_once is not None and spent[k["import"]] >= lim.import_once:
                raise BudgetExceeded("import_once")
            return UserDecision(True, self._warn(spent[k["import"]], lim.import_once))

        if cls is BudgetClass.DOCUMENTS and lim.documents_separate:
            used, cap = spent[k["cls_month"]], lim.documents_monthly
            if cap is not None and used >= cap and not continuing:
                raise BudgetExceeded("documents_monthly")
            return UserDecision(self._escalate(used, cap), self._warn(used, cap))

        used, cap = spent[k["all_month"]], lim.monthly_hard
        exempt = continuing and cls is BudgetClass.DOCUMENTS
        if cap is not None and used >= cap and not exempt:
            raise BudgetExceeded("monthly_hard")
        if (cls is BudgetClass.BACKGROUND and lim.background_daily_soft is not None
                and spent[k["cls_day"]] >= lim.background_daily_soft):
            raise BudgetExceeded("daily_soft")  # fmt: skip
        return UserDecision(self._escalate(used, cap), self._warn(used, cap))

    def _escalate(self, used: Decimal, cap: Decimal | None) -> bool:
        return cap is None or used < cap * self.cutoff

    def _warn(self, used: Decimal, cap: Decimal | None) -> bool:
        return cap is not None and used >= cap * self.cutoff

    async def charge_user(
        self, user_id: int, profile: str | None, cls: BudgetClass, cost: Decimal, now: datetime
    ) -> None:
        if cost <= 0:
            return
        lim = self.limits(profile)
        k = self._keys(user_id, cls, now)
        adds = [SpendAdd(k["all_day"], cost, lim.alert_daily)]
        if cls is BudgetClass.IMPORT:
            adds.append(SpendAdd(k["import"], cost, lim.import_once))
        else:
            daily = lim.background_daily_soft if cls is BudgetClass.BACKGROUND else None
            adds.append(SpendAdd(k["cls_day"], cost, daily))
            separate = cls is BudgetClass.DOCUMENTS and lim.documents_separate
            adds.append(SpendAdd(k["cls_month"], cost, lim.documents_monthly if separate else None))
            if not separate:
                adds.append(SpendAdd(k["all_month"], cost, lim.monthly_hard))
        totals = await self.store.add_spend(adds)
        if lim.alert_daily is not None and _crossed(totals[k["all_day"]], cost, lim.alert_daily):
            self.alert(f"user {user_id} ({profile}) spent over ${lim.alert_daily} today")
        if lim.monthly_hard is not None and k["all_month"] in totals:
            if _crossed(totals[k["all_month"]], cost, lim.monthly_hard):
                log.info("user %s reached the monthly AI budget", user_id)

    # --- providers ---

    def provider_monthly_limit(self, provider: str) -> Decimal | None:
        caps = self.s.ai_provider_monthly_usd
        if provider in caps:
            return _d(caps[provider])
        primary = self.s.ai_primary_provider
        if provider != primary and primary in caps:
            return _d(caps[primary] * self.s.ai_fallback_share_of_primary)
        return None

    def _provider_keys(self, provider: str, now: datetime) -> tuple[BudgetKey, BudgetKey]:
        day, month = period_starts(now, self.s.budget_tz)
        return (BudgetKey(Scope.PROVIDER, provider, ALL, Period.MONTH, month),
                BudgetKey(Scope.FALLBACK_PROVIDER, provider, ALL, Period.DAY, day))  # fmt: skip

    async def provider_plan(self, chain: list[str], now: datetime) -> ProviderPlan:
        off = await self.store.providers_off()
        keys = {p: self._provider_keys(p, now) for p in chain}
        spent = await self.store.spent([k for pair in keys.values() for k in pair])
        emergency = _d(self.s.ai_fallback_emergency_daily_usd)
        first: list[str] = []
        tail: list[str] = []
        excluded: dict[str, str] = {}
        for p in chain:
            month_key, day_key = keys[p]
            cap = self.provider_monthly_limit(p)
            if p not in self.s.ai_providers_enabled:
                excluded[p] = "disabled"
            elif p in off:
                excluded[p] = "off:" + off[p]
            elif cap is not None and spent[month_key] >= cap:
                excluded[p] = "monthly_budget"
            elif (p != self.s.ai_primary_provider and emergency is not None
                  and spent[day_key] >= emergency):
                excluded[p] = "fallback_daily"  # fmt: skip
            elif cap is not None and spent[month_key] >= cap * Decimal("0.8"):
                tail.append(p)
            else:
                first.append(p)
        return ProviderPlan(first + tail, excluded)

    async def charge_provider(self, provider: str, cost: Decimal, now: datetime) -> None:
        if cost <= 0:
            return
        month_key, day_key = self._provider_keys(provider, now)
        cap = self.provider_monthly_limit(provider)
        adds = [SpendAdd(month_key, cost, cap)]
        fallback = provider != self.s.ai_primary_provider
        emergency = _d(self.s.ai_fallback_emergency_daily_usd)
        if fallback:
            adds.append(SpendAdd(day_key, cost, emergency))
        totals = await self.store.add_spend(adds)
        if cap is not None:
            if _crossed(totals[month_key], cost, cap):
                self.alert(f"{provider}: monthly budget ${cap} used up, off until the 1st")
            elif _crossed(totals[month_key], cost, cap * Decimal("0.8")):
                self.alert(f"{provider}: 80% of the monthly budget, moved to the end of routes")
        if fallback and emergency is not None and _crossed(totals[day_key], cost, emergency):
            self.alert(f"{provider}: fallback emergency daily limit ${emergency} reached; "
                       "raise it or wait for tomorrow")  # fmt: skip


def _crossed(total: Decimal, added: Decimal, threshold: Decimal) -> bool:
    return total - added < threshold <= total
