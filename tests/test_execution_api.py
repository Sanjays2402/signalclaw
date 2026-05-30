from __future__ import annotations
from fastapi.testclient import TestClient
from signalclaw.api.app import create_app


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "k")
    monkeypatch.setenv("SIGNALCLAW_DATA_DIR", str(tmp_path))
    from signalclaw.config import get_settings
    get_settings.cache_clear()
    return TestClient(create_app()), {"x-api-key": "k"}


def test_execution_simulate_endpoint_returns_fills(monkeypatch, tmp_path):
    client, headers = _client(monkeypatch, tmp_path)
    body = {
        "order": {
            "ticker": "AAPL", "side": "buy", "shares": 300,
            "arrival_price": 100.0, "schedule": "twap",
            "base_slippage_bps": 0.0, "slippage_bps_per_pct_adv": 0.0,
        },
        "bars": [
            {"index": 0, "price": 100.0, "volume": 1_000_000},
            {"index": 1, "price": 100.0, "volume": 1_000_000},
            {"index": 2, "price": 100.0, "volume": 1_000_000},
        ],
    }
    r = client.post("/execution/simulate", json=body, headers=headers)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["filled_shares"] == 300
    assert d["unfilled_shares"] == 0
    assert len(d["fills"]) == 3
    assert d["avg_fill_price"] == 100.0


def test_execution_simulate_endpoint_rejects_bad_schedule(monkeypatch, tmp_path):
    client, headers = _client(monkeypatch, tmp_path)
    body = {
        "order": {"ticker": "X", "side": "buy", "shares": 100,
                  "arrival_price": 10.0, "schedule": "iceberg"},
        "bars": [{"index": 0, "price": 10.0, "volume": 100}],
    }
    r = client.post("/execution/simulate", json=body, headers=headers)
    assert r.status_code == 400


def test_execution_simulate_endpoint_rejects_empty_bars(monkeypatch, tmp_path):
    client, headers = _client(monkeypatch, tmp_path)
    body = {
        "order": {"ticker": "X", "side": "buy", "shares": 100,
                  "arrival_price": 10.0, "schedule": "vwap"},
        "bars": [],
    }
    r = client.post("/execution/simulate", json=body, headers=headers)
    assert r.status_code == 400


def test_execution_simulate_requires_api_key(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path)
    r = client.post("/execution/simulate", json={"order": {}, "bars": []})
    assert r.status_code in (401, 403)
