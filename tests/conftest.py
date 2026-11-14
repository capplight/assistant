"""Shared fixtures for every test package."""

import pytest


@pytest.fixture
def shopping_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ф-49 hides the shopping list by default; tests of «Покупки» itself turn it back on (the
    server reads `feature_shopping` through `get_settings()`)."""
    import assistant.config as config

    on = config.get_settings().model_copy(update={"feature_shopping": True})
    monkeypatch.setattr(config, "get_settings", lambda: on)
