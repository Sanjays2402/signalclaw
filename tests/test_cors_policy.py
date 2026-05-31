"""Tests for the strict CORS policy (no more allow_origins=[\"*\"]).

These are the procurement-blocker tests: prove that a fresh deploy
emits zero CORS headers, that wildcard / null origins are rejected,
that an allowed origin gets mirrored exactly, and that an unallowed
origin is silently dropped (no ACAO header at all).
"""
from __future__ import annotations

import os
import tempfile

import pytest

import json as _json
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ.setdefault("SIGNALCLAW_API_KEYS_JSON", _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
]))

from fastapi.testclient import TestClient

from signalclaw.api import create_app
from signalclaw import cors_policy
from signalclaw.cors_policy import (
    CorsPolicyStore,
    normalise_origin,
    normalise_origins,
)


@pytest.fixture(autouse=True)
def _isolate_cors_store(tmp_path, monkeypatch):
    """Each test gets its own JSON-backed policy store."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SIGNALCLAW_CORS_ORIGINS", raising=False)
    cors_policy.reset_store_for_tests()
    yield
    cors_policy.reset_store_for_tests()


def test_normalise_origin_rejects_wildcards():
    with pytest.raises(ValueError):
        normalise_origin("*")
    with pytest.raises(ValueError):
        normalise_origin("null")
    with pytest.raises(ValueError):
        normalise_origin("https://*.example.com")
    with pytest.raises(ValueError):
        normalise_origin("ftp://example.com")
    with pytest.raises(ValueError):
        normalise_origin("https://example.com/path")
    # http only on loopback
    with pytest.raises(ValueError):
        normalise_origin("http://example.com")
    assert normalise_origin("HTTPS://APP.Example.com") == "https://app.example.com"
    assert normalise_origin("http://localhost:3000") == "http://localhost:3000"


def test_default_deploy_emits_no_cors_headers():
    app = create_app()
    c = TestClient(app)
    r = c.get("/disclaimer", headers={"Origin": "https://evil.example.com"})
    assert r.status_code == 200
    # The blocker: no permissive default.
    assert "access-control-allow-origin" not in {
        k.lower() for k in r.headers
    }


def test_preflight_from_unlisted_origin_is_denied(tmp_path):
    app = create_app()
    c = TestClient(app)
    r = c.options(
        "/watchlist",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 403
    assert "access-control-allow-origin" not in {
        k.lower() for k in r.headers
    }


def test_allowed_origin_round_trip(tmp_path):
    store = cors_policy.get_store(tmp_path)
    store.set_policy(
        enabled=True,
        origins=["https://app.example.com"],
        actor="test",
    )

    app = create_app()
    c = TestClient(app)
    # Preflight
    r = c.options(
        "/watchlist",
        headers={
            "Origin": "https://app.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization, x-api-key",
        },
    )
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == "https://app.example.com"
    assert "GET" in r.headers["access-control-allow-methods"]
    assert "authorization" in r.headers["access-control-allow-headers"].lower()
    # Actual GET still mirrors origin
    r2 = c.get(
        "/disclaimer",
        headers={"Origin": "https://app.example.com"},
    )
    assert r2.status_code == 200
    assert r2.headers["access-control-allow-origin"] == "https://app.example.com"
    # Vary must include Origin so caches stay sane.
    assert "Origin" in r2.headers.get("Vary", "")


def test_cannot_enable_with_empty_allowlist(tmp_path):
    store = cors_policy.get_store(tmp_path)
    with pytest.raises(ValueError):
        store.set_policy(enabled=True, origins=[], actor="test")


def test_dangerous_request_headers_are_filtered(tmp_path):
    store = cors_policy.get_store(tmp_path)
    store.set_policy(
        enabled=True,
        origins=["https://app.example.com"],
        actor="test",
    )
    app = create_app()
    c = TestClient(app)
    r = c.options(
        "/watchlist",
        headers={
            "Origin": "https://app.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-evil-header, authorization",
        },
    )
    assert r.status_code == 204
    allowed = r.headers.get("access-control-allow-headers", "").lower()
    assert "authorization" in allowed
    assert "x-evil-header" not in allowed


def test_admin_endpoint_rejects_wildcard(tmp_path):
    from signalclaw.api.rate_limit import reset_registry
    reset_registry()
    app = create_app()
    c = TestClient(app)
    r = c.put(
        "/admin/cors-policy",
        headers={"x-api-key": "admin-test-key"},
        json={"enabled": True, "origins": ["*"]},
    )
    assert r.status_code == 400, r.text


def test_admin_endpoint_persists_policy(tmp_path):
    from signalclaw.api.rate_limit import reset_registry
    reset_registry()
    app = create_app()
    c = TestClient(app)
    r = c.put(
        "/admin/cors-policy",
        headers={"x-api-key": "admin-test-key"},
        json={
            "enabled": True,
            "origins": ["https://app.example.com"],
            "allow_credentials": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    assert body["origins"] == ["https://app.example.com"]
    assert body["allow_credentials"] is True
    # Refusing to lock out: enabling with empty origins must 400.
    r2 = c.put(
        "/admin/cors-policy",
        headers={"x-api-key": "admin-test-key"},
        json={"enabled": True, "origins": []},
    )
    assert r2.status_code == 400
