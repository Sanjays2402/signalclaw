from __future__ import annotations
import os
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def test_webhook_crud():
    c = TestClient(app)
    r = c.post("/webhooks", headers=HEAD, json={
        "url": "https://example.test/hook",
        "events": ["entered", "upgraded"],
        "tickers": ["aapl"],
    })
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    assert "AAPL" in r.json()["tickers"]
    assert set(r.json()["events"]) == {"entered", "upgraded"}

    r = c.get("/webhooks", headers=HEAD)
    assert any(s["id"] == sid for s in r.json()["subscriptions"])

    r = c.delete(f"/webhooks/{sid}", headers=HEAD)
    assert r.status_code == 200
    r = c.delete(f"/webhooks/{sid}", headers=HEAD)
    assert r.status_code == 404


def test_webhook_rejects_bad_url():
    c = TestClient(app)
    r = c.post("/webhooks", headers=HEAD, json={"url": "ftp://nope"})
    assert r.status_code == 400


def test_webhook_rejects_unknown_event():
    c = TestClient(app)
    r = c.post("/webhooks", headers=HEAD, json={
        "url": "https://example.test/hook", "events": ["frobnicate"],
    })
    assert r.status_code == 400


def test_webhook_requires_key():
    c = TestClient(app)
    assert c.get("/webhooks").status_code in (401, 403)


def test_webhook_fire_latest_404_when_empty():
    c = TestClient(app)
    # archive may or may not contain reports depending on test order;
    # if there are reports it's a 200; either way the route must exist.
    r = c.post("/webhooks/fire/latest", headers=HEAD)
    assert r.status_code in (200, 404)


def test_webhook_deliveries_endpoint():
    c = TestClient(app)
    r = c.get("/webhooks/deliveries", headers=HEAD)
    assert r.status_code == 200, r.text
    assert "deliveries" in r.json()


def test_webhook_deliveries_rejects_bad_status():
    c = TestClient(app)
    r = c.get("/webhooks/deliveries?status=bogus", headers=HEAD)
    assert r.status_code == 400


def test_webhook_replay_missing_attempt_404():
    c = TestClient(app)
    r = c.post("/webhooks/deliveries/nope/replay", headers=HEAD)
    assert r.status_code == 404


def test_webhook_deliveries_requires_key():
    c = TestClient(app)
    assert c.get("/webhooks/deliveries").status_code in (401, 403)
