"""Tap edits of a КП (spec 6.7 step 6, US-12 «тапает по полю»): a JSON Patch (RFC 6902 subset) on
`document_versions.data`, without the model. Only white-listed paths and ops; every value is
checked by code; sums are never patched (they are `calc`'s). Pure functions.

Ops: `replace` (also `add` on a field = the same), `remove` (a line, or clears an optional field),
`add` with path `/items/-` (a new line). Paths:
  /number /date /client/name /client/bin /client/contact /vat/mode /discount_total_pct
  /terms/payment /terms/delivery /terms/warranty /terms/validity_days
  /text_blocks/intro /text_blocks/outro
  /items/<index>/name|unit|qty|unit_price|discount_pct     /items/<index>     /items/-
A line can also be named by its id instead of the index (`/items/i3/qty`): what the phone saw is
then what changes, even if lines moved.

`changed_paths` name lines by id (`/items/i3/unit_price`) for the highlight. A price the person
types becomes `price_source = manual`; a field they touch loses its «Проверьте».
"""

import copy
import re
from datetime import date
from decimal import Decimal
from typing import Any

from assistant.ai import iin_bin_ok
from assistant.kp.calc import VAT_MODES, money
from assistant.kp.norm import MONEY_MAX, QTY_MAX, clean_text, digits, parse_decimal, unit_norm

MAX_OPS = 200
MAX_ITEMS = 600
TEXT_FIELDS = {"/number": 40, "/client/name": 200, "/client/contact": 120,
               "/terms/payment": 300, "/terms/delivery": 300, "/terms/warranty": 300,
               "/text_blocks/intro": 2000, "/text_blocks/outro": 2000}  # fmt: skip
OPTIONAL = {"/client/bin", "/client/contact", "/terms/payment", "/terms/delivery",
            "/terms/warranty", "/terms/validity_days", "/text_blocks/intro",
            "/text_blocks/outro"}  # fmt: skip
LINE_FIELDS = ("name", "unit", "qty", "unit_price", "discount_pct")
_LINE = re.compile(r"^/items/([^/]+)(?:/([a-z_]+))?$")


class PatchError(ValueError):
    def __init__(self, code: str, path: str | None = None) -> None:
        super().__init__(code)
        self.code, self.path = code, path


def _pct(value: Any, path: str) -> str:
    v = parse_decimal(str(value)) if value not in (None, "") else Decimal(0)
    if v is None or v < 0 or v > 100:
        raise PatchError("patch_value_invalid", path)
    return f"{v.normalize():f}"


def _qty(value: Any, path: str) -> str:
    v = parse_decimal(str(value)) if value not in (None, "") else None
    if v is None or v <= 0 or v > QTY_MAX:
        raise PatchError("patch_value_invalid", path)
    return f"{v.normalize():f}"


def _price(value: Any, path: str) -> str | None:
    if value in (None, ""):
        return None
    v = parse_decimal(str(value))
    if v is None or v < 0 or v > MONEY_MAX:
        raise PatchError("patch_value_invalid", path)
    return f"{money(v):.2f}"


def _line_value(name: str, value: Any, path: str) -> Any:
    if name == "name":
        text = clean_text(str(value or ""), 300)
        if not text:
            raise PatchError("patch_value_invalid", path)
        return text
    if name == "unit":
        return unit_norm(str(value or ""))
    if name == "qty":
        return _qty(value, path)
    if name == "unit_price":
        return _price(value, path)
    return _pct(value, path)


def _field_value(path: str, value: Any) -> Any:
    if path in TEXT_FIELDS:
        text = clean_text(str(value or ""), TEXT_FIELDS[path])
        if text is None and path not in OPTIONAL:
            raise PatchError("patch_value_invalid", path)
        return text
    if path == "/date":
        try:
            return date.fromisoformat(str(value)).isoformat()
        except ValueError as exc:
            raise PatchError("patch_value_invalid", path) from exc
    if path == "/client/bin":
        if value in (None, ""):
            return None
        d = digits(str(value))
        if len(d) != 12 or not iin_bin_ok(d):
            raise PatchError("bin_invalid", path)
        return d
    if path == "/vat/mode":
        if value not in VAT_MODES:
            raise PatchError("patch_value_invalid", path)
        return value
    if path == "/discount_total_pct":
        return _pct(value, path)
    if path == "/terms/validity_days":
        if value in (None, ""):
            return None
        if not isinstance(value, int) or not 1 <= value <= 365:
            raise PatchError("patch_value_invalid", path)
        return value
    raise PatchError("patch_path_not_allowed", path)


def _get_parent(data: dict[str, Any], path: str) -> tuple[dict[str, Any], str]:
    parts = path.strip("/").split("/")
    node = data
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    return node, parts[-1]


def _index(items: list[dict[str, Any]], ref: str, path: str) -> int:
    if ref.isdigit():
        i = int(ref)
        if i >= len(items):
            raise PatchError("patch_path_not_allowed", path)
        return i
    for i, it in enumerate(items):
        if str(it.get("id")) == ref:
            return i
    raise PatchError("patch_path_not_allowed", path)


def _next_id(items: list[dict[str, Any]]) -> str:
    n = max((int(str(it["id"])[1:]) for it in items if re.fullmatch(r"i\d+", str(it["id"]))),
            default=0)  # fmt: skip
    return f"i{n + 1}"


def apply_patch(data: dict[str, Any], ops: list[dict[str, Any]],
                ) -> tuple[dict[str, Any], list[str], list[dict[str, Any]]]:  # fmt: skip
    """(new data, changed paths, the ops as applied — lines named by id)."""
    if not isinstance(ops, list) or not ops or len(ops) > MAX_OPS:
        raise PatchError("patch_invalid")
    new = copy.deepcopy(data)
    items: list[dict[str, Any]] = new.setdefault("items", [])
    changed: list[str] = []
    applied: list[dict[str, Any]] = []
    for op in ops:
        if not isinstance(op, dict) or op.get("op") not in ("replace", "add", "remove"):
            raise PatchError("patch_invalid")
        kind, path = op["op"], str(op.get("path") or "")
        m = _LINE.match(path)
        if m:
            ref, name = m.group(1), m.group(2)
            if ref == "-" and kind == "add" and name is None:
                value = op.get("value")
                if not isinstance(value, dict) or set(value) - set(LINE_FIELDS):
                    raise PatchError("patch_value_invalid", path)
                if len(items) >= MAX_ITEMS:
                    raise PatchError("too_many", path)
                line = {"id": _next_id(items), "name": _line_value("name", value.get("name"), path),
                        "unit": _line_value("unit", value.get("unit"), path),
                        "qty": _line_value("qty", value.get("qty", "1"), path),
                        "unit_price": _line_value("unit_price", value.get("unit_price"), path),
                        "discount_pct": _line_value("discount_pct", value.get("discount_pct"),
                                                    path),
                        "matched_name": None, "price_review": False, "source_ref": None,
                        "review": []}  # fmt: skip
                line["price_source"] = "manual" if line["unit_price"] is not None else "missing"
                items.append(line)
                changed.append(f"/items/{line['id']}")
                applied.append({"op": "add", "path": "/items/-", "value": {
                    k: line[k] for k in LINE_FIELDS}})  # fmt: skip
                continue
            if ref == "-":
                raise PatchError("patch_path_not_allowed", path)
            i = _index(items, ref, path)
            line = items[i]
            if name is None:
                if kind != "remove":
                    raise PatchError("patch_path_not_allowed", path)
                if len(items) == 1:
                    raise PatchError("kp_last_line", path)
                items.pop(i)
                changed.append(f"/items/{line['id']}")
                applied.append({"op": "remove", "path": f"/items/{line['id']}"})
                continue
            if name not in LINE_FIELDS:
                raise PatchError("patch_path_not_allowed", path)
            value = None if kind == "remove" else op.get("value")
            if kind == "remove" and name not in ("unit", "unit_price", "discount_pct"):
                raise PatchError("patch_path_not_allowed", path)
            value = _line_value(name, value, path)
            line["review"] = [r for r in line.get("review") or [] if r != name]
            if name == "unit_price":
                line["price_source"] = "manual" if value is not None else "missing"
                line["price_review"] = False
                line["matched_name"] = None
            if line.get(name) != value:
                line[name] = value
                changed.append(f"/items/{line['id']}/{name}")
            applied.append({"op": "replace", "path": f"/items/{line['id']}/{name}",
                            "value": value})  # fmt: skip
            continue
        if kind == "remove":
            if path not in OPTIONAL:
                raise PatchError("patch_path_not_allowed", path)
            value = None
        else:
            value = _field_value(path, op.get("value"))
        parent, key = _get_parent(new, path)
        if path.startswith("/client/"):
            parent["review"] = [r for r in parent.get("review") or [] if r != f"client.{key}"]
        if parent.get(key) != value:
            parent[key] = value
            changed.append(path)
        applied.append({"op": "replace", "path": path, "value": value})
    if not items:
        raise PatchError("kp_last_line")
    return new, list(dict.fromkeys(changed)), applied


__all__ = ["PatchError", "apply_patch"]
