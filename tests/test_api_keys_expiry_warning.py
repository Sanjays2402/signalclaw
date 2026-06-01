"""Tests for the API-key expiry-warning surface.

Covers:
- ``is_expiring_soon`` / ``expiry_bucket`` pure helpers classify a row
  correctly (already-expired keys do not appear in the warning list).
- ``GET /admin/keys/expiring`` requires admin scope (RBAC) and returns
  a structured payload with rows sorted soonest-first.
- The endpoint validates ``within_days`` and returns a structured 400
  for out-of-range input.
- ``KeyExpiryWarningMiddleware`` attaches ``Sunset`` +
  ``X-Key-Expires-At`` / ``X-Key-Expires-In-Seconds`` /
  ``X-Key-Expiry-Bucket`` to a real authenticated request that uses a
  soon-to-expire user-managed key, and stays silent for a key with no
  expiry.
"""
from __future__ import annotations

import json as _json
import os
import tempfile
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_keys_expwarn_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps(
    [{"key": "admin-expwarn-key", "scopes": ["read", "trade", "admin"], "label": "ci"}]
)

from signalclaw.api.rate_limit import reset_registry  # noqa: E402

reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api_keys import (  # noqa: E402
    StoredKey,
    expiry_bucket,
    is_expiring_soon,
    seconds_until_expiry,
)

ADMIN = {"x-api-key": "admin-expwarn-key"}


def _iso(seconds_from_now: int) -> str:
    t = datetime.now(timezone.utc) + timedelta(seconds=seconds_from_now)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _mk(expires_at: str | None, *, revoked: bool = False) -> StoredKey:
    return StoredKey(
        id="k1", label="t", hash="h", prefix="sk_xxx", scopes=["read"],
        role="member", created_at=_iso(0),
        expires_at=expires_at,
        revoked=revoked,
    )


def test_helpers_classify_correctly() -> None:
    # No expiry -> never warns, bucket is ok.
    k = _mk(None)
    assert is_expiring_soon(k, 30) is False
    assert expiry_bucket(k) == "ok"

    # 12h out -> critical, warns inside any window >= 1d.
    k = _mk(_iso(12 * 3600))
    assert is_expiring_soon(k, 30) is True
    assert expiry_bucket(k) == "critical"
    assert (seconds_until_expiry(k) or 0) > 0

    # 5d out -> soon.
    k = _mk(_iso(5 * 86400))
    assert is_expiring_soon(k, 30) is True
    assert expiry_bucket(k) == "soon"

    # 20d out -> upcoming, warns inside 30d but not inside 7d.
    k = _mk(_iso(20 * 86400))
    assert is_expiring_soon(k, 30) is True
    assert is_expiring_soon(k, 7) is False
    assert expiry_bucket(k) == "upcoming"

    # Already expired -> does NOT appear in the warning list (handled
    # by the auth path), bucket is expired.
    k = _mk(_iso(-3600))
    assert is_expiring_soon(k, 30) is False
    assert expiry_bucket(k) == "expired"

    # Revoked -> never warns even if not yet expired.
    k = _mk(_iso(3600), revoked=True)
    assert is_expiring_soon(k, 30) is False

    # within_days <= 0 disables the check.
    k = _mk(_iso(3600))
    assert is_expiring_soon(k, 0) is False


def _mint(client: TestClient, label: str, *, expires_in: int | None,
          role: str = "member") -> tuple[str, str]:
    body: dict = {"label": label, "scopes": ["read", "trade"], "role": role}
    if expires_in is not None:
        body["expires_in_seconds"] = expires_in
    r = client.post("/admin/keys", json=body, headers=ADMIN)
    assert r.status_code == 200, r.text
    j = r.json()
    return j["id"], j["secret"]


def test_admin_keys_expiring_route_and_rbac() -> None:
    client = TestClient(app)

    # Mint three keys: 12h, 10d, 200d, plus one with no expiry.
    _mint(client, "critical", expires_in=12 * 3600)
    _mint(client, "upcoming", expires_in=10 * 86400)
    _mint(client, "far-future", expires_in=200 * 86400)
    _mint(client, "no-exp", expires_in=None)

    # Default within_days=30: returns critical + upcoming, not the
    # 200d one, not the no-expiry one.
    r = client.get("/admin/keys/expiring", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    labels = [k["label"] for k in body["keys"]]
    assert "critical" in labels
    assert "upcoming" in labels
    assert "far-future" not in labels
    assert "no-exp" not in labels
    # Soonest-first.
    secs = [k["expires_in_seconds"] for k in body["keys"]]
    assert secs == sorted(secs)
    assert body["window_days"] == 30
    assert body["counts"]["critical"] >= 1

    # Narrow window to 1d: only the 12h key.
    r = client.get("/admin/keys/expiring?within_days=1", headers=ADMIN)
    assert r.status_code == 200
    labels = [k["label"] for k in r.json()["keys"]]
    assert labels == ["critical"]

    # Bad input -> structured 400.
    r = client.get("/admin/keys/expiring?within_days=0", headers=ADMIN)
    assert r.status_code == 400
    r = client.get("/admin/keys/expiring?within_days=999999", headers=ADMIN)
    assert r.status_code == 400

    # RBAC: a non-admin caller is rejected. Mint a member key with no
    # admin scope and confirm 403.
    _id, member_secret = _mint(client, "member-probe", expires_in=3600,
                                role="member")
    r = client.get("/admin/keys/expiring",
                   headers={"x-api-key": member_secret})
    assert r.status_code in (401, 403)


def test_middleware_attaches_warning_headers() -> None:
    client = TestClient(app)

    # Key expiring in ~6 hours: should trigger the warning headers on
    # any normal authenticated request.
    _id, soon_secret = _mint(client, "soon-runner", expires_in=6 * 3600)
    r = client.get("/health", headers={"x-api-key": soon_secret})
    # /health is exempt: no warning headers there.
    assert "x-key-expires-at" not in {h.lower() for h in r.headers.keys()}

    # Non-exempt path. Use /admin/keys (admin scope key would be ideal;
    # we instead mint an admin-role key that expires soon).
    _id, admin_soon = _mint(client, "admin-soon", expires_in=6 * 3600,
                            role="admin")
    r = client.get("/admin/keys", headers={"x-api-key": admin_soon})
    # The handler may 200 or 403 depending on MFA posture, but the
    # middleware runs on the response either way.
    hdrs = {h.lower(): v for h, v in r.headers.items()}
    assert "x-key-expires-at" in hdrs
    assert "x-key-expires-in-seconds" in hdrs
    assert "x-key-expiry-bucket" in hdrs
    assert hdrs["x-key-expiry-bucket"] in ("critical", "soon")
    assert "sunset" in hdrs  # RFC 8594 advisory header

    # Key with no expiry: no warning headers.
    _id, ever_secret = _mint(client, "no-exp-runner", expires_in=None,
                             role="admin")
    r = client.get("/admin/keys", headers={"x-api-key": ever_secret})
    hdrs = {h.lower() for h in r.headers.keys()}
    assert "x-key-expires-at" not in hdrs
    assert "sunset" not in hdrs
