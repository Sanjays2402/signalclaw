"""API tests for drawdown guard endpoints."""
from __future__ import annotations
import os
import tempfile
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
HEAD = {"x-api-key": "test-key"}


@pytest.fixture()
def isolated_app(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    # Provide a small synthetic cache for ticker SPY
    cache = tmp_path / "ohlcv"
    cache.mkdir(parents=True, exist_ok=True)
    # Save a fake OHLCV parquet for SPY using the lib's saver
    import importlib
    from signalclaw.config import get_settings
    get_settings.cache_clear()  # type: ignore[attr-defined]
    from signalclaw import data as data_mod
    importlib.reload(data_mod)
    df = pd.DataFrame(
        {
            "open": [100, 105, 110, 90, 85, 80, 75],
            "high": [102, 107, 111, 92, 86, 81, 76],
            "low": [99, 104, 109, 89, 84, 79, 74],
            "close": [100, 105, 110, 90, 85, 80, 75],
            "volume": [1000] * 7,
        },
        index=pd.date_range("2024-01-01", periods=7),
    )
    data_mod.save_ohlcv("SPY", df)
    from signalclaw.api import create_app
    app = create_app()
    yield TestClient(app)
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_drawdown_requires_trades(isolated_app):
    r = isolated_app.get("/portfolio/drawdown", headers=HEAD)
    assert r.status_code == 404


def test_drawdown_end_to_end(isolated_app):
    # Add a trade
    r = isolated_app.post("/portfolio/trades", headers=HEAD, json={
        "ticker": "SPY", "side": "buy", "quantity": 10, "price": 100.0,
        "date": "2024-01-01",
    })
    assert r.status_code == 200, r.text
    r = isolated_app.get(
        "/portfolio/drawdown",
        headers=HEAD,
        params={"trigger": 0.10, "rearm": 0.03, "min_history_days": 2,
                 "cash": 1000.0, "persist": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"]["tripped"] is True
    assert body["state"]["peak"] > 0
    assert body["config"]["trigger"] == 0.10
    # History recorded
    r = isolated_app.get("/portfolio/drawdown/history", headers=HEAD)
    assert len(r.json()["history"]) == 1
    # Clear
    r = isolated_app.post("/portfolio/drawdown/clear", headers=HEAD)
    assert r.status_code == 200
    r = isolated_app.get("/portfolio/drawdown/history", headers=HEAD)
    assert r.json()["history"] == []


def test_drawdown_invalid_config_returns_400(isolated_app):
    r = isolated_app.post("/portfolio/trades", headers=HEAD, json={
        "ticker": "SPY", "side": "buy", "quantity": 1, "price": 100.0,
        "date": "2024-01-01",
    })
    assert r.status_code == 200
    r = isolated_app.get("/portfolio/drawdown", headers=HEAD,
                          params={"trigger": 0, "rearm": 0})
    assert r.status_code == 400
