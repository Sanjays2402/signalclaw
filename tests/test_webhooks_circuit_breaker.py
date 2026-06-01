"""Circuit breaker for failing webhook subscriptions.

Enterprise procurement reviews require that an outbound webhook
endpoint that is durably broken (DNS gone, returning 500 forever) is
auto-disabled instead of being hammered indefinitely. These tests cover:

* the threshold flip: after AUTO_DISABLE_FAILURE_THRESHOLD consecutive
  failed logical deliveries, the subscription is marked disabled with
  a reason string and the operator can no longer have events fan out
  to it,
* recovery: one successful delivery resets the counter and clears the
  auto-disable fields,
* manual reactivation via POST /webhooks/{id}/reactivate, including
  the tenant-isolation property that a non-owner cannot reactivate
  someone else's webhook (gets 404, not 403, so existence is not
  leaked across tenants), and that an admin-role key can.
"""
from __future__ import annotations
import os
import tempfile
import json as _json
from pathlib import Path

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_webhook_cb_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-cb-default")
# Register both this suite's admin key and the tenant-isolation suite's
# admin key so the two test modules can run in either order in a single
# pytest session (env vars are read once at import time by the app).
_existing_keys = []
try:
    _existing_keys = _json.loads(os.environ.get("SIGNALCLAW_API_KEYS_JSON", "[]"))
except Exception:
    _existing_keys = []
_existing_labels = {k.get("key") for k in _existing_keys}
for _k in [
    {"key": "cb-admin-key", "scopes": ["read", "trade", "admin"], "label": "cb-admin"},
    {"key": "iso-admin-key", "scopes": ["read", "trade", "admin"], "label": "iso-admin"},
]:
    if _k["key"] not in _existing_labels:
        _existing_keys.append(_k)
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps(_existing_keys)

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.webhooks import (  # noqa: E402
    WebhookStore, WebhookSubscription, PickEvent, deliver_events,
    AUTO_DISABLE_FAILURE_THRESHOLD, _apply_outcome,
)

from signalclaw.api.rate_limit import get_registry as _get_registry  # noqa: E402
_admin_key = next(
    (k for k, rec in _get_registry()._keys.items()  # type: ignore[attr-defined]
     if "admin" in rec.scopes and k in ("cb-admin-key", "iso-admin-key")),
    "cb-admin-key",
)
ADMIN = {"x-api-key": _admin_key}


def _mint(label: str, role: str = "member") -> str:
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read", "trade"], "role": role,
    })
    assert r.status_code == 200, r.text
    return r.json()["secret"]


def _fresh_store(tmp_path: Path) -> WebhookStore:
    p = tmp_path / "subs.json"
    return WebhookStore(p)


def test_threshold_flips_subscription_to_auto_disabled(tmp_path):
    store = _fresh_store(tmp_path)
    sub = WebhookSubscription(url="https://dead.example.test/hook",
                              secret="s")
    store.add(sub)
    events = [PickEvent(kind="entered", ticker="AAPL", as_of="2024-01-01")]

    transitions = []

    def on_outcome(s, t, info):
        transitions.append((s.id, t, info.get("status")))

    # Always-fail HTTP. Each call is one logical delivery (the inner
    # _attempt_http retries are budgeted, so 1 logical failure per call).
    def http(url, body, headers, timeout):
        return 500, "boom"

    for _ in range(AUTO_DISABLE_FAILURE_THRESHOLD):
        deliver_events(events, store, http=http, max_attempts=1,
                       sleep=lambda _s: None, on_outcome=on_outcome)
    after = store.get(sub.id)
    assert after is not None
    assert after.enabled is False, "subscription must be auto-disabled at threshold"
    assert after.auto_disabled_at is not None
    assert after.auto_disable_reason and "boom" in after.auto_disable_reason
    assert after.consecutive_failures == AUTO_DISABLE_FAILURE_THRESHOLD
    # Exactly one auto_disabled transition emitted.
    flips = [t for t in transitions if t[1] == "auto_disabled"]
    assert len(flips) == 1, f"expected 1 auto_disabled, got {flips}"

    # Once disabled, matches() returns False so future deliveries skip it.
    results = deliver_events(events, store, http=http, max_attempts=1,
                             sleep=lambda _s: None, on_outcome=on_outcome)
    assert results == [], "disabled subscription must not be fanned out to"


def test_success_resets_counter_and_clears_auto_disable():
    sub = WebhookSubscription(url="https://x.example.test/hook")
    sub.consecutive_failures = AUTO_DISABLE_FAILURE_THRESHOLD
    sub.enabled = False
    sub.auto_disabled_at = "2024-01-01T00:00:00Z"
    sub.auto_disable_reason = "http_500"
    t = _apply_outcome(sub, status=200, err=None,
                       now_iso="2024-01-02T00:00:00Z")
    assert t == "recovered"
    assert sub.consecutive_failures == 0
    assert sub.auto_disabled_at is None
    assert sub.auto_disable_reason is None


def test_reactivate_endpoint_clears_breaker_and_isolates_tenants():
    c = TestClient(app)
    alice = _mint("cb-alice")
    bob = _mint("cb-bob")

    r = c.post("/webhooks", headers={"x-api-key": alice}, json={
        "url": "https://alice.example.test/hook",
        "events": ["entered"],
    })
    assert r.status_code == 200, r.text
    sub_id = r.json()["id"]

    # Force the subscription into auto-disabled state on disk so the
    # endpoint has something to clear.
    from signalclaw.api import app as _fast_app
    store = _fast_app.state.webhooks_store
    raw = store.get(sub_id)
    raw.enabled = False
    raw.consecutive_failures = AUTO_DISABLE_FAILURE_THRESHOLD
    raw.auto_disabled_at = "2024-01-01T00:00:00Z"
    raw.auto_disable_reason = "http_500"
    store.update(raw)

    # Bob cannot reactivate Alice's webhook. 404 (not 403) so existence
    # does not leak across tenants.
    r = c.post(f"/webhooks/{sub_id}/reactivate",
               headers={"x-api-key": bob})
    assert r.status_code == 404, r.text
    still = store.get(sub_id)
    assert still.enabled is False, "bob's call must not flip Alice's webhook"

    # Alice can reactivate her own.
    r = c.post(f"/webhooks/{sub_id}/reactivate",
               headers={"x-api-key": alice})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    assert body["auto_disabled_at"] is None
    assert body["auto_disable_reason"] is None
    assert body["consecutive_failures"] == 0

    # Re-disable and confirm admin can also reactivate.
    raw = store.get(sub_id)
    raw.enabled = False
    raw.auto_disabled_at = "2024-01-01T00:00:00Z"
    raw.auto_disable_reason = "http_500"
    raw.consecutive_failures = AUTO_DISABLE_FAILURE_THRESHOLD
    store.update(raw)

    r = c.post(f"/webhooks/{sub_id}/reactivate", headers=ADMIN)
    assert r.status_code == 200, r.text
    assert r.json()["enabled"] is True


def test_reactivate_unknown_subscription_returns_404():
    c = TestClient(app)
    r = c.post("/webhooks/does-not-exist/reactivate", headers=ADMIN)
    assert r.status_code == 404
