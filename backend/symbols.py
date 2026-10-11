"""Snap prices and volumes to what a symbol accepts.

Applied before the risk check, so the values the risk engine checks are exactly the
values sent to MT5, and the trade server doesn't reject them (invalid price, stops or
volume). Snapping never adds risk: volumes round down and stop losses round towards
the entry price.
"""

from __future__ import annotations

import math
from typing import Literal

from backend import schemas

Direction = Literal["nearest", "up", "down"]
_GRID_EPS = 1e-6  # in ticks: float noise like 1.08499999999


class InvalidOrder(ValueError):
    """The order can't be sent as entered (e.g. a volume below the symbol's minimum)."""


def snap_price(price: float, info: schemas.SymbolInfo, toward: Direction = "nearest") -> float:
    tick = info.tick_size or info.point
    n = price / tick
    k = round(n)
    if abs(n - k) > _GRID_EPS:
        k = math.ceil(n) if toward == "up" else math.floor(n) if toward == "down" else k
    return round(k * tick, info.digits)


def snap_stop_loss(sl: float, side: schemas.Side, info: schemas.SymbolInfo) -> float:
    """Towards the entry: up for a buy (whose stop is below), down for a sell."""
    return snap_price(sl, info, "up" if side == "buy" else "down")


def _decimals(step: float) -> int:
    s = f"{step:.10f}".rstrip("0")
    return len(s.split(".")[1]) if "." in s else 0


def snap_volume(volume: float, info: schemas.SymbolInfo) -> float:
    """Down to the volume step; refuses volumes outside the symbol's limits."""
    step = info.volume_step or info.volume_min
    v = round(math.floor(volume / step + _GRID_EPS) * step, _decimals(step))
    if v < info.volume_min - 1e-9:
        raise InvalidOrder(f"Volume {volume:g} is below {info.name}'s minimum of {info.volume_min:g} lots.")
    if v > info.volume_max + 1e-9:
        raise InvalidOrder(f"Volume {volume:g} is above {info.name}'s maximum of {info.volume_max:g} lots.")
    return v


def snap_close_volume(volume: float, info: schemas.SymbolInfo) -> float:
    """A partial close: down to the volume step, at least one step."""
    step = info.volume_step or info.volume_min
    v = round(math.floor(volume / step + _GRID_EPS) * step, _decimals(step))
    if v <= 0:
        raise InvalidOrder(f"Close volume {volume:g} is below {info.name}'s volume step of {step:g} lots.")
    return v
