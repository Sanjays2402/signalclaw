"""Tests for audit log retention pruning."""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from signalclaw.audit.log import AuditLog
from signalclaw.audit.retention import (
    AuditRetentionPruner,
    retention_config_from_env,
)


def _touch_audit_file(base: Path, day: str, payload: str = '{"ok":1}\n') -> Path:
    p = base / f"audit-{day}.jsonl"
    p.write_text(payload, encoding="utf-8")
    return p


def test_prune_removes_files_older_than_threshold(tmp_path: Path) -> None:
    log = AuditLog(tmp_path)
    today = datetime(2025, 6, 1, tzinfo=timezone.utc)
    keep_recent = _touch_audit_file(tmp_path, "2025-05-31")
    keep_boundary = _touch_audit_file(tmp_path, "2025-05-25")  # exactly 7 days old, kept
    drop_old = _touch_audit_file(tmp_path, "2025-05-24")        # 8 days old, removed
    drop_ancient = _touch_audit_file(tmp_path, "2024-01-01")

    removed = log.prune(max_age_days=7, now=today)

    removed_set = {Path(p) for p in removed}
    assert drop_old in removed_set
    assert drop_ancient in removed_set
    assert keep_recent.exists()
    assert keep_boundary.exists()
    assert not drop_old.exists()
    assert not drop_ancient.exists()


def test_prune_no_op_when_disabled(tmp_path: Path) -> None:
    log = AuditLog(tmp_path)
    p = _touch_audit_file(tmp_path, "1999-01-01")
    assert log.prune(max_age_days=0) == []
    assert p.exists()


def test_prune_ignores_unrelated_files(tmp_path: Path) -> None:
    log = AuditLog(tmp_path)
    (tmp_path / "audit-not-a-date.jsonl").write_text("garbage", encoding="utf-8")
    (tmp_path / "README.md").write_text("hi", encoding="utf-8")
    removed = log.prune(max_age_days=1)
    assert removed == []
    assert (tmp_path / "audit-not-a-date.jsonl").exists()
    assert (tmp_path / "README.md").exists()


def test_pruner_sweep_once_emits_removals(tmp_path: Path) -> None:
    log = AuditLog(tmp_path)
    old_day = (datetime.now(timezone.utc) - timedelta(days=400)).strftime("%Y-%m-%d")
    fresh_day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    old = _touch_audit_file(tmp_path, old_day)
    fresh = _touch_audit_file(tmp_path, fresh_day)

    pruner = AuditRetentionPruner(log, retention_days=90, interval_seconds=3600)
    assert pruner.enabled is True
    removed = pruner.sweep_once()

    assert Path(removed[0]) == old
    assert not old.exists()
    assert fresh.exists()


def test_pruner_disabled_when_zero_days(tmp_path: Path) -> None:
    log = AuditLog(tmp_path)
    old = _touch_audit_file(tmp_path, "2000-01-01")
    pruner = AuditRetentionPruner(log, retention_days=0)
    assert pruner.enabled is False
    assert pruner.sweep_once() == []
    assert old.exists()


def test_pruner_thread_runs_initial_sweep(tmp_path: Path) -> None:
    log = AuditLog(tmp_path)
    old_day = (datetime.now(timezone.utc) - timedelta(days=10)).strftime("%Y-%m-%d")
    old = _touch_audit_file(tmp_path, old_day)
    pruner = AuditRetentionPruner(log, retention_days=1, interval_seconds=60)
    try:
        pruner.start()
        # Initial sweep runs synchronously at thread start; allow scheduler slack.
        for _ in range(50):
            if not old.exists():
                break
            time.sleep(0.02)
        assert not old.exists()
    finally:
        pruner.stop(timeout=2.0)


def test_retention_config_from_env_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SIGNALCLAW_AUDIT_RETENTION_DAYS", raising=False)
    monkeypatch.delenv("SIGNALCLAW_AUDIT_RETENTION_INTERVAL_SECONDS", raising=False)
    days, interval = retention_config_from_env()
    assert days == 90
    assert interval == 3600


def test_retention_config_from_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SIGNALCLAW_AUDIT_RETENTION_DAYS", "30")
    monkeypatch.setenv("SIGNALCLAW_AUDIT_RETENTION_INTERVAL_SECONDS", "120")
    days, interval = retention_config_from_env()
    assert days == 30
    assert interval == 120


def test_retention_config_from_env_invalid_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SIGNALCLAW_AUDIT_RETENTION_DAYS", "not-a-number")
    monkeypatch.setenv("SIGNALCLAW_AUDIT_RETENTION_INTERVAL_SECONDS", "also-bad")
    days, interval = retention_config_from_env()
    assert days == 90
    assert interval == 3600
