"""PATCH /webhooks/{id} in-place update endpoint.

Procurement review wants operators to be able to fix a typoed
webhook URL, narrow the event filter, or pause a noisy subscription
without losing the delivery log + secret rotation history that a
delete + recreate would discard. These tests cover:

* a tenant can patch their own subscription's url, events, tickers,
  and enabled flag, and the change persists,
* tenant isolation: a sibling tenant gets 404 (not 403) so existence
  is not leaked, and an admin-role key can patch any subscription,
* SSRF / scheme validation: an attempt to pivot an existing
  subscription onto a destination the policy rejects (here, a
  non-https scheme) is rejected with 400 and the row is left
  untouched,
* re-enable clears the circuit breaker auto-disable markers so the
  next fan-out actually attempts delivery,
* unknown event kinds are rejected with 400 and an empty events list
  is rejected with 422.
"""
from __future__ import annotations
import os
import tempfile
import json as _json

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_webhook_update_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-up-default")
_existing_keys = []
try:
    _existing_keys = _json.loads(os.environ.get("SIGNALCLAW_API_KEYS_JSON", "[]"))
except Exception:
    _existing_keys = []
_existing_labels = {k.get("key") for k in _existing_keys}
for _k in [
    {"key": "up-admin-key", "scopes": ["read", "trade", "admin"], "label": "up-admin"},
]:
    if _k["key"] not in _existing_labels:
        _existing_keys.append(_k)
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps(_existing_keys)

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api.rate_limit import get_registry as _get_registry  # noqa: E402

_admin_key = next(
    (k for k, rec in _get_registry()._keys.items()  # type: ignore[attr-defined]
     if "admin" in rec.scopes and k == "up-admin-key"),
    "up-admin-key",
)
ADMIN = {"x-api-key": _admin_key}


def _mint(label: str) -> str:
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read", "trade"], "role": "member",
    })
    assert r.status_code == 200, r.text
    return r.json()["secret"]


def _add(c: TestClient, key: str, url: str = "https://up.example.test/hook") -> str:
    r = c.post("/webhooks", headers={"x-api-key": key}, json={
        "url": url,
        "events": ["entered", "exited"],
        "tickers": ["AAPL"],
    })
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_owner_can_patch_url_events_tickers_and_enabled():
    c = TestClient(app)
    alice = _mint("up-alice-1")
    sub_id = _add(c, alice)

    r = c.patch(f"/webhooks/{sub_id}", headers={"x-api-key": alice}, json={
        "url": "https://up2.example.test/hook2",
        "events": ["entered"],
        "tickers": ["MSFT", "googl"],
        "enabled": False,
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["url"] == "https://up2.example.test/hook2"
    assert out["events"] == ["entered"]
    assert sorted(out["tickers"]) == ["GOOGL", "MSFT"]
    assert out["enabled"] is False

    # Re-fetch via list to prove persistence (not just echo).
    listed = c.get("/webhooks", headers={"x-api-key": alice}).json()
    row = next(s for s in listed["subscriptions"] if s["id"] == sub_id)
    assert row["url"] == "https://up2.example.test/hook2"
    assert row["enabled"] is False


def test_cross_tenant_patch_returns_404_not_403_and_admin_can_patch():
    c = TestClient(app)
    alice = _mint("up-alice-2")
    bob = _mint("up-bob-2")
    sub_id = _add(c, alice, url="https://alice.example.test/hook")

    # Bob is a sibling tenant: must see 404, not 403, so Alice's
    # subscription existence does not leak across the boundary.
    r = c.patch(f"/webhooks/{sub_id}", headers={"x-api-key": bob}, json={
        "enabled": False,
    })
    assert r.status_code == 404, r.text

    # Alice's row is untouched by Bob's attempt.
    listed = c.get("/webhooks", headers={"x-api-key": alice}).json()
    row = next(s for s in listed["subscriptions"] if s["id"] == sub_id)
    assert row["enabled"] is True

    # Admin-scope key can patch any tenant's subscription.
    r = c.patch(f"/webhooks/{sub_id}", headers=ADMIN, json={
        "enabled": False,
    })
    assert r.status_code == 200, r.text
    assert r.json()["enabled"] is False


def test_patch_rejects_ssrf_url_and_leaves_row_untouched():
    c = TestClient(app)
    alice = _mint("up-alice-3")
    sub_id = _add(c, alice, url="https://safe.example.test/hook")

    r = c.patch(f"/webhooks/{sub_id}", headers={"x-api-key": alice}, json={
        "url": "ftp://safe.example.test/hook",
    })
    assert r.status_code == 400, r.text

    listed = c.get("/webhooks", headers={"x-api-key": alice}).json()
    row = next(s for s in listed["subscriptions"] if s["id"] == sub_id)
    assert row["url"] == "https://safe.example.test/hook", \
        "SSRF-blocked patch must not mutate the subscription"


def test_reenable_clears_circuit_breaker_auto_disable():
    c = TestClient(app)
    alice = _mint("up-alice-4")
    sub_id = _add(c, alice)

    # Force the subscription into auto-disabled state via the
    # store layer, then re-enable through the PATCH route.
    store = app.state.webhooks_store
    sub = store.get(sub_id)
    assert sub is not None
    sub.enabled = False
    sub.auto_disabled_at = "2024-01-01T00:00:00Z"
    sub.auto_disable_reason = "http_500"
    sub.consecutive_failures = 9
    store.update(sub)

    r = c.patch(f"/webhooks/{sub_id}", headers={"x-api-key": alice}, json={
        "enabled": True,
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["enabled"] is True
    assert out["auto_disabled_at"] is None
    assert out["auto_disable_reason"] is None
    assert out["consecutive_failures"] == 0


def test_patch_rejects_unknown_events_and_empty_events():
    c = TestClient(app)
    alice = _mint("up-alice-5")
    sub_id = _add(c, alice)

    r = c.patch(f"/webhooks/{sub_id}", headers={"x-api-key": alice}, json={
        "events": ["entered", "not_a_real_event"],
    })
    assert r.status_code == 400, r.text

    r = c.patch(f"/webhooks/{sub_id}", headers={"x-api-key": alice}, json={
        "events": [],
    })
    assert r.status_code == 422, r.text
