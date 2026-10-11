"""Live data over WebSocket `/ws/stream`.

One `StreamHub` polls MT5 for the union of everything all connected clients
want, then sends each client only the messages that changed since the last
thing *that client* received. So MT5 is polled once regardless of how many
browser tabs are open, and a freshly (re)subscribed client gets a full snapshot.

Protocol (JSON; models in `schemas.py`):
  client → server  {"type": "subscribe", "symbols": [...]}         tick symbols
                   {"type": "chart", "symbol": "...", "timeframe": "M15"}   one chart
                   {"type": "charts", "charts": [{"symbol", "timeframe"}, ...]}  several
  server → client  status | account | risk | positions | orders | tick | candle | error
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from fastapi import WebSocket
from pydantic import TypeAdapter, ValidationError
from starlette.concurrency import run_in_threadpool

from backend import schemas
from backend.mt5_bridge import MT5Bridge, MT5Error, MT5Unavailable, SymbolNotFound
from backend.risk_service import RiskService

log = logging.getLogger(__name__)

_client_message = TypeAdapter(schemas.ClientMessage)
SEND_TIMEOUT_S = 2.0
T = TypeVar("T")

# key -> (comparison value, wire message)
Snapshot = dict[str, tuple[Any, dict[str, Any]]]


@dataclass(eq=False)
class StreamClient:
    ws: WebSocket
    symbols: set[str] = field(default_factory=set)
    charts: set[tuple[str, str]] = field(default_factory=set)
    sent: dict[str, Any] = field(default_factory=dict)

    def wants(self, key: str) -> bool:
        kind, _, rest = key.partition(":")
        if kind == "tick":
            return rest in self.symbols
        if kind == "candle":
            sym, _, tf = rest.partition(":")
            return (sym, tf) in self.charts
        return True  # status, account, risk, positions, orders go to everyone


class StreamHub:
    def __init__(self, bridge: MT5Bridge, interval_s: float, risk: RiskService | None = None) -> None:
        self._bridge = bridge
        self._risk = risk
        self._interval = interval_s
        self._clients: set[StreamClient] = set()
        self._wake = asyncio.Event()
        self._bad_symbols: set[str] = set()
        self._part_errors: dict[str, str] = {}  # last error logged per snapshot part

    # -- client management ---------------------------------------------------

    def add(self, ws: WebSocket) -> StreamClient:
        client = StreamClient(ws)
        self._clients.add(client)
        self._wake.set()
        return client

    def remove(self, client: StreamClient) -> None:
        self._clients.discard(client)

    async def handle(self, client: StreamClient, raw: Any) -> None:
        try:
            msg = _client_message.validate_python(raw)
        except ValidationError as exc:
            await self._send(client, schemas.StreamError(message=f"Bad message: {exc.errors()[0]['msg']}").model_dump())
            return
        if isinstance(msg, schemas.SubscribeMessage):
            client.symbols = {s for s in msg.symbols if s}
        elif isinstance(msg, schemas.ChartsMessage):
            client.charts = {(c.symbol, c.timeframe) for c in msg.charts}
        else:
            client.charts = {(msg.symbol, msg.timeframe)} if msg.symbol else set()
        # Forget what this client was sent for its new keys so it gets a fresh snapshot.
        client.sent = {k: v for k, v in client.sent.items() if not k.startswith(("tick:", "candle:"))}
        self._bad_symbols.clear()
        self._wake.set()

    # -- polling loop --------------------------------------------------------

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # keep streaming whatever happens
                log.exception("stream tick failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=self._interval)
            self._wake.clear()

    async def tick(self) -> None:
        if not self._clients:
            return
        symbols = set().union(*(c.symbols for c in self._clients)) - self._bad_symbols
        charts = {ch for c in self._clients for ch in c.charts if ch[0] not in self._bad_symbols}
        snapshot, errors = await run_in_threadpool(self._snapshot, symbols, charts)
        self._bad_symbols |= set(errors)
        await asyncio.gather(*(self._fan_out(c, snapshot, errors) for c in list(self._clients)))

    def _snapshot(self, symbols: set[str], charts: set[tuple[str, str]]) -> tuple[Snapshot, dict[str, str]]:
        """Runs in a worker thread: gather the current state from MT5.

        Each part is read on its own, so one failing call (a symbol without prices,
        an odd reply) doesn't stop the rest of the stream. A lost terminal ends the
        snapshot early; the next status message reports it.
        """
        b = self._bridge
        snap: Snapshot = {}
        errors: dict[str, str] = {}
        status = b.status()
        snap["status"] = (status, schemas.StreamStatus(status=status).model_dump())
        if not status.connected:
            return snap, errors
        try:
            account = self._read("account", b.account_info)
            if account is not None:
                snap["account"] = (account, schemas.StreamAccount(account=account).model_dump())
                risk = self._risk.status(account.equity) if self._risk else None
                if risk is not None:
                    snap["risk"] = (risk, schemas.StreamRisk(risk=risk.model_dump()).model_dump())
            positions = self._read("positions", b.positions)
            if positions is not None:
                snap["positions"] = (positions, schemas.StreamPositions(positions=positions).model_dump())
            orders = self._read("orders", b.orders)
            if orders is not None:
                snap["orders"] = (orders, schemas.StreamOrders(orders=orders).model_dump())
            for sym in sorted(symbols):
                try:
                    t = self._read(f"tick:{sym}", lambda: b.tick(sym))  # noqa: B023 - called immediately
                except SymbolNotFound as exc:
                    errors[sym] = str(exc)
                    continue
                if t is not None:
                    snap[f"tick:{sym}"] = ((t.bid, t.ask), schemas.StreamTick(tick=t).model_dump())
            for sym, tf in sorted(charts):
                try:
                    candles = self._read(f"candle:{sym}:{tf}", lambda: b.candles(sym, tf, 2))  # noqa: B023
                except SymbolNotFound as exc:
                    errors[sym] = str(exc)
                    continue
                if candles is not None:
                    msg = schemas.StreamCandles(symbol=sym, timeframe=tf, candles=candles).model_dump()  # type: ignore[arg-type]
                    snap[f"candle:{sym}:{tf}"] = (candles, msg)
        except MT5Unavailable:
            pass  # status message already reflects it on the next tick
        return snap, errors

    def _read(self, part: str, fetch: Callable[[], T]) -> T | None:
        """One part of the snapshot. MT5 errors are logged (once per new message) and skipped;
        SymbolNotFound and MT5Unavailable propagate."""
        try:
            value = fetch()
        except (SymbolNotFound, MT5Unavailable):
            raise
        except MT5Error as exc:
            if self._part_errors.get(part) != str(exc):
                log.warning("stream: can't read %s: %s", part, exc)
            self._part_errors[part] = str(exc)
            return None
        self._part_errors.pop(part, None)
        return value

    async def _fan_out(self, client: StreamClient, snap: Snapshot, errors: dict[str, str]) -> None:
        for sym, message in errors.items():
            charted = {ch for ch in client.charts if ch[0] == sym}
            if sym in client.symbols or charted:
                client.symbols.discard(sym)
                client.charts -= charted
                if not await self._send(client, schemas.StreamError(message=message, symbol=sym).model_dump()):
                    return
        for key, (value, message) in snap.items():
            if client.wants(key) and client.sent.get(key) != value:
                if not await self._send(client, message):
                    return
                client.sent[key] = value

    async def _send(self, client: StreamClient, message: dict[str, Any]) -> bool:
        try:
            await asyncio.wait_for(client.ws.send_json(message), timeout=SEND_TIMEOUT_S)
            return True
        except Exception:  # closed or stuck socket: drop the client
            self.remove(client)
            with contextlib.suppress(Exception):
                await client.ws.close()
            return False
