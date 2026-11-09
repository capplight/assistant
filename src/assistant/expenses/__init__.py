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
"""

from assistant.expenses import amounts, calc, parse, service
from assistant.expenses.parse import ExpenseDraft, ExpenseReply, read_phrase

__all__ = ["ExpenseDraft", "ExpenseReply", "amounts", "calc", "parse", "read_phrase", "service"]
