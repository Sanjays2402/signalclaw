"""Tests for break-glass emergency admin elevation.

Covers the procurement-required flow:

* Admin grants a member-scoped key temporary admin via /admin/break-glass.
* While the grant is live the member key passes admin scope checks.
* Revoking the grant immediately drops the elevated scope.
* Issuing, revoking, and using the grant are recorded in the audit log.
* TTL is clamped: a 0-second or week-long request returns a structured 400.
* /admin/break-glass/me reports the caller's own active grant.
* A non-admin key cannot reach /admin/break-glass even to read.
"""
from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
    {"key": "member-key", "scopes": ["read"], "label": "oncall"},
])

from signalclaw.api import create_app  # noqa: E402
from signalclaw.api.rate_limit import reset_registry, get_registry  # noqa: E402
from signalclaw.audit import reset_audit_log  # noqa: E402
from signalclaw.break_glass import (  # noqa: E402
    reset_store as reset_bg_store,
    hash_key as bg_hash_key,
    MAX_TTL_SECONDS,
)
from signalclaw.config import settings as settings_mod  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    reset_bg_store()
    get_registry().reload()
    c = TestClient(create_app())
    yield c
    reset_bg_store()
    reset_audit_log()
    reset_registry()
    settings_mod.get_settings.cache_clear()


def test_non_admin_cannot_read_break_glass(client):
    r = client.get(
        "/admin/break-glass",
        headers={"x-api-key": "member-key"},
    )
    assert r.status_code == 403, r.text


def test_grant_lifecycle_elevates_then_revokes(client):
    # Member key cannot reach an admin route to start with.
    pre = client.get(
        "/admin/break-glass",
        headers={"x-api-key": "member-key"},
    )
    assert pre.status_code == 403

    # Admin issues a 5-minute grant against the member key.
    g = client.post(
        "/admin/break-glass",
        headers={"x-api-key": "admin-key"},
        json={
            "target_api_key": "member-key",
            "target_label": "on-call shift",
            "reason": "incident SC-42: ingest worker wedged, need /admin/keys",
            "ttl_seconds": 300,
        },
    )
    assert g.status_code == 200, g.text
    grant = g.json()
    assert grant["status"] == "active"
    assert grant["target_key_hash"] == bg_hash_key("member-key")
    assert 0 < grant["remaining_seconds"] <= 300
    grant_id = grant["id"]

    # Member key now has admin via the elevation: the admin list works.
    elevated = client.get(
        "/admin/break-glass",
        headers={"x-api-key": "member-key"},
    )
    assert elevated.status_code == 200, elevated.text
    body = elevated.json()
    assert body["max_ttl_seconds"] == MAX_TTL_SECONDS
    assert any(row["id"] == grant_id for row in body["grants"])
    # The grant store recorded the use.
    used = [row for row in body["grants"] if row["id"] == grant_id][0]
    assert used["used_count"] >= 1
    assert used["last_used_at"] is not None

    # /me reports the active grant for the caller.
    me = client.get(
        "/break-glass/me",
        headers={"x-api-key": "member-key"},
    ).json()
    assert me["active"] is True
    assert me["grant"]["id"] == grant_id

    # Admin revokes it; the next call from the member key drops to 403.
    rev = client.post(
        f"/admin/break-glass/{grant_id}/revoke",
        headers={"x-api-key": "admin-key"},
    )
    assert rev.status_code == 200
    assert rev.json()["status"] == "revoked"

    after = client.get(
        "/admin/break-glass",
        headers={"x-api-key": "member-key"},
    )
    assert after.status_code == 403, after.text

    me2 = client.get(
        "/break-glass/me",
        headers={"x-api-key": "member-key"},
    ).json()
    assert me2["active"] is False


@pytest.mark.parametrize("ttl", [0, 30, MAX_TTL_SECONDS + 1, 7 * 24 * 3600])
def test_grant_rejects_out_of_range_ttl(client, ttl):
    r = client.post(
        "/admin/break-glass",
        headers={"x-api-key": "admin-key"},
        json={
            "target_api_key": "member-key",
            "reason": "test",
            "ttl_seconds": ttl,
        },
    )
    assert r.status_code == 400, r.text
    assert "ttl_seconds" in r.json()["detail"]


def test_grant_rejects_missing_target_and_reason(client):
    r = client.post(
        "/admin/break-glass",
        headers={"x-api-key": "admin-key"},
        json={"reason": "test", "ttl_seconds": 120},
    )
    assert r.status_code == 400
    assert "target" in r.json()["detail"].lower()

    r2 = client.post(
        "/admin/break-glass",
        headers={"x-api-key": "admin-key"},
        json={"target_api_key": "member-key", "ttl_seconds": 120, "reason": ""},
    )
    assert r2.status_code == 400
    assert "reason" in r2.json()["detail"].lower()


def test_audit_log_records_grant_revoke(client, tmp_path):
    g = client.post(
        "/admin/break-glass",
        headers={"x-api-key": "admin-key"},
        json={
            "target_api_key": "member-key",
            "reason": "after-hours rotate",
            "ttl_seconds": 120,
        },
    ).json()
    client.post(
        f"/admin/break-glass/{g['id']}/revoke",
        headers={"x-api-key": "admin-key"},
    )

    # Walk the persisted audit JSONL files for our two action tags.
    audit_dir = tmp_path / "audit"
    actions = []
    if audit_dir.exists():
        for f in sorted(audit_dir.glob("*.jsonl")):
            for line in f.read_text().splitlines():
                try:
                    actions.append(json.loads(line).get("action"))
                except json.JSONDecodeError:
                    pass
    assert "break_glass.grant" in actions
    assert "break_glass.revoke" in actions
