"""The server clock: learned from moving ticks, kept when ticks stop."""

from __future__ import annotations

import pytest

from backend.server_clock import ServerClock

UTC0 = 1_791_799_200.0  # 2026-10-12 10:00 UTC
OFFSET = 3 * 3600


class Feed:
    """A tick source: server time = UTC + offset while `live`, frozen otherwise."""

    def __init__(self) -> None:
        self.utc = UTC0
        self.offset = OFFSET
        self.live = True
        self.tick = (int(UTC0 + OFFSET) - 1, int((UTC0 + OFFSET - 1) * 1000))
        self.error: Exception | None = None

    def advance(self, seconds: float) -> None:
        self.utc += seconds
        if self.live:
            t = self.utc + self.offset - 0.4  # ticks lag real time a little
            self.tick = (int(t), int(t * 1000))

    def read(self) -> tuple[int, int]:
        if self.error:
            raise self.error
        return self.tick


@pytest.fixture
def feed() -> Feed:
    return Feed()


def make(feed: Feed, offset=None, saved=None) -> ServerClock:
    return ServerClock(feed.read, lambda: feed.utc, offset, on_learned=(saved.append if saved is not None else lambda _: None))


def test_learns_the_offset_from_moving_ticks(feed):
    saved: list[float] = []
    c = make(feed, saved=saved)
    assert c.now() == pytest.approx(UTC0 + OFFSET - 1)  # nothing learned yet: the tick itself
    feed.advance(1)
    assert c.now() == UTC0 + 1 + OFFSET
    assert saved == [OFFSET]


def test_keeps_running_when_ticks_stop(feed):
    c = make(feed)
    c.now()
    feed.advance(1)
    c.now()
    feed.live = False  # Friday close
    feed.advance(36 * 3600)  # Sunday
    assert c.now() == feed.utc + OFFSET


def test_a_saved_offset_is_used_after_a_weekend_restart(feed):
    feed.live = False
    feed.advance(36 * 3600)
    assert make(feed, offset=OFFSET).now() == feed.utc + OFFSET
    assert make(feed).now() is None  # unknown, and the stale tick isn't believable


def test_follows_a_daylight_saving_change(feed):
    saved: list[float] = []
    c = make(feed, offset=OFFSET, saved=saved)
    feed.offset = 2 * 3600
    for _ in range(2):
        feed.advance(1)
        c.now()
    assert c.offset_s == 2 * 3600 and saved == [2 * 3600]


def test_read_failures(feed):
    feed.error = RuntimeError("Unknown symbol: EURUSD.raw")
    with pytest.raises(RuntimeError):
        make(feed).now()
    assert make(feed, offset=OFFSET).now() == feed.utc + OFFSET


def test_rejects_absurd_offsets(feed):
    c = make(feed)
    c.now()
    feed.offset = 20 * 3600
    feed.advance(1)
    assert c.now() is None and c.offset_s is None
