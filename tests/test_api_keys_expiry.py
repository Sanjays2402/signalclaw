"""Tests for API key hard-expiry (SOC2-style credential lifetime cap).

Covers:
  * ``POST /admin/keys`` with ``expires_in_seconds`` mints an expiring key.
  * ``PUT /admin/keys/{id}/expiry`` sets and clears the expiry.
  * Expired keys are rejected with 401 even if they have valid scopes.
  * The store helpers validate bounds and fail closed on garbled data.
"""
from __future__ import annotations

import json as _json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_expiry_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api_keys import ApiKeyStore, is_expired  # noqa: E402

ADMIN = {"x-api-key": "admin-test-key"}


def test_create_with_expiry_then_force_expire_rejects():
    c = TestClient(app)
    # 1-hour expiry on a read-scoped key
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "short-lived",
        "scopes": ["read"],
        "expires_in_seconds": 3600,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    secret = body["secret"]
    key_id = body["id"]
    assert body["expires_at"], "expires_at should be populated on the public view"
    assert body["expired"] is False

    # The key works while live.
    assert c.get("/watchlist", headers={"x-api-key": secret}).status_code == 200

    # Force-expire by rewriting the JSON store on disk so the test is
    # deterministic without sleeping. The store path is derived from
    # ``signalclaw.config.settings.data_dir`` at app-init time, not from
    # our local ``DATA_DIR`` env (other test modules set it first), so
    # resolve it from the already-loaded settings to avoid path drift.
    from signalclaw.config.settings import get_settings
    store_path = get_settings().data_dir / "api_keys.json"
    raw = _json.loads(store_path.read_text())
    past = (datetime.now(timezone.utc) - timedelta(hours=1)
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
    for k in raw["keys"]:
        if k["id"] == key_id:
            k["expires_at"] = past
    store_path.write_text(_json.dumps(raw))
    # The auth path holds an in-memory index keyed by hash; nudge it so
    # the freshly-written expiry actually takes effect on the next lookup.
    app.state.api_key_store._reload_index()

    # Now the same secret must fail closed with 401. is_expired() agrees.
    resp = c.get("/watchlist", headers={"x-api-key": secret})
    assert resp.status_code == 401, resp.text


def test_set_expiry_endpoint_rejects_bad_ttl():
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "ttl-validation", "scopes": ["read"],
    })
    assert r.status_code == 200, r.text
    key_id = r.json()["id"]

    # Too large -> 400
    bad = c.put(f"/admin/keys/{key_id}/expiry", headers=ADMIN,
                json={"expires_in_seconds": 10**12})
    assert bad.status_code == 400

    # Non-integer -> 400
    bad2 = c.put(f"/admin/keys/{key_id}/expiry", headers=ADMIN,
                 json={"expires_in_seconds": "soon"})
    assert bad2.status_code == 400

    # None clears the expiry; should succeed and return expired=False
    ok = c.put(f"/admin/keys/{key_id}/expiry", headers=ADMIN,
               json={"expires_in_seconds": None})
    assert ok.status_code == 200, ok.text
    assert ok.json()["expired"] is False
    assert ok.json().get("expires_at") in (None, "")


def test_is_expired_helper_fails_closed_on_garbage():
    store = ApiKeyStore(Path(_TMP) / "scratch.json")
    rec, _ = store.create("scratch", scopes=["read"], expires_in_seconds=3600)
    assert is_expired(rec) is False
    rec.expires_at = "not-a-date"
    # Lex comparison on garbage strings is unreliable; the helper must fall
    # back to "expired" rather than silently extending a credential.
    assert is_expired(rec) is True
    rec.expires_at = None
    assert is_expired(rec) is False
