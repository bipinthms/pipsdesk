"""Every guardrail in risk.py, including edge cases. Pure tests: no MT5, no DB."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from backend.risk import (
    Exposure,
    OrderIntent,
    RiskContext,
    RiskEngine,
    RiskSettings,
    RiskState,
)

BAL = 100_000.0
# 2026-10-12 10:00 UTC; server clock assumed 3h ahead (13:00) unless a test says otherwise.
NOW = datetime(2026, 10, 12, 10, 0, tzinfo=UTC).timestamp()
SERVER = NOW + 3 * 3600


def profit(side, symbol, volume, open_, close):
    """EURUSD-like: 1 lot, 1 pip (0.0001) = $10."""
    diff = (close - open_) if side == "buy" else (open_ - close)
    return diff * volume * 100_000


def make(settings: RiskSettings | None = None, state: RiskState | None = None, **overrides) -> RiskEngine:
    s = settings or RiskSettings(initial_balance=BAL, news_blackout_enabled=False, **overrides)
    return RiskEngine(s, state, profit)


_DEFAULT = object()


def ctx(*exposures: Exposure, balance=BAL, equity=None, now=NOW, server=_DEFAULT, news=()) -> RiskContext:
    """`server=None` means the server clock couldn't be read; by default it runs 3h ahead of `now`."""
    return RiskContext(
        balance=balance,
        equity=balance if equity is None else equity,
        exposures=list(exposures),
        now_utc=now,
        server_now=(now + 3 * 3600) if server is _DEFAULT else server,
        news_times_utc=list(news),
    )


def buy(volume=1.0, entry=1.1000, sl: float | None = 1.0950, tp=None, **kw) -> OrderIntent:
    """Default: 1 lot, 50 pip stop = $500 risk (0.5%)."""
    return OrderIntent("open", "EURUSD", "buy", volume, entry, sl, tp, **kw)


def sell(volume=1.0, entry=1.1000, sl: float | None = 1.1050, tp=None, **kw) -> OrderIntent:
    return OrderIntent("open", "EURUSD", "sell", volume, entry, sl, tp, **kw)


def pos(ticket=1, side="buy", volume=1.0, entry=1.1000, sl: float | None = 1.0950, floating=0.0) -> Exposure:
    return Exposure("position", ticket, "EURUSD", side, volume, entry, sl, floating)


def pending(ticket=2, side="buy", volume=1.0, entry=1.0900, sl: float | None = 1.0850) -> Exposure:
    return Exposure("pending", ticket, "EURUSD", side, volume, entry, sl)


def assert_blocked(decision, fragment: str):
    assert not decision.allowed, decision
    assert any(fragment in v for v in decision.violations), decision.violations


# ---------------------------------------------------------------------------


class TestSettings:
    def test_defaults_match_chosen_prop_rules(self):
        s = RiskSettings()
        assert (s.daily_loss_pct, s.max_drawdown_pct, s.drawdown_mode) == (5.0, 10.0, "static")
        assert (s.max_risk_per_trade_pct, s.max_actions_per_minute, s.news_blackout_minutes) == (1.0, 5, 2)
        assert (s.max_open_positions, s.max_total_lots, s.require_stop_loss) == (3, 5.0, True)
        assert (s.day_reset_time, s.day_reset_timezone) == ("00:00", "server")

    @pytest.mark.parametrize(
        "field,value",
        [
            ("daily_loss_pct", 0),
            ("max_drawdown_pct", 101),
            ("max_actions_per_minute", 31),  # hard ceiling: no high-frequency trading
            ("day_reset_time", "24:00"),
            ("day_reset_timezone", "Mars/Olympus"),
            ("commission_per_lot", -1),
        ],
    )
    def test_invalid_settings_rejected(self, field, value):
        with pytest.raises(ValidationError):
            RiskSettings(**{field: value})


class TestHappyPath:
    def test_valid_order_passes_with_metrics(self):
        d = make().evaluate(buy(tp=1.1100), ctx())
        assert d.allowed and d.violations == []
        assert d.trade_risk == pytest.approx(500)
        assert d.trade_risk_pct == pytest.approx(0.5)
        assert d.trade_reward == pytest.approx(1000)
        assert d.reward_risk == pytest.approx(2.0)
        assert d.worst_case_equity == pytest.approx(BAL - 500)
        assert d.daily_floor == pytest.approx(95_000)
        assert d.drawdown_floor == pytest.approx(90_000)

    def test_sell_side_maths(self):
        d = make().evaluate(sell(tp=1.0900), ctx())
        assert d.allowed and d.trade_risk == pytest.approx(500) and d.reward_risk == pytest.approx(2.0)


class TestStopLoss:
    def test_missing_sl_rejected(self):
        assert_blocked(make().evaluate(buy(sl=None), ctx()), "stop loss is required")

    def test_override_allows_with_warning(self):
        d = make(allow_no_sl_override=True).evaluate(buy(sl=None, allow_no_sl=True), ctx())
        assert d.allowed
        assert any("unlimited" in w for w in d.warnings)
        assert d.trade_risk is None

    def test_setting_off_allows_without_override(self):
        assert make(require_stop_loss=False).evaluate(buy(sl=None), ctx()).allowed

    @pytest.mark.parametrize("intent", [buy(sl=1.1000), buy(sl=1.1010), sell(sl=1.1000), sell(sl=1.0990)])
    def test_sl_on_wrong_side_rejected(self, intent):
        assert_blocked(make().evaluate(intent, ctx()), "Stop loss must be")

    @pytest.mark.parametrize("intent", [buy(tp=1.0990), sell(tp=1.1010)])
    def test_tp_on_wrong_side_rejected(self, intent):
        assert_blocked(make().evaluate(intent, ctx()), "Take profit must be")


class TestPerTradeRisk:
    def test_exactly_at_limit_is_allowed(self):
        # 2 lots x 50 pips = $1,000 = 1.00%
        assert make().evaluate(buy(volume=2.0), ctx()).allowed

    def test_one_cent_over_limit_rejected(self):
        d = make(commission_per_lot=0.005).evaluate(buy(volume=2.0), ctx())  # +$0.01
        assert_blocked(d, "per-trade limit")

    def test_commission_counts_towards_risk(self):
        d = make(commission_per_lot=7.0).evaluate(buy(volume=2.0), ctx())
        assert d.trade_risk == pytest.approx(1014)
        assert_blocked(d, "exceeds the 1% per-trade limit")

    def test_commission_reduces_reward(self):
        d = make(commission_per_lot=10.0).evaluate(buy(tp=1.1100), ctx())
        assert d.trade_reward == pytest.approx(990)
        assert d.reward_risk == pytest.approx(990 / 510, abs=0.01)

    def test_limit_scales_with_current_balance(self):
        # After losses the same trade is a bigger % of a smaller balance.
        d = make().evaluate(buy(volume=2.0), ctx(balance=96_000))
        assert_blocked(d, "per-trade limit")

    @pytest.mark.parametrize("volume", [0.0, -1.0, float("nan")])
    def test_invalid_volume(self, volume):
        assert_blocked(make().evaluate(buy(volume=volume), ctx()), "Volume")

    def test_missing_entry_price(self):
        assert_blocked(make().evaluate(buy(entry=0.0), ctx()), "Entry price")


class TestDailyLoss:
    def test_worst_case_includes_all_open_stops_and_pendings(self):
        # Realised losses today: balance 96,000. Floor 95,000. Open SL risk 500 + pending 500 = 1,000.
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)  # day starts at 100k
        d = e.evaluate(buy(volume=0.2), ctx(pos(), pending(), balance=96_000))
        # 96,000 - 500 - 500 - 100 = 94,900 < 95,000
        assert_blocked(d, "below today's floor of $95,000.00")
        assert d.worst_case_equity == pytest.approx(94_900)

    def test_same_order_fits_without_the_pending(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        assert e.evaluate(buy(volume=0.2), ctx(pos(), balance=96_000)).allowed

    def test_profitable_trailing_stop_offsets_risk(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        locked = pos(sl=1.1050)  # stop already 50 pips in profit: +$500 if hit
        d = e.evaluate(buy(volume=1.0), ctx(locked, balance=95_400))
        assert d.allowed and d.worst_case_equity == pytest.approx(95_400)

    def test_position_without_sl_counts_floating_loss_and_warns(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        # 100,000 - 4,000 floating - 500 new SL = 95,500: allowed, but flagged
        d = e.evaluate(buy(volume=1.0), ctx(pos(sl=None, floating=-4_000), equity=96_000))
        assert d.allowed and d.worst_case_equity == pytest.approx(95_500)
        assert any("worst case is larger" in w for w in d.warnings)
        # 100,000 - 4,600 - 500 = 94,900: blocked
        d = e.evaluate(buy(volume=1.0), ctx(pos(sl=None, floating=-4_600), equity=95_400))
        assert_blocked(d, "below today's floor")

    def test_already_breached_blocks_everything_new(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        d = e.evaluate(buy(volume=0.01), ctx(balance=95_000, equity=94_999))
        assert_blocked(d, "Daily loss limit reached")

    @pytest.mark.parametrize(
        "basis,expected_floor",
        [("higher_of_balance_equity", 102_000 * 0.95), ("balance", 95_000), ("equity", 102_000 * 0.95)],
    )
    def test_basis(self, basis, expected_floor):
        e = make(daily_loss_basis=basis)
        e.observe(BAL, 102_000, NOW, SERVER)  # floating profit at the day's start
        assert e.floors()[0] == pytest.approx(expected_floor)

    def test_basis_balance_when_equity_lower(self):
        e = make()
        e.observe(BAL, 98_000, NOW, SERVER)
        assert e.floors()[0] == pytest.approx(95_000)


class TestDayReset:
    def test_anchor_held_through_the_day_then_resets_at_server_midnight(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)  # server 13:00
        e.observe(97_000, 97_000, NOW + 3600, SERVER + 3600)
        assert e.daily_base() == BAL
        nxt = SERVER + 11 * 3600 + 1  # server 00:00:01 next day
        e.observe(97_000, 97_000, NOW + 11 * 3600 + 1, nxt)
        assert e.state.day_key == "2026-10-13"
        assert e.daily_base() == 97_000
        assert e.state.day_anchor_late is False

    def test_late_anchor_flagged(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)  # first seen 13:00 server time
        assert e.state.day_anchor_late is True

    def test_custom_reset_time_and_timezone(self):
        e = make(day_reset_time="17:00", day_reset_timezone="America/New_York")
        # 2026-10-12 10:00 UTC = 06:00 New York (EDT) -> still the trading day that began 2026-10-11 17:00
        assert e.day_key(NOW, SERVER)[0] == "2026-10-11"
        # 21:30 UTC = 17:30 New York -> new day
        assert e.day_key(NOW + 11.5 * 3600, SERVER)[0] == "2026-10-12"

    def test_restored_state_keeps_anchor(self):
        e1 = make()
        e1.observe(BAL, BAL, NOW, SERVER)
        e2 = make(state=RiskState(**e1.state.model_dump()))
        e2.observe(96_000, 96_000, NOW + 60, SERVER + 60)
        assert e2.daily_base() == BAL

    def test_state_saved_before_schedules_were_recorded_keeps_anchor(self):
        e = make(state=RiskState(day_key="2026-10-12", day_start_balance=BAL, day_start_equity=BAL))
        e.observe(96_000, 96_000, NOW, SERVER)
        assert e.daily_base() == BAL and e.state.day_schedule == "00:00@server"


def _down_4pct_at_1300() -> RiskEngine:
    """Anchored at 100k (server 13:00), then 4% lost the same day."""
    e = make()
    e.observe(BAL, BAL, NOW, SERVER)
    e.observe(96_000, 96_000, NOW + 60, SERVER + 60)
    assert e.floors()[0] == pytest.approx(95_000)
    return e


class TestDayAnchorNeverMovesBack:
    """The daily floor must never drop mid-day because the day key moved backwards."""

    @pytest.mark.parametrize(
        "change", [{"day_reset_time": "14:00"}, {"day_reset_timezone": "America/New_York", "day_reset_time": "17:00"}]
    )
    def test_schedule_change_keeps_todays_anchor(self, change):
        e = _down_4pct_at_1300()
        e.settings = RiskSettings(initial_balance=BAL, news_blackout_enabled=False, **change)
        e.observe(96_000, 96_000, NOW + 120, SERVER + 120)
        assert e.floors()[0] == pytest.approx(95_000)

    def test_new_schedule_starts_at_its_next_reset(self):
        e = _down_4pct_at_1300()
        e.settings = RiskSettings(initial_balance=BAL, news_blackout_enabled=False, day_reset_time="14:00")
        e.observe(96_000, 96_000, NOW + 120, SERVER + 120)  # 13:02 server
        hour = 3600  # 14:00:00 server
        e.observe(96_500, 96_500, NOW + hour, SERVER + hour)
        assert e.daily_base() == 96_500 and e.state.day_anchor_late is False

    def test_moving_the_reset_earlier_waits_for_tomorrow(self):
        e = _down_4pct_at_1300()
        e.settings = RiskSettings(initial_balance=BAL, news_blackout_enabled=False, day_reset_time="06:00")
        for dt in (120, 6 * 3600, 16 * 3600):  # 13:02, 19:00, then 05:00 next day
            e.observe(96_000, 96_000, NOW + dt, SERVER + dt)
            assert e.floors()[0] == pytest.approx(95_000)
        six_am = 17 * 3600  # 06:00 next day
        e.observe(96_000, 96_000, NOW + six_am, SERVER + six_am)
        assert e.daily_base() == 96_000

    @pytest.mark.parametrize("bad_server_time", [0.0, -1.0, SERVER - 86_400, SERVER + 86_400])
    def test_implausible_server_clock_is_ignored(self, bad_server_time):
        e = _down_4pct_at_1300()
        e.observe(96_000, 96_000, NOW + 120, bad_server_time)
        e.observe(96_000, 96_000, NOW + 180, SERVER + 180)
        assert e.floors()[0] == pytest.approx(95_000) and e.state.day_key == "2026-10-12"

    def test_none_server_clock_is_ignored(self):
        e = _down_4pct_at_1300()
        e.observe(96_000, 96_000, NOW + 120, None)
        assert e.floors()[0] == pytest.approx(95_000)

    def test_repeated_hour_when_clocks_go_back_does_not_reanchor(self):
        # Europe/Prague leaves summer time on 2026-10-25: 03:00 CEST -> 02:00 CET, so 02:00-03:00 happens twice.
        e = make(day_reset_time="02:30", day_reset_timezone="Europe/Prague")
        first = datetime(2026, 10, 25, 0, 30, tzinfo=UTC).timestamp()  # 02:30 CEST
        e.observe(BAL, BAL, first, first)
        assert e.state.day_key == "2026-10-25"
        anchor = e.state.day_anchor_time_utc
        for minutes in (45, 60, 75):  # 02:15, 02:30, 02:45 CET: the same wall-clock times again
            t = first + minutes * 60
            e.observe(96_000, 96_000, t, t)
        assert e.state.day_anchor_time_utc == anchor and e.daily_base() == BAL

    def test_iana_reset_does_not_need_the_server_clock(self):
        e = make(day_reset_timezone="Europe/Prague")
        e.observe(BAL, BAL, NOW, None)
        assert e.state.day_key == "2026-10-12"


class TestDrawdown:
    def test_static_floor(self):
        e = make()
        e.observe(91_000, 91_000, NOW, SERVER)
        d = e.evaluate(buy(volume=0.3), ctx(balance=91_000))  # 91,000 - 150 = 90,850 OK
        assert d.allowed and d.drawdown_floor == pytest.approx(90_000)
        d = e.evaluate(buy(volume=0.3, sl=1.0600), ctx(balance=91_000))  # 400 pips * 0.3 = 1,200
        assert_blocked(d, "max drawdown floor")

    def test_trailing_follows_high_water_mark(self):
        e = make(drawdown_mode="trailing")
        e.observe(BAL, 110_000, NOW, SERVER)
        assert e.floors()[1] == pytest.approx(99_000)
        e.observe(BAL, 105_000, NOW + 60, SERVER + 60)  # never moves down
        assert e.floors()[1] == pytest.approx(99_000)

    def test_breached_blocks(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        e.settings = RiskSettings(initial_balance=BAL, daily_loss_pct=50, news_blackout_enabled=False)
        assert_blocked(e.evaluate(buy(volume=0.01), ctx(balance=90_000)), "Max drawdown reached")

    def test_unknown_initial_balance_uses_first_observation(self):
        e = RiskEngine(RiskSettings(news_blackout_enabled=False), None, profit)
        e.observe(50_000, 50_000, NOW, SERVER)
        assert e.initial_balance() == (50_000, "observed")
        assert e.floors()[1] == pytest.approx(45_000)


class TestExposureLimits:
    def test_max_positions_counts_pending_orders(self):
        e = make()
        small = dict(volume=0.1)
        d = e.evaluate(buy(**small), ctx(pos(1, volume=0.1), pos(3, volume=0.1), pending(2, volume=0.1)))
        assert_blocked(d, "Max open positions reached: 3")

    def test_max_positions_boundary(self):
        assert make().evaluate(buy(volume=0.1), ctx(pos(1, volume=0.1), pos(2, volume=0.1))).allowed

    def test_max_total_lots(self):
        d = make(max_risk_per_trade_pct=5).evaluate(buy(volume=1.5), ctx(pos(1, volume=2.0), pos(2, volume=2.0)))
        assert_blocked(d, "Total volume would be 5.50 lots (max 5.00)")

    def test_lots_exactly_at_limit(self):
        e = make(max_risk_per_trade_pct=5)
        assert e.evaluate(buy(volume=1.0, sl=1.0990), ctx(pos(1, volume=2.0, sl=1.0990), pos(2, volume=2.0, sl=1.0990))).allowed


class TestRateLimit:
    def test_sixth_action_in_a_minute_blocked_then_window_slides(self):
        e = make()
        for i in range(5):
            e.record_action(NOW + i)
        assert_blocked(e.evaluate(buy(volume=0.1), ctx(now=NOW + 10)), "Rate limit: 5 order actions")
        assert e.evaluate(buy(volume=0.1), ctx(now=NOW + 60.5)).allowed  # first action aged out

    def test_closing_is_never_rate_limited(self):
        e = make()
        for i in range(10):
            e.record_action(NOW + i)
        assert e.evaluate(OrderIntent("close", ticket=1), ctx(pos(), now=NOW + 10)).allowed
        assert e.evaluate(OrderIntent("cancel", ticket=2), ctx(pending(), now=NOW + 10)).allowed


class TestNewsBlackout:
    def make_news(self, **kw):
        return RiskEngine(RiskSettings(initial_balance=BAL, **kw), None, profit)

    @pytest.mark.parametrize("offset", [-120, -1, 0, 60, 120])
    def test_inside_window_blocked(self, offset):
        d = self.make_news().evaluate(buy(volume=0.1), ctx(news=[NOW + offset]))
        assert_blocked(d, "News blackout: event at")

    @pytest.mark.parametrize("offset", [-121, 121, 3600])
    def test_outside_window_allowed(self, offset):
        assert self.make_news().evaluate(buy(volume=0.1), ctx(news=[NOW + offset])).allowed

    def test_disabled(self):
        assert self.make_news(news_blackout_enabled=False).evaluate(buy(volume=0.1), ctx(news=[NOW])).allowed

    def test_blackout_applies_to_pending_orders(self):
        intent = OrderIntent("pending", "EURUSD", "buy", 0.1, 1.0900, 1.0850)
        assert_blocked(self.make_news().evaluate(intent, ctx(news=[NOW])), "News blackout")

    def test_tightening_stop_during_news_is_allowed(self):
        intent = OrderIntent("modify_position", ticket=1, sl=1.0980)
        assert self.make_news().evaluate(intent, ctx(pos(), news=[NOW])).allowed

    def test_status_reports_blackout_and_next_event(self):
        st = self.make_news().status(BAL, NOW, [NOW + 60, NOW + 7200])
        assert st.news_blackout_active is True and st.next_news_event_utc == NOW + 60


class TestModifications:
    def test_tightening_allowed_even_when_limits_are_breached(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        for i in range(10):
            e.record_action(NOW + i)
        d = e.evaluate(OrderIntent("modify_position", ticket=1, sl=1.0990), ctx(pos(), balance=94_000, now=NOW + 10))
        assert d.allowed and d.trade_risk == pytest.approx(100)

    def test_adding_a_stop_to_a_naked_position_is_allowed(self):
        d = make().evaluate(OrderIntent("modify_position", ticket=1, sl=1.0500), ctx(pos(sl=None)))
        assert d.allowed

    def test_widening_beyond_per_trade_limit_blocked(self):
        d = make().evaluate(OrderIntent("modify_position", ticket=1, sl=1.0850), ctx(pos()))  # 150 pips = $1,500
        assert_blocked(d, "per-trade limit")

    def test_widening_that_breaches_daily_floor_blocked(self):
        e = make(max_risk_per_trade_pct=10)
        e.observe(BAL, BAL, NOW, SERVER)
        d = e.evaluate(OrderIntent("modify_position", ticket=1, sl=1.0500), ctx(pos(), balance=99_000))
        assert_blocked(d, "below today's floor")

    def test_removing_stop_requires_override(self):
        assert_blocked(make().evaluate(OrderIntent("modify_position", ticket=1, sl=None), ctx(pos())), "stop loss is required")
        assert make(allow_no_sl_override=True).evaluate(
            OrderIntent("modify_position", ticket=1, sl=None, allow_no_sl=True), ctx(pos())
        ).allowed

    @pytest.mark.parametrize("intent", [buy(sl=None, allow_no_sl=True), OrderIntent("modify_position", ticket=1, sl=None, allow_no_sl=True)])
    def test_override_is_refused_unless_enabled_in_settings(self, intent):
        assert not RiskSettings().allow_no_sl_override
        assert_blocked(make().evaluate(intent, ctx(pos())), "Orders without one are off in Settings")

    def test_moving_sl_into_profit_is_fine(self):
        d = make().evaluate(OrderIntent("modify_position", ticket=1, sl=1.1020), ctx(pos()))
        assert d.allowed

    def test_unknown_ticket(self):
        assert_blocked(make().evaluate(OrderIntent("modify_position", ticket=99, sl=1.09), ctx(pos())), "#99 not found")

    def test_moving_pending_entry_is_rechecked(self):
        # Move the buy limit's entry up to 1.1050 while the stop stays at 1.0850 → 200 pips = $2,000
        intent = OrderIntent("modify_order", ticket=2, entry=1.1050, sl=1.0850)
        assert_blocked(make().evaluate(intent, ctx(pending())), "per-trade limit")

    def test_pending_modify_does_not_count_as_new_position(self):
        intent = OrderIntent("modify_order", ticket=2, entry=1.0910, sl=1.0870)
        e = ctx(pos(1, volume=0.1, sl=1.0990), pos(3, volume=0.1, sl=1.0990), pending(2))
        assert make().evaluate(intent, e).allowed


class TestStatus:
    def test_levels(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        assert e.status(99_000, NOW).daily.level == "ok"  # 20% used
        assert e.status(97_500, NOW).daily.level == "warn"  # 50%
        assert e.status(96_000, NOW).daily.level == "danger"  # 80%
        st = e.status(95_000, NOW)
        assert st.daily.level == "breached" and st.daily.remaining == 0
        assert st.drawdown.level == "warn" and st.drawdown.remaining == 5_000

    def test_status_before_any_observation(self):
        st = RiskEngine(RiskSettings(), None, profit).status(BAL, NOW)
        assert st.daily is None and st.drawdown is None and st.initial_balance_source == "unknown"


class TestNeverBlocked:
    """Closing, cancelling and tightening a stop must not depend on account data, prices or the clock."""

    @pytest.mark.parametrize("action", ["close", "cancel"])
    def test_needs_no_context_at_all(self, action):
        assert make().evaluate(OrderIntent(action, ticket=1), None).allowed

    def test_tightening_when_pricing_fails(self):
        def broken(*_):
            raise RuntimeError("terminal can't price EURUSD")

        e = RiskEngine(RiskSettings(initial_balance=BAL, news_blackout_enabled=False), None, broken)
        d = e.evaluate(OrderIntent("modify_position", ticket=1, sl=1.0990), ctx(pos()))
        assert d.allowed and d.trade_risk is None

    @pytest.mark.parametrize("new_sl", [1.0960, 1.0950, 1.1020])  # closer, unchanged, into profit
    def test_tightening_with_no_server_clock_and_limits_breached(self, new_sl):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        d = e.evaluate(OrderIntent("modify_position", ticket=1, sl=new_sl), ctx(pos(), balance=94_000, server=None))
        assert d.allowed

    def test_adding_a_stop_to_a_sell_is_always_allowed(self):
        d = make().evaluate(OrderIntent("modify_position", ticket=1, sl=1.2000), ctx(pos(side="sell", sl=None), server=None))
        assert d.allowed

    @pytest.mark.parametrize("new_sl", [1.0940, None])
    def test_widening_or_removing_is_still_checked(self, new_sl):
        d = make().evaluate(OrderIntent("modify_position", ticket=1, sl=new_sl), ctx(pos(), server=None))
        assert_blocked(d, "server clock")

    def test_new_order_without_server_clock_is_blocked(self):
        assert_blocked(make().evaluate(buy(volume=0.1), ctx(server=None)), "server clock can't be read")

    def test_new_order_with_iana_reset_needs_no_server_clock(self):
        assert make(day_reset_timezone="Europe/Prague").evaluate(buy(volume=0.1), ctx(server=None)).allowed

    def test_other_actions_need_a_context(self):
        with pytest.raises(ValueError):
            make().evaluate(buy(), None)


class TestAccountBinding:
    def test_first_account_is_adopted(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER, account="acct-a")
        assert e.state.account == "acct-a" and e.state.account_confirmed

    def test_another_account_starts_afresh_and_blocks_new_risk(self):
        e = RiskEngine(RiskSettings(news_blackout_enabled=False), None, profit)
        e.observe(10_000, 10_000, NOW, SERVER, account="small")  # floors 9,500 / 9,000
        big = replace(ctx(pos(), balance=100_000), account="big")
        d = e.evaluate(buy(volume=0.1), big)
        assert_blocked(d, "different MT5 account")
        assert e.floors() == (pytest.approx(95_000), pytest.approx(90_000))
        assert e.status(100_000, NOW).account_changed is True
        # Getting out and protecting positions still work.
        assert e.evaluate(OrderIntent("close", ticket=1), None).allowed
        assert e.evaluate(OrderIntent("modify_position", ticket=1, sl=1.0990), big).allowed
        assert e.confirm_account() is True
        assert e.evaluate(buy(volume=0.1), big).allowed
        assert e.confirm_account() is False

    def test_blocks_from_the_service_apply_to_new_risk_only(self):
        c = replace(ctx(pos()), blocks=["Wrong account."])
        assert_blocked(make().evaluate(buy(volume=0.1), c), "Wrong account.")
        assert make().evaluate(OrderIntent("modify_position", ticket=1, sl=1.0990), c).allowed


class TestLateDayStartRebuilt:
    """App started after the reset: the day start comes from history, not today's numbers."""

    def make(self, found):
        calls = []

        def rebuild(reset_at, balance_now):
            calls.append((reset_at, balance_now))
            return found

        return RiskEngine(RiskSettings(initial_balance=BAL, news_blackout_enabled=False), None, profit, rebuild), calls

    def test_losses_before_the_app_started_still_count(self):
        e, calls = self.make((100_000.0, 100_500.0))
        e.observe(97_000, 97_000, NOW, SERVER)  # server 13:00, 3% realised loss this morning
        assert calls == [(SERVER - 13 * 3600, 97_000)]  # asked for the 00:00 server reset
        assert (e.state.day_start_balance, e.state.day_start_equity) == (100_000, 100_500)
        assert e.state.day_anchor_late and e.state.day_start_rebuilt
        assert e.floors()[0] == pytest.approx(100_500 * 0.95)
        assert e.status(97_000, NOW).day_start_rebuilt is True

    def test_equity_unknown_uses_the_higher_of_rebuilt_balance_and_today(self):
        e, _ = self.make((100_000.0, None))
        e.observe(97_000, 97_000, NOW, SERVER)
        assert e.state.day_start_equity == 100_000 and e.floors()[0] == pytest.approx(95_000)

    def test_history_unavailable_falls_back_to_today(self):
        e, _ = self.make(None)
        e.observe(97_000, 97_000, NOW, SERVER)
        assert e.state.day_start_balance == 97_000 and not e.state.day_start_rebuilt and e.state.day_anchor_late

    def test_on_time_anchor_is_not_rebuilt(self):
        e, calls = self.make((1.0, 1.0))
        midnight = SERVER + 11 * 3600 + 60  # 00:01 server
        e.observe(BAL, BAL, NOW + 11 * 3600 + 60, midnight)
        assert calls == [] and e.daily_base() == BAL


class TestInitialBalance:
    def test_precedence_settings_then_deposit_then_observed(self):
        e = RiskEngine(RiskSettings(news_blackout_enabled=False), RiskState(initial_balance_observed=95_000), profit)
        assert e.initial_balance() == (95_000, "observed")
        e.state.initial_balance_deposit = 100_000
        assert e.initial_balance() == (100_000, "deposit")
        e.settings = RiskSettings(initial_balance=50_000)
        assert e.initial_balance() == (50_000, "settings")

    def test_live_never_uses_the_first_balance_seen(self):
        e = RiskEngine(RiskSettings(news_blackout_enabled=False), None, profit, allow_observed_initial=False)
        e.observe(95_000, 95_000, NOW, SERVER)  # first seen after a 5% loss: would put the floor at 85,500
        assert e.initial_balance() == (None, "unknown")
        assert_blocked(e.evaluate(buy(volume=0.1), ctx(balance=95_000)), "Initial balance unknown")
        assert e.evaluate(OrderIntent("modify_position", ticket=1, sl=1.0990), ctx(pos(), balance=95_000)).allowed
        e.state.initial_balance_deposit = 100_000
        d = e.evaluate(buy(volume=0.1), ctx(balance=95_000))
        assert d.allowed and d.drawdown_floor == pytest.approx(90_000)


class TestWorstCaseAccuracy:
    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), 0.0])
    def test_unpriceable_stop_blocks_the_order(self, bad):
        e = RiskEngine(RiskSettings(initial_balance=BAL, news_blackout_enabled=False), None, lambda *_: bad)
        assert_blocked(e.evaluate(buy(volume=0.1), ctx()), "couldn't value the stop loss on EURUSD")

    def test_unpriceable_open_exposure_blocks_new_risk_but_not_tightening(self):
        def calc(side, symbol, volume, open_, close):
            return float("nan") if symbol == "XAUUSD" else profit(side, symbol, volume, open_, close)

        gold = Exposure("position", 7, "XAUUSD", "buy", 1.0, 2400.0, 2390.0)
        e = RiskEngine(RiskSettings(initial_balance=BAL, news_blackout_enabled=False), None, calc)
        assert_blocked(e.evaluate(buy(volume=0.1), ctx(gold)), "XAUUSD")
        assert e.evaluate(OrderIntent("modify_position", ticket=7, sl=2395.0), ctx(gold)).allowed

    def test_accrued_negative_swap_counts(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        held = Exposure("position", 1, "EURUSD", "buy", 1.0, 1.1000, 1.0950, floating_pnl=-450.0, swap=-400.0)
        d = e.evaluate(buy(volume=0.1), ctx(held, equity=99_550))
        assert d.worst_case_equity == pytest.approx(BAL - 500 - 400 - 50)

    def test_positive_swap_is_not_relied_on(self):
        e = make()
        e.observe(BAL, BAL, NOW, SERVER)
        held = Exposure("position", 1, "EURUSD", "buy", 1.0, 1.1000, 1.0950, floating_pnl=300.0, swap=300.0)
        assert e.evaluate(buy(volume=0.1), ctx(held)).worst_case_equity == pytest.approx(BAL - 500 - 50)


def test_status_reads_the_rate_limit_without_changing_it():
    """The stream thread reads the status without the risk lock: it must not mutate shared state."""
    e = make()
    for i in range(3):
        e.record_action(NOW + i)
    later = NOW + 61.5  # the first two have aged out
    assert e.status(BAL, later).actions_last_minute == 1
    assert len(e._actions) == 3  # untouched; only the locked paths trim the queue
    assert e.actions_in_window(later) == 1 and len(e._actions) == 1
