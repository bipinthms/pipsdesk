"""Glue between the pure risk engine, the MT5 bridge and SQLite.

Builds a `RiskContext` from live account data, persists settings and engine
state, keeps the news calendar cached, and journals settings changes.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from backend import schemas
from backend.db import Database, NewsEvent
from backend.mt5_bridge import MT5Bridge, MT5Error, MT5Unavailable
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
NEWS_LOOKBACK_S = 86_400


class RiskService:
    def __init__(
        self,
        db: Database,
        bridge: MT5Bridge,
        server_time_symbol: str,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._db = db
        self._bridge = bridge
        self._symbol = server_time_symbol
        self._clock = clock
        # Held across evaluate → order_send in the trading layer, so two orders
        # can never both pass the checks against the same exposure.
        self.lock = threading.RLock()
        settings = RiskSettings.model_validate(db.get_json(SETTINGS_KEY) or {})
        state = RiskState.model_validate(db.get_json(STATE_KEY) or {})
        self.engine = RiskEngine(settings, state, bridge.calc_profit)
        self._news: list[NewsEvent] = db.news_events()
        self._last_equity: float | None = None
        self._clock_error: str | None = None

    # -- context -------------------------------------------------------------

    def context(self) -> RiskContext:
        b = self._bridge
        account = b.account_info()
        exposures = [
            Exposure("position", p.ticket, p.symbol, p.side, p.volume, p.price_open, p.sl, p.profit + p.swap)
            for p in b.positions()
        ] + [
            Exposure("pending", o.ticket, o.symbol, "buy" if o.type.startswith("buy") else "sell", o.volume, o.price_open, o.sl)
            for o in b.orders()
        ]
        now = self._clock()
        return RiskContext(
            balance=account.balance,
            equity=account.equity,
            exposures=exposures,
            now_utc=now,
            server_now=self.server_now(),
            news_times_utc=self._news_times(now),
        )

    def server_now(self) -> float | None:
        """The MT5 server clock, or None when it can't be read (e.g. SERVER_TIME_SYMBOL doesn't exist)."""
        try:
            t = float(self._bridge.server_time(self._symbol))
        except MT5Unavailable:
            raise
        except MT5Error as exc:
            if str(exc) != self._clock_error:
                log.warning("Can't read the MT5 server clock from %s: %s", self._symbol, exc)
            self._clock_error = str(exc)
            return None
        self._clock_error = None
        return t

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
            self.engine.observe(account.balance, account.equity, self._clock(), self.server_now())
            self._last_equity = account.equity
            self._persist_state(before)

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
