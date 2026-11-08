"""DUP_JUDGE (spec 6.3 p. 2): two records, is the second a repeat of the first? Only borderline
pairs come here; the router checks consent and the budget. Both texts are untrusted data."""

from typing import Literal

from pydantic import BaseModel

from assistant.ai import LLMTask, Router, TaskInputs, UntrustedPart

PROMPT_VERSION = "dup_judge.v1"
MAX_CHARS = 1500  # per record: enough to tell, cheap
SYSTEM = (
    "You compare two records from one person's notes app and say whether they are the same "
    "note saved twice. Answer `same` when they say the same thing (wording, typos, order, "
    "extra greeting or signature may differ). Answer `newer_version` when the second is an "
    "updated version of the same document with changed facts (a quote v2 with other prices, a "
    "list with other items, a different date or amount). Answer `different` when they are about "
    "different things or differ in a fact that matters (a date, a sum, a person, a code). When "
    "unsure, answer `different`."
)
INSTRUCTION = "Compare record A and record B."


class DupVerdict(BaseModel):
    verdict: Literal["same", "different", "newer_version"]


def inputs(a: str, b: str) -> TaskInputs:
    return TaskInputs(system=SYSTEM, instruction=INSTRUCTION,
                      untrusted=[UntrustedPart("record A", a[:MAX_CHARS]),
                                 UntrustedPart("record B", b[:MAX_CHARS])],
                      prompt_version=PROMPT_VERSION)  # fmt: skip


async def judge(router: Router, user_id: int, a: str, b: str,
                job_id: int | None = None) -> tuple[str, str, float]:  # fmt: skip
    """(verdict, model, cost). Raises the router's errors (consent, budget, outage)."""
    result = await router.run(LLMTask.DUP_JUDGE, DupVerdict, inputs(a, b), user_id=user_id,
                              job_id=job_id)  # fmt: skip
    assert result.data is not None
    return result.data.verdict, result.model, float(result.cost_usd)
