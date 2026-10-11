from __future__ import annotations

import logging

import pytest

from backend.config import Settings
from backend.mt5_bridge import (
    MT5Bridge,
    MT5Error,
    MT5Unavailable,
    SymbolNotFound,
    TradeRejected,
    describe_last_error,
    describe_retcode,
)


def test_account_info(bridge):
    a = bridge.account_info()
    assert a.mock is True
    assert a.balance == a.equity == 100_000
    assert a.margin_level is None  # MT5 reports 0 with no positions; we expose "n/a"


def test_symbols_and_unknown_symbol(bridge):
    names = {s.name for s in bridge.symbols()}
    assert {"EURUSD", "XAUUSD", "US30"} <= names
    with pytest.raises(SymbolNotFound, match="Unknown symbol: NOPE"):
        bridge.candles("NOPE", "M1", 10)


def test_candles_paging_is_contiguous(bridge):
    latest = bridge.candles("EURUSD", "M15", 100)
    older = bridge.candles("EURUSD", "M15", 50, before=latest[0].time)
    assert len(latest) == 100 and len(older) == 50
    assert older[-1].time == latest[0].time - 900
    assert all(c.time < latest[0].time for c in older)


def test_trade_round_trip(bridge):
    r = bridge.market_order("EURUSD", "buy", 0.1)
    (pos,) = bridge.positions()
    assert pos.ticket == r.order and pos.side == "buy" and pos.sl is None

    tick = bridge.tick("EURUSD")
    bridge.modify_position(pos.ticket, sl=round(tick.bid - 0.002, 5), tp=None)
    assert bridge.positions()[0].sl == round(tick.bid - 0.002, 5)

    bridge.close_position(pos.ticket)
    assert bridge.positions() == []


def test_rejection_has_readable_message(bridge):
    tick = bridge.tick("EURUSD")
    with pytest.raises(TradeRejected, match="Invalid stops") as exc:
        bridge.market_order("EURUSD", "buy", 0.1, sl=tick.bid + 0.01)
    assert exc.value.retcode == 10016


def test_pending_order_lifecycle(bridge):
    ask = bridge.tick("EURUSD").ask
    r = bridge.pending_order("EURUSD", "buy_stop", 0.1, price=round(ask + 0.002, 5))
    (o,) = bridge.orders()
    assert o.ticket == r.order and o.type == "buy_stop"
    bridge.modify_order(o.ticket, price=round(ask + 0.003, 5), sl=None, tp=None)
    assert bridge.orders()[0].price_open == round(ask + 0.003, 5)
    bridge.cancel_order(o.ticket)
    assert bridge.orders() == []


def test_calc_profit_matches_contract_maths(bridge):
    # 1 lot EURUSD, 10 pips = $100
    assert bridge.calc_profit("buy", "EURUSD", 1.0, 1.1000, 1.0990) == pytest.approx(-100.0)
    assert bridge.calc_profit("sell", "EURUSD", 1.0, 1.1000, 1.0990) == pytest.approx(100.0)


def test_disconnect_then_reconnect_with_backoff(bridge, mock, clock):
    mock._mock_set_terminal_down(True)
    with pytest.raises(MT5Unavailable, match="Not connected"):
        bridge.account_info()
    status = bridge.status()
    assert not status.connected

    # Terminal still down: the immediate retry fails and schedules a 1s backoff.
    assert bridge.health_check() is False
    assert bridge.status().retry_in_seconds == pytest.approx(1.0)
    with pytest.raises(MT5Unavailable, match="MetaTrader 5"):
        bridge.account_info()  # within backoff window: fails fast, no reconnect attempt

    clock.advance(1.0)
    assert bridge.health_check() is False  # second failure: next delay is 2s
    assert bridge.status().retry_in_seconds == pytest.approx(2.0)

    mock._mock_set_terminal_down(False)
    clock.advance(2.0)
    assert bridge.health_check() is True
    assert bridge.account_info().balance == 100_000


def test_backoff_caps_at_sixty_seconds(settings, mock, clock):
    mock._mock_set_terminal_down(True)
    b = MT5Bridge(settings, mt5=mock, clock=clock)
    for _ in range(10):
        b.connect()
        clock.advance(b.status().retry_in_seconds or 0)
    b.connect()
    assert b.status().retry_in_seconds == 60.0


def test_credentials_never_logged(mock, clock, caplog):
    s = Settings(_env_file=None, mt5_mock=True, mt5_login=555, mt5_password="hunter2-secret", mt5_server="Srv")
    assert "hunter2-secret" not in repr(s)
    mock._mock_set_terminal_down(True)
    with caplog.at_level(logging.DEBUG):
        MT5Bridge(s, mt5=mock, clock=clock).connect()
    assert caplog.records, "expected a connection-failure log line"
    assert "hunter2-secret" not in caplog.text


def test_message_mapping():
    assert "Market is closed" in describe_retcode(10018)
    assert "Algo Trading" in describe_retcode(10027)
    assert "retcode 99999" in describe_retcode(99999)
    assert "Authorization failed" in describe_last_error(-6, "auth")
    assert describe_last_error(-77, "weird") == "weird"


class TestEmptyListsAsNone:
    """Some terminal builds answer an empty list with None and last_error() == (1, "Success")."""

    @pytest.fixture(autouse=True)
    def quirk(self, mock):
        mock._mock_set_quirks(empty_as_none=True)

    def test_empty_positions_orders_and_history(self, bridge, clock):
        assert bridge.positions() == [] and bridge.orders() == []
        later = int(clock.t) + 10 * 86_400
        assert bridge.deals(later, later + 86_400) == []

    def test_missing_ticket_is_still_position_closed(self, bridge):
        with pytest.raises(TradeRejected) as exc:
            bridge.close_position(999)
        assert exc.value.retcode == 10036

    def test_a_failed_read_never_looks_empty(self, bridge, mock, monkeypatch):
        bridge.market_order("EURUSD", "buy", 0.1)
        monkeypatch.setattr(mock, "positions_get", lambda **_: None)
        with pytest.raises(MT5Error, match="reports 1"):
            bridge.positions()
