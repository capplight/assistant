"""Ф-95 phase 1 golden set (`eval/golden_ops/chat_ops.yaml`, chat-full-control.md §5): each
phrase goes through the same code the line runs — the code reader (`read_code` / `plan_code`), the
domain choice (`domains_for`), and for a model case the call the model gave (a cassette), checked
by `plan_call` — and must give the expected operation, object and arguments. Metrics: operation
accuracy (all must pass), false changes = 0 (no question / refused case runs an operation).
Offline: no DB, no model, a fixed clock (Thu 12 Nov 2026 10:00 Almaty)."""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

from assistant.chat import ops_line
from assistant.chat.intent import Intent, asks_assistant, rules_first, undo_phrase
from assistant.chat.sources import Obj, SourceBook

DATA = Path(__file__).resolve().parents[2] / "eval" / "golden_ops" / "chat_ops.yaml"
TZ = ZoneInfo("Asia/Almaty")
NOW = datetime(2026, 11, 12, 10, 0, tzinfo=TZ).astimezone(UTC)


def cases() -> list[dict[str, Any]]:
    return yaml.safe_load(DATA.read_text(encoding="utf-8"))


@dataclass
class Mut:
    phrase: str
    allowed: bool = True
    clock: Any = field(default=lambda: NOW)


@dataclass
class Env:
    book: SourceBook
    mut: Mut


def build(case: dict[str, Any]) -> tuple[Env, list[Obj], dict[uuid.UUID, str]]:
    book = SourceBook("Asia/Almaty")
    objs: list[Obj] = []
    titles: dict[uuid.UUID, str] = {}
    for o in case.get("objects") or []:
        oid = uuid.uuid4()
        titles[oid] = o["title"]
        at = datetime.strptime(o["at"], "%Y-%m-%d %H:%M").replace(tzinfo=TZ).astimezone(UTC) \
            if o.get("at") else None  # fmt: skip
        kind = o["kind"]
        if kind == "page":  # Ф-97: a live page (code reads pages by title)
            objs.append(Obj("", "page", oid, o["title"], o["title"]))
            continue
        objs.append(book.add_obj(
            kind, oid, o["title"], o["title"], start=at, repeat=bool(o.get("repeat")),
            duration_min=o.get("duration"),
            occurrence_at=at if o.get("repeat") else None, done=bool(o.get("done")),
            list_key=o.get("list") or ("todo" if kind in ("task", "event") else None),
            data={"amount": o.get("amount"), "what": o.get("what", "item"),
                  "qty": o.get("qty"), "version": o.get("version")}))  # fmt: skip
    return Env(book, Mut(case["phrase"])), objs, titles


def _local(value: Any) -> str | None:
    if not isinstance(value, datetime):
        return None
    return value.astimezone(TZ).strftime("%Y-%m-%d %H:%M")


def check_planned(p: ops_line.Planned, exp: dict[str, Any], titles: dict[uuid.UUID, str],
                  phrase: str, *, yes: bool | None = None) -> list[str]:  # fmt: skip
    bad: list[str] = []
    if exp.get("ask"):
        if p.ask is None or not p.choices:
            bad.append("expected a question with choices")
        elif exp.get("op") and p.choices[0][1][0][0] != exp["op"]:
            bad.append(f"op {p.choices[0][1][0][0]}")
        return bad
    if p.ask is not None:
        return [f"asked {p.ask!r}"]
    if exp.get("note"):  # nothing to do, said honestly: no operation runs
        return [] if p.note and exp["note"] in p.note else [f"note {p.note!r}"]
    if not p.calls:
        return ["no operation"]
    name, args = p.calls[0]
    if name != exp["op"]:
        bad.append(f"op {name}")
    target = exp.get("target")
    if target is not None:
        got = titles.get(args.get("task_id") or args.get("reminder_id") or args.get("expense_id")
                         or args.get("page_id") or args.get("habit_id")
                         or (args.get("item_ids") or [None])[0])
        if got != target:
            bad.append(f"target {got}")
    for k, v in (exp.get("args") or {}).items():
        if str(args.get(k)) != str(v) and not (isinstance(v, bool) and args.get(k) is v):
            bad.append(f"{k}={args.get(k)}")
    if exp.get("local") is not None:
        got = _local(args.get("start_at") or args.get("due_at"))
        if got != exp["local"]:
            bad.append(f"local {got}")
    if exp.get("count") is not None and p.count != exp["count"]:
        bad.append(f"count {p.count}")
    if exp.get("many") and p.many is None:
        bad.append("not one action for all")
    want_yes = bool(exp.get("confirm"))
    got_yes = ops_line.needs_yes(p, phrase) if yes is None else yes
    if want_yes != got_yes:
        bad.append(f"yes {got_yes}")
    return bad


def run_case(case: dict[str, Any]) -> tuple[list[str], bool]:
    """(problems, changed): `changed` = an operation would run (for the false-change metric)."""
    exp, phrase = case["expect"], case["phrase"]
    route = exp["route"]
    env, objs, titles = build(case)
    if route in ("assistant", "not_assistant"):
        want = route == "assistant"
        ok = asks_assistant(phrase) == want and (
            not want or rules_first(phrase).intent == Intent.QUESTION)
        return ([] if ok else [f"asks_assistant={asks_assistant(phrase)}"]), False
    reading = rules_first(phrase)
    ask = ops_line.read_code(phrase)
    if route == "reads":  # Ф-97: what code reads (an operation that needs the DB to plan)
        got = (ask.kind, ask.value) if ask is not None else None
        want = (exp["kind"], str(exp.get("value", "")))
        return ([] if got == want else [f"read {got}"]), False
    if route == "free":  # Ф-97: free windows of a day, by code
        day = datetime.strptime(exp["day"], "%Y-%m-%d").date()
        wins = ops_line.free_windows(objs, day, TZ, NOW.astimezone(TZ).replace(tzinfo=None))
        got = [f"{a:%H:%M}-{b:%H:%M}" for a, b in wins]
        return ([] if got == exp["windows"] else [f"windows {got}"]), False
    if route in ("code", "none"):
        plan = ops_line.plan_code(env, ask, objs) if ask is not None else None  # type: ignore[arg-type]
        if exp.get("not_undo") and undo_phrase(phrase) is not None:
            return ["read as an undo"], False
        if exp.get("purchase") and ops_line.purchase_of(phrase) != exp["purchase"]:
            return [f"purchase {ops_line.purchase_of(phrase)}"], False
        if route == "none":
            return ([] if plan is None else [f"code took it: {plan.calls or plan.ask}"]), False
        if plan is None:
            return [f"code did not take it ({ask})"], False
        bulk = ask is not None and (ask.all_of_day or ask.kind == "cleanup")
        return check_planned(plan, exp, titles, phrase,
                             yes=True if bulk else None), not exp.get("note")  # type: ignore[union-attr]
    call = case["call"]
    if route == "question":
        problems = []
        if reading.intent == Intent.CHANGE:
            problems.append("read as a change")
        read = ops_line.read_domains_for(phrase)
        if read != (exp.get("read") or []):
            problems.append(f"read domains {read}")
        state = ops_line.LineState(read=bool(read))
        names = {t.name for t in ops_line.tools_of(state, change=False)}
        if call["tool"] in names:
            problems.append(f"{call['tool']} offered on a question")
        return problems, False
    if reading.intent != Intent.CHANGE:
        return [f"intent {reading.intent}"], False
    domains = ops_line.domains_for(phrase)
    if exp.get("domains") and domains != exp["domains"]:
        return [f"domains {domains}"], False
    if route == "refused" and call["tool"] not in domains:
        return [], False  # the tool was not even offered
    if call["tool"] not in domains:
        return [f"{call['tool']} not offered ({domains})"], False
    args = ops_line.ARGS[call["tool"]].model_validate(call["args"])
    p = ops_line.plan_call(env, call["tool"], args)
    if route == "refused":
        return ([] if p.error else [f"not refused: {p.calls}"]), not p.error
    if p.error:
        return [f"error {p.error}"], False
    return check_planned(p, exp, titles, phrase), True


def test_golden_ops_set_composition() -> None:
    got = cases()
    assert len(got) >= 80
    assert len({c["id"] for c in got}) == len(got)
    routes = [c["expect"]["route"] for c in got]
    assert routes.count("code") >= 25 and routes.count("model") >= 12
    assert routes.count("assistant") >= 15 and routes.count("question") >= 5


def test_golden_ops_pass_with_no_false_changes() -> None:
    failures: dict[str, list[str]] = {}
    false_changes = 0
    passed = 0
    for case in cases():
        problems, changed = run_case(case)
        if case["expect"]["route"] in ("question", "refused", "none") and changed:
            false_changes += 1
        if problems:
            failures[case["id"]] = problems
        else:
            passed += 1
    accuracy = Decimal(passed) / Decimal(len(cases()))
    assert failures == {}, failures
    assert false_changes == 0
    assert accuracy == 1


def test_no_irreversible_operation_is_offered_to_the_line() -> None:
    from assistant import operations

    for domain in ops_line.DOMAINS:
        spec = ops_line.domain_spec(domain)
        assert spec.name == domain and "ops:" in spec.description
        for names in ops_line.LINE_OPS[domain].values():
            for n in names:
                assert operations.get(n).risk != "irreversible"
                assert operations.get(n).description in spec.description
