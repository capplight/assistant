"""Tasks and shopping lists (week 9; spec 3.x `tasks`, F-12, US-10). Contract: docs/api/today.md.

Public surface:
- `parse.read_phrase(text, ...)` → `Reading | None`: a phrase as to-dos / a shopping list. The
  model (`tasks_parse`, consent gate) by default; code first only with `settings.tasks_rules_first`
  (Ф-1). `parse.mentions_list`: routing words only.
- `service.add(session, user_id, specs, by=, now=)` → `Added` (tasks, undo ops, «Что изменилось»
  rows, pages touched, the sentence for the line); `service.list_page`, `tasks_dicts`,
  `field_values` (page fields), `done_sentence`.
"""

from assistant.tasks import parse, service
from assistant.tasks.parse import Reading, TaskSpec, TasksReply, read_phrase

__all__ = ["Reading", "TaskSpec", "TasksReply", "parse", "read_phrase", "service"]
