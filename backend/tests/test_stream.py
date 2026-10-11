from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.api import create_app
from backend.mt5_bridge import MT5Bridge, MT5Error
from backend.stream import StreamHub


class FakeWS:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed = False

    async def send_json(self, message: dict) -> None:
        if self.closed:
            raise RuntimeError("closed")
        self.sent.append(message)

    async def close(self, code: int = 1000) -> None:
        self.closed = True

    def take(self) -> list[dict]:
        out, self.sent = self.sent, []
        return out


def kinds(messages: list[dict]) -> list[str]:
    return [m["type"] + (":" + m["tick"]["symbol"] if m["type"] == "tick" else "") for m in messages]


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def hub(bridge) -> StreamHub:
    return StreamHub(bridge, interval_s=0.1)


def test_first_tick_sends_full_snapshot(hub):
    ws = FakeWS()

    async def go():
        c = hub.add(ws)
        await hub.handle(c, {"type": "subscribe", "symbols": ["EURUSD", "XAUUSD"]})
        await hub.handle(c, {"type": "chart", "symbol": "EURUSD", "timeframe": "M5"})
        await hub.tick()

    run(go())
    msgs = ws.take()
    assert sorted(kinds(msgs)) == ["account", "candle", "orders", "positions", "status", "tick:EURUSD", "tick:XAUUSD"]
    candle = next(m for m in msgs if m["type"] == "candle")
    assert candle["timeframe"] == "M5" and len(candle["candles"]) == 2
    assert candle["candles"][1]["time"] - candle["candles"][0]["time"] == 300


def test_only_changes_are_pushed(hub, clock):
    ws = FakeWS()

    async def go():
        c = hub.add(ws)
        await hub.handle(c, {"type": "subscribe", "symbols": ["EURUSD"]})
        await hub.tick()
        ws.take()
        await hub.tick()  # frozen clock: nothing changed
        assert ws.take() == []
        clock.advance(60)
        await hub.tick()
        return ws.take()

    assert "tick:EURUSD" in kinds(run(go()))


def test_new_subscription_gets_snapshot_and_unsubscribed_symbols_stop(hub, clock):
    ws = FakeWS()

    async def go():
        c = hub.add(ws)
        await hub.handle(c, {"type": "subscribe", "symbols": ["EURUSD"]})
        await hub.tick()
        ws.take()
        await hub.handle(c, {"type": "subscribe", "symbols": ["GBPUSD"]})
        clock.advance(60)
        await hub.tick()
        return kinds(ws.take())

    k = run(go())
    assert "tick:GBPUSD" in k and "tick:EURUSD" not in k


def test_unknown_symbol_reports_error_once_and_is_dropped(hub):
    ws = FakeWS()

    async def go():
        c = hub.add(ws)
        await hub.handle(c, {"type": "subscribe", "symbols": ["NOPE", "EURUSD"]})
        await hub.tick()
        first = ws.take()
        await hub.tick()
        return c, first, ws.take()

    c, first, second = run(go())
    errors = [m for m in first if m["type"] == "error"]
    assert errors == [{"type": "error", "message": "Unknown symbol: NOPE", "symbol": "NOPE"}]
    assert c.symbols == {"EURUSD"} and second == []


def test_invalid_message_is_answered_with_error(hub):
    ws = FakeWS()

    async def go():
        c = hub.add(ws)
        await hub.handle(c, {"type": "chart", "symbol": "EURUSD", "timeframe": "M2"})
        await hub.handle(c, {"type": "subscribe", "symbols": ["X"] * 51})

    run(go())
    assert [m["type"] for m in ws.take()] == ["error", "error"]


def test_disconnected_terminal_streams_status_only(hub, mock):
    ws = FakeWS()
    mock._mock_set_terminal_down(True)

    async def go():
        c = hub.add(ws)
        await hub.handle(c, {"type": "subscribe", "symbols": ["EURUSD"]})
        await hub.tick()  # bridge still believes it's connected; its calls fail
        await hub.tick()

    run(go())
    msgs = ws.take()
    statuses = [m["status"]["connected"] for m in msgs if m["type"] == "status"]
    assert statuses[-1] is False
    assert not any(m["type"] == "tick" for m in msgs)


def test_dead_client_is_dropped(hub):
    ws = FakeWS()
    ws.closed = True

    async def go():
        hub.add(ws)
        await hub.tick()

    run(go())
    assert hub._clients == set()


# --- end to end through the real WebSocket endpoint ---------------------------


@pytest.fixture
def client(mock, clock, db):
    from backend.config import Settings

    s = Settings(_env_file=None, mt5_mock=True, extra_allowed_hosts="testserver", stream_interval_ms=100)
    app = create_app(s, bridge=MT5Bridge(s, mt5=mock, clock=clock), db=db, clock=clock)
    with TestClient(app) as c:
        yield c


def test_websocket_end_to_end(client):
    with client.websocket_connect("/ws/stream", headers={"origin": "http://localhost:5173"}) as ws:
        ws.send_json({"type": "subscribe", "symbols": ["US30"]})
        ws.send_json({"type": "chart", "symbol": "US30", "timeframe": "H1"})
        seen: set[str] = set()
        for _ in range(20):
            m = ws.receive_json()
            seen.add(m["type"] + (":" + m["tick"]["symbol"] if m["type"] == "tick" else ""))
            if {"tick:US30", "candle", "account"} <= seen:
                break
        assert {"tick:US30", "candle", "account", "status"} <= seen


def test_websocket_rejects_foreign_origin(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/stream", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()


def test_several_charts_stream_their_own_candles(hub):
    ws = FakeWS()

    async def go():
        c = hub.add(ws)
        await hub.handle(
            c,
            {
                "type": "charts",
                "charts": [
                    {"symbol": "EURUSD", "timeframe": "M5"},
                    {"symbol": "EURUSD", "timeframe": "H1"},
                    {"symbol": "XAUUSD", "timeframe": "M15"},
                ],
            },
        )
        await hub.tick()
        first = ws.take()
        await hub.handle(c, {"type": "charts", "charts": [{"symbol": "XAUUSD", "timeframe": "M15"}]})
        await hub.tick()
        return first, ws.take()

    first, second = run(go())
    assert sorted((m["symbol"], m["timeframe"]) for m in first if m["type"] == "candle") == [
        ("EURUSD", "H1"),
        ("EURUSD", "M5"),
        ("XAUUSD", "M15"),
    ]
    assert [(m["symbol"], m["timeframe"]) for m in second if m["type"] == "candle"] == [("XAUUSD", "M15")]


def test_unknown_chart_symbol_drops_only_its_charts(hub):
    ws = FakeWS()

    async def go():
        c = hub.add(ws)
        await hub.handle(
            c,
            {"type": "charts", "charts": [{"symbol": "NOPE", "timeframe": "M5"}, {"symbol": "EURUSD", "timeframe": "M5"}]},
        )
        await hub.tick()
        return c

    c = run(go())
    assert c.charts == {("EURUSD", "M5")}
    assert any(m["type"] == "error" and m["symbol"] == "NOPE" for m in ws.take())


def test_empty_lists_returned_as_none_still_stream(hub, mock):
    mock._mock_set_quirks(empty_as_none=True)
    snap, errors = hub._snapshot({"EURUSD"}, {("EURUSD", "M5")})
    assert errors == {}
    assert snap["positions"][0] == [] and snap["orders"][0] == []
    assert {"account", "tick:EURUSD", "candle:EURUSD:M5"} <= set(snap)


def test_one_failing_part_does_not_stop_the_stream(hub, monkeypatch):
    def broken():
        raise MT5Error("orders_get failed: odd reply")

    monkeypatch.setattr(hub._bridge, "orders", broken)
    snap, _ = hub._snapshot({"EURUSD", "XAUUSD"}, {("EURUSD", "M5")})
    assert "orders" not in snap
    assert {"account", "positions", "tick:EURUSD", "tick:XAUUSD", "candle:EURUSD:M5"} <= set(snap)
