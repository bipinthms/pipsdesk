"""FastAPI application: REST endpoints over the MT5 bridge.

Run with `python -m backend` (binds to 127.0.0.1 by default), or
`uvicorn backend.api:create_app --factory`.

Browser-facing hardening, since a local trading API is a juicy target for any
web page the user happens to visit:
- binds to 127.0.0.1 only (see __main__)
- Host header allow-list (blocks DNS-rebinding attacks)
- CORS restricted to the UI origins
- state-changing requests must carry `X-Requested-With: trading-ui`, which
  forces a CORS preflight that foreign origins fail

The UI calls everything under `/api/...`. In development the Vite proxy strips
the prefix; when this server serves the built UI itself (frontend/dist), the
`StripApiPrefix` middleware does the same, so both setups use identical URLs.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Path, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from backend import schemas
from backend.config import Settings, get_settings
from backend.db import Database
from backend.mt5_bridge import MT5Bridge, MT5Error, MT5Unavailable, SymbolNotFound, TradeRejected
from backend.risk import RiskDecision, RiskSettings, RiskStatus
from backend.risk_service import RiskService
from backend.stream import StreamHub
from backend.trading import RiskBlocked, TradingService

log = logging.getLogger(__name__)

HEALTH_CHECK_INTERVAL_S = 2.0
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "trading-ui"
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


class StripApiPrefix:
    """Serve `/api/x` as `/x` (HTTP and WebSocket), matching the Vite dev proxy."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            path: str = scope["path"]
            if path == "/api" or path.startswith("/api/"):
                scope = {**scope, "path": path[4:] or "/", "raw_path": (path[4:] or "/").encode()}
        await self.app(scope, receive, send)


async def _supervise(bridge: MT5Bridge, risk: RiskService) -> None:
    """Keep the terminal connection alive (reconnects use the bridge's backoff) and
    let the risk engine observe the account, so the daily anchor is captured at the reset."""
    while True:
        try:
            if await run_in_threadpool(bridge.health_check):
                await run_in_threadpool(risk.observe)
        except MT5Error as exc:
            log.debug("supervisor: %s", exc)
        except Exception:  # never let the supervisor die
            log.exception("supervisor tick failed")
        await asyncio.sleep(HEALTH_CHECK_INTERVAL_S)


def create_app(
    settings: Settings | None = None, bridge: MT5Bridge | None = None, db: Database | None = None
) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        b = bridge or MT5Bridge(settings)
        app.state.bridge = b
        database = db or Database(settings.db_path)
        risk = RiskService(database, b, settings.server_time_symbol)
        hub = StreamHub(b, settings.stream_interval_ms / 1000, risk)
        app.state.db = database
        app.state.risk = risk
        app.state.trading = TradingService(b, risk, database)
        app.state.hub = hub
        if await run_in_threadpool(b.connect):
            with contextlib.suppress(MT5Error):
                await run_in_threadpool(risk.observe)
        tasks = [asyncio.create_task(_supervise(b, risk)), asyncio.create_task(hub.run())]
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await run_in_threadpool(b.shutdown)

    app = FastAPI(title="Trading Desk API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-Requested-With"],
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    app.add_middleware(StripApiPrefix)

    @app.middleware("http")
    async def require_csrf_header(request: Request, call_next):
        if request.method in _MUTATING and request.headers.get(CSRF_HEADER) != CSRF_VALUE:
            return JSONResponse({"detail": "Missing X-Requested-With header."}, status_code=403)
        return await call_next(request)

    @app.exception_handler(MT5Unavailable)
    async def _unavailable(_: Request, exc: MT5Unavailable) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.exception_handler(SymbolNotFound)
    async def _not_found(_: Request, exc: SymbolNotFound) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(TradeRejected)
    async def _rejected(_: Request, exc: TradeRejected) -> JSONResponse:
        body = schemas.TradeErrorResponse(detail=str(exc), kind="broker", retcode=exc.retcode)
        return JSONResponse(body.model_dump(), status_code=409)

    @app.exception_handler(RiskBlocked)
    async def _blocked(_: Request, exc: RiskBlocked) -> JSONResponse:
        d = exc.decision
        body = schemas.TradeErrorResponse(detail=d.violations[0], kind="risk", violations=d.violations)
        return JSONResponse(body.model_dump(), status_code=422)

    @app.exception_handler(MT5Error)
    async def _mt5_error(_: Request, exc: MT5Error) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=502)

    _register_routes(app)
    _register_stream(app, settings)

    # Mounted last, so API routes always win; "/" serves index.html.
    dist = settings.frontend_dist
    if settings.serve_frontend and (dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=dist, html=True), name="ui")
    return app


def get_bridge(request: Request) -> MT5Bridge:
    return request.app.state.bridge


def get_risk(request: Request) -> RiskService:
    return request.app.state.risk


def get_trading(request: Request) -> TradingService:
    return request.app.state.trading


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


Bridge = Annotated[MT5Bridge, Depends(get_bridge)]
Risk = Annotated[RiskService, Depends(get_risk)]
Trading = Annotated[TradingService, Depends(get_trading)]
Db = Annotated[Database, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_app_settings)]
SymbolPath = Annotated[str, Path(pattern=schemas.SYMBOL_PATTERN)]
_ERRORS = {
    404: {"model": schemas.ErrorResponse},
    503: {"model": schemas.ErrorResponse, "description": "MT5 terminal unavailable"},
}
_TRADE_ERRORS = {
    **_ERRORS,
    409: {"model": schemas.TradeErrorResponse, "description": "Rejected by the broker"},
    422: {"model": schemas.TradeErrorResponse, "description": "Blocked by the risk engine (or invalid input)"},
}


def _register_routes(app: FastAPI) -> None:
    # Sync handlers run in FastAPI's thread pool, so blocking MT5 calls never stall the event loop.

    @app.get("/health", response_model=schemas.HealthResponse)
    def health(bridge: Bridge) -> schemas.HealthResponse:
        return bridge.status()

    @app.get("/account", response_model=schemas.AccountInfo, responses=_ERRORS)
    def account(bridge: Bridge) -> schemas.AccountInfo:
        return bridge.account_info()

    @app.get("/symbols", response_model=list[schemas.SymbolInfo], responses=_ERRORS)
    def symbols(bridge: Bridge) -> list[schemas.SymbolInfo]:
        return bridge.symbols()

    @app.get("/candles", response_model=schemas.CandlesResponse, responses=_ERRORS)
    def candles(
        bridge: Bridge,
        symbol: Annotated[str, Query(min_length=1, max_length=32)],
        timeframe: schemas.Timeframe = "M15",
        count: Annotated[int, Query(ge=1, le=5000)] = 500,
        before: Annotated[int | None, Query(gt=0, description="Only bars strictly older than this server-time epoch")] = None,
    ) -> schemas.CandlesResponse:
        return schemas.CandlesResponse(
            symbol=symbol, timeframe=timeframe, candles=bridge.candles(symbol, timeframe, count, before)
        )

    # --- trading state -------------------------------------------------------------

    @app.get("/positions", response_model=list[schemas.Position], responses=_ERRORS)
    def positions(bridge: Bridge) -> list[schemas.Position]:
        return bridge.positions()

    @app.get("/orders", response_model=list[schemas.PendingOrder], responses=_ERRORS)
    def orders(bridge: Bridge) -> list[schemas.PendingOrder]:
        return bridge.orders()

    @app.get("/history", response_model=list[schemas.Deal], responses=_ERRORS)
    def history(
        bridge: Bridge, settings: AppSettings, days: Annotated[int, Query(ge=1, le=365)] = 7
    ) -> list[schemas.Deal]:
        now = bridge.server_time(settings.server_time_symbol)
        deals = bridge.deals(now - days * 86_400, now + 86_400)
        return sorted(deals, key=lambda d: d.time, reverse=True)

    @app.get("/journal", response_model=list[schemas.JournalOut])
    def journal(
        db: Db,
        limit: Annotated[int, Query(ge=1, le=1000)] = 200,
        before_id: int | None = None,
        status: Literal["accepted", "blocked", "rejected", "error", "info"] | None = None,
    ) -> list[schemas.JournalOut]:
        return [
            schemas.JournalOut.model_validate({**e.model_dump(), "details": json.loads(e.details or "{}")})
            for e in db.journal_list(limit, before_id, status)
        ]

    @app.patch("/journal/{entry_id}", response_model=schemas.JournalOut, responses={404: {"model": schemas.ErrorResponse}})
    def set_journal_note(db: Db, entry_id: int, body: schemas.JournalNoteIn) -> schemas.JournalOut:
        e = db.journal_set_note(entry_id, body.note)
        if e is None:
            raise HTTPException(status_code=404, detail="Journal entry not found.")
        return schemas.JournalOut.model_validate({**e.model_dump(), "details": json.loads(e.details or "{}")})

    # --- order actions (each one is risk-checked and journaled) ---------------------

    @app.post("/orders", response_model=schemas.TradeResponse, responses=_TRADE_ERRORS)
    def place_order(trading: Trading, body: schemas.OrderRequest) -> schemas.TradeResponse:
        return trading.place(body)

    @app.patch("/orders/{ticket}", response_model=schemas.TradeResponse, responses=_TRADE_ERRORS)
    def modify_order(trading: Trading, ticket: int, body: schemas.ModifyOrderRequest) -> schemas.TradeResponse:
        return trading.modify_order(ticket, body)

    @app.delete("/orders/{ticket}", response_model=schemas.TradeResponse, responses=_TRADE_ERRORS)
    def cancel_order(trading: Trading, ticket: int) -> schemas.TradeResponse:
        return trading.cancel_order(ticket)

    @app.patch("/positions/{ticket}", response_model=schemas.TradeResponse, responses=_TRADE_ERRORS)
    def modify_position(trading: Trading, ticket: int, body: schemas.ModifyPositionRequest) -> schemas.TradeResponse:
        return trading.modify_position(ticket, body)

    @app.delete("/positions/{ticket}", response_model=schemas.TradeResponse, responses=_TRADE_ERRORS)
    def close_position(
        trading: Trading,
        ticket: int,
        volume: Annotated[float | None, Query(gt=0, description="Partial close volume; omit to close fully")] = None,
    ) -> schemas.TradeResponse:
        return trading.close_position(ticket, volume)

    @app.post("/positions/flatten", response_model=schemas.FlattenResponse, responses=_ERRORS)
    def flatten(trading: Trading) -> schemas.FlattenResponse:
        """Close all positions and cancel all pending orders."""
        return trading.flatten()

    # --- chart drawings ----------------------------------------------------------

    @app.get("/drawings/{symbol}", response_model=schemas.DrawingsOut, response_model_exclude_none=True)
    def get_drawings(db: Db, symbol: SymbolPath) -> schemas.DrawingsOut:
        saved = db.get_json(f"drawings:{symbol}") or []
        return schemas.DrawingsOut(symbol=symbol, drawings=saved)

    @app.put("/drawings/{symbol}", response_model=schemas.DrawingsOut, response_model_exclude_none=True)
    def put_drawings(db: Db, symbol: SymbolPath, body: schemas.DrawingsIn) -> schemas.DrawingsOut:
        """Replace all drawings for a symbol."""
        db.set_json(f"drawings:{symbol}", [d.model_dump(exclude_none=True, by_alias=True) for d in body.drawings])
        return schemas.DrawingsOut(symbol=symbol, drawings=body.drawings)

    # --- risk ------------------------------------------------------------------

    @app.get("/risk/settings", response_model=RiskSettings)
    def get_risk_settings(risk: Risk) -> RiskSettings:
        return risk.settings

    @app.put("/risk/settings", response_model=RiskSettings)
    def put_risk_settings(risk: Risk, body: RiskSettings) -> RiskSettings:
        return risk.update_settings(body)

    @app.get("/risk/status", response_model=RiskStatus, responses=_ERRORS)
    def risk_status(risk: Risk) -> RiskStatus:
        risk.observe()
        status = risk.status()
        assert status is not None  # observe() just recorded equity
        return status

    @app.post("/risk/check", response_model=RiskDecision, responses=_ERRORS)
    def risk_check(risk: Risk, body: schemas.OrderCheckRequest) -> RiskDecision:
        """Dry run: what the risk engine would say about this action. Sends nothing to MT5."""
        return risk.evaluate(risk.intent_from_check(body))

    @app.get("/risk/news", response_model=list[schemas.NewsEventOut])
    def list_news(risk: Risk) -> list[schemas.NewsEventOut]:
        return [schemas.NewsEventOut(id=e.id or 0, time_utc=e.time_utc, title=e.title) for e in risk.news_events()]

    @app.post("/risk/news", response_model=schemas.NewsEventOut, status_code=201)
    def add_news(risk: Risk, body: schemas.NewsEventIn) -> schemas.NewsEventOut:
        e = risk.add_news_event(body.time_utc, body.title)
        return schemas.NewsEventOut(id=e.id or 0, time_utc=e.time_utc, title=e.title)

    @app.delete("/risk/news/{event_id}", status_code=204, responses={404: {"model": schemas.ErrorResponse}})
    def delete_news(risk: Risk, event_id: int) -> None:
        if not risk.delete_news_event(event_id):
            raise HTTPException(status_code=404, detail="News event not found.")



def _register_stream(app: FastAPI, settings: Settings) -> None:
    allowed_origins = set(settings.cors_origin_list)

    @app.websocket("/ws/stream")
    async def stream(ws: WebSocket) -> None:
        # Browsers don't apply CORS to WebSockets, so check the Origin ourselves.
        origin = ws.headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            await ws.close(code=1008)
            return
        await ws.accept()
        hub: StreamHub = app.state.hub
        client = hub.add(ws)
        try:
            while True:
                try:
                    raw = await ws.receive_json()
                except ValueError:  # not JSON
                    await ws.send_json({"type": "error", "message": "Messages must be JSON.", "symbol": None})
                    continue
                await hub.handle(client, raw)
        except WebSocketDisconnect:
            pass
        finally:
            hub.remove(client)
