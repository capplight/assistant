"""Per-task routes and model prices from routes.yaml (or settings.ai_routes_file)."""

from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

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

    def cost(self, usage: Usage) -> Decimal:
        total = (usage.tokens_in * self.inp + usage.tokens_out * self.out
                 + usage.cached_in * self.cached_in + usage.cache_write_in * self.cache_write)
        return (total / _MTOK).quantize(Decimal("0.000001"))  # fmt: skip


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


class RouteTable:
    def __init__(self, raw: dict[str, Any], settings: Settings) -> None:
        self._settings = settings
        self._models: dict[str, dict[str, str]] = {
            p: {t: self._expand(m) for t, m in tiers.items()}
            for p, tiers in raw.get("models", {}).items()
        }
        self._prices = {
            name: Price(*(Decimal(str(p[k])) for k in ("in", "out", "cached_in", "cache_write")))
            for name, p in raw.get("prices", {}).items()
        }
        if "default" not in self._prices:
            raise ValueError("routes: prices.default is required")
        defaults = raw.get("defaults", {})
        self._routes: dict[LLMTask, Route] = {}
        for name, cfg in raw.get("tasks", {}).items():
            task = LLMTask(name)
            merged = {**defaults, **(cfg or {})}
            chain: list[str] = []
            for entry in merged["chain"]:
                provider = self._resolve(entry)
                if provider and provider not in chain:
                    chain.append(provider)
            self._routes[task] = Route(
                task=task,
                budget_class=BudgetClass(merged["budget_class"]),
                tier=Tier(merged["tier"]),
                escalate=Tier(merged["escalate"]) if merged.get("escalate") else None,
                timeout_s=float(merged["timeout_s"]),
                max_tokens=int(merged["max_tokens"]),
                mask_contacts=bool(merged["mask_contacts"]),
                chain=tuple(chain),
            )

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

    def has_price(self, model: str) -> bool:
        return model in self._prices


def load_routes(settings: Settings, path: str | Path | None = None) -> RouteTable:
    file = Path(path or settings.ai_routes_file or DEFAULT_ROUTES_FILE)
    raw = yaml.safe_load(file.read_text(encoding="utf-8")) or {}
    return RouteTable(raw, settings)
