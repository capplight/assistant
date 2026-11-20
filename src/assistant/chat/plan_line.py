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
from dataclasses import dataclass
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


# --- a plan on the calendar (2026-11-20, plans.md «A plan on the calendar») ---
# «добавь план в календарь», «поставь поездку в календарь с 10 декабря», «убери поездку из
# календаря», «перенеси поездку на неделю позже». Code reads the person's own words; the plan is
# the selected one, the one whose title the phrase names, else the newest (`calendar_plan`);
# every write is assistant.plans.calendar.

CAL_ACTIVITY = "Ставлю в календарь…"
_CAL_IN = re.compile(r"(?<!\w)(?:в|на)\s+календар(?:ь|ик)(?!\w)")  # «в календаре?» is a question
_CAL_OUT = re.compile(r"(?<!\w)из\s+календар\w*")
_CAL_OUT_VERB = re.compile(r"(?<!\w)(?:убер|убра|удал|сотр|вычеркн|сним|сня|очист|выкин|убир)\w*")
_SHIFT_VERB = re.compile(r"^(?:пожалуйста[,\s]+)?(?:перенес|перенос|сдвин|подвин|передвин|отлож|"
                         r"перестав)\w*")  # fmt: skip
_PLAN_WORD = re.compile(r"(?<!\w)(?:план\w*|поездк\w*|путешеств\w*|отпуск\w*|маршрут\w*|"
                        r"тур(?!\w)|программ\w*|жоспар\w*|пункт\w*)")  # fmt: skip
_DEICTIC = re.compile(r"(?<!\w)(?:его|ее|это|эту|этот|их)(?!\w)")
_MONTHS = ("январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр",
           "ноябр", "декабр")  # fmt: skip
_DAY_MONTH = re.compile(r"(?<![\w.:])(\d{1,2})(?:-?(?:го|е|ое))?\s+(январ|феврал|марта?|апрел|"
                        r"мая|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*")  # fmt: skip
_DOTTED = re.compile(r"(?<![\w.:])(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?![\w.:])")
_FROM_WEEKDAY = re.compile(r"(?<!\w)(?:с|со)\s+(понедельник|вторник|сред|четверг|пятниц|суббот|"
                           r"воскресень)\w*")  # fmt: skip
_NEXT_WEEK = re.compile(r"(?<!\w)(?:со?|на)\s+следующ\w+\s+недел\w*")
_SHIFT_BY = re.compile(r"(?<!\w)на\s+(?:(\d{1,2}|один|одну|два|две|три|четыре|пять|шесть|семь|"
                       r"пару)\s+)?(день|дня|дней|сутки|неделю|недели|недель)"
                       r"(?:\s+(позже|раньше|вперед|назад|попозже|пораньше))?")  # fmt: skip
_COUNT = {"один": 1, "одну": 1, "два": 2, "две": 2, "пару": 2, "три": 3, "четыре": 4, "пять": 5,
          "шесть": 6, "семь": 7}  # fmt: skip
_WD = ("понедельник", "вторник", "сред", "четверг", "пятниц", "суббот", "воскресень")


@dataclass
class CalendarAsk:
    op: Literal["add", "remove", "shift"]
    plan_word: bool  # «план», «поездку», «отпуск» said
    deictic: bool  # «его», «это»: the selected / newest plan


def calendar_phrase(text: str) -> CalendarAsk | None:
    """The person asks to put a plan on the calendar, take it off, or move it. A plan must still
    be found (`calendar_plan`); a phrase about something else falls through."""
    norm = _norm(text).strip(" .!?")
    if not norm or len(norm) > 200:
        return None
    plan_word = bool(_PLAN_WORD.search(norm))
    deictic = bool(_DEICTIC.search(norm))
    if _CAL_OUT.search(norm) and _CAL_OUT_VERB.search(norm):
        return CalendarAsk("remove", plan_word, deictic)
    if _CAL_IN.search(norm) and not _CAL_OUT.search(norm):
        return CalendarAsk("add", plan_word, deictic)
    if _SHIFT_VERB.match(norm) and (_SHIFT_BY.search(norm) or _NEXT_WEEK.search(norm)
                                    or _DAY_MONTH.search(norm) or _DOTTED.search(norm)):
        return CalendarAsk("shift", plan_word, deictic)
    return None


def _year_of(day: int, month: int, today: date) -> date | None:
    """The next such date: this year unless it is already behind, else next year."""
    try:
        d = date(today.year, month, day)
    except ValueError:
        return None
    if d >= today - timedelta(days=1):
        return d
    try:
        return date(today.year + 1, month, day)
    except ValueError:
        return None


def said_start(text: str, today: date) -> date | None:
    """The first day the phrase names: «с 10 декабря», «10.12», «с понедельника», «со следующей
    недели», «завтра», «в пятницу» (timewords). The next such date from today."""
    norm = _norm(text)
    m = _DAY_MONTH.search(norm)
    if m:
        month = next(i for i, stem in enumerate(_MONTHS, 1) if m.group(2).startswith(stem))
        return _year_of(int(m.group(1)), month, today)
    m = _DOTTED.search(norm)
    if m and 1 <= int(m.group(2)) <= 12:
        if m.group(3):
            year = int(m.group(3)) + (2000 if len(m.group(3)) == 2 else 0)
            try:
                return date(year, int(m.group(2)), int(m.group(1)))
            except ValueError:
                return None
        return _year_of(int(m.group(1)), int(m.group(2)), today)
    m = _FROM_WEEKDAY.search(norm)
    if m:
        wd = next(i for i, stem in enumerate(_WD) if m.group(1).startswith(stem))
        return today + timedelta(days=(wd - today.weekday()) % 7 or 7)
    if _NEXT_WEEK.search(norm):
        return today + timedelta(days=7 - today.weekday())
    from assistant import timewords

    return timewords.day_of(text, today)


def shift_of(text: str, today: date) -> tuple[int | None, date | None]:
    """«на неделю позже» → (7, None), «на 2 дня раньше» → (-2, None), «на 17 декабря» → (None,
    that date), «на следующую неделю» → (7, None)."""
    norm = _norm(text)
    m = _SHIFT_BY.search(norm)
    if m:
        n = int(m.group(1)) if (m.group(1) or "").isdigit() else _COUNT.get(m.group(1) or "", 1)
        n *= 7 if m.group(2).startswith("недел") else 1
        back = (m.group(3) or "") in ("раньше", "назад", "пораньше")
        return (-n if back else n), None
    if _NEXT_WEEK.search(norm):
        return 7, None
    return None, said_start(text, today)


def _stems(title: str) -> list[str]:
    words = [w for w in re.findall(r"\w+", _norm(title)) if len(w) >= 4]
    return [w[:max(4, len(w) - 2)] for w in words]


def names_plan(text: str, title: str) -> bool:
    """The phrase names the plan by its title («поездку в Стамбул» → «Стамбул»): its first long
    words, by their stems."""
    stems = _stems(title)
    words = re.findall(r"\w+", _norm(text))
    return bool(stems) and all(any(w.startswith(s) for w in words) for s in stems[:2])


async def calendar_plan(session: Any, user_id: int, text: str, ask: CalendarAsk,
                        selected_pk: int | None) -> Item | None:  # fmt: skip
    """Which plan the phrase means: the selected plan; else a live plan whose title it names
    (newest first); else, when it says «план» / «поездку» / «его», the newest live plan."""
    if selected_pk is not None:
        item = await session.get(Item, selected_pk)
        if item is not None and item.user_id == user_id and item.deleted_at is None \
                and plans.plan_of(item) is not None:  # fmt: skip
            return item
    rows = list(await session.scalars(
        select(Item).where(Item.user_id == user_id, Item.kind == RecordKind.PLAN,
                           Item.deleted_at.is_(None)).order_by(Item.id.desc()).limit(30)))
    rows = [r for r in rows if plans.plan_of(r) is not None]
    for item in rows:
        if names_plan(text, item.title or ""):
            return item
    if rows and (ask.plan_word or ask.deictic):
        return rows[0]
    return None


def date_options(today: date) -> list[tuple[str, date]]:
    """Choices for «С какого дня?»: tomorrow, the nearest Saturday, next Monday."""
    from assistant.plans.calendar import range_text

    out: list[tuple[str, date]] = []
    tomorrow = today + timedelta(days=1)
    sat = today + timedelta(days=(5 - today.weekday()) % 7 or 7)
    mon = today + timedelta(days=7 - today.weekday())
    for label, d in (("С завтра", tomorrow), ("С субботы", sat), ("С понедельника", mon)):
        if all(d != x for _, x in out):
            out.append((f"{label}, {range_text(d, d)}", d))
    return out


TEXT_NO_CAL_PLAN = ("Не нашёл плана для календаря. Сначала составьте его, например: «составь "
                    "план поездки в Стамбул на 4 дня».")


# --- Ф-96: «по дню одним делом или каждый пункт отдельно?», and the times of the points ---

_MODE_POINTS = re.compile(r"(?<!\w)(?:кажд\w*\s+(?:пункт|мест|точк|дел)\w*|по\s+пунктам|"
                          r"по\s+местам|отдельн\w*|по\s+отдельности|поштучно|разбей\w*)")
_MODE_DAYS = re.compile(r"(?<!\w)(?:по\s+дням|по\s+дню|одним\s+делом|просто\s+(?:добав|постав|"
                        r"закин|внес)\w*|как\s+есть|разом|целиком|неважно|не\s+важно|без\s+разницы|"
                        r"вс[её]\s+равно|как\s+удобно|на\s+твой\s+выбор|по\s+умолчанию)")
_NO_PREF = re.compile(r"^(?:нет|не|неа|не\s+надо|не\s+нужно|просто|обычно|любой|любым|давай\s+"
                      r"просто|да\s+просто)$")  # fmt: skip
_OK = re.compile(r"^(?:да|ок|окей|ok|ага|угу|давай|хорошо|отлично|поставь|ставь|подходит|норм\w*|"
                 r"годится|супер|можно|верно|вс[её]\s+верно|так\s+и\s+сделай|поставь\s+так|"
                 r"ставь\s+так|так|пойдет|идет|согласен|согласна)(?:\s+так)?$")  # fmt: skip
_CANCEL = re.compile(r"^(?:отмена|отмени|не\s+надо|не\s+нужно|не\s+ставь|передумал\w*|стоп)$")


def mode_of(text: str, *, answer: bool = False) -> str | None:
    """`points` («каждый пункт отдельно»), `days` («просто добавь», «по дням»; as an answer also
    a bare «нет» / «просто» — no preference, Ф-96), else None."""
    norm = _norm(text).strip(" .!?,")
    if re.search(r"(?<!\w)не\s+(?:надо\s+|нужно\s+)?(?:кажд\w*\s+\w+\s+)?отдельн", norm):
        return "days"  # «не надо отдельно»
    if _MODE_POINTS.search(norm):
        return "points"
    if _MODE_DAYS.search(norm) or (answer and _NO_PREF.match(norm)):
        return "days"
    return None


def times_reply(text: str) -> str | None:
    """The answer to «Поставить так?»: `ok`, `days` (one to-do per day after all), `cancel`."""
    norm = _norm(text).strip(" .!?,")
    if _OK.match(norm):
        return "ok"
    if _CANCEL.match(norm):
        return "cancel"
    if mode_of(norm) == "days":
        return "days"
    return None


def _point_stems(title: str) -> list[str]:
    return [w[:max(4, len(w) - 2)] for w in re.findall(r"\w+", _norm(title)) if len(w) >= 4]


def apply_edits(text: str, days: list[dict[str, Any]], times: dict[str, str],
                on: date) -> tuple[dict[str, str], list[str]]:  # fmt: skip
    """«ужин в 20, музей утром» → the proposed times with those points moved (every point whose
    title the part names best; a bare hour takes the reading nearest the proposed time). Returns
    the new times and the parts that named no point (to say so)."""
    from datetime import time as time_

    from assistant import timewords

    out = dict(times)
    missed: list[str] = []
    points = [p for d in days for p in d.get("points") or [] if p["id"] in times]
    for part in re.split(r",|;|(?<!\w)и(?!\w)|(?<!\w)а(?!\w)", text):
        part = part.strip(" .!?")
        if not part:
            continue
        r = timewords.read(part, datetime.combine(on, time_(0, 0)))
        if r is None or r.rel is not None or not r.times():
            continue
        words = [w for w in re.findall(r"\w+", _norm(timewords.strip(part, r.spans)))
                 if len(w) >= 4]
        score = {p["id"]: sum(any(w.startswith(s) for w in words) for s in _point_stems(p["title"]))
                 for p in points}
        best = max(score.values(), default=0)
        if not best:
            missed.append(part)
            continue
        for p in points:
            if score[p["id"]] != best:
                continue
            was = time_.fromisoformat(out[p["id"]])
            pick = min(r.times(), key=lambda t: abs((t.hour * 60 + t.minute)
                                                    - (was.hour * 60 + was.minute)))
            out[p["id"]] = f"{pick.hour:02d}:{pick.minute:02d}"
    return out, missed


def mode_question(title: str) -> str:
    return (f"Как поставить «{title}» в календарь: каждый день одним делом (все пункты внутри) "
            f"или каждый пункт отдельным делом со своим временем?")


def times_question(lines: list[str]) -> str:
    return ("Предлагаю так:\n" + "\n".join(lines)
            + "\nПоставить так? Можно поправить одной фразой: «ужин в 20, музей утром».")


def example_point(days: list[dict[str, Any]]) -> str:
    """A point title to show in «например: «…» в 10»."""
    for d in days:
        for p in d.get("points") or []:
            words = re.findall(r"\w+", p.get("title") or "")
            if words:
                return words[0].lower()
    return "ужин"
