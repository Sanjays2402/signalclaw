"""Suspend/resume on API keys.

Validates the reversible-disable contract enterprise procurement asks
for: a suspended key fails auth immediately without losing its scopes /
role / ip-allowlist / forensic fingerprint, and ``resume`` restores
the prior posture in one call. Distinct from :func:`revoke`, which is
a permanent tombstone.
"""
from __future__ import annotations
import json
import os
import tempfile
from fastapi.testclient import TestClient

# Isolated data dir so the key store starts clean.
_TMP = tempfile.mkdtemp(prefix="sc_suspend_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = json.dumps([
    {"key": "admin-suspend-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402

ADMIN = {"x-api-key": "admin-suspend-key"}


def _mint_member_key(c: TestClient) -> tuple[str, str]:
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "incident-test", "scopes": ["read", "trade"], "role": "member",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    return body["id"], body["secret"]


def test_suspend_blocks_auth_and_resume_restores():
    c = TestClient(app)
    key_id, secret = _mint_member_key(c)

    # Baseline: the fresh key works on a read endpoint.
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 200, r.text

    # Suspend with a reason.
    r = c.post(f"/admin/keys/{key_id}/suspend", headers=ADMIN,
               json={"reason": "incident-2026-IR-42"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["suspended"] is True
    assert body["suspended_reason"] == "incident-2026-IR-42"
    assert body["suspended_at"]
    # Scopes / role preserved (not destructive).
    assert "read" in body["scopes"] and "trade" in body["scopes"]
    assert body["role"] == "member"

    # Suspended key now fails auth.
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 401

    # Admin list still shows the row with the suspended flag set.
    r = c.get("/admin/keys", headers=ADMIN)
    assert r.status_code == 200
    row = next(k for k in r.json()["keys"] if k["id"] == key_id)
    assert row["suspended"] is True
    assert row["suspended_reason"] == "incident-2026-IR-42"

    # Idempotent: suspending again is a no-op (200, still suspended).
    r = c.post(f"/admin/keys/{key_id}/suspend", headers=ADMIN, json={})
    assert r.status_code == 200
    assert r.json()["suspended"] is True

    # Resume restores access and clears the suspended_* fields.
    r = c.post(f"/admin/keys/{key_id}/resume", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["suspended"] is False
    assert body["suspended_at"] is None
    assert body["suspended_reason"] is None
    assert body["suspended_by"] is None

    # Original secret works again with its original scopes.
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 200
    r = c.post("/watchlist", headers={"x-api-key": secret}, json={"ticker": "ZZZZ"})
    assert r.status_code == 200, r.text


def test_suspend_requires_admin_scope():
    c = TestClient(app)
    key_id, _ = _mint_member_key(c)
    # The legacy env "test-key" is not admin.
    r = c.post(f"/admin/keys/{key_id}/suspend",
               headers={"x-api-key": "test-key"}, json={})
    assert r.status_code in (401, 403)
    r = c.post(f"/admin/keys/{key_id}/resume",
               headers={"x-api-key": "test-key"})
    assert r.status_code in (401, 403)


def test_suspend_missing_key_404():
    c = TestClient(app)
    r = c.post("/admin/keys/does-not-exist/suspend", headers=ADMIN, json={})
    assert r.status_code == 404
    r = c.post("/admin/keys/does-not-exist/resume", headers=ADMIN)
    assert r.status_code == 404


def test_suspend_validates_reason_type():
    c = TestClient(app)
    key_id, _ = _mint_member_key(c)
    r = c.post(f"/admin/keys/{key_id}/suspend", headers=ADMIN,
               json={"reason": 123})
    assert r.status_code == 400


def test_revoked_key_cannot_be_suspended():
    c = TestClient(app)
    key_id, _ = _mint_member_key(c)
    r = c.delete(f"/admin/keys/{key_id}", headers=ADMIN)
    assert r.status_code == 200
    # Revocation is terminal: suspend on a revoked row returns 404.
    r = c.post(f"/admin/keys/{key_id}/suspend", headers=ADMIN, json={})
    assert r.status_code == 404
