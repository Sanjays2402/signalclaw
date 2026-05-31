from __future__ import annotations
import os
from pathlib import Path

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

from signalclaw.alerts import AlertEventStore
from signalclaw.alerts.rules import AlertHit


def _hit(alert_id="a1", ticker="MSFT", observed=101.0):
    return AlertHit(
        alert_id=alert_id,
        ticker=ticker,
        condition="price_above",
        value=100.0,
        observed=observed,
        fired_at="2025-01-01T00:00:00+00:00",
        note="",
    )


def test_alert_event_store_records_and_lists(tmp_path: Path):
    store = AlertEventStore(tmp_path / "ae.json")
    assert store.count() == 0
    store.record([_hit(), _hit(alert_id="a2", ticker="AAPL", observed=210.0)])
    assert store.count() == 2
    rows = store.list()
    assert [r.alert_id for r in rows] == ["a2", "a1"]
    msft_only = store.list(ticker="msft")
    assert len(msft_only) == 1 and msft_only[0].ticker == "MSFT"


def test_alert_event_store_pagination_and_cap(tmp_path: Path):
    store = AlertEventStore(tmp_path / "ae.json", max_entries=10)
    store.record([_hit(alert_id=f"a{i}") for i in range(25)])
    assert store.count() == 10
    page = store.list(limit=4, offset=0)
    assert len(page) == 4
    page2 = store.list(limit=4, offset=4)
    assert len(page2) == 4
    assert {r.alert_id for r in page} & {r.alert_id for r in page2} == set()


def test_alert_event_store_clear(tmp_path: Path):
    store = AlertEventStore(tmp_path / "ae.json")
    store.record([_hit(), _hit(alert_id="a2")])
    assert store.count() == 2
    store.clear()
    assert store.count() == 0


def test_alerts_history_endpoint_schema_and_auth():
    """End-to-end: endpoint is mounted, requires api key, returns schema."""
    from fastapi.testclient import TestClient
    from signalclaw.api import app

    c = TestClient(app)
    # Auth required
    r = c.get("/alerts/history")
    assert r.status_code in (401, 403)
    # With key, valid pagination response
    r = c.get("/alerts/history?limit=10&offset=0", headers={"x-api-key": "test-key"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) >= {"total", "limit", "offset", "events"}
    assert body["limit"] == 10 and body["offset"] == 0
    assert isinstance(body["events"], list)

    # Ticker filter does not crash on empty store
    r = c.get("/alerts/history?ticker=MSFT", headers={"x-api-key": "test-key"})
    assert r.status_code == 200

    # Clear endpoint is mounted and authed
    r = c.delete("/alerts/history/clear")
    assert r.status_code in (401, 403)
    r = c.delete("/alerts/history/clear", headers={"x-api-key": "test-key"})
    assert r.status_code == 200 and r.json() == {"cleared": True}
