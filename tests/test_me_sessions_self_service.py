"""Self-service /me/sessions endpoints.

Procurement reviewers expect every API-key holder to be able to see
and revoke their own active sessions without an operator round-trip.
These tests prove:

1. A caller can list only their own sessions.
2. A caller can revoke their own session.
3. A caller cannot revoke another tenant's session (cross-tenant
   isolation): the response is 404, never 403, so the endpoint
   cannot be used as an oracle to enumerate other tenants' session
   ids.
4. revoke-others clears every session for the caller's key except
   the one making the call.
"""
from __future__ import annotations
import os
import tempfile

# Keep env in lock-step with the other session tests so the FastAPI
# app singleton (imported once per process) sees the same key set
# regardless of test order. Use setdefault so we never clobber.
_TMP = tempfile.mkdtemp(prefix="sc_me_sessions_test_")
os.environ.setdefault("DATA_DIR", _TMP)
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
import json as _json
os.environ.setdefault("SIGNALCLAW_API_KEYS_JSON", _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"},
    {"key": "reader-test-key", "scopes": ["read"], "label": "reader"},
]))

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from fastapi.testclient import TestClient  # noqa: E402
from signalclaw.api import app  # noqa: E402

# Two distinct tenants for cross-tenant isolation checks.
ALICE = {"x-api-key": "reader-test-key"}  # non-admin tenant
BOB = {"x-api-key": "admin-test-key"}     # other tenant (also admin)


def _warm(client, headers, ua):
    r = client.get("/watchlist", headers={**headers, "user-agent": ua})
    assert r.status_code == 200, r.text


def test_me_sessions_returns_only_caller_sessions():
    c = TestClient(app)
    _warm(c, ALICE, "alice-laptop/1.0")
    _warm(c, ALICE, "alice-phone/1.0")
    _warm(c, BOB, "bob-laptop/1.0")

    r = c.get("/me/sessions",
              headers={**ALICE, "user-agent": "alice-laptop/1.0"})
    assert r.status_code == 200, r.text
    body = r.json()
    uas = sorted(s["user_agent"] for s in body["sessions"])
    assert "alice-laptop/1.0" in uas
    assert "alice-phone/1.0" in uas
    # Cross-tenant isolation: Bob's session must not leak.
    assert all("bob" not in s["user_agent"] for s in body["sessions"])
    current = [s for s in body["sessions"] if s["current"]]
    assert len(current) == 1
    assert current[0]["user_agent"] == "alice-laptop/1.0"


def test_me_sessions_revoke_own_session():
    c = TestClient(app)
    _warm(c, ALICE, "alice-laptop/2.0")
    _warm(c, ALICE, "alice-phone/2.0")

    r = c.get("/me/sessions",
              headers={**ALICE, "user-agent": "alice-laptop/2.0"})
    sessions = r.json()["sessions"]
    phone = next(s for s in sessions if s["user_agent"] == "alice-phone/2.0")

    r = c.delete(f"/me/sessions/{phone['id']}",
                 headers={**ALICE, "user-agent": "alice-laptop/2.0"})
    assert r.status_code == 200, r.text
    assert r.json()["revoked"] == phone["id"]
    assert r.json()["self_logged_out"] is False

    r = c.get("/me/sessions",
              headers={**ALICE, "user-agent": "alice-laptop/2.0"})
    ids = {s["id"] for s in r.json()["sessions"]}
    assert phone["id"] not in ids


def test_me_sessions_cannot_revoke_other_tenant_session():
    """Cross-tenant isolation: Alice cannot revoke Bob's session.
    The endpoint returns 404 (not 403) so it cannot be used as an
    oracle to enumerate other tenants' session ids.
    """
    c = TestClient(app)
    _warm(c, BOB, "bob-laptop/3.0")
    _warm(c, ALICE, "alice-laptop/3.0")

    # Use admin endpoint to capture Bob's session id (admin == Bob here).
    r = c.get("/admin/sessions",
              headers={**BOB, "user-agent": "bob-laptop/3.0"})
    assert r.status_code == 200, r.text
    bob_row = next(s for s in r.json()["sessions"]
                   if s["user_agent"] == "bob-laptop/3.0")

    # Alice's /me/sessions view never contains Bob's row.
    r = c.get("/me/sessions",
              headers={**ALICE, "user-agent": "alice-laptop/3.0"})
    assert r.status_code == 200
    assert all(s["id"] != bob_row["id"] for s in r.json()["sessions"])

    # Alice tries to revoke Bob's session by id. Must 404.
    r = c.delete(f"/me/sessions/{bob_row['id']}",
                 headers={**ALICE, "user-agent": "alice-laptop/3.0"})
    assert r.status_code == 404, r.text

    # Bob's session is still alive.
    r = c.get("/watchlist",
              headers={**BOB, "user-agent": "bob-laptop/3.0"})
    assert r.status_code == 200


def test_me_sessions_revoke_others_keeps_current():
    c = TestClient(app)
    _warm(c, ALICE, "alice-laptop/4.0")
    _warm(c, ALICE, "alice-phone/4.0")
    _warm(c, ALICE, "alice-tablet/4.0")

    r = c.post("/me/sessions/revoke-others",
               headers={**ALICE, "user-agent": "alice-laptop/4.0"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] >= 2
    assert body["current_session_id"] not in body["revoked"]

    # Current session still works.
    r = c.get("/watchlist",
              headers={**ALICE, "user-agent": "alice-laptop/4.0"})
    assert r.status_code == 200

    # Revoked sessions are enforced by the revocation middleware: the
    # next call from a revoked UA is rejected with HTTP 401.
    r = c.get("/watchlist",
              headers={**ALICE, "user-agent": "alice-phone/4.0"})
    assert r.status_code == 401, r.text


def test_me_sessions_requires_auth():
    c = TestClient(app)
    r = c.get("/me/sessions")
    assert r.status_code in (401, 403)


def teardown_module(_mod):
    """Leave the shared session + revocation stores clean so other
    test modules that depend on a fresh ledger (e.g.
    test_sessions_admin.py) are not order-coupled to us.
    """
    try:
        store = getattr(app.state, "session_store", None)
        if store is not None:
            store.revoke_all()
    except Exception:
        pass
    try:
        rev = getattr(app.state, "revocation_store", None)
        if rev is not None:
            for r in list(rev.list()):
                if getattr(r, "scope", "session") == "session":
                    rev.clear_session(r.session_id)
                elif r.key_id:
                    rev.clear_key(r.key_id)
    except Exception:
        pass
