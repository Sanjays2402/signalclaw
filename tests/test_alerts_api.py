from __future__ import annotations
import os
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def test_alerts_api_crud_and_check():
    c = TestClient(app)
    # initial empty
    r = c.get("/alerts", headers=HEAD)
    assert r.status_code == 200
    # add
    r = c.post("/alerts", headers=HEAD, json={
        "ticker": "msft", "condition": "price_above", "value": 100.0,
        "note": "test", "cooldown_hours": 1,
    })
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    assert r.json()["ticker"] == "MSFT"
    # list filters
    r = c.get("/alerts?ticker=MSFT", headers=HEAD)
    assert any(a["id"] == aid for a in r.json()["alerts"])
    # check endpoint (no ohlcv likely, fetch may fail offline; tolerate)
    r = c.post("/alerts/check", headers=HEAD)
    assert r.status_code == 200
    body = r.json()
    assert "checked" in body and "hits" in body
    # remove
    r = c.delete(f"/alerts/{aid}", headers=HEAD)
    assert r.status_code == 200
    # remove again -> 404
    r = c.delete(f"/alerts/{aid}", headers=HEAD)
    assert r.status_code == 404


def test_alerts_api_rejects_bad_condition():
    c = TestClient(app)
    r = c.post("/alerts", headers=HEAD, json={
        "ticker": "X", "condition": "garbage", "value": 1,
    })
    assert r.status_code == 400


def test_alerts_api_requires_key():
    c = TestClient(app)
    r = c.get("/alerts")
    assert r.status_code in (401, 403)
