"""Per-task routes and model prices from routes.yaml (or settings.ai_routes_file)."""

from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from assistant.ai.policy import BatchMode, validate_route
from assistant.ai.types import BudgetClass, LLMTask, Tier, Usage
from assistant.config import Settings

DEFAULT_ROUTES_FILE = Path(__file__).with_name("routes.yaml")
_MTOK = Decimal(1_000_000)


@dataclass(frozen=True)
class Price:
    inp: Decimal
    out: Decimal
    cached_in: Decimal
    cache_write: Decimal
    cache_write_1h: Decimal

    def cost(self, usage: Usage, multiplier: Decimal = Decimal(1)) -> Decimal:
        total = (usage.tokens_in * self.inp + usage.tokens_out * self.out
                 + usage.cached_in * self.cached_in + usage.cache_write_in * self.cache_write
                 + usage.cache_write_1h_in * self.cache_write_1h)
        return (total * multiplier / _MTOK).quantize(Decimal("0.000001"))  # fmt: skip


@dataclass(frozen=True)
class Route:
    task: LLMTask
    budget_class: BudgetClass
    tier: Tier
    escalate: Tier | None
    timeout_s: float
    max_tokens: int
    mask_contacts: bool
    chain: tuple[str, ...]  # provider names, priority order, duplicates removed
    cache_ttl: str | None = "5m"
    batch: BatchMode = BatchMode.OFF
    batch_max_wait_h: float = 6.0


class RouteTable:
    def __init__(self, raw: dict[str, Any], settings: Settings) -> None:
        self._settings = settings
        self._models: dict[str, dict[str, str]] = {
            p: {t: self._expand(m) for t, m in tiers.items()}
            for p, tiers in raw.get("models", {}).items()
        }
        self._prices = {
            name: Price(*(Decimal(str(p[k])) for k in ("in", "out", "cached_in", "cache_write")),
                        Decimal(str(p.get("cache_write_1h", Decimal(str(p["in"])) * 2))))
            for name, p in raw.get("prices", {}).items()
        }
        if "default" not in self._prices:
            raise ValueError("routes: prices.default is required")
        self._batch_discount = {p: Decimal(str(v))
                                for p, v in raw.get("batch_discount", {}).items()}  # fmt: skip
        defaults = {"cache": "5m", "batch": "off", "batch_max_wait_h": 6, **raw.get("defaults", {})}
        self._routes: dict[LLMTask, Route] = {}
        for name, cfg in raw.get("tasks", {}).items():
            task = LLMTask(name)
            merged = {**defaults, **(cfg or {})}
            chain: list[str] = []
            for entry in merged["chain"]:
                provider = self._resolve(entry)
                if provider and provider not in chain:
                    chain.append(provider)
            cache = str(merged["cache"])
            if cache not in ("off", "5m", "1h"):
                raise ValueError(f"routes: {task}: unknown cache {cache!r}")
            route = Route(
                task=task,
                budget_class=BudgetClass(merged["budget_class"]),
                tier=Tier(merged["tier"]),
                escalate=Tier(merged["escalate"]) if merged.get("escalate") else None,
                timeout_s=float(merged["timeout_s"]),
                max_tokens=int(merged["max_tokens"]),
                mask_contacts=bool(merged["mask_contacts"]),
                chain=tuple(chain),
                cache_ttl=None if cache == "off" else cache,
                batch=BatchMode(merged["batch"]),
                batch_max_wait_h=float(merged["batch_max_wait_h"]),
            )
            validate_route(route)
            self._routes[task] = route

    def _expand(self, model: str) -> str:
        return (model.replace("${MODEL_FAST}", self._settings.model_fast)
                .replace("${MODEL_STRONG}", self._settings.model_strong))  # fmt: skip

    def _resolve(self, entry: str) -> str:
        if entry == "primary":
            return self._settings.ai_primary_provider
        if entry == "fallback":
            return self._settings.ai_fallback_provider
        return entry

    def route(self, task: LLMTask) -> Route:
        try:
            return self._routes[task]
        except KeyError:
            raise KeyError(f"no AI route for task {task}") from None

    def model(self, provider: str, tier: Tier) -> str | None:
        return self._models.get(provider, {}).get(tier.value)

    def price(self, model: str) -> Price:
        return self._prices.get(model, self._prices["default"])

    def batch_multiplier(self, provider: str) -> Decimal:
        return self._batch_discount.get(provider, Decimal(1))

    def strong_models(self) -> frozenset[str]:
        return frozenset(m for tiers in self._models.values()
                         for t, m in tiers.items() if t == Tier.STRONG.value)  # fmt: skip

    def has_price(self, model: str) -> bool:
        return model in self._prices


def load_routes(settings: Settings, path: str | Path | None = None) -> RouteTable:
    file = Path(path or settings.ai_routes_file or DEFAULT_ROUTES_FILE)
    raw = yaml.safe_load(file.read_text(encoding="utf-8")) or {}
    return RouteTable(raw, settings)
