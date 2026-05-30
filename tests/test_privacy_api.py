"""Tests for the privacy (GDPR export + delete) endpoints."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
    {"key": "trader-key", "scopes": ["read", "trade"], "label": "trader"},
])


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    from signalclaw.api import create_app
    from signalclaw.api.rate_limit import reset_registry, get_registry
    from signalclaw.audit import reset_audit_log
    from signalclaw.config import settings as settings_mod
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    get_registry().reload()
    c = TestClient(create_app())
    yield c
    reset_audit_log()
    reset_registry()
    settings_mod.get_settings.cache_clear()


def _admin():
    return {"x-api-key": "admin-key"}


def _trader():
    return {"x-api-key": "trader-key"}


def test_privacy_export_requires_admin_scope(client):
    # no key
    r = client.get("/privacy/export")
    assert r.status_code in (401, 403)
    # wrong scope
    r = client.get("/privacy/export", headers=_trader())
    assert r.status_code == 403


def test_privacy_export_returns_known_shape(client):
    client.post("/watchlist", json={"ticker": "AAPL"}, headers=_admin())
    client.post("/alerts", json={
        "ticker": "AAPL", "condition": "price_above", "value": 999.0,
    }, headers=_admin())
    client.post("/portfolio/trades", json={
        "ticker": "AAPL", "side": "buy", "quantity": 1.0,
        "price": 100.0, "date": "2025-01-02",
    }, headers=_admin())
    r = client.get("/privacy/export", headers=_admin())
    assert r.status_code == 200, r.text
    data = r.json()
    for k in ("meta", "watchlist", "alerts", "portfolio_trades", "stops",
              "earnings", "journal", "brackets", "news_events", "webhooks",
              "scaling_plans", "drawdown_history", "fx_currencies",
              "audit_log"):
        assert k in data, f"missing {k} in export"
    assert "AAPL" in data["watchlist"]
    assert any(a.get("ticker") == "AAPL" for a in data["alerts"])
    assert any(t.get("ticker") == "AAPL" for t in data["portfolio_trades"])
    assert data["meta"]["schema_version"] == 1


def test_privacy_delete_requires_confirm(client):
    r = client.post("/privacy/delete", headers=_admin())
    assert r.status_code == 400
    assert "confirm" in r.text.lower()


def test_privacy_delete_requires_admin_scope(client):
    r = client.post("/privacy/delete?confirm=DELETE", headers=_trader())
    assert r.status_code == 403


def test_privacy_delete_wipes_user_state(client):
    client.post("/watchlist", json={"ticker": "MSFT"}, headers=_admin())
    client.post("/alerts", json={
        "ticker": "MSFT", "condition": "price_above", "value": 1.0,
    }, headers=_admin())
    client.post("/portfolio/trades", json={
        "ticker": "MSFT", "side": "buy", "quantity": 2.0,
        "price": 10.0, "date": "2025-01-03",
    }, headers=_admin())
    pre = client.get("/privacy/export", headers=_admin()).json()
    assert pre["watchlist"] and pre["alerts"] and pre["portfolio_trades"]
    r = client.post("/privacy/delete?confirm=DELETE", headers=_admin())
    assert r.status_code == 200, r.text
    summary = r.json()
    assert summary["ok"] is True
    assert summary["removed"].get("watchlist", 0) >= 1
    assert summary["removed"].get("alerts", 0) >= 1
    assert summary["removed"].get("portfolio_trades", 0) >= 1
    post = client.get("/privacy/export", headers=_admin()).json()
    assert post["watchlist"] == []
    assert post["alerts"] == []
    assert post["portfolio_trades"] == []
    # audit log preserved by default
    assert isinstance(post["audit_log"], dict)
