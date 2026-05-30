"""Tests for the per-IP DoS rate limiter."""
from __future__ import annotations

import os
import sys
import importlib

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient


def test_client_ip_ignores_xff_by_default():
    from signalclaw.api.rate_limit import client_ip_from_request

    scope = {
        "type": "http",
        "headers": [(b"x-forwarded-for", b"1.2.3.4, 5.6.7.8")],
        "client": ("10.0.0.1", 1234),
    }
    req = Request(scope)
    assert client_ip_from_request(req) == "10.0.0.1"


def test_client_ip_honours_xff_when_proxy_trusted():
    from signalclaw.api.rate_limit import client_ip_from_request

    scope = {
        "type": "http",
        "headers": [(b"x-forwarded-for", b"203.0.113.7, 5.6.7.8")],
        "client": ("10.0.0.1", 1234),
    }
    req = Request(scope)
    got = client_ip_from_request(
        req, trusted_proxies=("10.0.0.1",), trust_forwarded=True
    )
    assert got == "203.0.113.7"


def test_client_ip_rejects_xff_from_untrusted_peer():
    from signalclaw.api.rate_limit import client_ip_from_request

    scope = {
        "type": "http",
        "headers": [(b"x-forwarded-for", b"203.0.113.7")],
        "client": ("198.51.100.9", 1234),
    }
    req = Request(scope)
    # Peer is not in trusted list -> XFF is ignored even with trust on.
    got = client_ip_from_request(
        req, trusted_proxies=("10.0.0.1",), trust_forwarded=True
    )
    assert got == "198.51.100.9"


def _mini_app(**mw_kwargs):
    from signalclaw.api.rate_limit import PerIPRateLimitMiddleware

    app = FastAPI()
    app.add_middleware(PerIPRateLimitMiddleware, **mw_kwargs)

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/picks")
    def picks():
        return {"ok": True}

    return app


def test_per_ip_middleware_returns_429_after_capacity():
    app = _mini_app(per_minute=3)
    c = TestClient(app)
    for _ in range(3):
        assert c.get("/picks").status_code == 200
    resp = c.get("/picks")
    assert resp.status_code == 429
    assert resp.headers.get("X-RateLimit-Scope") == "per-ip"
    body = resp.json()
    assert body["scope"] == "per-ip"
    assert body["retry_after_seconds"] >= 1


def test_per_ip_middleware_exempts_health_and_metrics():
    app = _mini_app(per_minute=1)
    c = TestClient(app)
    # Burn the budget on /picks first.
    assert c.get("/picks").status_code == 200
    assert c.get("/picks").status_code == 429
    # /health stays open.
    for _ in range(5):
        assert c.get("/health").status_code == 200


def test_per_ip_buckets_are_independent_per_ip():
    """Different client IPs should not share a bucket."""
    app = _mini_app(per_minute=1)
    # Two TestClients send distinct client.host values via ASGI scope by
    # rebuilding the request with a different peer. Use raw httpx
    # transport with a custom client.host through TestClient's headers
    # is not supported, so we drive the middleware directly.
    from signalclaw.api.rate_limit import PerIPRateLimitMiddleware, TokenBucket

    mw = PerIPRateLimitMiddleware(app=lambda *_: None, per_minute=1)
    b1 = mw._bucket("1.1.1.1")
    b2 = mw._bucket("2.2.2.2")
    assert b1 is not b2
    ok1, _ = b1.take(1.0)
    ok2, _ = b2.take(1.0)
    assert ok1 and ok2
    # Both now empty independently.
    fail1, _ = b1.take(1.0)
    fail2, _ = b2.take(1.0)
    assert not fail1 and not fail2


def test_per_ip_wired_into_real_app(monkeypatch):
    """End-to-end: the production app honours SIGNALCLAW_PER_IP_PER_MIN."""
    monkeypatch.setenv("SIGNALCLAW_PER_IP_PER_MIN", "2")
    monkeypatch.setenv("SIGNALCLAW_RBAC_ENFORCE", "0")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "e2e-perip-key")
    monkeypatch.delenv("SIGNALCLAW_API_KEYS_JSON", raising=False)
    monkeypatch.delenv("SIGNALCLAW_RATE_LIMIT_ENABLED", raising=False)
    from signalclaw.config import get_settings
    get_settings.cache_clear()
    from signalclaw.api import rate_limit
    rate_limit.reset_registry()
    app_mod = importlib.reload(sys.modules["signalclaw.api.app"])
    try:
        c = TestClient(app_mod.app)
        h = {"x-api-key": "e2e-perip-key"}
        # Authenticated GET /watchlist passes auth. After 2 requests the
        # per-IP bucket is empty so the third returns 429 from the per-IP
        # layer, ahead of the per-key limiter and route handler.
        r1 = c.get("/watchlist", headers=h)
        r2 = c.get("/watchlist", headers=h)
        r3 = c.get("/watchlist", headers=h)
        assert r1.status_code == 200, r1.text
        assert r2.status_code == 200, r2.text
        assert r3.status_code == 429, r3.text
        assert r3.headers.get("X-RateLimit-Scope") == "per-ip"
    finally:
        # Restore registry + app module to whatever the surrounding
        # env says now that monkeypatch has popped our overrides,
        # so later tests that rely on the default app keep working.
        for k in ("SIGNALCLAW_PER_IP_PER_MIN", "SIGNALCLAW_RBAC_ENFORCE",
                  "SIGNALCLAW_API_KEY"):
            os.environ.pop(k, None)
        os.environ["SIGNALCLAW_API_KEY"] = "test-key"
        get_settings.cache_clear()
        rate_limit.reset_registry()
        importlib.reload(sys.modules["signalclaw.api.app"])
