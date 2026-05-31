"""Tests for the multi-day audit search + CSV export endpoints.

These cover the enterprise procurement use case: an auditor logs in,
filters the audit log across the last N days by actor / method /
status / path, and downloads the matching rows as CSV. The tests
verify the filter semantics, the streaming CSV header + escaping,
admin-scope enforcement, and the bounds clamps that protect the API.
"""
from __future__ import annotations

import csv
import io
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
    {"key": "trader-key", "scopes": ["read", "trade"], "label": "trader"},
    {"key": "reader-key", "scopes": ["read"], "label": "reader"},
])

from signalclaw.api import create_app  # noqa: E402
from signalclaw.api.rate_limit import reset_registry, get_registry  # noqa: E402
from signalclaw.audit import AuditLog, reset_audit_log  # noqa: E402
from signalclaw.audit.log import AuditEvent  # noqa: E402
from signalclaw.config import settings as settings_mod  # noqa: E402


@pytest.fixture()
def tmp_data(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    get_registry().reload()
    yield tmp_path
    reset_audit_log()
    reset_registry()
    settings_mod.get_settings.cache_clear()


def _seed_events(audit_dir: Path) -> None:
    """Drop a small synthetic audit history spanning 3 days.

    Using the on-disk format directly (one JSONL per UTC day) is more
    realistic than going through the middleware: it guarantees the
    test exercises the multi-file walk in ``search`` / ``iter_csv``
    and is order-independent of how FastAPI happens to record probes
    on this test's own /audit calls.
    """
    audit_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    rows = [
        # day 0: a successful POST by ops, a 403 by trader
        (today, "00:00:01.000000Z", "POST", "/api/v1/watchlist", 200, "ops", "ip1"),
        (today, "00:00:02.000000Z", "POST", "/audit", 403, "trader", "ip2"),
        # day 1: a DELETE by ops, a 500 by ops
        (today - timedelta(days=1), "00:00:03.000000Z", "DELETE", "/api/v1/alerts/abc", 204, "ops", "ip1"),
        (today - timedelta(days=1), "00:00:04.000000Z", "POST", "/api/v1/portfolio/trades", 500, "ops", "ip1"),
        # day 2: a 401 anonymous
        (today - timedelta(days=2), "00:00:05.000000Z", "POST", "/api/v1/webhooks", 401, "", "ip9"),
    ]
    for day, t, method, path, status, label, ip in rows:
        ev = AuditEvent(
            ts=f"{day.strftime('%Y-%m-%d')}T{t}",
            request_id="r" + str(status),
            method=method,
            path=path,
            status=status,
            actor_key_hash=("a" + label) if label else "",
            actor_label=label,
            source_ip=ip,
            duration_ms=1.23,
            action="",
        )
        with (audit_dir / f"audit-{day.strftime('%Y-%m-%d')}.jsonl").open("a") as fh:
            fh.write(ev.to_json() + "\n")


def test_search_filters_by_status_min_and_actor(tmp_data):
    _seed_events(tmp_data / "audit")
    client = TestClient(create_app())
    # ops POST 500 + trader 403 are the only >=400 rows from those actors
    r = client.get(
        "/audit/search?status_min=400&days_back=3",
        headers={"x-api-key": "admin-key"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    statuses = sorted(e["status"] for e in body["events"])
    # 401 anon, 403 trader, 500 ops all match.
    assert 401 in statuses and 403 in statuses and 500 in statuses
    # Now narrow to one actor only.
    r2 = client.get(
        "/audit/search?status_min=400&actor_label=ops&days_back=3",
        headers={"x-api-key": "admin-key"},
    )
    assert r2.status_code == 200
    labels = {e["actor_label"] for e in r2.json()["events"]}
    assert labels == {"ops"}


def test_search_path_prefix_and_method(tmp_data):
    _seed_events(tmp_data / "audit")
    client = TestClient(create_app())
    r = client.get(
        "/audit/search?method=DELETE&path_prefix=/api/v1/alerts&days_back=3",
        headers={"x-api-key": "admin-key"},
    )
    assert r.status_code == 200
    events = r.json()["events"]
    assert len(events) == 1
    assert events[0]["method"] == "DELETE"
    assert events[0]["path"].startswith("/api/v1/alerts")


def test_search_requires_admin_scope(tmp_data):
    _seed_events(tmp_data / "audit")
    client = TestClient(create_app())
    # No key at all -> 401
    r0 = client.get("/audit/search")
    assert r0.status_code in (401, 403)
    # Read-only key -> 403
    r1 = client.get("/audit/search", headers={"x-api-key": "reader-key"})
    assert r1.status_code == 403
    # Trader (read+trade, no admin) -> 403
    r2 = client.get("/audit/search", headers={"x-api-key": "trader-key"})
    assert r2.status_code == 403


def test_export_csv_has_header_and_filtered_rows(tmp_data):
    _seed_events(tmp_data / "audit")
    client = TestClient(create_app())
    r = client.get(
        "/audit/export.csv?status_min=400&days_back=3",
        headers={"x-api-key": "admin-key"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    reader = csv.DictReader(io.StringIO(r.text))
    rows = list(reader)
    # header present
    assert reader.fieldnames is not None
    assert "ts" in reader.fieldnames and "status" in reader.fieldnames
    statuses = sorted(int(row["status"]) for row in rows)
    # Same three failures as the JSON search test.
    assert statuses == [401, 403, 500]


def test_export_csv_requires_admin(tmp_data):
    _seed_events(tmp_data / "audit")
    client = TestClient(create_app())
    r = client.get(
        "/audit/export.csv",
        headers={"x-api-key": "reader-key"},
    )
    assert r.status_code == 403


def test_search_days_back_is_clamped(tmp_data):
    _seed_events(tmp_data / "audit")
    client = TestClient(create_app())
    # 99999 should clamp to 365, not blow up.
    r = client.get(
        "/audit/search?days_back=99999",
        headers={"x-api-key": "admin-key"},
    )
    assert r.status_code == 200
    assert r.json()["days_back"] == 365
