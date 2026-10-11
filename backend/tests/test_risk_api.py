"""Risk service + endpoints against the mock terminal and an in-memory DB."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.mt5_bridge import MT5Bridge

CSRF = {"X-Requested-With": "trading-ui"}


@pytest.fixture
def app(settings, mock, clock, db):
    return create_app(settings, bridge=MT5Bridge(settings, mt5=mock, clock=clock), db=db, clock=clock)


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


def eurusd(client):
    tick = client.app.state.bridge.tick("EURUSD")
    return tick.bid, tick.ask


def test_default_settings(client):
    s = client.get("/risk/settings").json()
    assert s["daily_loss_pct"] == 5.0 and s["max_drawdown_pct"] == 10.0 and s["commission_per_lot"] == 0.0


def test_settings_validated_persisted_and_journaled(client, settings, mock, clock, db):
    s = client.get("/risk/settings").json()
    bad = client.put("/risk/settings", json={**s, "max_actions_per_minute": 100}, headers=CSRF)
    assert bad.status_code == 422

    r = client.put("/risk/settings", json={**s, "daily_loss_pct": 4.0, "initial_balance": 100_000}, headers=CSRF)
    assert r.status_code == 200 and r.json()["daily_loss_pct"] == 4.0

    (entry,) = db.journal_list(status="info")
    assert entry.action == "settings" and "daily_loss_pct" in entry.reason

    # A fresh app on the same DB sees the saved settings.
    with TestClient(create_app(settings, bridge=MT5Bridge(settings, mt5=mock, clock=clock), db=db, clock=clock)) as c2:
        assert c2.get("/risk/settings").json()["daily_loss_pct"] == 4.0


def test_settings_change_requires_csrf_header(client):
    s = client.get("/risk/settings").json()
    assert client.put("/risk/settings", json=s).status_code == 403


def test_status_captures_day_anchor(client, db):
    st = client.get("/risk/status").json()
    assert st["daily"]["base"] == 100_000 and st["daily"]["floor"] == 95_000 and st["daily"]["level"] == "ok"
    assert st["drawdown"]["floor"] == 90_000
    assert st["initial_balance_source"] == "observed"
    assert db.get_json("risk_state")["day_start_balance"] == 100_000


def test_check_market_order(client):
    bid, ask = eurusd(client)
    body = {"action": "open", "symbol": "EURUSD", "side": "buy", "volume": 1.0,
            "sl": round(ask - 0.0050, 5), "tp": round(ask + 0.0100, 5)}
    d = client.post("/risk/check", json=body, headers=CSRF).json()
    assert d["allowed"] is True
    assert d["trade_risk"] == pytest.approx(500, abs=1)
    assert d["reward_risk"] == pytest.approx(2.0, abs=0.01)


def test_check_blocks_and_explains(client):
    bid, ask = eurusd(client)
    no_sl = client.post("/risk/check", json={"action": "open", "symbol": "EURUSD", "side": "sell", "volume": 0.1}, headers=CSRF).json()
    assert no_sl["allowed"] is False and "stop loss is required" in no_sl["violations"][0]

    huge = {"action": "open", "symbol": "EURUSD", "side": "buy", "volume": 5.0, "sl": round(ask - 0.0050, 5)}
    d = client.post("/risk/check", json=huge, headers=CSRF).json()
    assert d["allowed"] is False and any("per-trade limit" in v for v in d["violations"])


def test_check_pending_order(client):
    bid, ask = eurusd(client)
    body = {"action": "pending", "symbol": "EURUSD", "side": "buy", "volume": 0.5,
            "price": round(ask - 0.0020, 5), "sl": round(ask - 0.0070, 5)}
    d = client.post("/risk/check", json=body, headers=CSRF).json()
    assert d["allowed"] and d["trade_risk"] == pytest.approx(250, abs=1)


def test_check_unknown_symbol_is_404(client):
    r = client.post("/risk/check", json={"action": "open", "symbol": "NOPE", "side": "buy", "volume": 1}, headers=CSRF)
    assert r.status_code == 404


def test_news_crud_and_blackout(client, clock):
    bid, ask = eurusd(client)
    order = {"action": "open", "symbol": "EURUSD", "side": "buy", "volume": 0.1, "sl": round(ask - 0.0050, 5)}
    assert client.post("/risk/check", json=order, headers=CSRF).json()["allowed"]

    r = client.post("/risk/news", json={"time_utc": int(clock.t) + 30, "title": "NFP"}, headers=CSRF)
    assert r.status_code == 201
    event = r.json()
    assert client.get("/risk/news").json() == [event]

    d = client.post("/risk/check", json=order, headers=CSRF).json()
    assert not d["allowed"] and "News blackout" in d["violations"][0]
    assert client.get("/risk/status").json()["news_blackout_active"] is True

    assert client.delete(f"/risk/news/{event['id']}", headers=CSRF).status_code == 204
    assert client.delete(f"/risk/news/{event['id']}", headers=CSRF).status_code == 404
    assert client.post("/risk/check", json=order, headers=CSRF).json()["allowed"]


def test_rate_limit_through_service(client):
    risk = client.app.state.risk
    for _ in range(5):
        risk.record_action()
    bid, ask = eurusd(client)
    order = {"action": "open", "symbol": "EURUSD", "side": "buy", "volume": 0.1, "sl": round(ask - 0.0050, 5)}
    d = client.post("/risk/check", json=order, headers=CSRF).json()
    assert not d["allowed"] and d["violations"][0].startswith("Rate limit")
    assert client.get("/risk/status").json()["actions_last_minute"] == 5


def test_worst_case_counts_live_positions(client):
    bridge = client.app.state.bridge
    bid, ask = eurusd(client)
    # Two open buys, 1.0 lot each with a 50 pip stop: $1,000 at risk.
    for _ in range(2):
        bridge.market_order("EURUSD", "buy", 1.0, sl=round(bid - 0.0050, 5))
    bid, ask = eurusd(client)
    order = {"action": "open", "symbol": "EURUSD", "side": "buy", "volume": 1.0, "sl": round(ask - 0.0050, 5)}
    d = client.post("/risk/check", json=order, headers=CSRF).json()
    assert d["allowed"]
    assert d["worst_case_equity"] == pytest.approx(100_000 - 1_500 - 2 * 16, abs=40)  # spread on entry


def test_switching_accounts_blocks_new_orders_until_limits_are_confirmed(client, mock, db):
    assert client.get("/risk/status").json()["account_changed"] is False  # first account adopted
    mock._mock_switch_account(87_654_321, "FundingPips-Server", 200_000)
    st = client.get("/risk/status").json()
    assert st["account_changed"] is True
    assert st["daily"]["base"] == 200_000 and st["drawdown"]["floor"] == 180_000  # not the old account's 95k/90k

    bid, ask = eurusd(client)
    order = {"symbol": "EURUSD", "side": "buy", "volume": 0.1, "sl": round(ask - 0.0050, 5)}
    r = client.post("/orders", json=order, headers=CSRF)
    assert r.status_code == 422 and "different MT5 account" in r.json()["detail"]
    # A position opened in the terminal on the new account can still be closed.
    ticket = client.app.state.bridge.market_order("EURUSD", "buy", 0.1).order
    assert client.delete(f"/positions/{ticket}", headers=CSRF).status_code == 200

    s = client.get("/risk/settings").json()
    assert client.put("/risk/settings", json=s, headers=CSRF).status_code == 200
    assert client.get("/risk/status").json()["account_changed"] is False
    assert client.post("/orders", json=order, headers=CSRF).status_code == 200
    assert any("confirmed for a new MT5 account" in e.reason for e in db.journal_list(status="info"))


def test_terminal_on_another_account_than_configured_blocks_new_orders(mock, clock, db, settings):
    from backend.risk import OrderIntent
    from backend.risk_service import RiskService

    bridge = MT5Bridge(settings, mt5=mock, clock=clock)
    assert bridge.connect()
    tick = bridge.tick("EURUSD")
    intent = OrderIntent("open", "EURUSD", "buy", 0.1, tick.ask, round(tick.ask - 0.005, 5))
    wrong = RiskService(db, bridge, "EURUSD", clock=clock, expected_login=999)
    assert "different account from MT5_LOGIN" in wrong.evaluate(intent).violations[0]
    right = RiskService(db, bridge, "EURUSD", clock=clock, expected_login=12_345_678)
    assert right.evaluate(intent).allowed
