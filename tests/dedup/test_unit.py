"""Repeat signals and candidate generation without a database, on a synthetic corpus."""

import random

from assistant.dedup import similarity as sim
from assistant.dedup.texts import import_summary, plural
from assistant.records.textnorm import content_hash
from tests.dedup.corpus import build, truth_pairs


def detect(recs, *, cosines=None):  # type: ignore[no-untyped-def]
    """The scan's code path: blocking, signals, decide; exact repeats are left to the cleanup."""
    docs = [sim.make_doc(r.id, r.text) for r in recs]
    by = {d.id: d for d in docs}
    hashes = {r.id: content_hash(r.text) for r in recs}
    pairs = sim.prefix_pairs(docs) | sim.simhash_pairs(docs) | set(cosines or {})
    sure, judge = set(), set()
    for p in pairs:
        if hashes[p[0]] == hashes[p[1]]:
            continue
        what, _ = sim.decide(sim.signals(by[p[0]], by[p[1]], (cosines or {}).get(p)))
        if what == sim.SURE:
            sure.add(p)
        elif what == sim.JUDGE:
            judge.add(p)
    return sure, judge


def test_simhash_is_stable_signed_and_close_for_close_texts():
    a = "Позвонить в управляющую компанию насчёт протечки в ванной и спросить про сантехника"
    h = sim.simhash(a)
    assert h is not None and -(1 << 63) <= h < (1 << 63) and h == sim.simhash(a)
    assert sim.simhash("коротко") is None
    assert sim.hamming(h, sim.simhash(a.upper() + "!")) == 0
    other = sim.simhash("Совсем другая заметка про рецепт плова с бараниной и морковью")
    assert sim.hamming(h, other) > 10


def test_trigrams_match_pg_trgm_padding_and_jaccard():
    assert sim.trigrams("кот") == frozenset({"  к", " ко", "кот", "от "})
    assert sim.jaccard(sim.trigrams("кот"), sim.trigrams("Кот!")) == 1.0
    assert sim.jaccard(frozenset(), sim.trigrams("кот")) == 0.0


def test_numbers_conflict_only_when_neither_holds_the_other():
    n = sim.numbers
    assert sim.numbers_conflict(n("12 марта в 15:00"), n("13 марта в 15:00"))
    assert not sim.numbers_conflict(n("позвонить Арману"), n("позвонить Арману 87011234567"))
    assert not sim.numbers_conflict(n("в 15:00"), n("12 марта в 15:00"))


def test_decide_follows_the_spec_thresholds():
    s = sim.PairSignals
    assert sim.decide(s(3, 0.1, None, False)) == (sim.SURE, "simhash")
    assert sim.decide(s(4, 0.81, None, False)) == (sim.SURE, "trgm")
    assert sim.decide(s(None, 0.8, None, False))[0] == sim.NO  # «> 0.8», not ≥
    assert sim.decide(s(None, 0.2, 0.92, False)) == (sim.SURE, "embedding")
    assert sim.decide(s(None, 0.2, 0.86, False)) == (sim.JUDGE, "embedding")
    assert sim.decide(s(None, 0.2, 0.84, False))[0] == sim.NO
    assert sim.decide(s(0, 0.95, None, True))[0] == sim.JUDGE  # a date differs: never on signals


def test_prefix_filter_misses_no_pair_above_the_threshold():
    rng = random.Random(3)
    words = "дом сад кот лес мост река поле гора снег дождь окно стол".split()
    docs = [sim.make_doc(i, " ".join(rng.choice(words) for _ in range(rng.randint(3, 9))))
            for i in range(150)]  # fmt: skip
    brute = {(a.id, b.id) for i, a in enumerate(docs) for b in docs[i + 1:]
             if sim.jaccard(a.grams, b.grams) >= 0.8}
    assert brute and brute <= sim.prefix_pairs(docs, 0.8)


def test_union_find_components():
    assert sim.components([(1, 2), (3, 4), (2, 3), (7, 9)]) == [[1, 2, 3, 4], [7, 9]]


def test_paragraph_diff_keeps_only_what_is_new():
    keep = "Купить краску.\nПозвонить мастеру."
    other = "купить краску!\nСпросить про скидку."
    assert sim.paragraphs_missing(keep, other) == ["Спросить про скидку."]


def test_quality_on_the_synthetic_corpus():
    """Measured, not tuned to pass: code-only path (no embeddings, no judge). The numbers go to
    the report; the asserts only guard against a regression."""
    recs = build()
    truth = truth_pairs(recs)
    sure, judge = detect(recs)
    tp = len(sure & truth)
    precision = tp / len(sure) if sure else 1.0
    recall = tp / len(truth)
    print(f"\nsynthetic corpus: {len(recs)} records, {len(truth)} true near pairs; "
          f"sure={len(sure)} tp={tp} precision={precision:.2f} recall={recall:.2f}; "
          f"to judge={len(judge)}")
    assert precision >= 0.95
    assert recall >= 0.6
    clusters = {r.id: r.cluster for r in recs}
    assert all(clusters[a] == clusters[b] for a, b in sure), "a false merge suggestion"


def test_hard_negatives_are_never_sure():
    recs = build(repeats=("typo",))
    sure, judge = detect(recs)
    by = {r.id: r for r in recs}
    negatives = {(a, b) for a, b in sure | judge if by[a].cluster != by[b].cluster}
    assert not (negatives & sure)


def test_russian_plurals_and_import_summary():
    assert plural(1, ("повтор", "повтора", "повторов")) == "1 повтор"
    assert plural(22, ("повтор", "повтора", "повторов")) == "22 повтора"
    assert plural(212, ("повтор", "повтора", "повторов")) == "212 повторов"
    assert import_summary(640, 212, {"video": 34}) == (
        "Принёс 640 записей, 212 повторов убрал, видео (34) не перенёс — только подписи.")
