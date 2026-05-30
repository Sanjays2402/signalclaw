from __future__ import annotations
import os
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def test_portfolio_api_add_list_remove():
    c = TestClient(app)
    r = c.post("/portfolio/trades", headers=HEAD, json={
        "ticker": "msft", "side": "buy", "quantity": 10, "price": 100,
        "date": "2026-01-01",
    })
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    assert r.json()["ticker"] == "MSFT"

    r = c.get("/portfolio/trades", headers=HEAD)
    assert r.status_code == 200
    assert any(t["id"] == tid for t in r.json()["trades"])

    r = c.get("/portfolio/snapshot", headers=HEAD)
    assert r.status_code == 200
    body = r.json()
    assert "positions" in body and "total_cost" in body

    r = c.delete(f"/portfolio/trades/{tid}", headers=HEAD)
    assert r.status_code == 200
    r = c.delete(f"/portfolio/trades/{tid}", headers=HEAD)
    assert r.status_code == 404


def test_portfolio_api_rejects_bad_side():
    c = TestClient(app)
    r = c.post("/portfolio/trades", headers=HEAD, json={
        "ticker": "X", "side": "short", "quantity": 1, "price": 1, "date": "2026-01-01",
    })
    assert r.status_code == 400


def test_portfolio_api_requires_key():
    c = TestClient(app)
    assert c.get("/portfolio/trades").status_code in (401, 403)
    assert c.get("/portfolio/snapshot").status_code in (401, 403)
