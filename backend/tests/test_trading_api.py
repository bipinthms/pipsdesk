"""Order endpoints end to end: risk engine → mock MT5 → journal."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.mt5_bridge import MT5Bridge

H = {"X-Requested-With": "trading-ui"}


@pytest.fixture
def client(settings, mock, clock, db):
    app = create_app(settings, bridge=MT5Bridge(settings, mt5=mock, clock=clock), db=db, clock=clock)
    with TestClient(app) as c:
        yield c


def quote(client, symbol="EURUSD"):
    t = client.app.state.bridge.tick(symbol)
    return t.bid, t.ask


def market(client, side="buy", volume=0.5, sl_pips=50, **extra):
    bid, ask = quote(client)
    entry = ask if side == "buy" else bid
    sl = round(entry - sl_pips * 0.0001, 5) if side == "buy" else round(entry + sl_pips * 0.0001, 5)
    body = {"symbol": "EURUSD", "side": side, "order_type": "market", "volume": volume, "sl": sl, **extra}
    return client.post("/orders", json=body, headers=H)


def journal(client, **params):
    return client.get("/journal", params=params).json()


def test_market_order_accepted_and_journaled(client):
    r = market(client)
    assert r.status_code == 200, r.text
    ticket = r.json()["result"]["order"]
    (pos,) = client.get("/positions").json()
    assert pos["ticket"] == ticket and pos["volume"] == 0.5 and pos["sl"] is not None

    (entry,) = journal(client)
    assert entry["status"] == "accepted" and entry["action"] == "open" and entry["ticket"] == ticket
    assert entry["risk_amount"] == pytest.approx(254, abs=5)  # 50 pips + spread on 0.5 lots
    assert entry["details"]["order_type"] == "market"


def test_risk_block_is_422_journaled_and_nothing_sent(client):
    r = client.post("/orders", json={"symbol": "EURUSD", "side": "buy", "volume": 0.1}, headers=H)
    assert r.status_code == 422
    body = r.json()
    assert body["kind"] == "risk" and "stop loss is required" in body["detail"]
    assert client.get("/positions").json() == []
    (entry,) = journal(client)
    assert entry["status"] == "blocked" and "stop loss" in entry["reason"]
    assert client.get("/risk/status").json()["actions_last_minute"] == 0  # blocked attempts aren't sent


def allow_no_sl(client):
    s = client.get("/risk/settings").json()
    client.put("/risk/settings", json={**s, "allow_no_sl_override": True}, headers=H)


def test_no_sl_override_is_off_by_default(client):
    r = client.post("/orders", json={"symbol": "EURUSD", "side": "buy", "volume": 0.1, "allow_no_sl": True}, headers=H)
    assert r.status_code == 422 and "off in Settings" in r.json()["detail"]
    assert client.get("/positions").json() == []


def test_no_sl_override_goes_through_with_warning_when_enabled(client):
    allow_no_sl(client)
    r = client.post("/orders", json={"symbol": "EURUSD", "side": "buy", "volume": 0.1, "allow_no_sl": True}, headers=H)
    assert r.status_code == 200
    assert any("unlimited" in w for w in r.json()["warnings"])


def test_requote_is_broker_rejection(client):
    bid, ask = quote(client)
    r = market(client, price=round(ask - 0.0020, 5), deviation=5)
    assert r.status_code == 409
    assert r.json() == {"detail": r.json()["detail"], "kind": "broker", "violations": [], "retcode": 10004}
    assert "Requote" in r.json()["detail"]
    (entry,) = journal(client)
    assert entry["status"] == "rejected" and entry["retcode"] == 10004
    assert client.get("/risk/status").json()["actions_last_minute"] == 1


def test_market_closed(client, mock):
    mock._mock_set_market_closed("EURUSD", True)
    r = market(client)
    assert r.status_code == 409 and r.json()["retcode"] == 10018 and "Market is closed" in r.json()["detail"]


def test_terminal_down_is_503(client, mock):
    mock._mock_set_terminal_down(True)
    body = {"symbol": "EURUSD", "side": "buy", "volume": 0.1, "sl": 1.0}
    r = client.post("/orders", json=body, headers=H)
    assert r.status_code == 503 and "MetaTrader 5" in r.json()["detail"]


def test_csrf_header_required(client):
    assert client.post("/orders", json={"symbol": "EURUSD", "side": "buy", "volume": 0.1}).status_code == 403


def test_pending_orders(client):
    bid, ask = quote(client)
    body = {"symbol": "EURUSD", "side": "buy", "order_type": "limit", "volume": 0.2,
            "price": round(ask - 0.0030, 5), "sl": round(ask - 0.0080, 5), "tp": round(ask + 0.0050, 5)}
    r = client.post("/orders", json=body, headers=H)
    assert r.status_code == 200, r.text
    (o,) = client.get("/orders").json()
    assert o["type"] == "buy_limit" and o["volume"] == 0.2

    # Modify: move it 10 pips lower with the stop.
    r = client.patch(f"/orders/{o['ticket']}", json={"price": round(ask - 0.0040, 5), "sl": round(ask - 0.0090, 5)}, headers=H)
    assert r.status_code == 200
    assert client.get("/orders").json()[0]["price_open"] == round(ask - 0.0040, 5)

    assert client.delete(f"/orders/{o['ticket']}", headers=H).status_code == 200
    assert client.get("/orders").json() == []
    assert [e["action"] for e in journal(client)] == ["cancel", "modify_order", "pending"]


def test_pending_price_required_and_wrong_side_rejected(client):
    bid, ask = quote(client)
    base = {"symbol": "EURUSD", "side": "buy", "order_type": "limit", "volume": 0.1, "sl": round(ask - 0.01, 5)}
    assert client.post("/orders", json=base, headers=H).status_code == 409
    r = client.post("/orders", json={**base, "price": round(ask + 0.0020, 5)}, headers=H)  # buy limit above market
    assert r.status_code == 409 and r.json()["retcode"] == 10015


def test_modify_position_tighten_and_widen(client):
    market(client, volume=1.0, sl_pips=50)
    (pos,) = client.get("/positions").json()
    t = pos["ticket"]
    tighter = round(pos["price_open"] - 0.0030, 5)
    assert client.patch(f"/positions/{t}", json={"sl": tighter}, headers=H).status_code == 200
    wider = round(pos["price_open"] - 0.0200, 5)  # 200 pips on 1 lot = $2,000 > 1%
    r = client.patch(f"/positions/{t}", json={"sl": wider}, headers=H)
    assert r.status_code == 422 and "per-trade limit" in r.json()["detail"]
    assert client.get("/positions").json()[0]["sl"] == tighter


def test_partial_and_full_close(client):
    market(client, volume=0.5)
    t = client.get("/positions").json()[0]["ticket"]
    assert client.delete(f"/positions/{t}", params={"volume": 0.8}, headers=H).status_code == 409
    assert client.delete(f"/positions/{t}", params={"volume": 0.2}, headers=H).status_code == 200
    assert client.get("/positions").json()[0]["volume"] == pytest.approx(0.3)
    assert client.delete(f"/positions/{t}", headers=H).status_code == 200
    assert client.get("/positions").json() == []
    assert client.delete(f"/positions/{t}", headers=H).json()["retcode"] == 10036
    deals = client.get("/history").json()
    assert sum(1 for d in deals if d["entry"] == "out" and d["position_id"] == t) == 2


def test_rate_limit_blocks_new_orders_but_not_closes(client):
    allow_no_sl(client)
    for _ in range(3):
        assert market(client, volume=0.1).status_code == 200
    t = client.get("/positions").json()[0]["ticket"]
    assert client.patch(f"/positions/{t}", json={"sl": None, "allow_no_sl": True}, headers=H).status_code == 200
    assert client.delete(f"/positions/{t}", params={"volume": 0.05}, headers=H).status_code == 200
    # 5 actions sent in the last minute: the next new order is blocked...
    r = market(client, volume=0.1)
    assert r.status_code == 422 and r.json()["detail"].startswith("Rate limit")
    # ...but closing still works.
    assert client.delete(f"/positions/{t}", headers=H).status_code == 200


def test_flatten_all(client):
    market(client, volume=0.1)
    market(client, side="sell", volume=0.1)
    bid, ask = quote(client)
    client.post("/orders", json={"symbol": "EURUSD", "side": "sell", "order_type": "limit", "volume": 0.1,
                                 "price": round(bid + 0.003, 5), "sl": round(bid + 0.006, 5)}, headers=H)
    r = client.post("/positions/flatten", headers=H).json()
    assert len(r["closed"]) == 2 and len(r["cancelled"]) == 1 and r["errors"] == []
    assert client.get("/positions").json() == [] and client.get("/orders").json() == []


def test_concurrent_orders_cannot_both_pass(client):
    s = client.get("/risk/settings").json()
    client.put("/risk/settings", json={**s, "max_open_positions": 1}, headers=H)
    with ThreadPoolExecutor(4) as pool:
        codes = sorted(pool.map(lambda _: market(client, volume=0.1).status_code, range(4)))
    assert codes == [200, 422, 422, 422]
    assert len(client.get("/positions").json()) == 1


def test_journal_filter_and_paging(client):
    market(client)
    client.post("/orders", json={"symbol": "EURUSD", "side": "buy", "volume": 0.1}, headers=H)
    assert [e["status"] for e in journal(client)] == ["blocked", "accepted"]
    assert [e["status"] for e in journal(client, status="blocked")] == ["blocked"]
    newest = journal(client)[0]["id"]
    assert [e["status"] for e in journal(client, before_id=newest)] == ["accepted"]


def test_closing_never_depends_on_the_server_clock_symbol(mock, clock, db):
    """SERVER_TIME_SYMBOL missing on this broker: new risk is blocked, getting flat still works."""
    from backend.config import Settings

    s = Settings(_env_file=None, mt5_mock=True, extra_allowed_hosts="testserver", server_time_symbol="EURUSD.raw")
    app = create_app(s, bridge=MT5Bridge(s, mt5=mock, clock=clock), db=db, clock=clock)
    with TestClient(app) as c:
        b = c.app.state.bridge
        bid, ask = quote(c)
        # Opened outside the app (terminal or phone).
        p1 = b.market_order("EURUSD", "buy", 0.2, sl=round(bid - 0.0050, 5)).order
        p2 = b.market_order("EURUSD", "buy", 0.2, sl=round(bid - 0.0050, 5)).order
        o1 = b.pending_order("EURUSD", "buy_limit", 0.1, round(ask - 0.0030, 5), sl=round(ask - 0.0080, 5)).order
        o2 = b.pending_order("EURUSD", "buy_limit", 0.1, round(ask - 0.0040, 5), sl=round(ask - 0.0090, 5)).order

        r = market(c, volume=0.1)
        assert r.status_code == 422 and "server clock" in r.json()["detail"]

        assert c.patch(f"/positions/{p1}", json={"sl": round(bid - 0.0020, 5)}, headers=H).status_code == 200
        assert c.delete(f"/positions/{p1}", params={"volume": 0.1}, headers=H).status_code == 200
        assert c.delete(f"/positions/{p1}", headers=H).status_code == 200
        assert c.delete(f"/orders/{o1}", headers=H).status_code == 200
        flat = c.post("/positions/flatten", headers=H).json()
        assert flat == {"closed": [p2], "cancelled": [o2], "errors": []}
        assert c.get("/positions").json() == [] and c.get("/orders").json() == []


def test_orders_work_when_empty_lists_come_back_as_none(client, mock):
    mock._mock_set_quirks(empty_as_none=True)
    assert client.get("/positions").json() == [] and client.get("/orders").json() == []
    r = market(client, volume=0.1)
    assert r.status_code == 200, r.text
    assert len(client.get("/positions").json()) == 1


def test_an_order_mt5_hasnt_listed_yet_still_counts(client, mock, clock):
    """A real terminal can list a new position a moment after order_send returns."""
    mock._mock_set_quirks(list_lag_s=2.0)
    s = client.get("/risk/settings").json()
    client.put("/risk/settings", json={**s, "max_open_positions": 1}, headers=H)
    assert market(client, volume=0.1).status_code == 200
    assert client.get("/positions").json() == []  # not listed yet
    r = market(client, volume=0.1)
    assert r.status_code == 422 and "Max open positions" in r.json()["detail"]
    clock.advance(3)  # listed now: counted once, not twice
    assert len(client.get("/positions").json()) == 1
    check = {"action": "open", "symbol": "EURUSD", "side": "buy", "volume": 0.1, "sl": 1.0}
    assert "Max open positions reached: 1" in client.post("/risk/check", json=check, headers=H).json()["violations"][0]
    clock.advance(15)
    assert "Max open positions reached: 1" in client.post("/risk/check", json=check, headers=H).json()["violations"][0]


def test_a_pending_order_mt5_hasnt_listed_yet_still_counts(client, mock):
    mock._mock_set_quirks(list_lag_s=2.0)
    s = client.get("/risk/settings").json()
    client.put("/risk/settings", json={**s, "max_total_lots": 0.15}, headers=H)
    bid, ask = quote(client)
    body = {"symbol": "EURUSD", "side": "buy", "order_type": "limit", "volume": 0.1,
            "price": round(ask - 0.0030, 5), "sl": round(ask - 0.0080, 5)}
    assert client.post("/orders", json=body, headers=H).status_code == 200
    r = client.post("/orders", json=body, headers=H)
    assert r.status_code == 422 and "Total volume" in r.json()["detail"]


# --- unclear outcomes and resubmits -------------------------------------------------


def _reply_lost(mock, monkeypatch, execute: bool = True):
    """order_send reaches the server (or not), but the reply never comes back."""
    real = mock.order_send
    state = {"error": None}

    def send(request):
        if execute:
            real(request)
        state["error"] = (-10002, "IPC recv failed")
        return None

    monkeypatch.setattr(mock, "order_send", send)
    monkeypatch.setattr(mock, "last_error", lambda: state["error"] or (1, "Success"))
    return lambda: monkeypatch.setattr(mock, "order_send", real)


def test_lost_reply_is_reported_as_unknown_not_as_a_failure(client, mock, monkeypatch):
    _reply_lost(mock, monkeypatch, execute=True)
    r = market(client, volume=0.1)
    # The order is tagged, so it's found in MT5 straight away and reported as placed.
    assert r.status_code == 200, r.text
    assert any("listed in MT5" in w for w in r.json()["warnings"])
    (pos,) = client.get("/positions").json()
    assert pos["comment"].startswith("pd:")


def test_unclear_outcome_not_found_is_unknown_and_resubmit_is_safe(client, mock, monkeypatch, clock):
    restore = _reply_lost(mock, monkeypatch, execute=False)
    body_id = "3f2c9a1e-7b4d-4c1a-9e2f-0a1b2c3d4e5f"
    r = market(client, volume=0.1, client_order_id=body_id)
    assert r.status_code == 503 and r.json()["kind"] == "unknown"
    assert "may or may not" in r.json()["detail"]
    (entry,) = journal(client)
    assert entry["status"] == "unknown" and entry["details"]["tag"].startswith("pd:")
    restore()
    clock.advance(1)  # reconnect allowed again
    # Same id again: not listed in MT5, so it is refused rather than sent a second time.
    r = market(client, volume=0.1, client_order_id=body_id)
    assert r.status_code == 502 and r.json()["kind"] == "unknown" and "earlier attempt" in r.json()["detail"]
    assert client.get("/positions").json() == []
    assert journal(client, status="unknown")[0]["id"] == entry["id"]


def test_unclear_outcome_counts_as_exposure_for_a_while(client, mock, monkeypatch, clock):
    s = client.get("/risk/settings").json()
    client.put("/risk/settings", json={**s, "max_open_positions": 1}, headers=H)
    restore = _reply_lost(mock, monkeypatch, execute=False)
    assert market(client, volume=0.1).json()["kind"] == "unknown"
    restore()
    clock.advance(1)
    r = market(client, volume=0.1)  # a new order: maybe the first one was placed
    assert r.status_code == 422 and "Max open positions" in r.json()["detail"]
    clock.advance(61)
    assert market(client, volume=0.1).status_code == 200


def test_resubmitting_the_same_order_returns_the_first_result(client):
    body_id = "a1b2c3d4-0000-4000-8000-000000000001"
    first = market(client, volume=0.1, client_order_id=body_id)
    again = market(client, volume=0.1, client_order_id=body_id)
    assert first.status_code == again.status_code == 200
    assert again.json()["result"] == first.json()["result"]
    assert any("already sent" in w for w in again.json()["warnings"])
    assert len(client.get("/positions").json()) == 1
    assert [e["status"] for e in journal(client)] == ["accepted"]


def test_concurrent_resubmits_place_one_order(client):
    body_id = "a1b2c3d4-0000-4000-8000-000000000002"
    with ThreadPoolExecutor(4) as pool:
        codes = list(pool.map(lambda _: market(client, volume=0.1, client_order_id=body_id).status_code, range(4)))
    assert codes == [200] * 4
    assert len(client.get("/positions").json()) == 1


def test_timeout_retcode_is_unknown(client, mock, monkeypatch):
    def timeout(request):
        return mock.OrderSendResult(10012, 0, 0, 0.0, 0.0, 0.0, 0.0, "Timeout", 0, 0, request)

    monkeypatch.setattr(mock, "order_send", timeout)
    r = market(client, volume=0.1)
    assert r.status_code == 409 and r.json()["kind"] == "unknown" and r.json()["retcode"] == 10012


def test_journal_failure_after_a_fill_is_not_an_error(client, monkeypatch):
    db = client.app.state.db
    real = db.journal_add

    def flaky(**fields):
        if fields.get("status") == "accepted":
            raise RuntimeError("database is locked")
        return real(**fields)

    monkeypatch.setattr(db, "journal_add", flaky)
    r = market(client, volume=0.1)
    assert r.status_code == 200
    assert any("journal entry couldn't be saved" in w for w in r.json()["warnings"])
    assert len(client.get("/positions").json()) == 1


def test_client_order_id_is_validated(client):
    assert market(client, volume=0.1, client_order_id="bad id!").status_code == 422
