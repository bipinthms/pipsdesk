from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.mt5_bridge import MT5Bridge

H = {"X-Requested-With": "trading-ui"}


@pytest.fixture
def client(settings, mock, clock, db):
    with TestClient(create_app(settings, bridge=MT5Bridge(settings, mt5=mock, clock=clock), db=db, clock=clock)) as c:
        yield c


DRAWINGS = [
    {"id": "h1", "type": "hline", "points": [{"time": 0, "price": 1.085}], "showLabel": True},
    {"id": "t1", "type": "trend", "points": [{"time": 1000, "price": 1.08}, {"time": 5000, "price": 1.09}],
     "color": "#ff8800", "width": 3, "dash": "dashed", "extendRight": True},
    {"id": "r1", "type": "rect", "points": [{"time": 1000, "price": 1.07}, {"time": 9000, "price": 1.075}], "fill": 0.2},
    {"id": "f1", "type": "fib", "points": [{"time": 1000, "price": 1.07}, {"time": 9000, "price": 1.09}],
     "levels": [0, 0.5, 1.618]},
    {"id": "x1", "type": "text", "points": [{"time": 1000, "price": 1.07}], "text": "Breakout", "fontSize": 16},
    {"id": "l1", "type": "long", "points": [{"time": 1000, "price": 1.08}, {"time": 9000, "price": 1.07},
                                            {"time": 9000, "price": 1.1}], "pane": "2", "locked": True},
    {"id": "c1", "type": "channel", "points": [{"time": 1, "price": 1}, {"time": 2, "price": 2}, {"time": 3, "price": 1}]},
]


def test_empty_by_default(client):
    assert client.get("/drawings/EURUSD").json() == {"symbol": "EURUSD", "drawings": []}


def test_save_and_load_per_symbol(client):
    r = client.put("/drawings/EURUSD", json={"drawings": DRAWINGS}, headers=H)
    assert r.status_code == 200
    assert r.json()["drawings"] == DRAWINGS
    assert client.get("/drawings/EURUSD").json()["drawings"] == DRAWINGS
    assert client.get("/drawings/GBPUSD").json()["drawings"] == []
    # Replace semantics
    client.put("/drawings/EURUSD", json={"drawings": DRAWINGS[:1]}, headers=H)
    assert client.get("/drawings/EURUSD").json()["drawings"] == DRAWINGS[:1]


def test_legacy_drawings_are_converted(client, db):
    # Saved by the earlier version: {price} and {p1, p2}
    db.set_json("drawings:EURUSD", [
        {"id": "h1", "type": "hline", "price": 1.085},
        {"id": "t1", "type": "trend", "p1": {"time": 1000, "price": 1.08}, "p2": {"time": 5000, "price": 1.09}, "color": "#ff8800"},
    ])
    assert client.get("/drawings/EURUSD").json()["drawings"] == [
        {"id": "h1", "type": "hline", "points": [{"time": 0, "price": 1.085}]},
        {"id": "t1", "type": "trend", "points": [{"time": 1000, "price": 1.08}, {"time": 5000, "price": 1.09}], "color": "#ff8800"},
    ]
    legacy_put = {"id": "r1", "type": "rect", "p1": {"time": 1, "price": 1}, "p2": {"time": 2, "price": 2}}
    assert client.put("/drawings/EURUSD", json={"drawings": [legacy_put]}, headers=H).status_code == 200


P = {"time": 1, "price": 1}


@pytest.mark.parametrize(
    "bad",
    [
        {"id": "x", "type": "circle", "points": [P]},
        {"id": "x", "type": "hline"},
        {"id": "bad id!", "type": "hline", "points": [P]},
        {"id": "x", "type": "hline", "points": [P], "color": "red"},
        {"id": "x", "type": "trend", "p1": P},
        {"id": "x", "type": "trend", "points": [P]},
        {"id": "x", "type": "channel", "points": [P, P]},
        {"id": "x", "type": "hline", "points": [P], "width": 9},
        {"id": "x", "type": "hline", "points": [P], "dash": "wavy"},
        {"id": "x", "type": "rect", "points": [P, P], "fill": 2},
        {"id": "x", "type": "text", "points": [P], "text": "x" * 501},
        {"id": "x", "type": "fib", "points": [P, P], "levels": [0.5] * 21},
    ],
)
def test_validation(client, bad):
    assert client.put("/drawings/EURUSD", json={"drawings": [bad]}, headers=H).status_code == 422


def test_limits_and_symbol_pattern(client):
    many = [{"id": f"h{i}", "type": "hline", "points": [P]} for i in range(501)]
    assert client.put("/drawings/EURUSD", json={"drawings": many}, headers=H).status_code == 422
    assert client.get("/drawings/EUR%20USD").status_code == 422
    assert client.put("/drawings/US30.cash", json={"drawings": []}, headers=H).status_code == 200


def test_requires_csrf_header(client):
    assert client.put("/drawings/EURUSD", json={"drawings": []}).status_code == 403
