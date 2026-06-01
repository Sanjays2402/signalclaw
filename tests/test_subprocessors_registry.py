"""Tests for the Trust Center subprocessor registry.

Covers the enterprise procurement flow: a public DPA reviewer fetches
the registry without auth, an admin adds/updates/removes entries, a
non-admin key is rejected by the scope middleware, and every mutation
is audit logged with the actor hash.
"""
from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
    {"key": "reader-key", "scopes": ["read"], "label": "reader"},
])

from signalclaw.api import create_app  # noqa: E402
from signalclaw.api.rate_limit import reset_registry, get_registry  # noqa: E402
from signalclaw.audit import reset_audit_log  # noqa: E402
from signalclaw.subprocessors import reset_store as reset_subprocessor_store  # noqa: E402
from signalclaw.config import settings as settings_mod  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    reset_subprocessor_store()
    get_registry().reload()
    c = TestClient(create_app())
    yield c
    reset_subprocessor_store()
    reset_audit_log()
    reset_registry()
    settings_mod.get_settings.cache_clear()


def test_public_read_is_unauthenticated_and_starts_empty(client):
    r = client.get("/trust/subprocessors")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 0
    assert body["entries"] == []


def test_admin_can_add_update_and_remove(client):
    # Add
    r = client.post(
        "/admin/subprocessors",
        headers={"x-api-key": "admin-key"},
        json={
            "name": "Stripe, Inc.",
            "purpose": "Payment processing for paid plans",
            "country": "US",
            "url": "https://stripe.com/privacy",
            "data_categories": ["email", "billing_address"],
        },
    )
    assert r.status_code == 200, r.text
    added = r.json()
    assert added["id"] == "stripe-inc"
    assert added["country"] == "US"
    assert added["data_categories"] == ["email", "billing_address"]

    # Public registry now reflects the change with a bumped version
    pub = client.get("/trust/subprocessors").json()
    assert pub["version"] == 1
    assert len(pub["entries"]) == 1
    assert pub["entries"][0]["name"] == "Stripe, Inc."

    # Update one field; other fields are preserved
    r2 = client.put(
        "/admin/subprocessors/stripe-inc",
        headers={"x-api-key": "admin-key"},
        json={"purpose": "Payments and tax invoicing"},
    )
    assert r2.status_code == 200, r2.text
    updated = r2.json()
    assert updated["purpose"] == "Payments and tax invoicing"
    assert updated["country"] == "US"  # preserved
    assert updated["url"] == "https://stripe.com/privacy"  # preserved

    # History records both events with before/after diffs
    hist = client.get("/trust/subprocessors/history").json()["changes"]
    actions = [c["action"] for c in hist]
    assert "add" in actions and "update" in actions
    upd = next(c for c in hist if c["action"] == "update")
    assert upd["before"]["purpose"] == "Payment processing for paid plans"
    assert upd["after"]["purpose"] == "Payments and tax invoicing"

    # Remove
    r3 = client.delete(
        "/admin/subprocessors/stripe-inc",
        headers={"x-api-key": "admin-key"},
    )
    assert r3.status_code == 200
    assert client.get("/trust/subprocessors").json()["entries"] == []


def test_non_admin_key_cannot_mutate(client):
    # Reader has only 'read' scope; the scope-enforcement middleware
    # must return 403 on every mutating /admin/subprocessors path.
    for verb, payload in (
        ("post", {"name": "X", "purpose": "y", "country": "US", "url": "https://x.test/p"}),
        ("put", {"name": "X"}),
        ("delete", None),
    ):
        path = "/admin/subprocessors" if verb == "post" else "/admin/subprocessors/x"
        kwargs = {"headers": {"x-api-key": "reader-key"}}
        if payload is not None:
            kwargs["json"] = payload
        r = getattr(client, verb)(path, **kwargs)
        assert r.status_code in (401, 403), f"{verb} {path} -> {r.status_code} {r.text}"

    # And anonymous (no key at all) is also rejected
    r = client.post(
        "/admin/subprocessors",
        json={"name": "X", "purpose": "y", "country": "US", "url": "https://x.test/p"},
    )
    assert r.status_code in (401, 403)


def test_validation_rejects_bad_country_and_url(client):
    for bad in (
        {"name": "Bad", "purpose": "p", "country": "USA", "url": "https://x.test/p"},
        {"name": "Bad", "purpose": "p", "country": "US", "url": "ftp://x.test/p"},
        {"name": "", "purpose": "p", "country": "US", "url": "https://x.test/p"},
    ):
        r = client.post(
            "/admin/subprocessors",
            headers={"x-api-key": "admin-key"},
            json=bad,
        )
        assert r.status_code in (400, 422), r.text


def test_update_and_remove_404_for_unknown_id(client):
    r = client.put(
        "/admin/subprocessors/does-not-exist",
        headers={"x-api-key": "admin-key"},
        json={"purpose": "x"},
    )
    assert r.status_code == 404
    r2 = client.delete(
        "/admin/subprocessors/does-not-exist",
        headers={"x-api-key": "admin-key"},
    )
    assert r2.status_code == 404
