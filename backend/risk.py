"""Risk engine: every order action must pass `RiskEngine.evaluate` before it reaches MT5.

Pure logic. It does no I/O; the caller supplies the account snapshot, open
exposure, clocks and a profit calculator (MT5's `order_calc_profit` in
production). That keeps every rule unit-testable.

Rules (all limits configurable in `RiskSettings`):
- Daily loss: equity may not fall below the day's starting base minus X%. The base
  is the higher of balance/equity (or either one) at the configured day reset.
- Max drawdown: equity may not fall below initial balance minus Y% (static), or
  the equity high-water mark minus Y% (trailing).
- A new or widened stop is blocked when the *worst case* (every open SL, every
  pending order filled and stopped, plus this order's SL, plus commissions)
  would breach either floor.
- Max risk per trade as % of balance; a stop loss is required unless explicitly overridden.
- Max open positions (positions + pending orders) and max total lots.
- At most N order actions per minute.
- Optional news blackout: no new orders within ±M minutes of a user-entered event.

Risk-reducing actions are never blocked: closing positions, cancelling pending
orders, and moving a stop loss closer to price.
"""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator

Side = Literal["buy", "sell"]
# (side, symbol, volume, price_open, price_close) -> P/L in account currency
ProfitCalc = Callable[[Side, str, float, float, float], float]

EPS = 0.005  # half a cent: tolerance for money comparisons
RATE_WINDOW_S = 60.0
LATE_ANCHOR_S = 300.0  # anchors captured >5 min after the reset are flagged
ACCOUNT_CHANGED = (
    "The terminal is on a different MT5 account from the one these limits were recorded for. "
    "Open Settings, check Initial balance and the limits for this account, and save to continue."
)
# Real UTC offsets run from -12h to +14h. A server clock further from UTC than this
# is a bad reading (a zero or very old tick), not a time zone.
MAX_SERVER_OFFSET_S = 14 * 3600


# ---------------------------------------------------------------------------
# Settings and persistent state
# ---------------------------------------------------------------------------


class RiskSettings(BaseModel):
    daily_loss_pct: float = Field(5.0, gt=0, le=100)
    daily_loss_basis: Literal["higher_of_balance_equity", "balance", "equity"] = "higher_of_balance_equity"
    max_drawdown_pct: float = Field(10.0, gt=0, le=100)
    drawdown_mode: Literal["static", "trailing"] = "static"
    # Account size the drawdown is measured from. None = first balance observed.
    initial_balance: float | None = Field(None, gt=0)
    max_risk_per_trade_pct: float = Field(1.0, gt=0, le=100)
    require_stop_loss: bool = True
    max_open_positions: int = Field(3, ge=1, le=100)
    max_total_lots: float = Field(5.0, gt=0)
    # Hard ceiling of 30/min: this app is for manual trading only.
    max_actions_per_minute: int = Field(5, ge=1, le=30)
    news_blackout_enabled: bool = True
    news_blackout_minutes: int = Field(2, ge=0, le=240)
    # Round-turn commission per lot in account currency, added to every worst case.
    commission_per_lot: float = Field(0.0, ge=0)
    day_reset_time: str = Field("00:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    # "server" = MT5 server clock (what prop firms usually use), or an IANA zone name.
    day_reset_timezone: str = "server"
    warn_at_pct_used: float = Field(50.0, gt=0, lt=100)
    danger_at_pct_used: float = Field(80.0, gt=0, lt=100)

    @field_validator("day_reset_timezone")
    @classmethod
    def _valid_tz(cls, v: str) -> str:
        if v != "server":
            try:
                ZoneInfo(v)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise ValueError(f"Unknown timezone: {v}") from exc
        return v


class RiskState(BaseModel):
    """Values the engine must remember across restarts, for one MT5 account."""

    # Fingerprint of the MT5 account (login@server) this state belongs to.
    account: str | None = None
    # False after the terminal switched accounts, until the limits are confirmed in Settings.
    account_confirmed: bool = True
    day_key: str | None = None
    # Reset schedule ("HH:MM@zone") that `day_key` was computed under.
    day_schedule: str | None = None
    day_start_balance: float | None = None
    day_start_equity: float | None = None
    day_anchor_time_utc: float | None = None
    day_anchor_late: bool = False
    high_water_equity: float | None = None
    initial_balance_observed: float | None = None


# ---------------------------------------------------------------------------
# Inputs and outputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Exposure:
    """An open position or pending order."""

    kind: Literal["position", "pending"]
    ticket: int
    symbol: str
    side: Side
    volume: float
    entry: float  # open price, or trigger price for pending orders
    sl: float | None
    floating_pnl: float = 0.0  # positions only


ActionKind = Literal["open", "pending", "modify_position", "modify_order", "close", "cancel"]
# Actions that only ever reduce risk.
NEVER_BLOCKED: frozenset[str] = frozenset({"close", "cancel"})


@dataclass(frozen=True)
class OrderIntent:
    action: ActionKind
    symbol: str = ""
    side: Side | None = None
    volume: float = 0.0
    entry: float = 0.0  # expected fill (market) or order price (pending / modify_order)
    sl: float | None = None
    tp: float | None = None
    ticket: int | None = None  # modify / close / cancel
    allow_no_sl: bool = False  # the explicit "no stop loss" override


@dataclass(frozen=True)
class RiskContext:
    balance: float
    equity: float
    exposures: Sequence[Exposure]
    now_utc: float
    server_now: float | None  # MT5 server clock as epoch seconds; None when it can't be read
    news_times_utc: Sequence[float] = ()
    account: str | None = None  # fingerprint of the account the terminal is on
    # Conditions found outside the engine that block new risk (e.g. the wrong account).
    blocks: Sequence[str] = ()


class RiskDecision(BaseModel):
    allowed: bool
    violations: list[str] = []
    warnings: list[str] = []
    trade_risk: float | None = None  # loss at SL incl. commission, account currency
    trade_risk_pct: float | None = None  # of balance
    trade_reward: float | None = None
    reward_risk: float | None = None
    worst_case_equity: float | None = None
    daily_floor: float | None = None
    drawdown_floor: float | None = None


Level = Literal["ok", "warn", "danger", "breached"]


class LimitStatus(BaseModel):
    limit_pct: float
    base: float  # the amount the % applies to
    limit_amount: float
    floor: float  # equity must stay above this
    used: float  # amount lost against the limit so far (>= 0)
    remaining: float  # equity - floor
    used_pct: float  # used / limit_amount * 100
    level: Level


class RiskStatus(BaseModel):
    daily: LimitStatus | None
    drawdown: LimitStatus | None
    day_key: str | None
    day_start_balance: float | None
    day_start_equity: float | None
    day_anchor_late: bool
    initial_balance: float | None
    initial_balance_source: Literal["settings", "observed", "unknown"]
    actions_last_minute: int
    max_actions_per_minute: int
    news_blackout_active: bool
    next_news_event_utc: float | None
    # The terminal switched to another account: new orders wait for the limits to be confirmed.
    account_changed: bool = False


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


def _money(v: float) -> str:
    return f"${v:,.2f}"


class RiskEngine:
    def __init__(self, settings: RiskSettings, state: RiskState | None, profit_calc: ProfitCalc) -> None:
        self.settings = settings
        self.state = state or RiskState()
        self._profit = profit_calc
        self._actions: deque[float] = deque()

    # -- clocks and anchors ------------------------------------------------

    def day_key(self, now_utc: float, server_now: float) -> tuple[str, float]:
        """(trading-day key, seconds elapsed since that day's reset)."""
        s = self.settings
        if s.day_reset_timezone == "server":
            local = datetime.fromtimestamp(server_now, UTC).replace(tzinfo=None)
        else:
            local = datetime.fromtimestamp(now_utc, ZoneInfo(s.day_reset_timezone)).replace(tzinfo=None)
        h, m = (int(x) for x in s.day_reset_time.split(":"))
        shifted = local - timedelta(hours=h, minutes=m)
        midnight = shifted.replace(hour=0, minute=0, second=0, microsecond=0)
        return shifted.date().isoformat(), (shifted - midnight).total_seconds()

    def _schedule(self) -> str:
        return f"{self.settings.day_reset_time}@{self.settings.day_reset_timezone}"

    def confirm_account(self) -> bool:
        """The trader checked the limits for the current account. Returns True if it was pending."""
        pending = not self.state.account_confirmed
        self.state.account_confirmed = True
        return pending

    def clock_valid(self, now_utc: float, server_now: float | None) -> bool:
        """Can the trading day be worked out from these clocks?"""
        if self.settings.day_reset_timezone != "server":
            return True
        return server_now is not None and abs(server_now - now_utc) <= MAX_SERVER_OFFSET_S

    def observe(
        self, balance: float, equity: float, now_utc: float, server_now: float | None, account: str | None = None
    ) -> bool:
        """Update day anchor, high-water mark and observed initial balance. Returns True if state changed.

        The trading day only ever moves forward. A day key older than the stored one
        (a stale or zero tick, or the repeated hour when clocks go back) is ignored,
        so the anchor can never be re-taken in the middle of a day at a lower equity.

        State belongs to one account. On another account, it starts afresh and new
        orders are blocked until the limits are confirmed (`confirm_account`).
        """
        before = self.state.model_copy()
        if account is not None and self.state.account != account:
            if self.state.account is None:
                self.state.account = account  # first run, or state saved before accounts were recorded
            else:
                self.state = RiskState(account=account, account_confirmed=False)
        st = self.state
        if st.initial_balance_observed is None:
            st.initial_balance_observed = balance
        if self.clock_valid(now_utc, server_now):
            key, since_reset = self.day_key(now_utc, server_now or 0.0)
            schedule = self._schedule()
            if st.day_schedule is None:
                st.day_schedule = schedule  # state saved before schedules were recorded
            if st.day_key is not None and st.day_schedule != schedule:
                # Reset time or zone changed: keep today's anchor. The new schedule's
                # first reset comes at its next reset time, never at the moment of the edit.
                st.day_key = key
                st.day_schedule = schedule
            elif st.day_key is None or key > st.day_key:
                st.day_key = key
                st.day_start_balance = balance
                st.day_start_equity = equity
                st.day_anchor_time_utc = now_utc
                st.day_anchor_late = since_reset > LATE_ANCHOR_S
        st.high_water_equity = max(st.high_water_equity or equity, equity)
        return st != before

    # -- limits --------------------------------------------------------------

    def initial_balance(self) -> tuple[float | None, Literal["settings", "observed", "unknown"]]:
        if self.settings.initial_balance:
            return self.settings.initial_balance, "settings"
        if self.state.initial_balance_observed:
            return self.state.initial_balance_observed, "observed"
        return None, "unknown"

    def daily_base(self) -> float | None:
        st = self.state
        if st.day_start_balance is None or st.day_start_equity is None:
            return None
        return {
            "higher_of_balance_equity": max(st.day_start_balance, st.day_start_equity),
            "balance": st.day_start_balance,
            "equity": st.day_start_equity,
        }[self.settings.daily_loss_basis]

    def drawdown_base(self) -> float | None:
        initial, _ = self.initial_balance()
        if self.settings.drawdown_mode == "static" or initial is None:
            return initial
        return max(initial, self.state.high_water_equity or initial)

    def floors(self) -> tuple[float | None, float | None]:
        s = self.settings
        daily = self.daily_base()
        dd = self.drawdown_base()
        return (
            None if daily is None else daily * (1 - s.daily_loss_pct / 100),
            None if dd is None else dd * (1 - s.max_drawdown_pct / 100),
        )

    def _limit_status(self, base: float | None, pct: float, equity: float) -> LimitStatus | None:
        if base is None:
            return None
        limit_amount = base * pct / 100
        floor = base - limit_amount
        used = max(0.0, base - equity)
        used_pct = used / limit_amount * 100 if limit_amount else 100.0
        s = self.settings
        level: Level = (
            "breached" if equity <= floor + EPS
            else "danger" if used_pct >= s.danger_at_pct_used
            else "warn" if used_pct >= s.warn_at_pct_used
            else "ok"
        )
        return LimitStatus(
            limit_pct=pct, base=round(base, 2), limit_amount=round(limit_amount, 2), floor=round(floor, 2),
            used=round(used, 2), remaining=round(equity - floor, 2), used_pct=round(used_pct, 1), level=level,
        )

    def status(self, equity: float, now_utc: float, news_times_utc: Sequence[float] = ()) -> RiskStatus:
        s = self.settings
        initial, source = self.initial_balance()
        upcoming = [t for t in news_times_utc if t + s.news_blackout_minutes * 60 >= now_utc]
        return RiskStatus(
            daily=self._limit_status(self.daily_base(), s.daily_loss_pct, equity),
            drawdown=self._limit_status(self.drawdown_base(), s.max_drawdown_pct, equity),
            day_key=self.state.day_key,
            day_start_balance=self.state.day_start_balance,
            day_start_equity=self.state.day_start_equity,
            day_anchor_late=self.state.day_anchor_late,
            initial_balance=initial,
            initial_balance_source=source,
            actions_last_minute=self.actions_in_window(now_utc),
            max_actions_per_minute=s.max_actions_per_minute,
            news_blackout_active=self._blackout_event(now_utc, news_times_utc) is not None,
            next_news_event_utc=min(upcoming) if upcoming else None,
            account_changed=not self.state.account_confirmed,
        )

    # -- rate limiting ---------------------------------------------------------

    def record_action(self, now_utc: float) -> None:
        """Call once for every request actually sent to MT5."""
        self._actions.append(now_utc)
        self.actions_in_window(now_utc)

    def actions_in_window(self, now_utc: float) -> int:
        while self._actions and self._actions[0] <= now_utc - RATE_WINDOW_S:
            self._actions.popleft()
        return len(self._actions)

    def _blackout_event(self, now_utc: float, news_times_utc: Sequence[float]) -> float | None:
        s = self.settings
        if not s.news_blackout_enabled:
            return None
        window = s.news_blackout_minutes * 60
        return next((t for t in sorted(news_times_utc) if abs(now_utc - t) <= window), None)

    # -- money helpers -----------------------------------------------------------

    def _pnl_at_sl(self, e: Exposure) -> float | None:
        """Realised P/L if the stop is hit (negative = loss), commission included. None without SL."""
        if e.sl is None:
            return None
        return self._profit(e.side, e.symbol, e.volume, e.entry, e.sl) - self.settings.commission_per_lot * e.volume

    def _pnl_at(self, e: Exposure, price: float) -> float:
        return self._profit(e.side, e.symbol, e.volume, e.entry, price) - self.settings.commission_per_lot * e.volume

    def _risk_or_none(self, e: Exposure) -> float | None:
        """Loss at the stop for display only: pricing failures must never block a risk-reducing action."""
        try:
            pnl = self._pnl_at_sl(e)
        except Exception:  # noqa: BLE001 - e.g. the terminal can't price the symbol right now
            return None
        return round(max(0.0, -pnl), 2) if pnl is not None and math.isfinite(pnl) else None

    @staticmethod
    def _tightens(old: Exposure, new: Exposure) -> bool:
        """Adding a stop, or moving it towards the profit side, with the entry unchanged."""
        if new.sl is None or new.entry != old.entry:
            return False
        if old.sl is None:
            return True
        return new.sl >= old.sl if new.side == "buy" else new.sl <= old.sl

    # -- the check -------------------------------------------------------------------

    def evaluate(self, intent: OrderIntent, ctx: RiskContext | None) -> RiskDecision:
        """`ctx` may be None for closes and cancels: they need no account or market data."""
        # Closing and cancelling only ever reduce risk: always allowed, whatever state
        # the account, the prices or the server clock are in.
        if intent.action in NEVER_BLOCKED:
            return RiskDecision(allowed=True)
        if ctx is None:
            raise ValueError(f"{intent.action} needs a risk context")
        self.observe(ctx.balance, ctx.equity, ctx.now_utc, ctx.server_now, ctx.account)
        daily_floor, dd_floor = self.floors()
        s = self.settings
        violations: list[str] = []
        warnings: list[str] = []
        decision = RiskDecision(allowed=True, daily_floor=daily_floor, drawdown_floor=dd_floor)

        # --- build the exposure this action would leave behind --------------------
        existing: Exposure | None = None
        if intent.action in ("modify_position", "modify_order"):
            kind = "position" if intent.action == "modify_position" else "pending"
            existing = next((e for e in ctx.exposures if e.ticket == intent.ticket and e.kind == kind), None)
            if existing is None:
                what = "Position" if kind == "position" else "Pending order"
                return RiskDecision(allowed=False, violations=[f"{what} #{intent.ticket} not found."])
            candidate = replace(
                existing,
                sl=intent.sl,
                entry=intent.entry if intent.action == "modify_order" and intent.entry else existing.entry,
            )
        else:
            if intent.side is None or not intent.symbol:
                return RiskDecision(allowed=False, violations=["Order needs a symbol and a side."])
            if not (intent.volume > 0 and math.isfinite(intent.volume)):
                return RiskDecision(allowed=False, violations=["Volume must be greater than zero."])
            if not (intent.entry > 0 and math.isfinite(intent.entry)):
                return RiskDecision(allowed=False, violations=["Entry price is missing."])
            candidate = Exposure(
                "position" if intent.action == "open" else "pending", 0, intent.symbol, intent.side,
                intent.volume, intent.entry, intent.sl,
            )

        # Adding a stop, or moving one closer (less potential loss), is always allowed.
        # Decided from prices alone, so it can't fail on a pricing or clock problem.
        if existing is not None and self._tightens(existing, candidate):
            decision.trade_risk = self._risk_or_none(candidate)
            return decision

        new_pnl = self._pnl_at_sl(candidate)

        # --- the account itself ----------------------------------------------------------------
        if not self.state.account_confirmed:
            violations.append(ACCOUNT_CHANGED)
        violations.extend(ctx.blocks)

        # --- server clock: without it, today's daily-loss anchor can't be confirmed --------
        if not self.clock_valid(ctx.now_utc, ctx.server_now):
            violations.append(
                "The MT5 server clock can't be read, so today's daily loss limit can't be confirmed. "
                "Check SERVER_TIME_SYMBOL and that the terminal is receiving prices."
            )

        # --- rate limit ------------------------------------------------------------
        n_actions = self.actions_in_window(ctx.now_utc)
        if n_actions >= s.max_actions_per_minute:
            violations.append(
                f"Rate limit: {n_actions} order actions in the last minute (max {s.max_actions_per_minute})."
            )

        # --- news blackout (new orders only) ---------------------------------------------
        if intent.action in ("open", "pending"):
            event = self._blackout_event(ctx.now_utc, ctx.news_times_utc)
            if event is not None:
                at = datetime.fromtimestamp(event, UTC).strftime("%H:%M UTC")
                violations.append(f"News blackout: event at {at} (±{s.news_blackout_minutes} min).")

        # --- stop loss presence and side ---------------------------------------------------
        buy = candidate.side == "buy"
        if candidate.sl is None:
            if s.require_stop_loss and not intent.allow_no_sl:
                violations.append("A stop loss is required. Set one, or explicitly override.")
            else:
                warnings.append("No stop loss: the potential loss on this trade is unlimited.")
        elif intent.action in ("open", "pending", "modify_order") and (
            (buy and candidate.sl >= candidate.entry) or (not buy and candidate.sl <= candidate.entry)
        ):
            violations.append(f"Stop loss must be {'below' if buy else 'above'} the entry price for a {candidate.side}.")
        if intent.tp is not None and intent.action in ("open", "pending") and (
            (buy and intent.tp <= candidate.entry) or (not buy and intent.tp >= candidate.entry)
        ):
            violations.append(f"Take profit must be {'above' if buy else 'below'} the entry price for a {candidate.side}.")

        # --- position count and total lots (new orders only) ------------------------------------
        if intent.action in ("open", "pending"):
            if len(ctx.exposures) + 1 > s.max_open_positions:
                violations.append(
                    f"Max open positions reached: {len(ctx.exposures)} open or pending (max {s.max_open_positions})."
                )
            lots = sum(e.volume for e in ctx.exposures) + candidate.volume
            if lots > s.max_total_lots + 1e-9:
                violations.append(f"Total volume would be {lots:.2f} lots (max {s.max_total_lots:.2f}).")

        # --- per-trade risk and reward ---------------------------------------------------------
        if new_pnl is not None:
            risk = max(0.0, -new_pnl)
            max_risk = ctx.balance * s.max_risk_per_trade_pct / 100
            decision.trade_risk = round(risk, 2)
            decision.trade_risk_pct = round(risk / ctx.balance * 100, 3) if ctx.balance else None
            if risk > max_risk + EPS:
                violations.append(
                    f"Risk {_money(risk)} ({risk / ctx.balance * 100:.2f}%) exceeds the "
                    f"{s.max_risk_per_trade_pct:g}% per-trade limit ({_money(max_risk)})."
                )
            if intent.tp is not None:
                reward = self._pnl_at(candidate, intent.tp)
                decision.trade_reward = round(reward, 2)
                decision.reward_risk = round(reward / risk, 2) if risk > 0 else None

        # --- worst case across everything open -------------------------------------------------------
        others = [e for e in ctx.exposures if existing is None or e.ticket != existing.ticket]
        worst = ctx.balance
        unbounded = candidate.sl is None
        for e in [*others, candidate]:
            pnl = self._pnl_at_sl(e)
            if pnl is not None:
                worst += pnl
            else:
                unbounded = True
                worst += min(0.0, e.floating_pnl)  # best we can do without a stop
        decision.worst_case_equity = round(worst, 2)
        if unbounded:
            warnings.append("Some exposure has no stop loss, so the real worst case is larger than shown.")

        if daily_floor is not None:
            if ctx.equity <= daily_floor + EPS:
                violations.append(f"Daily loss limit reached: equity {_money(ctx.equity)} ≤ {_money(daily_floor)}.")
            elif worst < daily_floor - EPS:
                violations.append(
                    f"If every stop loss is hit, equity would be {_money(worst)}, below today's floor of "
                    f"{_money(daily_floor)} ({s.daily_loss_pct:g}% daily loss limit)."
                )
        if dd_floor is not None:
            if ctx.equity <= dd_floor + EPS:
                violations.append(f"Max drawdown reached: equity {_money(ctx.equity)} ≤ {_money(dd_floor)}.")
            elif worst < dd_floor - EPS:
                violations.append(
                    f"If every stop loss is hit, equity would be {_money(worst)}, below the max drawdown floor of "
                    f"{_money(dd_floor)} ({s.max_drawdown_pct:g}% {s.drawdown_mode})."
                )
        else:
            warnings.append("Initial balance unknown: max drawdown is not being enforced. Set it in Settings.")

        decision.violations = violations
        decision.warnings = warnings
        decision.allowed = not violations
        return decision
