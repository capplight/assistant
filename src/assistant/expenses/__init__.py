"""«Расходы» (week 12; spec 3.12, 4.11, 6.13; F-40, US-31, R-36, R-59). Contract:
docs/api/expenses.md. Totals are computed by code only.

Public surface:
- `amounts.find_amounts(text)`, `amounts.said(text, value)`: amounts in a person's words (RU/KK),
  the check of the model's reading; `amounts.best_amount` for the rules-first reader.
- `parse.read_phrase(text, ...)` → `ExpenseDraft | None`: the model (`expense_parse`, consent gate)
  by default, code first only with `settings.expenses_rules_first` (Ф-1); `parse.mentions_expense`
  is routing only.
- `calc`: `evaluate` (the keypad sum, never `eval`), `aggregate`, `period_bounds`, `format_money`;
  shared vectors docs/spec/vectors/calc.json.
- `service`: categories (the person's copy of the 8 + «Переводы», chip order), `create`,
  `expenses_dicts`, `totals`, `field_values`.
Week 13 («Расходы 2»):
- `documents`: amounts and days written in a document (the check of every number the model gives).
- `receipts`: a receipt's text → a draft (the model, checked by code; code first only with Ф-1).
- `ofd`: fiscal QR links (allowlisted OFD hosts) and the SSRF-guarded OFD page reader.
- `statements`: bank statement PDFs by the bank's template + the check against its summary.
- `imports`: a statement → a plan → one «Да» (`bulk_create_expenses`) → one «Отменить».
- `repeats`: «Похоже, эта трата уже есть [Объединить?]».
"""

from assistant.expenses import (
    amounts,
    calc,
    documents,
    imports,
    ofd,
    parse,
    receipts,
    repeats,
    service,
    statements,
)
from assistant.expenses.imports import StatementReply
from assistant.expenses.parse import ExpenseDraft, ExpenseReply, read_phrase
from assistant.expenses.receipts import ReceiptReply

__all__ = ["ExpenseDraft", "ExpenseReply", "ReceiptReply", "StatementReply", "amounts", "calc",
           "documents", "imports", "ofd", "parse", "read_phrase", "receipts", "repeats",
           "service", "statements"]  # fmt: skip
