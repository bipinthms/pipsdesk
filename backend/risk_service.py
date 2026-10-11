"""Glue between the pure risk engine, the MT5 bridge and SQLite.

Builds a `RiskContext` from live account data, persists settings and engine
state, keeps the news calendar cached, and journals settings changes.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections.abc import Callable

from backend import schemas
from backend.db import Database, NewsEvent
from backend.mt5_bridge import MT5Bridge, MT5Error, MT5Unavailable
from backend.server_clock import ServerClock
from backend.risk import (
    NEVER_BLOCKED,
    Exposure,
    OrderIntent,
    RiskContext,
    RiskDecision,
    RiskEngine,
    RiskSettings,
    RiskState,
    RiskStatus,
)

log = logging.getLogger(__name__)

SETTINGS_KEY = "risk_settings"
STATE_KEY = "risk_state"
CLOCK_KEY = "server_clock"
NEWS_LOOKBACK_S = 86_400
WRONG_ACCOUNT = (
    "The terminal is logged into a different account from MT5_LOGIN in backend/.env. "
    "Log the terminal into the configured account, or update .env and restart."
)
# How long an order this app just sent is counted before MT5 lists it. A real terminal
# can take a moment to show a new position or order after order_send returns.
RECENT_SEND_TTL_S = 10.0


class RiskService:
    def __init__(
        self,
        db: Database,
        bridge: MT5Bridge,
        server_time_symbol: str,
        clock: Callable[[], float] = time.time,
        expected_login: int | None = None,
        live: bool = False,
    ) -> None:
        """`expected_login`: the MT5_LOGIN the app is configured for (live mode); new orders are
        blocked while the terminal is on another account. `live`: max drawdown is never measured
        from the first balance seen (Settings, or the account's first deposit)."""
        self._db = db
        self._bridge = bridge
        self._symbol = server_time_symbol
        self._clock = clock
        self._expected_login = expected_login
        # Held across evaluate → order_send in the trading layer, so two orders
        # can never both pass the checks against the same exposure.
        self.lock = threading.RLock()
        settings = RiskSettings.model_validate(db.get_json(SETTINGS_KEY) or {})
        state = RiskState.model_validate(db.get_json(STATE_KEY) or {})
        self.engine = RiskEngine(
            settings, state, bridge.calc_profit, rebuild_day_start=self._rebuild_day_start, allow_observed_initial=not live
        )
        self._deposit_checked: str | None = None  # account whose first deposit was looked up
        self._news: list[NewsEvent] = db.news_events()
        self._last_equity: float | None = None
        self._clock_error: str | None = None
        saved_clock = db.get_json(CLOCK_KEY) or {}
        self._server_clock = ServerClock(
            self._read_server_tick,
            clock,
            saved_clock.get("offset_s"),
            on_learned=lambda offset: db.set_json(CLOCK_KEY, {"offset_s": offset}),
        )
        self._recent: list[tuple[Exposure, float]] = []  # (exposure, counted until)

    # -- context -------------------------------------------------------------

    def context(self) -> RiskContext:
        b = self._bridge
        account = b.account_info()
        exposures = [
            Exposure("position", p.ticket, p.symbol, p.side, p.volume, p.price_open, p.sl, p.profit + p.swap, p.swap)
            for p in b.positions()
        ] + [
            Exposure("pending", o.ticket, o.symbol, "buy" if o.type.startswith("buy") else "sell", o.volume, o.price_open, o.sl)
            for o in b.orders()
        ]
        now = self._clock()
        exposures += self._unlisted_recent(exposures, now)
        fingerprint, login = self._account()
        wrong = self._expected_login is not None and login != self._expected_login
        return RiskContext(
            balance=account.balance,
            equity=account.equity,
            exposures=exposures,
            now_utc=now,
            server_now=self.server_now(),
            news_times_utc=self._news_times(now),
            account=fingerprint,
            blocks=[WRONG_ACCOUNT] if wrong else [],
        )

    def _account(self) -> tuple[str, int]:
        """(fingerprint, login) of the terminal's account. The fingerprint is what's stored."""
        login, server = self._bridge.account_identity()
        return hashlib.sha256(f"{login}@{server.strip().lower()}".encode()).hexdigest()[:16], login

    def _read_server_tick(self) -> tuple[int, int]:
        t = self._bridge.tick(self._symbol)
        return t.time, t.time_msc

    def server_now(self) -> float | None:
        """The MT5 server clock (see server_clock.py), or None when it isn't known: no offset
        learned yet and SERVER_TIME_SYMBOL can't be read."""
        try:
            t = self._server_clock.now()
        except MT5Unavailable:
            raise
        except MT5Error as exc:
            if str(exc) != self._clock_error:
                log.warning("Can't read the MT5 server clock from %s: %s", self._symbol, exc)
            self._clock_error = str(exc)
            return None
        self._clock_error = None
        return t

    @property
    def server_offset_s(self) -> float | None:
        return self._server_clock.offset_s

    # -- day start rebuilt from history (the app wasn't running at the reset) ----------

    def _rebuild_day_start(self, reset_at: float, balance_now: float) -> tuple[float, float | None] | None:
        """Balance and equity at the reset: today's balance minus the trading P/L booked since
        (a deposit today counts as day-start capital), plus the P/L at the reset of the
        positions open then (priced from M1 bars)."""
        reset = int(reset_at)
        try:
            start_balance = round(balance_now - self._bridge.trading_pnl_since(reset), 2)
        except MT5Error as exc:
            log.warning("Can't rebuild the day start from MT5 history: %s", exc)
            return None
        try:
            start_equity: float | None = round(start_balance + self._floating_at(reset), 2)
        except MT5Error as exc:
            log.warning("Can't rebuild the equity at the day start: %s", exc)
            start_equity = None
        log.info("Day start rebuilt from history: balance %.2f, equity %s", start_balance, start_equity)
        return start_balance, start_equity

    def _floating_at(self, reset: int) -> float:
        """Open P/L at `reset` (server time) of every position open at that moment."""
        b = self._bridge
        ids = {p.ticket for p in b.positions() if p.time < reset}
        ids |= {d.position_id for d in b.deals(reset, reset + 3 * 86_400) if d.entry == "out" and d.position_id}
        total = 0.0
        for pid in sorted(ids):
            before = [d for d in b.position_deals(pid) if d.time < reset]
            opened = [d for d in before if d.entry == "in" and d.side is not None]
            volume = sum(d.volume for d in opened) - sum(d.volume for d in before if d.entry == "out")
            if not opened or volume <= 1e-9:
                continue
            first = opened[0]
            price_open = sum(d.price * d.volume for d in opened) / sum(d.volume for d in opened)
            quote = b.price_at(first.symbol, reset)
            if quote is None:
                raise MT5Error(f"No {first.symbol} price at the day start.")
            close = quote[0] if first.side == "buy" else quote[1]
            total += b.calc_profit(first.side, first.symbol, volume, price_open, close)  # type: ignore[arg-type]
        return total

    def _news_times(self, now: float) -> list[float]:
        return [float(e.time_utc) for e in self._news if e.time_utc >= now - NEWS_LOOKBACK_S]

    def _persist_state(self, before: RiskState) -> None:
        if self.engine.state != before:
            self._db.set_json(STATE_KEY, self.engine.state.model_dump())

    # -- periodic observation and status ------------------------------------------

    def observe(self) -> None:
        """Called every few seconds so the day anchor is captured even when no orders are placed."""
        with self.lock:
            account = self._bridge.account_info()
            before = self.engine.state.model_copy()
            fingerprint = self._account()[0]
            self.engine.observe(account.balance, account.equity, self._clock(), self.server_now(), account=fingerprint)
            self._find_first_deposit(fingerprint)
            self._last_equity = account.equity
            self._persist_state(before)

    def _find_first_deposit(self, fingerprint: str) -> None:
        """Once per account: its first deposit, the account size when Settings leaves it blank."""
        st = self.engine.state
        if st.initial_balance_deposit is not None or self._deposit_checked == fingerprint:
            return
        try:
            st.initial_balance_deposit = self._bridge.first_deposit()
        except MT5Error as exc:
            log.warning("Can't read the account's first deposit: %s", exc)
            return
        self._deposit_checked = fingerprint
        if st.initial_balance_deposit is not None:
            log.info("Account size from its first deposit: %.2f", st.initial_balance_deposit)

    def status(self, equity: float | None = None) -> RiskStatus | None:
        """Pure computation: no MT5 calls. `equity` defaults to the last observed value."""
        equity = self._last_equity if equity is None else equity
        if equity is None:
            return None
        now = self._clock()
        return self.engine.status(equity, now, self._news_times(now))

    # -- checks -------------------------------------------------------------------

    def evaluate(self, intent: OrderIntent, ctx: RiskContext | None = None) -> RiskDecision:
        with self.lock:
            if intent.action in NEVER_BLOCKED:
                # Closing and cancelling must work even when account data, prices or
                # the server clock can't be read: don't fetch any of it.
                return self.engine.evaluate(intent, None)
            ctx = ctx or self.context()
            before = self.engine.state.model_copy()
            decision = self.engine.evaluate(intent, ctx)
            self._persist_state(before)
            return decision

    def record_action(self) -> None:
        with self.lock:
            self.engine.record_action(self._clock())

    def note_sent(self, exposure: Exposure, ttl_s: float = RECENT_SEND_TTL_S) -> None:
        """An order this app just sent: count it until MT5 lists it (or `ttl_s` passes)."""
        with self.lock:
            self._recent.append((exposure, self._clock() + ttl_s))

    def _unlisted_recent(self, listed: list[Exposure], now: float) -> list[Exposure]:
        tickets = {e.ticket for e in listed}
        self._recent = [(e, until) for e, until in self._recent if until > now and e.ticket not in tickets]
        return [e for e, _ in self._recent]

    def intent_from_check(self, req: schemas.OrderCheckRequest) -> OrderIntent:
        """Fill in the market price for market orders."""
        entry = req.price or 0.0
        if req.action == "open" and req.symbol and req.side and not req.price:
            tick = self._bridge.tick(req.symbol)
            entry = tick.ask if req.side == "buy" else tick.bid
        return OrderIntent(
            action=req.action,
            symbol=req.symbol or "",
            side=req.side,
            volume=req.volume,
            entry=entry,
            sl=req.sl,
            tp=req.tp,
            ticket=req.ticket,
            allow_no_sl=req.allow_no_sl,
        )

    # -- settings and news ----------------------------------------------------------

    @property
    def settings(self) -> RiskSettings:
        return self.engine.settings

    def update_settings(self, new: RiskSettings) -> RiskSettings:
        with self.lock:
            old = self.engine.settings
            changes = {
                k: {"from": v, "to": getattr(new, k)} for k, v in old.model_dump().items() if getattr(new, k) != v
            }
            self.engine.settings = new
            self._db.set_json(SETTINGS_KEY, new.model_dump())
            # Saving the limits is how the trader confirms them for a newly seen account.
            if self.engine.confirm_account():
                self._db.set_json(STATE_KEY, self.engine.state.model_dump())
                self._db.journal_add(action="settings", status="info", reason="Risk limits confirmed for a new MT5 account.")
            if changes:
                self._db.journal_add(
                    action="settings",
                    status="info",
                    reason="Risk settings changed: " + ", ".join(sorted(changes)),
                    details=changes,
                )
            return new

    def news_events(self) -> list[NewsEvent]:
        return list(self._news)

    def add_news_event(self, time_utc: int, title: str) -> NewsEvent:
        ev = self._db.add_news_event(time_utc, title)
        self._news = self._db.news_events()
        return ev

    def delete_news_event(self, event_id: int) -> bool:
        ok = self._db.delete_news_event(event_id)
        self._news = self._db.news_events()
        return ok
