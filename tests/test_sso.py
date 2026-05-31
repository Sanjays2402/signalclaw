"""Tests for OIDC SSO config + login flow.

These tests stub the IdP by injecting a fake :class:`OidcClient` via
``app.state.oidc_client_factory``. The rest of the path — config
store, state ledger, callback handler, key minting, audit record — is
the real code.
"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any, Dict

from fastapi.testclient import TestClient


_TMP = tempfile.mkdtemp(prefix="sc_sso_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "sso-test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = json.dumps([
    {"key": "admin-sso-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry, set_user_key_store  # noqa: E402

reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.sso import OidcConfig, StateRecord  # noqa: E402

ADMIN = {"x-api-key": "admin-sso-key"}


class _FakeOidcClient:
    """Stub that mimics OidcClient without hitting the network."""

    def __init__(self, cfg: OidcConfig, *, token_response: Dict[str, Any], userinfo: Dict[str, Any] | None = None):
        self.config = cfg
        self._token = token_response
        self._userinfo = userinfo

    def discover(self) -> Dict[str, Any]:
        return {
            "authorization_endpoint": "https://idp.example/authorize",
            "token_endpoint": "https://idp.example/token",
            "userinfo_endpoint": "https://idp.example/userinfo" if self._userinfo else None,
        }

    def authorization_url(self, state: StateRecord) -> str:
        return f"https://idp.example/authorize?state={state.state}"

    def exchange_code(self, code: str, state: StateRecord) -> Dict[str, Any]:
        assert code == "test-code"
        return self._token

    def userinfo(self, access_token: str) -> Dict[str, Any]:
        if self._userinfo is None:
            from signalclaw.sso import OidcError
            raise OidcError("no userinfo")
        return self._userinfo


def _install_sso(domains=None, role="member", scopes=None, *, userinfo=None, token=None):
    cfg_in = {
        "enabled": True,
        "issuer": "https://idp.example",
        "client_id": "client-abc",
        "client_secret": "shh",
        "redirect_uri": "https://app.example/auth/sso/callback",
        "allowed_email_domains": domains if domains is not None else ["example.com"],
        "default_role": role,
        "default_scopes": scopes or ["read"],
    }
    c = TestClient(app)
    r = c.put("/admin/sso", headers=ADMIN, json=cfg_in)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["client_secret"] == "***redacted***"
    assert body["client_secret_set"] is True

    token = token or {
        "access_token": "at-1",
        "token_type": "Bearer",
    }
    userinfo = userinfo if userinfo is not None else {"email": "alice@example.com", "email_verified": True}

    def _factory(cfg):
        return _FakeOidcClient(cfg, token_response=token, userinfo=userinfo)

    app.state.oidc_client_factory = _factory
    return c


def test_admin_sso_get_redacts_secret():
    c = _install_sso()
    r = c.get("/admin/sso", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["client_secret"] == "***redacted***"
    assert body["client_secret_set"] is True
    assert body["allowed_email_domains"] == ["example.com"]


def test_admin_sso_requires_admin_scope():
    _install_sso()
    c = TestClient(app)
    r = c.get("/admin/sso")
    assert r.status_code in (401, 403)


def test_sso_login_redirects_to_idp():
    c = _install_sso()
    r = c.get("/auth/sso/login", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://idp.example/authorize")
    # State persisted server-side
    state = loc.split("state=")[-1]
    assert state in app.state.oidc_state._records


def test_sso_callback_mints_key_for_allowed_email():
    c = _install_sso(domains=["example.com"], role="member", scopes=["read", "trade"])
    # Issue a real state via /login so the callback can consume it.
    r = c.get("/auth/sso/login", follow_redirects=False)
    state = r.headers["location"].split("state=")[-1]

    r = c.get(f"/auth/sso/callback?code=test-code&state={state}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["email"] == "alice@example.com"
    secret = body["secret"]
    assert secret.startswith("sck_")
    assert body["role"] == "member"
    assert "read" in body["scopes"] and "trade" in body["scopes"]

    # Minted key actually authenticates against a read endpoint.
    r2 = c.get("/watchlist", headers={"x-api-key": secret})
    assert r2.status_code == 200, r2.text

    # State was single-use.
    r3 = c.get(f"/auth/sso/callback?code=test-code&state={state}")
    assert r3.status_code == 400


def test_sso_callback_rejects_off_domain_email():
    c = _install_sso(
        domains=["example.com"],
        userinfo={"email": "mallory@evil.example", "email_verified": True},
    )
    r = c.get("/auth/sso/login", follow_redirects=False)
    state = r.headers["location"].split("state=")[-1]
    r = c.get(f"/auth/sso/callback?code=test-code&state={state}")
    assert r.status_code == 403
    assert "allowlist" in r.json()["detail"]


def test_sso_callback_rejects_unknown_state():
    _install_sso()
    c = TestClient(app)
    r = c.get("/auth/sso/callback?code=test-code&state=bogus")
    assert r.status_code == 400


def test_admin_sso_put_validates_required_fields_when_enabled():
    c = TestClient(app)
    r = c.put("/admin/sso", headers=ADMIN, json={
        "enabled": True,
        "issuer": "",
        "client_id": "",
        "client_secret": "",
        "redirect_uri": "",
    })
    assert r.status_code == 400


def test_admin_sso_delete_clears_config():
    c = _install_sso()
    r = c.delete("/admin/sso", headers=ADMIN)
    assert r.status_code == 200
    r = c.get("/admin/sso", headers=ADMIN)
    assert r.json()["enabled"] is False
    # Login now 404s because SSO is no longer configured.
    r = c.get("/auth/sso/login", follow_redirects=False)
    assert r.status_code == 404
