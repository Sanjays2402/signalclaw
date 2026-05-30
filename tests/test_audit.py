"""Tests for the persisted audit log + middleware."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Ensure auth registry picks up a deterministic admin key for /audit access.
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
    {"key": "trader-key", "scopes": ["read", "trade"], "label": "trader"},
])

from signalclaw.api import create_app  # noqa: E402
from signalclaw.api.rate_limit import reset_registry, get_registry  # noqa: E402
from signalclaw.audit import AuditLog, reset_audit_log, get_audit_log  # noqa: E402
from signalclaw.audit.log import AuditEvent, _hash_key  # noqa: E402
from signalclaw.config import settings as settings_mod  # noqa: E402


@pytest.fixture()
def tmp_data(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    # rebuild registry so the new env vars apply
    get_registry().reload()
    yield tmp_path
    reset_audit_log()
    reset_registry()
    settings_mod.get_settings.cache_clear()


def _client(tmp_path):
    return TestClient(create_app()), tmp_path / "audit"


def _read_all(audit_dir: Path):
    rows = []
    for p in sorted(audit_dir.glob("audit-*.jsonl")):
        for line in p.read_text().splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


def test_audit_log_write_and_tail(tmp_path):
    log = AuditLog(tmp_path / "audit")
    ev = AuditEvent(
        ts="2026-05-30T00:00:00.000000Z",
        request_id="abc",
        method="POST",
        path="/watchlist",
        status=200,
        actor_key_hash=_hash_key("trader-key"),
        actor_label="trader",
        source_ip="127.0.0.1",
        duration_ms=1.23,
    )
    log.record(ev)
    log.record(ev)
    rows = log.tail(limit=10)
    assert len(rows) == 2
    assert rows[0]["path"] == "/watchlist"
    assert rows[0]["actor_label"] == "trader"
    # hash is stable, never reveals key
    assert rows[0]["actor_key_hash"] == _hash_key("trader-key")
    assert "trader-key" not in json.dumps(rows[0])


def test_audit_skips_health_and_reads(tmp_data):
    client, audit_dir = _client(tmp_data)
    client.get("/health")
    client.get("/watchlist", headers={"x-api-key": "trader-key"})
    # neither health nor a successful GET is audited by default
    rows = _read_all(audit_dir)
    assert rows == []


def test_audit_records_mutation_and_auth_failure(tmp_data):
    client, audit_dir = _client(tmp_data)
    # mutating call by trader -> audited
    client.post("/watchlist", json={"ticker": "AAPL"},
                headers={"x-api-key": "trader-key"})
    # auth failure on a protected route -> audited even though GET
    client.get("/watchlist")  # missing key -> 401
    rows = _read_all(audit_dir)
    paths = [(r["method"], r["path"], r["status"]) for r in rows]
    assert ("POST", "/watchlist", 200) in paths
    assert ("GET", "/watchlist", 401) in paths
    # mutating row carries the trader identity
    mut = next(r for r in rows if r["method"] == "POST")
    assert mut["actor_label"] == "trader"
    assert mut["actor_key_hash"] == _hash_key("trader-key")
    assert mut["request_id"]


def test_audit_endpoint_requires_admin_scope(tmp_data):
    client, _ = _client(tmp_data)
    # trader has no admin scope
    r = client.get("/audit", headers={"x-api-key": "trader-key"})
    assert r.status_code == 403
    # admin can read
    client.post("/watchlist", json={"ticker": "MSFT"},
                headers={"x-api-key": "trader-key"})
    r = client.get("/audit?limit=50", headers={"x-api-key": "admin-key"})
    assert r.status_code == 200
    body = r.json()
    assert "events" in body
    # at least the mutation and the admin /audit call's prior auth flows
    # have been recorded; ensure the mutation is visible
    assert any(e["method"] == "POST" and e["path"] == "/watchlist"
               for e in body["events"])


def test_request_id_round_trips(tmp_data):
    client, _ = _client(tmp_data)
    r = client.post("/watchlist", json={"ticker": "NVDA"},
                    headers={"x-api-key": "trader-key",
                             "x-request-id": "deadbeefcafebabe"})
    assert r.status_code == 200
    assert r.headers.get("x-request-id") == "deadbeefcafebabe"
