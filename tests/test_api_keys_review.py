"""Tests for periodic access-review attestation on API keys.

Covers:
- Admin can attest a key and the audit fields move forward.
- A non-admin (member-scoped) key gets 403 (RBAC enforcement).
- Unknown key id returns 404.
- ``review_overdue`` flips correctly when a key's interval has elapsed.
- ``GET /admin/keys/review-overdue`` only surfaces past-due live keys.
- ``set_review_interval`` clamps to 1..365 and rejects bad input.
"""
from __future__ import annotations

import json as _json
import os
import tempfile
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_keys_review_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps(
    [{"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}]
)

from signalclaw.api.rate_limit import reset_registry  # noqa: E402

reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api_keys import (  # noqa: E402
    is_review_overdue,
    review_due_at,
)

ADMIN = {"x-api-key": "admin-test-key"}


def _mint(label: str = "laptop", role: str = "member") -> tuple[str, str]:
    c = TestClient(app)
    r = c.post(
        "/admin/keys",
        headers=ADMIN,
        json={"label": label, "scopes": ["read", "trade"], "role": role},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    return body["id"], body["secret"]


def test_admin_attests_key_review():
    c = TestClient(app)
    key_id, _secret = _mint(label="attest target")

    # Fresh key: review fields are present, not yet reviewed.
    listed = c.get("/admin/keys", headers=ADMIN).json()["keys"]
    rec = next(k for k in listed if k["id"] == key_id)
    assert rec["last_reviewed_at"] is None
    assert rec["review_interval_days"] == 90
    assert rec["review_due_at"] is not None
    assert rec["review_overdue"] is False

    # Admin attests.
    r = c.post(f"/admin/keys/{key_id}/review", headers=ADMIN, json={})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["last_reviewed_at"] is not None
    # Reviewer prefix is the actor's key prefix; non-empty and bounded.
    assert isinstance(out["last_reviewed_by"], str)
    assert 0 < len(out["last_reviewed_by"]) <= 16
    assert out["review_overdue"] is False


def test_attest_with_interval_change():
    c = TestClient(app)
    key_id, _ = _mint(label="interval combo")
    r = c.post(
        f"/admin/keys/{key_id}/review",
        headers=ADMIN,
        json={"interval_days": 30},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["review_interval_days"] == 30
    assert out["last_reviewed_at"] is not None


def test_set_review_interval_rejects_out_of_range():
    c = TestClient(app)
    key_id, _ = _mint(label="bad interval")
    for bad in [0, -1, 366, 10_000]:
        r = c.put(
            f"/admin/keys/{key_id}/review-interval",
            headers=ADMIN,
            json={"days": bad},
        )
        assert r.status_code == 400, (bad, r.text)
    r = c.put(
        f"/admin/keys/{key_id}/review-interval",
        headers=ADMIN,
        json={"days": "not-an-int"},
    )
    assert r.status_code == 400, r.text


def test_unknown_key_returns_404():
    c = TestClient(app)
    r = c.post("/admin/keys/does-not-exist/review", headers=ADMIN, json={})
    assert r.status_code == 404


def test_non_admin_cannot_attest():
    """RBAC: a member-scoped key (no admin scope) gets 403."""
    c = TestClient(app)
    key_id, _ = _mint(label="target")
    _, member_secret = _mint(label="non-admin", role="member")
    r = c.post(
        f"/admin/keys/{key_id}/review",
        headers={"x-api-key": member_secret},
        json={},
    )
    assert r.status_code == 403, r.text


def test_non_admin_cannot_view_overdue():
    c = TestClient(app)
    _, member_secret = _mint(label="non-admin viewer", role="member")
    r = c.get(
        "/admin/keys/review-overdue",
        headers={"x-api-key": member_secret},
    )
    assert r.status_code == 403, r.text


def test_overdue_listing_surfaces_only_past_due_keys():
    """Forge a past-due last_reviewed_at on disk and confirm the
    overdue queue picks it up, while a freshly attested key does not."""
    c = TestClient(app)
    overdue_id, _ = _mint(label="overdue target")
    fresh_id, _ = _mint(label="fresh target")

    # Attest the fresh one so it's not overdue.
    r = c.post(f"/admin/keys/{fresh_id}/review", headers=ADMIN, json={})
    assert r.status_code == 200

    # Backdate the other on disk: pretend it was reviewed 200 days ago
    # with a 90 day interval, which puts the next-due well in the past.
    # Use the actually-loaded app's store path so this works regardless
    # of import order with other test modules that set DATA_DIR first.
    store_path = app.state.api_key_store.path
    raw = _json.loads(store_path.read_text())
    past = (datetime.utcnow() - timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for row in raw["keys"]:
        if row["id"] == overdue_id:
            row["last_reviewed_at"] = past
            row["review_interval_days"] = 90
    store_path.write_text(_json.dumps(raw))
    # Force the in-memory key store to re-read from disk so the
    # forged timestamp is what /admin/keys/review-overdue evaluates.
    app.state.api_key_store._reload_index()

    r = c.get("/admin/keys/review-overdue", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    ids = {k["id"] for k in body["keys"]}
    assert overdue_id in ids
    assert fresh_id not in ids
    assert body["count"] == len(body["keys"]) >= 1


def test_helpers_handle_unparseable_timestamps():
    """A corrupted last_reviewed_at fails closed: treated as due now."""
    from signalclaw.api_keys import StoredKey

    k = StoredKey(
        id="x",
        label="x",
        hash="x",
        prefix="sck_xxxx",
        scopes=["read"],
        created_at="not-a-date",
    )
    # Unparseable created_at + no last_reviewed_at -> due now (not None).
    assert review_due_at(k) is not None
    assert is_review_overdue(k) is True
