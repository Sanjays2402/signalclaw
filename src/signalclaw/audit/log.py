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

import csv
import io
import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

# NOTE: ``..api.rate_limit`` is imported lazily inside ``_safe_record``
# to avoid a circular import: ``api.app`` imports from ``..audit``,
# and ``audit.log`` is loaded as part of the ``signalclaw.audit``
# package init. A top-level import here would resolve only when tests
# happened to import ``signalclaw.api`` first, which is fragile.


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _hash_key(key: str) -> str:
    """Stable, non-reversible identifier for an API key.

    We keep only the first 12 hex chars of the SHA-256 digest so the
    audit log can correlate activity per key without ever revealing the
    key material itself.
    """
    return sha256(key.encode("utf-8")).hexdigest()[:12]


# Genesis hash for the audit chain. 64 zero hex chars so the first
# real entry binds against a well-known value an auditor can recompute
# without any prior state.
GENESIS_HASH: str = "0" * 64


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
    # Tamper-evident chain fields. ``prev_hash`` is the ``entry_hash``
    # of the previous record (or :data:`GENESIS_HASH` for the first
    # ever entry). ``entry_hash`` is sha256 over
    # ``prev_hash + canonical_body_json`` where the body excludes
    # both hash fields. Excluding them keeps the body deterministic so
    # re-verification is a pure function of the on-disk row.
    prev_hash: str = ""
    entry_hash: str = ""

    def body_json(self) -> str:
        """Canonical JSON of the auditable body (chain fields omitted)."""
        d = asdict(self)
        d.pop("prev_hash", None)
        d.pop("entry_hash", None)
        return json.dumps(d, separators=(",", ":"), sort_keys=True)

    def compute_entry_hash(self, prev_hash: str) -> str:
        return sha256((prev_hash + self.body_json()).encode("utf-8")).hexdigest()

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)


class AuditLog:
    """Append-only JSONL audit log with daily file rotation."""

    def __init__(self, base_dir: Path) -> None:
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # Chain head cache so we do not stat/parse a file on every
        # write. Lazily populated on the first record() call from the
        # on-disk ``.chain-state`` file plus the latest daily JSONL.
        self._chain_state_path = self.base / ".chain-state"
        self._last_hash: Optional[str] = None

    def _load_chain_head(self) -> str:
        """Return the entry_hash of the most recent audited row.

        Trusts the persisted ``.chain-state`` file if present; otherwise
        reconstructs from the newest daily JSONL so a deployment that
        upgrades into hash-chaining still produces a continuous chain
        from its first new write onward.
        """
        if self._last_hash is not None:
            return self._last_hash
        try:
            if self._chain_state_path.exists():
                state = json.loads(self._chain_state_path.read_text(encoding="utf-8"))
                head = str(state.get("last_hash") or "")
                if head:
                    self._last_hash = head
                    return head
        except (OSError, json.JSONDecodeError):
            pass
        # Fallback: scan the newest daily file for its last entry_hash.
        for p in sorted(self.base.glob("audit-*.jsonl"), reverse=True):
            try:
                with p.open("r", encoding="utf-8") as fh:
                    last_line = ""
                    for line in fh:
                        line = line.strip()
                        if line:
                            last_line = line
                if last_line:
                    try:
                        row = json.loads(last_line)
                        h = str(row.get("entry_hash") or "")
                        if h:
                            self._last_hash = h
                            return h
                    except json.JSONDecodeError:
                        continue
            except OSError:
                continue
        self._last_hash = GENESIS_HASH
        return self._last_hash

    def _persist_chain_head(self, head: str) -> None:
        try:
            self._chain_state_path.write_text(
                json.dumps({"last_hash": head}, separators=(",", ":")),
                encoding="utf-8",
            )
        except OSError:
            # The chain head will be recovered from the JSONL on next
            # load; persistence is best-effort.
            pass

    def _path_for(self, day: Optional[str] = None) -> Path:
        d = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return self.base / f"audit-{d}.jsonl"

    def record(self, event: AuditEvent) -> None:
        path = self._path_for()
        with self._lock:
            prev = self._load_chain_head()
            event.prev_hash = prev
            event.entry_hash = event.compute_entry_hash(prev)
            line = event.to_json() + "\n"
            # open per write so external log rotation / removal is safe
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line)
            self._last_hash = event.entry_hash
            self._persist_chain_head(event.entry_hash)

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

    # --- search / export ------------------------------------------------
    # Procurement reviewers (SOC2 / ISO 27001) expect operators to be
    # able to answer "show me every mutating call from key X over the
    # past 30 days where status >= 400, and hand me a CSV." ``tail`` is
    # too coarse for that: it only looks at a single day and accepts no
    # filters. ``search`` walks ``days_back`` daily files newest-first
    # and applies all filters in a single pass; ``iter_search`` is the
    # streaming variant that backs ``/audit/export.csv`` so a 90-day
    # export does not have to materialise in memory.

    _CSV_FIELDS: tuple = (
        "ts", "request_id", "method", "path", "status",
        "actor_label", "actor_key_hash", "source_ip",
        "duration_ms", "action", "prev_hash", "entry_hash",
    )

    # --- tamper-evident verification ------------------------------------
    def verify(
        self,
        days_back: int = 30,
        max_rows: int = 1_000_000,
    ) -> Dict[str, object]:
        """Recompute the hash chain across daily files and report breaks.

        Walks audit JSONL files in chronological order across the last
        ``days_back`` UTC days and recomputes ``entry_hash`` for every
        row. The first row's ``prev_hash`` must equal the previous
        row's ``entry_hash`` (or :data:`GENESIS_HASH` if none).

        Returns a dict with:

        * ``ok``: True if every row matched
        * ``checked``: total rows verified
        * ``mismatches``: list of ``{file, line, reason, expected,
          actual}`` for the first few breaks (capped at 50)
        * ``head``: entry_hash of the last row scanned
        * ``days_back``: window inspected
        * ``files``: list of audit file names inspected (chronological)
        """
        days_back = max(1, min(int(days_back), 365))
        today = datetime.now(timezone.utc).date()
        files: List[Path] = []
        # chronological order = oldest first so the chain runs forward
        for delta in range(days_back - 1, -1, -1):
            d = today - timedelta(days=delta)
            p = self.base / f"audit-{d.strftime('%Y-%m-%d')}.jsonl"
            if p.exists():
                files.append(p)
        prev = GENESIS_HASH
        # If we are not scanning from the genesis day, accept whatever
        # ``prev_hash`` the first encountered row carries as the chain
        # entry point. Procurement reviewers can widen ``days_back`` to
        # 365 to walk the full chain.
        first_row_seen = False
        checked = 0
        mismatches: List[dict] = []
        for path in files:
            try:
                with path.open("r", encoding="utf-8") as fh:
                    for line_no, raw in enumerate(fh, start=1):
                        raw = raw.strip()
                        if not raw:
                            continue
                        try:
                            row = json.loads(raw)
                        except json.JSONDecodeError:
                            mismatches.append({
                                "file": path.name, "line": line_no,
                                "reason": "invalid_json",
                                "expected": "", "actual": raw[:120],
                            })
                            continue
                        if not first_row_seen:
                            prev = str(row.get("prev_hash") or GENESIS_HASH)
                            first_row_seen = True
                        ev = AuditEvent(
                            ts=str(row.get("ts", "")),
                            request_id=str(row.get("request_id", "")),
                            method=str(row.get("method", "")),
                            path=str(row.get("path", "")),
                            status=int(row.get("status", 0) or 0),
                            actor_key_hash=str(row.get("actor_key_hash", "")),
                            actor_label=str(row.get("actor_label", "")),
                            source_ip=str(row.get("source_ip", "")),
                            duration_ms=float(row.get("duration_ms", 0) or 0),
                            action=str(row.get("action", "")),
                            extra=dict(row.get("extra", {}) or {}),
                        )
                        expected_prev = prev
                        actual_prev = str(row.get("prev_hash", ""))
                        recomputed = ev.compute_entry_hash(actual_prev)
                        stored = str(row.get("entry_hash", ""))
                        if actual_prev != expected_prev:
                            if len(mismatches) < 50:
                                mismatches.append({
                                    "file": path.name, "line": line_no,
                                    "reason": "prev_hash_mismatch",
                                    "expected": expected_prev,
                                    "actual": actual_prev,
                                })
                        if recomputed != stored:
                            if len(mismatches) < 50:
                                mismatches.append({
                                    "file": path.name, "line": line_no,
                                    "reason": "entry_hash_mismatch",
                                    "expected": recomputed,
                                    "actual": stored,
                                })
                        prev = stored or recomputed
                        checked += 1
                        if checked >= max_rows:
                            break
            except OSError as exc:
                mismatches.append({
                    "file": path.name, "line": 0,
                    "reason": f"io_error:{exc.__class__.__name__}",
                    "expected": "", "actual": "",
                })
            if checked >= max_rows:
                break
        return {
            "ok": not mismatches,
            "checked": checked,
            "mismatches": mismatches,
            "head": prev,
            "days_back": days_back,
            "files": [p.name for p in files],
        }

    @staticmethod
    def _matches(row: dict, filters: Dict[str, object]) -> bool:
        for k, v in filters.items():
            if v is None or v == "":
                continue
            if k == "path_prefix":
                if not str(row.get("path", "")).startswith(str(v)):
                    return False
            elif k == "path_contains":
                if str(v) not in str(row.get("path", "")):
                    return False
            elif k == "status":
                try:
                    if int(row.get("status", 0)) != int(v):  # type: ignore[arg-type]
                        return False
                except (TypeError, ValueError):
                    return False
            elif k == "status_min":
                try:
                    if int(row.get("status", 0)) < int(v):  # type: ignore[arg-type]
                        return False
                except (TypeError, ValueError):
                    return False
            elif k == "method":
                if str(row.get("method", "")).upper() != str(v).upper():
                    return False
            elif k == "from_ts":
                if str(row.get("ts", "")) < str(v):
                    return False
            elif k == "to_ts":
                if str(row.get("ts", "")) > str(v):
                    return False
            else:
                if str(row.get(k, "")) != str(v):
                    return False
        return True

    def _iter_days(self, days_back: int) -> Iterator[Path]:
        """Yield daily audit files newest-first across ``days_back`` UTC days.

        Bounded by ``days_back`` so an operator cannot accidentally
        scan years of history in a single request. ``days_back`` is
        clamped to a 1..365 window by callers.
        """
        today = datetime.now(timezone.utc).date()
        for delta in range(int(days_back)):
            d = today - timedelta(days=delta)
            p = self.base / f"audit-{d.strftime('%Y-%m-%d')}.jsonl"
            if p.exists():
                yield p

    def iter_search(
        self,
        filters: Optional[Dict[str, object]] = None,
        days_back: int = 7,
        max_rows: int = 100_000,
    ) -> Iterator[dict]:
        """Stream matching audit rows newest-first across daily files.

        Each file is read inside the instance lock to stay consistent
        with ``record`` writes, then released before the next file so a
        long export does not block writers for its full duration.
        ``max_rows`` is a hard cap to keep CSV exports bounded.
        """
        f = filters or {}
        days_back = max(1, min(int(days_back), 365))
        emitted = 0
        for path in self._iter_days(days_back):
            with self._lock:
                try:
                    text = path.read_text(encoding="utf-8")
                except OSError:
                    continue
            # Reverse per-file lines so the overall stream is newest-first.
            for line in reversed(text.splitlines()):
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if self._matches(row, f):
                    yield row
                    emitted += 1
                    if emitted >= max_rows:
                        return

    def search(
        self,
        filters: Optional[Dict[str, object]] = None,
        days_back: int = 7,
        limit: int = 200,
        offset: int = 0,
    ) -> Dict[str, object]:
        """Filtered, paginated audit query.

        Returns ``{"events": [...], "limit", "offset", "days_back",
        "scanned", "has_more"}``. ``scanned`` is the number of matching
        rows considered up to ``offset + limit + 1`` so the UI can show
        a "more available" indicator without a full count scan.
        """
        limit = max(1, min(int(limit), 1000))
        offset = max(0, int(offset))
        events: List[dict] = []
        scanned = 0
        has_more = False
        for row in self.iter_search(filters, days_back=days_back, max_rows=offset + limit + 1):
            if scanned >= offset and len(events) < limit:
                events.append(row)
            elif len(events) >= limit:
                has_more = True
                scanned += 1
                break
            scanned += 1
        return {
            "events": events,
            "limit": limit,
            "offset": offset,
            "days_back": days_back,
            "scanned": scanned,
            "has_more": has_more,
        }

    def iter_csv(
        self,
        filters: Optional[Dict[str, object]] = None,
        days_back: int = 30,
        max_rows: int = 100_000,
    ) -> Iterator[str]:
        """Stream a CSV export of matching rows, header first.

        Yields one CSV-encoded text chunk per row plus a leading header
        row. Uses :mod:`csv` to handle quoting/escaping for free-form
        fields like ``actor_label`` (which may contain commas).
        """
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(self._CSV_FIELDS), extrasaction="ignore")
        writer.writeheader()
        yield buf.getvalue()
        for row in self.iter_search(filters, days_back=days_back, max_rows=max_rows):
            buf.seek(0)
            buf.truncate(0)
            safe = {k: row.get(k, "") for k in self._CSV_FIELDS}
            writer.writerow(safe)
            yield buf.getvalue()

    def prune(self, max_age_days: int, *, now: Optional[datetime] = None) -> List[str]:
        """Delete audit JSONL files older than ``max_age_days`` UTC days.

        Returns the list of removed file paths (absolute) so the caller
        can log a structured event. ``max_age_days <= 0`` is a no-op
        (retention disabled). The cutoff is inclusive: a file dated
        exactly ``today - max_age_days`` is kept; anything strictly
        older is removed.
        """
        if max_age_days is None or int(max_age_days) <= 0:
            return []
        cutoff_date = (now or datetime.now(timezone.utc)).date()
        removed: List[str] = []
        with self._lock:
            for p in sorted(self.base.glob("audit-*.jsonl")):
                stem = p.stem.removeprefix("audit-")
                try:
                    file_date = datetime.strptime(stem, "%Y-%m-%d").date()
                except ValueError:
                    continue
                age = (cutoff_date - file_date).days
                if age > int(max_age_days):
                    try:
                        p.unlink()
                        removed.append(str(p))
                    except OSError:
                        # best-effort; surface via return value being short
                        continue
        return removed


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
        # Lazy import: see top-of-file note on circular import avoidance.
        from ..api.rate_limit import get_registry
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
        # Dry-run flag is set by DryRunMiddleware when ?dry_run=true is
        # honoured. Surface it in the audit row so compliance teams can
        # tell probe traffic apart from real mutations.
        if getattr(request.state, "dry_run", False):
            event.action = "dry_run"
            event.extra["dry_run"] = True
        try:
            self._log.record(event)
        except OSError:
            # never let audit IO break the request path; rate-limit
            # noise by simply dropping. Operators monitor disk fill
            # via the standard infra alerts.
            pass
