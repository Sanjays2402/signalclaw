from __future__ import annotations
import numpy as np
import pandas as pd
from fastapi.testclient import TestClient
from signalclaw.api.app import create_app


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "k")
    monkeypatch.setenv("SIGNALCLAW_DATA_DIR", str(tmp_path))
    from signalclaw.config import get_settings
    get_settings.cache_clear()
    return TestClient(create_app()), {"x-api-key": "k"}


def _seed_parquet(tmp_path, ticker, df):
    from signalclaw.data.ohlcv import save_ohlcv
    save_ohlcv(ticker, df)


def _frame(spike=False):
    rng = np.random.default_rng(0)
    n = 120
    px = 100.0 * np.exp(np.cumsum(rng.normal(0, 0.005, n)))
    if spike:
        px[80] *= 1.40
    idx = pd.date_range("2024-01-01", periods=n, freq="B")
    df = pd.DataFrame({
        "open": px, "close": px,
        "high": px * 1.005, "low": px * 0.995,
        "volume": rng.integers(800_000, 1_200_000, n),
    }, index=idx)
    df["high"] = df[["high", "open", "close"]].max(axis=1)
    df["low"] = df[["low", "open", "close"]].min(axis=1)
    return df


def test_quality_endpoint_returns_report_for_seeded_ticker(monkeypatch, tmp_path):
    monkeypatch.setenv("SIGNALCLAW_DATA_DIR", str(tmp_path))
    from signalclaw.config import get_settings
    get_settings.cache_clear()
    _seed_parquet(tmp_path, "AAA", _frame(spike=True))
    client, h = _client(monkeypatch, tmp_path)
    r = client.get("/quality/anomalies/AAA", headers=h)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ticker"] == "AAA"
    assert d["n_bars"] == 120
    assert d["n_anomalous"] >= 1
    assert any("return_z" in a["reasons"] or "return_atr" in a["reasons"]
               for a in d["anomalies"])


def test_quality_endpoint_404_when_ticker_missing(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.get("/quality/anomalies/ZZZZ", headers=h)
    assert r.status_code == 404


def test_quality_endpoint_400_on_bad_threshold(monkeypatch, tmp_path):
    _seed_parquet(tmp_path, "BBB", _frame())
    client, h = _client(monkeypatch, tmp_path)
    r = client.get("/quality/anomalies/BBB?z_threshold=0", headers=h)
    assert r.status_code == 400


def test_quality_endpoint_requires_api_key(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path)
    r = client.get("/quality/anomalies/AAA")
    assert r.status_code in (401, 403)
