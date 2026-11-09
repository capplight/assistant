"""The shared vectors of «Расходы» (docs/spec/vectors/amounts.json, calc.json): the phone's ports
run the same files. Pure code, no DB, no network."""

import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from assistant.expenses import amounts, calc
from assistant.expenses.parse import rules_parse

ROOT = Path(__file__).parents[2]
AMOUNTS = json.loads((ROOT / "docs/spec/vectors/amounts.json").read_text(encoding="utf-8"))
CALC = json.loads((ROOT / "docs/spec/vectors/calc.json").read_text(encoding="utf-8"))
TODAY = date.fromisoformat(AMOUNTS["today"])


def test_at_least_200_shared_phrase_vectors():
    assert len(AMOUNTS["vectors"]) >= 200
    assert sum(1 for v in AMOUNTS["vectors"] if v["expect"] is None) >= 30  # code must not guess


@pytest.mark.parametrize("v", AMOUNTS["vectors"], ids=lambda v: v["text"][:40])
def test_rules_reader_vector(v):
    d = rules_parse(v["text"], TODAY, on_page=v.get("on_page", False))
    e = v["expect"]
    if e is None:
        assert d is None, d
        return
    assert d is not None
    got = {"amount": f"{d.amount:.2f}", "currency": d.currency,
           "spent_on": (d.spent_on or TODAY).isoformat(), "category": d.category_key,
           "method": d.method, "direction": str(d.direction), "note": d.note}  # fmt: skip
    want = {"spent_on": TODAY.isoformat(), **e}
    assert {k: got[k] for k in want} == want


@pytest.mark.parametrize("v", [v for v in AMOUNTS["vectors"] if v["expect"]],
                         ids=lambda v: v["text"][:40])  # fmt: skip
def test_the_amount_is_found_in_the_words(v):
    """The model's reading is checked with `said`: the right amount must always pass it."""
    found = amounts.said(v["text"], Decimal(v["expect"]["amount"]))
    assert found is not None
    assert (found.currency or "KZT") == v["expect"]["currency"]


def test_a_number_not_in_the_words_does_not_pass():
    assert amounts.said("потратил 5000 на бензин", Decimal("50000")) is None
    assert amounts.said("потратил 1200 и 350", Decimal("1550")) is None  # never added up
    assert amounts.said("позвонить Ерлану", Decimal("1")) is None


@pytest.mark.parametrize("v", CALC["expressions"], ids=lambda v: v["expr"] or "empty")
def test_expression_vector(v):
    if isinstance(v["expect"], dict):
        with pytest.raises(calc.CalcError) as err:
            calc.evaluate(v["expr"])
        assert err.value.code == v["expect"]["error"]
    else:
        r = calc.evaluate(v["expr"])
        assert f"{r.amount:.2f}" == v["expect"]
        assert r.canonical == v["canonical"]


def _row(r: dict) -> calc.Row:
    return calc.Row(id=r["id"], amount=Decimal(r["amount"]), currency=r["currency"],
                    direction=r["direction"], spent_on=date.fromisoformat(r["spent_on"]),
                    category=r.get("category"), service=r.get("service", False),
                    payee=r.get("payee"), method=r.get("method"), review=r.get("review", False),
                    deleted=r.get("deleted", False))  # fmt: skip


@pytest.mark.parametrize("v", CALC["aggregates"], ids=lambda v: v["name"])
def test_aggregate_vector(v):
    res = calc.aggregate([_row(r) for r in v["rows"]], group_by=v["group_by"])
    got = {
        "totals": [{"currency": t.currency, "total": f"{t.total:.2f}",
                    "expense": f"{t.expense:.2f}", "refund": f"{t.refund:.2f}",
                    "income": f"{t.income:.2f}", "count": t.count} for t in res.totals],
        "groups": [{"key": g.key, "currency": g.currency, "total": f"{g.total:.2f}",
                    "count": g.count} for g in res.groups],
        "review_count": res.review_count, "basis": res.basis,
    }  # fmt: skip
    assert got == v["expect"]
    assert res.calc_version == CALC["calc_version"]


@pytest.mark.parametrize("v", CALC["periods"], ids=lambda v: f"{v['kind']}-{v['date']}")
def test_period_vector(v):
    lo, hi = calc.period_bounds(v["kind"], date.fromisoformat(v["date"]))
    assert [lo.isoformat() if lo else None, hi.isoformat() if hi else None] == [v["from"], v["to"]]


@pytest.mark.parametrize("v", CALC["format"], ids=lambda v: v["text"])
def test_format_vector(v):
    assert calc.format_money(Decimal(v["amount"]), v["currency"]) == v["text"]


def test_custom_period_needs_both_ends():
    with pytest.raises(ValueError):
        calc.period_bounds("custom", TODAY, start=TODAY, end=None)
    assert calc.period_bounds("custom", TODAY, start=date(2026, 9, 1),
                              end=TODAY) == (date(2026, 9, 1), TODAY)  # fmt: skip
