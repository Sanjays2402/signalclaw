"""End-to-end tests for the per-key monthly quota subsystem.

Covers:
* ``X-RateLimit-*`` headers on a normal authenticated request.
* Enforcement of the monthly ceiling (429 + Retry-After + structured body).
* Admin plan reassignment (``PUT /admin/keys/{id}/plan``) immediately
  changes the cap that the middleware enforces on the next call.
* Anonymous requests are not billed and receive no ``X-RateLimit-*``
  headers (they fall through to the existing auth gate).

These tests share the process-wide app instance with the rest of the
suite, so we do NOT mutate ``DATA_DIR`` or rebuild the app. Quota
state is isolated by using a dedicated user-managed key (newly minted
inside each test) which starts on the default ``free`` plan with a
fresh zero counter.
"""
from __future__ import annotations
import hashlib
import json as _json

# Reuse the same admin key the other key-admin tests rely on so the
# shared app instance authenticates us as admin without needing a
# rebuild. We do not override DATA_DIR (conftest owns that) and we do
# not override SIGNALCLAW_PLANS_JSON globally; instead we monkey-patch
# the live QuotaStore with a tiny test catalogue inside this module
# and restore the original catalogue on teardown so the rest of the
# suite keeps the generous default ceilings.
import os
_PRIOR_KEYS_JSON = os.environ.get("SIGNALCLAW_API_KEYS_JSON")
_PRIOR_API_KEY = os.environ.get("SIGNALCLAW_API_KEY")
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key-quotas")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "quota-admin", "scopes": ["read", "trade", "admin"], "label": "qa"},
])

from fastapi.testclient import TestClient  # noqa: E402

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.quotas import (  # noqa: E402
    get_quota_store, Plan, DEFAULT_PLAN_ID,
)

ADMIN = {"x-api-key": "quota-admin"}

# Tiny test catalogue: free=3 so we can saturate fast.
_TEST_PLANS = (
    Plan(id="free", label="Free", monthly_limit=3, rate_per_minute=60),
    Plan(id="pro", label="Pro", monthly_limit=50, rate_per_minute=300),
    Plan(id="enterprise", label="Enterprise",
         monthly_limit=0, rate_per_minute=1200),
)

_qs = get_quota_store()
_orig_plans = _qs._plans  # type: ignore[attr-defined]
_orig_default = _qs._default_plan_id  # type: ignore[attr-defined]
_qs._plans = {p.id: p for p in _TEST_PLANS}  # type: ignore[attr-defined]
_qs._default_plan_id = DEFAULT_PLAN_ID  # type: ignore[attr-defined]

# Park admin on enterprise so admin probes do not eat their own quota.
_admin_id = f"env:{hashlib.sha256(b'quota-admin').hexdigest()[:8]}"
_qs.set_plan(_admin_id, "enterprise")


def teardown_module(module):  # noqa: D401
    """Restore the production plan catalogue + env keys for the rest of the suite."""
    _qs._plans = _orig_plans  # type: ignore[attr-defined]
    _qs._default_plan_id = _orig_default  # type: ignore[attr-defined]
    if _PRIOR_KEYS_JSON is None:
        os.environ.pop("SIGNALCLAW_API_KEYS_JSON", None)
    else:
        os.environ["SIGNALCLAW_API_KEYS_JSON"] = _PRIOR_KEYS_JSON
    if _PRIOR_API_KEY is None:
        os.environ.pop("SIGNALCLAW_API_KEY", None)
    else:
        os.environ["SIGNALCLAW_API_KEY"] = _PRIOR_API_KEY
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


def test_response_has_standard_rate_limit_headers():
    c = _client()
    # /disclaimer is exempt; the middleware bypasses it entirely.
    r = c.get("/disclaimer", headers=ADMIN)
    assert r.status_code == 200
    assert "X-RateLimit-Limit" not in r.headers

    # Real authenticated route on the unlimited admin plan: GitHub-style
    # "limit=0, remaining=unlimited" envelope.
    r = c.get("/watchlist", headers=ADMIN)
    assert r.status_code == 200
    assert r.headers.get("X-RateLimit-Scope") == "monthly"
    assert r.headers["X-RateLimit-Limit"] == "0"
    assert r.headers["X-RateLimit-Remaining"] == "unlimited"
    assert "X-RateLimit-Reset" in r.headers


def test_anonymous_requests_are_not_billed():
    c = _client()
    r = c.get("/watchlist")  # no auth
    assert r.status_code in (401, 403)
    assert "X-RateLimit-Limit" not in r.headers


def test_monthly_ceiling_returns_429_with_retry_after_and_lifts_on_upgrade():
    c = _client()
    key_id, secret = _mint_user_key(c, "quota-test-key")
    headers = {"x-api-key": secret}

    # Free plan allows 3 calls. Saturate it and confirm the structured
    # 429 envelope on the fourth call.
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

    # Upgrade to pro and confirm the cap lifts on the very next call,
    # without restarting the process. This proves the store + middleware
    # are correctly threaded.
    upd = c.put(f"/admin/keys/{key_id}/plan",
                headers=ADMIN, json={"plan": "pro"})
    assert upd.status_code == 200, upd.text
    assert upd.json()["plan"]["id"] == "pro"

    r = c.get("/watchlist", headers=headers)
    assert r.status_code == 200, r.text
    assert r.headers["X-RateLimit-Limit"] == "50"


def test_admin_plan_endpoints_validate_input():
    c = _client()
    key_id, _ = _mint_user_key(c, "plan-validation")

    bad = c.put(f"/admin/keys/{key_id}/plan",
                headers=ADMIN, json={"plan": "ultra-mega"})
    assert bad.status_code == 400, bad.text

    missing = c.put("/admin/keys/does-not-exist/plan",
                    headers=ADMIN, json={"plan": "pro"})
    assert missing.status_code == 404, missing.text

    no_field = c.put(f"/admin/keys/{key_id}/plan",
                     headers=ADMIN, json={})
    assert no_field.status_code == 400, no_field.text


def test_admin_usage_endpoint_lists_per_key_counters():
    c = _client()
    key_id, secret = _mint_user_key(c, "usage-listing")
    # One call to seed a counter for this key.
    assert c.get("/watchlist", headers={"x-api-key": secret}).status_code == 200

    r = c.get("/admin/usage", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "month" in body and "keys" in body
    row = next((k for k in body["keys"] if k["key_id"] == key_id), None)
    assert row is not None, body
    assert row["used"] >= 1
    assert row["plan"]["id"] == "free"

    # Per-key endpoint surfaces the same info plus history dict.
    r = c.get(f"/admin/usage/{key_id}", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body["key_id"] == key_id
    assert body["used"] >= 1
    assert body["current_month"] in body["history"]


def test_plans_listing_exposes_catalogue():
    c = _client()
    r = c.get("/admin/plans", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body["default_plan_id"] == "free"
    ids = {p["id"] for p in body["plans"]}
    assert {"free", "pro", "enterprise"} <= ids
