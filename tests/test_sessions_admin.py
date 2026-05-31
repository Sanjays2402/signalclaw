from __future__ import annotations
import os
import tempfile
from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_sessions_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
import json as _json
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"},
    {"key": "reader-test-key", "scopes": ["read"], "label": "reader"},
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402

ADMIN = {"x-api-key": "admin-test-key"}
READER = {"x-api-key": "reader-test-key"}


def test_sessions_tracked_listed_and_revoked():
    c = TestClient(app)

    # Drive a few authenticated reads from two different keys with
    # distinct user agents so we get distinct session rows.
    r = c.get("/watchlist", headers={**READER, "user-agent": "ci-curl/1.0"})
    assert r.status_code == 200, r.text
    r = c.get("/watchlist", headers={**READER, "user-agent": "ci-curl/1.0"})
    assert r.status_code == 200
    r = c.get("/watchlist", headers={**ADMIN, "user-agent": "ci-admin/1.0"})
    assert r.status_code == 200

    # Admin can see both sessions.
    r = c.get("/admin/sessions", headers={**ADMIN, "user-agent": "ci-admin/1.0"})
    assert r.status_code == 200, r.text
    rows = r.json()["sessions"]
    by_label = {row["key_label"]: row for row in rows}
    assert "reader" in by_label
    assert "ci" in by_label
    reader_session = by_label["reader"]
    assert reader_session["request_count"] >= 2
    assert reader_session["user_agent"] == "ci-curl/1.0"

    # Non-admin cannot list sessions.
    r = c.get("/admin/sessions", headers=READER)
    assert r.status_code == 403, r.text

    # Revoke just the reader's session row.
    sid = reader_session["id"]
    r = c.delete(f"/admin/sessions/{sid}",
                 headers={**ADMIN, "user-agent": "ci-admin/1.0"})
    assert r.status_code == 200, r.text
    assert r.json()["revoked"] == sid

    # It's gone from the list (admin row still there).
    r = c.get("/admin/sessions", headers={**ADMIN, "user-agent": "ci-admin/1.0"})
    rows = r.json()["sessions"]
    ids = {row["id"] for row in rows}
    assert sid not in ids

    # Revoke-all clears every tracked session.
    r = c.post("/admin/sessions/revoke-all",
               headers={**ADMIN, "user-agent": "ci-admin/1.0"})
    assert r.status_code == 200, r.text
    n = r.json()["sessions_removed"]
    assert n >= 1

    # Underlying admin key still authenticates after revoke-all
    # (sessions are visibility, not credentials).
    r = c.get("/watchlist", headers={**ADMIN, "user-agent": "ci-admin/1.0"})
    assert r.status_code == 200, r.text


def test_revoke_missing_session_returns_404():
    c = TestClient(app)
    r = c.delete("/admin/sessions/does-not-exist",
                 headers={**ADMIN, "user-agent": "ci-admin/1.0"})
    assert r.status_code == 404, r.text
