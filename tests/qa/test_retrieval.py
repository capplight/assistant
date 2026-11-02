from datetime import UTC, datetime

from sqlalchemy.dialects import postgresql

from assistant.qa.filters import QueryFilters, heuristic_filters
from assistant.qa.retrieval import (
    bookings_stmt,
    fts_stmt,
    item_conditions,
    near_stmt,
    nearby_stmt,
    recent_stmt,
    rrf,
    vector_stmt,
    websearch_text,
)


def sql(stmt):
    c = stmt.compile(dialect=postgresql.dialect())
    return " ".join(str(c).split()), c.params


# RRF ----------------------------------------------------------------------------------------


def test_rrf_rewards_agreement():
    fts = [1, 2, 3]
    vec = [3, 4, 1]
    assert rrf([fts, vec]) == [1, 3, 2, 4]


def test_rrf_scores_and_limit():
    fused = rrf([[10, 20], [20]], k=60, limit=1)
    assert fused == [20]  # 1/62 + 1/61 > 1/61


def test_rrf_duplicates_and_empty():
    assert rrf([[5, 5, 6]]) == [5, 6]
    assert rrf([]) == []
    assert rrf([[], []]) == []
    assert len(rrf([list(range(100))])) == 15


def test_rrf_ties_keep_first_seen_order():
    assert rrf([[1], [2]]) == [1, 2]


# Filters -> SQL -----------------------------------------------------------------------------


def test_base_conditions_scope_to_user_and_searchable_statuses():
    text, params = sql(recent_stmt(item_conditions(42, QueryFilters())))
    assert "items.user_id = %(user_id_1)s" in text
    assert "items.status IN" in text
    assert params["user_id_1"] == 42
    assert {"done", "needs_input"} <= set(_flatten(params.values()))
    assert "ORDER BY items.created_at DESC" in text


def _flatten(values):
    for v in values:
        if isinstance(v, (list, tuple)):
            yield from v
        else:
            yield v


def test_city_category_trip_and_dates():
    f = QueryFilters(
        city_variants=["Фукуок", "Phu Quoc"],
        country="vn",
        categories=["food", "beach"],
        trip_hint="Вьетнам",
        date_from="2026-10-01",
        date_to="2026-10-31",
    )
    text, params = sql(recent_stmt(item_conditions(1, f)))
    assert text.count("items.city ILIKE") == 2
    assert "items.country" not in text  # city wins over country
    assert "items.category IN" in text
    assert "items.trip_id IN (SELECT trips.id FROM trips" in text
    values = list(_flatten(params.values()))
    assert {"Фукуок", "Phu Quoc", "food", "beach", "%Вьетнам%"} <= set(values)
    dates = sorted(v for v in values if isinstance(v, datetime))
    assert dates == [datetime(2026, 10, 1, tzinfo=UTC), datetime(2026, 11, 1, tzinfo=UTC)]


def test_country_only_and_like_escaping():
    text, params = sql(recent_stmt(item_conditions(1, QueryFilters(country="vn"))))
    assert "items.country = " in text and "VN" in params.values()
    _, params = sql(recent_stmt(item_conditions(1, QueryFilters(city_variants=["100%_city"]))))
    assert "100\\%\\_city" in params.values()


def test_bad_dates_are_ignored():
    text, _ = sql(recent_stmt(item_conditions(1, QueryFilters(date_from="вчера"))))
    assert "created_at >=" not in text


def test_fts_uses_websearch_simple_and_or_semantics():
    conds = item_conditions(1, QueryFilters())
    text, params = sql(fts_stmt(conds, ["pho", "bánh mì", 'say "hi"']))
    assert "websearch_to_tsquery(CAST(%(param_1)s" in text and "AS REGCONFIG)" in text
    assert "items.tsv @@ websearch_to_tsquery" in text
    assert "ts_rank_cd(items.tsv" in text
    assert params["param_1"] == "simple"
    assert 'pho or "bánh mì" or "say  hi"' in params.values()
    assert fts_stmt(conds, []) is None
    assert fts_stmt(conds, ["  ", '"']) is None


def test_websearch_text_dedups():
    assert websearch_text(["pho", "pho", "phở"]) == "pho or phở"


def test_vector_uses_cosine_operator():
    text, _ = sql(vector_stmt(item_conditions(1, QueryFilters()), [0.1, 0.2]))
    assert "items.embedding <=>" in text
    assert "items.embedding IS NOT NULL" in text


def test_near_arm_and_nearby_query():
    text, params = sql(near_stmt(item_conditions(1, QueryFilters()), 10.21, 103.96, 5000))
    assert "ST_DWithin(places.geom, CAST(ST_MakePoint(" in text
    assert "AS geography(POINT,4326))" in text
    assert "JOIN item_places ON item_places.item_id = items.id" in text
    text, params = sql(nearby_stmt(7, 10.21, 103.96, 1500, 10))
    assert "ST_Distance(places.geom" in text and "ORDER BY distance_m" in text
    vals = list(params.values())
    # lon goes first into ST_MakePoint
    assert vals.index(103.96) < vals.index(10.21)
    assert 1500 in vals and 7 in vals and 30 in vals


def test_bookings_only_confirmed_upcoming_by_default():
    now = datetime(2026, 12, 1, tzinfo=UTC)
    text, _ = sql(bookings_stmt(1, QueryFilters(wants_bookings=True), now))
    assert "bookings.confirmed_at IS NOT NULL" in text
    assert "bookings.starts_at IS NULL OR bookings.starts_at >=" in text
    text, _ = sql(bookings_stmt(1, QueryFilters(date_from="2026-12-10"), now))
    assert "bookings.starts_at IS NULL" not in text


def test_heuristic_filters():
    f = heuristic_filters("Что я сохранял про бань ми и пляжи в Хойане?")
    assert f.keywords == ["бань", "пляжи", "хойане"]
    assert not f.wants_bookings
    assert heuristic_filters("Когда мой рейс?").wants_bookings
