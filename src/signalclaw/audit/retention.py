"""Background retention pruner for the persisted audit log.

Audit data must not grow without bound. Without a retention policy the
JSONL files under ``<data_dir>/audit/`` accumulate forever, eventually
filling the volume and making GDPR-style erasure requests harder than
they should be.

This module provides a tiny daemon thread that wakes on a fixed
interval, calls :meth:`AuditLog.prune` with the configured maximum
age, and emits a structured log line for each sweep so operators can
see deletions in their log aggregator. The pruner is intentionally
isolated from FastAPI so it can be reused by the CLI or cron jobs.

Configuration is environment driven so it composes with the existing
settings pattern:

* ``SIGNALCLAW_AUDIT_RETENTION_DAYS`` (default ``90``): age threshold.
  ``0`` disables retention entirely.
* ``SIGNALCLAW_AUDIT_RETENTION_INTERVAL_SECONDS`` (default ``3600``):
  how often to sweep. Kept short enough that a misconfiguration is
  visible inside an hour, long enough not to thrash disk.

The thread is a daemon so it never blocks process shutdown.
"""
from __future__ import annotations

import os
import threading
from typing import Optional

import structlog

from .log import AuditLog

log = structlog.get_logger(__name__)


DEFAULT_RETENTION_DAYS = 90
DEFAULT_INTERVAL_SECONDS = 3600


def retention_config_from_env() -> tuple[int, int]:
    """Return ``(retention_days, interval_seconds)`` from the environment.

    Both values are clamped to non-negative integers. Invalid values
    fall back to the defaults so a typo in the env file does not crash
    boot.
    """
    raw_days = os.environ.get("SIGNALCLAW_AUDIT_RETENTION_DAYS", str(DEFAULT_RETENTION_DAYS))
    raw_int = os.environ.get(
        "SIGNALCLAW_AUDIT_RETENTION_INTERVAL_SECONDS", str(DEFAULT_INTERVAL_SECONDS)
    )
    try:
        days = max(0, int(raw_days))
    except ValueError:
        days = DEFAULT_RETENTION_DAYS
    try:
        interval = max(60, int(raw_int))
    except ValueError:
        interval = DEFAULT_INTERVAL_SECONDS
    return days, interval


class AuditRetentionPruner:
    """Daemon-thread wrapper around :meth:`AuditLog.prune`.

    Construct once at app startup, call :meth:`start` to launch the
    background sweeper. :meth:`stop` is provided for tests and clean
    shutdown; in normal process exit the daemon flag handles it.
    """

    def __init__(
        self,
        audit_log: AuditLog,
        retention_days: int,
        interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
    ) -> None:
        self._log = audit_log
        self._retention_days = int(retention_days)
        self._interval = max(1, int(interval_seconds))
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    @property
    def enabled(self) -> bool:
        return self._retention_days > 0

    def sweep_once(self) -> list[str]:
        """Run a single prune pass synchronously and return removed files."""
        if not self.enabled:
            return []
        try:
            removed = self._log.prune(self._retention_days)
        except Exception as e:  # never let pruner kill the process
            log.warning("audit.retention.sweep_failed", error=repr(e))
            return []
        if removed:
            log.info(
                "audit.retention.pruned",
                files_removed=len(removed),
                retention_days=self._retention_days,
            )
        return removed

    def _run(self) -> None:
        # First sweep on startup so a long-stopped service catches up
        # immediately rather than waiting a full interval.
        self.sweep_once()
        while not self._stop.wait(self._interval):
            self.sweep_once()

    def start(self) -> None:
        if not self.enabled:
            log.info("audit.retention.disabled")
            return
        if self._thread is not None and self._thread.is_alive():
            return
        log.info(
            "audit.retention.started",
            retention_days=self._retention_days,
            interval_seconds=self._interval,
        )
        t = threading.Thread(
            target=self._run, name="audit-retention", daemon=True
        )
        self._thread = t
        t.start()

    def stop(self, timeout: float = 1.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None
