"""Journal notes, account mode, /api prefix and serving the built UI."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.config import Settings
from backend.mt5_bridge import MT5Bridge

H = {"X-Requested-With": "trading-ui"}


def make(mock, clock, db, **overrides):
    s = Settings(_env_file=None, mt5_mock=True, extra_allowed_hosts="testserver", **overrides)
    return TestClient(create_app(s, bridge=MT5Bridge(s, mt5=mock, clock=clock), db=db))


@pytest.fixture
def client(mock, clock, db, tmp_path):
    with make(mock, clock, db, frontend_dist=tmp_path / "missing") as c:
        yield c


def test_account_mode_is_reported(client):
    assert client.get("/account").json()["account_mode"] == "demo"


def test_journal_note(client, db):
    entry = db.journal_add(action="open", status="blocked", reason="x")
    r = client.patch(f"/journal/{entry.id}", json={"note": "Chased the breakout; wait for the retest."}, headers=H)
    assert r.status_code == 200 and r.json()["note"].startswith("Chased")
    assert client.get("/journal").json()[0]["note"].startswith("Chased")
    assert client.patch("/journal/999", json={"note": "x"}, headers=H).status_code == 404
    assert client.patch(f"/journal/{entry.id}", json={"note": "x" * 2001}, headers=H).status_code == 422
    assert client.patch(f"/journal/{entry.id}", json={"note": "x"}).status_code == 403  # CSRF header


def test_api_prefix_matches_dev_proxy(client):
    assert client.get("/api/health").json() == client.get("/health").json()
    assert client.post("/api/orders", json={"symbol": "EURUSD", "side": "buy", "volume": 0.1}, headers=H).status_code == 422
    with client.websocket_connect("/api/ws/stream", headers={"origin": "http://127.0.0.1:8000"}) as ws:
        ws.send_json({"type": "subscribe", "symbols": ["EURUSD"]})
        assert ws.receive_json()["type"] in {"status", "account", "risk", "positions", "orders", "tick"}


def test_serves_built_ui_without_shadowing_api(mock, clock, db, tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>Pipdesk</title>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log(1)")
    with make(mock, clock, db, frontend_dist=tmp_path) as c:
        assert "Pipdesk" in c.get("/").text
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert c.get("/health").json()["connected"] is True
        assert c.get("/api/account").json()["mock"] is True


def test_own_origin_is_allowed_for_websocket(mock, clock, db, tmp_path):
    with make(mock, clock, db, frontend_dist=tmp_path, app_port=8123) as c:
        with c.websocket_connect("/ws/stream", headers={"origin": "http://localhost:8123"}) as ws:
            ws.send_json({"type": "subscribe", "symbols": []})
            assert ws.receive_json()["type"]
