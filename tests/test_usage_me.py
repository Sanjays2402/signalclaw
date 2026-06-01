"""Tests for the caller-facing ``GET /usage/me`` self-service endpoint.

Covers cross-tenant isolation (key A cannot see key B's usage),
auth enforcement (anonymous is rejected), and the response shape
(plan, used, remaining, reset_at). Reuses the ``quota_env`` fixture
pattern from ``test_quotas`` so the live process-wide app/quota
store is snapshotted and restored cleanly.
"""
from __future__ import annotations
import hashlib
import json as _json
import os
import pytest

from fastapi.testclient import TestClient

from signalclaw.api.rate_limit import reset_registry
from signalclaw.api import app
from signalclaw.quotas import get_quota_store, Plan, DEFAULT_PLAN_ID


_TEST_PLANS = (
    Plan(id="free", label="Free", monthly_limit=5, rate_per_minute=60),
    Plan(id="pro", label="Pro", monthly_limit=50, rate_per_minute=300),
    Plan(id="enterprise", label="Enterprise",
         monthly_limit=0, rate_per_minute=1200),
)

ADMIN_KEY = "usage-me-admin"
ADMIN = {"x-api-key": ADMIN_KEY}


@pytest.fixture
def quota_env():
    qs = get_quota_store()
    orig_plans = qs._plans  # type: ignore[attr-defined]
    orig_default = qs._default_plan_id  # type: ignore[attr-defined]
    qs._plans = {p.id: p for p in _TEST_PLANS}  # type: ignore[attr-defined]
    qs._default_plan_id = DEFAULT_PLAN_ID  # type: ignore[attr-defined]

    prior_keys_json = os.environ.get("SIGNALCLAW_API_KEYS_JSON")
    prior_api_key = os.environ.get("SIGNALCLAW_API_KEY")
    os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
        {"key": ADMIN_KEY, "scopes": ["read", "trade", "admin"],
         "label": "usage-me-admin"},
    ])
    os.environ["SIGNALCLAW_API_KEY"] = "usage-me-legacy"
    reset_registry()

    admin_scoped = f"env:{hashlib.sha256(ADMIN_KEY.encode()).hexdigest()[:8]}"
    qs.set_plan(admin_scoped, "enterprise")
    try:
        yield qs
    finally:
        qs._plans = orig_plans  # type: ignore[attr-defined]
        qs._default_plan_id = orig_default  # type: ignore[attr-defined]
        if prior_keys_json is None:
            os.environ.pop("SIGNALCLAW_API_KEYS_JSON", None)
        else:
            os.environ["SIGNALCLAW_API_KEYS_JSON"] = prior_keys_json
        if prior_api_key is None:
            os.environ.pop("SIGNALCLAW_API_KEY", None)
        else:
            os.environ["SIGNALCLAW_API_KEY"] = prior_api_key
        reset_registry()


def _client() -> TestClient:
    return TestClient(app)


def _mint(c: TestClient, label: str):
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read"], "role": "member",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    return body["id"], body["secret"]


def test_anonymous_rejected(quota_env):
    c = _client()
    r = c.get("/usage/me")
    assert r.status_code in (401, 403)


def test_returns_caller_scoped_usage(quota_env):
    c = _client()
    key_id, secret = _mint(c, "self-usage")
    h = {"x-api-key": secret}

    # Burn three calls against /watchlist (a counted route).
    for _ in range(3):
        rr = c.get("/watchlist", headers=h)
        assert rr.status_code == 200, rr.text

    r = c.get("/usage/me", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["key_id"] == f"key:{key_id}"
    assert body["plan"]["id"] == "free"
    assert body["used"] == 3
    assert body["remaining"] == 2
    assert body["reset_in_seconds"] > 0
    assert body["reset_at"].endswith("Z")
    assert isinstance(body["history"], dict)
    assert body["current_month"] in body["history"]


def test_cross_tenant_isolation(quota_env):
    """Key A must never see key B's usage row through /usage/me."""
    c = _client()
    a_id, a_secret = _mint(c, "tenant-a")
    b_id, b_secret = _mint(c, "tenant-b")

    # Tenant A makes 2 counted calls, tenant B makes 4.
    for _ in range(2):
        assert c.get("/watchlist", headers={"x-api-key": a_secret}).status_code == 200
    for _ in range(4):
        assert c.get("/watchlist", headers={"x-api-key": b_secret}).status_code == 200

    a = c.get("/usage/me", headers={"x-api-key": a_secret}).json()
    b = c.get("/usage/me", headers={"x-api-key": b_secret}).json()

    assert a["key_id"] == f"key:{a_id}"
    assert b["key_id"] == f"key:{b_id}"
    assert a["used"] == 2
    assert b["used"] == 4
    # A cannot influence its scoping with a query param or header trick:
    # only x-api-key drives the lookup.
    spoof = c.get(f"/usage/me?key_id={b_id}", headers={"x-api-key": a_secret}).json()
    assert spoof["key_id"] == f"key:{a_id}"
    assert spoof["used"] == 2


def test_self_probe_does_not_burn_quota(quota_env):
    """Polling /usage/me must not consume the quota it reports."""
    c = _client()
    _, secret = _mint(c, "self-probe")
    h = {"x-api-key": secret}
    for _ in range(10):
        r = c.get("/usage/me", headers=h)
        assert r.status_code == 200
    final = c.get("/usage/me", headers=h).json()
    assert final["used"] == 0
    assert final["remaining"] == 5
