"""API tests for bracket order plans."""
from __future__ import annotations

import os
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app as _fastapi_app
from signalclaw.config import get_settings

HEAD = {"x-api-key": "test-key"}


@pytest.fixture(autouse=True)
def _reset_brackets():
    s = get_settings()
    p = s.data_dir / "brackets.json"
    if p.exists():
        p.unlink()
    yield
    if p.exists():
        p.unlink()


def _client():
    return TestClient(_fastapi_app)


def test_create_list_get_remove():
    c = _client()
    r = c.post("/brackets", headers=HEAD, json={
        "ticker": "aapl", "side": "long",
        "entry": 100, "stop": 95, "target": 110, "shares": 10,
    })
    assert r.status_code == 200, r.text
    plan = r.json()
    assert plan["ticker"] == "AAPL"
    assert plan["planned_r_multiple"] == 2.0
    pid = plan["id"]

    r = c.get("/brackets", headers=HEAD)
    assert r.status_code == 200
    assert any(p["id"] == pid for p in r.json()["plans"])

    r = c.get(f"/brackets/{pid}", headers=HEAD)
    assert r.status_code == 200
    assert r.json()["status"] == "open"

    r = c.delete(f"/brackets/{pid}", headers=HEAD)
    assert r.status_code == 200
    assert c.get(f"/brackets/{pid}", headers=HEAD).status_code == 404


def test_geometry_validation():
    c = _client()
    r = c.post("/brackets", headers=HEAD, json={
        "ticker": "AAPL", "side": "long", "entry": 100, "stop": 105,
        "target": 110, "shares": 1,
    })
    assert r.status_code == 400


def test_fill_close_lifecycle():
    c = _client()
    r = c.post("/brackets", headers=HEAD, json={
        "ticker": "MSFT", "side": "long",
        "entry": 400, "stop": 380, "target": 440, "shares": 5,
    })
    pid = r.json()["id"]

    r = c.post(f"/brackets/{pid}/close", headers=HEAD,
                json={"actual_exit": 440, "reason": "target"})
    assert r.status_code == 400

    r = c.post(f"/brackets/{pid}/fill", headers=HEAD, json={"actual_entry": 401})
    assert r.status_code == 200
    assert r.json()["status"] == "filled"

    r = c.post(f"/brackets/{pid}/close", headers=HEAD,
                json={"actual_exit": 441, "reason": "target"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "closed"
    assert body["realized_r"] == 2.0


def test_cancel_and_invalid_reason():
    c = _client()
    r = c.post("/brackets", headers=HEAD, json={
        "ticker": "X", "side": "long", "entry": 10, "stop": 9, "target": 12, "shares": 1,
    })
    pid = r.json()["id"]
    r = c.post(f"/brackets/{pid}/cancel", headers=HEAD)
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"

    r = c.post("/brackets", headers=HEAD, json={
        "ticker": "X", "side": "long", "entry": 10, "stop": 9, "target": 12, "shares": 1,
    })
    pid2 = r.json()["id"]
    c.post(f"/brackets/{pid2}/fill", headers=HEAD, json={"actual_entry": 10})
    r = c.post(f"/brackets/{pid2}/close", headers=HEAD,
                json={"actual_exit": 11, "reason": "moon"})
    assert r.status_code == 400


def test_list_filters_and_stats():
    c = _client()
    for body in [
        {"ticker": "AAPL", "side": "long", "entry": 100, "stop": 95, "target": 110, "shares": 1},
        {"ticker": "MSFT", "side": "long", "entry": 200, "stop": 190, "target": 220, "shares": 1},
    ]:
        c.post("/brackets", headers=HEAD, json=body)

    r = c.get("/brackets?ticker=AAPL", headers=HEAD)
    assert [p["ticker"] for p in r.json()["plans"]] == ["AAPL"]

    r = c.get("/brackets?status=closed", headers=HEAD)
    assert r.json()["plans"] == []

    r = c.get("/brackets?status=banana", headers=HEAD)
    assert r.status_code == 400

    r = c.get("/brackets/stats", headers=HEAD)
    assert r.status_code == 200
    stats = r.json()
    assert stats["total"] == 2
    assert stats["open"] == 2


def test_requires_api_key():
    c = _client()
    r = c.post("/brackets", json={
        "ticker": "X", "side": "long", "entry": 10, "stop": 9, "target": 12, "shares": 1,
    })
    assert r.status_code in (401, 403)
