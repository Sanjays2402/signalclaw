"""API tests for trade journal."""
from __future__ import annotations
import os

import pandas as pd
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


def _add_trade(client, ticker="AAPL", side="buy", qty=1, price=100.0,
                date="2024-01-01"):
    r = client.post("/portfolio/trades", headers=HEAD, json={
        "ticker": ticker, "side": side, "quantity": qty, "price": price,
        "date": date,
    })
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_journal_crud(isolated_app):
    tid = _add_trade(isolated_app)
    r = isolated_app.post("/journal", headers=HEAD, json={
        "trade_id": tid, "thesis": "long term", "conviction": 4,
        "tags": ["macro"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["conviction"] == 4
    assert r.json()["tags"] == ["macro"]

    r = isolated_app.get(f"/journal/{tid}", headers=HEAD)
    assert r.status_code == 200
    assert r.json()["trade_id"] == tid

    # Update
    r = isolated_app.post("/journal", headers=HEAD, json={
        "trade_id": tid, "thesis": "revised", "conviction": 5,
        "tags": ["macro", "fed"],
    })
    assert r.json()["conviction"] == 5

    r = isolated_app.get("/journal", headers=HEAD, params={"min_conviction": 5})
    assert len(r.json()["entries"]) == 1

    r = isolated_app.delete(f"/journal/{tid}", headers=HEAD)
    assert r.status_code == 200
    r = isolated_app.get(f"/journal/{tid}", headers=HEAD)
    assert r.status_code == 404


def test_journal_rejects_unknown_trade(isolated_app):
    r = isolated_app.post("/journal", headers=HEAD, json={
        "trade_id": "nope", "conviction": 3,
    })
    assert r.status_code == 404


def test_journal_rejects_invalid_conviction(isolated_app):
    tid = _add_trade(isolated_app)
    r = isolated_app.post("/journal", headers=HEAD, json={
        "trade_id": tid, "conviction": 9,
    })
    # Pydantic schema accepts 9 (int), validation fails in JournalEntry -> 400
    assert r.status_code == 400


def test_journal_conviction_stats_endpoint(isolated_app):
    buy_id = _add_trade(isolated_app, "AAPL", "buy", 10, 100.0, "2024-01-01")
    sell_id = _add_trade(isolated_app, "AAPL", "sell", 10, 110.0, "2024-01-10")
    isolated_app.post("/journal", headers=HEAD, json={
        "trade_id": buy_id, "conviction": 4, "thesis": "entry",
    })
    isolated_app.post("/journal", headers=HEAD, json={
        "trade_id": sell_id, "conviction": 4, "thesis": "take profit",
        "exit_reason": "target",
    })
    r = isolated_app.get("/journal/stats/conviction", headers=HEAD)
    assert r.status_code == 200, r.text
    buckets = r.json()["buckets"]
    by_c = {b["conviction"]: b for b in buckets}
    assert 4 in by_c
    assert by_c[4]["n_trades"] == 1  # only the sell carries realized_pnl
    assert by_c[4]["realized_pnl"] > 0
