"""First launch (week 16, spec 3.11, 6.14; contract docs/api/onboarding.md): the pages S35 ticks
after the first phrase, by code. The API is `assistant.api.routes.onboarding`."""

from assistant.onboarding.marks import DEFAULT_TEMPLATES, INTRO_MARKS, MAX_MARKED, suggested_pages

__all__ = ["DEFAULT_TEMPLATES", "INTRO_MARKS", "MAX_MARKED", "suggested_pages"]
