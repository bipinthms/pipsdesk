"""Pydantic models for the HTTP/WebSocket API.

These are the single source of truth for the API contract; the frontend's
`src/api/types.ts` mirrors them by hand. Times are MT5 *server* time expressed
as epoch seconds, which is how MetaTrader reports them.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

Timeframe = Literal["M1", "M5", "M15", "H1", "H4", "D1"]
Side = Literal["buy", "sell"]
PendingType = Literal["buy_limit", "sell_limit", "buy_stop", "sell_stop"]


class HealthResponse(BaseModel):
    connected: bool
    mock: bool
    message: str | None = None
    retry_in_seconds: float | None = None


class AccountInfo(BaseModel):
    currency: str
    balance: float
    equity: float
    margin: float
    margin_free: float
    margin_level: float | None
    profit: float
    leverage: int
    trade_allowed: bool
    mock: bool
    # What kind of account the terminal is logged into (from MT5's trade_mode).
    account_mode: Literal["demo", "contest", "real"]


class SymbolInfo(BaseModel):
    name: str
    description: str
    digits: int
    point: float
    contract_size: float
    tick_size: float
    tick_value: float
    volume_min: float
    volume_max: float
    volume_step: float
    stops_level: int
    spread: int
    currency_base: str
    currency_profit: str
    trade_allowed: bool


class Tick(BaseModel):
    symbol: str
    time: int
    time_msc: int
    bid: float
    ask: float


class Candle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: int


class CandlesResponse(BaseModel):
    symbol: str
    timeframe: Timeframe
    candles: list[Candle]


class Position(BaseModel):
    ticket: int
    symbol: str
    side: Side
    volume: float
    price_open: float
    price_current: float
    sl: float | None
    tp: float | None
    profit: float
    swap: float
    time: int
    comment: str


class PendingOrder(BaseModel):
    ticket: int
    symbol: str
    type: PendingType
    volume: float
    price_open: float
    price_current: float
    sl: float | None
    tp: float | None
    time_setup: int
    comment: str


class Deal(BaseModel):
    ticket: int
    order: int
    position_id: int
    symbol: str
    side: Side | None
    entry: Literal["in", "out", "other"]
    volume: float
    price: float
    profit: float
    commission: float
    swap: float
    time: int
    reason: str
    comment: str


class TradeResult(BaseModel):
    retcode: int
    message: str
    order: int
    deal: int
    volume: float
    price: float


class ErrorResponse(BaseModel):
    detail: str


# ---------------------------------------------------------------------------
# WebSocket /ws/stream messages
# ---------------------------------------------------------------------------


class SubscribeMessage(BaseModel):
    """Client → server: the full set of symbols to stream ticks for (replaces the previous set)."""

    type: Literal["subscribe"]
    symbols: list[str] = Field(max_length=50)


class ChartMessage(BaseModel):
    """Client → server: the chart whose forming candle should be streamed (symbol=None stops it)."""

    type: Literal["chart"]
    symbol: str | None = Field(default=None, max_length=32)
    timeframe: Timeframe = "M15"


class ChartRef(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    timeframe: Timeframe


class ChartsMessage(BaseModel):
    """Client → server: every chart whose forming candle should be streamed (replaces `chart`)."""

    type: Literal["charts"]
    charts: list[ChartRef] = Field(max_length=8)


ClientMessage = Annotated[SubscribeMessage | ChartMessage | ChartsMessage, Field(discriminator="type")]


class StreamStatus(BaseModel):
    type: Literal["status"] = "status"
    status: HealthResponse


class StreamTick(BaseModel):
    type: Literal["tick"] = "tick"
    tick: Tick


class StreamCandles(BaseModel):
    """The last closed bar and the forming bar, oldest first."""

    type: Literal["candle"] = "candle"
    symbol: str
    timeframe: Timeframe
    candles: list[Candle]


class StreamAccount(BaseModel):
    type: Literal["account"] = "account"
    account: AccountInfo


class StreamPositions(BaseModel):
    type: Literal["positions"] = "positions"
    positions: list[Position]


class StreamError(BaseModel):
    type: Literal["error"] = "error"
    message: str
    symbol: str | None = None


# ---------------------------------------------------------------------------
# Risk
# ---------------------------------------------------------------------------


class OrderCheckRequest(BaseModel):
    """Dry-run an order action through the risk engine (no order is sent)."""

    action: Literal["open", "pending", "modify_position", "modify_order"]
    symbol: str | None = Field(default=None, max_length=32)
    side: Side | None = None
    volume: float = 0.0
    # Pending / modify_order price. Omit for market orders: the current bid/ask is used.
    price: float | None = Field(default=None, gt=0)
    sl: float | None = Field(default=None, gt=0)
    tp: float | None = Field(default=None, gt=0)
    ticket: int | None = None
    allow_no_sl: bool = False


class NewsEventIn(BaseModel):
    time_utc: int = Field(gt=0, description="Event time, epoch seconds UTC")
    title: str = Field(min_length=1, max_length=120)


class NewsEventOut(NewsEventIn):
    id: int


class StreamRisk(BaseModel):
    type: Literal["risk"] = "risk"
    risk: dict


# ---------------------------------------------------------------------------
# Trading
# ---------------------------------------------------------------------------


class OrderRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    side: Side
    order_type: Literal["market", "limit", "stop"] = "market"
    volume: float = Field(gt=0)
    # Required for limit/stop. For market orders, the price the trader saw (used for slippage control).
    price: float | None = Field(default=None, gt=0)
    sl: float | None = Field(default=None, gt=0)
    tp: float | None = Field(default=None, gt=0)
    allow_no_sl: bool = False
    deviation: int = Field(default=20, ge=0, le=1000, description="Max slippage in points (market orders)")
    comment: str = Field(default="", max_length=24)  # after the 11-character order tag; MT5 keeps 31
    # Optional id chosen by the UI for this order. Sending the same id again returns the
    # first attempt's result instead of placing the order twice.
    client_order_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{8,64}$")


class ModifyPositionRequest(BaseModel):
    sl: float | None = Field(default=None, gt=0)
    tp: float | None = Field(default=None, gt=0)
    allow_no_sl: bool = False


class ModifyOrderRequest(BaseModel):
    price: float = Field(gt=0)
    sl: float | None = Field(default=None, gt=0)
    tp: float | None = Field(default=None, gt=0)
    allow_no_sl: bool = False


class TradeResponse(BaseModel):
    result: TradeResult
    warnings: list[str] = []


class FlattenResponse(BaseModel):
    closed: list[int]
    cancelled: list[int]
    errors: list[str]


class TradeErrorResponse(BaseModel):
    detail: str
    # risk: blocked by the risk engine. broker: rejected by MT5 / the trade server.
    # unknown: sent, but MT5 gave no clear answer; check positions before retrying.
    kind: Literal["risk", "broker", "unknown"]
    violations: list[str] = []
    retcode: int | None = None


class JournalOut(BaseModel):
    id: int
    time_utc: float
    action: str
    status: Literal["accepted", "blocked", "rejected", "error", "unknown", "info"]
    symbol: str | None
    side: str | None
    volume: float | None
    price: float | None
    sl: float | None
    tp: float | None
    ticket: int | None
    retcode: int | None
    risk_amount: float | None
    reason: str
    note: str
    details: dict


class StreamOrders(BaseModel):
    type: Literal["orders"] = "orders"
    orders: list[PendingOrder]


# ---------------------------------------------------------------------------
# Chart drawings (saved per symbol; times are MT5 server time)
# ---------------------------------------------------------------------------

_COLOR = r"^#[0-9a-fA-F]{6}$"
_ID = r"^[A-Za-z0-9_-]{1,40}$"
SYMBOL_PATTERN = r"^[A-Za-z0-9._#+-]{1,32}$"


class ChartPoint(BaseModel):
    time: int
    price: float


# Points each type needs. Positions are [entry, stop, target]; channels [a, b, offset].
DRAWING_POINTS = {
    "hline": 1, "hray": 1, "vline": 1, "cross": 1, "text": 1,
    "trend": 2, "arrow": 2, "fib": 2, "rect": 2, "ellipse": 2, "range": 2,
    "channel": 3, "triangle": 3, "long": 3, "short": 3,
}
DrawingType = Literal[
    "hline", "hray", "vline", "cross", "text", "trend", "arrow", "fib",
    "rect", "ellipse", "range", "channel", "triangle", "long", "short",
]


class Drawing(BaseModel):
    """One chart drawing: its points plus optional style (JSON keys are camelCase)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str = Field(pattern=_ID)
    type: DrawingType
    points: list[ChartPoint] = Field(min_length=1, max_length=3)
    color: str | None = Field(default=None, pattern=_COLOR)
    width: int | None = Field(default=None, ge=1, le=4)
    dash: Literal["solid", "dashed", "dotted"] | None = None
    fill: float | None = Field(default=None, ge=0, le=1)
    extend_left: bool | None = None
    extend_right: bool | None = None
    text: str | None = Field(default=None, max_length=500)
    font_size: int | None = Field(default=None, ge=8, le=48)
    show_label: bool | None = None
    levels: list[Annotated[float, Field(ge=-10, le=10)]] | None = Field(default=None, max_length=20)
    locked: bool | None = None
    pane: str | None = Field(default=None, pattern=_ID)

    @model_validator(mode="before")
    @classmethod
    def _from_legacy(cls, data: object) -> object:
        """Drawings saved before points[] existed: {price} (hline) or {p1, p2}."""
        if not isinstance(data, dict) or "points" in data:
            return data
        data = dict(data)
        price = data.pop("price", None)
        p1, p2 = data.pop("p1", None), data.pop("p2", None)
        if price is not None:
            data["points"] = [{"time": 0, "price": price}]
        elif p1 is not None:
            data["points"] = [p for p in (p1, p2) if p is not None]
        return data

    @model_validator(mode="after")
    def _point_count(self) -> Drawing:
        need = DRAWING_POINTS[self.type]
        if len(self.points) != need:
            raise ValueError(f"{self.type} needs {need} point(s), got {len(self.points)}")
        return self


class DrawingsIn(BaseModel):
    drawings: list[Drawing] = Field(max_length=500)


class DrawingsOut(DrawingsIn):
    symbol: str


class JournalNoteIn(BaseModel):
    note: str = Field(max_length=2000)
