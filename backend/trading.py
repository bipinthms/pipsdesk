"""Order actions: risk check → MT5 → journal, as one atomic step.

Every action goes through `_execute`, which holds the risk lock from the risk
check through `order_send`. Two orders can therefore never both pass against
the same exposure. Every attempt is journaled: blocked by the risk engine,
rejected by the broker, failed, or accepted.

Nothing here decides to trade on its own: each method runs one action the
trader requested in the UI.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from backend import schemas
from backend.db import Database
from backend.mt5_bridge import RETCODE_MESSAGES, MT5Bridge, MT5Error, TradeRejected
from backend.risk import OrderIntent, RiskDecision
from backend.risk_service import RiskService

log = logging.getLogger(__name__)

_PENDING = {("buy", "limit"): "buy_limit", ("sell", "limit"): "sell_limit",
            ("buy", "stop"): "buy_stop", ("sell", "stop"): "sell_stop"}


class RiskBlocked(Exception):
    def __init__(self, decision: RiskDecision) -> None:
        super().__init__("; ".join(decision.violations))
        self.decision = decision


class TradingService:
    def __init__(self, bridge: MT5Bridge, risk: RiskService, db: Database) -> None:
        self._bridge = bridge
        self._risk = risk
        self._db = db

    # -- core ------------------------------------------------------------------

    def _execute(
        self,
        intent: OrderIntent,
        send: Callable[[], schemas.TradeResult],
        journal: dict[str, Any],
        extra: dict[str, Any] | None = None,
    ) -> schemas.TradeResponse:
        with self._risk.lock:
            decision = self._risk.evaluate(intent)
            base = {"action": intent.action, "risk_amount": decision.trade_risk, **journal}
            extra = extra or {}
            if not decision.allowed:
                self._db.journal_add(status="blocked", reason="; ".join(decision.violations),
                                     details={**extra, **decision.model_dump()}, **base)
                raise RiskBlocked(decision)
            try:
                result = send()
            except TradeRejected as exc:
                self._risk.record_action()
                self._db.journal_add(status="rejected", reason=str(exc), retcode=exc.retcode,
                                     details={**extra, "warnings": decision.warnings}, **base)
                raise
            except MT5Error as exc:
                self._db.journal_add(status="error", reason=str(exc), details=extra, **base)
                raise
            self._risk.record_action()
            fields = {**base, "ticket": base.get("ticket") or result.order or None}
            if result.price:
                fields["price"] = result.price
            self._db.journal_add(status="accepted", reason=result.message, retcode=result.retcode,
                                 details={**extra, "warnings": decision.warnings, "deal": result.deal}, **fields)
            log.info("%s accepted: ticket=%s", intent.action, fields["ticket"])
            return schemas.TradeResponse(result=result, warnings=decision.warnings)

    def _find_position(self, ticket: int) -> schemas.Position:
        p = next((p for p in self._bridge.positions() if p.ticket == ticket), None)
        if p is None:
            raise TradeRejected(RETCODE_MESSAGES[10036], 10036)
        return p

    def _find_order(self, ticket: int) -> schemas.PendingOrder:
        o = next((o for o in self._bridge.orders() if o.ticket == ticket), None)
        if o is None:
            raise TradeRejected(RETCODE_MESSAGES[10035], 10035)
        return o

    # -- actions -------------------------------------------------------------------

    def place(self, req: schemas.OrderRequest) -> schemas.TradeResponse:
        b = self._bridge
        info = b.symbol_info(req.symbol)
        if not info.trade_allowed:
            raise TradeRejected(RETCODE_MESSAGES[10017], 10017)
        journal = {"symbol": req.symbol, "side": req.side, "volume": req.volume, "sl": req.sl, "tp": req.tp,
                   "price": req.price}
        extra: dict[str, Any] = {"order_type": req.order_type}

        if req.order_type == "market":
            tick = b.tick(req.symbol)
            entry = tick.ask if req.side == "buy" else tick.bid
            intent = OrderIntent("open", req.symbol, req.side, req.volume, entry, req.sl, req.tp,
                                 allow_no_sl=req.allow_no_sl)
            journal["price"] = req.price or entry
            send = lambda: b.market_order(  # noqa: E731
                req.symbol, req.side, req.volume, req.sl, req.tp, req.deviation, req.comment, price=req.price
            )
        else:
            if req.price is None:
                raise TradeRejected("A price is required for limit and stop orders.", 10015)
            pending_type = _PENDING[(req.side, req.order_type)]
            intent = OrderIntent("pending", req.symbol, req.side, req.volume, req.price, req.sl, req.tp,
                                 allow_no_sl=req.allow_no_sl)
            extra["order_type"] = pending_type
            send = lambda: b.pending_order(  # noqa: E731
                req.symbol, pending_type, req.volume, req.price, req.sl, req.tp, req.comment  # type: ignore[arg-type]
            )
        return self._execute(intent, send, journal, extra)

    def modify_position(self, ticket: int, req: schemas.ModifyPositionRequest) -> schemas.TradeResponse:
        p = self._find_position(ticket)
        intent = OrderIntent("modify_position", p.symbol, p.side, p.volume, p.price_open, req.sl, req.tp,
                             ticket=ticket, allow_no_sl=req.allow_no_sl)
        journal = {"symbol": p.symbol, "side": p.side, "volume": p.volume, "sl": req.sl, "tp": req.tp, "ticket": ticket}
        return self._execute(intent, lambda: self._bridge.modify_position(ticket, req.sl, req.tp), journal)

    def modify_order(self, ticket: int, req: schemas.ModifyOrderRequest) -> schemas.TradeResponse:
        o = self._find_order(ticket)
        side = "buy" if o.type.startswith("buy") else "sell"
        intent = OrderIntent("modify_order", o.symbol, side, o.volume, req.price, req.sl, req.tp,
                             ticket=ticket, allow_no_sl=req.allow_no_sl)
        journal = {"symbol": o.symbol, "side": side, "volume": o.volume, "price": req.price,
                   "sl": req.sl, "tp": req.tp, "ticket": ticket}
        return self._execute(intent, lambda: self._bridge.modify_order(ticket, req.price, req.sl, req.tp), journal)

    def close_position(self, ticket: int, volume: float | None = None, note: str = "") -> schemas.TradeResponse:
        p = self._find_position(ticket)
        if volume is not None and volume > p.volume + 1e-9:
            raise TradeRejected(RETCODE_MESSAGES[10038], 10038)
        intent = OrderIntent("close", p.symbol, p.side, volume or p.volume, ticket=ticket)
        journal = {"symbol": p.symbol, "side": p.side, "volume": volume or p.volume, "ticket": ticket, "note": note}
        return self._execute(intent, lambda: self._bridge.close_position(ticket, volume), journal)

    def cancel_order(self, ticket: int, note: str = "") -> schemas.TradeResponse:
        o = self._find_order(ticket)
        intent = OrderIntent("cancel", o.symbol, ticket=ticket)
        journal = {"symbol": o.symbol, "volume": o.volume, "price": o.price_open, "ticket": ticket, "note": note}
        return self._execute(intent, lambda: self._bridge.cancel_order(ticket), journal)

    def flatten(self) -> schemas.FlattenResponse:
        """Close every position and cancel every pending order (the trader confirmed this in the UI)."""
        closed: list[int] = []
        cancelled: list[int] = []
        errors: list[str] = []
        for o in self._bridge.orders():
            try:
                self.cancel_order(o.ticket, note="flatten all")
                cancelled.append(o.ticket)
            except MT5Error as exc:
                errors.append(f"Order #{o.ticket}: {exc}")
        for p in self._bridge.positions():
            try:
                self.close_position(p.ticket, note="flatten all")
                closed.append(p.ticket)
            except MT5Error as exc:
                errors.append(f"Position #{p.ticket}: {exc}")
        return schemas.FlattenResponse(closed=closed, cancelled=cancelled, errors=errors)
