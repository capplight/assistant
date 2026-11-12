"""The free board of «Заметки» (Ф-28, weeks 16а–16б), pure code: no DB. Contract:
docs/api/views.md («Доска»). The phone runs the same rules.

**Board space** (the same board on every screen size). The board is `WIDTH` = 360 board points
wide and grows down; a phone draws it at scale `s = its board width in pt / 360`.
- `board_x`: the sticker's left edge as a share of the board width, 0 … `MAX_X_PT / 360`
  (drawn at `board_x * width`);
- `board_y`: the top edge in board points, 0 … `MAX_Y_PT` (drawn at `board_y * s`);
- a sticker is `STICKER` × `STICKER` board points (drawn `140 * s`).
The server keeps whole board points: `x_pt = round(x * 360)`, stored as `x_pt / 360`.
The 8 pt grid the sticker snaps to is the phone's; the server does not snap.

**Stacking** (`board_z`, higher lies on top; null lowest; ties by item id): the Unix time in ms
of the winning place (`z_of`), so it is the same whatever order two phones' calls arrive in.

**Auto places** (`free_slots`): two columns at x 24 and 196, rows every 156 pt from y 16; a slot
is free when no placed sticker overlaps it. Used when the board is turned on (stickers without a
place, in rows order) and for a new sticker on a board.

**Reading order** (`reading_order`, ≥150% font and screen readers): bands of one sticker height
by the sticker's middle, then left to right.
"""

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

WIDTH = 360  # board points
STICKER = 140
MAX_X_PT = WIDTH - STICKER  # 220: the sticker stays inside the board
MAX_Y_PT = 100_000
COLUMNS = (24, 196)
TOP = 16
PITCH = STICKER + 16  # 156
ARROW_STEP = STICKER // 2  # «Левее / Правее / Выше / Ниже»: half a sticker, then the 8 pt grid
GRID = 8
MAX_PLACES = 200  # stickers in one call (a pile moves with all its stickers)


class BadPlace(ValueError):
    pass


def normalize(x: Any, y: Any) -> tuple[float, float]:
    """The place to store: (board_x share, board_y pt), clamped into the board, whole points."""
    try:
        fx, fy = float(x), float(y)
    except (TypeError, ValueError) as exc:
        raise BadPlace("x, y: numbers") from exc
    if not (math.isfinite(fx) and math.isfinite(fy)):
        raise BadPlace("x, y: finite numbers")
    x_pt = min(max(round(fx * WIDTH), 0), MAX_X_PT)
    y_pt = min(max(round(fy), 0), MAX_Y_PT)
    return x_pt / WIDTH, float(y_pt)


def x_pt(board_x: float) -> int:
    return round(board_x * WIDTH)


def z_of(ts: datetime) -> int:
    """Stacking value of a place made at `ts` (the winning stamp's time): Unix ms."""
    return int(ts.timestamp() * 1000)


def snap(value_pt: float) -> int:
    """The phone's 8 pt grid (documented for the arrows; the server stores what it gets)."""
    return int(math.floor(value_pt / GRID + 0.5)) * GRID


@dataclass(frozen=True)
class Placed:
    x_pt: int
    y_pt: int


def _blocked(placed: Iterable[Placed]) -> set[tuple[int, int]]:
    """Grid slots (row, column) that a placed sticker overlaps (positive area)."""
    out: set[tuple[int, int]] = set()
    for p in placed:
        cols = [c for c, cx in enumerate(COLUMNS)
                if p.x_pt < cx + STICKER and cx < p.x_pt + STICKER]
        if not cols:
            continue
        # rows r with TOP + r*PITCH < y + STICKER and y < TOP + r*PITCH + STICKER
        first = max(0, math.floor((p.y_pt - TOP - STICKER) / PITCH) + 1)
        last = math.ceil((p.y_pt + STICKER - TOP) / PITCH) - 1
        for r in range(first, last + 1):
            for c in cols:
                out.add((r, c))
    return out


def free_slots(placed: Iterable[Placed], n: int) -> list[tuple[float, float]]:
    """The first `n` free grid slots from the top, as (board_x share, board_y pt)."""
    blocked = _blocked(placed)
    out: list[tuple[float, float]] = []
    r = 0
    while len(out) < n:
        for c, cx in enumerate(COLUMNS):
            if len(out) < n and (r, c) not in blocked:
                out.append((cx / WIDTH, float(TOP + r * PITCH)))
        r += 1
    return out


def reading_order(rows: Sequence[tuple[Any, float | None, float | None]]) -> list[Any]:
    """Keys of `rows` [(key, board_x, board_y)] given in rows order, sorted top-to-bottom,
    left-to-right; stickers without a place go last in rows order."""
    placed = [(i, k, bx, by) for i, (k, bx, by) in enumerate(rows)
              if bx is not None and by is not None]  # fmt: skip
    rest = [k for k, bx, by in rows if bx is None or by is None]
    placed.sort(key=lambda t: ((int(t[3]) + STICKER // 2) // STICKER, x_pt(t[2]), t[3], t[0]))
    return [k for _, k, _, _ in placed] + rest
