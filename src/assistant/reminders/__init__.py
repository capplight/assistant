"""App reminders as alarms (week 8; spec 3-engineering 3.x, 4.5, 6.6; R-05, R-09…R-14; Ф-1).

Public surface (contract: docs/api/reminders.md):
- `parse_phrase(...)` → `ParseOutcome`: «как понял» for S13, nothing saved. Rules first only
  when `settings.reminders_rules_first` (Ф-1); otherwise the model (`reminder_parse`).
- `service`: `create`, `change`, `delete`, `create_test`, `window`, `apply_events`,
  `mark_active` / `retarget` (last active phone), JSON shapes `reminders_dicts`, `fires_dicts`.
- `worker.tick(sessionmaker, push_sender)`: backup push at +3 min, `missed` at +30 min, top-up
  of repeating reminders; loop `python -m assistant.reminders`.
- `rules.parse`: the deterministic RU parser (shared vectors docs/api/reminder-parse-vectors.json).
"""

from assistant.reminders import rules, service, texts, worker
from assistant.reminders.parse import Draft, ParseOutcome, ReminderParseOut, parse_phrase

__all__ = ["Draft", "ParseOutcome", "ReminderParseOut", "parse_phrase", "rules", "service",
           "texts", "worker"]  # fmt: skip
