"""The only module that talks to MetaTrader 5.

Responsibilities:
- connection lifecycle (initialize, login, reconnect with exponential backoff, shutdown)
- market data (symbols, ticks, rates), account, positions, orders and deals
- `order_send` and thin helpers built on it
- translating MT5 `last_error()` codes and trade `retcode`s into readable messages

The MetaTrader5 package is not thread-safe, so every call is serialised behind a
single lock. Methods are synchronous; async callers use a thread pool.

Credentials are only ever passed to `initialize`/`login` and never logged.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from types import ModuleType
from typing import Any

from backend import schemas
from backend.config import Settings

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class MT5Error(Exception):
    """An MT5 call failed. `str(err)` is safe to show to the user."""


class MT5Unavailable(MT5Error):
    """The terminal is not reachable or not connected to the trade server."""


class SymbolNotFound(MT5Error):
    pass


class TradeRejected(MT5Error):
    def __init__(self, message: str, retcode: int) -> None:
        super().__init__(message)
        self.retcode = retcode


class OrderOutcomeUnknown(MT5Error):
    """order_send gave no clear answer: the request may or may not have been executed.

    Never retried automatically: retrying could place the order twice.
    """

    def __init__(self, message: str, retcode: int | None = None, terminal_lost: bool = False) -> None:
        super().__init__(message)
        self.retcode = retcode
        self.terminal_lost = terminal_lost


RETCODE_DONE = 10009
RETCODE_PLACED = 10008
RETCODE_DONE_PARTIAL = 10010
_SUCCESS_RETCODES = {RETCODE_PLACED, RETCODE_DONE, RETCODE_DONE_PARTIAL}
# The trade server answered, but not whether it executed the request.
_UNKNOWN_RETCODES = {10011, 10012}
UNKNOWN_OUTCOME = (
    "No clear answer from MT5: the request may or may not have been executed. "
    "Check Positions and Orders before trying again."
)

RETCODE_MESSAGES: dict[int, str] = {
    10004: "Requote: the price changed. Check the new price and try again.",
    10006: "Request rejected by the trade server.",
    10007: "Request cancelled.",
    10008: "Order placed.",
    10009: "Request completed.",
    10010: "Only part of the request was completed.",
    10011: "The trade server failed to process the request.",
    10012: "Request timed out.",
    10013: "Invalid request.",
    10014: "Invalid volume. Check the symbol's minimum, maximum and step.",
    10015: "Invalid price for this order type.",
    10016: "Invalid stops: SL/TP is on the wrong side of the price or too close to it.",
    10017: "Trading is disabled for this symbol or account.",
    10018: "Market is closed.",
    10019: "Not enough free margin.",
    10020: "Prices changed. Try again.",
    10021: "No quotes available to process the request.",
    10022: "Invalid order expiration.",
    10023: "Order state changed. Refresh and try again.",
    10024: "Too many requests. Slow down.",
    10025: "No changes: the request matches the current values.",
    10026: "Automated trading is disabled by the server.",
    10027: "Algo Trading is disabled in the MT5 terminal. Enable the 'Algo Trading' toolbar button.",
    10028: "Request locked for processing.",
    10029: "Order or position is frozen (too close to the market price).",
    10030: "Unsupported order filling type for this symbol.",
    10031: "No connection to the trade server.",
    10032: "Operation allowed only on live accounts.",
    10033: "Pending order limit reached.",
    10034: "Volume limit for this symbol reached.",
    10035: "Invalid or prohibited order type.",
    10036: "Position is already closed.",
    10038: "Close volume exceeds the position volume.",
    10039: "A close order for this position already exists.",
    10040: "Maximum number of open positions reached.",
    10041: "Pending order activation was rejected.",
    10042: "Only long positions are allowed for this symbol.",
    10043: "Only short positions are allowed for this symbol.",
    10044: "Only closing positions is allowed for this symbol.",
    10045: "Positions must be closed in FIFO order.",
}

LAST_ERROR_MESSAGES: dict[int, str] = {
    -1: "MT5 call failed.",
    -2: "Invalid parameters.",
    -3: "MT5 terminal is out of memory.",
    -4: "Not found.",
    -5: "Unsupported MT5 terminal version.",
    -6: "Authorization failed: check MT5_LOGIN, MT5_PASSWORD and MT5_SERVER.",
    -7: "Unsupported method.",
    -8: "Algo Trading is disabled in the MT5 terminal.",
    -10000: "Internal MT5 terminal error.",
    -10001: "Lost connection to the MT5 terminal (send failed).",
    -10002: "Lost connection to the MT5 terminal (receive failed).",
    -10003: "Could not start or find the MT5 terminal. Is MetaTrader 5 installed and running?",
    -10004: "Not connected to the MT5 terminal.",
    -10005: "MT5 terminal timed out.",
}
# Codes meaning the IPC link to the terminal is gone: we must re-initialise.
_IPC_ERRORS = {-10000, -10001, -10002, -10003, -10004, -10005}
RES_S_OK = 1
# List calls that some terminal builds answer with None + (1, "Success") when the list is
# empty, and the count call that tells an empty list apart from a failure.
_LIST_TOTALS = {"positions_get": "positions_total", "orders_get": "orders_total", "history_deals_get": "history_deals_total"}


def describe_retcode(retcode: int, comment: str = "") -> str:
    msg = RETCODE_MESSAGES.get(retcode, f"Trade request failed (retcode {retcode}).")
    return f"{msg} [{comment}]" if comment and retcode not in _SUCCESS_RETCODES else msg


def describe_last_error(code: int, message: str = "") -> str:
    return LAST_ERROR_MESSAGES.get(code) or message or f"MT5 error {code}."


# ---------------------------------------------------------------------------
# Mappings
# ---------------------------------------------------------------------------

TIMEFRAMES: dict[str, str] = {
    "M1": "TIMEFRAME_M1",
    "M5": "TIMEFRAME_M5",
    "M15": "TIMEFRAME_M15",
    "H1": "TIMEFRAME_H1",
    "H4": "TIMEFRAME_H4",
    "D1": "TIMEFRAME_D1",
}
TIMEFRAME_SECONDS: dict[str, int] = {
    "M1": 60, "M5": 300, "M15": 900, "H1": 3600, "H4": 14_400, "D1": 86_400,
}

_PENDING_TYPES = {"buy_limit": 2, "sell_limit": 3, "buy_stop": 4, "sell_stop": 5}
_PENDING_NAMES = {v: k for k, v in _PENDING_TYPES.items()}
_DEAL_REASONS = {0: "client", 1: "mobile", 2: "web", 3: "expert", 4: "sl", 5: "tp", 6: "stop_out"}
# symbol_info().filling_mode bit flags
_SYMBOL_FILLING_FOK = 1
_SYMBOL_FILLING_IOC = 2


def load_mt5_module(mock: bool) -> ModuleType:
    if mock:
        from backend import mt5_mock

        return mt5_mock
    try:
        import MetaTrader5  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - Windows only
        raise RuntimeError(
            "The MetaTrader5 package is not installed. On Windows run "
            "`pip install MetaTrader5`, or set MT5_MOCK=1."
        ) from exc
    return MetaTrader5


def _opt(value: float) -> float | None:
    return value or None


class Backoff:
    """Exponential reconnect delay: 1s, 2s, 4s ... capped at `maximum`."""

    def __init__(self, initial: float = 1.0, maximum: float = 60.0) -> None:
        self.initial = initial
        self.maximum = maximum
        self.delay = initial
        self.next_attempt = 0.0

    def ready(self, now: float) -> bool:
        return now >= self.next_attempt

    def remaining(self, now: float) -> float:
        return max(0.0, self.next_attempt - now)

    def failure(self, now: float) -> float:
        wait = self.delay
        self.next_attempt = now + wait
        self.delay = min(self.delay * 2, self.maximum)
        return wait

    def success(self) -> None:
        self.delay = self.initial
        self.next_attempt = 0.0


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------


class MT5Bridge:
    def __init__(
        self,
        settings: Settings,
        mt5: ModuleType | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._mt5 = mt5 or load_mt5_module(settings.mt5_mock)
        self._clock = clock
        self._lock = threading.RLock()
        self._connected = False
        self._last_error: str | None = "Not connected yet."
        self._backoff = Backoff()

    # -- lifecycle ----------------------------------------------------------

    @property
    def mock(self) -> bool:
        return self._settings.mt5_mock

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self) -> bool:
        """Make one connection attempt. Returns True on success."""
        s = self._settings
        mt5 = self._mt5
        with self._lock:
            if self.mock:
                mt5._mock_configure(server_tz=s.mock_server_tz, initial_balance=s.mock_initial_balance)
            kwargs: dict[str, Any] = {"timeout": s.mt5_timeout_ms}
            if s.mt5_path:
                kwargs["path"] = s.mt5_path
            if s.mt5_login and s.mt5_password and s.mt5_server:
                kwargs.update(
                    login=s.mt5_login,
                    password=s.mt5_password.get_secret_value(),
                    server=s.mt5_server,
                )
            if not mt5.initialize(**kwargs):
                return self._connect_failed(describe_last_error(*mt5.last_error()))

            if "login" in kwargs and not mt5.login(
                kwargs["login"], password=kwargs["password"], server=kwargs["server"], timeout=s.mt5_timeout_ms
            ):
                err = describe_last_error(*mt5.last_error())
                mt5.shutdown()
                return self._connect_failed(err)

            info = mt5.terminal_info()
            if info is None or not info.connected:
                return self._connect_failed("MT5 terminal is running but not connected to the trade server.")

            self._connected = True
            self._last_error = None
            self._backoff.success()
            log.info("Connected to MT5 terminal%s", " (mock)" if self.mock else "")
            return True

    def _connect_failed(self, message: str) -> bool:
        self._connected = False
        self._last_error = message
        wait = self._backoff.failure(self._clock())
        log.warning("MT5 connection failed: %s Retrying in %.0fs.", message, wait)
        return False

    def _mark_disconnected(self, message: str) -> None:
        if self._connected:
            log.warning("MT5 disconnected: %s", message)
        self._connected = False
        self._last_error = message
        # Retry immediately once, then back off.
        self._backoff.next_attempt = 0.0

    def shutdown(self) -> None:
        with self._lock:
            try:
                self._mt5.shutdown()
            finally:
                self._connected = False
                self._last_error = "Shut down."

    def health_check(self) -> bool:
        """Called periodically: detect a dropped terminal and reconnect with backoff."""
        with self._lock:
            if not self._connected:
                if self._backoff.ready(self._clock()):
                    return self.connect()
                return False
            info = self._mt5.terminal_info()
            if info is None:
                self._mark_disconnected(describe_last_error(*self._mt5.last_error()))
            elif not info.connected:
                self._mark_disconnected("MT5 terminal lost its connection to the trade server.")
            return self._connected

    def status(self) -> schemas.HealthResponse:
        with self._lock:
            retry = None if self._connected else round(self._backoff.remaining(self._clock()), 1)
            return schemas.HealthResponse(
                connected=self._connected, mock=self.mock, message=self._last_error, retry_in_seconds=retry
            )

    # -- low-level call wrapper --------------------------------------------

    def _ensure_connected(self) -> None:
        if not self._connected and not (self._backoff.ready(self._clock()) and self.connect()):
            raise MT5Unavailable(self._last_error or "Not connected to the MT5 terminal.")

    def _call(self, name: str, *args: Any, not_found: str | None = None, **kwargs: Any) -> Any:
        with self._lock:
            self._ensure_connected()
            result = getattr(self._mt5, name)(*args, **kwargs)
            if result is None:
                code, message = self._mt5.last_error()
                if code in _IPC_ERRORS:
                    self._mark_disconnected(describe_last_error(code, message))
                    raise MT5Unavailable(self._last_error or "")
                if code == RES_S_OK and name in _LIST_TOTALS:
                    return self._empty_list(name, args, kwargs)
                if not_found:
                    raise SymbolNotFound(not_found)
                raise MT5Error(f"{name} failed: {describe_last_error(code, message)}")
            return result

    def _empty_list(self, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> tuple[()]:
        """None with a success code: an empty list, but only once the matching count agrees.

        A filtered lookup (by ticket or symbol) that finds nothing is simply empty. An
        unfiltered one is double-checked, so a failed read can never look like "no
        positions" to the risk engine.
        """
        if kwargs:
            return ()
        total = getattr(self._mt5, _LIST_TOTALS[name])(*args)
        if total == 0:
            return ()
        raise MT5Error(f"{name} returned nothing but the terminal reports {total} item(s).")

    # -- market data --------------------------------------------------------

    def _raw_symbol(self, symbol: str) -> Any:
        info = self._call("symbol_info", symbol, not_found=f"Unknown symbol: {symbol}")
        if not info.visible:
            # Ticks and rates only flow for symbols shown in Market Watch.
            self._call("symbol_select", symbol, True)
        return info

    @staticmethod
    def _symbol_model(info: Any) -> schemas.SymbolInfo:
        return schemas.SymbolInfo(
            name=info.name,
            description=info.description,
            digits=info.digits,
            point=info.point,
            contract_size=info.trade_contract_size,
            tick_size=info.trade_tick_size,
            tick_value=info.trade_tick_value,
            volume_min=info.volume_min,
            volume_max=info.volume_max,
            volume_step=info.volume_step,
            stops_level=info.trade_stops_level,
            spread=info.spread,
            currency_base=info.currency_base,
            currency_profit=info.currency_profit,
            trade_allowed=info.trade_mode != 0,
        )

    def symbols(self) -> list[schemas.SymbolInfo]:
        return [self._symbol_model(s) for s in self._call("symbols_get")]

    def symbol_info(self, symbol: str) -> schemas.SymbolInfo:
        return self._symbol_model(self._raw_symbol(symbol))

    def tick(self, symbol: str) -> schemas.Tick:
        with self._lock:
            self._raw_symbol(symbol)
            t = self._call("symbol_info_tick", symbol, not_found=f"No prices for {symbol}")
        return schemas.Tick(symbol=symbol, time=int(t.time), time_msc=int(t.time_msc), bid=t.bid, ask=t.ask)

    def server_time(self, symbol: str) -> int:
        """MT5 has no server-clock call; the latest tick time of a liquid symbol is the standard proxy."""
        return self.tick(symbol).time

    def candles(self, symbol: str, timeframe: str, count: int, before: int | None = None) -> list[schemas.Candle]:
        """Most recent `count` bars (including the forming one), or bars strictly older than `before`."""
        with self._lock:
            self._raw_symbol(symbol)
            tf = getattr(self._mt5, TIMEFRAMES[timeframe])
            if before is None:
                rates = self._call("copy_rates_from_pos", symbol, tf, 0, count)
            else:
                rates = self._call("copy_rates_from", symbol, tf, before - 1, count)
        return [
            schemas.Candle(
                time=int(r["time"]),
                open=float(r["open"]),
                high=float(r["high"]),
                low=float(r["low"]),
                close=float(r["close"]),
                volume=int(r["tick_volume"]),
            )
            for r in rates
            if before is None or int(r["time"]) < before
        ]

    # -- account & trading state -------------------------------------------

    def account_info(self) -> schemas.AccountInfo:
        a = self._call("account_info")
        return schemas.AccountInfo(
            currency=a.currency,
            balance=a.balance,
            equity=a.equity,
            margin=a.margin,
            margin_free=a.margin_free,
            margin_level=a.margin_level or None,
            profit=a.profit,
            leverage=a.leverage,
            trade_allowed=bool(a.trade_allowed),
            mock=self.mock,
            account_mode={0: "demo", 1: "contest"}.get(a.trade_mode, "real"),
        )

    def account_identity(self) -> tuple[int, str]:
        """Login and server of the account the terminal is on. Server-side only: never sent to the browser."""
        a = self._call("account_info")
        return int(a.login), str(a.server)

    def positions(self, symbol: str | None = None) -> list[schemas.Position]:
        raw = self._call("positions_get", symbol=symbol) if symbol else self._call("positions_get")
        return [
            schemas.Position(
                ticket=p.ticket,
                symbol=p.symbol,
                side="buy" if p.type == 0 else "sell",
                volume=p.volume,
                price_open=p.price_open,
                price_current=p.price_current,
                sl=_opt(p.sl),
                tp=_opt(p.tp),
                profit=p.profit,
                swap=p.swap,
                time=int(p.time),
                comment=p.comment,
            )
            for p in raw
        ]

    def orders(self, symbol: str | None = None) -> list[schemas.PendingOrder]:
        raw = self._call("orders_get", symbol=symbol) if symbol else self._call("orders_get")
        return [
            schemas.PendingOrder(
                ticket=o.ticket,
                symbol=o.symbol,
                type=_PENDING_NAMES[o.type],
                volume=o.volume_current,
                price_open=o.price_open,
                price_current=o.price_current,
                sl=_opt(o.sl),
                tp=_opt(o.tp),
                time_setup=int(o.time_setup),
                comment=o.comment,
            )
            for o in raw
            if o.type in _PENDING_NAMES
        ]

    def deals(self, date_from: int, date_to: int) -> list[schemas.Deal]:
        raw = self._call("history_deals_get", date_from, date_to)
        return [
            schemas.Deal(
                ticket=d.ticket,
                order=d.order,
                position_id=d.position_id,
                symbol=d.symbol,
                side={0: "buy", 1: "sell"}.get(d.type),
                entry={0: "in", 1: "out"}.get(d.entry, "other"),
                volume=d.volume,
                price=d.price,
                profit=d.profit,
                commission=d.commission,
                swap=d.swap,
                time=int(d.time),
                reason=_DEAL_REASONS.get(d.reason, str(d.reason)),
                comment=d.comment,
            )
            for d in raw
        ]

    def calc_profit(self, side: schemas.Side, symbol: str, volume: float, price_open: float, price_close: float) -> float:
        """P/L in account currency for moving `volume` lots from price_open to price_close."""
        action = 0 if side == "buy" else 1
        return float(self._call("order_calc_profit", action, symbol, volume, price_open, price_close))

    def calc_margin(self, side: schemas.Side, symbol: str, volume: float, price: float) -> float:
        action = 0 if side == "buy" else 1
        return float(self._call("order_calc_margin", action, symbol, volume, price))

    # -- trading ------------------------------------------------------------

    def order_send(self, request: dict[str, Any]) -> schemas.TradeResult:
        """Send a raw trade request, exactly once.

        Raises TradeRejected when the server refused it, MT5Unavailable when nothing was
        sent, and OrderOutcomeUnknown when it was sent but the answer is unclear.
        """
        log.info("order_send %s", request)  # trade requests never contain credentials
        with self._lock:
            self._ensure_connected()  # raises before anything is sent
            try:
                r = self._mt5.order_send(request)
            except Exception as exc:
                log.exception("order_send raised")
                raise OrderOutcomeUnknown(f"{UNKNOWN_OUTCOME} ({exc})") from exc
            if r is None:
                code, err = self._mt5.last_error()
                lost = code in _IPC_ERRORS
                if lost:
                    self._mark_disconnected(describe_last_error(code, err))
                log.warning("order_send returned nothing: %s %s", code, err)
                raise OrderOutcomeUnknown(f"{UNKNOWN_OUTCOME} ({describe_last_error(code, err)})", terminal_lost=lost)
        message = describe_retcode(r.retcode, r.comment)
        if r.retcode in _UNKNOWN_RETCODES:
            log.warning("order_send unclear: retcode=%s %s", r.retcode, message)
            raise OrderOutcomeUnknown(f"{UNKNOWN_OUTCOME} ({message})", retcode=r.retcode)
        if r.retcode not in _SUCCESS_RETCODES:
            log.info("order_send rejected: retcode=%s %s", r.retcode, message)
            raise TradeRejected(message, r.retcode)
        return schemas.TradeResult(
            retcode=r.retcode, message=message, order=r.order, deal=r.deal, volume=r.volume, price=r.price
        )

    def _filling(self, info: Any) -> int:
        if info.filling_mode & _SYMBOL_FILLING_FOK:
            return self._mt5.ORDER_FILLING_FOK
        if info.filling_mode & _SYMBOL_FILLING_IOC:
            return self._mt5.ORDER_FILLING_IOC
        return self._mt5.ORDER_FILLING_RETURN

    def market_order(
        self,
        symbol: str,
        side: schemas.Side,
        volume: float,
        sl: float | None = None,
        tp: float | None = None,
        deviation: int = 20,
        comment: str = "",
        price: float | None = None,
    ) -> schemas.TradeResult:
        """`price` is the quote the trader confirmed; if the market has moved more than
        `deviation` points from it, the server answers with a requote instead of filling."""
        mt5 = self._mt5
        with self._lock:
            info = self._raw_symbol(symbol)
            tick = self._call("symbol_info_tick", symbol, not_found=f"No prices for {symbol}")
            return self.order_send({
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": float(volume),
                "type": mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
                "price": float(price) if price else (tick.ask if side == "buy" else tick.bid),
                "sl": float(sl or 0.0),
                "tp": float(tp or 0.0),
                "deviation": deviation,
                "magic": 0,
                "comment": comment[:31],
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": self._filling(info),
            })

    def pending_order(
        self,
        symbol: str,
        order_type: schemas.PendingType,
        volume: float,
        price: float,
        sl: float | None = None,
        tp: float | None = None,
        comment: str = "",
    ) -> schemas.TradeResult:
        mt5 = self._mt5
        with self._lock:
            self._raw_symbol(symbol)
            return self.order_send({
                "action": mt5.TRADE_ACTION_PENDING,
                "symbol": symbol,
                "volume": float(volume),
                "type": _PENDING_TYPES[order_type],
                "price": float(price),
                "sl": float(sl or 0.0),
                "tp": float(tp or 0.0),
                "magic": 0,
                "comment": comment[:31],
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_RETURN,
            })

    def _position(self, ticket: int) -> Any:
        found = self._call("positions_get", ticket=ticket)
        if not found:
            raise TradeRejected(RETCODE_MESSAGES[10036], 10036)
        return found[0]

    def modify_position(self, ticket: int, sl: float | None, tp: float | None) -> schemas.TradeResult:
        with self._lock:
            p = self._position(ticket)
            return self.order_send({
                "action": self._mt5.TRADE_ACTION_SLTP,
                "symbol": p.symbol,
                "position": ticket,
                "sl": float(sl or 0.0),
                "tp": float(tp or 0.0),
            })

    def close_position(self, ticket: int, volume: float | None = None, deviation: int = 20) -> schemas.TradeResult:
        """Close a position fully, or partially when `volume` is given."""
        mt5 = self._mt5
        with self._lock:
            p = self._position(ticket)
            info = self._raw_symbol(p.symbol)
            tick = self._call("symbol_info_tick", p.symbol, not_found=f"No prices for {p.symbol}")
            is_buy = p.type == 0
            return self.order_send({
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": p.symbol,
                "position": ticket,
                "volume": float(volume or p.volume),
                "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
                "price": tick.bid if is_buy else tick.ask,
                "deviation": deviation,
                "magic": 0,
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": self._filling(info),
            })

    def modify_order(self, ticket: int, price: float, sl: float | None, tp: float | None) -> schemas.TradeResult:
        with self._lock:
            found = self._call("orders_get", ticket=ticket)
            if not found:
                raise TradeRejected(RETCODE_MESSAGES[10035], 10035)
            o = found[0]
            return self.order_send({
                "action": self._mt5.TRADE_ACTION_MODIFY,
                "symbol": o.symbol,
                "order": ticket,
                "price": float(price),
                "sl": float(sl or 0.0),
                "tp": float(tp or 0.0),
                "type_time": self._mt5.ORDER_TIME_GTC,
            })

    def cancel_order(self, ticket: int) -> schemas.TradeResult:
        return self.order_send({"action": self._mt5.TRADE_ACTION_REMOVE, "order": ticket})
