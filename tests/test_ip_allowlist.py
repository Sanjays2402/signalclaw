"""Per-API-key IP allowlist enforcement.

Covers the store helpers (normalisation, membership) and the live HTTP
path through ``IPAllowlistMiddleware`` so a regression in either layer
fails CI before a buyer notices.
"""
from __future__ import annotations

import json as _json
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# Clean data dir + admin env key, same pattern as test_api_keys_admin.
_TMP = tempfile.mkdtemp(prefix="sc_ipallow_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api_keys import (  # noqa: E402
    ApiKeyStore, normalise_cidrs, is_ip_allowed,
)

ADMIN = {"x-api-key": "admin-test-key"}


# --- store-level ---------------------------------------------------------

def test_normalise_cidrs_accepts_ip_and_cidr_dedups():
    out = normalise_cidrs(["10.0.0.0/8", "10.0.0.0/8", "192.0.2.5", " "])
    assert out == ["10.0.0.0/8", "192.0.2.5/32"]


def test_normalise_cidrs_rejects_garbage():
    with pytest.raises(ValueError):
        normalise_cidrs(["not-an-ip"])


def test_normalise_cidrs_caps_entries():
    big = [f"10.0.{i}.0/24" for i in range(0, 70)]
    with pytest.raises(ValueError):
        normalise_cidrs(big)


def test_is_ip_allowed_empty_means_unrestricted(tmp_path):
    store = ApiKeyStore(tmp_path / "k.json")
    rec, _ = store.create("x", ["read"])
    assert is_ip_allowed(rec, "203.0.113.9") is True
    assert is_ip_allowed(rec, "") is True  # no allowlist = allow everything


def test_is_ip_allowed_matches_inside_cidr(tmp_path):
    store = ApiKeyStore(tmp_path / "k.json")
    rec, _ = store.create("x", ["read"])
    store.set_ip_allowlist(rec.id, ["10.0.0.0/8"])
    updated = next(k for k in store.list() if k.id == rec.id)
    assert is_ip_allowed(updated, "10.1.2.3") is True
    assert is_ip_allowed(updated, "192.0.2.1") is False
    # missing / garbled client IP fails closed when allowlist is set
    assert is_ip_allowed(updated, "") is False
    assert is_ip_allowed(updated, "not-an-ip") is False


# --- HTTP-level ----------------------------------------------------------

def _mint_user_key(client: TestClient, *, ip_allowlist=None):
    body = {"label": "tester", "scopes": ["read", "trade"]}
    if ip_allowlist is not None:
        body["ip_allowlist"] = ip_allowlist
    r = client.post("/admin/keys", headers=ADMIN, json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    return out["id"], out["secret"], out


def test_create_with_invalid_cidr_returns_400_and_no_phantom_key():
    c = TestClient(app)
    before = len(c.get("/admin/keys", headers=ADMIN).json()["keys"])
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "bad", "scopes": ["read"], "ip_allowlist": ["not-an-ip"],
    })
    assert r.status_code == 400, r.text
    after = c.get("/admin/keys", headers=ADMIN).json()["keys"]
    # Either the count is unchanged, or the placeholder was revoked.
    live = [k for k in after if not k.get("revoked")]
    assert len(live) <= before


def test_put_allowlist_then_enforced_on_request():
    c = TestClient(app)
    key_id, secret, _ = _mint_user_key(c)
    # No allowlist -> any client passes (TestClient peer is "testclient").
    r = c.get("/admin/keys", headers={"x-api-key": secret})
    # admin/keys requires admin scope; user key has only read+trade, so 403
    # from RBAC rather than 200. The point is it is NOT blocked by the
    # allowlist middleware (which would return 403 with
    # "client IP not in key allowlist").
    assert r.status_code in (200, 403)
    assert "client IP not in key allowlist" not in r.text

    # Restrict to a CIDR the TestClient peer cannot match.
    r = c.put(f"/admin/keys/{key_id}/ip-allowlist", headers=ADMIN,
              json={"ip_allowlist": ["198.51.100.0/24"]})
    assert r.status_code == 200, r.text
    assert r.json()["ip_allowlist"] == ["198.51.100.0/24"]

    # A request authenticated with the user key now hits IPAllowlistMiddleware
    # and is rejected with 403 + structured payload.
    r = c.get("/health", headers={"x-api-key": secret})
    # /health is exempt and should still succeed.
    assert r.status_code == 200

    r = c.get("/disclaimer", headers={"x-api-key": secret})
    assert r.status_code == 200  # also exempt

    # A non-exempt route is blocked.
    r = c.get("/whoami", headers={"x-api-key": secret})
    if r.status_code == 404:
        # endpoint name differs across versions; try a known one
        r = c.get("/v1/whoami", headers={"x-api-key": secret})
    assert r.status_code == 403, r.text
    body = r.json()
    assert body["detail"] == "client IP not in key allowlist"
    assert body["key_id"] == key_id
    assert body["allowlist"] == ["198.51.100.0/24"]

    # The same route with the admin env key (no allowlist) still works.
    r2 = c.get("/v1/whoami", headers=ADMIN)
    assert r2.status_code in (200, 404)  # 200 if endpoint exists

    # Clearing the allowlist restores access.
    r = c.put(f"/admin/keys/{key_id}/ip-allowlist", headers=ADMIN,
              json={"ip_allowlist": []})
    assert r.status_code == 200, r.text
    assert r.json()["ip_allowlist"] == []
    r = c.get("/v1/whoami", headers={"x-api-key": secret})
    assert r.status_code in (200, 404)


def test_put_allowlist_bad_cidr_returns_400():
    c = TestClient(app)
    key_id, _secret, _ = _mint_user_key(c)
    r = c.put(f"/admin/keys/{key_id}/ip-allowlist", headers=ADMIN,
              json={"ip_allowlist": ["nope"]})
    assert r.status_code == 400
    assert "invalid CIDR" in r.json()["detail"]


def test_put_allowlist_unknown_key_returns_404():
    c = TestClient(app)
    r = c.put("/admin/keys/does-not-exist/ip-allowlist", headers=ADMIN,
              json={"ip_allowlist": ["10.0.0.0/8"]})
    assert r.status_code == 404
