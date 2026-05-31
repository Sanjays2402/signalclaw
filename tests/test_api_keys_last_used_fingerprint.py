"""Tests for the forensic last-use fingerprint on API keys.

Enterprise procurement and SOC2 incident response require answering
"who used this credential, from where, with what client?" without
trawling raw logs. We persist ``last_used_ip`` and
``last_used_user_agent`` alongside ``last_used_at`` on every successful
auth and surface them via ``/admin/keys``.
"""
from __future__ import annotations

import json as _json
import os
import tempfile

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_lastuse_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402

ADMIN = {"x-api-key": "admin-test-key"}


def test_last_used_ip_and_user_agent_are_persisted():
    c = TestClient(app)
    # Mint a fresh read key so we are not racing other test rows.
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "forensic", "scopes": ["read"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    secret = body["secret"]
    key_id = body["id"]
    assert body.get("last_used_ip") in (None, "")
    assert body.get("last_used_user_agent") in (None, "")

    # Hit a real authed route with a distinctive UA so the store records it.
    ua = "signalclaw-procurement-suite/1.0 (forensic-probe)"
    resp = c.get(
        "/watchlist",
        headers={"x-api-key": secret, "user-agent": ua},
    )
    assert resp.status_code == 200, resp.text

    # /admin/keys reflects the IP + UA fingerprint for that row.
    listing = c.get("/admin/keys", headers=ADMIN).json()["keys"]
    row = next(k for k in listing if k["id"] == key_id)
    assert row["last_used_ip"], "last_used_ip must be populated after auth"
    assert row["last_used_user_agent"] == ua
    assert row["last_used_at"], "last_used_at must advance alongside fingerprint"


def test_user_agent_is_truncated_to_protect_store():
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": "ua-cap", "scopes": ["read"],
    })
    secret = r.json()["secret"]
    key_id = r.json()["id"]

    huge_ua = "X" * 4096
    assert c.get(
        "/watchlist",
        headers={"x-api-key": secret, "user-agent": huge_ua},
    ).status_code == 200

    listing = c.get("/admin/keys", headers=ADMIN).json()["keys"]
    row = next(k for k in listing if k["id"] == key_id)
    assert row["last_used_user_agent"] is not None
    assert len(row["last_used_user_agent"]) <= 256, (
        "UA must be truncated so a malicious caller cannot bloat the store"
    )
