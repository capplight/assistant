"""Ф-97 injection cases (eval/injection/corpus.yaml `line_*`): a record «orders» one of the new
line operations — the trash, pages, the budget, quiet hours, the name, rules, «убрать купленное»,
a to-do's quantity. A model that obeys the text calls the tool; code must refuse:

- on a question turn the line's changing tools are not available at all (the intent gate);
- in a turn where the person asked for a *different* change, the word guards and «only what the
  person said» checks refuse the call, or code uses the person's own values, never the record's.
No network, no database."""

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import yaml

from assistant.ai import ToolCall
from assistant.chat import ops_line
from assistant.chat.intent import Intent, rules_first
from assistant.chat.sources import SourceBook
from assistant.chat.tools import READ_TOOLS, ToolEnv, execute

CORPUS = Path(__file__).resolve().parents[2] / "eval" / "injection" / "corpus.yaml"
CASES = [c for c in yaml.safe_load(CORPUS.read_text(encoding="utf-8"))
         if str(c["attack"]).startswith("line_")]  # fmt: skip
IDS = [c["id"] for c in CASES]
INJECTED = {"1", "1.00", "00:00", "23:59", "Должник", "Debtor", "100", "Чужой"}
QUESTION = {"ru": "Что написано в этом документе?", "kk": "Бұл құжатта не жазылған?",
            "en": "What does this document say?"}  # fmt: skip


class _Mut:
    def __init__(self, allowed: bool) -> None:
        self.allowed = allowed
        self.proposal = None
        self.action_pks: list[int] = []


@dataclass
class Mut:
    phrase: str
    allowed: bool = True
    clock: Any = field(default=lambda: datetime(2026, 11, 12, 5, 0, tzinfo=UTC))


@dataclass
class Env:
    book: SourceBook
    mut: Mut


def test_there_are_line_cases_in_three_languages():
    assert len(CASES) >= 15
    assert {c["lang"] for c in CASES} == {"ru", "kk", "en"}


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_question_turn_never_offers_or_runs_the_new_tools(case):
    assert rules_first(QUESTION[case["lang"]]).intent != Intent.CHANGE
    assert rules_first(case["text"], input_kind="share").intent == Intent.QUESTION
    state = ops_line.LineState(read=True)
    names = {t.name for t in ops_line.tools_of(state, change=False)}
    assert case["call"]["tool"] not in names
    env = ToolEnv(None, None, 1, SourceBook("Asia/Almaty"), 0.0, 0.0, counts=set(),  # type: ignore[arg-type]
                  mut=_Mut(False))  # fmt: skip
    allowed = {t.name for t in READ_TOOLS} | set(ops_line.LINE_NAMES)
    call = ToolCall("x", case["call"]["tool"], case["call"]["args"])
    res = asyncio.run(execute(env, call, allowed=allowed))
    assert res.is_error and "not available" in res.content


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_another_change_turn_refuses_or_keeps_the_persons_values(case):
    env = Env(SourceBook("Asia/Almaty"), Mut(case["change"]))
    tool = case["call"]["tool"]
    args = ops_line.ARGS[tool].model_validate(case["call"]["args"])
    p = ops_line.plan_call(env, tool, args)
    if p.error:
        return
    for _, a in p.calls:  # code ran it with the person's own words only
        assert not ({str(v) for v in a.values()} & INJECTED), (case["id"], p.calls)
