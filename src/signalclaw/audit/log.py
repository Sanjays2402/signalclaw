"""Persisted audit log + ASGI middleware.

Design notes:

* Writes are append-only JSONL, one file per UTC day. This keeps the
  format trivially tailable, grep-able, and shippable to a SIEM. No
  separate database is required.
* The middleware fires after the downstream handler so the audit record
  carries the final HTTP status. This means a failed auth (401) or a
  missing scope (403) still produces a row, which is exactly what an
  enterprise auditor wants to see.
* We never log request bodies or response payloads. We log metadata
  only: who (api key label + hashed key prefix), what (method + path),
  when (UTC ISO timestamp), outcome (status code), request id, source
  IP, and an optional free-form ``action`` tag.
* Read-only ``GET`` and ``HEAD`` requests are skipped by default to
  keep the log signal-to-noise high. Set ``audit_reads=True`` to
  capture them too.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Iterable, List, Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from ..api.rate_limit import get_registry


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _hash_key(key: str) -> str:
    """Stable, non-reversible identifier for an API key.

    We keep only the first 12 hex chars of the SHA-256 digest so the
    audit log can correlate activity per key without ever revealing the
    key material itself.
    """
    return sha256(key.encode("utf-8")).hexdigest()[:12]


@dataclass
class AuditEvent:
    ts: str
    request_id: str
    method: str
    path: str
    status: int
    actor_key_hash: str
    actor_label: str
    source_ip: str
    duration_ms: float
    action: str = ""
    extra: dict = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)


class AuditLog:
    """Append-only JSONL audit log with daily file rotation."""

    def __init__(self, base_dir: Path) -> None:
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path_for(self, day: Optional[str] = None) -> Path:
        d = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return self.base / f"audit-{d}.jsonl"

    def record(self, event: AuditEvent) -> None:
        line = event.to_json() + "\n"
        path = self._path_for()
        with self._lock:
            # open per write so external log rotation / removal is safe
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line)

    def tail(self, limit: int = 100, day: Optional[str] = None) -> List[dict]:
        """Return up to ``limit`` most recent events for ``day`` (UTC).

        Defaults to today. We read the file once, parse all valid lines,
        then return the trailing slice. The audit volume is operator-
        scale so this is cheap; if it ever becomes hot, switch to a
        reverse-line iterator.
        """
        path = self._path_for(day)
        if not path.exists():
            return []
        out: List[dict] = []
        with self._lock:
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        if limit > 0:
            out = out[-limit:]
        return out

    def list_days(self) -> List[str]:
        days: List[str] = []
        for p in sorted(self.base.glob("audit-*.jsonl")):
            stem = p.stem  # audit-YYYY-MM-DD
            days.append(stem.removeprefix("audit-"))
        return days


# --- module singleton ---------------------------------------------------

_LOG: Optional[AuditLog] = None
_LOG_DIR: Optional[Path] = None


def get_audit_log(base_dir: Optional[Path] = None) -> AuditLog:
    global _LOG, _LOG_DIR
    if base_dir is not None and base_dir != _LOG_DIR:
        _LOG = AuditLog(base_dir)
        _LOG_DIR = base_dir
    if _LOG is None:
        # fallback: ./data/audit
        fallback = Path(os.environ.get("SIGNALCLAW_DATA_DIR", "./data")) / "audit"
        _LOG = AuditLog(fallback)
        _LOG_DIR = fallback
    return _LOG


def reset_audit_log() -> None:
    global _LOG, _LOG_DIR
    _LOG = None
    _LOG_DIR = None


# --- middleware ---------------------------------------------------------


class AuditMiddleware(BaseHTTPMiddleware):
    """Persist an audit row for every mutating or auth-relevant request.

    ``audit_reads`` lets operators flip on read-side auditing for
    incident response. ``exempt_paths`` matches health and docs paths
    so dashboards do not flood the log.
    """

    DEFAULT_EXEMPT: tuple[str, ...] = (
        "/health",
        "/ready",
        "/disclaimer",
        "/metrics",
        "/docs",
        "/openapi.json",
        "/redoc",
        "/docs/oauth2-redirect",
        "/favicon.ico",
    )

    def __init__(
        self,
        app,
        audit_log: AuditLog,
        audit_reads: bool = False,
        exempt_paths: Iterable[str] = DEFAULT_EXEMPT,
    ) -> None:
        super().__init__(app)
        self._log = audit_log
        self._audit_reads = audit_reads
        self._exempt = tuple(exempt_paths)

    def _should_audit(self, method: str, path: str, status: int) -> bool:
        if any(path.startswith(p) for p in self._exempt):
            return False
        # always audit auth failures regardless of method
        if status in (401, 403):
            return True
        if method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
            return True
        return self._audit_reads

    async def dispatch(self, request: Request, call_next):
        t0 = time.perf_counter()
        # Prefer the id set by RequestContextMiddleware so the audit
        # row and structured logs share the same request_id. Fall back
        # to the inbound header or a fresh id if this middleware runs
        # standalone (for example in narrow unit tests).
        rid = (
            getattr(request.state, "request_id", None)
            or request.headers.get("x-request-id")
            or uuid.uuid4().hex[:16]
        )
        # stash it for downstream code / response header
        try:
            response = await call_next(request)
        except Exception:
            # Record the failure as a 500 audit row, then re-raise so
            # the framework's own error path still runs.
            self._safe_record(request, rid, 500, (time.perf_counter() - t0) * 1000.0)
            raise
        response.headers["x-request-id"] = rid
        if self._should_audit(request.method, request.url.path, response.status_code):
            self._safe_record(
                request, rid, response.status_code,
                (time.perf_counter() - t0) * 1000.0,
            )
        return response

    def _safe_record(self, request: Request, rid: str, status: int, dur_ms: float) -> None:
        api_key = request.headers.get("x-api-key", "")
        rec = get_registry().get(api_key) if api_key else None
        actor_label = rec.label if rec else ("anon" if not api_key else "unknown")
        actor_hash = _hash_key(api_key) if api_key else ""
        client = request.client.host if request.client else ""
        ip = request.headers.get("x-forwarded-for", client).split(",")[0].strip()
        event = AuditEvent(
            ts=_utc_now_iso(),
            request_id=rid,
            method=request.method.upper(),
            path=request.url.path,
            status=int(status),
            actor_key_hash=actor_hash,
            actor_label=actor_label,
            source_ip=ip,
            duration_ms=round(dur_ms, 2),
        )
        try:
            self._log.record(event)
        except OSError:
            # never let audit IO break the request path; rate-limit
            # noise by simply dropping. Operators monitor disk fill
            # via the standard infra alerts.
            pass
