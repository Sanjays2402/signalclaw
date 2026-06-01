"""Per-tenant outbound webhook host allowlist.

Each tenant manages their own allowlist of hosts their webhooks may
fire to. The store is keyed by ``owner_key_id`` (the same identity
the rest of the webhook subsystem uses), so tenant A's policy must
not affect tenant B's subscriptions or deliveries.

These tests exercise the full path:

* tenant A enables an allowlist with one host,
* subscribe-time validation rejects a non-allowlisted URL for A but
  not for B,
* delivery-time validation refuses the actual HTTP call for A,
* tenant B (no policy) is unaffected and delivers normally,
* the per-tenant API surface (GET/PUT /webhooks/host-allowlist) is
  tenant-scoped, returns the right shape, and rejects lockout.
"""
from __future__ import annotations
import os
import tempfile
import json as _json

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_webhook_hostallow_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-default")
# Extend any pre-existing SIGNALCLAW_API_KEYS_JSON so this module can
# run in any order within a single pytest session: the FastAPI app
# binds the env-key registry at import time.
_existing_keys = []
try:
    _existing_keys = _json.loads(
        os.environ.get("SIGNALCLAW_API_KEYS_JSON", "[]"))
except Exception:
    _existing_keys = []
_existing = {k.get("key") for k in _existing_keys}
for _k in [
    {"key": "hl-admin-key", "scopes": ["read", "trade", "admin"],
     "label": "hl-admin"},
    {"key": "cb-admin-key", "scopes": ["read", "trade", "admin"],
     "label": "cb-admin"},
    {"key": "iso-admin-key", "scopes": ["read", "trade", "admin"],
     "label": "iso-admin"},
]:
    if _k["key"] not in _existing:
        _existing_keys.append(_k)
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps(_existing_keys)
# Loopback is intentionally permitted so the fake delivery target
# can be a TestServer; the per-tenant gate is host-based, not
# private-ip-based.
os.environ["SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE"] = "1"

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.webhooks import (  # noqa: E402
    WebhookStore, WebhookSubscription, PickEvent, deliver_events,
    DeliveryLogStore,
)
from signalclaw.webhooks import host_allowlist as _hl  # noqa: E402

ADMIN = {"x-api-key": "hl-admin-key"}


def _mint(label: str, role: str = "member") -> str:
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read", "trade"], "role": role,
    })
    assert r.status_code == 200, r.text
    return r.json()["secret"]


def test_subscribe_blocked_by_tenant_allowlist_for_a_but_allowed_for_b():
    c = TestClient(app)
    alice = _mint("hl-alice-sub")
    bob = _mint("hl-bob-sub")

    # Alice locks her tenant down to hooks.example.test only.
    r = c.put("/webhooks/host-allowlist", headers={"x-api-key": alice},
              json={"enabled": True, "hosts": ["hooks.example.test"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    assert body["hosts"] == ["hooks.example.test"]
    assert body["max_hosts"] >= 1

    # Subscribe with a non-allowlisted URL: rejected for Alice.
    bad = c.post("/webhooks", headers={"x-api-key": alice}, json={
        "url": "http://other.example.test/hook",
        "events": ["entered"],
    })
    assert bad.status_code == 400
    assert "not in tenant webhook allowlist" in bad.text

    # Subscribe with an allowlisted URL: accepted for Alice.
    ok = c.post("/webhooks", headers={"x-api-key": alice}, json={
        "url": "http://hooks.example.test/hook",
        "events": ["entered"],
    })
    assert ok.status_code == 200, ok.text

    # Bob has no policy and is unaffected by Alice's.
    bob_ok = c.post("/webhooks", headers={"x-api-key": bob}, json={
        "url": "http://other.example.test/hook",
        "events": ["entered"],
    })
    assert bob_ok.status_code == 200, bob_ok.text


def test_get_host_allowlist_is_tenant_scoped():
    c = TestClient(app)
    alice = _mint("hl-alice-get")
    bob = _mint("hl-bob-get")
    r = c.put("/webhooks/host-allowlist", headers={"x-api-key": alice},
              json={"enabled": True, "hosts": ["only-alice.example.test"]})
    assert r.status_code == 200

    a = c.get("/webhooks/host-allowlist",
              headers={"x-api-key": alice}).json()
    b = c.get("/webhooks/host-allowlist",
              headers={"x-api-key": bob}).json()
    assert a["enabled"] is True
    assert a["hosts"] == ["only-alice.example.test"]
    # Bob sees his own (open) policy, never Alice's hosts.
    assert b["enabled"] is False
    assert b["hosts"] == []


def test_put_host_allowlist_refuses_lockout():
    c = TestClient(app)
    alice = _mint("hl-alice-lock")
    r = c.put("/webhooks/host-allowlist", headers={"x-api-key": alice},
              json={"enabled": True, "hosts": []})
    assert r.status_code == 400
    assert "refusing" in r.text.lower() or "no hosts" in r.text.lower() \
        or "at least one host" in r.text.lower()


def test_put_host_allowlist_validates_hosts():
    c = TestClient(app)
    alice = _mint("hl-alice-valid")
    bad = c.put("/webhooks/host-allowlist", headers={"x-api-key": alice},
                json={"enabled": False, "hosts": ["https://x.example/y"]})
    assert bad.status_code == 400
    bad2 = c.put("/webhooks/host-allowlist", headers={"x-api-key": alice},
                 json={"enabled": False, "hosts": [123]})
    assert bad2.status_code == 400


def test_delivery_blocked_by_tenant_allowlist_without_affecting_other_tenant(tmp_path):
    """Direct deliver_events() exercise: two subs, two tenants, one is
    blocked by tenant policy at delivery time and the other sails through."""
    # Wire a fresh store backed by the api app's data dir so the gate
    # in deliver_events sees the same singleton.
    _hl.reset_store()
    store = _hl.get_store(tmp_path / "wh_allow.json")
    store.set("alice", enabled=True, hosts=["hooks.example.test"])

    calls = []

    def fake_http(url, body, headers, timeout=5):
        calls.append(url)
        return 200, ""

    subs = WebhookStore(tmp_path / "subs.json")
    sub_a = WebhookSubscription(
        url="http://other.example.test/hook", events=["entered"],
        tickers=[], enabled=True, owner_key_id="alice")
    sub_b = WebhookSubscription(
        url="http://other.example.test/hook", events=["entered"],
        tickers=[], enabled=True, owner_key_id="bob")
    subs.add(sub_a)
    subs.add(sub_b)
    log = DeliveryLogStore(tmp_path / "log.json")
    ev = PickEvent(kind="entered", ticker="AAPL", as_of="2026-06-01")
    results = deliver_events([ev], subs, http=fake_http, log_store=log,
                              max_attempts=1, sleep=lambda s: None)
    # Map by subscription id for assertions.
    by_id = {r["subscription_id"]: r for r in results}
    assert sub_a.id in by_id and sub_b.id in by_id
    a_res = by_id[sub_a.id]
    b_res = by_id[sub_b.id]
    assert a_res["status"] == 0
    assert "tenant_allowlist_blocked" in (a_res["error"] or "")
    assert b_res["status"] == 200
    assert b_res["error"] in (None, "")
    # Only Bob's URL was actually hit.
    assert calls == [sub_b.url]
    # Reset for any later tests.
    _hl.reset_store()
