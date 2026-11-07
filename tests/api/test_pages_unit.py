"""LexoRank against the shared vectors, `auto_rule`, and the frozen copy in the migration."""

import importlib.util
import json
import random
from pathlib import Path

import pytest

from assistant.pages import lexorank as lr
from assistant.pages.rules import ItemFacts, aspects_of, is_valid_rule, matches

ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads((ROOT / "docs/spec/vectors/lexorank.json").read_text(encoding="utf-8"))


def _migration():
    spec = importlib.util.spec_from_file_location(
        "migration_0007", ROOT / "migrations/versions/0007_pages.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- lexorank ---


def test_vectors_alphabet_matches_code():
    assert VECTORS["alphabet"] == lr.ALPHABET
    assert VECTORS["max_length"] == lr.MAX_LENGTH
    assert list(lr.ALPHABET) == sorted(lr.ALPHABET)  # ASCII order: "C" collation and JS `<`


@pytest.mark.parametrize("case", VECTORS["between"], ids=lambda c: f"{c['a']}|{c['b']}")
def test_between_vectors(case):
    a, b, key = case["a"], case["b"], case["expect"]
    assert lr.between(a, b) == key
    assert lr.is_valid(key)
    assert a is None or a < key
    assert b is None or key < b


@pytest.mark.parametrize("case", VECTORS["invalid"], ids=lambda c: f"{c['a']}|{c['b']}")
def test_invalid_vectors(case):
    with pytest.raises(lr.RankError):
        lr.between(case["a"], case["b"])


@pytest.mark.parametrize("case", VECTORS["sequence"], ids=lambda c: str(c["n"]))
def test_sequence_vectors(case):
    keys = lr.sequence(case["n"])
    assert keys == case["expect"]
    assert keys == sorted(keys) and len(set(keys)) == len(keys)


@pytest.mark.parametrize("case", VECTORS["sequence_samples"], ids=lambda c: str(c["n"]))
def test_sequence_samples(case):
    keys = lr.sequence(case["n"])
    assert len(keys) == case["len"]
    assert (keys[0], keys[-1], keys[case["n"] // 2]) == (
        case["first"], case["last"], case["at_index_n_div_2"])  # fmt: skip
    assert keys == sorted(keys) and all(lr.is_valid(k) for k in keys)
    assert len(set(keys)) == len(keys)


def test_chain_vector_reproduces_step_by_step():
    keys: list[str] = []
    for step in VECTORS["chain"]:
        i = step["insert_at"]
        key = lr.between(keys[i - 1] if i else None, keys[i] if i < len(keys) else None)
        assert key == step["expect"]
        keys.insert(i, key)
    assert keys == VECTORS["chain_sorted"]


def test_sort_check_vector():
    assert sorted(VECTORS["sort_check"]["input"]) == VECTORS["sort_check"]["bytewise"]


@pytest.mark.parametrize("seed", range(5))
def test_random_inserts_keep_strict_order(seed):
    rnd = random.Random(seed)
    keys: list[str] = []
    for _ in range(1500):
        i = rnd.randint(0, len(keys))
        key = lr.between(keys[i - 1] if i else None, keys[i] if i < len(keys) else None)
        assert lr.is_valid(key)
        keys.insert(i, key)
    assert keys == sorted(keys) and len(set(keys)) == len(keys)


def test_same_gap_again_and_again_stays_ordered():
    low, high = "A", "B"
    for _ in range(600):
        high = lr.between(low, high)
        assert low < high
    low, high = "A", "B"
    for _ in range(600):
        low = lr.between(low, high)
        assert low < high


def test_append_and_prepend_stay_short():
    key = "V"
    for _ in range(1000):
        next_key = lr.between(key, None)
        assert key < next_key
        key = next_key
    assert len(key) <= 40
    key = "V"
    for _ in range(1000):
        next_key = lr.between(None, key)
        assert next_key < key
        key = next_key
    assert len(key) <= 40


def test_rebalance_room_between_sequence_neighbours():
    keys = lr.sequence(500)
    for low, high in zip(keys, keys[1:], strict=False):
        key = lr.between(low, high)
        assert low < key < high
        assert len(key) <= len(max(low, high, key=len)) + 1


def test_migration_keys_are_the_same_as_the_code():
    migration = _migration()
    for n in (0, 1, 2, 7, 61, 62, 500, 4000):
        assert migration._keys(n) == lr.sequence(n)


# --- auto_rule ---


def _facts(kind="note", envelope=None, title=None, summary=None, text=None) -> ItemFacts:
    return ItemFacts(kind=kind, envelope=envelope, title=title, summary=summary, text=text)


def test_rule_shapes():
    assert matches({"any": [{"always": True}]}, _facts())
    assert not matches({"any": []}, _facts())
    assert not matches(None, _facts())
    assert not matches({}, _facts())
    assert not matches({"any": [{"always": False}]}, _facts())
    assert not matches({"any": "always"}, _facts())


def test_unknown_or_odd_conditions_never_match():
    assert not matches({"any": [{"regex": ".*"}]}, _facts(text="всё"))
    assert not matches({"any": [{"kinds": "note"}]}, _facts())
    assert not matches({"any": [{"kinds": ["note"], "words": ["a"]}]}, _facts())
    assert not matches({"any": ["always"]}, _facts())


def test_kinds_and_envelope_types():
    assert matches({"any": [{"kinds": ["pdf"]}]}, _facts(kind="pdf"))
    assert not matches({"any": [{"kinds": ["pdf"]}]}, _facts(kind="note"))
    rule = {"any": [{"envelope_types": ["receipt"]}]}
    assert matches(rule, _facts(envelope={"type": "receipt"}))
    assert not matches(rule, _facts(envelope={"type": "note"}))
    assert not matches(rule, _facts())


def test_aspects():
    envelope = {"type": "note", "proposed": {"reminders": [{"text": "x"}], "tasks": []},
                "entities": {"amounts": ["5000"]}}  # fmt: skip
    assert aspects_of(envelope) == {"reminder", "amount"}
    assert aspects_of(None) == frozenset()
    assert aspects_of({"proposed": "bad", "entities": 3}) == frozenset()
    assert matches({"any": [{"aspects": ["reminder"]}]}, _facts(envelope=envelope))
    assert not matches({"any": [{"aspects": ["task"]}]}, _facts(envelope=envelope))


def test_words_ignore_case_and_match_word_starts():
    rule = {"any": [{"words": ["ремонт"]}]}
    assert matches(rule, _facts(text="Смета на РЕМОНТА кухни"))
    assert matches(rule, _facts(title="ремонт"))
    assert matches(rule, _facts(summary="про ремонту"))
    assert not matches(rule, _facts(text="авторемонт"))
    assert not matches(rule, _facts())
    assert not matches({"any": [{"words": ["", " "]}]}, _facts(text="всё"))


def test_is_valid_rule():
    assert is_valid_rule({"any": []})
    assert is_valid_rule({"any": [{"words": ["x"]}, {"always": True}]})
    assert not is_valid_rule({"all": []})
    assert not is_valid_rule({"any": [{"regex": "x"}]})
    assert not is_valid_rule([])


def test_seeded_catalogue_is_well_formed():
    migration = _migration()
    templates = {t["key"]: t for t in migration.TEMPLATES}
    assert set(templates) == {"today", "custom", "notes", "tasks", "shopping", "documents",
                              "expenses"}  # fmt: skip
    gallery = sorted((t for t in templates.values() if t["catalog_visible"]),
                     key=lambda t: t["catalog_order"])  # fmt: skip
    assert [t["key"] for t in gallery][0] == "custom"  # like «Пустая книга» in Excel
    assert len(gallery) == 6 and not templates["today"]["catalog_visible"]
    for t in templates.values():
        assert is_valid_rule(t["auto_rule"]), t["key"]
        assert t["default_layout"] in t["layouts"]
        assert t["singleton"] is (t["key"] != "custom")
    required = {key: {f["id"] for f in t["fields"] if f["required"]}
                for key, t in templates.items()}  # fmt: skip
    assert required == {  # ★ in 03, 3.2
        "today": set(),
        "custom": {"title"},
        "notes": {"text"},
        "tasks": {"what", "when", "done"},
        "shopping": {"what", "bought"},
        "documents": {"name"},
        "expenses": {"amount", "date"},
    }
    # A person never sees a page on Today by rule, and a blank page holds what they put there.
    assert templates["today"]["auto_rule"] == {"any": []}
    assert templates["custom"]["auto_rule"] == {"any": []}
    assert templates["custom"]["default_title"]["ru"] == "Моя страница"
