"""Force-logout enforcement.

Confirms that ``DELETE /admin/sessions/{id}`` and
``POST /admin/sessions/revoke-key/{key_id}`` not only clear the active
ledger row but actively reject the next request from the same client
with HTTP 401, until the operator restores the session or the
revocation TTL expires.

Without this enforcement the admin "Revoke" button is theatre:
removing a row from the session ledger only clears the audit view; the
same client recreates the row on its next call.
"""
from __future__ import annotations
import os
import tempfile

# Keep env in lock-step with test_sessions_admin.py so the FastAPI
# app singleton (imported once per process) sees the same key set
# regardless of test order.
_TMP = tempfile.mkdtemp(prefix="sc_revocation_test_")
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

ADMIN_UA = "rev-admin/1.0"
READER_UA = "rev-reader/1.0"
ADMIN = {"x-api-key": "admin-test-key", "user-agent": ADMIN_UA}
READER = {"x-api-key": "reader-test-key", "user-agent": READER_UA}


def _seed_session(c: TestClient, headers: dict) -> str:
    r = c.get("/watchlist", headers=headers)
    assert r.status_code == 200, r.text
    rows = c.get("/admin/sessions", headers=ADMIN).json()["sessions"]
    for row in rows:
        if row["user_agent"] == headers["user-agent"]:
            return row["id"]
    raise AssertionError(
        f"session row not found for UA {headers['user-agent']}: {rows!r}")


def _clear_all_revocations(c: TestClient) -> None:
    """Wipe revocation state so test order does not bleed.

    The admin/sessions GET surfaces every active revocation; we lift
    each one through the restore endpoints, which are themselves
    exempt from the revocation gate.
    """
    body = c.get("/admin/sessions", headers=ADMIN).json()
    for r in body.get("revocations", []):
        if r["scope"] == "key":
            c.post(f"/admin/sessions/restore-key/{r['key_id']}", headers=ADMIN)
        else:
            c.post(f"/admin/sessions/{r['session_id']}/restore", headers=ADMIN)


def test_revoke_session_blocks_future_requests_then_restore_unblocks():
    c = TestClient(app)
    _clear_all_revocations(c)
    sid = _seed_session(c, READER)

    # Pre-revoke: reader works.
    assert c.get("/watchlist", headers=READER).status_code == 200

    # Revoke just this session row.
    r = c.delete(f"/admin/sessions/{sid}", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enforced"] is True
    assert body["revoked"] == sid

    # Post-revoke: same client is blocked with 401 BEFORE the route runs.
    r = c.get("/watchlist", headers=READER)
    assert r.status_code == 401, r.text
    assert r.headers.get("x-session-revoked") == "1"
    assert r.json()["detail"] == "session revoked"

    # A different UA (=different session_id) on the SAME key is NOT
    # blocked, because we placed a session-scope revocation only.
    other = {"x-api-key": "reader-test-key", "user-agent": "rev-other/1.0"}
    assert c.get("/watchlist", headers=other).status_code == 200

    # Restoring the session lifts the block.
    r = c.post(f"/admin/sessions/{sid}/restore", headers=ADMIN)
    assert r.status_code == 200, r.text
    assert c.get("/watchlist", headers=READER).status_code == 200
    _clear_all_revocations(c)


def test_revoke_key_blocks_every_session_for_that_key():
    c = TestClient(app)
    _clear_all_revocations(c)
    # Seed two distinct sessions for the reader key (two UAs).
    for ua in ("rev-key-a/1.0", "rev-key-b/1.0"):
        r = c.get(
            "/watchlist",
            headers={"x-api-key": "reader-test-key", "user-agent": ua},
        )
        assert r.status_code == 200, r.text

    rows = c.get("/admin/sessions", headers=ADMIN).json()["sessions"]
    key_ids = {row["key_id"] for row in rows
               if row["user_agent"] in ("rev-key-a/1.0", "rev-key-b/1.0")}
    assert len(key_ids) == 1, rows
    key_id = next(iter(key_ids))

    r = c.post(f"/admin/sessions/revoke-key/{key_id}", headers=ADMIN)
    assert r.status_code == 200, r.text
    assert r.json()["enforced"] is True

    # Every UA for that key is now blocked, including a brand new one.
    for ua in ("rev-key-a/1.0", "rev-key-b/1.0", "rev-key-c/1.0"):
        r = c.get(
            "/watchlist",
            headers={"x-api-key": "reader-test-key", "user-agent": ua},
        )
        assert r.status_code == 401, (ua, r.text)
        assert r.json()["scope"] == "key"

    # Admin key is untouched.
    assert c.get("/watchlist", headers=ADMIN).status_code == 200

    # Lift the block, reader works again.
    r = c.post(f"/admin/sessions/restore-key/{key_id}", headers=ADMIN)
    assert r.status_code == 200
    r = c.get(
        "/watchlist",
        headers={"x-api-key": "reader-test-key", "user-agent": "rev-key-a/1.0"},
    )
    assert r.status_code == 200
    _clear_all_revocations(c)


def test_revoke_all_exempts_calling_admin_and_blocks_others():
    c = TestClient(app)
    _clear_all_revocations(c)
    # Seed both admin and reader sessions.
    assert c.get("/watchlist", headers=READER).status_code == 200
    assert c.get("/watchlist", headers=ADMIN).status_code == 200

    r = c.post("/admin/sessions/revoke-all", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enforced"] is True
    assert body["caller_exempted"], body

    # Admin caller can still hit endpoints.
    assert c.get("/watchlist", headers=ADMIN).status_code == 200
    # Reader is now blocked.
    r = c.get("/watchlist", headers=READER)
    assert r.status_code == 401, r.text
    _clear_all_revocations(c)


def test_admin_recovery_surface_reachable_after_self_revoke():
    """An operator who accidentally revokes their own session must
    still reach /admin/sessions/* to undo the action.
    """
    c = TestClient(app)
    _clear_all_revocations(c)
    sid = _seed_session(c, ADMIN)
    r = c.delete(f"/admin/sessions/{sid}", headers=ADMIN)
    assert r.status_code == 200, r.text
    # Recovery routes remain reachable.
    r = c.get("/admin/sessions", headers=ADMIN)
    assert r.status_code == 200, r.text
    r = c.post(f"/admin/sessions/{sid}/restore", headers=ADMIN)
    assert r.status_code == 200
    assert c.get("/watchlist", headers=ADMIN).status_code == 200
    _clear_all_revocations(c)
