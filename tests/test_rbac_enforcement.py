"""Global RBAC scope enforcement middleware.

Verifies that a read-only API key cannot mutate state via routes that
were previously only guarded by ``require_api_key`` (which accepts any
known key regardless of scope), and that a trade-scoped key still can.
"""
from __future__ import annotations
import json
import os
import importlib
import sys


def _fresh_app(env: dict):
    for k, v in env.items():
        os.environ[k] = v
    from signalclaw.config import get_settings as _gs
    _gs.cache_clear()
    from signalclaw.api import rate_limit
    rate_limit.reset_registry()
    app_mod = sys.modules.get("signalclaw.api.app")
    if app_mod is None:
        import signalclaw.api.app as app_mod  # noqa: F401
        app_mod = sys.modules["signalclaw.api.app"]
    importlib.reload(app_mod)
    return app_mod.app


def test_read_only_key_blocked_on_mutating_route(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", json.dumps([
        {"key": "ro", "scopes": ["read"]},
        {"key": "rw", "scopes": ["read", "trade"]},
    ]))
    monkeypatch.delenv("SIGNALCLAW_API_KEY", raising=False)
    monkeypatch.setenv("SIGNALCLAW_RBAC_ENFORCE", "1")
    monkeypatch.setenv("SIGNALCLAW_RATE_LIMIT_ENABLED", "0")
    app = _fresh_app({})
    from fastapi.testclient import TestClient
    c = TestClient(app)

    # Read with the read-only key works.
    r = c.get("/watchlist", headers={"x-api-key": "ro"})
    assert r.status_code == 200, r.text

    # Mutating with the read-only key is rejected by the middleware.
    r = c.post("/watchlist", headers={"x-api-key": "ro"},
               json={"ticker": "AAPL"})
    assert r.status_code == 403
    body = r.json()
    assert body["required_scope"] == "trade"
    assert body["method"] == "POST"

    # The trade-scoped key can mutate.
    r = c.post("/watchlist", headers={"x-api-key": "rw"},
               json={"ticker": "AAPL"})
    assert r.status_code == 200, r.text


def test_admin_route_requires_admin_scope(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", json.dumps([
        {"key": "rw", "scopes": ["read", "trade"]},
        {"key": "boss", "scopes": ["read", "trade", "admin"]},
    ]))
    monkeypatch.delenv("SIGNALCLAW_API_KEY", raising=False)
    monkeypatch.setenv("SIGNALCLAW_RBAC_ENFORCE", "1")
    app = _fresh_app({})
    from fastapi.testclient import TestClient
    c = TestClient(app)

    # /audit is protected by a per-route admin dependency. The trade
    # key gets 403 from that dependency.
    r = c.get("/audit", headers={"x-api-key": "rw"})
    assert r.status_code == 403

    r = c.get("/audit", headers={"x-api-key": "boss"})
    assert r.status_code == 200


def test_exempt_paths_bypass_scope_check(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_RBAC_ENFORCE", "1")
    app = _fresh_app({})
    from fastapi.testclient import TestClient
    c = TestClient(app)
    assert c.get("/health").status_code == 200
    assert c.get("/disclaimer").status_code == 200


def test_rbac_can_be_disabled(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", json.dumps([
        {"key": "ro", "scopes": ["read"]},
    ]))
    monkeypatch.delenv("SIGNALCLAW_API_KEY", raising=False)
    monkeypatch.setenv("SIGNALCLAW_RBAC_ENFORCE", "0")
    app = _fresh_app({})
    from fastapi.testclient import TestClient
    c = TestClient(app)
    # With enforcement off, the read-only key reaches the route and
    # require_api_key admits it.
    r = c.post("/watchlist", headers={"x-api-key": "ro"},
               json={"ticker": "AAPL"})
    assert r.status_code == 200, r.text

    # restore default for other tests
    monkeypatch.setenv("SIGNALCLAW_RBAC_ENFORCE", "1")
    _fresh_app({})
