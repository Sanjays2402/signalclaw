from __future__ import annotations
import os

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

from fastapi.testclient import TestClient

from signalclaw.api import app
from signalclaw.engine.daily import DailyReport, DailyPick
from signalclaw.history import ReportArchive
from signalclaw.config import get_settings

HEAD = {"x-api-key": "test-key"}


def _seed():
    s = get_settings()
    a = ReportArchive(s.data_dir / "reports")
    a.save(DailyReport(as_of="2026-05-27", picks=[
        DailyPick(ticker="MSFT", label="hold", score=0.5,
                  expected_return=0.01, rationale="seed"),
    ]))
    a.save(DailyReport(as_of="2026-05-28", picks=[
        DailyPick(ticker="MSFT", label="watch", score=0.8,
                  expected_return=0.02, rationale="seed"),
        DailyPick(ticker="SPY", label="watch", score=0.7,
                  expected_return=0.01, rationale="seed"),
    ]))


def test_history_list_endpoint():
    _seed()
    c = TestClient(app)
    r = c.get("/reports/history", headers=HEAD)
    assert r.status_code == 200, r.text
    dates = [s["as_of"] for s in r.json()["summaries"]]
    assert "2026-05-27" in dates and "2026-05-28" in dates


def test_history_get_specific_report():
    _seed()
    c = TestClient(app)
    r = c.get("/reports/2026-05-27", headers=HEAD)
    assert r.status_code == 200
    body = r.json()
    assert body["as_of"] == "2026-05-27"
    assert any(p["ticker"] == "MSFT" for p in body["picks"])


def test_history_get_unknown_404():
    c = TestClient(app)
    r = c.get("/reports/1999-01-01", headers=HEAD)
    assert r.status_code == 404


def test_history_diff_latest():
    _seed()
    c = TestClient(app)
    r = c.get("/reports/diff/latest", headers=HEAD)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["current_as_of"] == "2026-05-28"
    assert body["prior_as_of"] == "2026-05-27"
    assert "SPY" in body["new_picks"]
    assert any(u["ticker"] == "MSFT" for u in body["upgraded"])


def test_history_diff_specific_date():
    _seed()
    c = TestClient(app)
    r = c.get("/reports/diff/2026-05-28", headers=HEAD)
    assert r.status_code == 200
    assert r.json()["prior_as_of"] == "2026-05-27"


def test_history_endpoints_require_key():
    c = TestClient(app)
    assert c.get("/reports/history").status_code in (401, 403)
    assert c.get("/reports/diff/latest").status_code in (401, 403)
