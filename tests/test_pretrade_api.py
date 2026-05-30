"""API test for /risk/pretrade."""
from __future__ import annotations

import os
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def test_pretrade_basic():
    c = TestClient(app)
    r = c.post("/risk/pretrade", headers=HEAD, json={
        "ticker": "AAPL", "side": "long",
        "price": 100, "stop": 95, "target": 110, "equity": 10_000,
        "risk_per_trade": 0.01, "max_position_pct": 1.0,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accepted"] is True
    assert body["shares"] == 20
    assert body["cap_reason"] == "risk_per_trade"
    assert body["planned_r_multiple"] == 2.0


def test_pretrade_with_costs_reduces_shares():
    c = TestClient(app)
    r = c.post("/risk/pretrade", headers=HEAD, json={
        "ticker": "X", "side": "long",
        "price": 100, "stop": 95, "target": 110, "equity": 10_000,
        "risk_per_trade": 0.01, "max_position_pct": 1.0,
        "cost": {"commission_per_trade": 30.0},
    })
    body = r.json()
    assert body["shares"] == 14
    assert body["fees"] == 30.0


def test_pretrade_bad_geometry_returns_400():
    c = TestClient(app)
    r = c.post("/risk/pretrade", headers=HEAD, json={
        "ticker": "X", "side": "long",
        "price": 100, "stop": 105, "target": 110, "equity": 10_000,
    })
    assert r.status_code == 400


def test_pretrade_requires_api_key():
    c = TestClient(app)
    r = c.post("/risk/pretrade", json={
        "ticker": "X", "side": "long",
        "price": 100, "stop": 95, "target": 110, "equity": 10_000,
    })
    assert r.status_code in (401, 403)
