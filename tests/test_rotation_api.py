"""API tests for sector rotation endpoint."""
from __future__ import annotations

import os
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def _mk(n, d, s):
    rng = np.random.default_rng(s)
    r = rng.normal(d, 0.005, n)
    idx = pd.date_range("2024-01-01", periods=n, freq="B")
    return pd.DataFrame({"close": 100 * np.exp(np.cumsum(r))}, index=idx)


@pytest.fixture()
def patched_loader():
    panel = {
        "SPY":  _mk(200, 0.0002, 1),
        "AAPL": _mk(200, 0.0012, 2),
        "MSFT": _mk(200, 0.0011, 3),
        "NVDA": _mk(200, 0.0014, 4),
        "XOM":  _mk(200, -0.0008, 5),
        "CVX":  _mk(200, -0.0007, 6),
        "JPM":  _mk(200, 0.0002, 7),
        "BAC":  _mk(200, 0.0001, 8),
    }

    def fake_load(*args, **kwargs):
        # Signature in app.py is load_ohlcv(parquet_dir, ticker) or load_ohlcv(ticker)
        ticker = None
        for a in args:
            if isinstance(a, str) and a in panel:
                ticker = a
                break
        if ticker is None:
            ticker = kwargs.get("ticker")
        if ticker in panel:
            return panel[ticker]
        return pd.DataFrame()

    with patch("signalclaw.api.app.load_ohlcv", side_effect=fake_load):
        yield panel


def test_rotation_endpoint_returns_scores(patched_loader):
    c = TestClient(app)
    qs = "tickers=" + ",".join(["AAPL", "MSFT", "NVDA", "XOM", "CVX", "JPM", "BAC"])
    r = c.get(f"/rotation?{qs}", headers=HEAD)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["benchmark"] == "SPY"
    sectors = {s["sector"] for s in body["scores"]}
    assert "Technology" in sectors
    assert "Energy" in sectors
    # Technology should be overweight
    assert "Technology" in body["overweight"]


def test_rotation_missing_benchmark_returns_404(patched_loader):
    c = TestClient(app)
    r = c.get("/rotation?benchmark=ZZZZ&tickers=AAPL,MSFT", headers=HEAD)
    assert r.status_code == 404


def test_rotation_bad_lookbacks(patched_loader):
    c = TestClient(app)
    r = c.get("/rotation?tickers=AAPL,MSFT&lookback_short=0", headers=HEAD)
    assert r.status_code == 400


def test_rotation_requires_api_key(patched_loader):
    c = TestClient(app)
    r = c.get("/rotation?tickers=AAPL,MSFT")
    assert r.status_code in (401, 403)
