from __future__ import annotations
import os
import json
import time

import pytest


def _fresh_app(env: dict):
    """Build a fresh FastAPI app with patched env so middleware/registry pick it up."""
    for k, v in env.items():
        os.environ[k] = v
    # Reset cached settings + registry so the new env is honored
    from signalclaw.config import get_settings as _gs
    _gs.cache_clear()
    from signalclaw.api import rate_limit
    rate_limit.reset_registry()
    # Reimport app module fresh
    import importlib
    import sys
    app_mod = sys.modules["signalclaw.api.app"]
    importlib.reload(app_mod)
    return app_mod.app


def test_token_bucket_drains_and_refills():
    from signalclaw.api.rate_limit import TokenBucket
    b = TokenBucket(capacity=2, refill_per_sec=2.0, tokens=2.0)
    ok, _ = b.take()
    assert ok
    ok, _ = b.take()
    assert ok
    ok, retry = b.take()
    assert not ok and retry >= 1.0
    time.sleep(0.6)
    ok, _ = b.take()
    assert ok


def test_required_scope_for_routes():
    from signalclaw.api.rate_limit import required_scope_for
    assert required_scope_for("GET", "/picks") == "read"
    assert required_scope_for("POST", "/portfolio/trades") == "trade"
    assert required_scope_for("DELETE", "/stops/abc") == "trade"
    assert required_scope_for("GET", "/portfolio/trades") == "read"
    assert required_scope_for("POST", "/admin/wipe") == "admin"


def test_registry_legacy_key_grants_full_access(monkeypatch):
    monkeypatch.delenv("SIGNALCLAW_API_KEYS_JSON", raising=False)
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "legacy-xyz")
    from signalclaw.api import rate_limit
    reg = rate_limit.ApiKeyRegistry()
    rec = reg.get("legacy-xyz")
    assert rec is not None
    assert "read" in rec.scopes and "trade" in rec.scopes


def test_registry_multi_key_json(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", json.dumps([
        {"key": "k-read", "scopes": ["read"], "label": "ro"},
        {"key": "k-trade", "scopes": ["read", "trade"], "rate_per_minute": 5},
    ]))
    monkeypatch.delenv("SIGNALCLAW_API_KEY", raising=False)
    from signalclaw.api import rate_limit
    reg = rate_limit.ApiKeyRegistry()
    ro = reg.get("k-read")
    assert ro and ro.scopes == {"read"}
    rw = reg.get("k-trade")
    assert rw and rw.has_scope("trade")
    assert rw.rate_per_minute == 5


def test_require_scope_dependency_denies(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", json.dumps([
        {"key": "ro-only", "scopes": ["read"]},
    ]))
    monkeypatch.delenv("SIGNALCLAW_API_KEY", raising=False)
    from signalclaw.api import rate_limit
    rate_limit.reset_registry()
    dep = rate_limit.require_scope("trade")
    with pytest.raises(Exception) as exc:
        dep(x_api_key="ro-only")
    assert "scope" in str(exc.value).lower()


def test_rate_limit_middleware_returns_429(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_RATE_LIMIT_ENABLED", "1")
    monkeypatch.setenv("SIGNALCLAW_RATE_LIMIT_READ_PER_MIN", "2")
    monkeypatch.setenv("SIGNALCLAW_RATE_LIMIT_WRITE_PER_MIN", "2")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "rl-key")
    monkeypatch.delenv("SIGNALCLAW_API_KEYS_JSON", raising=False)
    app = _fresh_app({})
    from fastapi.testclient import TestClient
    c = TestClient(app)
    h = {"x-api-key": "rl-key"}
    # /watchlist is read; capacity is 2 -> third call should 429
    r1 = c.get("/watchlist", headers=h)
    r2 = c.get("/watchlist", headers=h)
    r3 = c.get("/watchlist", headers=h)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r3.status_code == 429
    assert "Retry-After" in r3.headers

    # /health is exempt and should always succeed
    for _ in range(5):
        assert c.get("/health").status_code == 200

    # cleanup so other tests see middleware disabled again
    monkeypatch.setenv("SIGNALCLAW_RATE_LIMIT_ENABLED", "0")
    _fresh_app({})
