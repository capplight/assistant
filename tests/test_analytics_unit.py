"""Product events keep no content (R-40): registry keys and safe values only."""

from assistant.analytics import clean, pseudo


def test_clean_keeps_registry_keys_and_codes_only():
    assert clean("made_up", {"a": 1}) is None
    assert clean("capture_created", {"channel": "voice", "type": "note", "text": "секрет",
                                     "offline_queued": True, "lang_ui": "ru"}) == {
        "channel": "voice", "type": "note", "offline_queued": True, "lang_ui": "ru"}
    assert clean("duplicate_decided", {"decision": "Мама +77011234567"}) == {}
    assert clean("duplicate_decided", {"decision": "77011234567"}) == {}
    assert clean("search_performed", {"results_count": 12, "latency_ms": 7_011_234_567}) == {
        "results_count": 12}
    assert clean("pages_selected", {"templates": ["notes", "Мои вещи", "expenses"]}) == {
        "templates": ["notes", "expenses"]}


def test_pseudonyms_are_stable_and_not_the_id():
    assert pseudo("user", 42) == pseudo("user", 42) != pseudo("user", 43)
    assert "42" not in pseudo("user", 42) or len(pseudo("user", 42)) == 32
