"""Snapping order values to the symbol's grid: never adds risk."""

from __future__ import annotations

import pytest

from backend.schemas import SymbolInfo
from backend.symbols import InvalidOrder, snap_close_volume, snap_price, snap_stop_loss, snap_volume


def spec(**kw) -> SymbolInfo:
    base = dict(name="NAS100", description="", digits=2, point=0.01, contract_size=1, tick_size=0.25, tick_value=0.25,
                volume_min=0.1, volume_max=50, volume_step=0.1, stops_level=0, spread=150, currency_base="USD",
                currency_profit="USD", trade_allowed=True)
    return SymbolInfo(**{**base, **kw})


@pytest.mark.parametrize("price,toward,expected", [
    (19_500.13, "nearest", 19_500.25), (19_500.10, "nearest", 19_500.0),
    (19_500.10, "up", 19_500.25), (19_500.20, "down", 19_500.0),
    (19_500.25, "up", 19_500.25), (19_500.2500000001, "down", 19_500.25),  # already on the grid
])
def test_snap_price(price, toward, expected):
    assert snap_price(price, spec(), toward) == expected


def test_stop_loss_moves_towards_entry():
    assert snap_stop_loss(19_400.10, "buy", spec()) == 19_400.25  # a buy's stop is below: up
    assert snap_stop_loss(19_600.10, "sell", spec()) == 19_600.0  # a sell's stop is above: down


def test_fx_float_noise():
    eur = spec(name="EURUSD", digits=5, point=0.00001, tick_size=0.00001, volume_min=0.01, volume_step=0.01)
    assert snap_price(1.0849999999999, eur) == 1.085
    assert snap_stop_loss(1.084999999, "buy", eur) == 1.085


def test_volume_rounds_down_and_respects_limits():
    assert snap_volume(0.19, spec()) == 0.1
    assert snap_volume(0.3, spec()) == 0.3  # 0.3 / 0.1 = 2.9999999999999996
    with pytest.raises(InvalidOrder, match="below NAS100's minimum"):
        snap_volume(0.05, spec())
    with pytest.raises(InvalidOrder, match="above"):
        snap_volume(60, spec())


def test_close_volume():
    assert snap_close_volume(0.27, spec()) == 0.2
    with pytest.raises(InvalidOrder):
        snap_close_volume(0.05, spec())
