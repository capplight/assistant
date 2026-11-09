"""Bank statement PDFs read by the bank's template (spec 6.13: «`pdfplumber` по шаблону банка»).

Pure code, no model, always on: this is reading a table by its columns, not reading a phrase (Ф-1
does not apply). Words come from pdfplumber with their x position; the header row of the bank's
table gives the column bounds; every row with a day in the first column is an operation, and a
line below it inside the description column continues its description.

Then the check (the week 13 finish criterion): code adds the operations up by kind and compares
each sum, and the closing balance, with the bank's own summary on the same statement, to the
tiyn. Templates (calibrate on real, anonymised PDFs — founder decision Ф-26):
- `kaspi_gold`: «Выписка по Kaspi Gold за период с 01.10.26 по 31.10.26», a summary block
  («Доступно на …», «Пополнения», «Переводы», «Покупки», «Снятия», «Разное»), table «Дата · Сумма ·
  Операция · Детали», amounts «- 2 500,00 ₸».
- `halyk`: «Выписка по счёту … за период 01.10.2026 - 31.10.2026», «Входящий остаток», table
  «Дата операции · Дата отражения · Описание · Сумма · Валюта · Приход · Расход · Комиссия»,
  «Итого поступлений / расходов / комиссий», «Исходящий остаток».
Anything else raises `statement_unknown_format` with the lines, for the model to read (service).
The PDF's text is data; nothing in it is followed.
"""

import io
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from assistant.expenses.documents import money, parse_day, signed_amount

MAX_PAGES = 60
MAX_ROWS = 2000
ZERO = Decimal("0.00")


class StatementError(ValueError):
    def __init__(self, code: str, lines: "list[Line] | None" = None) -> None:
        super().__init__(code)
        self.code = code
        self.lines = lines or []


@dataclass
class Word:
    x0: float
    text: str


@dataclass
class Line:
    page: int
    top: float
    words: list[Word]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    def cell(self, lo: float, hi: float) -> str:
        return " ".join(w.text for w in self.words if lo <= w.x0 < hi).strip()


@dataclass
class Op:
    """One operation as the bank wrote it. `amount` > 0, `sign` −1 money left / +1 came in, in
    the account currency."""

    n: int
    day: date
    amount: Decimal
    sign: int
    label: str  # the bank's word: «Покупка», «Перевод»…
    description: str
    kind: str = "other"  # purchase | transfer | withdrawal | topup | refund | fee | other
    direction: str = "expense"
    method: str | None = None
    note: str | None = None  # «10.00 USD» for an operation in another currency
    key: str = ""

    @property
    def signed(self) -> Decimal:
        return self.amount if self.sign > 0 else -self.amount


@dataclass
class Check:
    ok: bool
    lines: list[dict] = field(default_factory=list)

    def add(self, key: str, title: str, bank: Decimal, ours: Decimal) -> None:
        good = money(bank) == money(ours)
        self.lines.append({"key": key, "title": title, "bank": f"{money(bank):.2f}",
                           "ours": f"{money(ours):.2f}", "ok": good})  # fmt: skip
        self.ok = self.ok and good


@dataclass
class Parsed:
    bank: str
    parser: str  # template | model
    currency: str
    period_from: date | None
    period_to: date | None
    ops: list[Op]
    check: Check | None


# --- words → lines ---


def pdf_lines(data: bytes) -> list[Line]:
    import pdfplumber

    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except Exception as exc:
        raise StatementError("statement_unreadable") from exc
    out: list[Line] = []
    try:
        with pdf:
            if len(pdf.pages) > MAX_PAGES:
                raise StatementError("statement_too_long")
            for number, page in enumerate(pdf.pages, start=1):
                words = page.extract_words(x_tolerance=1.5, y_tolerance=2, keep_blank_chars=False)
                rows: list[Line] = []
                for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
                    if rows and abs(rows[-1].top - w["top"]) <= 2:
                        rows[-1].words.append(Word(w["x0"], w["text"]))
                    else:
                        rows.append(Line(number, w["top"], [Word(w["x0"], w["text"])]))
                for r in rows:
                    r.words.sort(key=lambda w: w.x0)
                out.extend(rows)
    except StatementError:
        raise
    except Exception as exc:  # encrypted, broken
        raise StatementError("statement_unreadable") from exc
    return out


def _norm(text: str) -> str:
    return " ".join(text.lower().replace("ё", "е").split())


def row_keys(bank: str, ops: list[Op]) -> None:
    """A key per row that is the same when the same statement is read again: the bank, the day,
    the signed amount, the description and the ordinal among identical rows."""
    seen: Counter[tuple] = Counter()
    for op in ops:
        base = (bank, op.day.isoformat(), f"{op.signed:.2f}", _norm(op.description)[:200])
        seen[base] += 1
        op.key = "|".join([*base, str(seen[base])])


_AMOUNT_TAIL = r"([-−+]?\s?\d{1,3}(?:[  ]\d{3})*(?:[.,]\d{2}))\s*(?:₸|KZT|тг)?"


def _amount_after(label: str, lines: list[Line]) -> Decimal | None:
    rx = re.compile(r"^\s*" + label + r"\s*:?\s*" + _AMOUNT_TAIL + r"\s*$", re.IGNORECASE)
    for line in lines:
        m = rx.match(line.text)
        if m:
            return signed_amount(m.group(1))
    return None


def _columns(header: Line, names: list[str]) -> list[float] | None:
    """x of each header word in order (a name may repeat: «Дата», «Дата»)."""
    xs: list[float] = []
    i = 0
    for w in header.words:
        if i < len(names) and w.text.lower().startswith(names[i].lower()):
            xs.append(w.x0)
            i += 1
    return xs if i == len(names) else None


def _bounds(xs: list[float]) -> list[tuple[float, float]]:
    pad = 2.0
    return [(x - pad, (xs[i + 1] - pad) if i + 1 < len(xs) else 10_000.0)
            for i, x in enumerate(xs)]  # fmt: skip


def _table(lines: list[Line], names: list[str], first: int, read_row, *,
           desc_col: int) -> tuple[list[Op], int]:  # fmt: skip
    """Rows under every header of the table. `read_row(cells, n) -> Op | None | False`: an op,
    None (not a row: a total, a footer), False (a dated row code could not read)."""
    ops: list[Op] = []
    unread = 0
    bounds: list[tuple[float, float]] | None = None
    last: tuple[int, float] | None = None
    for line in lines:
        xs = _columns(line, names)
        if xs is not None:
            bounds = _bounds(xs)
            last = None
            continue
        if bounds is None:
            continue
        cells = [line.cell(lo, hi) for lo, hi in bounds]
        if parse_day(cells[first]) is not None:
            op = read_row(cells, len(ops) + 1)
            if op is False:
                unread += 1
                last = None
                continue
            if op is None:
                last = None
                continue
            ops.append(op)
            last = (line.page, line.top)
            continue
        lo = bounds[desc_col][0]
        hi = bounds[desc_col][1]
        inside = all(lo <= w.x0 < hi for w in line.words)
        if (ops and last and inside and line.page == last[0]
                and 0 < line.top - last[1] <= 16):  # fmt: skip
            ops[-1].description = f"{ops[-1].description} {line.text}".strip()
            last = (line.page, line.top)
        else:
            last = None
    return ops, unread


# --- Kaspi Gold ---

_KASPI_PERIOD = re.compile(r"за\s+период\s+с\s+(\d{2}\.\d{2}\.\d{2,4})\s+по\s+"
                           r"(\d{2}\.\d{2}\.\d{2,4})", re.IGNORECASE)  # fmt: skip
_KASPI_SUMMARY = [("topups", "Пополнения", "Пополнение"), ("transfers", "Переводы", "Перевод"),
                  ("purchases", "Покупки", "Покупка"), ("withdrawals", "Снятия", "Снятие"),
                  ("other", "Разное", "Разное")]  # fmt: skip


_KASPI_BALANCE = re.compile(r"^\s*Доступно\s+на\s+(\d{2}\.\d{2}\.\d{2,4})\s*:?\s*"
                            + _AMOUNT_TAIL + r"\s*$", re.IGNORECASE)  # fmt: skip


def is_kaspi(text: str) -> bool:
    return bool(re.search(r"kaspi\s+gold", text, re.IGNORECASE)) and bool(
        re.search(r"kaspi\.kz|kaspi\s+bank", text, re.IGNORECASE))


def _kaspi_kind(op: Op) -> None:
    label = op.label.lower()
    if label.startswith("покуп"):
        op.kind, op.direction, op.method = (("purchase", "expense", "kaspi") if op.sign < 0
                                            else ("refund", "refund", "kaspi"))  # fmt: skip
    elif label.startswith("перевод"):
        op.kind, op.direction, op.method = (("transfer", "expense", "transfer") if op.sign < 0
                                            else ("topup", "income", "transfer"))  # fmt: skip
    elif label.startswith("снят"):
        op.kind, op.direction, op.method = "withdrawal", "transfer_own", "cash"
    elif label.startswith("пополн"):
        op.kind, op.direction, op.method = "topup", "income", None
    else:
        op.kind, op.direction = "other", ("expense" if op.sign < 0 else "income")


def parse_kaspi(lines: list[Line]) -> Parsed:
    text = "\n".join(line.text for line in lines)
    m = _KASPI_PERIOD.search(text)
    p_from = parse_day(m.group(1)) if m else None
    p_to = parse_day(m.group(2)) if m else None

    def read_row(cells: list[str], n: int) -> Op | None | bool:
        day = parse_day(cells[0])
        amount = signed_amount(cells[1])
        if day is None or amount is None or amount == 0 or not cells[2]:
            return False
        op = Op(n=n, day=day, amount=abs(amount), sign=1 if amount > 0 else -1,
                label=cells[2], description=cells[3])  # fmt: skip
        _kaspi_kind(op)
        return op

    ops, unread = _table(lines, ["Дата", "Сумма", "Операция", "Детали"], 0, read_row,
                         desc_col=3)  # fmt: skip
    check = Check(ok=unread == 0)
    if unread:
        check.lines.append({"key": "unread", "title": "Строки, которые не прочитал",
                            "bank": None, "ours": str(unread), "ok": False})  # fmt: skip
    opening = closing = None
    for line in lines:
        mm = _KASPI_BALANCE.match(line.text)
        if mm:
            d = parse_day(mm.group(1))
            v = signed_amount(mm.group(2))
            if d == p_from and opening is None:
                opening = v
            elif d == p_to:
                closing = v
    for key, title, label in _KASPI_SUMMARY:
        bank = _amount_after(title, lines)
        if bank is None:
            continue
        ours = sum((o.signed for o in ops if o.label.lower().startswith(label.lower()[:5])), ZERO)
        check.add(key, title, bank, ours)
    if opening is not None and closing is not None:
        check.add("closing", "Остаток на конец", closing, opening + sum((o.signed for o in ops),
                                                                         ZERO))  # fmt: skip
    if not check.lines or opening is None or closing is None:
        check.ok = False  # no summary to check against: the rows are «Проверьте»
    return Parsed("kaspi_gold", "template", "KZT", p_from, p_to, ops, check)


# --- Halyk ---

_HALYK_PERIOD = re.compile(r"период\w*\s+(?:с\s+)?(\d{2}\.\d{2}\.\d{4})\s*(?:-|–|по)\s*"
                           r"(\d{2}\.\d{2}\.\d{4})", re.IGNORECASE)  # fmt: skip


def is_halyk(text: str) -> bool:
    return bool(re.search(r"halyk|народный\s+банк", text, re.IGNORECASE))


def _halyk_kind(op: Op) -> None:
    d = op.label.lower()
    if op.kind == "fee":
        op.direction = "expense"
        return
    if d.startswith(("покупк", "оплат")):
        op.kind, op.direction, op.method = (("purchase", "expense", "card") if op.sign < 0
                                            else ("refund", "refund", "card"))  # fmt: skip
    elif d.startswith("возврат") and op.sign > 0:
        op.kind, op.direction, op.method = "refund", "refund", "card"
    elif d.startswith("перевод"):
        op.kind, op.direction, op.method = (("transfer", "expense", "transfer") if op.sign < 0
                                            else ("topup", "income", "transfer"))  # fmt: skip
    elif d.startswith("снят"):
        op.kind, op.direction, op.method = "withdrawal", "transfer_own", "cash"
    elif d.startswith(("пополн", "зачисл", "поступл")):
        op.kind, op.direction = "topup", "income"
    else:
        op.kind, op.direction = "other", ("expense" if op.sign < 0 else "income")


_SHOP_LEAD = re.compile(r"^\s*(?:покупка|оплата|возврат)\s*[.:,-]\s*", re.IGNORECASE)


def parse_halyk(lines: list[Line]) -> Parsed:
    text = "\n".join(line.text for line in lines)
    m = _HALYK_PERIOD.search(text)
    p_from = parse_day(m.group(1)) if m else None
    p_to = parse_day(m.group(2)) if m else None
    cur = re.search(r"Валюта\s+сч[её]та\s*:?\s*([A-Z]{3})", text)
    currency = cur.group(1) if cur else "KZT"
    fees: list[Op] = []

    def read_row(cells: list[str], n: int) -> Op | None | bool:
        day = parse_day(cells[0])
        credit = signed_amount(cells[5]) if cells[5] else ZERO
        debit = signed_amount(cells[6]) if cells[6] else ZERO
        fee = signed_amount(cells[7]) if cells[7] else ZERO
        orig = signed_amount(cells[3]) if cells[3] else None
        if day is None or credit is None or debit is None or fee is None or not cells[2]:
            return False
        value = credit if credit else debit
        if value == 0 and fee == 0:
            return False
        desc = cells[2]
        payee = _SHOP_LEAD.sub("", desc).strip() or desc  # «Покупка. SMALL» → «SMALL»
        op = Op(n=n, day=day, amount=abs(value), sign=1 if value > 0 else -1, label=desc,
                description=payee)  # fmt: skip
        if cells[4] and cells[4] != currency and orig is not None:
            op.note = f"{abs(orig):.2f} {cells[4]}"
        if fee:
            fees.append(Op(n=0, day=day, amount=abs(fee), sign=-1, label="Комиссия",
                           description="Комиссия банка", kind="fee"))  # fmt: skip
        if value == 0:
            return None
        _halyk_kind(op)
        return op

    names = ["Дата", "Дата", "Описание", "Сумма", "Валюта", "Приход", "Расход", "Комиссия"]
    ops, unread = _table(lines, names, 0, read_row, desc_col=2)
    for f in fees:
        _halyk_kind(f)
    ops = sorted([*ops, *fees], key=lambda o: (o.day, 0 if o.kind != "fee" else 1))
    for i, op in enumerate(ops, start=1):
        op.n = i
    check = Check(ok=unread == 0)
    if unread:
        check.lines.append({"key": "unread", "title": "Строки, которые не прочитал",
                            "bank": None, "ours": str(unread), "ok": False})  # fmt: skip
    plain = [o for o in ops if o.kind != "fee"]
    pairs = [("credits", "Итого поступлений", sum((o.signed for o in plain if o.sign > 0), ZERO)),
             ("debits", "Итого расходов", sum((o.signed for o in plain if o.sign < 0), ZERO)),
             ("fees", "Итого комиссий", sum((o.signed for o in ops if o.kind == "fee"), ZERO))]
    for key, title, ours in pairs:
        bank = _amount_after(title, lines)
        if bank is not None:
            check.add(key, title, bank, ours)
    opening = _amount_after(r"Входящий\s+остаток", lines)
    closing = _amount_after(r"Исходящий\s+остаток", lines)
    if opening is not None and closing is not None:
        check.add("closing", "Остаток на конец", closing,
                  opening + sum((o.signed for o in ops), ZERO))  # fmt: skip
    if not check.lines or opening is None or closing is None:
        check.ok = False
    return Parsed("halyk", "template", currency, p_from, p_to, ops, check)


# --- entry ---


def parse(data: bytes) -> Parsed:
    """A statement PDF by its bank's template. Raises StatementError: `statement_unreadable`,
    `statement_too_long`, `statement_empty`, `statement_unknown_format` (with `.lines`)."""
    lines = pdf_lines(data)
    text = "\n".join(line.text for line in lines)
    if not text.strip():
        raise StatementError("statement_unknown_format", lines)
    if is_kaspi(text):
        parsed = parse_kaspi(lines)
    elif is_halyk(text):
        parsed = parse_halyk(lines)
    else:
        raise StatementError("statement_unknown_format", lines)
    if not parsed.ops:
        raise StatementError("statement_empty")  # the bank's template, but no operation
    if len(parsed.ops) > MAX_ROWS:
        raise StatementError("statement_too_long")
    row_keys(parsed.bank, parsed.ops)
    return parsed


__all__ = ["Check", "Line", "Op", "Parsed", "StatementError", "parse", "pdf_lines", "row_keys"]
