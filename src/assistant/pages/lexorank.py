"""LexoRank keys for manual order: a string between any two neighbours (spec 3.10).

A key is a base-62 fraction: "V" is 0.V, "VV" is 0.VV. The alphabet is in ASCII order, so Postgres
`COLLATE "C"`, Python `<` and JS `<` on strings all give the same order. Keys never end in "0", so
there is always room below any key. Same algorithm on the phone; both are checked against
`docs/spec/vectors/lexorank.json`.

Appending and prepending step by one digit, which keeps keys short; inserting between two keys
takes the midpoint and grows about one char per 6 inserts into the same gap. Past MAX_LENGTH the
caller re-keys the page with `sequence`.
"""

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
BASE = len(ALPHABET)
MAX_LENGTH = 64
_DIGIT = {ch: i for i, ch in enumerate(ALPHABET)}
_MID = ALPHABET[BASE // 2]  # "V": the very first key
_LAST = BASE - 1


class RankError(ValueError):
    """Malformed key, or bounds that are not in strict order."""


def is_valid(key: str) -> bool:
    return bool(key) and key[-1] != "0" and all(ch in _DIGIT for ch in key)


def _check(key: str) -> None:
    if not is_valid(key):
        raise RankError(f"bad rank key: {key!r}")


def _after(a: str) -> str:
    for i, ch in enumerate(a):
        if _DIGIT[ch] < _LAST:
            return a[:i] + ALPHABET[_DIGIT[ch] + 1]
    return a + _MID


def _before(b: str) -> str:
    for i, ch in enumerate(b):
        digit = _DIGIT[ch]
        if digit > 1:
            return b[:i] + ALPHABET[digit - 1]
        if digit == 1:
            return b[:i] + "0" + _MID
    raise RankError(f"bad rank key: {b!r}")  # all zeros; _check rules this out


def _midpoint(a: str, b: str) -> str:
    prefix: list[str] = []
    tight = True  # still on b's digits; once False the upper bound no longer limits us
    i = 0
    while True:
        low = _DIGIT[a[i]] if i < len(a) else 0
        high = _DIGIT[b[i]] if tight and i < len(b) else BASE
        if high - low > 1:
            return "".join(prefix) + ALPHABET[(low + high) // 2]
        prefix.append(ALPHABET[low])
        if high - low == 1:
            tight = False
        i += 1


def between(a: str | None, b: str | None) -> str:
    """A key strictly between `a` and `b`. None means no bound on that side."""
    if a is not None:
        _check(a)
    if b is not None:
        _check(b)
    if a is None and b is None:
        return _MID
    if b is None:
        assert a is not None
        return _after(a)
    if a is None:
        return _before(b)
    if a >= b:
        raise RankError(f"bounds out of order: {a!r} >= {b!r}")
    return _midpoint(a, b)


def sequence(n: int) -> list[str]:
    """`n` evenly spaced keys in ascending order, with room between neighbours."""
    if n < 0:
        raise RankError("negative count")
    width = 1
    while BASE**width < (n + 1) * BASE:
        width += 1
    step = BASE**width // (n + 1)
    out = []
    for i in range(1, n + 1):
        value, digits = i * step, []
        for _ in range(width):
            value, digit = divmod(value, BASE)
            digits.append(ALPHABET[digit])
        out.append("".join(reversed(digits)).rstrip("0"))
    return out
