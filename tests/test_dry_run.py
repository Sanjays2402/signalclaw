"""Tests for sandbox / dry-run middleware.

Proves that ``?dry_run=true`` on mutating endpoints:

* Short-circuits the handler (no state is written).
* Returns 202 with the canonical envelope and ``X-Dry-Run: true``.
* Still produces an audit row, tagged ``dry_run``.
* Still enforces scope checks (so a read-only key cannot probe a
  trade-scoped route even in sandbox mode).
* Leaves read endpoints untouched.
"""
from __future__ import annotations

import json
import os

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
    monkeypatch.delenv("SIGNALCLAW_API_KEY", raising=False)

    from signalclaw.config import settings as settings_mod
    settings_mod.get_settings.cache_clear()
    from signalclaw.api.rate_limit import reset_registry
    reset_registry()
    from signalclaw.audit import reset_audit_log
    reset_audit_log()

    from signalclaw.api import create_app
    app = create_app()
    with TestClient(app) as c:
        yield c, tmp_path


def _audit_rows(tmp_path):
    rows = []
    audit_dir = tmp_path / "audit"
    if not audit_dir.exists():
        return rows
    for f in sorted(audit_dir.glob("audit-*.jsonl")):
        for line in f.read_text().splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


def test_dry_run_short_circuits_post(client):
    c, tmp = client
    headers = {"x-api-key": "admin-key"}
    # Add a watchlist ticker with dry_run=true.
    r = c.post("/watchlist?ticker=AAPL&dry_run=true", headers=headers)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["dry_run"] is True
    assert body["would_execute"]["method"] == "POST"
    assert body["would_execute"]["path"] == "/watchlist"
    assert body["would_execute"]["query"]["ticker"] == "AAPL"
    assert r.headers.get("X-Dry-Run") == "true"

    # State unchanged: the real GET shows no ticker.
    g = c.get("/watchlist", headers=headers)
    assert g.status_code == 200
    assert "AAPL" not in (g.json().get("tickers") or [])


def test_dry_run_short_circuits_delete(client):
    c, tmp = client
    headers = {"x-api-key": "admin-key"}
    # Seed a real ticker.
    c.post("/watchlist?ticker=MSFT", headers=headers)
    # Dry-run delete.
    r = c.delete("/watchlist/MSFT?dry_run=true", headers=headers)
    assert r.status_code == 202
    assert r.json()["would_execute"]["method"] == "DELETE"
    assert r.headers.get("X-Dry-Run") == "true"
    # MSFT is still in the watchlist.
    g = c.get("/watchlist", headers=headers).json()
    assert "MSFT" in (g.get("tickers") or [])


def test_dry_run_via_header(client):
    c, _ = client
    r = c.post(
        "/watchlist?ticker=NVDA",
        headers={"x-api-key": "admin-key", "X-Dry-Run": "1"},
    )
    assert r.status_code == 202
    assert r.json()["dry_run"] is True


def test_dry_run_records_audit_row(client):
    c, tmp = client
    c.post("/watchlist?ticker=AMZN&dry_run=true",
           headers={"x-api-key": "admin-key"})
    rows = _audit_rows(tmp)
    hits = [r for r in rows
            if r["path"] == "/watchlist" and r["method"] == "POST"]
    assert hits, f"expected an audit row, got {rows}"
    last = hits[-1]
    assert last["status"] == 202
    assert last.get("action") == "dry_run"
    assert last.get("extra", {}).get("dry_run") is True


def test_dry_run_still_enforces_scope(client):
    c, _ = client
    # reader-key has only the ``read`` scope; the trade-scoped POST
    # must be rejected with 403 even in sandbox mode. Otherwise an
    # attacker could probe destructive routes they have no right to
    # call.
    r = c.post(
        "/watchlist?ticker=AAPL&dry_run=true",
        headers={"x-api-key": "reader-key"},
    )
    assert r.status_code == 403, r.text


def test_dry_run_ignored_for_get(client):
    c, _ = client
    r = c.get("/watchlist?dry_run=true",
              headers={"x-api-key": "admin-key"})
    assert r.status_code == 200
    assert r.headers.get("X-Dry-Run") is None
