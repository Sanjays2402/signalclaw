"""Webhook signing secret rotation with a grace window.

Covers the full enterprise-rotation contract:

* ``POST /webhooks/{id}/rotate-secret`` replaces the active secret and
  stamps ``secret_rotated_at``.
* During the grace window deliveries sign with the NEW secret as
  ``X-SignalClaw-Signature`` AND with the PRIOR secret as
  ``X-SignalClaw-Signature-Previous`` so receivers can roll their
  verifier without missing events.
* Once the grace expires the prior secret is dropped on the next
  delivery and only the new signature is emitted.
* Tenant isolation: a different API key cannot rotate someone else's
  webhook secret (returns 404, not 403, so existence is not leaked).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app  # noqa: E402
from signalclaw.webhooks import (  # noqa: E402
    PickEvent,
    WebhookStore,
    WebhookSubscription,
    deliver_events,
)

HEAD = {"x-api-key": "test-key"}


def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(
        secret.encode(), body, hashlib.sha256).hexdigest()


def test_rotate_secret_returns_metadata_and_persists():
    c = TestClient(app)
    r = c.post("/webhooks", headers=HEAD, json={
        "url": "https://example.test/hook", "secret": "initial-secret-xxxx",
    })
    assert r.status_code == 200, r.text
    sid = r.json()["id"]

    r = c.post(f"/webhooks/{sid}/rotate-secret", headers=HEAD,
               json={"secret": "rolled-secret-yyyyyy", "grace_seconds": 3600})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == sid
    assert body["secret_rotated_at"]
    assert body["previous_secret_expires_at"]
    assert body["grace_seconds"] == 3600

    listed = next(
        s for s in c.get("/webhooks", headers=HEAD).json()["subscriptions"]
        if s["id"] == sid)
    assert listed["secret"] == "rolled-secret-yyyyyy"
    assert listed["previous_secret"] == "initial-secret-xxxx"
    assert listed["previous_secret_expires_at"]
    c.delete(f"/webhooks/{sid}", headers=HEAD)


def test_rotate_generates_random_secret_when_blank():
    c = TestClient(app)
    sid = c.post("/webhooks", headers=HEAD, json={
        "url": "https://example.test/hook", "secret": "original-secret-abc",
    }).json()["id"]
    r = c.post(f"/webhooks/{sid}/rotate-secret", headers=HEAD,
               json={"secret": "", "grace_seconds": 0})
    assert r.status_code == 200
    listed = next(
        s for s in c.get("/webhooks", headers=HEAD).json()["subscriptions"]
        if s["id"] == sid)
    # No grace -> previous secret cleared immediately.
    assert listed["previous_secret"] == ""
    assert listed["previous_secret_expires_at"] is None
    # New secret is the random one and is at least 16 chars.
    assert len(listed["secret"]) >= 16
    assert listed["secret"] != "original-secret-abc"
    c.delete(f"/webhooks/{sid}", headers=HEAD)


def test_rotate_rejects_too_short_secret():
    c = TestClient(app)
    sid = c.post("/webhooks", headers=HEAD, json={
        "url": "https://example.test/hook", "secret": "ok-original-secret",
    }).json()["id"]
    r = c.post(f"/webhooks/{sid}/rotate-secret", headers=HEAD,
               json={"secret": "tooshort", "grace_seconds": 0})
    assert r.status_code == 422
    c.delete(f"/webhooks/{sid}", headers=HEAD)


def test_delivery_dual_signs_during_grace_then_drops_old(tmp_path: Path):
    """End-to-end: deliver_events emits two signatures during grace,
    then only the new one once the grace has elapsed."""
    store = WebhookStore(tmp_path / "subs.json")
    sub = WebhookSubscription(
        url="https://example.test/hook",
        secret="new-secret-aaaaaaaa",
        previous_secret="old-secret-bbbbbbbb",
        # Active grace window: ten minutes in the future.
        previous_secret_expires_at="2099-01-01T00:00:00Z",
    )
    store.add(sub)
    captured: list[dict] = []

    def fake_http(url, body, headers, timeout):
        captured.append({"url": url, "body": body, "headers": dict(headers)})
        return 200, ""

    ev = PickEvent(kind="entered", ticker="AAPL", as_of="2025-01-01",
                   prior_as_of=None)
    deliver_events([ev], store, http=fake_http,
                   sleep=lambda _s: None, max_attempts=1)
    assert captured, "no delivery captured"
    h = captured[-1]["headers"]
    body = captured[-1]["body"]
    assert h["x-signalclaw-signature"] == _sign("new-secret-aaaaaaaa", body)
    assert h["x-signalclaw-signature-previous"] == _sign(
        "old-secret-bbbbbbbb", body)

    # Now expire the grace and re-deliver: only the new signature.
    sub2 = store.get(sub.id)
    sub2.previous_secret_expires_at = "2000-01-01T00:00:00Z"
    store.update(sub2)
    captured.clear()
    deliver_events([ev], store, http=fake_http,
                   sleep=lambda _s: None, max_attempts=1)
    h2 = captured[-1]["headers"]
    assert h2["x-signalclaw-signature"] == _sign(
        "new-secret-aaaaaaaa", captured[-1]["body"])
    assert "x-signalclaw-signature-previous" not in h2
    # Prior secret is purged from the persisted record after delivery.
    refreshed = store.get(sub.id)
    assert refreshed.previous_secret == ""
    assert refreshed.previous_secret_expires_at is None


def test_rotate_secret_is_tenant_isolated(tmp_path, monkeypatch):
    """A different user-scoped API key cannot rotate someone else's
    webhook secret. The response is 404 (not 403) so existence is not
    leaked across tenants."""
    c = TestClient(app)
    with c:
        store = app.state.api_key_store
    _, a_secret = store.create(label="tenant-a", role="member",
                               scopes=["read", "write"])
    _, b_secret = store.create(label="tenant-b", role="member",
                               scopes=["read", "write"])
    try:
        r = c.post("/webhooks", headers={"x-api-key": a_secret}, json={
            "url": "https://example.test/hook",
            "secret": "tenant-a-original-key",
        })
        assert r.status_code == 200, r.text
        sid = r.json()["id"]
        # Tenant B sees a 404 listing and cannot rotate the secret.
        listed = c.get("/webhooks",
                       headers={"x-api-key": b_secret}).json()
        assert not any(s["id"] == sid for s in listed["subscriptions"])
        r = c.post(f"/webhooks/{sid}/rotate-secret",
                   headers={"x-api-key": b_secret},
                   json={"secret": "evil-rotated-secret", "grace_seconds": 0})
        assert r.status_code == 404
        # And the owner's secret is untouched.
        listed_a = c.get("/webhooks",
                         headers={"x-api-key": a_secret}).json()
        owned = next(s for s in listed_a["subscriptions"] if s["id"] == sid)
        assert owned["secret"] == "tenant-a-original-key"
        c.delete(f"/webhooks/{sid}", headers={"x-api-key": a_secret})
    finally:
        # Cleanup: revoke the test keys so other tests start clean.
        for k in list(store.list()):
            if k.label in ("tenant-a", "tenant-b"):
                store.revoke(k.id)
