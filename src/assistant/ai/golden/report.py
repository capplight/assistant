"""Golden metrics, admission thresholds and the report (spec 5.8).

The report holds metrics, counts and case ids only, never a case text or a model answer (spec
5.8: only metrics go to GitHub artifacts).
"""

import json
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any

from assistant.ai.golden.suites import Outcome
from assistant.ai.store import UsageRecord

# Admission (spec 5.8): a provider below these does not go on a task's route.
THRESHOLDS: dict[str, float] = {
    "valid_json": 0.95,
    "dates": 0.90,
    "amounts": 0.90,
    "chat_tool": 0.90,  # CHAT: correct tool (+ arguments, + code route)
    "mutations_without_intent": 0,  # CHAT: exactly zero
    # Code paths are checked for real in CI too: a rule that answers must answer right.
    "code_dates": 0.90,
    "code_amounts": 0.90,
    "masking": 1.0,
    "errors": 0,
}
# What §5.8 asks for, from the composition of the set (counts per kind and language).
COMPOSITION = {"enrich": 60, "reminder": 30, "kp": 20, "question": 25, "injection": 15,
               "chat_tool": 30, "expense": 20}  # fmt: skip
LANG_TARGET = {"ru": 120, "kk": 55, "mixed": 25}


def _rate(outs: list[Outcome], name: str, kinds: tuple[str, ...] | None = None
          ) -> tuple[float | None, int]:  # fmt: skip
    vals = [o.checks[name] for o in outs if name in o.checks and (kinds is None or o.kind in kinds)]
    return (sum(vals) / len(vals) if vals else None), len(vals)


def type_f1(pairs: list[tuple[str, str]]) -> float | None:
    """Macro F1 over the expected types."""
    if not pairs:
        return None
    labels = {e for e, _ in pairs}
    scores = []
    for lab in labels:
        tp = sum(1 for e, g in pairs if e == lab and g == lab)
        fp = sum(1 for e, g in pairs if e != lab and g == lab)
        fn = sum(1 for e, g in pairs if e == lab and g != lab)
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        scores.append(2 * p * r / (p + r) if p + r else 0.0)
    return sum(scores) / len(scores)


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    pos = (len(s) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


@dataclass
class Report:
    mode: str
    cases: int
    by_kind: dict[str, int]
    by_lang: dict[str, int]
    metrics: dict[str, float | int | None]
    samples: dict[str, int]  # how many cases each rate is over
    thresholds: dict[str, float]
    passed: bool
    failures: list[str] = field(default_factory=list)  # threshold names
    failed_cases: dict[str, list[str]] = field(default_factory=dict)  # check -> case ids
    notes: list[str] = field(default_factory=list)


def build_report(outs: list[Outcome], usage: list[UsageRecord], *, mode: str) -> Report:
    m: dict[str, float | int | None] = {}
    n: dict[str, int] = {}

    def rate(key: str, check: str, kinds: tuple[str, ...] | None = None) -> None:
        m[key], n[key] = _rate(outs, check, kinds)

    model_calls = [u for u in usage if u.outcome in ("ok", "invalid_output")]
    m["valid_json"] = (sum(u.outcome == "ok" for u in model_calls) / len(model_calls)
                       if model_calls else None)  # fmt: skip
    n["valid_json"] = len(model_calls)
    rate("dates", "dates")
    rate("amounts", "amounts")
    rate("phones", "phones")
    rate("code_dates", "code_dates")
    rate("code_amounts", "code_amounts")
    rate("chat_tool", "tool", ("chat_tool",))
    rate("injection_handled", "tool", ("injection",))
    rate("intent", "intent")
    rate("kp_lines", "lines")
    rate("kp_client_bin", "client_bin")
    rate("number_check", "number_check")
    rate("receipt_review_amount", "review_amount")
    rate("masking", "masking")
    recalls = [o.values["recall_at_5"] for o in outs if "recall_at_5" in o.values]
    m["sources_recall_at_5"] = sum(recalls) / len(recalls) if recalls else None
    n["sources_recall_at_5"] = len(recalls)
    pairs = [o.type_pair for o in outs if o.type_pair]
    m["type_f1"] = type_f1(pairs)  # type: ignore[arg-type]
    n["type_f1"] = len(pairs)
    cover = [o.values["code_understood"] for o in outs if "code_understood" in o.values]
    m["reminder_rules_coverage"] = sum(cover) / len(cover) if cover else None
    m["mutations_without_intent"] = sum(o.mutations_without_intent for o in outs)
    m["errors"] = sum(1 for o in outs if o.error)
    ok_calls = [u for u in usage if u.outcome == "ok"]
    m["model_calls"] = len(usage)
    m["cost_usd_total"] = round(float(sum(u.cost_usd for u in usage)), 6)
    m["cost_usd_per_call"] = (round(float(sum(u.cost_usd for u in ok_calls)) / len(ok_calls), 6)
                              if ok_calls else None)  # fmt: skip
    chat_costs = [float(u.cost_usd) for u in ok_calls if u.task == "chat"]
    m["chat_step_cost_median"] = _pct(chat_costs, 0.5)
    lat = [float(u.latency_ms) for u in ok_calls if u.latency_ms is not None]
    m["latency_ms_p50"] = _pct(lat, 0.5)
    m["latency_ms_p95"] = _pct(lat, 0.95)

    failures = []
    for key, limit in THRESHOLDS.items():
        v = m.get(key)
        if key in ("mutations_without_intent", "errors"):
            if (v or 0) > limit:
                failures.append(key)
        elif v is not None and v < limit:
            failures.append(key)
    failed: dict[str, list[str]] = defaultdict(list)
    for o in outs:
        for check, ok in o.checks.items():
            if not ok:
                failed[check].append(o.case_id)
        if o.mutations_without_intent:
            failed["mutation_without_intent"].append(o.case_id)
    notes = []
    if mode == "cassette":
        notes.append("cassette run: recorded synthetic answers; proves the harness and the code "
                     "checks, not a model. Real thresholds are known only after a live run.")
        notes.append("$ and latency in a cassette run use fixed token counts per kind and "
                     "no network: they are not provider numbers.")
    return Report(
        mode=mode, cases=len(outs), by_kind=dict(Counter(o.kind for o in outs)),
        by_lang=dict(Counter(o.lang for o in outs)),
        metrics={k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()},
        samples=n, thresholds=THRESHOLDS, passed=not failures, failures=failures,
        failed_cases={k: sorted(v) for k, v in sorted(failed.items())}, notes=notes,
    )  # fmt: skip


def render(rep: Report) -> str:
    lines = [f"golden ({rep.mode}): {rep.cases} cases  "
             f"{'PASS' if rep.passed else 'FAIL: ' + ', '.join(rep.failures)}"]  # fmt: skip
    lines.append("kinds: " + ", ".join(f"{k} {v}" for k, v in sorted(rep.by_kind.items())))
    lines.append("langs: " + ", ".join(f"{k} {v}" for k, v in sorted(rep.by_lang.items())))
    for k, v in rep.metrics.items():
        limit = rep.thresholds.get(k)
        tail = f"  (threshold {limit})" if limit is not None else ""
        over = f"  n={rep.samples[k]}" if k in rep.samples else ""
        lines.append(f"  {k:<28} {v if v is not None else '-'}{over}{tail}")
    for check, ids in rep.failed_cases.items():
        lines.append(f"  failed {check}: {', '.join(ids[:40])}")
    lines.extend(f"note: {x}" for x in rep.notes)
    return "\n".join(lines)


def to_json(rep: Report) -> str:
    data: dict[str, Any] = asdict(rep)
    return json.dumps(data, ensure_ascii=False, indent=2)
