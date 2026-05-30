from __future__ import annotations
import numpy as np
import pandas as pd
from fastapi.testclient import TestClient

import os
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
import sys
import importlib
importlib.import_module("signalclaw.api.app")
app_mod = sys.modules["signalclaw.api.app"]
create_app = app_mod.create_app


def test_regime_endpoint(tmp_path, monkeypatch):
    # Build synthetic OHLCV and patch loader
    rng = np.random.default_rng(0)
    rets = rng.normal(0.0007, 0.009, 500)
    prices = 100 * np.exp(np.cumsum(rets))
    idx = pd.date_range("2020-01-01", periods=len(prices), freq="B")
    df = pd.DataFrame({
        "open": prices, "high": prices * 1.01, "low": prices * 0.99,
        "close": prices, "volume": 1_000_000,
    }, index=idx)

    monkeypatch.setattr(app_mod, "load_ohlcv", lambda t: df)
    client = TestClient(create_app())
    r = client.get("/regime?ticker=SPY", headers={"x-api-key": "test-key"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["label"] in ("bull", "chop", "bear", "crash")
    assert 0.0 <= body["risk_scale"] <= 1.5


def test_regime_endpoint_no_data(tmp_path, monkeypatch):
    monkeypatch.setattr(app_mod, "load_ohlcv", lambda t: pd.DataFrame())
    monkeypatch.setattr(app_mod, "fetch_ohlcv", lambda t, period="3y": pd.DataFrame())
    client = TestClient(create_app())
    r = client.get("/regime?ticker=ZZZ", headers={"x-api-key": "test-key"})
    assert r.status_code == 404
