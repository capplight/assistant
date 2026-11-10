"""The VAT rate by date (spec 6.7 step 4, Ф-18). The rate is never written in code: it comes from
`settings.kp_vat_rates`, a list of `{rate, from}` (the newest `from` on or before the КП's date
wins), so a change of the law is a new row, and an old КП keeps the rate of its own date. Each
version stores the rate it was computed with (`document_versions.vat_rate`).

Ф-18 (founder, 2026-11-10): 16% for Kazakhstan, confirmed. Still open: the rules for an ИП that
works without VAT; the «без НДС» mode stays available (and is the default for a seller that is not
a VAT payer, `company_profiles.vat_payer = false`).
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from assistant.kp.calc import VAT_MODES


class VatConfigError(ValueError):
    pass


@dataclass(frozen=True)
class RateRow:
    rate: Decimal
    since: date


def parse_rates(rows: list[dict[str, Any]]) -> list[RateRow]:
    out = []
    for row in rows:
        try:
            rate = Decimal(str(row["rate"]))
            since = date.fromisoformat(str(row["from"]))
        except (KeyError, ValueError, InvalidOperation) as exc:
            raise VatConfigError(f"bad vat rate row: {row!r}") from exc
        if not rate.is_finite() or rate < 0 or rate >= 100:
            raise VatConfigError(f"vat rate out of range: {row!r}")
        out.append(RateRow(rate, since))
    if not out:
        raise VatConfigError("no vat rates configured")
    return sorted(out, key=lambda r: r.since)


def rate_on(rows: list[dict[str, Any]], day: date) -> Decimal:
    """The rate in force on `day`. A day before the first row is a config error (we do not guess
    an older rate)."""
    found = None
    for row in parse_rates(rows):
        if row.since <= day:
            found = row
    if found is None:
        raise VatConfigError(f"no vat rate for {day.isoformat()}")
    return found.rate


def default_mode(vat_payer: bool | None, configured: str) -> str:
    """A seller that is not a VAT payer: «без НДС». Else the configured default («в сумме»)."""
    if vat_payer is False:
        return "none"
    if configured not in VAT_MODES:
        raise VatConfigError(f"unknown vat mode {configured!r}")
    return configured


__all__ = ["RateRow", "VatConfigError", "default_mode", "parse_rates", "rate_on"]
