"""The intent rule (spec 5.7 p. 6 and 10, 5.10 rule 2, R-56): may this phrase change anything?

Only the person's own phrase is looked at, never record text, files or shared text. Code first
(`rules_first`): imperative change verbs («разложи», «перенеси», «удали», «запиши», «создай
страницу») mean `change`; question words or «?» without such a verb mean `question`. When the
words say neither, the caller may ask the light model (INTENT) on the phrase alone.

Also code-only parsing of the simple cases the line handles without the chat model (spec 5.10
rule 7): «разложи по темам», «отсортируй сначала новые», «удали это».
"""

import enum
import re
from dataclasses import dataclass

from pydantic import BaseModel


class Intent(enum.StrEnum):
    CHANGE = "change"
    QUESTION = "question"
    NOTE = "note"  # just something to keep: saved as the person said it, by code
    UNCLEAR = "unclear"


class IntentReply(BaseModel):
    """INTENT task output: the light model's reading of the phrase."""

    intent: str  # change | question | note
    confidence: float


def _norm(text: str) -> str:
    return " ".join(text.lower().replace("ё", "е").split())


_W = r"(?:^|(?<=[\s,.;:!?«\"(]))"
_E = r"(?=$|[\s,.;:!?»\")])"  # a whole word: «удалил» is not «удали»
# Imperatives and infinitives only: «записал», «удалил» (past) are about the past, not orders.
_CHANGE = re.compile(_W + r"(?:"
    r"разлож(?:и|ите|ить)|сгруппир(?:уй|уйте|овать)|рассортир(?:уй|уйте|овать)|"
    r"отсортир(?:уй|уйте|овать)|упорядоч(?:ь|ьте|ить)|перестав(?:ь|ьте|ить)|"
    r"перенес(?:и|ите|ти)|перемест(?:и|ите|ить)|полож(?:и|ите|ить)|перелож(?:и|ите|ить)|"
    r"постав(?:ь|ьте|ить)|"
    r"добав(?:ь|ьте|ить)|запиш(?:и|ите)|записать|сохран(?:и|ите|ить)|"
    r"созда(?:й|йте|ть)|сдела(?:й|йте|ть)\s+страниц\w*|заведи|удал(?:и|ите|ить)|"
    r"убер(?:и|ите)|убрать|выброс(?:и|ите|ить)|переимен(?:уй|уйте|овать)|назов(?:и|ите)|"
    # Ф-73: an edit inside a record's text («исправь в заметке …», «допиши …»)
    r"исправ(?:ь|ьте)|поправ(?:ь|ьте)|допиш(?:и|ите)|дополн(?:и|ите)|перепиш(?:и|ите)|"
    r"вычеркн(?:и|ите)|"
    # «покажи (плитку / это / её) ещё на …»: up to three words of the record (week 17: the
    # golden set found «покажи плитку ещё на странице Дом» read as a question); not a question
    r"покажи\s+(?![^?]*\?)(?!(?:что|где|как\w*|сколько|кто|какие)\s)(?:[^\s?]+\s+){0,3}?"
    r"(?:ещ[её]|тоже)\s+на|"
    # week 11: the view of a page (set_view, proposal 2.8)
    r"(?:покажи|сделай|сделайте)\s+(?:\w+\s+)?(?:таблиц\w*|списк\w*|простым|чек-?лист\w*|"
    r"доск\w*|рядами|стикер\w*|ежедневник\w*|картотек\w*)|"
    r"покажи\s+(?:за\s+(?:неделю|месяц|год)|по\s+\w+)|"
    r"(?:сделай|сделайте)\s+(?:\w+\s+)?(?:ж[её]лт|розов|зел[её]н|голуб|персиков|бирюз|бел)\w*|"
    r"включи|включите|выключи|выключите|скрой|скройте|спрячь|спрячьте|раскрась|раскрасьте|"
    r"покрась|покрасьте|перекрась|перекрасьте|приколи|приколите|открепи|открепите|"
    r"верни(?:те)?\s+(?:\w+\s+)?(?:как\s+было|страниц\w*|вид|пол[ея])|"
    # Kazakh imperatives (R-39; reviewed vocabulary to come)
    r"жаз(?:ып\s+қой|ыңыз)|қос(?:ыңыз)?\b|өшір(?:іңіз)?|жоямын|ауыстыр(?:ыңыз)?|"
    r"сұрыпта(?:ңыз)?|топта(?:ңыз)?"
    r")" + _E, re.IGNORECASE)  # fmt: skip
_QUESTION = re.compile(_W + r"(?:сколько|где|когда|что|чего|какой|какая|какое|какие|кто|кому|"
                       r"почему|зачем|как|есть ли|найди|покажи|напомни мне|қашан|қайда|қанша|"
                       r"не\b|кім|куда|откуда|"
                       # Ф-86: asking the assistant for help, advice, a plan or a chat is a
                       # question (answered from general knowledge), never a note to keep
                       r"посоветуй\w*|подскаж\w*|расскаж\w*|объясни\w*|"
                       r"состав(?:ь|ьте)(?!\s+спис)|придума\w*|помоги\w*|предлож(?:и|ите)\b|"
                       r"порекоменду\w*|поищи\w*|загугли\w*|в\s+интернете|"
                       r"нужн[аоы]?\s+(?:инф\w*|совет\w*|иде\w*|помощь)|как\s+дела|"
                       r"привет\w*|здравствуй\w*|сәлем\w*|кеңес\w*)", re.IGNORECASE)  # fmt: skip
_DEICTIC = re.compile(_W + r"(?:это|эту|этот|эти|этого|здесь|тут|ее|его|осы|мұны|бұны)"
                      r"(?=$|[\s,.;:!?»\"])", re.IGNORECASE)  # fmt: skip
_TOPICS = re.compile(_W + r"(?:разлож(?:и|ите|ить)|сгруппир(?:уй|уйте|овать)|"
                     r"рассортир(?:уй|уйте|овать)|топта(?:ңыз)?)" + _E, re.IGNORECASE)  # fmt: skip
_SORT = re.compile(_W + r"(?:отсортир(?:уй|уйте|овать)|упорядоч(?:ь|ьте|ить)|"
                   r"перестав(?:ь|ьте))" + _E, re.IGNORECASE)  # fmt: skip
_NEWEST = re.compile(r"нов(?:ые|ое|ых)\s+(?:сверху|вверху|наверху|первыми)|сначала\s+нов|"
                     r"по\s+дате|от\s+новых", re.IGNORECASE)  # fmt: skip
_OLDEST = re.compile(r"стар(?:ые|ое|ых)\s+(?:сверху|вверху|наверху|первыми)|сначала\s+стар|"
                     r"от\s+старых", re.IGNORECASE)  # fmt: skip
_DELETE = re.compile(_W + r"(?:удал(?:и|ите|ить)|выброс(?:и|ите|ить)|өшір(?:іңіз)?)" + _E,
                     re.IGNORECASE)  # fmt: skip
_PAGE_WORD = re.compile(r"страниц|бет", re.IGNORECASE)
_COMPARE = re.compile(_W + r"(?:сравни|сравнить|чем отлича|что дешевле|что дороже|разница|"
                      r"салыстыр)", re.IGNORECASE)  # fmt: skip
_WORDS = re.compile(r"\w+")


@dataclass(frozen=True)
class Reading:
    intent: Intent
    source: str  # rules | model | share
    deictic: bool = False
    verbs: int = 0  # how many change verbs: >=2 is a multi-step action


def rules_first(text: str, *, input_kind: str = "typed") -> Reading:
    """Code's reading of the person's phrase. Shared text is never an order."""
    norm = _norm(text)
    if input_kind == "share":
        return Reading(Intent.QUESTION, "share")
    verbs = len(_CHANGE.findall(norm))
    deictic = bool(_DEICTIC.search(norm))
    if verbs:
        return Reading(Intent.CHANGE, "rules", deictic, verbs)
    if norm.endswith("?") or _QUESTION.search(norm):
        return Reading(Intent.QUESTION, "rules", deictic)
    return Reading(Intent.UNCLEAR, "rules", deictic)


def from_model(reply: IntentReply, base: Reading) -> Reading:
    if reply.intent == "change" and reply.confidence >= 0.6:
        return Reading(Intent.CHANGE, "model", base.deictic, max(1, base.verbs))
    if reply.intent == "note":
        return Reading(Intent.NOTE, "model", base.deictic)
    return Reading(Intent.QUESTION, "model", base.deictic)


_DIGITS = re.compile(r"\d")


def note_by_code(text: str, base: Reading) -> Reading:
    """No model to ask: a phrase with a number (a phone, an amount) or of 3+ words that is
    neither a question nor an order is something to keep; a word or two is a search."""
    if len(_DIGITS.findall(text)) >= 5 or len(text.split()) >= 3:
        return Reading(Intent.NOTE, "rules", base.deictic)
    return Reading(Intent.QUESTION, "rules", base.deictic)


_SAVE = re.compile(r"^(?:запиш(?:и|ите)|записать|сохран(?:и|ите)|добав(?:ь|ьте)|"
                   r"жазып\s+қой)(?:\s+(?:мне|себе|пожалуйста))*\s*[:,—-]?\s+(?P<rest>.+)$",
                   re.IGNORECASE | re.DOTALL)  # fmt: skip


def save_text(text: str) -> str | None:
    """«запиши купить хлеб» -> «купить хлеб». None when the phrase names a page or a record
    («добавь в Покупки …», «запиши это»): the chat model decides those."""
    m = _SAVE.match(" ".join(text.split()))
    if m is None:
        return None
    rest = m.group("rest").strip()
    first = rest.split()[0].lower() if rest else ""
    if first in ("в", "на", "это", "эту", "этот", "сюда", "туда", "ко", "к") or not rest:
        return None
    if first in ("поле", "колонку", "столбец", "столбик"):  # week 11: a view change (set_view)
        return None
    return rest[:1].upper() + rest[1:]


@dataclass(frozen=True)
class FastPath:
    """A phrase code handles without the chat model."""

    tool: str  # reorder | trash_selected | color_topics
    how: str | None = None  # topics | newest | oldest


def _only_words(norm: str, pattern: re.Pattern[str], allowed: set[str]) -> bool:
    rest = pattern.sub(" ", norm)
    return all(w in allowed for w in _WORDS.findall(rest))


_TOPIC_FILLER = {"по", "темам", "теме", "группам", "записи", "заметки", "все", "всё", "их",
                 "пожалуйста", "мне", "здесь", "тут", "на", "этой", "странице", "это", "эти",
                 "стопкам", "стопки", "тақырып", "бойынша"}  # fmt: skip
_SORT_FILLER = {"по", "дате", "сначала", "новые", "старые", "сверху", "вверху", "наверху",
                "первыми", "от", "новых", "старых", "к", "записи", "заметки", "все", "их",
                "пожалуйста", "здесь", "тут", "на", "этой", "странице"}  # fmt: skip
# week 11а: «раскрась по темам» on «Заметки» (set_view color_by=topic; proposal 2.1, 2.8)
_PAINT = re.compile(_W + r"(?:раскрас(?:ь|ьте|ить)|покрас(?:ь|ьте|ить)|перекрас(?:ь|ьте|ить))"
                    + _E, re.IGNORECASE)  # fmt: skip
_BY_TOPIC = re.compile(r"по\s+тем(?:ам|е)" + _E, re.IGNORECASE)
_PAINT_FILLER = {"по", "темам", "теме", "заметки", "стикеры", "все", "всё", "их", "пожалуйста",
                 "мне", "здесь", "тут", "на", "этой", "странице", "разными", "цветами", "в",
                 "цвета"}  # fmt: skip
_DELETE_FILLER = {"это", "эту", "этот", "эти", "его", "ее", "пожалуйста", "запись", "заметку",
                  "осы", "мұны"}  # fmt: skip


def fast_path(text: str) -> FastPath | None:
    norm = _norm(text).strip(" .!")
    if _TOPICS.search(norm) and _only_words(norm, _TOPICS, _TOPIC_FILLER):
        return FastPath("reorder", "topics")
    if _SORT.search(norm) and _only_words(norm, _SORT, _SORT_FILLER):
        if _OLDEST.search(norm):
            return FastPath("reorder", "oldest")
        if _NEWEST.search(norm):
            return FastPath("reorder", "newest")
    if _PAINT.search(norm) and _BY_TOPIC.search(norm) and _only_words(norm, _PAINT,
                                                                       _PAINT_FILLER):
        return FastPath("color_topics")
    if _DELETE.search(norm) and _only_words(norm, _DELETE, _DELETE_FILLER):
        return FastPath("trash_selected")
    return None


_TO_TRASH = re.compile(r"в\s+корзин", re.IGNORECASE)


_TEXT_EDIT = re.compile(
    _W + r"(?:исправ\w*|поправ\w*|допиш\w*|дополн\w*|замен(?:и|ите)|измен(?:и|ите)|"
    r"поменя(?:й|йте)|перепиш\w*|вычеркн\w*|сократ(?:и|ите)|"
    r"(?:убер(?:и|ите)|удал(?:и|ите))\s+(?:\S+\s+){0,4}?из\s+(?:эт\w+\s+|мо\w+\s+)?"
    r"(?:заметк|запис|текст)\w*|"
    r"(?:добав(?:ь|ьте)|впиш(?:и|ите)|запиш(?:и|ите))\s+(?:\S+\s+){0,6}?(?:в|к)\s+"
    r"(?:эт\w+\s+|мо\w+\s+|ту\s+же\s+)?(?:заметк|запис|текст)\w*)", re.IGNORECASE)


def asks_text_edit(text: str) -> bool:
    """Ф-73: the person's own phrase asks to change what a record says (code's guard: record
    text that says «исправь» never edits anything)."""
    return bool(_TEXT_EDIT.search(_norm(text)))


def is_delete(text: str) -> bool:
    """The person's own phrase asks to delete («удали», «выброси», «убери в корзину»)."""
    norm = _norm(text)
    return bool(_DELETE.search(norm) or _TO_TRASH.search(norm))


# Ф-67 / Ф-73: undo by phrase for any action («верни как было», «отмени», «не туда»,
# «отмени всё», «верни запись про хлеб», «отмени то, что ты сделал с хлебом»).
_UNDO = re.compile(r"^(?:пожалуйста[,\s]+)?(?:(?P<verb>верни(?:те)?|отмени(?:те)?|откати(?:те)?|"
                   r"отмена|қайтар(?:ыңыз)?|болдырма(?:ңыз)?)(?P<rest>(?:\s.*)?)|"
                   r"не\s+туда(?:\s+(?:положил|записал|перенес))?)$", re.IGNORECASE | re.DOTALL)
# «верни страницу как было», «верни вид / поле»: the page view (set_view reset), not an undo
_UNDO_VIEW = re.compile(r"страниц|(?<!\w)вид[ау]?(?!\w)|(?<!\w)пол(?:е|я|ю|ей)(?!\w)|колонк|столбц|"
                        r"(?<!\w)бет", re.IGNORECASE)  # fmt: skip
_UNDO_FILLER = {"как", "было", "все", "обратно", "назад", "последнее", "последний", "последнюю",
                "последние", "действие", "действия", "изменение", "изменения", "это", "эти",
                "пожалуйста", "мне", "то", "что", "ты", "вы", "сделал", "сделала", "сделали",
                "только", "сейчас", "уже", "бәрін", "барлығын", "соңғы", "қалай", "болса",
                "солай", "ну", "давай", "а", "и", "же", "его", "ее", "их"}  # fmt: skip
_UNDO_ALL = {"все", "бәрін", "барлығын"}
_UNDO_LINK = {"про", "о", "об", "с", "со", "для", "запись", "записи", "заметку", "заметки",
              "из", "в", "на", "по", "к", "у", "мою", "мой", "моё", "мое", "мои"}  # fmt: skip


@dataclass(frozen=True)
class UndoPhrase:
    """«отмени» (the last change), «отмени всё» (`all`), «верни запись про хлеб» (`about`)."""

    all: bool = False
    about: tuple[str, ...] = ()


def undo_phrase(text: str) -> UndoPhrase | None:
    """Code only, on the person's own phrase. None: not an undo (a question, a page view)."""
    norm = _norm(text).strip(" .!")
    if "?" in norm or len(norm) > 120:
        return None
    m = _UNDO.match(norm)
    if m is None:
        return None
    if m.group("verb") is None:  # «не туда»
        return UndoPhrase()
    rest = m.group("rest") or ""
    if _UNDO_VIEW.search(rest):
        return None
    words = _WORDS.findall(rest)
    about = tuple(w for w in words if w not in _UNDO_FILLER and w not in _UNDO_LINK)
    if m.group("verb").startswith("верни") and not about and not words:
        return None  # a bare «верни» says too little
    return UndoPhrase(all=any(w in _UNDO_ALL for w in words), about=about)


_VIEW = re.compile(
    r"таблиц|списк|простым|чек-?лист|доск|рядами|стикер|ежедневник|картотек|"
    r"пол[еяю]\b|полей|колонк|столбц|сортир|группир|фильтр|\bвид\b|как\s+было|"
    r"ж[её]лт|розов|зел[её]н|голуб|персиков|бирюз|\bбел(?:ый|ым|ой|ые|ыми)\b|цвет|раскрас|покрас|"
    r"перекрас|приколи|открепи|назов|переимен|иконк|за\s+(?:неделю|месяц|год)|"
    r"по\s+(?:магазин|клиент|категор|дат|сумм|тип|статус|папк)|на\s+сегодня|"
    r"скрой|спрячь|покажи\s+пол", re.IGNORECASE)


def asks_view(text: str) -> bool:
    """The person's own words are about how a page looks (week 11, set_view): code checks this
    before the assistant may change a view, so record text can never trigger it."""
    return bool(_VIEW.search(_norm(text)))


# Ф-47: the open page is where a new record goes only when the person says so.
_HERE = re.compile(_W + r"(?:сюда|здесь|тут|на\s+(?:эту|этой|текущ\w*|открыт\w*)\s+страниц\w*|"
                   r"в\s+(?:эту|этой)\s+страниц\w*|на\s+эту\s+же|осында|осы\s+бетке)" + _E,
                   re.IGNORECASE)  # fmt: skip


def names_here(text: str) -> bool:
    """«добавь сюда», «запиши на эту страницу»: the person chose the open page (Ф-47)."""
    return bool(_HERE.search(_norm(text)))


def names_page(text: str) -> bool:
    """«сделай страницу …»: a page is made only on a direct request (R-55)."""
    return bool(_PAGE_WORD.search(_norm(text)))


_WEB = re.compile(
    r"(?:в\s+интернете|в\s+сети|в\s+гугл\w*|загугли\w*|поищи\s+(?:в\s+)?(?:интернет|онлайн|сайт)|"
    r"онлайн|интернеттен|"
    r"погод\w*|прогноз\w*|курс\w*\s+(?:доллар|валют|евро|рубл|тенге|юан)\w*|новост\w*|"
    r"сейчас\s+открыт\w*|часы\s+работы|режим\s+работы|расписани\w*|афиш\w*|"
    r"(?:что|какие)\s+(?:идет|идут)\s+в\s+кино|сч[её]т\s+матча|кто\s+выиграл|"
    r"сколько\s+(?:сейчас\s+)?стоит|цен[аы]\s+на|актуальн\w*|свеж\w+\s+(?:инф|данн|новост)\w*)",
    re.IGNORECASE)  # fmt: skip


def asks_web(text: str) -> bool:
    """Ф-86: the phrase needs fresh or online information (weather, rates, news, opening hours)
    or asks to look it up online. Only then is web search offered (it is paid per search)."""
    return bool(_WEB.search(_norm(text)))


def is_comparison(text: str) -> bool:
    return bool(_COMPARE.search(_norm(text)))


# Step 6: several things in one phrase («купил хлеб за 400 и молоко за 600, и напомни оплатить
# свет»). Code only splits where it is cheap and safe: at «,» / «;» / «и» before an order word,
# and a spend with several amounts at «и» / «,» (the verb carried over: «молоко за 600» →
# «купил молоко за 600»). The caller uses the parts only when every part is read by code.
MAX_PARTS = 8
_ORDER = (r"(?:напомн|запиш|запомн|добав|купи|потрат|заплат|оплат|перелож|перенеси|сохрани|"
          r"удали|разбуд|поставь)")
_SPLIT = re.compile(r"\s*[;,]\s*(?:(?:и|а\s+ещ[её]|потом|также|ещ[её])\s+)?(?=" + _ORDER + r")"
                    r"|\s+(?:и|а\s+также|потом)\s+(?:ещ[её]\s+)?(?=" + _ORDER + r")",
                    re.IGNORECASE)  # fmt: skip
_AMOUNT = re.compile(r"\d[\d\s]*(?:[.,]\d+)?", re.IGNORECASE)
_SPEND_VERB = re.compile(r"^(купил[аи]?|потратил[аи]?|заплатил[аи]?|оплатил[аи]?)\s",
                         re.IGNORECASE)  # fmt: skip


def split_parts(text: str) -> list[str]:
    """The parts of a phrase, or [text] when it is one thing (or more than MAX_PARTS)."""
    flat = " ".join(text.split()).strip(" .!")
    if not flat or "?" in flat or len(flat) > 400:
        return [flat] if flat else []
    parts = [p.strip(" ,.;") for p in _SPLIT.split(flat) if p and p.strip(" ,.;")]
    out: list[str] = []
    for part in parts:
        verb = _SPEND_VERB.match(part)
        if verb and len(_AMOUNT.findall(part)) >= 2:
            subs = [x.strip(" ,") for x in re.split(r"\s+и\s+|,\s*", part) if x.strip(" ,")]
            if len(subs) >= 2 and all(_AMOUNT.search(x) for x in subs):
                out += [x if _SPEND_VERB.match(x) else f"{verb.group(1)} {x}" for x in subs]
                continue
        out.append(part)
    return out if len(out) <= MAX_PARTS else [flat]
