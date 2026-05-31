"""Per-API-key tenant isolation for webhook subscriptions.

Before this change a webhook created by one user-managed API key was
visible (and deletable, and replayable) by every other key that hit
the same deployment. Enterprise procurement reviews reject that
pattern: webhooks frequently carry secrets and trigger downstream
side effects, so cross-tenant leakage at the subscription layer is a
security finding.

The tests below stand up two member keys against the real FastAPI
app, prove that:

* a webhook created by key A is invisible in ``GET /webhooks`` for
  key B,
* key B cannot delete key A's webhook (gets a 404, not a 403, so
  existence does not leak),
* key B cannot replay a delivery attempt belonging to key A's
  subscription,
* an admin-role key can see and act on both, matching the operator
  expectation that the admin console is the single inspection
  surface.
"""
from __future__ import annotations
import os
import tempfile
import json as _json

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_webhook_iso_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-iso-default")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "iso-admin-key", "scopes": ["read", "trade", "admin"],
     "label": "iso-admin"},
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.webhooks import DeliveryAttempt  # noqa: E402

ADMIN = {"x-api-key": "iso-admin-key"}


def _mint(label: str, role: str = "member"):
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read", "trade"], "role": role,
    })
    assert r.status_code == 200, r.text
    return r.json()["secret"]


def test_webhook_is_invisible_to_other_user_keys():
    c = TestClient(app)
    alice = _mint("alice")
    bob = _mint("bob")

    # Alice creates a webhook.
    r = c.post("/webhooks", headers={"x-api-key": alice}, json={
        "url": "https://alice.example.test/hook",
        "events": ["entered"],
    })
    assert r.status_code == 200, r.text
    alice_sub = r.json()
    assert alice_sub["owner_key_id"], "owner_key_id must be populated"

    # Alice sees it.
    r = c.get("/webhooks", headers={"x-api-key": alice})
    ids = {s["id"] for s in r.json()["subscriptions"]}
    assert alice_sub["id"] in ids

    # Bob does NOT see it.
    r = c.get("/webhooks", headers={"x-api-key": bob})
    ids = {s["id"] for s in r.json()["subscriptions"]}
    assert alice_sub["id"] not in ids

    # Admin sees it.
    r = c.get("/webhooks", headers=ADMIN)
    ids = {s["id"] for s in r.json()["subscriptions"]}
    assert alice_sub["id"] in ids


def test_other_key_cannot_delete_or_enumerate_via_id():
    c = TestClient(app)
    alice = _mint("alice2")
    bob = _mint("bob2")
    r = c.post("/webhooks", headers={"x-api-key": alice}, json={
        "url": "https://alice2.example.test/hook"})
    sid = r.json()["id"]

    # Bob's delete returns 404 (NOT 403): existence must not leak.
    r = c.delete(f"/webhooks/{sid}", headers={"x-api-key": bob})
    assert r.status_code == 404

    # Alice's row still exists.
    r = c.get("/webhooks", headers={"x-api-key": alice})
    assert any(s["id"] == sid for s in r.json()["subscriptions"])

    # Admin can delete it.
    r = c.delete(f"/webhooks/{sid}", headers=ADMIN)
    assert r.status_code == 200


def test_replay_blocked_across_tenants():
    """A delivery attempt belonging to Alice cannot be replayed by Bob."""
    c = TestClient(app)
    alice = _mint("alice3")
    bob = _mint("bob3")
    r = c.post("/webhooks", headers={"x-api-key": alice}, json={
        "url": "https://alice3.example.test/hook"})
    alice_sid = r.json()["id"]

    # Synthesize a delivery attempt directly in the log store, since
    # we don't want this test to depend on outbound HTTP.
    log_store = app.state.webhook_log_store
    attempt = DeliveryAttempt(
        id="atmp-cross-1",
        subscription_id=alice_sid,
        url="https://alice3.example.test/hook",
        status=200,
        error=None,
        attempt=1,
        delivered_at="2026-01-01T00:00:00Z",
        signature="sha256=deadbeef",
        event_count=1,
        events=[{"kind": "entered", "ticker": "AAPL"}],
        payload_b64="e30=",   # "{}"
    )
    log_store.append(attempt)

    # Bob: cannot list this delivery.
    r = c.get(f"/webhooks/deliveries?subscription_id={alice_sid}",
              headers={"x-api-key": bob})
    assert r.status_code == 200
    assert r.json()["deliveries"] == []

    # Bob: cannot replay this attempt. 404, not 403.
    r = c.post(f"/webhooks/deliveries/{attempt.id}/replay",
               headers={"x-api-key": bob})
    assert r.status_code == 404

    # Alice can at least see her own delivery row.
    r = c.get(f"/webhooks/deliveries?subscription_id={alice_sid}",
              headers={"x-api-key": alice})
    assert r.status_code == 200
    seen_ids = {d["id"] for d in r.json()["deliveries"]}
    assert attempt.id in seen_ids
