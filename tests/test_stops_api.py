from __future__ import annotations
import os
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def test_stops_requires_key():
    c = TestClient(app)
    assert c.get("/stops").status_code in (401, 403)


def test_stops_crud():
    c = TestClient(app)
    r = c.post("/stops", headers=HEAD, json={
        "ticker": "MSFT", "kind": "stop_loss", "value": 300.0, "note": "t",
    })
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    r = c.get("/stops", headers=HEAD)
    assert any(rule["id"] == rid for rule in r.json()["rules"])
    r = c.delete(f"/stops/{rid}", headers=HEAD)
    assert r.status_code == 200
    assert c.delete(f"/stops/{rid}", headers=HEAD).status_code == 404


def test_stops_validation_trailing_fraction():
    c = TestClient(app)
    r = c.post("/stops", headers=HEAD, json={
        "ticker": "MSFT", "kind": "trailing", "value": 5.0,
    })
    assert r.status_code == 400


def test_stops_validation_negative_price():
    c = TestClient(app)
    r = c.post("/stops", headers=HEAD, json={
        "ticker": "MSFT", "kind": "stop_loss", "value": -1.0,
    })
    assert r.status_code == 400


def test_stops_validation_bad_kind():
    c = TestClient(app)
    r = c.post("/stops", headers=HEAD, json={
        "ticker": "MSFT", "kind": "garbage", "value": 1.0,
    })
    assert r.status_code == 400


def test_stops_check_endpoint_structure():
    c = TestClient(app)
    r = c.post("/stops/check", headers=HEAD)
    assert r.status_code == 200
    body = r.json()
    assert "checked" in body and "events" in body
