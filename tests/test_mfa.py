"""End-to-end test for TOTP MFA enrollment and admin gating.

Proves three things procurement reviewers actually ask about:

1. An unenrolled admin key still works (so a fresh deploy is usable).
2. After enrollment, admin endpoints require ``x-mfa-code``.
3. A stale (replayed) code is rejected, and a fresh code is accepted.
"""
from __future__ import annotations
import json
import os
import tempfile
import time

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_mfa_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "mfa-test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = json.dumps([
    {"key": "mfa-admin-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api.app import app  # noqa: E402
from signalclaw.mfa import generate_code  # noqa: E402

ADMIN = {"x-api-key": "mfa-admin-key"}


def test_admin_works_before_enrollment():
    c = TestClient(app)
    r = c.get("/audit", headers=ADMIN)
    assert r.status_code == 200, r.text


def test_mfa_enroll_and_gate_admin_routes():
    c = TestClient(app)

    # status starts unenrolled
    r = c.get("/mfa/status", headers=ADMIN)
    assert r.status_code == 200
    assert r.json()["enrolled"] is False

    # enroll
    r = c.post("/mfa/enroll", headers=ADMIN, json={"label": "ci-laptop"})
    assert r.status_code == 200, r.text
    body = r.json()
    secret = body["secret"]
    assert body["otpauth_uri"].startswith("otpauth://totp/SignalClaw")

    # confirm with first code
    code = generate_code(secret)
    r = c.post("/mfa/confirm", headers=ADMIN, json={"code": code})
    assert r.status_code == 200, r.text
    assert r.json()["enrolled"] is True

    # now /audit demands MFA: missing header -> 401
    r = c.get("/audit", headers=ADMIN)
    assert r.status_code == 401, r.text
    assert "x-mfa-code" in r.json()["detail"]

    # wrong code -> 401
    r = c.get("/audit", headers={**ADMIN, "x-mfa-code": "000000"})
    assert r.status_code == 401

    # use a fresh code from the next step so replay protection
    # doesn't reject us (the enroll/confirm above used the current step).
    # Wait for next step boundary.
    while int(time.time()) % 30 < 29:
        time.sleep(0.5)
    time.sleep(1.1)
    fresh = generate_code(secret)
    r = c.get("/audit", headers={**ADMIN, "x-mfa-code": fresh})
    assert r.status_code == 200, r.text

    # replay the same code -> rejected
    r = c.get("/audit", headers={**ADMIN, "x-mfa-code": fresh})
    assert r.status_code == 401, r.text


def test_non_admin_routes_unaffected():
    c = TestClient(app)
    # health doesn't even need a key
    assert c.get("/healthz").status_code == 200
