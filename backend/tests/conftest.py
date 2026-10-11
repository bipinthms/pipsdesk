from __future__ import annotations

import pytest

from backend import mt5_mock
from backend.config import Settings
from backend.db import Database
from backend.mt5_bridge import MT5Bridge

# A fixed wall-clock instant (UTC) so simulated prices are reproducible.
T0 = 1_760_000_000.0


class FakeClock:
    """Settable clock, shared by the mock's server time and the bridge's backoff timer."""

    def __init__(self, t: float = T0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def settings() -> Settings:
    return Settings(_env_file=None, mt5_mock=True, extra_allowed_hosts="testserver")


@pytest.fixture
def db() -> Database:
    return Database(":memory:")


@pytest.fixture
def mock(clock: FakeClock):
    mt5_mock._mock_reset()
    mt5_mock._mock_set_clock(clock)
    yield mt5_mock
    mt5_mock._mock_reset()


@pytest.fixture
def bridge(settings: Settings, mock, clock: FakeClock) -> MT5Bridge:
    b = MT5Bridge(settings, mt5=mock, clock=clock)
    assert b.connect()
    return b


def find_time(clock: FakeClock, predicate, step: float = 1.0, limit: float = 7 * 86_400) -> None:
    """Advance the clock until `predicate()` is true (prices are a pure function of time)."""
    start = clock.t
    while not predicate():
        clock.advance(step)
        if clock.t - start > limit:
            raise AssertionError("condition never met within the search window")
