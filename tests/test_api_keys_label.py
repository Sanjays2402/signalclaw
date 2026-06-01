"""Tests for PUT /admin/keys/{id}/label (rename without rotation).

Covers:
- Admin can rename a key; the secret keeps working.
- Empty / whitespace-only labels are rejected with 400.
- Labels are trimmed and clamped to 80 chars.
- A non-admin (member-scoped) key is denied with 403 (RBAC enforcement).
- A revoked key returns 404.
- Unknown key id returns 404.
"""
from __future__ import annotations
import os
import tempfile
from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_keys_label_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
import json as _json
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402

ADMIN = {"x-api-key": "admin-test-key"}


def _mint(label: str = "laptop", role: str = "member") -> tuple[str, str]:
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read", "trade"], "role": role,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    return body["id"], body["secret"]


def test_admin_renames_key_secret_still_works():
    c = TestClient(app)
    key_id, secret = _mint(label="old name")
    r = c.put(f"/admin/keys/{key_id}/label",
              headers=ADMIN, json={"label": "renamed by ops"})
    assert r.status_code == 200, r.text
    assert r.json()["label"] == "renamed by ops"
    # Secret still authenticates -- rename is metadata-only.
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 200, r.text
    # Listing reflects the new label.
    listed = c.get("/admin/keys", headers=ADMIN).json()["keys"]
    rec = next(k for k in listed if k["id"] == key_id)
    assert rec["label"] == "renamed by ops"


def test_label_is_trimmed_and_clamped():
    c = TestClient(app)
    key_id, _ = _mint(label="a")
    long_label = "  " + ("x" * 200) + "  "
    r = c.put(f"/admin/keys/{key_id}/label",
              headers=ADMIN, json={"label": long_label})
    assert r.status_code == 200, r.text
    assert len(r.json()["label"]) == 80
    assert r.json()["label"].startswith("x")


def test_empty_label_rejected():
    c = TestClient(app)
    key_id, _ = _mint(label="x")
    for bad in ["", "   ", "\t\n"]:
        r = c.put(f"/admin/keys/{key_id}/label",
                  headers=ADMIN, json={"label": bad})
        assert r.status_code == 400, (bad, r.text)


def test_non_admin_cannot_rename():
    """RBAC: a member-scoped key (no admin scope) gets 403."""
    c = TestClient(app)
    target_id, _ = _mint(label="target")
    # Create a separate member-scoped key and try to use it against the
    # admin endpoint.
    _, member_secret = _mint(label="member key", role="member")
    r = c.put(f"/admin/keys/{target_id}/label",
              headers={"x-api-key": member_secret},
              json={"label": "owned"})
    assert r.status_code == 403, r.text
    # And the original label is unchanged.
    listed = c.get("/admin/keys", headers=ADMIN).json()["keys"]
    rec = next(k for k in listed if k["id"] == target_id)
    assert rec["label"] == "target"


def test_revoked_key_returns_404():
    c = TestClient(app)
    key_id, _ = _mint(label="doomed")
    assert c.delete(f"/admin/keys/{key_id}", headers=ADMIN).status_code == 200
    r = c.put(f"/admin/keys/{key_id}/label",
              headers=ADMIN, json={"label": "ghost"})
    assert r.status_code == 404, r.text


def test_unknown_key_returns_404():
    c = TestClient(app)
    r = c.put("/admin/keys/does-not-exist/label",
              headers=ADMIN, json={"label": "nope"})
    assert r.status_code == 404, r.text


def test_bad_body_returns_400():
    c = TestClient(app)
    key_id, _ = _mint(label="x")
    r = c.put(f"/admin/keys/{key_id}/label",
              headers=ADMIN, json={"label": 123})
    assert r.status_code == 400, r.text
