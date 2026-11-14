"""«Сегодня» as a morning briefing (mocks v2, Ф-55; `screens-v2.html` «Сегодня · утро / день /
вечер»): the headline and ≤3 lines of the day, written by CODE from counts and the next things
(no model call, nothing made up). RU and KK (kk: until reviewed, R-39). Pure: the route gathers
the facts (`api/routes/today.py`) and this module only words them.
"""

from dataclasses import dataclass, field
from datetime import datetime, time
from decimal import Decimal

MORNING_END = time(12, 0)
EVENING_START = time(18, 0)
SOON_MIN = 120  # «Через 25 минут — …» within two hours
CURRENCY_SIGN = {"KZT": "₸", "USD": "$", "EUR": "€", "RUB": "₽"}


@dataclass
class PlanEntry:
    kind: str  # reminder | task
    title: str
    at: datetime | None  # local time (None = a task without a time)
    done: bool = False
    missed: bool = False


@dataclass
class Facts:
    now: datetime  # local
    plan: list[PlanEntry] = field(default_factory=list)  # today, timed by time, then untimed
    tomorrow: list[PlanEntry] = field(default_factory=list)  # timed, by time
    waiting: int = 0  # missed + overdue + questions waiting for a tap
    spent_today: Decimal = Decimal(0)
    spent_month: Decimal = Decimal(0)
    count_today: int = 0  # expenses today
    currency: str = "KZT"
    budget_left: Decimal | None = None  # None = no budget


def part_of_day(now: datetime) -> str:
    t = now.time()
    return "morning" if t < MORNING_END else "evening" if t >= EVENING_START else "day"


def money(amount: Decimal, currency: str = "KZT") -> str:
    """«18 400 ₸»: whole tenge in the brief (the exact sum is on «Расходы»)."""
    value = int(Decimal(amount).to_integral_value())
    sign = "−" if value < 0 else ""
    return f"{sign}{abs(value):,} {CURRENCY_SIGN.get(currency, currency)}".replace(",", " ")


def _hm(at: datetime) -> str:
    return at.strftime("%H:%M").lstrip("0") if at.hour < 10 else at.strftime("%H:%M")


def _first_low(title: str) -> str:
    return title if len(title) > 1 and title[1].isupper() else title[:1].lower() + title[1:]


def _dela(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return "дело"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return "дела"
    return "дел"


def build(f: Facts) -> dict:
    """{"part", "headline": {ru, kk}, "lines": {ru: [...], kk: [...]}} — ≤3 lines each."""
    part = part_of_day(f.now)
    total = len(f.plan)
    done = sum(1 for p in f.plan if p.done)
    left = [p for p in f.plan if not p.done and not p.missed]
    upcoming = [p for p in left if p.at is not None and p.at >= f.now]
    ru: list[str] = []
    kk: list[str] = []

    if part == "morning":
        head_ru = f"Доброе утро · {total} {_dela(total)}" if total else "Доброе утро"
        head_kk = f"Қайырлы таң · {total} іс" if total else "Қайырлы таң"
    elif part == "day":
        head_ru = f"День в разгаре · {done} из {total}" if total else "Добрый день"
        head_kk = f"Күн қызу · {total} істің {done}" if total else "Қайырлы күн"
    else:
        head_ru = f"Вечер · {done} из {total} сделано" if total else "Добрый вечер"
        head_kk = f"Кеш · {total} істің {done} орындалды" if total else "Қайырлы кеш"

    # 1. the mood of the day
    if f.waiting:
        ru.append("Есть что проверить — ниже.")
        kk.append("Тексеретін нәрсе бар — төменде.")
    elif part == "evening":
        if total and not left:
            ru.append("Хороший день.")
            kk.append("Жақсы күн болды.")
        elif total:
            ru.append("Почти всё.")
            kk.append("Бәрі дерлік.")
        else:
            ru.append("Спокойный вечер.")
            kk.append("Тыныш кеш.")
    elif part == "day" and upcoming:
        nxt = upcoming[0]
        mins = int((nxt.at - f.now).total_seconds() // 60)  # type: ignore[operator]
        if mins <= SOON_MIN:
            ru.append(f"Через {mins} мин — {_first_low(nxt.title)}.")
            kk.append(f"{mins} минуттан кейін — {_first_low(nxt.title)}.")
        else:
            ru.append(f"Дальше в {_hm(nxt.at)} — {_first_low(nxt.title)}.")  # type: ignore[arg-type]
            kk.append(f"Келесі {_hm(nxt.at)} — {_first_low(nxt.title)}.")  # type: ignore[arg-type]
    elif total == 0:
        ru.append("Свободный день.")
        kk.append("Бос күн.")
    elif total <= 5:
        ru.append("Спокойный день.")
        kk.append("Тыныш күн.")
    else:
        ru.append("Насыщенный день.")
        kk.append("Қарбалас күн.")

    # 2. what is next
    timed = [p for p in upcoming if p.at is not None][:2]
    if part == "evening":
        if left:
            ru.append(f"Осталось: {_first_low(left[0].title)}.")
            kk.append(f"Қалғаны: {_first_low(left[0].title)}.")
        if f.tomorrow and len(ru) < 3:
            t = f.tomorrow[0]
            ru.append(f"Завтра в {_hm(t.at)} — {_first_low(t.title)}.")  # type: ignore[arg-type]
            kk.append(f"Ертең {_hm(t.at)} — {_first_low(t.title)}.")  # type: ignore[arg-type]
    elif part == "morning" and timed:
        bits = [f"{timed[0].title} в {_hm(timed[0].at)}"]  # type: ignore[arg-type]
        bits_kk = [f"{timed[0].title} — {_hm(timed[0].at)}"]  # type: ignore[arg-type]
        if len(timed) > 1:
            bits.append(f"в {_hm(timed[1].at)} — {_first_low(timed[1].title)}")  # type: ignore[arg-type]
            bits_kk.append(f"{_hm(timed[1].at)} — {_first_low(timed[1].title)}")  # type: ignore[arg-type]
        ru.append(", ".join(bits) + ".")
        kk.append(", ".join(bits_kk) + ".")
    elif part == "day" and len(upcoming) > 1:
        rest = ", ".join(_first_low(p.title) for p in upcoming[1:3])
        ru.append(f"Потом: {rest}.")
        kk.append(f"Содан кейін: {rest}.")

    # 3. money (only what code counted)
    if len(ru) < 3:
        if part == "evening" and f.spent_today > 0:
            ru.append(f"За день — {money(f.spent_today, f.currency)}.")
            kk.append(f"Бүгін — {money(f.spent_today, f.currency)}.")
        elif f.budget_left is not None and (f.spent_month > 0 or part == "morning"):
            spent = money(f.spent_month, f.currency)
            if f.budget_left >= 0:
                ru.append(f"Потрачено {spent}, в бюджете ещё "
                          f"{money(f.budget_left, f.currency)}.")
                kk.append(f"Жұмсалды {spent}, бюджетте тағы "
                          f"{money(f.budget_left, f.currency)}.")
            else:
                over = money(-f.budget_left, f.currency)
                ru.append(f"Потрачено {spent} — бюджет превышен на {over}.")
                kk.append(f"Жұмсалды {spent} — бюджеттен {over} асты.")
        elif f.spent_today > 0:
            ru.append(f"Сегодня потрачено {money(f.spent_today, f.currency)}.")
            kk.append(f"Бүгін жұмсалды {money(f.spent_today, f.currency)}.")
    return {"part": part, "headline": {"ru": head_ru, "kk": head_kk},
            "lines": {"ru": ru[:3], "kk": kk[:3]}}
