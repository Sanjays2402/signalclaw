"""API tests for news events."""
from __future__ import annotations

import os
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app
from signalclaw.config import get_settings

HEAD = {"x-api-key": "test-key"}


@pytest.fixture(autouse=True)
def _reset_events():
    s = get_settings()
    p = s.data_dir / "news_events.json"
    if p.exists():
        p.unlink()
    yield
    if p.exists():
        p.unlink()


def _c():
    return TestClient(app)


def test_create_list_remove():
    c = _c()
    r = c.post("/news-events", headers=HEAD, json={
        "ticker": "aapl", "headline": "Apple beats", "event_date": "2026-04-01",
        "tags": ["Earnings", "beat"], "source": "reuters",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ticker"] == "AAPL"
    assert body["tags"] == ["beat", "earnings"]
    eid = body["id"]

    r = c.get("/news-events", headers=HEAD)
    assert any(e["id"] == eid for e in r.json()["events"])

    r = c.get(f"/news-events?ticker=AAPL", headers=HEAD)
    assert len(r.json()["events"]) == 1

    r = c.delete(f"/news-events/{eid}", headers=HEAD)
    assert r.status_code == 200
    r = c.delete(f"/news-events/{eid}", headers=HEAD)
    assert r.status_code == 404


def test_bad_date_returns_400():
    c = _c()
    r = c.post("/news-events", headers=HEAD, json={
        "ticker": "X", "headline": "h", "event_date": "2026/01/01",
    })
    assert r.status_code == 400


def test_requires_api_key():
    c = _c()
    r = c.get("/news-events")
    assert r.status_code in (401, 403)


def test_study_endpoint_with_mocked_prices():
    c = _c()
    # Seed two events
    for body in [
        {"ticker": "AAPL", "headline": "h", "event_date": "2026-01-15",
         "tags": ["upgrade"]},
        {"ticker": "MSFT", "headline": "h", "event_date": "2026-01-15",
         "tags": ["downgrade"]},
    ]:
        assert c.post("/news-events", headers=HEAD, json=body).status_code == 200

    idx = pd.date_range("2026-01-01", periods=40, freq="B")
    aapl = pd.Series(100.0, index=idx)
    aapl.iloc[10:] = 105.0
    msft = pd.Series(100.0, index=idx)
    msft.iloc[10:] = 97.0
    panel = {
        "AAPL": pd.DataFrame({"close": aapl}, index=idx),
        "MSFT": pd.DataFrame({"close": msft}, index=idx),
    }

    def fake_load(*args, **kwargs):
        for a in args:
            if isinstance(a, str) and a in panel:
                return panel[a]
        t = kwargs.get("ticker")
        if t in panel:
            return panel[t]
        return pd.DataFrame()

    with patch("signalclaw.api.app.load_ohlcv", side_effect=fake_load):
        r = c.get("/news-events/study?horizons=1,5", headers=HEAD)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_events"] == 2
    assert body["horizons"] == [1, 5]
    assert "upgrade" in body["by_tag"]
    assert "downgrade" in body["by_tag"]


def test_study_bad_horizons():
    c = _c()
    r = c.get("/news-events/study?horizons=abc", headers=HEAD)
    assert r.status_code == 400
    r = c.get("/news-events/study?horizons=", headers=HEAD)
    assert r.status_code == 400
