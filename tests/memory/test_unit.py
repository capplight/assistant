"""Pure code of assistant.memory: folding, tokens, chunking, snippets, storage policy, embedders."""

import httpx
import pytest
import respx

from assistant.embeddings import (
    FakeEmbedder,
    NullChunkEmbedder,
    TeiEmbedder,
    make_chunk_embedder,
)
from assistant.memory import OriginalFacts, OriginalFate, StorageFlags, embed_query, original_fate
from assistant.memory.chunking import OVERLAP_CHARS, TARGET_CHARS, chunk_text
from assistant.memory.embed_jobs import fingerprint, inputs_for
from assistant.memory.fold import fold, tokens, translit
from assistant.memory.search import kinds_for, make_snippet, tsquery_text


def test_fold_kazakh_letters_case_and_yo():
    assert fold("ҚАЛА Өнер ІС ЁЛКА Ұлы әғң үһ") == "кала онер ис елка улы агн ух"
    assert len(fold("ҚАЛА Өнер")) == len("ҚАЛА Өнер")


def test_translit_is_ascii_and_brings_scripts_together():
    assert translit("Каспи") == translit("Kaspi") == "kaspi"
    assert translit("Қала день").isascii()
    assert translit("день") == "din"


def test_translit_makes_confusable_vowels_one_letter():
    assert translit("молоко") == translit("малако") == translit("молако")
    assert translit("семинар") == translit("симинар")


def test_tokens_drop_stop_words_unless_nothing_else():
    assert tokens("Куда я записала размер обуви сына?") == ["записала", "размер", "обуви", "сына"]
    assert tokens("что это") == ["что", "это"]
    assert tokens("!!! ???") == []
    assert len(tokens(" ".join(f"слово{n}" for n in range(30)))) == 8


def test_tsquery_prefixes_only_long_words():
    assert tsquery_text(["молоко", "кг"]) == "'молоко':* | 'кг'"


def test_kinds_include_legacy_values():
    assert kinds_for("note") == ["note", "text"]
    assert kinds_for("pdf") == ["pdf"]


def test_chunks_short_text_is_one():
    assert [c.text for c in chunk_text("Купить хлеб")] == ["Купить хлеб"]
    assert chunk_text(None) == [] and chunk_text("  \n ") == []


def test_chunks_long_text_stay_in_size_overlap_and_cover_everything():
    words = [f"слово{n}." for n in range(3000)]
    text = " ".join(words)
    chunks = chunk_text(text)
    assert len(chunks) > 5
    assert [c.ord for c in chunks] == list(range(len(chunks)))
    assert all(len(c.text) <= TARGET_CHARS for c in chunks)
    assert all(c.token_count > 0 for c in chunks)
    joined = " ".join(c.text for c in chunks)
    assert all(w in joined for w in words)
    # Neighbours share their border.
    assert chunks[0].text[-OVERLAP_CHARS // 2:] in chunks[1].text


def test_chunks_one_word_without_spaces_is_cut():
    chunks = chunk_text("я" * 5000)
    assert all(len(c.text) <= TARGET_CHARS for c in chunks) and len(chunks) >= 4


def test_embedding_inputs_carry_the_title_but_not_twice():
    chunks = chunk_text("Договор аренды\n\nТекст договора")
    assert inputs_for(None, chunks) == [chunks[0].text]
    assert inputs_for("Договор аренды", chunks) == [chunks[0].text]
    assert inputs_for("Аренда", chunks) == [f"Аренда\n{chunks[0].text}"]


def test_fingerprint_changes_with_title_and_text():
    assert fingerprint("a", "b") != fingerprint("a", "c") != fingerprint(None, "c")
    assert fingerprint("a", "b") == fingerprint("a", "b")


def test_snippet_marks_words_in_utf16_units():
    body = "😀 Купила молоко и хлеб"
    snippet, marks = make_snippet(body, ["молоко"])
    assert snippet == body
    start, end = marks[0]
    assert snippet.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le") == "молоко"


def test_snippet_marks_original_letters_of_a_folded_match():
    snippet, marks = make_snippet("Алматы Қаласында", ["каласында"])
    assert snippet[marks[0][0]:marks[0][1]] == "Қаласында"  # fmt: skip


def test_snippet_of_a_long_text_centers_on_the_word():
    body = "начало " * 200 + "ключевое слово" + " конец" * 200
    snippet, marks = make_snippet(body, ["ключевое"])
    assert snippet.startswith("…") and snippet.endswith("…") and len(snippet) <= 205
    assert snippet[marks[0][0]:marks[0][1]] == "ключевое"  # fmt: skip


def test_snippet_finds_the_word_behind_a_typo():
    snippet, marks = make_snippet("Купить молоко домой", ["молако"])
    assert snippet[marks[0][0]:marks[0][1]] == "молоко"  # fmt: skip


def test_snippet_without_a_match_is_the_start():
    assert make_snippet("Просто текст", ["другое"]) == ("Просто текст", [])


# Spec 2.3: the storage policy, a decision table over its flags.
@pytest.mark.parametrize(
    ("facts", "flags", "fate"),
    [
        (OriginalFacts(), StorageFlags(), OriginalFate.TRASH),
        (OriginalFacts(confidence=None), StorageFlags(), OriginalFate.TRASH),
        (OriginalFacts(confidence=0.7), StorageFlags(), OriginalFate.TRASH),
        (OriginalFacts(confidence=0.69), StorageFlags(), OriginalFate.KEEP_UNSURE),
        (OriginalFacts(has_text=False), StorageFlags(), OriginalFate.KEEP_UNSURE),
        (OriginalFacts(confidence=0.5, confirmed=True), StorageFlags(), OriginalFate.TRASH),
        (OriginalFacts(has_text=False, confirmed=True), StorageFlags(), OriginalFate.KEEP_UNSURE),
        (OriginalFacts(confidence=0.5), StorageFlags(keep_while_unsure=False), OriginalFate.TRASH),
        (OriginalFacts(has_text=False), StorageFlags(keep_while_unsure=False), OriginalFate.TRASH),
        (OriginalFacts(data_not_smaller=True), StorageFlags(), OriginalFate.KEEP_SIZE),
        (OriginalFacts(text_possible=False), StorageFlags(), OriginalFate.KEEP_NO_TEXT),
        (OriginalFacts(pinned_by_user=True, confidence=0.1), StorageFlags(), OriginalFate.PIN),
        (OriginalFacts(role="company_logo"), StorageFlags(), OriginalFate.PIN),
        (OriginalFacts(role="company_template"), StorageFlags(), OriginalFate.PIN),
        (OriginalFacts(role="signature"), StorageFlags(), OriginalFate.PIN),
        (OriginalFacts(role="stamp"), StorageFlags(keep_while_unsure=False), OriginalFate.PIN),
    ],
)
def test_original_fate(facts, flags, fate):
    assert original_fate(facts, flags) == fate


# --- embedders ---


async def test_fake_embedder_is_deterministic_normalized_and_needs_no_network():
    fake = FakeEmbedder()
    a, b, empty = await fake.embed(["молоко хлеб", "молоко хлеб", "!!!"], "document")
    assert a == b and len(a) == 1024 and abs(sum(v * v for v in a) - 1) < 1e-9
    assert any(empty)  # never a zero vector: pgvector's cosine distance would be NaN


async def test_fake_embedder_acts_out_a_meaning():
    fake = FakeEmbedder(same_meaning={"туфли": "обувь"})
    a, b = await fake.embed(["туфли", "обувь"], "document")
    assert a == b


@respx.mock
async def test_tei_embedder_sends_batches_of_32_and_keeps_order():
    def answer(request: httpx.Request) -> httpx.Response:
        import json

        inputs = json.loads(request.content)["inputs"]
        return httpx.Response(200, json=[[float(t)] * 3 for t in inputs])

    route = respx.post("http://tei:80/embed").mock(side_effect=answer)
    embedder = TeiEmbedder("http://tei:80/", model="BAAI/bge-m3", dim=3)
    out = await embedder.embed([str(n) for n in range(70)], "document")
    assert route.call_count == 3
    assert [v[0] for v in out] == [float(n) for n in range(70)]


def test_chunk_embedder_is_tei_or_nothing():
    made = make_chunk_embedder("tei", url="http://tei", model="BAAI/bge-m3", dim=1024)
    assert isinstance(made, TeiEmbedder) and made.model == "BAAI/bge-m3"
    assert isinstance(make_chunk_embedder("tei", url="", model="m", dim=1024), NullChunkEmbedder)
    # A foreign provider's name doesn't get a foreign provider (R-02).
    assert isinstance(make_chunk_embedder("voyage", url="http://x", model="m", dim=1024),
                      NullChunkEmbedder)  # fmt: skip


async def test_embed_query_gives_up_quietly():
    class Down:
        dim, model = 1024, "m"

        async def embed(self, texts, input_type):
            raise httpx.ConnectError("down")

    class Slow:
        dim, model = 1024, "m"

        async def embed(self, texts, input_type):
            import asyncio

            await asyncio.sleep(5)
            return [[0.0]]

    assert await embed_query(Down(), "молоко", 1.0) is None
    assert await embed_query(Slow(), "молоко", 0.01) is None
    assert await embed_query(NullChunkEmbedder(), "молоко", 1.0) is None
    assert await embed_query(FakeEmbedder(), "  ", 1.0) is None
    assert await embed_query(FakeEmbedder(), "молоко", 1.0) is not None
