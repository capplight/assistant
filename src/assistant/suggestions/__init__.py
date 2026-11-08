"""Tips and data proposals (week 9; spec 3.4, 6.5; R-35, R-08). Contract: docs/api/today.md.

Public surface: `engine.current(session, user_id, now, settings)` (what «Сегодня» shows),
`engine.decide(...)` (accept / «Не сейчас»), `engine.views` (JSON), `engine.SuggestionGone`.
"""

from assistant.suggestions import engine

__all__ = ["engine"]
