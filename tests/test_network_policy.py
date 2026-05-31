"""Tests for the workspace-level (global) IP allowlist."""
import json
import os
import tempfile

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ.setdefault("SIGNALCLAW_MFA_REQUIRED_FOR_ADMIN", "0")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = json.dumps([
    {"key": "netpol-admin-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

import pytest
from fastapi.testclient import TestClient

from signalclaw.api import create_app
from signalclaw.api.rate_limit import reset_registry
from signalclaw import network_policy
from signalclaw.config import get_settings
from signalclaw.network_policy import (
    NetworkPolicyStore,
    normalise_cidr,
    MAX_CIDRS,
)

ADMIN = {"x-api-key": "netpol-admin-key"}


def _fresh_app(tmp_path_factory):
    d = tmp_path_factory.mktemp("sc_netpolicy")
    os.environ["DATA_DIR"] = str(d)
    get_settings.cache_clear()
    network_policy.reset_store()
    reset_registry()
    return create_app()


def test_normalise_cidr_accepts_bare_ip():
    assert normalise_cidr("10.0.0.5") == "10.0.0.5/32"
    assert normalise_cidr("::1") == "::1/128"
    assert normalise_cidr("10.0.0.0/8") == "10.0.0.0/8"


def test_normalise_cidr_rejects_garbage():
    with pytest.raises(ValueError):
        normalise_cidr("not-an-ip")
    with pytest.raises(ValueError):
        normalise_cidr("")


def test_store_refuses_enable_with_empty_cidrs(tmp_path):
    s = NetworkPolicyStore(tmp_path / "np.json")
    with pytest.raises(ValueError):
        s.set(enabled=True, cidrs=[])


def test_store_caps_cidr_count(tmp_path):
    s = NetworkPolicyStore(tmp_path / "np.json")
    too_many = [f"10.0.{i // 256}.{i % 256}/32" for i in range(MAX_CIDRS + 1)]
    with pytest.raises(ValueError):
        s.set(enabled=True, cidrs=too_many)


def test_disabled_policy_lets_everyone_through(tmp_path_factory):
    app = _fresh_app(tmp_path_factory)
    c = TestClient(app)
    r = c.get("/watchlist", headers={
        "x-api-key": "test-key",
        "x-forwarded-for": "203.0.113.7",
    })
    assert r.status_code == 200


def test_enabled_policy_blocks_unlisted_ip(tmp_path_factory, monkeypatch):
    # Trust XFF so the test can spoof a non-loopback client IP.
    monkeypatch.setenv("SIGNALCLAW_TRUST_FORWARDED", "1")
    app = _fresh_app(tmp_path_factory)
    store = app.state.network_policy_store
    store.set(enabled=True, cidrs=["10.0.0.0/8"], actor="test")
    c = TestClient(app)

    # Off-network IP must be rejected with 403 before auth even matters.
    r = c.get("/watchlist", headers={
        "x-api-key": "test-key",
        "x-forwarded-for": "203.0.113.99",
    })
    assert r.status_code == 403
    body = r.json()
    assert body["scope"] == "workspace"
    assert body["client_ip"] == "203.0.113.99"

    # On-network IP passes through to the normal handler.
    r = c.get("/watchlist", headers={
        "x-api-key": "test-key",
        "x-forwarded-for": "10.1.2.3",
    })
    assert r.status_code == 200


def test_health_and_metrics_exempt_from_policy(tmp_path_factory, monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_TRUST_FORWARDED", "1")
    app = _fresh_app(tmp_path_factory)
    app.state.network_policy_store.set(
        enabled=True, cidrs=["10.0.0.0/8"], actor="test")
    c = TestClient(app)
    # Health and metrics must remain reachable from anywhere so
    # external monitors keep working even with a strict policy.
    for path in ("/health", "/metrics"):
        r = c.get(path, headers={"x-forwarded-for": "203.0.113.99"})
        assert r.status_code in (200, 404), f"{path} -> {r.status_code}"


def test_admin_endpoint_updates_policy(tmp_path_factory):
    app = _fresh_app(tmp_path_factory)
    c = TestClient(app)
    r = c.get("/admin/network-policy", headers=ADMIN)
    assert r.status_code == 200, (r.status_code, r.text)
    assert r.json()["enabled"] is False

    # Refuse enable + empty.
    r = c.put("/admin/network-policy",
              headers=ADMIN,
              json={"enabled": True, "cidrs": []})
    assert r.status_code == 400

    # Refuse bad CIDR.
    r = c.put("/admin/network-policy",
              headers=ADMIN,
              json={"enabled": False, "cidrs": ["not-a-cidr"]})
    assert r.status_code == 400

    # Accept a valid update (kept last so we do not lock the test
    # client out of subsequent calls).
    r = c.put("/admin/network-policy",
              headers=ADMIN,
              json={"enabled": False, "cidrs": ["10.0.0.0/8", "192.168.1.5"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is False
    assert "192.168.1.5/32" in body["cidrs"]
