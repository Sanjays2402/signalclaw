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


def _synth(n: int = 500, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0008, 0.012, n)
    prices = 100 * np.exp(np.cumsum(rets))
    idx = pd.date_range("2021-01-01", periods=n, freq="B")
    return pd.DataFrame({
        "open": prices, "high": prices * 1.01, "low": prices * 0.99,
        "close": prices, "volume": 1_000_000,
    }, index=idx)


def test_explain_endpoint_insufficient_history(monkeypatch):
    df = _synth(n=200)  # < 300 bars -> 404 path
    monkeypatch.setattr(app_mod, "load_ohlcv", lambda t: df)
    client = TestClient(create_app())
    r = client.get("/explain/SPY?lookback_days=120", headers={"x-api-key": "test-key"})
    assert r.status_code == 404


def test_explain_endpoint_bad_lookback():
    client = TestClient(create_app())
    r = client.get("/explain/SPY?lookback_days=notanumber", headers={"x-api-key": "test-key"})
    assert r.status_code in (400, 422)


def test_explain_endpoint_invalid_ticker():
    client = TestClient(create_app())
    r = client.get("/explain/!!!", headers={"x-api-key": "test-key"})
    assert r.status_code == 400


def test_explain_endpoint_no_data(monkeypatch):
    monkeypatch.setattr(app_mod, "load_ohlcv", lambda t: pd.DataFrame())
    monkeypatch.setattr(app_mod, "fetch_ohlcv", lambda t, period="3y": pd.DataFrame())
    client = TestClient(create_app())
    r = client.get("/explain/ZZZ", headers={"x-api-key": "test-key"})
    assert r.status_code == 404
