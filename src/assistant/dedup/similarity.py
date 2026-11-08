"""Similar-repeat signals (spec 6.3 p. 2). Pure code, no I/O, no model.

- SimHash, 64 bits, over words and word pairs of the hash basis (the same normalisation as
  `content_hash`). Stored signed in `items.simhash` (Postgres bigint).
- Trigrams like pg_trgm (each word padded "  w "), compared by Jaccard: pg_trgm's `similarity()`.
- Numbers in the text: two notes that differ only in a date, a sum or a code are different notes
  (a meeting on the 12th vs the 13th). Such pairs are never merged on signals alone.
- Candidate pairs for a whole corpus without comparing everything with everything: prefix
  filtering on trigram sets (exact for Jaccard >= t) and SimHash bands (exact for <= 3 bits: of 4
  bands of 16 bits, at least one is equal).
"""

import hashlib
import math
import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

from assistant.records.textnorm import hash_basis

MAX_CHARS = 5000  # enough to tell; long documents are compared by their head
SIMHASH_BITS = 64
SIMHASH_MAX_DISTANCE = 3  # spec: ≤3 of 64 bits
TRGM_SURE = 0.8  # spec: trgm > 0.8
COSINE_SURE = 0.92  # spec: cosine ≥ 0.92
COSINE_BORDER = 0.85  # spec: 0.85–0.92 → DUP_JUDGE
MIN_WORDS_FOR_SIMHASH = 4  # fewer words: a few bits mean nothing
SIMHASH_MAX_WORDS = 300  # the head is enough, and it keeps the pure-Python loop fast
_NUMBER = re.compile(r"\d+")
# A trigram that rare-first ordering still puts in the prefix of hundreds of records is boilerplate
# (a signature, a template): pairs through it alone are not looked at. Keeps a big import of
# look-alike messages from turning into millions of pairs; exactness holds below this.
MAX_POSTINGS = 200
_BANDS = 4
_BAND_BITS = SIMHASH_BITS // _BANDS


def basis(text: str | None) -> str:
    return hash_basis((text or "")[:MAX_CHARS])


def _h64(s: str) -> int:
    return int.from_bytes(hashlib.blake2b(s.encode(), digest_size=8).digest(), "big")


def simhash(text: str | None) -> int | None:
    """Signed 64-bit SimHash, or None when the text is too short to say anything."""
    words = basis(text).split()[:SIMHASH_MAX_WORDS]
    if len(words) < MIN_WORDS_FOR_SIMHASH:
        return None
    feats = Counter(words)
    feats.update(f"{a} {b}" for a, b in zip(words, words[1:], strict=False))
    acc = [0] * SIMHASH_BITS
    for feat, weight in feats.items():
        h = _h64(feat)
        for bit in range(SIMHASH_BITS):
            acc[bit] += weight if (h >> bit) & 1 else -weight
    value = sum(1 << bit for bit in range(SIMHASH_BITS) if acc[bit] > 0)
    return value - (1 << 64) if value >= 1 << 63 else value


def hamming(a: int, b: int) -> int:
    return ((a ^ b) & ((1 << 64) - 1)).bit_count()


def trigrams(text: str | None) -> frozenset[str]:
    out: set[str] = set()
    for word in basis(text).split():
        padded = f"  {word} "
        out.update(padded[i:i + 3] for i in range(len(padded) - 2))
    return frozenset(out)


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def numbers(text: str | None) -> frozenset[str]:
    return frozenset(m.lstrip("0") or "0" for m in _NUMBER.findall((text or "")[:MAX_CHARS]))


def numbers_conflict(a: frozenset[str], b: frozenset[str]) -> bool:
    """Both have numbers and neither set holds the other: «12 марта» vs «13 марта». A note that
    only adds a number (a phone) to the other is its fuller version, not a conflict."""
    return bool(a) and bool(b) and not (a <= b or b <= a)


def completeness(text: str | None) -> int:
    """keep_rule=most_complete: the one with more words wins (ties: the newer)."""
    return len(basis(text).split())


def paragraphs_missing(keep: str | None, other: str | None) -> list[str]:
    """Paragraphs of `other` that `keep` does not have (code diff by paragraph, spec 6.3 p. 4):
    they go into «Было в повторах», the text of `keep` stays as it is."""
    have = {hash_basis(p) for p in (keep or "").split("\n")}
    out = []
    for p in (other or "").split("\n"):
        b = hash_basis(p)
        if b and b not in have:
            have.add(b)
            out.append(p.strip())
    return out


# --- a pair's verdict from its signals ---


@dataclass(frozen=True)
class Doc:
    id: int
    text: str
    simhash: int | None
    grams: frozenset[str]
    nums: frozenset[str]


def make_doc(item_id: int, text: str | None, stored_simhash: int | None = None) -> Doc:
    return Doc(item_id, text or "", stored_simhash if stored_simhash is not None else simhash(text),
               trigrams(text), numbers(text))


@dataclass(frozen=True)
class PairSignals:
    hamming: int | None
    trgm: float
    cosine: float | None
    numbers_conflict: bool

    def as_json(self) -> dict:
        return {"hamming": self.hamming, "trgm": round(self.trgm, 4),
                "cosine": None if self.cosine is None else round(self.cosine, 4),
                "numbers_conflict": self.numbers_conflict}  # fmt: skip


def signals(a: Doc, b: Doc, cosine: float | None = None) -> PairSignals:
    h = hamming(a.simhash, b.simhash) if a.simhash is not None and b.simhash is not None else None
    return PairSignals(h, jaccard(a.grams, b.grams), cosine, numbers_conflict(a.nums, b.nums))


SURE, JUDGE, NO = "sure", "judge", "no"


def decide(s: PairSignals) -> tuple[str, str]:
    """(SURE | JUDGE | NO, method). SURE = a candidate by the spec's code thresholds; JUDGE =
    borderline, DUP_JUDGE decides; a SURE pair whose numbers conflict goes to the judge too."""
    method = None
    if s.hamming is not None and s.hamming <= SIMHASH_MAX_DISTANCE:
        method = "simhash"
    elif s.trgm > TRGM_SURE:
        method = "trgm"
    elif s.cosine is not None and s.cosine >= COSINE_SURE:
        method = "embedding"
    if method is not None:
        return (JUDGE if s.numbers_conflict else SURE), method
    if s.cosine is not None and s.cosine >= COSINE_BORDER:
        return JUDGE, "embedding"
    return NO, "trgm"


def score(s: PairSignals) -> float:
    parts = [s.trgm]
    if s.hamming is not None:
        parts.append(1 - s.hamming / SIMHASH_BITS)
    if s.cosine is not None:
        parts.append(s.cosine)
    return max(parts)


# --- candidate pairs over a corpus ---


def prefix_pairs(docs: list[Doc], threshold: float = TRGM_SURE) -> set[tuple[int, int]]:
    """Pairs that can have trigram Jaccard >= threshold (AllPairs prefix filtering): with tokens
    ordered rarest first, two such sets share a token among the first |x| - ceil(t|x|) + 1."""
    df: Counter[str] = Counter()
    for d in docs:
        df.update(d.grams)
    index: dict[str, list[int]] = defaultdict(list)
    out: set[tuple[int, int]] = set()
    for i, d in enumerate(docs):
        if not d.grams:
            continue
        toks = sorted(d.grams, key=lambda t: (df[t], t))
        n = len(toks) - math.ceil(threshold * len(toks)) + 1
        for t in toks[:n]:
            if len(index[t]) > MAX_POSTINGS:  # boilerplate shared by hundreds: not a signal
                continue
            for j in index[t]:
                other = docs[j]
                # size filter: |y| must be within [t|x|, |x|/t]
                if threshold * len(d.grams) <= len(other.grams) <= len(d.grams) / threshold:
                    out.add((min(other.id, d.id), max(other.id, d.id)))
            index[t].append(i)
    return out


def simhash_pairs(docs: Iterable[Doc]) -> set[tuple[int, int]]:
    buckets: dict[tuple[int, int], list[Doc]] = defaultdict(list)
    for d in docs:
        if d.simhash is None:
            continue
        u = d.simhash & ((1 << 64) - 1)
        for band in range(_BANDS):
            buckets[(band, (u >> (band * _BAND_BITS)) & 0xFFFF)].append(d)
    out: set[tuple[int, int]] = set()
    for group in buckets.values():
        if len(group) > 200:  # a degenerate bucket (same boilerplate): trigram filter covers it
            continue
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                assert a.simhash is not None and b.simhash is not None
                if hamming(a.simhash, b.simhash) <= SIMHASH_MAX_DISTANCE:
                    out.add((min(a.id, b.id), max(a.id, b.id)))
    return out


def components(pairs: Iterable[tuple[int, int]]) -> list[list[int]]:
    """Union-find: groups of 2+ ids, each sorted, groups in order of their smallest id."""
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    groups: dict[int, list[int]] = defaultdict(list)
    for x in parent:
        groups[find(x)].append(x)
    return sorted((sorted(g) for g in groups.values() if len(g) > 1), key=lambda g: g[0])
