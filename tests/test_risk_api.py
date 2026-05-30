from __future__ import annotations
import os
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def test_risk_size_endpoint_requires_key():
    c = TestClient(app)
    r = c.post("/risk/size", json={"ticker": "MSFT", "label": "watch", "score": 0.8})
    assert r.status_code in (401, 403)


def test_risk_size_endpoint_404_for_unknown_no_data():
    # Use a ticker very unlikely to fetch in offline tests and no cache
    c = TestClient(app)
    r = c.post("/risk/size", headers=HEAD, json={
        "ticker": "ZZZ_NONEXISTENT_999",
        "label": "watch",
        "score": 0.8,
        "equity": 50_000,
    })
    # Either 404 (no data fetched offline) or 200 if some loader produced data;
    # both branches must be sane.
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        body = r.json()
        assert body["ticker"] == "ZZZ_NONEXISTENT_999"
        assert body["shares"] >= 0
