"""Security headers middleware: end-to-end coverage.

Confirms the strict default policy ships on every kind of response
(success, 4xx, /healthz, /metrics) and that env overrides + the
disable flag take effect. Also exercises the public
/.well-known/security.txt and the admin /admin/security-headers
reflector so an enterprise scanner has a stable surface.
"""
from __future__ import annotations

import json as _json
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# Isolate state per test session (same pattern as test_ip_allowlist).
_TMP = tempfile.mkdtemp(prefix="sc_sec_headers_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "admin-test-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api.security_headers import build_header_policy  # noqa: E402
from signalclaw.api import app as _api_app  # noqa: E402

ADMIN = {"x-api-key": "admin-test-key"}

REQUIRED_HEADERS = [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
]


@pytest.fixture()
def client():
    return TestClient(_api_app)


def _assert_baseline(headers):
    for name in REQUIRED_HEADERS:
        assert name in headers, f"missing header {name}: have {dict(headers)}"
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "DENY"
    assert headers["Referrer-Policy"] == "no-referrer"
    assert "max-age=" in headers["Strict-Transport-Security"]
    assert "default-src 'none'" in headers["Content-Security-Policy"]


def test_security_headers_on_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    _assert_baseline(r.headers)


def test_security_headers_on_metrics(client):
    r = client.get("/metrics")
    assert r.status_code == 200
    _assert_baseline(r.headers)


def test_security_headers_on_404(client):
    r = client.get("/no-such-route")
    assert r.status_code == 404
    _assert_baseline(r.headers)


def test_security_headers_on_auth_failure(client):
    # Anonymous hit on an admin route returns 401/403; headers must
    # still be present so a denied request is still hardened.
    r = client.get("/admin/security-headers")
    assert r.status_code in (401, 403)
    _assert_baseline(r.headers)


def test_security_headers_admin_endpoint(client):
    r = client.get("/admin/security-headers", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    for name in REQUIRED_HEADERS:
        assert name in body["headers"]


def test_security_txt_public(client):
    r = client.get("/.well-known/security.txt")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    body = r.text
    assert "Contact:" in body
    assert "Expires:" in body
    assert "Policy:" in body


def test_hsts_preload_and_subdomains_env(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_HSTS_MAX_AGE", "63072000")
    monkeypatch.setenv("SIGNALCLAW_HSTS_PRELOAD", "1")
    monkeypatch.setenv("SIGNALCLAW_HSTS_INCLUDE_SUBDOMAINS", "1")
    policy = build_header_policy()
    hsts = policy["Strict-Transport-Security"]
    assert "max-age=63072000" in hsts
    assert "includeSubDomains" in hsts
    assert "preload" in hsts


def test_hsts_disabled_when_age_zero(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_HSTS_MAX_AGE", "0")
    policy = build_header_policy()
    assert "Strict-Transport-Security" not in policy


def test_csp_override(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_CSP", "default-src 'self'")
    policy = build_header_policy()
    assert policy["Content-Security-Policy"] == "default-src 'self'"


def test_middleware_preserves_explicit_handler_header():
    # Pure-unit test: contract is setdefault, so a downstream value
    # is preserved if a future endpoint chooses a looser CSP.
    from starlette.applications import Starlette
    from starlette.responses import Response
    from starlette.routing import Route
    from signalclaw.api.security_headers import SecurityHeadersMiddleware

    async def custom(_req):
        return Response("x", headers={"Content-Security-Policy": "default-src 'self'"})

    app = Starlette(routes=[Route("/x", custom)])
    app.add_middleware(SecurityHeadersMiddleware)
    r = TestClient(app).get("/x")
    assert r.headers["Content-Security-Policy"] == "default-src 'self'"
    assert r.headers["X-Frame-Options"] == "DENY"
