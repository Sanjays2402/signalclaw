from __future__ import annotations
import os
import tempfile
from fastapi.testclient import TestClient

# Use a clean data dir so the key store starts empty.
_TMP = tempfile.mkdtemp(prefix="sc_keys_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
# Give the env key admin scope so /admin/keys is reachable in tests.
import json as _json
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry, set_user_key_store
reset_registry()

from signalclaw.api import app  # noqa: E402

ADMIN = {"x-api-key": "admin-test-key"}


def test_admin_keys_lifecycle():
    c = TestClient(app)
    # empty
    r = c.get("/admin/keys", headers=ADMIN)
    assert r.status_code == 200, r.text
    initial = len(r.json()["keys"])

    # create
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "my laptop", "scopes": ["read", "trade"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    secret = body["secret"]
    key_id = body["id"]
    assert secret.startswith("sck_")
    assert body["label"] == "my laptop"
    assert "read" in body["scopes"] and "trade" in body["scopes"]
    assert "admin" not in body["scopes"]  # cannot self-escalate

    # list now shows it without the secret
    r = c.get("/admin/keys", headers=ADMIN)
    listed = r.json()["keys"]
    assert len(listed) == initial + 1
    rec = next(k for k in listed if k["id"] == key_id)
    assert "hash" not in rec and "secret" not in rec

    # the newly minted secret can authenticate a read endpoint
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 200, r.text

    # the newly minted secret can mutate (has trade scope)
    r = c.post("/watchlist", headers={"x-api-key": secret},
               json={"ticker": "ZZZZ"})
    assert r.status_code == 200, r.text

    # revoke
    r = c.delete(f"/admin/keys/{key_id}", headers=ADMIN)
    assert r.status_code == 200

    # revoked key no longer authenticates
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 401

    # double-revoke is 404
    r = c.delete(f"/admin/keys/{key_id}", headers=ADMIN)
    assert r.status_code == 404


def test_admin_keys_requires_admin_scope():
    c = TestClient(app)
    # the legacy test-key is not admin; should be forbidden
    r = c.get("/admin/keys", headers={"x-api-key": "test-key"})
    assert r.status_code in (401, 403)


def test_create_key_rejects_admin_scope_in_request():
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "sneaky", "scopes": ["admin", "trade"],
    })
    assert r.status_code == 200
    assert "admin" not in r.json()["scopes"]
    assert "trade" in r.json()["scopes"]
