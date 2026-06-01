"""Tests for the public status page + incident registry.

Covers the enterprise procurement flow that TPRM teams ask about:
prospects fetch the status page unauthenticated, an admin posts an
incident and follow-up updates, a non-admin (reader) key is rejected
by the scope middleware, every mutation lands in the global audit
log, and resolved incidents bubble up to the public overall status.
"""
from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
    {"key": "reader-key", "scopes": ["read"], "label": "reader"},
])

from signalclaw.api import create_app  # noqa: E402
from signalclaw.api.rate_limit import reset_registry, get_registry  # noqa: E402
from signalclaw.audit import reset_audit_log, get_audit_log  # noqa: E402
from signalclaw.incidents import reset_store as reset_incident_store  # noqa: E402
from signalclaw.config import settings as settings_mod  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    reset_incident_store()
    get_registry().reload()
    c = TestClient(create_app())
    yield c
    reset_incident_store()
    reset_audit_log()
    reset_registry()
    settings_mod.get_settings.cache_clear()


def test_public_status_is_unauthenticated_and_starts_operational(client):
    r = client.get("/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 0
    assert body["overall_status"] == "operational"
    assert body["open_count"] == 0
    assert body["incidents"] == []


def test_admin_can_create_then_resolve_incident_and_status_recovers(client):
    create = client.post(
        "/admin/incidents",
        headers={"x-api-key": "admin-key"},
        json={
            "title": "Signal engine latency spike",
            "severity": "sev2",
            "status": "investigating",
            "summary": "p95 latency above 2s on /signals.",
            "affected_services": ["signal-engine", "api"],
        },
    )
    assert create.status_code == 200, create.text
    inc_id = create.json()["id"]

    public = client.get("/status").json()
    assert public["overall_status"] == "major"
    assert public["open_count"] == 1
    assert public["incidents"][0]["id"] == inc_id
    # the create call also seeds an initial timeline update
    assert len(public["incidents"][0]["updates"]) == 1

    # Append a progress update
    upd = client.post(
        f"/admin/incidents/{inc_id}/updates",
        headers={"x-api-key": "admin-key"},
        json={"status": "monitoring", "body": "Cache warmed, latency returning to normal."},
    )
    assert upd.status_code == 200, upd.text
    assert len(upd.json()["updates"]) == 2

    # Resolve via PUT
    resolved = client.put(
        f"/admin/incidents/{inc_id}",
        headers={"x-api-key": "admin-key"},
        json={"status": "resolved", "postmortem_url": "https://example.com/pm/1"},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["status"] == "resolved"
    assert resolved.json()["resolved_at"] is not None
    assert resolved.json()["postmortem_url"] == "https://example.com/pm/1"

    after = client.get("/status").json()
    assert after["overall_status"] == "operational"
    assert after["open_count"] == 0


def test_reader_key_cannot_mutate_incidents(client):
    forbidden = client.post(
        "/admin/incidents",
        headers={"x-api-key": "reader-key"},
        json={
            "title": "X", "severity": "sev3", "status": "identified",
            "summary": "y",
        },
    )
    assert forbidden.status_code == 403, forbidden.text

    # public read still works without any key
    r = client.get("/status")
    assert r.status_code == 200

    # admin endpoints reject missing key too
    no_key = client.get("/admin/incidents")
    assert no_key.status_code in (401, 403)


def test_invalid_severity_and_status_are_rejected(client):
    r = client.post(
        "/admin/incidents",
        headers={"x-api-key": "admin-key"},
        json={
            "title": "X", "severity": "sevX", "status": "investigating",
            "summary": "y",
        },
    )
    assert r.status_code == 400
    r = client.post(
        "/admin/incidents",
        headers={"x-api-key": "admin-key"},
        json={
            "title": "X", "severity": "sev1", "status": "broken",
            "summary": "y",
        },
    )
    assert r.status_code == 400
    r = client.post(
        "/admin/incidents",
        headers={"x-api-key": "admin-key"},
        json={
            "title": "X", "severity": "sev1", "status": "resolved",
            "summary": "y", "postmortem_url": "not-a-url",
        },
    )
    assert r.status_code == 400


def test_mutations_are_audit_logged_with_actor_hash(client):
    r = client.post(
        "/admin/incidents",
        headers={"x-api-key": "admin-key"},
        json={
            "title": "DB failover", "severity": "sev1",
            "status": "investigating", "summary": "Primary unreachable.",
        },
    )
    assert r.status_code == 200
    inc_id = r.json()["id"]
    rm = client.delete(f"/admin/incidents/{inc_id}", headers={"x-api-key": "admin-key"})
    assert rm.status_code == 200

    audit = get_audit_log()
    rows = audit.tail(limit=500)
    incident_rows = [r for r in rows if str(r.get("action", "")).startswith("incident.")]
    actions = {r["action"] for r in incident_rows}
    assert "incident.add" in actions
    assert "incident.remove" in actions
    for r in incident_rows:
        actor = r.get("actor_key_hash") or r.get("actor") or ""
        assert actor and actor != "-"


def test_change_log_history_records_versioned_diffs(client):
    r = client.post(
        "/admin/incidents",
        headers={"x-api-key": "admin-key"},
        json={
            "title": "Webhook lag", "severity": "sev3",
            "status": "identified", "summary": "Delivery delays.",
        },
    )
    assert r.status_code == 200
    h = client.get("/status/history?limit=10").json()
    assert h["changes"]
    top = h["changes"][0]
    assert top["action"] == "add"
    assert top["version"] >= 1
    assert top["after"]["title"] == "Webhook lag"


def test_incident_detail_endpoint(client):
    r = client.post(
        "/admin/incidents",
        headers={"x-api-key": "admin-key"},
        json={
            "title": "Detail check", "severity": "sev4",
            "status": "monitoring", "summary": "trivial.",
        },
    )
    inc_id = r.json()["id"]
    d = client.get(f"/status/incidents/{inc_id}")
    assert d.status_code == 200
    assert d.json()["id"] == inc_id
    missing = client.get("/status/incidents/inc-nope")
    assert missing.status_code == 404
