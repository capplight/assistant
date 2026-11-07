"""Letter folding for search. Must match `search_fold` / `search_translit` in migration 0009 (a db
test compares them). `fold` keeps the length, so a match in folded text marks the original text.

Pure functions, no I/O.
"""

import re

_UPPER_LAT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_LOWER_LAT = "abcdefghijklmnopqrstuvwxyz"
_UPPER_CYR = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
_LOWER_CYR = "абвгдеежзийклмнопрстуфхцчшщъыьэюя"
_KK_FROM = "ӘҒҚҢӨҰҮҺІәғқңөұүһіё"
_KK_TO = "агкноуухиагкноуухие"
_FOLD = str.maketrans(_UPPER_LAT + _UPPER_CYR + _KK_FROM, _LOWER_LAT + _LOWER_CYR + _KK_TO)
# а/о/я and е/и/й/ы/э are one letter, Latin too: the commonest misspelling is a vowel (молако).
_TRANSLIT = str.maketrans("абвгдежзийклмнопрстуфхцчшщыэюяoey", "abvgdijziiklmnaprstufhccwwiiuaaii",
                          "ъь")  # fmt: skip

_WORD = re.compile(r"\w+")
MAX_TOKENS = 8

# Folded. Words that say nothing on their own in a question («куда я записала...»).
STOP_WORDS = frozenset("""
    а без бы в во вот все где да для до его ее если еще же за и из или им их к как кого когда
    ко кто ли мне мы на над не нет ни но о об он она они оно от по под при про с со так там то ты
    у уже чем что чтобы эта эти это этот я куда зачем почему какой какая какие мой моя мое
    жане мен бен пен сен тен де та те ма ме ба бе осы сол бул ушин ол биз сиз
""".split())  # fmt: skip


def fold(text: str) -> str:
    """Lower case, ё -> е, Kazakh letters -> the Russian letters people type instead."""
    return text.translate(_FOLD)


def translit(text: str) -> str:
    """`fold`, then ASCII: what trigrams compare (migration 0009 says why)."""
    return fold(text).translate(_TRANSLIT)


def tokens(query: str) -> list[str]:
    """Folded search words: no stop words unless nothing else is left; first MAX_TOKENS."""
    words = list(dict.fromkeys(_WORD.findall(fold(query))))
    meaningful = [w for w in words if w not in STOP_WORDS]
    return (meaningful or words)[:MAX_TOKENS]
