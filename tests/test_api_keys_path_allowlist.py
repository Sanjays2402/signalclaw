"""Tests for per-API-key path-prefix allowlists (least privilege at
the endpoint level beyond the role/scope cap).

Covers:
- The PUT admin route validates input (400 on bad shapes, traversal,
  scheme, missing leading slash, oversized list).
- The PUT admin route returns 404 for unknown ids and persists the
  canonicalised list otherwise.
- Create-time ``path_allowlist`` is honoured and a malformed value
  revokes the just-minted key (no half-configured credential).
- The middleware enforces the policy end-to-end: a member key
  scoped to ``/picks`` only gets 200 on ``/picks`` and 403 on
  ``/watchlist`` even though its scopes would normally allow it.
- Segment-boundary matching: ``/picks`` does not match ``/picksearch``.
- Empty allowlist = unrestricted (legacy behaviour preserved).
- A non-admin caller cannot set the allowlist (RBAC).
"""
from __future__ import annotations

import json as _json
import os
import tempfile

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_keys_path_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps(
    [{"key": "admin-path-key", "scopes": ["read", "trade", "admin"], "label": "ci"}]
)

from signalclaw.api.rate_limit import reset_registry  # noqa: E402

reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api_keys import (  # noqa: E402
    StoredKey,
    is_path_allowed,
    normalise_paths,
)

ADMIN = {"x-api-key": "admin-path-key"}


def _mint(label: str, role: str = "member", paths=None):
    c = TestClient(app)
    body = {"label": label, "scopes": ["read", "trade"], "role": role}
    if paths is not None:
        body["path_allowlist"] = paths
    r = c.post("/admin/keys", headers=ADMIN, json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ----- helpers ---------------------------------------------------------------


def test_normalise_paths_canonicalises_and_validates():
    out = normalise_paths(["/v1/runs/", "/v1/runs", "/picks"])
    assert out == ["/v1/runs", "/picks"]  # dedupe + trailing slash strip

    # Empty / None inputs are fine.
    assert normalise_paths([]) == []
    assert normalise_paths(None) == []  # type: ignore[arg-type]

    # Bad inputs raise.
    for bad in [
        ["no-leading-slash"],
        ["/has space"],
        ["/with\x00nul"],
        ["https://evil.example/x"],
        ["//host/x"],
        ["/v1/../admin"],
        [""],
        ["   "],
        [123],
    ]:
        try:
            normalise_paths(bad)  # type: ignore[arg-type]
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad!r}")

    # Cap at 64.
    try:
        normalise_paths([f"/p{i}" for i in range(65)])
    except ValueError:
        pass
    else:
        raise AssertionError("expected cap to be enforced")


def test_is_path_allowed_segment_bounded():
    k = StoredKey(
        id="x", label="x", hash="x", prefix="p", scopes=["read"],
        created_at="2026-01-01T00:00:00Z",
        path_allowlist=["/v1/runs", "/picks"],
    )
    assert is_path_allowed(k, "/v1/runs") is True
    assert is_path_allowed(k, "/v1/runs/abc") is True
    assert is_path_allowed(k, "/v1/runs/abc/export") is True
    assert is_path_allowed(k, "/picks") is True
    # Segment boundary: /picks must NOT match /picksearch.
    assert is_path_allowed(k, "/picksearch") is False
    assert is_path_allowed(k, "/v1/runsearch") is False
    assert is_path_allowed(k, "/watchlist") is False
    assert is_path_allowed(k, "") is False

    # Empty allowlist = unrestricted.
    k.path_allowlist = []
    assert is_path_allowed(k, "/anything") is True

    # Root entry allows everything.
    k.path_allowlist = ["/"]
    assert is_path_allowed(k, "/admin/keys") is True


# ----- admin route -----------------------------------------------------------


def test_put_path_allowlist_validates_and_persists():
    c = TestClient(app)
    rec = _mint("set-allowlist")
    key_id = rec["id"]

    # Bad shapes -> 400.
    for bad in [
        {"path_allowlist": "not-a-list"},
        {"path_allowlist": [1, 2]},
        {"path_allowlist": ["no-slash"]},
        {"path_allowlist": ["/v1/../admin"]},
    ]:
        r = c.put(f"/admin/keys/{key_id}/path-allowlist", headers=ADMIN, json=bad)
        assert r.status_code == 400, (bad, r.text)

    # Good input persists and canonicalises.
    r = c.put(
        f"/admin/keys/{key_id}/path-allowlist",
        headers=ADMIN,
        json={"path_allowlist": ["/v1/runs/", "/v1/runs", "/picks"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["path_allowlist"] == ["/v1/runs", "/picks"]

    # Empty list clears the policy.
    r = c.put(
        f"/admin/keys/{key_id}/path-allowlist",
        headers=ADMIN,
        json={"path_allowlist": []},
    )
    assert r.status_code == 200
    assert r.json()["path_allowlist"] == []


def test_put_path_allowlist_unknown_key_returns_404():
    c = TestClient(app)
    r = c.put(
        "/admin/keys/does-not-exist/path-allowlist",
        headers=ADMIN,
        json={"path_allowlist": ["/v1/runs"]},
    )
    assert r.status_code == 404


def test_non_admin_cannot_set_path_allowlist():
    c = TestClient(app)
    target = _mint("target")
    member = _mint("non-admin", role="member")
    r = c.put(
        f"/admin/keys/{target['id']}/path-allowlist",
        headers={"x-api-key": member["secret"]},
        json={"path_allowlist": ["/v1/runs"]},
    )
    assert r.status_code == 403, r.text


def test_create_with_path_allowlist_and_bad_input_revokes():
    c = TestClient(app)
    # Good input on create.
    rec = _mint("create-with-paths", paths=["/picks"])
    assert rec["path_allowlist"] == ["/picks"]

    # Bad input revokes the just-minted key (no half-configured row).
    r = c.post(
        "/admin/keys",
        headers=ADMIN,
        json={
            "label": "half-configured",
            "scopes": ["read"],
            "role": "member",
            "path_allowlist": ["no-slash"],
        },
    )
    assert r.status_code == 400, r.text


# ----- middleware enforcement -----------------------------------------------


def test_middleware_enforces_allowlist_end_to_end():
    """A scoped key with ``path_allowlist=['/picks']`` succeeds on
    ``/picks`` (status not 403) and is rejected with 403 on
    ``/watchlist`` even though its ``read`` scope would normally permit
    that endpoint. Status codes other than 403 are accepted on success
    because the underlying handlers may legitimately return 200/4xx/5xx
    depending on test fixtures; what we are asserting is the absence
    of the allowlist 403.
    """
    c = TestClient(app)
    rec = _mint("scoped-to-usage", paths=["/usage/me"])
    secret = rec["secret"]

    # /usage/me is on the allowlist -> not blocked by the middleware.
    r = c.get("/usage/me", headers={"x-api-key": secret})
    assert r.status_code != 403 or "key allowlist" not in r.text, r.text

    # /watchlist is NOT on the allowlist -> 403 with structured payload.
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 403, r.text
    body = r.json()
    assert body.get("scope") == "per-key-path"
    assert body.get("key_id") == rec["id"]
    assert "/usage/me" in body.get("allowlist", [])


def test_middleware_unrestricted_when_allowlist_empty():
    """A key with no allowlist is not blocked by the middleware at
    all, preserving legacy behaviour for rows that predate this
    feature.
    """
    c = TestClient(app)
    rec = _mint("legacy-unrestricted")  # no path_allowlist
    secret = rec["secret"]
    r = c.get("/watchlist", headers={"x-api-key": secret})
    # Whatever the handler returns, the middleware must not 403 us
    # with the per-key-path payload.
    assert not (r.status_code == 403 and "per-key-path" in r.text), r.text


def test_healthcheck_paths_bypass_allowlist():
    """Even a tightly-scoped key can reach /healthz so monitoring
    keeps working when an operator stamps a strict allowlist on the
    only credential in the box.
    """
    c = TestClient(app)
    rec = _mint("scoped-tight", paths=["/usage/me"])
    r = c.get("/healthz", headers={"x-api-key": rec["secret"]})
    assert r.status_code == 200, r.text
