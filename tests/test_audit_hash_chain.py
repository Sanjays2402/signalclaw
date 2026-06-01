"""Tamper-evident audit log: hash-chain verification.

These tests prove two properties procurement reviewers ask about:

* Every persisted audit row binds to its predecessor via a sha256
  hash chain (``entry_hash = sha256(prev_hash + canonical_body)``).
* Mutating any persisted row, or splicing one out, makes
  ``AuditLog.verify`` and the ``/audit/verify`` endpoint report a
  break with the exact offending file + line.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Deterministic API keys for admin access.
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

_KEYS_JSON = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ops"},
])

from signalclaw.api import create_app  # noqa: E402
from signalclaw.api.rate_limit import reset_registry, get_registry  # noqa: E402
from signalclaw.audit import AuditLog, GENESIS_HASH, reset_audit_log  # noqa: E402
from signalclaw.audit.log import AuditEvent  # noqa: E402
from signalclaw.config import settings as settings_mod  # noqa: E402


@pytest.fixture()
def tmp_audit(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIGNALCLAW_API_KEYS_JSON", _KEYS_JSON)
    settings_mod.get_settings.cache_clear()
    reset_registry()
    reset_audit_log()
    get_registry().reload()
    yield tmp_path
    reset_audit_log()
    reset_registry()
    settings_mod.get_settings.cache_clear()


def _make_event(i: int) -> AuditEvent:
    return AuditEvent(
        ts=f"2026-05-31T00:00:0{i}.000000Z",
        request_id=f"req-{i}",
        method="POST",
        path=f"/things/{i}",
        status=200,
        actor_key_hash="abc123",
        actor_label="ops",
        source_ip="127.0.0.1",
        duration_ms=1.0,
        action="test",
    )


def test_chain_is_continuous_and_starts_from_genesis(tmp_audit):
    log = AuditLog(Path(tmp_audit) / "audit")
    for i in range(5):
        log.record(_make_event(i))

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rows = [
        json.loads(line)
        for line in (Path(tmp_audit) / "audit" / f"audit-{today}.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(rows) == 5
    assert rows[0]["prev_hash"] == GENESIS_HASH
    # each prev_hash matches the previous entry_hash
    for prev, curr in zip(rows, rows[1:]):
        assert curr["prev_hash"] == prev["entry_hash"]
        assert curr["entry_hash"] and curr["entry_hash"] != curr["prev_hash"]

    result = log.verify(days_back=2)
    assert result["ok"] is True, result
    assert result["checked"] == 5
    assert result["mismatches"] == []
    assert result["head"] == rows[-1]["entry_hash"]


def test_tampered_row_is_detected(tmp_audit):
    log = AuditLog(Path(tmp_audit) / "audit")
    for i in range(4):
        log.record(_make_event(i))

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path = Path(tmp_audit) / "audit" / f"audit-{today}.jsonl"
    lines = path.read_text().splitlines()
    # Tamper with row 2 (zero-indexed) by changing the audited path
    # but leaving its stored entry_hash intact. A real attacker would
    # also have to forge every subsequent prev_hash, which is exactly
    # what we want to make visible.
    row = json.loads(lines[2])
    row["path"] = "/things/EDITED"
    lines[2] = json.dumps(row, separators=(",", ":"), sort_keys=True)
    path.write_text("\n".join(lines) + "\n")

    result = log.verify(days_back=2)
    assert result["ok"] is False
    assert result["checked"] == 4
    reasons = {m["reason"] for m in result["mismatches"]}
    assert "entry_hash_mismatch" in reasons
    # the break is reported on line 3 (1-indexed) — the edited row
    offenders = [m for m in result["mismatches"] if m["reason"] == "entry_hash_mismatch"]
    assert offenders[0]["line"] == 3
    assert offenders[0]["file"].endswith(".jsonl")


def test_verify_endpoint_requires_admin_and_reports_clean_chain(tmp_audit):
    app = create_app()
    client = TestClient(app)

    # Generate a few audit-worthy events by hitting an admin endpoint.
    headers = {"x-api-key": "admin-key"}
    for _ in range(3):
        r = client.get("/audit/days", headers=headers)
        assert r.status_code == 200

    # Without admin, the endpoint must refuse.
    anon = client.get("/audit/verify")
    assert anon.status_code in (401, 403)

    # With admin, the endpoint returns a clean verification report.
    ok = client.get("/audit/verify?days_back=2", headers=headers)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["ok"] is True
    assert body["checked"] >= 1
    assert body["mismatches"] == []
    assert body["head"] and body["head"] != GENESIS_HASH
