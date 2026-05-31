"""RBAC tests for user-managed API keys.

These tests exercise the role -> scope cap chokepoint end to end. A
viewer key cannot mutate state even if the request lists the trade
scope; a downgrade from admin to viewer immediately revokes the
admin scope on the next request; and the role is exposed through
the public payload so the admin console can render it.
"""
from __future__ import annotations
import os
import tempfile
import json as _json

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_keys_rbac_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key-rbac")
# Reuse the admin key from test_api_keys_admin.py so this module works
# both standalone and when the other admin test ran first in the same
# pytest session (env mutations after import do not re-init the
# registry; sharing the key avoids that fragile coupling).
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"},
    {"key": "rbac-admin-key", "scopes": ["read", "trade", "admin"], "label": "ci-rbac"},
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402

ADMIN = {"x-api-key": "admin-test-key"}


def _mint(role: str, scopes):
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": f"rbac-{role}", "scopes": scopes, "role": role,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    return body["id"], body["secret"], body


def test_viewer_role_cannot_mutate_even_if_trade_requested():
    c = TestClient(app)
    key_id, secret, body = _mint("viewer", ["read", "trade"])
    # The role cap drops the trade scope on creation. Both the stored
    # scopes and the effective_scopes echo the floor.
    assert body["role"] == "viewer"
    assert body["scopes"] == ["read"]
    assert body["effective_scopes"] == ["read"]

    # Reads work.
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 200, r.text

    # Writes are rejected by the scope enforcement middleware.
    r = c.post("/watchlist", headers={"x-api-key": secret},
               json={"ticker": "ZZZZ"})
    assert r.status_code == 403, r.text
    assert "missing scope" in r.json().get("detail", "").lower()


def test_member_role_cannot_reach_admin_routes():
    c = TestClient(app)
    _, secret, body = _mint("member", ["read", "trade"])
    assert body["role"] == "member"
    assert "admin" not in body["effective_scopes"]

    # Mutating a watchlist (trade scope) is fine.
    r = c.post("/watchlist", headers={"x-api-key": secret},
               json={"ticker": "AAAA"})
    assert r.status_code == 200, r.text

    # Admin routes require the admin scope which member never has.
    r = c.get("/admin/keys", headers={"x-api-key": secret})
    assert r.status_code == 403, r.text


def test_role_downgrade_revokes_privileges_on_next_request():
    c = TestClient(app)
    key_id, secret, body = _mint("admin", ["read", "trade"])
    assert "admin" in body["effective_scopes"]

    # While role=admin, the key can list other keys.
    r = c.get("/admin/keys", headers={"x-api-key": secret})
    assert r.status_code == 200, r.text

    # Downgrade to viewer.
    r = c.put(f"/admin/keys/{key_id}/role", headers=ADMIN,
              json={"role": "viewer"})
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "viewer"
    assert r.json()["effective_scopes"] == ["read"]

    # Same secret now cannot reach the admin route or mutate.
    r = c.get("/admin/keys", headers={"x-api-key": secret})
    assert r.status_code == 403, r.text
    r = c.post("/watchlist", headers={"x-api-key": secret},
               json={"ticker": "BBBB"})
    assert r.status_code == 403, r.text


def test_set_role_rejects_unknown_role():
    c = TestClient(app)
    key_id, _secret, _body = _mint("member", ["read"])
    r = c.put(f"/admin/keys/{key_id}/role", headers=ADMIN,
              json={"role": "superuser"})
    assert r.status_code == 400, r.text


def test_create_rejects_unknown_role():
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "bad", "scopes": ["read"], "role": "root",
    })
    assert r.status_code == 400, r.text
