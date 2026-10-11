"""Order actions: risk check → MT5 → journal, as one atomic step.

Every action goes through `_execute`, which holds the risk lock from the risk
check through `order_send`. Two orders can therefore never both pass against
the same exposure. Every attempt is journaled: blocked by the risk engine,
rejected by the broker, failed, unknown (no clear answer) or accepted.

`order_send` is never retried. New orders carry a tag in their MT5 comment
("pd:xxxxxxxx") so an order with an unclear outcome can be found again, and a
`client_order_id` makes resubmitting the same order return the first result
instead of sending it twice.

Nothing here decides to trade on its own: each method runs one action the
trader requested in the UI.
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from collections.abc import Callable
from typing import Any

from backend import schemas
from backend.db import Database
from backend.mt5_bridge import (
    RETCODE_DONE,
    RETCODE_MESSAGES,
    MT5Bridge,
    MT5Error,
    OrderOutcomeUnknown,
    TradeRejected,
)
from backend.risk import Exposure, OrderIntent, RiskDecision
from backend.risk_service import RiskService

log = logging.getLogger(__name__)

_PENDING = {("buy", "limit"): "buy_limit", ("sell", "limit"): "sell_limit",
            ("buy", "stop"): "buy_stop", ("sell", "stop"): "sell_stop"}
# A client_order_id is remembered this long: resubmitting it returns the first result.
REQUEST_MEMORY_S = 600.0
# An order with an unclear outcome is counted as exposure this long, in case it was placed.
UNKNOWN_EXPOSURE_S = 60.0
FOUND_AFTER_UNCLEAR = "MT5 gave no clear answer, but the order is listed in MT5: it was placed."
ALREADY_SENT = "This order was already sent: showing the result of the first attempt."


def order_tag(request_id: str | None) -> str:
    """Short tag written into the order's MT5 comment, so the order can be found again."""
    seed = request_id or uuid.uuid4().hex
    return "pd:" + hashlib.sha1(seed.encode()).hexdigest()[:8]


class RiskBlocked(Exception):
    def __init__(self, decision: RiskDecision) -> None:
        super().__init__("; ".join(decision.violations))
        self.decision = decision


class TradingService:
    def __init__(self, bridge: MT5Bridge, risk: RiskService, db: Database, clock: Callable[[], float] = time.time) -> None:
        self._bridge = bridge
        self._risk = risk
        self._db = db
        self._clock = clock
        # client_order_id -> (when, first response; None while its outcome is unclear)
        self._requests: dict[str, tuple[float, schemas.TradeResponse | None]] = {}

    # -- core ------------------------------------------------------------------

    def _journal(self, **fields: Any) -> bool:
        """Write a journal entry. A failed write is logged, never raised: it must not turn
        an order that MT5 already executed into an error the trader might retry."""
        try:
            self._db.journal_add(**fields)
            return True
        except Exception:
            log.exception("journal write failed for %s %s", fields.get("action"), fields.get("status"))
            return False

    def _execute(
        self,
        intent: OrderIntent,
        send: Callable[[], schemas.TradeResult],
        journal: dict[str, Any],
        extra: dict[str, Any] | None = None,
        *,
        tag: str | None = None,
        request_id: str | None = None,
    ) -> schemas.TradeResponse:
        with self._risk.lock:
            extra = {**(extra or {}), **({"tag": tag} if tag else {})}
            if request_id is not None:
                earlier = self._earlier_attempt(request_id, tag, intent, journal, extra)
                if earlier is not None:
                    return earlier
            decision = self._risk.evaluate(intent)
            base = {"action": intent.action, "risk_amount": decision.trade_risk, **journal}
            if not decision.allowed:
                self._journal(status="blocked", reason="; ".join(decision.violations),
                              details={**extra, **decision.model_dump()}, **base)
                raise RiskBlocked(decision)
            warnings = list(decision.warnings)
            try:
                result = send()
            except OrderOutcomeUnknown as exc:
                self._risk.record_action()
                found = self._find_tagged(tag)
                if found is None:
                    self._journal(status="unknown", reason=str(exc), retcode=exc.retcode,
                                  details={**extra, "warnings": warnings}, **base)
                    self._count_possible_order(intent)
                    if request_id is not None:
                        self._requests[request_id] = (self._clock(), None)
                    raise
                result = found
                warnings.append(FOUND_AFTER_UNCLEAR)
            except TradeRejected as exc:
                self._risk.record_action()
                self._journal(status="rejected", reason=str(exc), retcode=exc.retcode,
                              details={**extra, "warnings": warnings}, **base)
                raise
            except MT5Error as exc:
                self._journal(status="error", reason=str(exc), details=extra, **base)
                raise
            else:
                self._risk.record_action()
            response = self._accepted(intent, result, base, extra, warnings)
            if request_id is not None:
                self._requests[request_id] = (self._clock(), response)
            return response

    def _accepted(
        self,
        intent: OrderIntent,
        result: schemas.TradeResult,
        base: dict[str, Any],
        extra: dict[str, Any],
        warnings: list[str],
    ) -> schemas.TradeResponse:
        if intent.action in ("open", "pending") and intent.side is not None:
            # Until MT5 lists it, the next check must still see this order.
            self._risk.note_sent(Exposure(
                "position" if intent.action == "open" else "pending", result.order, intent.symbol, intent.side,
                result.volume or intent.volume, result.price or intent.entry, intent.sl,
            ))
        fields = {**base, "ticket": base.get("ticket") or result.order or None}
        if result.price:
            fields["price"] = result.price
        if not self._journal(status="accepted", reason=result.message, retcode=result.retcode,
                             details={**extra, "warnings": warnings, "deal": result.deal}, **fields):
            warnings.append("The order went through, but its journal entry couldn't be saved. See the backend log.")
        log.info("%s accepted: ticket=%s", intent.action, fields["ticket"])
        return schemas.TradeResponse(result=result, warnings=warnings)

    def _count_possible_order(self, intent: OrderIntent) -> None:
        """No clear answer: count the order for a while, in case it was placed."""
        if intent.action in ("open", "pending") and intent.side is not None:
            self._risk.note_sent(
                Exposure("position" if intent.action == "open" else "pending", 0, intent.symbol, intent.side,
                         intent.volume, intent.entry, intent.sl),
                ttl_s=UNKNOWN_EXPOSURE_S,
            )

    def _find_tagged(self, tag: str | None) -> schemas.TradeResult | None:
        """The position or pending order carrying `tag` in its comment, if MT5 lists one."""
        if not tag:
            return None
        try:
            for p in self._bridge.positions():
                if p.comment.startswith(tag):
                    return schemas.TradeResult(retcode=RETCODE_DONE, message="Found in MT5 after an unclear reply.",
                                               order=p.ticket, deal=0, volume=p.volume, price=p.price_open)
            for o in self._bridge.orders():
                if o.comment.startswith(tag):
                    return schemas.TradeResult(retcode=RETCODE_DONE, message="Found in MT5 after an unclear reply.",
                                               order=o.ticket, deal=0, volume=o.volume, price=o.price_open)
        except MT5Error as exc:
            log.warning("couldn't look for order %s: %s", tag, exc)
        return None

    def _earlier_attempt(
        self, request_id: str, tag: str | None, intent: OrderIntent, journal: dict[str, Any], extra: dict[str, Any]
    ) -> schemas.TradeResponse | None:
        """The same order submitted again (double-click, retry after a lost reply)."""
        now = self._clock()
        self._requests = {k: v for k, v in self._requests.items() if now - v[0] < REQUEST_MEMORY_S}
        entry = self._requests.get(request_id)
        if entry is None:
            return None
        response = entry[1]
        if response is not None:
            return response.model_copy(update={"warnings": [*response.warnings, ALREADY_SENT]})
        found = self._find_tagged(tag)
        if found is None:
            raise OrderOutcomeUnknown(
                "An earlier attempt of this order got no clear answer from MT5, and the order isn't listed. "
                "Check Positions and History before placing it again as a new order."
            )
        response = schemas.TradeResponse(result=found, warnings=[FOUND_AFTER_UNCLEAR])
        self._journal(status="accepted", reason=found.message, retcode=found.retcode,
                      details={**extra, "reconciled": True},
                      **{"action": intent.action, **journal, "ticket": found.order, "price": found.price})
        self._requests[request_id] = (now, response)
        return response

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
        tag = order_tag(req.client_order_id)
        comment = f"{tag} {req.comment}".strip()

        if req.order_type == "market":
            tick = b.tick(req.symbol)
            entry = tick.ask if req.side == "buy" else tick.bid
            intent = OrderIntent("open", req.symbol, req.side, req.volume, entry, req.sl, req.tp,
                                 allow_no_sl=req.allow_no_sl)
            journal["price"] = req.price or entry
            send = lambda: b.market_order(  # noqa: E731
                req.symbol, req.side, req.volume, req.sl, req.tp, req.deviation, comment, price=req.price
            )
        else:
            if req.price is None:
                raise TradeRejected("A price is required for limit and stop orders.", 10015)
            pending_type = _PENDING[(req.side, req.order_type)]
            intent = OrderIntent("pending", req.symbol, req.side, req.volume, req.price, req.sl, req.tp,
                                 allow_no_sl=req.allow_no_sl)
            extra["order_type"] = pending_type
            send = lambda: b.pending_order(  # noqa: E731
                req.symbol, pending_type, req.volume, req.price, req.sl, req.tp, comment  # type: ignore[arg-type]
            )
        return self._execute(intent, send, journal, extra, tag=tag, request_id=req.client_order_id)

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
