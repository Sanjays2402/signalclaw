"""End-to-end tests for the per-key monthly quota subsystem.

Covers:
* ``X-RateLimit-*`` headers on a normal authenticated request.
* Enforcement of the monthly ceiling (429 + Retry-After + structured body).
* Admin plan reassignment (``PUT /admin/keys/{id}/plan``) immediately
  changes the cap that the middleware enforces on the next call.
* Anonymous requests are not billed and receive no ``X-RateLimit-*``
  headers (they fall through to the existing auth gate).

We share the process-wide app instance with the rest of the suite, so
we cannot rebuild the app or permanently mutate env vars. Each test
swaps the live QuotaStore's plan catalogue to a tiny test catalogue
for the duration of the test and restores the production catalogue
on the way out. Env API-key state is snapshot/restored similarly so
sibling test modules keep their own admin credentials.
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
    Plan(id="free", label="Free", monthly_limit=3, rate_per_minute=60),
    Plan(id="pro", label="Pro", monthly_limit=50, rate_per_minute=300),
    Plan(id="enterprise", label="Enterprise",
         monthly_limit=0, rate_per_minute=1200),
)

ADMIN_KEY = "quota-admin"
ADMIN = {"x-api-key": ADMIN_KEY}


@pytest.fixture
def quota_env():
    """Swap in tiny test plans + a known admin key for one test.

    Restores the prior plan catalogue, prior env keys, and the prior
    registry singleton on teardown so sibling test modules remain
    isolated.
    """
    qs = get_quota_store()
    orig_plans = qs._plans  # type: ignore[attr-defined]
    orig_default = qs._default_plan_id  # type: ignore[attr-defined]
    qs._plans = {p.id: p for p in _TEST_PLANS}  # type: ignore[attr-defined]
    qs._default_plan_id = DEFAULT_PLAN_ID  # type: ignore[attr-defined]

    prior_keys_json = os.environ.get("SIGNALCLAW_API_KEYS_JSON")
    prior_api_key = os.environ.get("SIGNALCLAW_API_KEY")
    os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
        {"key": ADMIN_KEY, "scopes": ["read", "trade", "admin"],
         "label": "quota-test-admin"},
    ])
    os.environ["SIGNALCLAW_API_KEY"] = "quota-test-legacy"
    reset_registry()

    # Park admin on enterprise so admin probes do not eat quota.
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


def _mint_user_key(c: TestClient, label: str, role: str = "member"):
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read"], "role": role,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    return body["id"], body["secret"]


def test_response_has_standard_rate_limit_headers(quota_env):
    c = _client()
    r = c.get("/disclaimer", headers=ADMIN)
    assert r.status_code == 200
    assert "X-RateLimit-Limit" not in r.headers

    r = c.get("/watchlist", headers=ADMIN)
    assert r.status_code == 200
    assert r.headers.get("X-RateLimit-Scope") == "monthly"
    assert r.headers["X-RateLimit-Limit"] == "0"
    assert r.headers["X-RateLimit-Remaining"] == "unlimited"
    assert "X-RateLimit-Reset" in r.headers


def test_anonymous_requests_are_not_billed(quota_env):
    c = _client()
    r = c.get("/watchlist")
    assert r.status_code in (401, 403)
    assert "X-RateLimit-Limit" not in r.headers


def test_monthly_ceiling_returns_429_and_lifts_on_upgrade(quota_env):
    c = _client()
    key_id, secret = _mint_user_key(c, "quota-test-key")
    headers = {"x-api-key": secret}

    for i in range(3):
        r = c.get("/watchlist", headers=headers)
        assert r.status_code == 200, (i, r.text)
        assert r.headers["X-RateLimit-Limit"] == "3"
        assert r.headers["X-RateLimit-Remaining"] == str(2 - i)

    r = c.get("/watchlist", headers=headers)
    assert r.status_code == 429, r.text
    body = r.json()
    assert body["scope"] == "monthly"
    assert body["limit"] == 3
    assert body["remaining"] == 0
    assert body["plan"]["id"] == "free"
    assert int(r.headers["Retry-After"]) >= 1
    assert r.headers["X-RateLimit-Remaining"] == "0"

    # Upgrade lifts the cap immediately, no restart.
    upd = c.put(f"/admin/keys/{key_id}/plan",
                headers=ADMIN, json={"plan": "pro"})
    assert upd.status_code == 200, upd.text
    assert upd.json()["plan"]["id"] == "pro"

    r = c.get("/watchlist", headers=headers)
    assert r.status_code == 200, r.text
    assert r.headers["X-RateLimit-Limit"] == "50"


def test_admin_plan_endpoints_validate_input(quota_env):
    c = _client()
    key_id, _ = _mint_user_key(c, "plan-validation")

    bad = c.put(f"/admin/keys/{key_id}/plan",
                headers=ADMIN, json={"plan": "ultra-mega"})
    assert bad.status_code == 400

    missing = c.put("/admin/keys/does-not-exist/plan",
                    headers=ADMIN, json={"plan": "pro"})
    assert missing.status_code == 404

    no_field = c.put(f"/admin/keys/{key_id}/plan",
                     headers=ADMIN, json={})
    assert no_field.status_code == 400


def test_admin_usage_endpoint_lists_per_key_counters(quota_env):
    c = _client()
    key_id, secret = _mint_user_key(c, "usage-listing")
    assert c.get("/watchlist", headers={"x-api-key": secret}).status_code == 200

    r = c.get("/admin/usage", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    row = next((k for k in body["keys"] if k["key_id"] == key_id), None)
    assert row is not None, body
    assert row["used"] >= 1
    assert row["plan"]["id"] == "free"

    r = c.get(f"/admin/usage/{key_id}", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body["key_id"] == key_id
    assert body["used"] >= 1
    assert body["current_month"] in body["history"]


def test_plans_listing_exposes_catalogue(quota_env):
    c = _client()
    r = c.get("/admin/plans", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body["default_plan_id"] == "free"
    ids = {p["id"] for p in body["plans"]}
    assert {"free", "pro", "enterprise"} <= ids
