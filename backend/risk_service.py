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
    ) -> None:
        """`expected_login`: the MT5_LOGIN the app is configured for (live mode); new orders are
        blocked while the terminal is on another account."""
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
        self.engine = RiskEngine(settings, state, bridge.calc_profit)
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
            Exposure("position", p.ticket, p.symbol, p.side, p.volume, p.price_open, p.sl, p.profit + p.swap)
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
            self.engine.observe(
                account.balance, account.equity, self._clock(), self.server_now(), account=self._account()[0]
            )
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
