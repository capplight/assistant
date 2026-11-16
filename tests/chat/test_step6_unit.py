"""Step 6 (no database): splitting a phrase of several things, the cap of changes per phrase."""

import asyncio

import pytest

from assistant.ai import ToolCall
from assistant.chat.intent import split_parts
from assistant.chat.mutate import MAX_ACTIONS_PER_PHRASE, MutationState
from assistant.chat.sources import SourceBook
from assistant.chat.tools import ToolEnv, execute


@pytest.mark.parametrize(("phrase", "parts"), [
    ("купил хлеб за 400 и молоко за 600, и напомни оплатить свет",
     ["купил хлеб за 400", "купил молоко за 600", "напомни оплатить свет"]),
    ("запиши купить краску, напомни в 9 позвонить Ерлану",
     ["запиши купить краску", "напомни в 9 позвонить Ерлану"]),
    ("потратил 5000 на бензин и 2000 на обед",
     ["потратил 5000 на бензин", "потратил 2000 на обед"]),
    ("купить хлеб и молоко", ["купить хлеб и молоко"]),  # one list: the list reader splits it
    ("купить хлеб, молоко, сыр", ["купить хлеб, молоко, сыр"]),
    ("напомни завтра в 9 позвонить маме", ["напомни завтра в 9 позвонить маме"]),
    ("где ключи, и что купить?", ["где ключи, и что купить?"]),
])  # fmt: skip
def test_split_parts(phrase, parts):
    assert split_parts(phrase) == parts


def test_too_many_parts_stay_one_phrase():
    phrase = ", ".join(f"запиши дело {i}" for i in range(10))
    assert split_parts(phrase) == [phrase]


def test_changes_per_phrase_are_capped():
    m = MutationState(allowed=True, user_id=1, lang="ru", phrase="удали всё", reply_pk=1,
                      page=None, selected=None, deictic=False, emit=lambda *_: None)
    m.action_pk, m.more_action_pks = 1, list(range(2, MAX_ACTIONS_PER_PHRASE + 1))
    env = ToolEnv(None, None, 1, SourceBook("Asia/Almaty"), 0.5, 0.45, counts=set(), mut=m)  # type: ignore[arg-type]
    call = ToolCall("x", "update", {"records": ["s1"], "title": None, "trash": True})
    res = asyncio.run(execute(env, call, allowed={"update"}))
    assert res.is_error and f"at most {MAX_ACTIONS_PER_PHRASE} changes" in res.content
