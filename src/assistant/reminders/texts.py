"""Russian lines for reminders: S13 «как понял», «Напомню …», push titles (design 6.4, copy 32–37).

Short, friendly, no jargon, never «ИИ». Kazakh copy waits for review (R-39).
"""

from datetime import date, datetime, time

WEEKDAY = ("понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье")
WEEKDAY_ACC = ("понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье")
EVERY = ("Каждый понедельник", "Каждый вторник", "Каждую среду", "Каждый четверг",
         "Каждую пятницу", "Каждую субботу", "Каждое воскресенье")  # fmt: skip
MONTH_GEN = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
             "сентября", "октября", "ноября", "декабря")  # fmt: skip
CODES = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
LEVEL = {"alarm": "Будильник", "notification": "Уведомление"}
OFFSET = {15: "за 15 минут", 60: "за час", 1440: "накануне"}

TEST_TITLE = "Проверка будильника"
PUSH_BACKUP = "Напоминание на {time} — откройте. Если будильник уже звенел — всё в порядке"
PUSH_MISSED = "Вы пропустили напоминание на {time}"
PUSH_MISSED_TEXT = "Вы пропустили: {title}"

MSG = {
    "not_understood": "Не совсем понял. Укажите время вручную.",
    "no_ai": "Укажите время вручную.",
    "ai_unavailable": "Сейчас не получилось разобрать. Укажите время вручную.",
    "check_failed": "Проверьте время — я мог ошибиться.",
    "past": "Это время уже прошло. Выберите другое.",
}


def clock(t: time) -> str:
    return f"{t.hour}:{t.minute:02d}"


def _day_month(d: date, today: date) -> str:
    text = f"{d.day} {MONTH_GEN[d.month - 1]}"
    return text if d.year == today.year else f"{text} {d.year}"


def _relative(d: date, today: date) -> str | None:
    return {0: "Сегодня", 1: "Завтра", 2: "Послезавтра"}.get((d - today).days)


def repeat_label(rrule: str) -> str:
    parts = dict(p.split("=", 1) for p in rrule.split(";") if "=" in p)
    freq, interval = parts.get("FREQ"), int(parts.get("INTERVAL", "1"))
    if freq == "DAILY":
        return "Каждый день" if interval == 1 else f"Раз в {interval} дн."
    if freq == "WEEKLY":
        days = [CODES.index(c) for c in parts.get("BYDAY", "").split(",") if c in CODES]
        if interval != 1:
            return f"Раз в {interval} нед."
        if days == [0, 1, 2, 3, 4]:
            return "По будням"
        if days == [5, 6]:
            return "По выходным"
        if len(days) == 1:
            return EVERY[days[0]]
        if not days:
            return "Каждую неделю"
        names = [WEEKDAY_ACC[d] for d in days]
        return "Каждую неделю: " + ", ".join(names[:-1]) + " и " + names[-1]
    if freq == "MONTHLY":
        md = parts.get("BYMONTHDAY")
        base = "Каждый месяц" if interval == 1 else f"Раз в {interval} мес."
        return f"{base}, {md}-го" if md else base
    return "Повторяется"


def when_text(local: datetime, rrule: str | None, offsets: list[int] | tuple[int, ...],
              level: str, today: date) -> str:  # fmt: skip
    """«Завтра, понедельник, 9 ноября · 7:00 · Будильник · и за час»."""
    if rrule:
        head = repeat_label(rrule)
    else:
        rel = _relative(local.date(), today)
        wd = WEEKDAY[local.weekday()]
        dm = _day_month(local.date(), today)
        head = f"{rel}, {wd}, {dm}" if rel else f"{wd.capitalize()}, {dm}"
    line = f"{head} · {clock(local.time())} · {LEVEL.get(level, LEVEL['notification'])}"
    extra = [OFFSET.get(o, f"за {o} мин") for o in sorted(offsets)]
    if extra:
        line += " · и " + ", ".join(extra)
    return line


def saved_text(local: datetime, rrule: str | None, today: date) -> str:
    """«Напомню завтра в 7:00» (copy 32 rem.saved)."""
    at = clock(local.time())
    if rrule:
        return f"Напомню: {repeat_label(rrule).lower()} в {at}"
    rel = _relative(local.date(), today)
    if rel:
        return f"Напомню {rel.lower()} в {at}"
    if 0 < (local.date() - today).days < 7:
        prep = "во" if local.weekday() == 1 else "в"
        return f"Напомню {prep} {WEEKDAY_ACC[local.weekday()]} в {at}"
    return f"Напомню {_day_month(local.date(), today)} в {at}"


def ambiguous_text(options: list[time]) -> str:
    """«В 7 утра или в 7 вечера?» (copy 32 rem.ambiguous)."""
    a, b = sorted(options)
    if a.minute or b.minute:
        return f"В {clock(a)} или в {clock(b)}?"
    if a.hour >= 12:
        return f"В {clock(a)} или в {clock(b)}?"
    first, second = ("ночи", "дня") if a.hour <= 4 else ("утра", "вечера")
    return f"В {a.hour} {first} или в {a.hour} {second}?"
