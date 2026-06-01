"""Audit-log anomaly detector unit + endpoint tests.

These prove the four detectors fire on the patterns enterprise
buyers ask about (auth bursts, credential fan-out, off-hours admin
mutations) and that the ``/audit/anomalies`` endpoint requires the
``admin`` scope, matching every other audit surface.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
    {"key": "reader-key", "scopes": ["read"], "label": "reader"},
])

from signalclaw.api import create_app  # noqa: E402
from signalclaw.api.rate_limit import reset_registry, get_registry  # noqa: E402
from signalclaw.audit import AuditLog, detect_anomalies, reset_audit_log  # noqa: E402
from signalclaw.audit.log import AuditEvent  # noqa: E402
from signalclaw.config import settings as settings_mod  # noqa: E402


@pytest.fixture()
def tmp_audit(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    monkeypatch.setenv("REQUIRE_MFA_FOR_ADMIN", "0")
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    get_registry().reload()
    yield tmp_path
    reset_audit_log()
    reset_registry()
    settings_mod.get_settings.cache_clear()


def _ev(i, *, status=200, ip="10.0.0.1", method="POST", path="/x",
        key_hash="abc123abc123", label="ops", hour=12):
    # Anchor every event to the same UTC day as ``now`` below so the
    # window filter treats them as "recent".
    ts = f"2026-05-31T{hour:02d}:00:{i:02d}.000000Z"
    return AuditEvent(
        ts=ts,
        request_id=f"req-{i}",
        method=method,
        path=path,
        status=status,
        actor_key_hash=key_hash,
        actor_label=label,
        source_ip=ip,
        duration_ms=1.0,
    )


def _fixed_now():
    # 12:30 UTC on the same day the events above are stamped.
    return datetime(2026, 5, 31, 12, 30, 0, tzinfo=timezone.utc)


def test_auth_burst_flags_repeated_401_from_same_ip(tmp_audit):
    log = AuditLog(Path(tmp_audit) / "audit")
    for i in range(12):
        log.record(_ev(i, status=401, ip="203.0.113.7", key_hash="", label=""))
    # A successful unrelated call should not contribute.
    log.record(_ev(50, status=200, ip="10.0.0.9"))

    report = detect_anomalies(log, now=_fixed_now(), burst_threshold=10)
    kinds = [f["kind"] for f in report["findings"]]
    assert "auth_burst" in kinds
    burst = next(f for f in report["findings"] if f["kind"] == "auth_burst")
    assert burst["subject"] == "203.0.113.7"
    assert burst["count"] == 12
    assert burst["severity"] in {"low", "medium", "high"}


def test_key_ip_fanout_requires_non_loopback(tmp_audit):
    log = AuditLog(Path(tmp_audit) / "audit")
    # Same key seen from four distinct public IPs in the window.
    for i, ip in enumerate(["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"]):
        log.record(_ev(i, ip=ip, key_hash="deadbeefcafe", label="ci"))

    report = detect_anomalies(log, now=_fixed_now(), fanout_threshold=3)
    fan = [f for f in report["findings"] if f["kind"] == "key_ip_fanout"]
    assert len(fan) == 1
    assert fan[0]["count"] == 4
    assert set(fan[0]["extra"]["ips"]) >= {"198.51.100.1", "198.51.100.4"}

    # And a loopback-only key must NOT trigger fanout.
    log2 = AuditLog(Path(tmp_audit) / "audit2")
    for i in range(5):
        log2.record(_ev(i, ip="127.0.0.1", key_hash="loopback00000"))
    report2 = detect_anomalies(log2, now=_fixed_now(), fanout_threshold=3)
    assert not any(f["kind"] == "key_ip_fanout" for f in report2["findings"])


def test_offhours_admin_flags_mutation_outside_business_hours(tmp_audit):
    log = AuditLog(Path(tmp_audit) / "audit")
    # Default business hours are 13:00-02:00 UTC (start=13, end=2 wraps),
    # so an admin PUT at 03:00 UTC must trip the detector.
    log.record(_ev(1, status=204, method="PUT", path="/admin/keys/abc/role",
                   ip="10.0.0.1", key_hash="opskey000000", label="ops", hour=3))
    # And a 14:00 UTC admin mutation should NOT trip.
    log.record(_ev(2, status=204, method="PUT", path="/admin/keys/abc/role",
                   ip="10.0.0.1", key_hash="opskey000000", label="ops", hour=14))

    # Use now=04:00 UTC, window 6h, so both events are inside the window.
    now = datetime(2026, 5, 31, 4, 0, 0, tzinfo=timezone.utc)
    report = detect_anomalies(log, now=now, window_min=6 * 60)
    offhours = [f for f in report["findings"] if f["kind"] == "offhours_admin"]
    assert len(offhours) == 1
    assert offhours[0]["extra"]["method"] == "PUT"
    assert "/admin/keys/abc/role" in offhours[0]["subject"]


def test_endpoint_requires_admin_scope(tmp_audit):
    app = create_app()
    client = TestClient(app)

    # No key at all: must be denied.
    r0 = client.get("/audit/anomalies")
    assert r0.status_code in (401, 403)

    # Read-only key: must be denied for admin surface.
    r1 = client.get("/audit/anomalies", headers={"X-API-Key": "reader-key"})
    assert r1.status_code == 403

    # Admin key: must succeed and return the documented shape.
    r2 = client.get("/audit/anomalies", headers={"X-API-Key": "admin-key"})
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert set(body.keys()) >= {"window_min", "scanned", "thresholds", "findings", "generated_at"}
    assert isinstance(body["findings"], list)
