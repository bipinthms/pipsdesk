"""Simulated stand-in for the official `MetaTrader5` package (enabled by MT5_MOCK=1).

It mirrors the subset of the real module's API that `mt5_bridge` uses (same
function names, constants, return shapes and retcodes), so the bridge runs the
exact same code path in mock and live mode.

Prices come from a deterministic fractal "value noise" function of time. That
makes every timeframe and any history range mutually consistent and available
instantly, with no stored data. Trading is simulated against the same prices:
market fills, pending-order triggers, SL/TP hits, margin and P/L.

Not simulated: swaps, commissions, stop-out, weekend gaps, slippage beyond the
current bid/ask.
"""

from __future__ import annotations

import math
import threading
import time
from collections import namedtuple
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# Constants (values match the real MetaTrader5 package)
# ---------------------------------------------------------------------------
TIMEFRAME_M1 = 1
TIMEFRAME_M5 = 5
TIMEFRAME_M15 = 15
TIMEFRAME_H1 = 16385
TIMEFRAME_H4 = 16388
TIMEFRAME_D1 = 16408

_TIMEFRAME_SECONDS = {
    TIMEFRAME_M1: 60,
    TIMEFRAME_M5: 300,
    TIMEFRAME_M15: 900,
    TIMEFRAME_H1: 3600,
    TIMEFRAME_H4: 14400,
    TIMEFRAME_D1: 86400,
}

ORDER_TYPE_BUY = 0
ORDER_TYPE_SELL = 1
ORDER_TYPE_BUY_LIMIT = 2
ORDER_TYPE_SELL_LIMIT = 3
ORDER_TYPE_BUY_STOP = 4
ORDER_TYPE_SELL_STOP = 5

POSITION_TYPE_BUY = 0
POSITION_TYPE_SELL = 1

TRADE_ACTION_DEAL = 1
TRADE_ACTION_PENDING = 5
TRADE_ACTION_SLTP = 6
TRADE_ACTION_MODIFY = 7
TRADE_ACTION_REMOVE = 8

ORDER_TIME_GTC = 0
ORDER_FILLING_FOK = 0
ORDER_FILLING_IOC = 1
ORDER_FILLING_RETURN = 2

SYMBOL_FILLING_FOK = 1
SYMBOL_FILLING_IOC = 2

SYMBOL_TRADE_MODE_DISABLED = 0
SYMBOL_TRADE_MODE_FULL = 4

ORDER_STATE_PLACED = 1

DEAL_TYPE_BUY = 0
DEAL_TYPE_SELL = 1
DEAL_TYPE_BALANCE = 2

DEAL_ENTRY_IN = 0
DEAL_ENTRY_OUT = 1

DEAL_REASON_CLIENT = 0
DEAL_REASON_SL = 4
DEAL_REASON_TP = 5

TRADE_RETCODE_REQUOTE = 10004
TRADE_RETCODE_REJECT = 10006
TRADE_RETCODE_DONE = 10009
TRADE_RETCODE_INVALID = 10013
TRADE_RETCODE_INVALID_VOLUME = 10014
TRADE_RETCODE_INVALID_PRICE = 10015
TRADE_RETCODE_INVALID_STOPS = 10016
TRADE_RETCODE_TRADE_DISABLED = 10017
TRADE_RETCODE_MARKET_CLOSED = 10018
TRADE_RETCODE_NO_MONEY = 10019
TRADE_RETCODE_NO_CHANGES = 10025
TRADE_RETCODE_INVALID_ORDER = 10035
TRADE_RETCODE_POSITION_CLOSED = 10036
TRADE_RETCODE_INVALID_CLOSE_VOLUME = 10038

RES_S_OK = 1
RES_E_INVALID_PARAMS = -2
RES_E_NOT_FOUND = -4
RES_E_INTERNAL_FAIL_INIT = -10003
RES_E_NO_IPC = -10004

# ---------------------------------------------------------------------------
# Return types (field names match the real package's named tuples)
# ---------------------------------------------------------------------------
TerminalInfo = namedtuple(
    "TerminalInfo", "connected trade_allowed tradeapi_disabled build name company path"
)
AccountInfo = namedtuple(
    "AccountInfo",
    "login trade_mode leverage limit_orders margin_so_mode trade_allowed trade_expert "
    "margin_mode currency_digits fifo_close balance credit profit equity margin margin_free "
    "margin_level margin_so_call margin_so_so name server currency company",
)
SymbolInfo = namedtuple(
    "SymbolInfo",
    "name description path digits point spread trade_contract_size trade_tick_size "
    "trade_tick_value volume_min volume_max volume_step trade_stops_level trade_freeze_level "
    "trade_mode filling_mode currency_base currency_profit currency_margin bid ask visible select",
)
Tick = namedtuple("Tick", "time bid ask last volume time_msc flags volume_real")
TradePosition = namedtuple(
    "TradePosition",
    "ticket time time_msc time_update time_update_msc type magic identifier reason volume "
    "price_open sl tp price_current swap profit symbol comment external_id",
)
TradeOrder = namedtuple(
    "TradeOrder",
    "ticket time_setup time_setup_msc time_done time_done_msc time_expiration type type_time "
    "type_filling state magic position_id position_by_id reason volume_initial volume_current "
    "price_open sl tp price_current price_stoplimit symbol comment external_id",
)
TradeDeal = namedtuple(
    "TradeDeal",
    "ticket order time time_msc type entry magic position_id reason volume price commission "
    "swap profit fee symbol comment external_id",
)
OrderSendResult = namedtuple(
    "OrderSendResult",
    "retcode deal order volume price bid ask comment request_id retcode_external request",
)

# ---------------------------------------------------------------------------
# Instruments
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Spec:
    name: str
    description: str
    digits: int
    contract_size: float
    base_price: float
    daily_vol: float  # rough relative daily volatility
    spread_points: int
    currency_base: str
    currency_profit: str
    leverage: float
    stops_level: int = 0
    volume_min: float = 0.01
    volume_max: float = 50.0
    volume_step: float = 0.01
    ticks_per_sec: float = 2.0

    @property
    def point(self) -> float:
        return 10.0**-self.digits

    @property
    def seed(self) -> int:
        h = 1469598103934665603
        for ch in self.name.encode():
            h = ((h ^ ch) * 1099511628211) & _M64
        return h


_SPECS: dict[str, _Spec] = {
    s.name: s
    for s in (
        _Spec("EURUSD", "Euro vs US Dollar", 5, 100_000, 1.0850, 0.005, 8, "EUR", "USD", 100),
        _Spec("GBPUSD", "Pound Sterling vs US Dollar", 5, 100_000, 1.2700, 0.006, 10, "GBP", "USD", 100),
        _Spec("USDJPY", "US Dollar vs Japanese Yen", 3, 100_000, 150.00, 0.006, 12, "USD", "JPY", 100),
        _Spec("XAUUSD", "Gold vs US Dollar", 2, 100, 2400.0, 0.010, 25, "XAU", "USD", 30, stops_level=10),
        _Spec("US30", "Dow Jones 30 Index", 2, 1, 42_000.0, 0.009, 200, "USD", "USD", 20, volume_min=0.1, volume_step=0.1),
        _Spec("NAS100", "Nasdaq 100 Index", 2, 1, 19_500.0, 0.012, 150, "USD", "USD", 20, volume_min=0.1, volume_step=0.1),
        _Spec("BTCUSD", "Bitcoin vs US Dollar", 2, 1, 65_000.0, 0.030, 3000, "BTC", "USD", 2, volume_max=5.0),
    )
}

# ---------------------------------------------------------------------------
# Deterministic price path
# ---------------------------------------------------------------------------
_M64 = (1 << 64) - 1
# Noise octaves from 2 seconds to ~256 days. Each contributes Brownian-scaled amplitude.
_OCTAVES = (2, 5, 15, 60, 300, 900, 3600, 14_400, 86_400, 345_600, 1_382_400, 5_529_600, 22_118_400)
_SAMPLES_PER_BAR = 12


def _mix(x: int) -> int:
    x = (x + 0x9E3779B97F4A7C15) & _M64
    x = ((x ^ (x >> 30)) * 0xBF58476D1CE4E5B9) & _M64
    x = ((x ^ (x >> 27)) * 0x94D049BB133111EB) & _M64
    return x ^ (x >> 31)


def _noise(seed: int, octave: int, k: int) -> float:
    """Deterministic pseudo-random value in [-1, 1] for lattice point k of an octave."""
    return _mix(seed ^ _mix((octave << 48) ^ (k & _M64))) / _M64 * 2.0 - 1.0


@lru_cache(maxsize=250_000)
def _mid(symbol: str, t: float) -> float:
    spec = _SPECS[symbol]
    seed = spec.seed
    total = 0.0
    for i, period in enumerate(_OCTAVES):
        x = t / period
        k = math.floor(x)
        f = x - k
        f = f * f * (3.0 - 2.0 * f)
        a = _noise(seed, i, k)
        b = _noise(seed, i, k + 1)
        total += (a + (b - a) * f) * spec.daily_vol * math.sqrt(period / 86_400)
    return spec.base_price * math.exp(total)


def _bid(spec: _Spec, t: float) -> float:
    return round(_mid(spec.name, t), spec.digits)


def _bar(spec: _Spec, t_open: int, tf_sec: int, now: float) -> dict:
    t_end = min(t_open + tf_sec, now)
    span = max(t_end - t_open, 1e-6)
    n = max(2, math.ceil(_SAMPLES_PER_BAR * span / tf_sec))
    step = span / n
    pts = [_mid(spec.name, t_open + step * i) for i in range(n + 1)]
    # Widen wicks a little to stand in for movement between sample points.
    wick = spec.daily_vol * math.sqrt(step / 86_400) * 0.6
    j = t_open // tf_sec
    high = max(pts) * (1 + wick * abs(_noise(spec.seed, 90, j)))
    low = min(pts) * (1 - wick * abs(_noise(spec.seed, 91, j)))
    activity = 1.0 + 0.6 * _noise(spec.seed, 92, j)
    return {
        "time": int(t_open),
        "open": round(pts[0], spec.digits),
        "high": round(high, spec.digits),
        "low": round(low, spec.digits),
        "close": round(pts[-1], spec.digits),
        "tick_volume": max(1, int(span * spec.ticks_per_sec * activity)),
        "spread": spec.spread_points,
        "real_volume": 0,
    }


# ---------------------------------------------------------------------------
# Trading state
# ---------------------------------------------------------------------------


@dataclass
class _Position:
    ticket: int
    symbol: str
    type: int
    volume: float
    price_open: float
    sl: float
    tp: float
    time: int
    time_msc: int
    magic: int
    comment: str


@dataclass
class _Order:
    ticket: int
    symbol: str
    type: int
    volume: float
    price_open: float
    sl: float
    tp: float
    time_setup: int
    magic: int
    comment: str


class _State:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.initialized = False
        self.terminal_down = False
        self.last_error: tuple[int, str] = (RES_S_OK, "Success")
        self.server_tz = ZoneInfo("Europe/Athens")
        self.closed_symbols: set[str] = set()
        self.quirks: dict[str, bool] = {}
        self.reset(100_000.0)

    def reset(self, balance: float) -> None:
        self.initial_balance = balance
        self.balance = balance
        self.positions: dict[int, _Position] = {}
        self.orders: dict[int, _Order] = {}
        self.deals: list[TradeDeal] = []
        self.next_ticket = 1_000_000
        self.created = False

    def ticket(self) -> int:
        self.next_ticket += 1
        return self.next_ticket


_S = _State()
_clock = time.time


def _server_now() -> float:
    utc = _clock()
    offset = datetime.fromtimestamp(utc, _S.server_tz).utcoffset()
    return utc + (offset.total_seconds() if offset else 0.0)


# ---------------------------------------------------------------------------
# Test / configuration hooks (not part of the real package API)
# ---------------------------------------------------------------------------


def _mock_configure(*, server_tz: str | None = None, initial_balance: float | None = None) -> None:
    with _S.lock:
        if server_tz:
            _S.server_tz = ZoneInfo(server_tz)
        if initial_balance is not None and not _S.created:
            _S.reset(initial_balance)


def _mock_reset(initial_balance: float = 100_000.0) -> None:
    global _clock
    with _S.lock:
        _clock = time.time
        _S.initialized = False
        _S.terminal_down = False
        _S.closed_symbols.clear()
        _S.quirks = {}
        _S.last_error = (RES_S_OK, "Success")
        _S.reset(initial_balance)


def _mock_set_clock(fn) -> None:
    """Replace the wall clock (UTC epoch seconds) for deterministic tests."""
    global _clock
    _clock = fn


def _mock_set_terminal_down(down: bool) -> None:
    """Simulate the MT5 terminal being closed (True) or started again (False)."""
    with _S.lock:
        _S.terminal_down = down
        if down:
            _S.initialized = False


def _mock_set_market_closed(symbol: str, closed: bool) -> None:
    with _S.lock:
        (_S.closed_symbols.add if closed else _S.closed_symbols.discard)(symbol)


def _mock_set_quirks(*, empty_as_none: bool = False) -> None:
    """Behave like real terminal builds in ways the default mock doesn't.

    empty_as_none: positions_get / orders_get / history_deals_get return None with
    last_error() == (1, "Success") when there is nothing to return.
    """
    with _S.lock:
        _S.quirks = {"empty_as_none": empty_as_none}


def _empty(result: tuple):
    if not result and _S.quirks.get("empty_as_none"):
        _S.last_error = (RES_S_OK, "Success")
        return None
    return result


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------


def initialize(*_args, **_kwargs) -> bool:
    with _S.lock:
        if _S.terminal_down:
            _S.last_error = (RES_E_INTERNAL_FAIL_INIT, "IPC initialize failed, MetaTrader 5 x64 not found")
            return False
        _S.initialized = True
        if not _S.created:
            _S.created = True
            now = int(_server_now())
            _S.deals.append(
                TradeDeal(_S.ticket(), 0, now, now * 1000, DEAL_TYPE_BALANCE, DEAL_ENTRY_IN, 0, 0,
                          DEAL_REASON_CLIENT, 0.0, 0.0, 0.0, 0.0, _S.initial_balance, 0.0, "",
                          "Initial deposit", "")
            )
        _S.last_error = (RES_S_OK, "Success")
        return True


def login(*_args, **_kwargs) -> bool:
    return _ready() is not None


def shutdown() -> None:
    with _S.lock:
        _S.initialized = False


def last_error() -> tuple[int, str]:
    return _S.last_error


def _ready():
    """Return True when callable; otherwise set last_error and return None."""
    if not _S.initialized:
        _S.last_error = (RES_E_NO_IPC, "No IPC connection")
        return None
    _S.last_error = (RES_S_OK, "Success")
    return True


def terminal_info():
    with _S.lock:
        if _ready() is None:
            return None
        return TerminalInfo(True, True, False, 4000, "Mock MetaTrader 5", "Mock Broker", "")


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------


def _to_usd(amount: float, currency: str, now: float) -> float:
    if currency == "USD":
        return amount
    if currency == "JPY":
        return amount / _bid(_SPECS["USDJPY"], now)
    raise ValueError(f"no conversion for {currency}")


def _symbol_info(spec: _Spec, now: float):
    bid = _bid(spec, now)
    ask = round(bid + spec.spread_points * spec.point, spec.digits)
    tick_value = _to_usd(spec.point * spec.contract_size, spec.currency_profit, now)
    trade_mode = SYMBOL_TRADE_MODE_FULL
    return SymbolInfo(
        spec.name, spec.description, f"Mock\\{spec.name}", spec.digits, spec.point,
        spec.spread_points, spec.contract_size, spec.point, tick_value, spec.volume_min,
        spec.volume_max, spec.volume_step, spec.stops_level, 0, trade_mode,
        SYMBOL_FILLING_FOK | SYMBOL_FILLING_IOC, spec.currency_base, spec.currency_profit,
        spec.currency_base, bid, ask, True, True,
    )


def symbols_get(group: str | None = None):
    with _S.lock:
        if _ready() is None:
            return None
        now = _server_now()
        return tuple(_symbol_info(s, now) for s in _SPECS.values())


def symbols_total() -> int:
    return len(_SPECS)


def symbol_select(symbol: str, enable: bool = True) -> bool:
    return symbol in _SPECS


def symbol_info(symbol: str):
    with _S.lock:
        if _ready() is None:
            return None
        spec = _SPECS.get(symbol)
        if spec is None:
            _S.last_error = (RES_E_NOT_FOUND, "Symbol not found")
            return None
        return _symbol_info(spec, _server_now())


def symbol_info_tick(symbol: str):
    with _S.lock:
        if _ready() is None:
            return None
        spec = _SPECS.get(symbol)
        if spec is None:
            _S.last_error = (RES_E_NOT_FOUND, "Symbol not found")
            return None
        _process()
        now = _server_now()
        bid = _bid(spec, now)
        ask = round(bid + spec.spread_points * spec.point, spec.digits)
        return Tick(int(now), bid, ask, 0.0, 0, int(now * 1000), 6, 0.0)


def _rates(symbol: str, timeframe: int):
    if _ready() is None:
        return None, None, None
    spec = _SPECS.get(symbol)
    tf = _TIMEFRAME_SECONDS.get(timeframe)
    if spec is None or tf is None:
        _S.last_error = (RES_E_INVALID_PARAMS, "Invalid params")
        return None, None, None
    return spec, tf, _server_now()


def copy_rates_from_pos(symbol: str, timeframe: int, start_pos: int, count: int):
    """`count` bars ending `start_pos` bars before the current (forming) bar, oldest first."""
    with _S.lock:
        spec, tf, now = _rates(symbol, timeframe)
        if spec is None:
            return None
        current = int(now // tf) * tf
        newest = current - start_pos * tf
        return [_bar(spec, newest - i * tf, tf, now) for i in range(count - 1, -1, -1)]


def copy_rates_from(symbol: str, timeframe: int, date_from, count: int):
    """`count` bars whose open time is <= date_from, oldest first."""
    with _S.lock:
        spec, tf, now = _rates(symbol, timeframe)
        if spec is None:
            return None
        ts = date_from.timestamp() if isinstance(date_from, datetime) else float(date_from)
        newest = int(min(ts, now) // tf) * tf
        return [_bar(spec, newest - i * tf, tf, now) for i in range(count - 1, -1, -1)]


# ---------------------------------------------------------------------------
# Account
# ---------------------------------------------------------------------------


def _quote(spec: _Spec, now: float) -> tuple[float, float]:
    bid = _bid(spec, now)
    return bid, round(bid + spec.spread_points * spec.point, spec.digits)


def _profit(p: _Position, now: float) -> float:
    spec = _SPECS[p.symbol]
    bid, ask = _quote(spec, now)
    diff = (bid - p.price_open) if p.type == POSITION_TYPE_BUY else (p.price_open - ask)
    return round(_to_usd(diff * p.volume * spec.contract_size, spec.currency_profit, now), 2)


def _margin(symbol: str, volume: float, price: float, now: float) -> float:
    spec = _SPECS[symbol]
    notional = _to_usd(volume * spec.contract_size * price, spec.currency_profit, now)
    return notional / spec.leverage


def _totals(now: float) -> tuple[float, float]:
    profit = sum(_profit(p, now) for p in _S.positions.values())
    margin = sum(_margin(p.symbol, p.volume, p.price_open, now) for p in _S.positions.values())
    return round(profit, 2), round(margin, 2)


def account_info():
    with _S.lock:
        if _ready() is None:
            return None
        _process()
        now = _server_now()
        profit, margin = _totals(now)
        equity = round(_S.balance + profit, 2)
        level = round(equity / margin * 100, 2) if margin else 0.0
        return AccountInfo(
            12345678, 0, 100, 200, 0, True, True, 2, 2, False, round(_S.balance, 2), 0.0, profit,
            equity, margin, round(equity - margin, 2), level, 100.0, 50.0, "Mock Trader",
            "Mock-Server", "USD", "Mock Broker",
        )


# ---------------------------------------------------------------------------
# Positions, orders, history
# ---------------------------------------------------------------------------


def _pos_tuple(p: _Position, now: float):
    bid, ask = _quote(_SPECS[p.symbol], now)
    current = bid if p.type == POSITION_TYPE_BUY else ask
    return TradePosition(
        p.ticket, p.time, p.time_msc, p.time, p.time_msc, p.type, p.magic, p.ticket, 0, p.volume,
        p.price_open, p.sl, p.tp, current, 0.0, _profit(p, now), p.symbol, p.comment, "",
    )


def _order_tuple(o: _Order, now: float):
    bid, ask = _quote(_SPECS[o.symbol], now)
    current = ask if o.type in (ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_BUY_STOP) else bid
    return TradeOrder(
        o.ticket, o.time_setup, o.time_setup * 1000, 0, 0, 0, o.type, ORDER_TIME_GTC,
        ORDER_FILLING_RETURN, ORDER_STATE_PLACED, o.magic, 0, 0, 0, o.volume, o.volume,
        o.price_open, o.sl, o.tp, current, 0.0, o.symbol, o.comment, "",
    )


def positions_get(symbol: str | None = None, group: str | None = None, ticket: int | None = None):
    with _S.lock:
        if _ready() is None:
            return None
        _process()
        now = _server_now()
        return _empty(tuple(
            _pos_tuple(p, now)
            for p in _S.positions.values()
            if (symbol is None or p.symbol == symbol) and (ticket is None or p.ticket == ticket)
        ))


def positions_total() -> int | None:
    with _S.lock:
        if _ready() is None:
            return None
        _process()
        return len(_S.positions)


def orders_total() -> int | None:
    with _S.lock:
        if _ready() is None:
            return None
        _process()
        return len(_S.orders)


def orders_get(symbol: str | None = None, group: str | None = None, ticket: int | None = None):
    with _S.lock:
        if _ready() is None:
            return None
        _process()
        now = _server_now()
        return _empty(tuple(
            _order_tuple(o, now)
            for o in _S.orders.values()
            if (symbol is None or o.symbol == symbol) and (ticket is None or o.ticket == ticket)
        ))


def history_deals_get(date_from=None, date_to=None, group=None, ticket=None, position=None):
    with _S.lock:
        if _ready() is None:
            return None
        _process()

        def ts(v):
            return v.timestamp() if isinstance(v, datetime) else v

        lo, hi = ts(date_from), ts(date_to)
        return _empty(tuple(
            d
            for d in _S.deals
            if (lo is None or d.time >= lo)
            and (hi is None or d.time <= hi)
            and (position is None or d.position_id == position)
            and (ticket is None or d.ticket == ticket)
        ))


def history_deals_total(date_from, date_to) -> int | None:
    with _S.lock:
        if _ready() is None:
            return None
        _process()
        lo = date_from.timestamp() if isinstance(date_from, datetime) else date_from
        hi = date_to.timestamp() if isinstance(date_to, datetime) else date_to
        return sum(1 for d in _S.deals if lo <= d.time <= hi)


def order_calc_profit(action: int, symbol: str, volume: float, price_open: float, price_close: float):
    with _S.lock:
        if _ready() is None:
            return None
        spec = _SPECS.get(symbol)
        if spec is None:
            _S.last_error = (RES_E_NOT_FOUND, "Symbol not found")
            return None
        diff = (price_close - price_open) if action == ORDER_TYPE_BUY else (price_open - price_close)
        return round(_to_usd(diff * volume * spec.contract_size, spec.currency_profit, _server_now()), 2)


def order_calc_margin(action: int, symbol: str, volume: float, price: float):
    with _S.lock:
        if _ready() is None:
            return None
        if symbol not in _SPECS:
            _S.last_error = (RES_E_NOT_FOUND, "Symbol not found")
            return None
        return round(_margin(symbol, volume, price, _server_now()), 2)


# ---------------------------------------------------------------------------
# Simulation: triggers for pending orders and SL/TP
# ---------------------------------------------------------------------------


def _record_deal(order: int, symbol: str, deal_type: int, entry: int, volume: float,
                 price: float, profit: float, position_id: int, reason: int, magic: int,
                 comment: str, now: float) -> int:
    ticket = _S.ticket()
    _S.deals.append(
        TradeDeal(ticket, order, int(now), int(now * 1000), deal_type, entry, magic, position_id,
                  reason, volume, price, 0.0, 0.0, profit, 0.0, symbol, comment, "")
    )
    return ticket


def _open_position(symbol: str, side: int, volume: float, sl: float, tp: float, magic: int,
                   comment: str, now: float, order_ticket: int | None = None) -> tuple[int, int, float]:
    bid, ask = _quote(_SPECS[symbol], now)
    price = ask if side == POSITION_TYPE_BUY else bid
    ticket = order_ticket or _S.ticket()
    _S.positions[ticket] = _Position(ticket, symbol, side, volume, price, sl, tp, int(now),
                                     int(now * 1000), magic, comment)
    deal = _record_deal(ticket, symbol, DEAL_TYPE_BUY if side == POSITION_TYPE_BUY else DEAL_TYPE_SELL,
                        DEAL_ENTRY_IN, volume, price, 0.0, ticket, DEAL_REASON_CLIENT, magic, comment, now)
    return ticket, deal, price


def _close_position(p: _Position, volume: float, reason: int, now: float) -> tuple[int, float, float]:
    spec = _SPECS[p.symbol]
    bid, ask = _quote(spec, now)
    price = bid if p.type == POSITION_TYPE_BUY else ask
    diff = (price - p.price_open) if p.type == POSITION_TYPE_BUY else (p.price_open - price)
    profit = round(_to_usd(diff * volume * spec.contract_size, spec.currency_profit, now), 2)
    _S.balance += profit
    deal_type = DEAL_TYPE_SELL if p.type == POSITION_TYPE_BUY else DEAL_TYPE_BUY
    comment = {DEAL_REASON_SL: "[sl]", DEAL_REASON_TP: "[tp]"}.get(reason, p.comment)
    deal = _record_deal(_S.ticket(), p.symbol, deal_type, DEAL_ENTRY_OUT, volume, price, profit,
                        p.ticket, reason, p.magic, comment, now)
    p.volume = round(p.volume - volume, 8)
    if p.volume <= 1e-9:
        del _S.positions[p.ticket]
    return deal, price, profit


def _process() -> None:
    now = _server_now()
    for o in list(_S.orders.values()):
        bid, ask = _quote(_SPECS[o.symbol], now)
        hit = {
            ORDER_TYPE_BUY_LIMIT: ask <= o.price_open,
            ORDER_TYPE_SELL_LIMIT: bid >= o.price_open,
            ORDER_TYPE_BUY_STOP: ask >= o.price_open,
            ORDER_TYPE_SELL_STOP: bid <= o.price_open,
        }[o.type]
        if not hit:
            continue
        del _S.orders[o.ticket]
        side = POSITION_TYPE_BUY if o.type in (ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_BUY_STOP) else POSITION_TYPE_SELL
        price = ask if side == POSITION_TYPE_BUY else bid
        equity = _S.balance + _totals(now)[0]
        if equity - _totals(now)[1] - _margin(o.symbol, o.volume, price, now) < 0:
            continue  # the real server cancels an order it cannot fund at activation
        _open_position(o.symbol, side, o.volume, o.sl, o.tp, o.magic, o.comment, now, o.ticket)

    for p in list(_S.positions.values()):
        bid, ask = _quote(_SPECS[p.symbol], now)
        px = bid if p.type == POSITION_TYPE_BUY else ask
        buy = p.type == POSITION_TYPE_BUY
        if p.sl and (px <= p.sl if buy else px >= p.sl):
            _close_position(p, p.volume, DEAL_REASON_SL, now)
        elif p.tp and (px >= p.tp if buy else px <= p.tp):
            _close_position(p, p.volume, DEAL_REASON_TP, now)


# ---------------------------------------------------------------------------
# order_send
# ---------------------------------------------------------------------------


def _result(retcode: int, request: dict, *, deal: int = 0, order: int = 0, volume: float = 0.0,
            price: float = 0.0, bid: float = 0.0, ask: float = 0.0, comment: str = ""):
    return OrderSendResult(retcode, deal, order, volume, price, bid, ask, comment, 0, 0, request)


def _volume_ok(spec: _Spec, volume: float) -> bool:
    if volume < spec.volume_min - 1e-9 or volume > spec.volume_max + 1e-9:
        return False
    steps = volume / spec.volume_step
    return abs(steps - round(steps)) < 1e-6


def _stops_ok(spec: _Spec, buy: bool, sl: float, tp: float, ref: float) -> bool:
    """SL/TP must sit at least stops_level points away on the correct side of `ref`."""
    lvl = spec.stops_level * spec.point
    if buy:
        return (not sl or sl < ref - lvl) and (not tp or tp > ref + lvl)
    return (not sl or sl > ref + lvl) and (not tp or tp < ref - lvl)


def order_send(request: dict):
    with _S.lock:
        if _ready() is None:
            return None
        _process()
        now = _server_now()
        action = request.get("action")
        symbol = request.get("symbol")

        # Symbol-less actions resolve the symbol from the ticket.
        if action == TRADE_ACTION_SLTP and not symbol:
            p = _S.positions.get(request.get("position", 0))
            symbol = p.symbol if p else None
        if action in (TRADE_ACTION_MODIFY, TRADE_ACTION_REMOVE) and not symbol:
            o = _S.orders.get(request.get("order", 0))
            symbol = o.symbol if o else None

        spec = _SPECS.get(symbol or "")
        if spec is None:
            if action in (TRADE_ACTION_SLTP,):
                return _result(TRADE_RETCODE_POSITION_CLOSED, request, comment="Position doesn't exist")
            if action in (TRADE_ACTION_MODIFY, TRADE_ACTION_REMOVE):
                return _result(TRADE_RETCODE_INVALID_ORDER, request, comment="Invalid order")
            return _result(TRADE_RETCODE_INVALID, request, comment="Invalid request")
        bid, ask = _quote(spec, now)
        if symbol in _S.closed_symbols:
            return _result(TRADE_RETCODE_MARKET_CLOSED, request, bid=bid, ask=ask, comment="Market closed")

        sl = float(request.get("sl") or 0.0)
        tp = float(request.get("tp") or 0.0)
        volume = float(request.get("volume") or 0.0)
        magic = int(request.get("magic") or 0)
        comment = str(request.get("comment") or "")
        otype = request.get("type")

        if action == TRADE_ACTION_DEAL:
            if otype not in (ORDER_TYPE_BUY, ORDER_TYPE_SELL):
                return _result(TRADE_RETCODE_INVALID, request, comment="Invalid request")
            if not _volume_ok(spec, volume):
                return _result(TRADE_RETCODE_INVALID_VOLUME, request, comment="Invalid volume")
            fill = ask if otype == ORDER_TYPE_BUY else bid
            req_price = float(request.get("price") or 0.0)
            deviation = int(request.get("deviation") or 0)
            if req_price and abs(req_price - fill) > deviation * spec.point + 1e-12:
                return _result(TRADE_RETCODE_REQUOTE, request, bid=bid, ask=ask, comment="Requote")

            pos_ticket = request.get("position")
            if pos_ticket:  # closing (fully or partially) an existing position
                p = _S.positions.get(pos_ticket)
                if p is None:
                    return _result(TRADE_RETCODE_POSITION_CLOSED, request, comment="Position doesn't exist")
                if (p.type == POSITION_TYPE_BUY) == (otype == ORDER_TYPE_BUY):
                    return _result(TRADE_RETCODE_INVALID, request, comment="Invalid request")
                if volume > p.volume + 1e-9:
                    return _result(TRADE_RETCODE_INVALID_CLOSE_VOLUME, request, comment="Invalid close volume")
                deal, price, _ = _close_position(p, volume, DEAL_REASON_CLIENT, now)
                return _result(TRADE_RETCODE_DONE, request, deal=deal, order=deal, volume=volume,
                               price=price, bid=bid, ask=ask, comment="Request executed")

            buy = otype == ORDER_TYPE_BUY
            if not _stops_ok(spec, buy, sl, tp, bid if buy else ask):
                return _result(TRADE_RETCODE_INVALID_STOPS, request, bid=bid, ask=ask, comment="Invalid stops")
            profit, margin = _totals(now)
            if _S.balance + profit - margin - _margin(symbol, volume, fill, now) < 0:
                return _result(TRADE_RETCODE_NO_MONEY, request, bid=bid, ask=ask, comment="No money")
            ticket, deal, price = _open_position(
                symbol, POSITION_TYPE_BUY if buy else POSITION_TYPE_SELL, volume, sl, tp, magic, comment, now
            )
            return _result(TRADE_RETCODE_DONE, request, deal=deal, order=ticket, volume=volume,
                           price=price, bid=bid, ask=ask, comment="Request executed")

        if action == TRADE_ACTION_PENDING:
            if otype not in (ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_SELL_LIMIT, ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP):
                return _result(TRADE_RETCODE_INVALID, request, comment="Invalid request")
            if not _volume_ok(spec, volume):
                return _result(TRADE_RETCODE_INVALID_VOLUME, request, comment="Invalid volume")
            price = round(float(request.get("price") or 0.0), spec.digits)
            if not _pending_price_ok(spec, otype, price, bid, ask):
                return _result(TRADE_RETCODE_INVALID_PRICE, request, bid=bid, ask=ask, comment="Invalid price")
            buy = otype in (ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_BUY_STOP)
            if not _stops_ok(spec, buy, sl, tp, price):
                return _result(TRADE_RETCODE_INVALID_STOPS, request, bid=bid, ask=ask, comment="Invalid stops")
            ticket = _S.ticket()
            _S.orders[ticket] = _Order(ticket, symbol, otype, volume, price, sl, tp, int(now), magic, comment)
            return _result(TRADE_RETCODE_DONE, request, order=ticket, volume=volume, price=price,
                           bid=bid, ask=ask, comment="Request executed")

        if action == TRADE_ACTION_SLTP:
            p = _S.positions.get(request.get("position", 0))
            if p is None:
                return _result(TRADE_RETCODE_POSITION_CLOSED, request, comment="Position doesn't exist")
            buy = p.type == POSITION_TYPE_BUY
            if (sl, tp) == (p.sl, p.tp):
                return _result(TRADE_RETCODE_NO_CHANGES, request, comment="No changes")
            if not _stops_ok(spec, buy, sl, tp, bid if buy else ask):
                return _result(TRADE_RETCODE_INVALID_STOPS, request, bid=bid, ask=ask, comment="Invalid stops")
            p.sl, p.tp = sl, tp
            return _result(TRADE_RETCODE_DONE, request, order=p.ticket, bid=bid, ask=ask, comment="Request executed")

        if action == TRADE_ACTION_MODIFY:
            o = _S.orders.get(request.get("order", 0))
            if o is None:
                return _result(TRADE_RETCODE_INVALID_ORDER, request, comment="Invalid order")
            price = round(float(request.get("price") or o.price_open), spec.digits)
            if (price, sl, tp) == (o.price_open, o.sl, o.tp):
                return _result(TRADE_RETCODE_NO_CHANGES, request, comment="No changes")
            if not _pending_price_ok(spec, o.type, price, bid, ask):
                return _result(TRADE_RETCODE_INVALID_PRICE, request, bid=bid, ask=ask, comment="Invalid price")
            buy = o.type in (ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_BUY_STOP)
            if not _stops_ok(spec, buy, sl, tp, price):
                return _result(TRADE_RETCODE_INVALID_STOPS, request, bid=bid, ask=ask, comment="Invalid stops")
            o.price_open, o.sl, o.tp = price, sl, tp
            return _result(TRADE_RETCODE_DONE, request, order=o.ticket, comment="Request executed")

        if action == TRADE_ACTION_REMOVE:
            o = _S.orders.pop(request.get("order", 0), None)
            if o is None:
                return _result(TRADE_RETCODE_INVALID_ORDER, request, comment="Invalid order")
            return _result(TRADE_RETCODE_DONE, request, order=o.ticket, comment="Request executed")

        return _result(TRADE_RETCODE_INVALID, request, comment="Invalid request")


def _pending_price_ok(spec: _Spec, otype: int, price: float, bid: float, ask: float) -> bool:
    if price <= 0:
        return False
    lvl = spec.stops_level * spec.point
    return {
        ORDER_TYPE_BUY_LIMIT: price <= ask - lvl,
        ORDER_TYPE_SELL_LIMIT: price >= bid + lvl,
        ORDER_TYPE_BUY_STOP: price >= ask + lvl,
        ORDER_TYPE_SELL_STOP: price <= bid - lvl,
    }[otype]
