"""The MT5 server clock.

MT5 has no "server time" call: tick and bar times are in the broker's server time,
so the standard proxy is the latest tick time of a liquid symbol. That goes stale
whenever the symbol stops ticking (weekends, holidays, a feed pause), and a stale
clock puts the daily reset on the wrong day.

So the clock learns the server's offset from UTC (server time minus UTC, rounded to
15 minutes) whenever the tick is moving, and then reads the server time as the wall
clock plus that offset. The offset is saved, so it's known after a restart over a
weekend, and it follows the broker's daylight-saving changes as soon as ticks resume.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

log = logging.getLogger(__name__)

OFFSET_STEP_S = 900  # real UTC offsets are whole quarter hours
MAX_OFFSET_S = 14 * 3600

TickReader = Callable[[], tuple[int, int]]  # () -> (tick time s, tick time ms), server time


class ServerClock:
    def __init__(
        self,
        read_tick: TickReader,
        now_utc: Callable[[], float],
        offset_s: float | None = None,
        on_learned: Callable[[float], None] = lambda _: None,
    ) -> None:
        self._read_tick = read_tick
        self._now = now_utc
        self.offset_s = offset_s
        self._on_learned = on_learned
        self._last_msc: int | None = None

    def now(self) -> float | None:
        """Server time as epoch seconds, or None when it isn't known yet.

        Raises whatever `read_tick` raises (e.g. the symbol doesn't exist) only when
        no offset has been learned; otherwise a failed read falls back to the offset.
        """
        utc = self._now()
        try:
            tick_s, tick_ms = self._read_tick()
        except Exception:
            if self.offset_s is None:
                raise
            return utc + self.offset_s
        moving = self._last_msc is not None and tick_ms != self._last_msc
        self._last_msc = tick_ms
        if tick_s > 0 and moving:
            self._learn(tick_s - utc)
        if self.offset_s is not None:
            return utc + self.offset_s
        # Nothing learned yet: the tick time itself, if it's believable.
        return float(tick_s) if tick_s > 0 and abs(tick_s - utc) <= MAX_OFFSET_S else None

    def _learn(self, raw_offset: float) -> None:
        offset = round(raw_offset / OFFSET_STEP_S) * OFFSET_STEP_S
        if abs(offset) > MAX_OFFSET_S or offset == self.offset_s:
            return
        sign, minutes = ("+" if offset >= 0 else "-"), abs(offset) // 60
        log.info("MT5 server clock is UTC%s%02d:%02d", sign, minutes // 60, minutes % 60)
        self.offset_s = float(offset)
        self._on_learned(self.offset_s)
