"""«Составь план» in the line (step 8, docs/api/plans.md).

- `asks_plan(phrase)`: code's guard on the person's own words («составь план», «распиши по
  дням», «разложи мои дела по …», «поменяй план»). Only then the chat model is offered
  `make_plan` (and told a plan is wanted); record text can never start one.
- `make_plan` (chat model tool): the model decides that the person wants a plan and of which kind
  (`trip` — by days, `actions` — steps), and what to look for; code searches the saved records,
  the light model (`LLMTask.PLAN`, bigger output cap) structures them, code checks the plan
  (assistant.plans.build), saves it as a record on «Заметки» with «Отменить» and sends the
  `plan` event (the «План» card). The turn ends there: no extra model step.
  With `plan` (a ref of a plan record shown), the same plan is changed; its old title and text
  stay in the action (`diff`, Ф-73 inline edit) and «Отменить» brings the old plan back.
- `to_tasks_phrase(phrase)`: «сделай делами» — the newest action plan (or the selected one)
  becomes tasks, as the card's «Сделать делами» (assistant.plans.make_tasks), by code.
"""

import json
import logging
import re
from datetime import date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel
from sqlalchemy import select

from assistant.ai import (
    AIConsentRequired,
    AIUnavailable,
    BudgetExceeded,
    LLMTask,
    Masker,
    StreamInterrupted,
    TaskInputs,
    ToolSpec,
    UntrustedPart,
)
from assistant.ai.adapters import strict_json_schema
from assistant.chat.verify import facts_of
from assistant.db.models import Item
from assistant.db.models_actions import ActionKind
from assistant.db.models_v2 import RecordKind
from assistant.plans import build as plan_build
from assistant.plans import service as plans

log = logging.getLogger(__name__)

SEARCH_LIMIT = 30  # records looked at for one plan
ACTIVITY = "Составляю план…"


def _norm(text: str) -> str:
    return " ".join(text.lower().replace("ё", "е").split())


_PLAN = re.compile(
    r"(?<!\w)(?:план\w*|спланир\w*|маршрут\w*|программ\w*\s+(?:поездк|отпуск|путешеств)\w*|"
    r"распиш\w*|по\s+дням|по\s+шагам|пошагов\w*|"
    r"разлож\w*\s+(?:\w+\s+){0,2}?дел[аио]?\w*\s+(?:по|на|для)\s+|"
    r"с\s+чего\s+начать|что\s+(?:мне\s+)?делать\s+по\s+порядку|жоспар\w*)", re.IGNORECASE)
_TO_TASKS = re.compile(
    r"^(?:пожалуйста[,\s]+)?(?:сдела(?:й|йте|ть)|преврат(?:и|ите)|переведи|занеси|перенеси)\s+"
    r"(?:(?:это|эти|их|его|план|шаги|пункты|всё|все)\s+)*(?:делами|в\s+дела)\b",
    re.IGNORECASE)  # fmt: skip
_QUESTION_ONLY = re.compile(r"^(?:что|какой|какие|где|когда)\b.*\bплан\w*\b.*\?$", re.IGNORECASE)

TEXT_NO_PLAN = ("Не нашёл плана с шагами. Скажите, например: «разложи мои дела по ремонту "
                "кухни».")
TEXT_NO_STEPS = "В этом плане нет шагов, которые можно сделать делами."
CONTEXT_LINE = ("План: человек просит составить или изменить план. Первым шагом вызови "
                "make_plan (kind trip — поездка по дням, actions — шаги дел, ремонт, переезд, "
                "несколько дел), даже если в записях мало: недостающее план дополнит сам. Не "
                "пиши план текстом и не отвечай, что в записях мало. Если план уже есть в "
                "записях и человек просит его поменять, передай его ref в `plan`; если выбранная "
                "запись — план, фраза о нём: поменяй его так, как просят.")


def asks_plan(text: str) -> bool:
    """The person's own words ask for a plan (or to change one)."""
    norm = _norm(text)
    return bool(_PLAN.search(norm)) and not _QUESTION_ONLY.match(norm)


def to_tasks_phrase(text: str) -> bool:
    """«сделай делами», «сделай это делами», «преврати план в дела»."""
    norm = _norm(text).strip(" .!")
    return len(norm) <= 80 and bool(_TO_TASKS.match(norm))


class MakePlanArgs(BaseModel):
    kind: Literal["trip", "actions"]
    topic: str
    title: str | None
    days: int | None
    start_date: str | None
    end_date: str | None
    plan: str | None = None


MAKE_PLAN = ToolSpec(
    name="make_plan",
    description=(
        "Make a plan from the person's saved records (and your knowledge for the gaps), saved as "
        "a record they can open; the app shows it as a card. Use it whenever the person asks to "
        "make, plan or lay out a trip or a set of things to do. kind: trip (a travel plan by "
        "days) or actions (ordered steps: repairs, a move, a project, several tasks). topic: the "
        "words to look for in their records (a city, «ремонт кухни»). title: a short title or "
        "null. days: how many days, only if the person said it, else null. start_date / "
        "end_date: YYYY-MM-DD only if the person said the dates, else null. plan: the ref (s3) "
        "of a plan record shown to you when the person asks to change that plan, else null. "
        "After it, say nothing more."
    ),
    parameters=strict_json_schema(MakePlanArgs),
)


def _json(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _said_date(value: str | None, phrase: str, today: date) -> date | None:
    """A date the model read from the phrase, kept only if the phrase says it (or «завтра»)."""
    if not value:
        return None
    try:
        d = date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None
    said = facts_of(phrase)
    if any(sd == d.day and sm == d.month for sd, sm, _ in said.dates):
        return d
    # «10–11 декабря»: the first day of a range is a bare number before the month's date
    from decimal import Decimal

    if Decimal(d.day) in said.numbers and any(sm == d.month for _, sm, _ in said.dates):
        return d
    norm = _norm(phrase)
    if d == today + timedelta(days=1) and "завтра" in norm:
        return d
    if d == today and "сегодня" in norm:
        return d
    return None


def _said_days(args: MakePlanArgs, phrase: str, start: date | None,
               end: date | None) -> int | None:  # fmt: skip
    if start and end and start <= end and (end - start).days < plan_build.MAX_DAYS:
        return (end - start).days + 1
    if args.days and 0 < args.days <= plan_build.MAX_DAYS:
        from decimal import Decimal

        if Decimal(args.days) in facts_of(phrase).numbers:
            return args.days
        words = {2: "два", 3: "три", 4: "четыр", 5: "пят", 6: "шест", 7: "недел"}
        if args.days in words and words[args.days] in _norm(phrase):
            return args.days
    return None


async def _sources(env: Any, topic: str, previous_pk: int | None) -> list[Any]:
    """The saved material: what search finds for the topic, plus the records on screen."""
    from assistant.chat.tools import run_search

    found = await run_search(env, topic, limit=SEARCH_LIMIT) if topic.strip() else []
    seen = {s.pk for s in found}
    for s in env.book.all():  # the selected / visible / found records the model was shown
        if s.pk not in seen:
            found.append(s)
            seen.add(s.pk)
    out = [s for s in found if str(s.kind) != RecordKind.PLAN and s.pk != previous_pk]
    return out[:plan_build.MAX_SOURCES]


async def tool_make_plan(env: Any, args: MakePlanArgs) -> Any:
    from assistant.chat.mutate import Prepared, Result, _commit, _err

    m = env.mut
    on_plan = m.selected is not None and str(m.selected.kind) == RecordKind.PLAN
    if not asks_plan(m.phrase) and not on_plan:
        return _err("the person did not ask for a plan: answer with text")
    tz = env.book.tz
    now = m.clock()
    today = now.astimezone(tz if isinstance(tz, ZoneInfo) else ZoneInfo(str(tz))).date()
    previous: dict[str, Any] | None = None
    old_pk: int | None = None
    old: dict[str, Any] = {}
    if args.plan:
        src = env.book.get(args.plan)
        if src is None:
            return _err(f"unknown record {args.plan}: use a ref you were shown")
        async with env.sessionmaker() as s:
            item = await s.get(Item, src.pk)
            previous = plans.plan_of(item) if item is not None else None
            if item is not None:
                old = {"title": item.title, "text": item.text, "item_id": str(item.public_id)}
            await s.commit()
        if previous is None:
            return _err(f"{args.plan} is not a plan: make a new one with plan null")
        old_pk = src.pk
    kind = previous.get("kind", args.kind) if previous else args.kind
    m.emit("tool_activity", {"tool": "make_plan", "text": ACTIVITY, "page_id": None})
    start = _said_date(args.start_date, m.phrase, today)
    end = _said_date(args.end_date, m.phrase, today)
    days = _said_days(args, m.phrase, start, end)
    if previous and not start and previous.get("start_date"):
        start = date.fromisoformat(previous["start_date"])
    topic = " ".join((args.topic or args.title or "").split())[:200]
    found = await _sources(env, topic, old_pk)
    refs = [plan_build.SourceRef(s.ref, str(s.item_id), s.title, str(s.kind),
                                 s.created_at.isoformat(), s.facts) for s in found]  # fmt: skip
    bodies = {s.ref: (s.shown[-1] if s.shown else "") for s in found}
    dates = {s.ref: env.book.date_text(s) for s in found}
    untrusted = [UntrustedPart("Сохранённые записи",
                               plan_build.source_lines(refs, bodies, dates) or "(ничего)")]
    if previous:
        untrusted.append(UntrustedPart("Текущий план", old.get("text") or ""))
    context = plan_build.context_lines(kind=kind, phrase=m.phrase, today=today, days=days,
                                       start=start)  # fmt: skip
    inputs = TaskInputs(system=plan_build.SYSTEM, instruction="Make the plan.", context=context,
                        untrusted=untrusted, prompt_version=plan_build.PROMPT_VERSION)
    masker = m.masker or Masker(mask_contacts=True)
    try:
        result = await m.router.run(LLMTask.PLAN, plan_build.PlanReply, inputs, user_id=m.user_id,
                                    masker=masker)  # fmt: skip
    except AIConsentRequired:
        raise
    except (AIUnavailable, StreamInterrupted, BudgetExceeded) as exc:
        log.info("chat: plan not made: %s", type(exc).__name__)
        return _err("the plan could not be made now: tell the person in one sentence to ask "
                    "again a bit later", ACTIVITY)  # fmt: skip
    m.cost = (m.cost or 0) + result.cost_usd
    reply = plan_build.PlanReply.model_validate(masker.unmask_obj(result.data.model_dump()))
    built = plan_build.build(reply, kind=kind, sources=refs, phrase=m.phrase, today=today,
                             start=start, days=days, now=now, previous=previous)  # fmt: skip
    if plan_build.is_empty(built.plan):
        return _err("the plan came out empty: tell the person briefly and ask what to plan",
                    ACTIVITY)  # fmt: skip
    plan = built.plan
    edited = previous is not None
    made: dict[str, Any] = {}

    async def prepare(s: Any) -> Any:
        from assistant.actions import engine
        from assistant.db.models_actions import Initiator

        prep = Prepared()
        if edited:
            item = await s.get(Item, old_pk)
            out = await engine.apply(s, m.user_id, [{
                "op": "set_item_content", "entity": "items", "id": str(item.public_id),
                "values": {"title": plan["title"], "text": built.text, "plan": plan}}],
                by=Initiator.AGENT, check=False, now=now)  # fmt: skip
            prep.inverse = out.inverse
            prep.items = out.items
            prep.changes = [{"item_id": str(item.public_id), "title": plan["title"],
                             "kind": "edit", "page_id": None,
                             "text": f"План «{plan['title']}» изменён",
                             "diff": diff_rows(old, {"title": plan["title"],
                                                     "text": built.text})}]  # fmt: skip
        else:
            item = await plans.new_item(s, m.user_id, plan, built.text, phrase=m.phrase)
            prep.inverse = [{"op": "delete_entity_soft", "entity": "items",
                             "id": str(item.public_id)}]  # fmt: skip
            prep.items = {str(item.public_id)}
            prep.changes = [{"item_id": str(item.public_id), "title": plan["title"],
                             "kind": "create", "page_id": None,
                             "text": f"План «{plan['title']}»"}]  # fmt: skip
        pages = await plans.pages_of(s, item.id)
        prep.pages = {p["pk"] for p in pages}
        page = {"page_id": pages[0]["page_id"], "title": pages[0]["title"]} if pages else None
        card = plan_build.card(plan, str(item.public_id), page=page, edited=edited)
        prep.extra = {"plan_card": card}
        prep.sentence = card["lead"]
        made.update(item=item, card=card)
        return prep

    out = await _commit(env, kind=ActionKind.USER_EDIT if edited else ActionKind.SAVE_ITEM,
                        ops=[], sentence="Составил план.", changes=[], screen_pk=None,
                        source_pks=[s.pk for s in found][:50], prepare=prepare)  # fmt: skip
    card = {**made["card"], "action_id": out["id"]}
    m.emit("plan", {"reply_id": None, "plan": card, "action_id": out["id"],
                    "removed": built.removed})  # fmt: skip
    m.finished = True
    return Result(_json({"done": True, "said": card["lead"], "plan": card["item_id"]}), False,
                  ACTIVITY)


DIFF_CHARS = 4000


def diff_rows(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    """Ф-73 inline edit: the fields the assistant changed, old and new value (items.md)."""
    out = []
    for key in ("title", "text"):
        if key in after and before.get(key) != after[key]:
            out.append({"field": key, "before": (before.get(key) or None) and
                        str(before[key])[:DIFF_CHARS],
                        "after": (after[key] or None) and str(after[key])[:DIFF_CHARS]})
    return out


async def latest_action_plan(session: Any, user_id: int, selected_pk: int | None,
                             now: datetime) -> Item | None:  # fmt: skip
    """The plan «сделай делами» means: the selected plan, else the newest action plan of 7 days."""
    if selected_pk is not None:
        item = await session.get(Item, selected_pk)
        if item is not None and item.user_id == user_id and plans.plan_of(item) is not None:
            return item
    rows = await session.scalars(
        select(Item).where(Item.user_id == user_id, Item.kind == RecordKind.PLAN,
                           Item.deleted_at.is_(None), Item.created_at >= now - timedelta(days=7))
        .order_by(Item.id.desc()).limit(10))  # fmt: skip
    for item in rows:
        if (plans.plan_of(item) or {}).get("kind") == "actions":
            return item
    return None
