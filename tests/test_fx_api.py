"""API tests for FX rates and trade currency mapping."""
from __future__ import annotations
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
HEAD = {"x-api-key": "test-key"}


@pytest.fixture()
def isolated_app(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    from signalclaw.config import get_settings
    get_settings.cache_clear()  # type: ignore[attr-defined]
    from signalclaw.api import create_app
    app = create_app()
    yield TestClient(app)
    get_settings.cache_clear()  # type: ignore[attr-defined]


def _add_trade(c, ticker="SAP", side="buy", qty=10, price=100.0,
                date="2024-01-02"):
    r = c.post("/portfolio/trades", headers=HEAD, json={
        "ticker": ticker, "side": side, "quantity": qty, "price": price,
        "date": date,
    })
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_fx_upsert_and_get(isolated_app):
    r = isolated_app.post("/fx", headers=HEAD, json={
        "currency": "EUR", "date": "2024-01-01", "rate": 1.10,
    })
    assert r.status_code == 200, r.text
    r = isolated_app.get("/fx/EUR", headers=HEAD, params={"as_of": "2024-01-05"})
    assert r.status_code == 200
    assert r.json()["rate"] == pytest.approx(1.10)
    r = isolated_app.get("/fx", headers=HEAD)
    assert "EUR" in r.json()["currencies"]


def test_fx_rejects_bad_currency(isolated_app):
    r = isolated_app.post("/fx", headers=HEAD, json={
        "currency": "EU", "date": "2024-01-01", "rate": 1.0,
    })
    assert r.status_code == 400


def test_fx_rejects_non_positive_rate(isolated_app):
    r = isolated_app.post("/fx", headers=HEAD, json={
        "currency": "EUR", "date": "2024-01-01", "rate": 0,
    })
    assert r.status_code == 400


def test_fx_get_missing_returns_404(isolated_app):
    r = isolated_app.get("/fx/JPY", headers=HEAD, params={"as_of": "2024-01-01"})
    assert r.status_code == 404


def test_trade_currency_lifecycle(isolated_app):
    tid = _add_trade(isolated_app)
    r = isolated_app.post("/portfolio/currency", headers=HEAD, json={
        "trade_id": tid, "currency": "eur",
    })
    assert r.status_code == 200, r.text
    assert r.json()["map"][tid] == "EUR"
    r = isolated_app.get("/portfolio/currency", headers=HEAD)
    assert r.json()["map"][tid] == "EUR"
    r = isolated_app.delete(f"/portfolio/currency/{tid}", headers=HEAD)
    assert r.status_code == 200
    r = isolated_app.delete(f"/portfolio/currency/{tid}", headers=HEAD)
    assert r.status_code == 404


def test_trade_currency_rejects_unknown_trade(isolated_app):
    r = isolated_app.post("/portfolio/currency", headers=HEAD, json={
        "trade_id": "missing", "currency": "EUR",
    })
    assert r.status_code == 404


def test_portfolio_converted_end_to_end(isolated_app):
    # EUR rate at 2024-01-01
    isolated_app.post("/fx", headers=HEAD, json={
        "currency": "EUR", "date": "2024-01-01", "rate": 1.10,
    })
    eur_tid = _add_trade(isolated_app, "SAP", "buy", 10, 100.0, "2024-01-02")
    usd_tid = _add_trade(isolated_app, "AAPL", "buy", 5, 200.0, "2024-01-02")
    isolated_app.post("/portfolio/currency", headers=HEAD, json={
        "trade_id": eur_tid, "currency": "EUR",
    })
    r = isolated_app.get("/portfolio/converted", headers=HEAD)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["base"] == "USD"
    by_tid = {a["trade_id"]: a for a in body["audits"]}
    assert by_tid[eur_tid]["native_currency"] == "EUR"
    assert by_tid[eur_tid]["base_amount"] == pytest.approx(1100.0)
    assert by_tid[usd_tid]["base_amount"] == pytest.approx(1000.0)
    assert body["total_base_cost"] == pytest.approx(2100.0)


def test_portfolio_converted_rejects_non_usd_base(isolated_app):
    r = isolated_app.get("/portfolio/converted", headers=HEAD,
                          params={"base": "EUR"})
    assert r.status_code == 400


def test_portfolio_converted_fallback_when_rate_missing(isolated_app):
    tid = _add_trade(isolated_app, "SAP", "buy", 10, 100.0, "2024-01-02")
    isolated_app.post("/portfolio/currency", headers=HEAD, json={
        "trade_id": tid, "currency": "EUR",
    })
    r = isolated_app.get("/portfolio/converted", headers=HEAD)
    assert r.status_code == 200
    body = r.json()
    by_tid = {a["trade_id"]: a for a in body["audits"]}
    assert by_tid[tid]["fallback"] is True
    assert by_tid[tid]["base_amount"] is None
    assert body["total_fallback_native"] == pytest.approx(1000.0)
