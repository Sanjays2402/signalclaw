"""Audit log: append-only who/what/when record of mutating API calls.

The audit log persists a JSONL record for every authenticated mutating
request and for authentication or authorization failures on protected
routes. Records are written under ``<data_dir>/audit/audit-YYYY-MM-DD.jsonl``
and rotated daily by filename.

Records are intentionally small and structured so they can be tailed,
shipped to a SIEM, or queried via the ``/audit`` endpoint. They never
contain request bodies or response payloads, only metadata.
"""
from __future__ import annotations

from .log import (
    AuditEvent,
    AuditLog,
    AuditMiddleware,
    get_audit_log,
    reset_audit_log,
)
from .retention import (
    AuditRetentionPruner,
    retention_config_from_env,
)

__all__ = [
    "AuditEvent",
    "AuditLog",
    "AuditMiddleware",
    "AuditRetentionPruner",
    "get_audit_log",
    "reset_audit_log",
    "retention_config_from_env",
]
