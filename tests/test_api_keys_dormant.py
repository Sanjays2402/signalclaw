"""Tests for the API-key dormancy watchlist surface.

Covers:
- ``is_dormant`` / ``dormancy_bucket`` pure helpers classify a row by
  silence age (active / quiet / dormant / abandoned / revoked / unknown)
  and never flag a revoked or expired credential.
- ``GET /admin/keys/dormant`` requires admin scope (RBAC) and returns a
  structured payload with rows sorted longest-silent-first.
- The endpoint validates ``within_days`` and returns a structured 400
  for out-of-range input.

SOC2 CC6.1 / ISO 27001 A.9.2.5 require credential-life-cycle review;
this surface is the operator queue that drives those reviews.
"""
from __future__ import annotations

import json as _json
import os
import tempfile
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_keys_dormant_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps(
    [{"key": "admin-dormant-key", "scopes": ["read", "trade", "admin"], "label": "ci"}]
)

from signalclaw.api.rate_limit import reset_registry  # noqa: E402

reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api_keys import (  # noqa: E402
    StoredKey,
    dormancy_bucket,
    is_dormant,
    seconds_since_last_use,
)

api_key_store = app.state.api_key_store  # type: ignore[attr-defined]

ADMIN = {"x-api-key": "admin-dormant-key"}


def _iso(seconds_from_now: int) -> str:
    t = datetime.now(timezone.utc) + timedelta(seconds=seconds_from_now)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _mk(*, last_used: str | None, created: str | None = None,
        revoked: bool = False, expires_at: str | None = None) -> StoredKey:
    return StoredKey(
        id="k1", label="t", hash="h", prefix="sk_xxx", scopes=["read"],
        role="member", created_at=created or _iso(-365 * 86400),
        last_used_at=last_used, expires_at=expires_at, revoked=revoked,
    )


def test_dormancy_helpers_classify_correctly() -> None:
    now = datetime.now(timezone.utc)

    # Used 5 minutes ago -> active.
    k = _mk(last_used=_iso(-300))
    assert dormancy_bucket(k, now=now) == "active"
    assert is_dormant(k, 30, now=now) is False

    # Used 40 days ago -> quiet (and dormant for window=30).
    k = _mk(last_used=_iso(-40 * 86400))
    assert dormancy_bucket(k, now=now) == "quiet"
    assert is_dormant(k, 30, now=now) is True
    assert is_dormant(k, 90, now=now) is False
    assert (seconds_since_last_use(k, now=now) or 0) >= 40 * 86400 - 5

    # Used 120 days ago -> dormant.
    k = _mk(last_used=_iso(-120 * 86400))
    assert dormancy_bucket(k, now=now) == "dormant"
    assert is_dormant(k, 90, now=now) is True

    # Used 400 days ago -> abandoned.
    k = _mk(last_used=_iso(-400 * 86400))
    assert dormancy_bucket(k, now=now) == "abandoned"

    # Never used, created 200d ago -> abandoned (falls back to created_at).
    k = _mk(last_used=None, created=_iso(-200 * 86400))
    assert dormancy_bucket(k, now=now) == "abandoned"
    assert is_dormant(k, 30, now=now) is True

    # Revoked -> classified revoked, never dormant.
    k = _mk(last_used=_iso(-400 * 86400), revoked=True)
    assert dormancy_bucket(k, now=now) == "revoked"
    assert is_dormant(k, 30, now=now) is False

    # Already expired -> classified revoked (does not nag).
    k = _mk(last_used=_iso(-400 * 86400), expires_at=_iso(-3600))
    assert dormancy_bucket(k, now=now) == "revoked"
    assert is_dormant(k, 30, now=now) is False

    # within_days <= 0 disables the check.
    k = _mk(last_used=_iso(-400 * 86400))
    assert is_dormant(k, 0, now=now) is False


def _mint(client: TestClient, label: str) -> tuple[str, str]:
    r = client.post(
        "/admin/keys",
        json={"label": label, "scopes": ["read"], "role": "member"},
        headers=ADMIN,
    )
    assert r.status_code == 200, r.text
    j = r.json()
    return j["id"], j["secret"]


def _backdate(key_id: str, *, last_used_days: int | None,
              created_days: int | None = None) -> None:
    """Reach into the store and rewrite timestamps so a freshly minted
    key looks ancient for the watchlist test. We bypass the public API
    here on purpose: there is no /admin endpoint to fake a stale
    ``last_used_at`` (and we do not want one)."""
    rows = api_key_store._read()
    for r in rows:
        if r.id == key_id:
            if last_used_days is not None:
                r.last_used_at = _iso(-last_used_days * 86400)
            else:
                r.last_used_at = None
            if created_days is not None:
                r.created_at = _iso(-created_days * 86400)
    api_key_store._write(rows)
    api_key_store._reload_index()


def test_admin_keys_dormant_route_and_rbac() -> None:
    client = TestClient(app)

    fresh_id, _ = _mint(client, "fresh")
    quiet_id, _ = _mint(client, "quiet")
    dormant_id, _ = _mint(client, "dormant")
    abandoned_id, _ = _mint(client, "abandoned")
    never_id, _ = _mint(client, "never-used")

    # The fresh key was just minted by /admin/keys (created_at = now,
    # last_used_at = None). Leave it alone so it stays out of the list.
    _backdate(quiet_id, last_used_days=45)
    _backdate(dormant_id, last_used_days=120)
    _backdate(abandoned_id, last_used_days=400)
    _backdate(never_id, last_used_days=None, created_days=250)

    # Default within_days=30: returns quiet/dormant/abandoned/never,
    # not the fresh key.
    r = client.get("/admin/keys/dormant", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    labels = [k["label"] for k in body["keys"]]
    assert "fresh" not in labels
    assert "quiet" in labels
    assert "dormant" in labels
    assert "abandoned" in labels
    assert "never-used" in labels

    # Longest-silent-first ordering.
    secs = [k["silent_seconds"] for k in body["keys"]]
    assert secs == sorted(secs, reverse=True)

    assert body["window_days"] == 30
    assert body["counts"]["abandoned"] >= 1
    assert body["counts"]["never_used"] >= 1

    # Buckets present on every row.
    for k in body["keys"]:
        assert k["bucket"] in {"quiet", "dormant", "abandoned"}
        assert "silent_days" in k
        assert "never_used" in k

    # Narrow window to 100 days: drops the quiet (45d) key.
    r = client.get("/admin/keys/dormant?within_days=100", headers=ADMIN)
    assert r.status_code == 200
    labels = [k["label"] for k in r.json()["keys"]]
    assert "quiet" not in labels
    assert "dormant" in labels
    assert "abandoned" in labels

    # Bad input -> structured 400.
    r = client.get("/admin/keys/dormant?within_days=0", headers=ADMIN)
    assert r.status_code == 400
    r = client.get("/admin/keys/dormant?within_days=999999", headers=ADMIN)
    assert r.status_code == 400

    # RBAC: a non-admin caller is rejected.
    r = client.post(
        "/admin/keys",
        json={"label": "member-probe", "scopes": ["read"], "role": "member"},
        headers=ADMIN,
    )
    assert r.status_code == 200
    member_secret = r.json()["secret"]
    r = client.get("/admin/keys/dormant", headers={"x-api-key": member_secret})
    assert r.status_code in (401, 403)
