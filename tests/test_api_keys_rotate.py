"""Tests for API key rotation with grace window.

These cover the FastAPI ``/admin/keys/{id}/rotate`` endpoint and the
``ApiKeyStore.rotate`` mechanics: grace-window predecessor validity,
immediate-cutover, expired-grace rejection, and audit/auth wiring.
"""
from __future__ import annotations

import json as _json
import os
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_rotate_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api_keys import ApiKeyStore  # noqa: E402

ADMIN = {"x-api-key": "admin-test-key"}


def _make_key(c: TestClient, label: str = "rotate-test") -> tuple[str, str]:
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read", "trade"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    return body["id"], body["secret"]


def test_rotate_immediate_invalidates_old_secret():
    c = TestClient(app)
    key_id, old = _make_key(c, "immediate")

    # old secret works
    assert c.get("/watchlist", headers={"x-api-key": old}).status_code == 200

    # rotate with zero grace
    r = c.post(f"/admin/keys/{key_id}/rotate", headers=ADMIN,
               json={"grace_seconds": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    new = body["secret"]
    assert new.startswith("sck_") and new != old
    assert body["grace_seconds"] == 0
    assert "secret" in body and "hash" not in body
    assert "previous_hash" not in body  # never exposed

    # new works, old does not
    assert c.get("/watchlist", headers={"x-api-key": new}).status_code == 200
    assert c.get("/watchlist", headers={"x-api-key": old}).status_code == 401


def test_rotate_with_grace_keeps_old_secret_temporarily():
    c = TestClient(app)
    key_id, old = _make_key(c, "graceful")

    # rotate with a 2-second grace window
    r = c.post(f"/admin/keys/{key_id}/rotate", headers=ADMIN,
               json={"grace_seconds": 2})
    assert r.status_code == 200, r.text
    new = r.json()["secret"]

    # both work during grace
    assert c.get("/watchlist", headers={"x-api-key": old}).status_code == 200
    assert c.get("/watchlist", headers={"x-api-key": new}).status_code == 200

    # after grace expires, old is rejected, new still works
    time.sleep(2.5)
    assert c.get("/watchlist", headers={"x-api-key": old}).status_code == 401
    assert c.get("/watchlist", headers={"x-api-key": new}).status_code == 200


def test_rotate_rejects_bad_grace_and_missing_key():
    c = TestClient(app)
    key_id, _ = _make_key(c, "validate")

    r = c.post(f"/admin/keys/{key_id}/rotate", headers=ADMIN,
               json={"grace_seconds": -1})
    assert r.status_code == 400

    r = c.post(f"/admin/keys/{key_id}/rotate", headers=ADMIN,
               json={"grace_seconds": 7 * 24 * 3600 + 1})
    assert r.status_code == 400

    r = c.post("/admin/keys/no-such-id/rotate", headers=ADMIN,
               json={"grace_seconds": 0})
    assert r.status_code == 404


def test_rotate_requires_admin_scope():
    c = TestClient(app)
    key_id, _ = _make_key(c, "rbac")

    # legacy test-key has no admin scope
    r = c.post(f"/admin/keys/{key_id}/rotate",
               headers={"x-api-key": "test-key"},
               json={"grace_seconds": 0})
    assert r.status_code in (401, 403)


def test_store_rotate_unit_preserves_scopes_and_id():
    store = ApiKeyStore(Path(_TMP) / "rotate-unit.json")
    rec, secret = store.create("u", scopes=["read", "trade"])
    out = store.rotate(rec.id, grace_seconds=0)
    assert out is not None
    new_rec, new_secret = out
    assert new_rec.id == rec.id
    assert new_rec.scopes == rec.scopes
    assert new_secret != secret
    assert store.lookup(secret) is None
    assert store.lookup(new_secret) is not None


def test_healthz_and_readyz_aliases():
    c = TestClient(app)
    assert c.get("/healthz").status_code == 200
    assert c.get("/readyz").status_code == 200
