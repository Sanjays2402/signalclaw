"""Tests for the Prometheus metrics and readiness endpoints."""
import os
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

from fastapi.testclient import TestClient
from signalclaw.api import create_app


def test_metrics_endpoint_serves_prometheus_text():
    app = create_app()
    c = TestClient(app)
    # Generate a request so the counters move off zero.
    c.get("/health")
    r = c.get("/metrics")
    assert r.status_code == 200
    ct = r.headers.get("content-type", "")
    # Prometheus exposition format. Accept either the bare media type
    # or the versioned one prometheus_client emits.
    assert "text/plain" in ct
    body = r.text
    assert "signalclaw_http_requests_total" in body
    assert "signalclaw_http_request_duration_seconds" in body
    assert "signalclaw_build_info" in body


def test_metrics_records_route_template_not_raw_path():
    app = create_app()
    c = TestClient(app)
    headers = {"x-api-key": "test-key"}
    # Hit two distinct concrete paths under the same route template.
    c.delete("/watchlist/AAPL", headers=headers)
    c.delete("/watchlist/MSFT", headers=headers)
    body = c.get("/metrics").text
    # Route template collapses the two requests into one series and
    # the raw symbol should NOT appear as its own label value.
    assert "/watchlist/{ticker}" in body
    assert 'route="/watchlist/AAPL"' not in body


def test_metrics_excludes_its_own_endpoint():
    app = create_app()
    c = TestClient(app)
    # Scraping /metrics repeatedly should not inflate the counter for
    # /metrics itself.
    for _ in range(3):
        c.get("/metrics")
    body = c.get("/metrics").text
    assert 'route="/metrics"' not in body


def test_ready_endpoint_returns_ok_with_writable_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    # Reset settings cache so the new DATA_DIR is picked up.
    from signalclaw.config import settings as settings_mod
    settings_mod.get_settings.cache_clear()
    app = create_app()
    c = TestClient(app)
    r = c.get("/ready")
    assert r.status_code == 200
    payload = r.json()
    assert payload["status"] == "ready"
    assert payload["data_dir"] == str(tmp_path)
    settings_mod.get_settings.cache_clear()


def test_health_endpoint_still_cheap_and_open():
    app = create_app()
    c = TestClient(app)
    r = c.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
