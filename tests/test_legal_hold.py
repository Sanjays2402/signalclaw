"""Tests for the legal hold registry and its enforcement points.

Legal hold is the eDiscovery / regulator-ordered preservation gate.
While *any* hold is active:

* ``/privacy/delete`` must refuse with HTTP 409.
* The background audit retention pruner must skip its sweep.

These tests pin both behaviours so a future refactor cannot silently
weaken the preservation guarantee.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

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
    from signalclaw.legal_hold import reset_legal_hold_store
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    reset_legal_hold_store()
    get_registry().reload()
    c = TestClient(create_app())
    yield c
    reset_audit_log()
    reset_registry()
    reset_legal_hold_store()
    settings_mod.get_settings.cache_clear()


def _admin():
    return {"x-api-key": "admin-key"}


def _trader():
    return {"x-api-key": "trader-key"}


def test_legal_hold_requires_admin_scope(client):
    r = client.get("/admin/legal-hold")
    assert r.status_code in (401, 403)
    r = client.get("/admin/legal-hold", headers=_trader())
    assert r.status_code == 403


def test_legal_hold_lifecycle(client):
    # empty registry
    r = client.get("/admin/legal-hold", headers=_admin())
    assert r.status_code == 200
    assert r.json() == {"holds": []}

    # place a hold
    r = client.post("/admin/legal-hold", headers=_admin(), json={
        "key_hash": "abc123def456",
        "reason": "SEC subpoena SC-2026-1138",
        "case_id": "SC-2026-1138",
    })
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["key_hash"] == "abc123def456"
    assert payload["reason"].startswith("SEC subpoena")
    assert payload["case_id"] == "SC-2026-1138"
    assert payload["placed_by"]  # non-empty actor hash
    assert payload["placed_at"]

    # appears in list
    r = client.get("/admin/legal-hold", headers=_admin())
    assert len(r.json()["holds"]) == 1

    # validation: missing reason
    r = client.post("/admin/legal-hold", headers=_admin(), json={
        "key_hash": "deadbeef", "reason": "",
    })
    assert r.status_code in (400, 422)

    # release
    r = client.delete("/admin/legal-hold/abc123def456", headers=_admin())
    assert r.status_code == 200
    assert r.json()["ok"] is True

    # 404 on release of unknown hold
    r = client.delete("/admin/legal-hold/abc123def456", headers=_admin())
    assert r.status_code == 404


def test_privacy_delete_blocked_while_hold_active(client):
    # baseline: delete works (no hold)
    r = client.post("/privacy/delete?confirm=DELETE", headers=_admin())
    assert r.status_code == 200

    # place a hold and verify delete is refused with 409
    r = client.post("/admin/legal-hold", headers=_admin(), json={
        "key_hash": "facade0001",
        "reason": "litigation hold for matter X",
    })
    assert r.status_code == 200

    r = client.post("/privacy/delete?confirm=DELETE", headers=_admin())
    assert r.status_code == 409, r.text
    body = r.json()
    detail = body.get("detail", body)
    assert detail["error"] == "legal_hold_active"
    assert "facade0001" in detail["holds"]

    # also blocked when caller asks for broader wipe flags
    r = client.post(
        "/privacy/delete?confirm=DELETE&wipe_audit=true&wipe_reports=true",
        headers=_admin(),
    )
    assert r.status_code == 409

    # release the hold and confirm deletion resumes
    r = client.delete("/admin/legal-hold/facade0001", headers=_admin())
    assert r.status_code == 200
    r = client.post("/privacy/delete?confirm=DELETE", headers=_admin())
    assert r.status_code == 200


def test_audit_pruner_skips_sweep_while_hold_active(tmp_path):
    """Synchronously prove the retention pruner respects the hold predicate."""
    from signalclaw.audit.log import AuditLog
    from signalclaw.audit.retention import AuditRetentionPruner
    from signalclaw.legal_hold import LegalHoldStore

    audit_dir = tmp_path / "audit"
    audit_dir.mkdir()
    old_day_a = (datetime.now(timezone.utc) - timedelta(days=400)).strftime("%Y-%m-%d")
    old_day_b = (datetime.now(timezone.utc) - timedelta(days=200)).strftime("%Y-%m-%d")
    for d in (old_day_a, old_day_b):
        (audit_dir / f"audit-{d}.jsonl").write_text(
            '{"ts":"' + d + 'T00:00:00Z","action":"seed"}\n',
            encoding="utf-8",
        )

    audit = AuditLog(audit_dir)
    holds = LegalHoldStore(tmp_path / "legal_hold")
    pruner = AuditRetentionPruner(
        audit, retention_days=30, interval_seconds=3600,
        hold_predicate=holds.any_active,
    )

    # No holds: stale files get removed.
    removed = pruner.sweep_once()
    assert len(removed) == 2
    assert not list(audit_dir.glob("audit-*.jsonl"))

    # Recreate stale files, place a hold; sweep must be a no-op.
    for d in (old_day_a, old_day_b):
        (audit_dir / f"audit-{d}.jsonl").write_text("{}\n", encoding="utf-8")
    holds.place("anyhash", reason="preserve", placed_by="test")
    removed = pruner.sweep_once()
    assert removed == []
    assert len(list(audit_dir.glob("audit-*.jsonl"))) == 2

    # Release and sweep again: files purged.
    holds.release("anyhash")
    removed = pruner.sweep_once()
    assert len(removed) == 2
