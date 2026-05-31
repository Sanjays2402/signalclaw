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


def _synthetic_ohlcv(n: int = 800, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0006, 0.011, n)
    prices = 100 * np.exp(np.cumsum(rets))
    idx = pd.date_range("2018-01-01", periods=n, freq="B")
    return pd.DataFrame(
        {
            "open": prices,
            "high": prices * 1.01,
            "low": prices * 0.99,
            "close": prices,
            "volume": 1_000_000,
        },
        index=idx,
    )


def test_backtest_endpoint_returns_enriched_payload(monkeypatch):
    df = _synthetic_ohlcv()
    monkeypatch.setattr(app_mod, "load_ohlcv", lambda t: df)
    client = TestClient(create_app())
    r = client.get("/backtest/SPY", headers={"x-api-key": "test-key"})
    assert r.status_code == 200, r.text
    body = r.json()

    # Core legacy fields
    assert body["ticker"] == "SPY"
    assert len(body["equity_curve"]) == len(body["dates"]) > 0
    assert isinstance(body["n_trades"], int)

    # Enriched fields
    assert body["buy_hold_curve"] is not None
    assert len(body["buy_hold_curve"]) == len(body["equity_curve"])
    assert len(body["drawdown_curve"]) == len(body["equity_curve"])
    assert len(body["position"]) == len(body["equity_curve"])
    assert 0.0 <= body["exposure"] <= 1.0

    # Drawdown must be <= 0 at every point
    assert all(d <= 1e-9 for d in body["drawdown_curve"])

    # Position is 0/1 long-only
    assert all(p in (0.0, 1.0) for p in body["position"])

    # Trades are well-formed if any exist
    assert isinstance(body["trades"], list)
    for t in body["trades"]:
        assert {"entry_date", "exit_date", "bars", "return_pct"} <= set(t.keys())
        assert t["bars"] >= 1


def test_backtest_invalid_ticker(monkeypatch):
    client = TestClient(create_app())
    r = client.get("/backtest/" + "A" * 20, headers={"x-api-key": "test-key"})
    assert r.status_code == 400


def test_backtest_no_data(monkeypatch):
    monkeypatch.setattr(app_mod, "load_ohlcv", lambda t: pd.DataFrame())
    monkeypatch.setattr(app_mod, "fetch_ohlcv", lambda t, period="3y": pd.DataFrame())
    client = TestClient(create_app())
    r = client.get("/backtest/ZZZ", headers={"x-api-key": "test-key"})
    assert r.status_code == 404
