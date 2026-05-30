from __future__ import annotations
from fastapi.testclient import TestClient
from signalclaw.api.app import create_app


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "k")
    monkeypatch.setenv("SIGNALCLAW_DATA_DIR", str(tmp_path))
    from signalclaw.config import get_settings
    get_settings.cache_clear()
    return TestClient(create_app()), {"x-api-key": "k"}


def test_ledger_append_and_snapshot_flow(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.post("/ledger/main", headers=h, json={
        "ts": "d1", "kind": "deposit", "amount": 10000.0,
    })
    assert r.status_code == 200
    r = client.post("/ledger/main", headers=h, json={
        "ts": "d2", "kind": "buy", "amount": -5000.0,
        "ticker": "AAPL", "shares": 50, "price": 100.0,
    })
    assert r.status_code == 200
    r = client.get("/ledger/main", headers=h)
    assert r.status_code == 200
    assert len(r.json()["entries"]) == 2
    r = client.get("/ledger/main/snapshot?marks=AAPL:120", headers=h)
    assert r.status_code == 200
    d = r.json()
    assert d["cash"] == 5000.0
    assert d["long_market_value"] == 6000.0
    assert d["equity"] == 11000.0
    assert d["margin_call"] is False


def test_ledger_invalid_kind_rejected(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.post("/ledger/main", headers=h, json={
        "ts": "d1", "kind": "magic", "amount": 1.0,
    })
    assert r.status_code == 400


def test_ledger_invalid_mark_rejected(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.get("/ledger/main/snapshot?marks=AAPL:abc", headers=h)
    assert r.status_code == 400


def test_ledger_set_config_round_trip(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.put("/ledger/main/config", headers=h, json={
        "initial_margin": 0.4, "maintenance_margin": 0.2,
        "annual_interest_rate": 0.07,
    })
    assert r.status_code == 200
    assert r.json()["initial_margin"] == 0.4


def test_ledger_set_config_validation_error(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.put("/ledger/main/config", headers=h, json={
        "initial_margin": 0.2, "maintenance_margin": 0.5,
        "annual_interest_rate": 0.07,
    })
    assert r.status_code == 400


def test_ledger_requires_api_key(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path)
    r = client.get("/ledger/main")
    assert r.status_code in (401, 403)
