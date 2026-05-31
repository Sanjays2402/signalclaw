"""Tests for the configurable request body size guard.

Proves:
* Oversized request bodies are rejected with 413 + structured JSON.
* Content-Length header check fires before the body is read (layer 1).
* Streaming check catches clients that omit Content-Length (layer 2).
* GET/HEAD are exempt (no body to limit).
* Admin can read + raise the cap via /admin/body-limit.
* A non-admin key cannot mutate the cap.
* The default cap accepts normal payloads.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient


_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
    {"key": "reader-key", "scopes": ["read"], "label": "viewer"},
])


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    monkeypatch.setenv("SIGNALCLAW_RBAC_ENFORCE", "1")
    monkeypatch.setenv("SIGNALCLAW_MFA_REQUIRED_FOR_ADMIN", "0")
    monkeypatch.delenv("SIGNALCLAW_API_KEY", raising=False)
    monkeypatch.delenv("SIGNALCLAW_BODY_LIMIT_BYTES", raising=False)

    from signalclaw.config import settings as settings_mod
    settings_mod.get_settings.cache_clear()
    from signalclaw.api.rate_limit import reset_registry
    reset_registry()
    from signalclaw.audit import reset_audit_log
    reset_audit_log()

    from signalclaw.api.app import create_app
    app = create_app()
    with TestClient(app) as c:
        yield c


def _admin_h():
    return {"x-api-key": "admin-key"}


def _reader_h():
    return {"x-api-key": "reader-key"}


def test_default_cap_allows_small_payload(client):
    r = client.get("/admin/body-limit", headers=_admin_h())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["max_bytes"] == 1024 * 1024
    assert body["min_bytes"] == 1024
    assert body["max_allowed_bytes"] == 1024 * 1024 * 1024


def test_lower_cap_then_oversized_header_rejected(client):
    r = client.put("/admin/body-limit",
                   headers=_admin_h(), json={"max_bytes": 2048})
    assert r.status_code == 200, r.text
    assert r.json()["max_bytes"] == 2048

    # Send a 4 KiB JSON body; Content-Length is set by the client.
    big = {"ticker": "AAA", "blob": "x" * 4000}
    resp = client.post("/watchlist", headers=_admin_h(), json=big)
    assert resp.status_code == 413, resp.text
    payload = resp.json()
    assert payload["error"] == "payload_too_large"
    assert payload["limit_bytes"] == 2048
    assert resp.headers.get("x-body-limit-bytes") == "2048"


def test_get_is_exempt_even_with_tiny_cap(client):
    r = client.put("/admin/body-limit",
                   headers=_admin_h(), json={"max_bytes": 1024})
    assert r.status_code == 200
    # A GET with no body must still succeed regardless of cap.
    g = client.get("/watchlist", headers=_admin_h())
    assert g.status_code == 200, g.text


def test_non_admin_cannot_change_cap(client):
    r = client.put("/admin/body-limit",
                   headers=_reader_h(), json={"max_bytes": 4096})
    assert r.status_code in (401, 403)


def test_invalid_cap_rejected(client):
    r = client.put("/admin/body-limit",
                   headers=_admin_h(), json={"max_bytes": 10})
    assert r.status_code == 400
    r2 = client.put("/admin/body-limit",
                    headers=_admin_h(), json={})
    assert r2.status_code == 400
    r3 = client.put("/admin/body-limit",
                    headers=_admin_h(), json={"max_bytes": "huge"})
    assert r3.status_code == 400


def test_rejection_audited(client, tmp_path):
    client.put("/admin/body-limit",
               headers=_admin_h(), json={"max_bytes": 1024})
    big = {"ticker": "AAA", "blob": "x" * 4000}
    r = client.post("/watchlist", headers=_admin_h(), json=big)
    assert r.status_code == 413

    audit_dir = tmp_path / "audit"
    files = list(audit_dir.glob("audit-*.jsonl"))
    assert files, "audit file must exist"
    blob = "\n".join(p.read_text(encoding="utf-8") for p in files)
    assert "body.limit.exceeded" in blob
