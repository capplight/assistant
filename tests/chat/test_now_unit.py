"""Ф-89 part 3: the assistant knows «сейчас» — what of today is past, the next thing with a time
and the minutes until it, the free window — computed by code, and the answer check accepts these
facts while dropping a proposal of a time already past. No DB, no network."""

from datetime import datetime
from decimal import Decimal

from assistant.chat.intent import Intent, rules_first
from assistant.chat.now import Slot, build, lines
from assistant.chat.verify import check_sentence, personal_question, proposes_past

NOW = datetime(2026, 11, 20, 14, 20)


def view():  # type: ignore[no-untyped-def]
    return build(NOW, [Slot(datetime(2026, 11, 20, 9, 0), "Стоматолог"),
                       Slot(datetime(2026, 11, 20, 16, 0), "Встреча с Ерланом"),
                       Slot(datetime(2026, 11, 20, 19, 30), "Ужин")],
                 ["Оплатить свет"], overdue=1)  # fmt: skip


def test_what_is_past_next_and_free() -> None:
    v = view()
    assert [s.title for s in v.past] == ["Стоматолог"]
    assert [s.title for s in v.later] == ["Встреча с Ерланом", "Ужин"]
    assert v.next is not None and v.next.title == "Встреча с Ерланом"
    assert v.minutes_to_next == 100 and v.free_until == datetime(2026, 11, 20, 16, 0)
    line, data, facts = lines(v)
    assert "Сейчас у человека 14:20." in line
    assert "Следующее по времени — 16:00, через 1 ч 40 мин." in line
    assert "Свободно сейчас: до 16:00 (1 ч 40 мин)." in line
    assert "Время раньше 14:20 сегодня уже прошло: не предлагай его." in line
    assert "Стоматолог" not in line  # titles are the person's data: the data block only
    assert data is not None and "9:00 — Стоматолог (прошло)" in data
    assert "16:00 — Встреча с Ерланом" in data and "без времени — Оплатить свет" in data
    # the answer may say these: code computed them
    for sentence in ("Сейчас 14:20, следующая встреча в 16:00 — через 1 ч 40 мин.",
                     "До встречи 100 минут, успеете.", "Вы свободны до 16:00, почти 2 часа.",
                     "Сегодня ещё 2 дела по времени, в 19:30 ужин."):
        assert check_sentence(sentence, {}, facts).ok, sentence
    assert not check_sentence("Следующее в 17:00.", {}, facts).ok


def test_nothing_left_today_and_the_next_day() -> None:
    v = build(NOW, [Slot(datetime(2026, 11, 21, 10, 0), "Врач")])
    assert v.later == [] and v.next is not None and v.minutes_to_next == 19 * 60 + 40
    line, data, _ = lines(v)
    assert "Следующее по времени — 21.11 в 10:00" in line
    assert "свободно до конца дня" in line and data is not None and "(следующее)" in data
    line, data, _ = lines(build(NOW, []))
    assert "Дальше на неделю ничего по времени нет." in line and data is None


def test_a_time_already_past_is_not_proposed() -> None:
    assert proposes_past("Давайте поставим звонок на 10:00.", NOW)
    assert proposes_past("Могу напомнить в 13:30.", NOW)
    assert not proposes_past("Давайте поставим звонок на 17:00.", NOW)
    assert not proposes_past("Давайте завтра в 10:00.", NOW)
    assert not proposes_past("Встреча была в 9:00.", NOW)
    assert not proposes_past("Стоматолог в 9:00 уже прошёл.", NOW)
    assert not proposes_past("Сейчас 14:18.", NOW)


def test_now_questions_are_about_the_person_and_are_questions() -> None:
    for phrase in ("что у меня сейчас?", "когда я свободен", "успею до встречи",
                   "я свободна в 3?"):
        assert personal_question(phrase), phrase
    assert rules_first("успею до встречи").intent == Intent.QUESTION
    assert rules_first("когда я свободен").intent == Intent.QUESTION
    _, _, facts = lines(view())
    assert Decimal(100) in facts.numbers and (16, 0) in facts.times
