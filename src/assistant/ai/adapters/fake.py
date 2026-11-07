"""FakeAdapter for tests and offline dev: scripted answers or errors, records every request."""

import json
from collections.abc import Callable
from typing import Any

from pydantic import BaseModel

from assistant.ai.types import (
    AdapterRequest,
    AdapterResponse,
    BatchEntry,
    ProviderError,
    ToolCall,
    Usage,
)

Step = (
    BaseModel | dict[str, Any] | str | ProviderError | list[ToolCall]
    | Callable[[AdapterRequest], "Step"]
)


class FakeAdapter:
    """Each call consumes the next step (the last one repeats):
    BaseModel/dict -> JSON answer; str -> raw text (e.g. invalid JSON); ProviderError -> raised;
    list[ToolCall] -> tool calls; callable -> computed from the request."""

    def __init__(self, name: str, steps: list[Step] | None = None, *,
                 usage: Usage | None = None, stream_chunks: int = 3,
                 supports_batch: bool = False) -> None:
        self.name = name
        self.steps: list[Step] = list(steps or [])
        self.usage = usage or Usage(tokens_in=1000, tokens_out=200)
        self.stream_chunks = stream_chunks
        self.requests: list[AdapterRequest] = []  # fmt: skip
        self.supports_batch = supports_batch
        self.batches: dict[str, list[tuple[str, AdapterRequest]]] = {}
        self.batch_done = True  # False: a batch stays in progress
        self.cancelled: list[str] = []
        self.overrides: dict[str, BatchEntry] = {}  # custom_id -> a canned result

    @property
    def calls(self) -> int:
        return len(self.requests)

    async def submit_batch(self, requests: list[tuple[str, AdapterRequest]]) -> str:
        batch_id = f"fakebatch-{len(self.batches) + 1}"
        self.batches[batch_id] = list(requests)
        return batch_id

    async def batch_ended(self, batch_id: str) -> bool:
        return self.batch_done

    async def batch_results(self, batch_id: str) -> list[BatchEntry]:
        out = []
        for custom_id, req in self.batches[batch_id]:
            if custom_id in self.overrides:
                out.append(self.overrides[custom_id])
                continue
            try:
                out.append(BatchEntry(custom_id, response=await self.generate(req)))
            except ProviderError as exc:
                out.append(BatchEntry(custom_id, error=exc))
        return out

    async def cancel_batch(self, batch_id: str) -> None:
        self.cancelled.append(batch_id)

    async def generate(self, req: AdapterRequest) -> AdapterResponse:
        self.requests.append(req)
        if not self.steps:
            raise AssertionError(f"FakeAdapter {self.name}: no scripted step")
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        while callable(step) and not isinstance(step, BaseModel | ProviderError):
            step = step(req)
        if isinstance(step, ProviderError):
            raise step
        usage = Usage(**vars(self.usage))
        if isinstance(step, list):
            return AdapterResponse("", usage, req.model, tool_calls=list(step))
        if isinstance(step, BaseModel):
            text = step.model_dump_json()
        elif isinstance(step, dict):
            text = json.dumps(step, ensure_ascii=False)
        else:
            text = str(step)
        if req.on_token is not None:
            n = max(1, self.stream_chunks)
            size = max(1, -(-len(text) // n))
            for i in range(0, len(text), size):
                await req.on_token(text[i:i + size])
        return AdapterResponse(text, usage, req.model, request_id=f"fake-{self.calls}")
