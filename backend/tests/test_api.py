from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.mt5_bridge import MT5Bridge


@pytest.fixture
def client(settings, mock, clock, db):
    app = create_app(settings, bridge=MT5Bridge(settings, mt5=mock, clock=clock), db=db)
    with TestClient(app) as c:
        yield c


def test_health(client):
    body = client.get("/health").json()
    assert body == {"connected": True, "mock": True, "message": None, "retry_in_seconds": None}


def test_account(client):
    body = client.get("/account").json()
    assert body["balance"] == 100_000 and body["currency"] == "USD" and body["mock"] is True
    assert "login" not in body and "server" not in body  # account identity stays server-side


def test_candles(client):
    r = client.get("/candles", params={"symbol": "EURUSD", "timeframe": "H1", "count": 24})
    assert r.status_code == 200
    body = r.json()
    assert body["timeframe"] == "H1" and len(body["candles"]) == 24
    first = body["candles"][0]
    assert set(first) == {"time", "open", "high", "low", "close", "volume"}

    older = client.get("/candles", params={"symbol": "EURUSD", "timeframe": "H1", "count": 10, "before": first["time"]})
    assert older.json()["candles"][-1]["time"] == first["time"] - 3600


@pytest.mark.parametrize(
    "params",
    [
        {"symbol": "EURUSD", "timeframe": "M2"},
        {"symbol": "EURUSD", "count": 0},
        {"symbol": "EURUSD", "count": 5001},
        {"timeframe": "M1"},
    ],
)
def test_candles_validation(client, params):
    assert client.get("/candles", params=params).status_code == 422


def test_unknown_symbol_is_404(client):
    r = client.get("/candles", params={"symbol": "NOPE"})
    assert r.status_code == 404 and "NOPE" in r.json()["detail"]


def test_disconnected_terminal_is_503(client, mock):
    mock._mock_set_terminal_down(True)
    r = client.get("/account")
    assert r.status_code == 503
    assert client.get("/health").json()["connected"] is False


def test_foreign_host_header_rejected(client):
    assert client.get("/health", headers={"host": "evil.example"}).status_code == 400


def test_mutating_request_requires_csrf_header(client):
    assert client.post("/account").status_code == 403
    assert client.post("/account", headers={"X-Requested-With": "trading-ui"}).status_code == 405


def test_cors_only_allows_ui_origin(client):
    ok = client.options("/account", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    bad = client.options("/account", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "access-control-allow-origin" not in bad.headers
