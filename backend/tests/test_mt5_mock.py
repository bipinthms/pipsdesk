"""The simulator must behave like the real terminal closely enough to develop against."""

from __future__ import annotations

import pytest

from backend.tests.conftest import find_time


@pytest.fixture
def mt5(mock):
    assert mock.initialize()
    return mock


def _buy(mt5, volume=0.1, sl=0.0, tp=0.0, symbol="EURUSD", **extra):
    tick = mt5.symbol_info_tick(symbol)
    return mt5.order_send({
        "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": volume,
        "type": mt5.ORDER_TYPE_BUY, "price": tick.ask, "sl": sl, "tp": tp, "deviation": 10, **extra,
    })


class TestPrices:
    def test_rates_are_deterministic_aligned_and_well_formed(self, mt5):
        a = mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_M5, 0, 200)
        b = mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_M5, 0, 200)
        assert a == b and len(a) == 200
        times = [r["time"] for r in a]
        assert all(t % 300 == 0 for t in times)
        assert all(t2 - t1 == 300 for t1, t2 in zip(times, times[1:]))
        for r in a:
            assert r["low"] <= min(r["open"], r["close"]) <= max(r["open"], r["close"]) <= r["high"]
            assert r["tick_volume"] >= 1

    def test_timeframes_agree(self, mt5):
        h1 = mt5.copy_rates_from_pos("XAUUSD", mt5.TIMEFRAME_H1, 1, 1)[0]
        m1 = mt5.copy_rates_from("XAUUSD", mt5.TIMEFRAME_M1, h1["time"] + 3599, 60)
        assert m1[0]["time"] == h1["time"]
        assert m1[0]["open"] == h1["open"]
        assert m1[-1]["close"] == h1["close"]

    def test_forming_bar_closes_at_current_bid(self, mt5):
        bar = mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_M1, 0, 1)[0]
        assert bar["close"] == mt5.symbol_info_tick("EURUSD").bid

    def test_copy_rates_from_never_returns_future_bars(self, mt5, clock):
        now_bar = mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_M1, 0, 1)[0]
        bars = mt5.copy_rates_from("EURUSD", mt5.TIMEFRAME_M1, now_bar["time"] + 10_000, 5)
        assert bars[-1]["time"] == now_bar["time"]

    def test_spread_and_unknown_symbol(self, mt5):
        t = mt5.symbol_info_tick("EURUSD")
        assert round((t.ask - t.bid) / 0.00001) == 8
        assert mt5.symbol_info_tick("NOPE") is None
        assert mt5.last_error()[0] == mt5.RES_E_NOT_FOUND


class TestTrading:
    def test_market_buy_fills_at_ask_and_costs_the_spread(self, mt5):
        r = _buy(mt5, volume=1.0)
        assert r.retcode == mt5.TRADE_RETCODE_DONE
        (pos,) = mt5.positions_get()
        assert pos.price_open == r.price == r.ask
        assert pos.profit == pytest.approx(-8 * 0.00001 * 100_000, abs=0.01)
        acct = mt5.account_info()
        assert acct.equity == pytest.approx(acct.balance + pos.profit)
        assert acct.margin == pytest.approx(100_000 * pos.price_open / 100, rel=1e-6)

    def test_invalid_stops(self, mt5):
        bid = mt5.symbol_info_tick("EURUSD").bid
        assert _buy(mt5, sl=bid + 0.001).retcode == mt5.TRADE_RETCODE_INVALID_STOPS
        assert _buy(mt5, tp=bid - 0.001).retcode == mt5.TRADE_RETCODE_INVALID_STOPS
        # XAUUSD has a stops level of 10 points: an SL 5 points away is too close.
        gold = mt5.symbol_info_tick("XAUUSD")
        assert _buy(mt5, symbol="XAUUSD", sl=gold.bid - 0.05).retcode == mt5.TRADE_RETCODE_INVALID_STOPS

    def test_requote_when_price_moved_beyond_deviation(self, mt5):
        tick = mt5.symbol_info_tick("EURUSD")
        r = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL, "symbol": "EURUSD", "volume": 0.1,
            "type": mt5.ORDER_TYPE_BUY, "price": tick.ask - 0.0010, "deviation": 5,
        })
        assert r.retcode == mt5.TRADE_RETCODE_REQUOTE
        assert r.ask == tick.ask

    def test_invalid_volume(self, mt5):
        assert _buy(mt5, volume=0.015).retcode == mt5.TRADE_RETCODE_INVALID_VOLUME
        assert _buy(mt5, volume=0.0).retcode == mt5.TRADE_RETCODE_INVALID_VOLUME

    def test_no_money(self, mock, clock):
        mock._mock_reset(initial_balance=1_000)
        mock._mock_set_clock(clock)
        mock.initialize()
        assert _buy(mock, volume=5.0).retcode == mock.TRADE_RETCODE_NO_MONEY

    def test_market_closed(self, mt5):
        mt5._mock_set_market_closed("EURUSD", True)
        assert _buy(mt5).retcode == mt5.TRADE_RETCODE_MARKET_CLOSED

    def test_partial_then_full_close_realises_pnl(self, mt5, clock):
        _buy(mt5, volume=0.5)
        (pos,) = mt5.positions_get()
        clock.advance(600)
        start_balance = mt5.account_info().balance

        def close(volume):
            return mt5.order_send({
                "action": mt5.TRADE_ACTION_DEAL, "symbol": "EURUSD", "position": pos.ticket,
                "volume": volume, "type": mt5.ORDER_TYPE_SELL,
            })

        assert close(0.6).retcode == mt5.TRADE_RETCODE_INVALID_CLOSE_VOLUME
        assert close(0.2).retcode == mt5.TRADE_RETCODE_DONE
        assert mt5.positions_get()[0].volume == pytest.approx(0.3)
        assert close(0.3).retcode == mt5.TRADE_RETCODE_DONE
        assert mt5.positions_get() == ()
        realised = sum(d.profit for d in mt5.history_deals_get(position=pos.ticket))
        assert mt5.account_info().balance == pytest.approx(start_balance + realised)

    def test_stop_loss_is_hit(self, mt5, clock):
        bid = mt5.symbol_info_tick("EURUSD").bid
        sl = round(bid - 0.0003, 5)
        _buy(mt5, sl=sl)
        find_time(clock, lambda: mt5.symbol_info_tick("EURUSD").bid <= sl)
        assert mt5.positions_get() == ()
        out = [d for d in mt5.history_deals_get() if d.entry == mt5.DEAL_ENTRY_OUT]
        assert out[-1].reason == mt5.DEAL_REASON_SL
        assert out[-1].profit < 0

    def test_buy_limit_triggers_into_a_position(self, mt5, clock):
        ask = mt5.symbol_info_tick("EURUSD").ask
        price = round(ask - 0.0005, 5)
        r = mt5.order_send({
            "action": mt5.TRADE_ACTION_PENDING, "symbol": "EURUSD", "volume": 0.1,
            "type": mt5.ORDER_TYPE_BUY_LIMIT, "price": price,
        })
        assert r.retcode == mt5.TRADE_RETCODE_DONE
        assert len(mt5.orders_get()) == 1
        find_time(clock, lambda: mt5.symbol_info_tick("EURUSD").ask <= price)
        assert mt5.orders_get() == ()
        (pos,) = mt5.positions_get()
        assert pos.ticket == r.order

    def test_pending_order_price_must_be_on_correct_side(self, mt5):
        ask = mt5.symbol_info_tick("EURUSD").ask
        r = mt5.order_send({
            "action": mt5.TRADE_ACTION_PENDING, "symbol": "EURUSD", "volume": 0.1,
            "type": mt5.ORDER_TYPE_BUY_LIMIT, "price": ask + 0.001,
        })
        assert r.retcode == mt5.TRADE_RETCODE_INVALID_PRICE

    def test_modify_and_remove(self, mt5):
        _buy(mt5)
        (pos,) = mt5.positions_get()
        bid = mt5.symbol_info_tick("EURUSD").bid
        sltp = {"action": mt5.TRADE_ACTION_SLTP, "position": pos.ticket, "sl": round(bid - 0.002, 5), "tp": 0.0}
        assert mt5.order_send(sltp).retcode == mt5.TRADE_RETCODE_DONE
        assert mt5.order_send(sltp).retcode == mt5.TRADE_RETCODE_NO_CHANGES
        assert mt5.order_send({**sltp, "position": 1}).retcode == mt5.TRADE_RETCODE_POSITION_CLOSED
        assert mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": 1}).retcode == mt5.TRADE_RETCODE_INVALID_ORDER

    def test_disconnected_terminal_returns_none(self, mt5):
        mt5._mock_set_terminal_down(True)
        assert mt5.account_info() is None
        assert mt5.last_error()[0] == -10004
        assert mt5.initialize() is False
