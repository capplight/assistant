"""Circuit breaker per (provider, model) (spec 5.3).

closed --5 errors within 60 s--> open --2 min--> half_open (one trial call)
  half_open --success--> closed;  half_open --failure--> open again.

State is per process (in memory): it reacts to seconds-scale outages, so it does not need the
DB. Transitions to `open` are written to provider_usage by the router (outcome circuit_open).
"""

import enum
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field


class BreakerState(enum.StrEnum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class _Circuit:
    state: BreakerState = BreakerState.CLOSED
    failures: deque[float] = field(default_factory=deque)
    opened_at: float = 0.0
    trial_in_flight: bool = False


class CircuitBreaker:
    def __init__(
        self, *, failures: int = 5, window_s: float = 60.0, open_s: float = 120.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:  # fmt: skip
        self.failures = failures
        self.window_s = window_s
        self.open_s = open_s
        self._clock = clock
        self._circuits: dict[tuple[str, str], _Circuit] = {}

    def _get(self, key: tuple[str, str]) -> _Circuit:
        return self._circuits.setdefault(key, _Circuit())

    def state(self, provider: str, model: str) -> BreakerState:
        c = self._get((provider, model))
        if c.state is BreakerState.OPEN and self._clock() - c.opened_at >= self.open_s:
            c.state = BreakerState.HALF_OPEN
            c.trial_in_flight = False
        return c.state

    def allow(self, provider: str, model: str) -> bool:
        """May a call go out now? In half-open only one trial call is let through."""
        state = self.state(provider, model)
        if state is BreakerState.CLOSED:
            return True
        if state is BreakerState.OPEN:
            return False
        c = self._get((provider, model))
        if c.trial_in_flight:
            return False
        c.trial_in_flight = True
        return True

    def record_success(self, provider: str, model: str) -> None:
        c = self._get((provider, model))
        c.state = BreakerState.CLOSED
        c.failures.clear()
        c.trial_in_flight = False

    def record_failure(self, provider: str, model: str) -> bool:
        """Count an error. Returns True when this call opened the circuit (a transition)."""
        now = self._clock()
        c = self._get((provider, model))
        if self.state(provider, model) is BreakerState.HALF_OPEN:
            c.state, c.opened_at, c.trial_in_flight = BreakerState.OPEN, now, False
            return True
        if c.state is BreakerState.OPEN:
            return False
        c.failures.append(now)
        while c.failures and now - c.failures[0] > self.window_s:
            c.failures.popleft()
        if len(c.failures) >= self.failures:
            c.state, c.opened_at = BreakerState.OPEN, now
            c.failures.clear()
            return True
        return False

    def release(self, provider: str, model: str) -> None:
        """A half-open trial ended without a verdict (e.g. invalid output): allow another."""
        self._get((provider, model)).trial_in_flight = False
