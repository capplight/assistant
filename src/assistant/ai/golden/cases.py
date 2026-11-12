"""Golden cases on disk and the providers they run against (spec 5.8).

A case file is a YAML list; each case:

    id: enr-ru-001            # unique; reports name cases by id only, never by text
    kind: enrich | reminder | kp | question | injection | chat_tool | expense
    lang: ru | kk | mixed
    input: {...}              # what the code path gets (text, phrase, page, sources, ...)
    expect: {...}             # what code + model must end with (after our checks)
    cassette:                 # recorded answers for CI, by schema name; a list = successive
      Envelope: {...}         #   calls. {"$tool_calls": [{name, arguments}]} = tool calls,
                              #   {"$raw": "..."} = raw (invalid) text
    usage: {in, out, cached}  # optional token counts of each recorded call (for the $ metric)

`CassetteAdapter` answers from the cassette of the current case (no network); a code path that
asks a schema the cassette does not have gets a provider error, as if nobody answered.
`live_router` uses the real adapters (keys from the environment); cases' cassettes are ignored.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from assistant.ai.adapters import build_adapters
from assistant.ai.router import Router
from assistant.ai.routes import load_routes
from assistant.ai.store import MemoryAIStore
from assistant.ai.types import (
    AdapterRequest,
    AdapterResponse,
    ProviderRequestError,
    ToolCall,
    Usage,
)
from assistant.config import Settings

KINDS = ("enrich", "reminder", "kp", "question", "injection", "chat_tool", "expense")
LANGS = ("ru", "kk", "mixed")
GOLDEN_USER = 900_001  # synthetic user id: in memory only, never a DB row
DEFAULT_USAGE = {  # tokens per recorded call, close to spec 5.10 estimates [estimate]
    "chat_tool": (2000, 200, 4000), "question": (4000, 300, 4000), "injection": (2500, 150, 4000),
    "enrich": (1200, 350, 1500), "reminder": (300, 80, 600), "kp": (2500, 900, 1500),
    "expense": (500, 120, 600),
}  # fmt: skip
DATA_DIR = Path(__file__).resolve().parents[4] / "eval" / "golden"


@dataclass
class Case:
    id: str
    kind: str
    lang: str
    input: dict[str, Any]
    expect: dict[str, Any]
    cassette: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, int] | None = None
    tags: list[str] = field(default_factory=list)
    file: str = ""


def load_cases(path: Path | str | None = None) -> list[Case]:
    root = Path(path) if path else DATA_DIR
    files = sorted(root.rglob("*.yaml")) if root.is_dir() else [root]
    out: list[Case] = []
    seen: set[str] = set()
    for f in files:
        raw = yaml.safe_load(f.read_text(encoding="utf-8")) or []
        for c in raw:
            case = Case(id=str(c["id"]), kind=c["kind"], lang=c["lang"], input=c.get("input") or {},
                        expect=c.get("expect") or {}, cassette=c.get("cassette") or {},
                        usage=c.get("usage"), tags=list(c.get("tags") or []),
                        file=f.name)  # fmt: skip
            if case.kind not in KINDS or case.lang not in LANGS:
                raise ValueError(f"{case.id}: bad kind or lang")
            if case.id in seen:
                raise ValueError(f"duplicate case id {case.id}")
            seen.add(case.id)
            out.append(case)
    return out


class CassetteAdapter:
    """Answers each call from the current case's cassette (spec 5.8 «synthetic part» in CI)."""

    name = "anthropic"
    supports_batch = False

    def __init__(self, *, live: bool = False) -> None:
        self.live = live  # True: only a holder of the current case (real adapters answer)
        self.case: Case | None = None
        self._queues: dict[str, list[Any]] = {}
        self.requests: list[AdapterRequest] = []

    def start(self, case: Case) -> None:
        self.case = case
        self.requests = []
        self._queues = {k: list(v) if isinstance(v, list) else [v]
                        for k, v in case.cassette.items()}  # fmt: skip

    async def generate(self, req: AdapterRequest) -> AdapterResponse:
        self.requests.append(req)
        assert self.case is not None
        queue = self._queues.get(req.schema_name)
        if not queue:
            raise ProviderRequestError(f"no cassette for {req.schema_name}")
        step = queue.pop(0) if len(queue) > 1 else queue[0]
        tin, tout, cached = DEFAULT_USAGE.get(self.case.kind, (1000, 200, 0))
        if self.case.usage:
            tin = self.case.usage.get("in", tin)
            tout = self.case.usage.get("out", tout)
            cached = self.case.usage.get("cached", cached)
        usage = Usage(tokens_in=tin, tokens_out=tout, cached_in=cached)
        if isinstance(step, dict) and "$tool_calls" in step:
            calls = [ToolCall(f"g{i}", c["name"], c.get("arguments") or {})
                     for i, c in enumerate(step["$tool_calls"], start=1)]  # fmt: skip
            return AdapterResponse("", usage, req.model, tool_calls=calls, request_id="cassette")
        if isinstance(step, dict) and "$raw" in step:
            return AdapterResponse(str(step["$raw"]), usage, req.model, request_id="cassette")
        body = json.dumps(step, ensure_ascii=False)
        if req.on_token is not None:
            await req.on_token(body)
        return AdapterResponse(body, usage, req.model, request_id="cassette")


def offline_settings() -> Settings:
    return Settings(_env_file=None, anthropic_api_key="", openai_api_key="", google_api_key="",
                    groq_api_key="", ai_primary_provider="anthropic",
                    ai_fallback_provider="openai")  # fmt: skip


def _store() -> MemoryAIStore:
    store = MemoryAIStore()
    store.consents[GOLDEN_USER] = frozenset({"anthropic", "openai", "google", "groq"})
    store.profiles[GOLDEN_USER] = "family_beta"  # no budget cut-offs during a run
    return store


def cassette_router(adapter: CassetteAdapter) -> tuple[Router, MemoryAIStore]:
    s = offline_settings()
    store = _store()
    return Router(settings=s, routes=load_routes(s), adapters={"anthropic": adapter},
                  store=store), store  # fmt: skip


def live_router(settings: Settings | None = None) -> tuple[Router, MemoryAIStore]:
    """Real providers (keys from env / local .env). Golden data is synthetic or anonymised
    (spec 5.8), so it runs with the golden user, whose consent lives only in memory."""
    s = settings or Settings()
    adapters = build_adapters(s)
    if not adapters:
        raise SystemExit("no provider key set: the live golden run needs at least one")
    store = _store()
    return Router(settings=s, routes=load_routes(s), adapters=adapters, store=store), store
