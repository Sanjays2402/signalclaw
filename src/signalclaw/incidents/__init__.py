"""Public incident registry powering ``/status`` and ``/admin/incidents``.

Enterprise procurement reviews and most vendor security questionnaires
(SIG, CAIQ, vendor-managed-risk) explicitly ask whether the supplier
publishes (a) a real-time service status page, (b) a historical
incident log with severities and durations, and (c) post-incident
review (post-mortem) links. Without a versioned, auditable registry
the buyer's TPRM team cannot accept the contract.

Design mirrors :mod:`signalclaw.subprocessors`:

* JSON-backed at ``<data_dir>/incidents.json``, thread-safe.
* Every mutation bumps a monotonic ``version`` and is appended to
  ``incidents.log.jsonl`` with timestamp, actor hash, and full
  before/after snapshots. The change log is replayable for any
  external audit (SOC2 CC7.4, ISO 27035 records).
* Each incident carries a stable id, severity (``sev1``..``sev4``),
  status (``investigating``/``identified``/``monitoring``/``resolved``),
  affected services, a postmortem URL (optional), and an ordered list
  of public updates.
* Public reads are intentionally unauthenticated so prospects and
  customers can fetch the page without a login. Mutations require the
  ``admin`` scope and (in the API layer) MFA, plus they write to the
  global audit chain.
"""
from __future__ import annotations

import json
import re
import secrets
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


MAX_INCIDENTS = 1024
MAX_TITLE = 200
MAX_SUMMARY = 1024
MAX_URL = 512
MAX_SERVICES = 32
MAX_SERVICE_NAME = 64
MAX_UPDATES = 256
MAX_UPDATE_BODY = 2048

SEVERITIES = ("sev1", "sev2", "sev3", "sev4")
STATUSES = ("investigating", "identified", "monitoring", "resolved")

_URL_RE = re.compile(r"^https?://[^\s]+$", re.IGNORECASE)
_SERVICE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_incident_id() -> str:
    # e.g. inc-2026-05-31-a1b2c3
    return "inc-" + datetime.now(timezone.utc).strftime("%Y-%m-%d-") + secrets.token_hex(3)


def _parse_iso(value: str) -> str:
    """Validate an ISO-8601 UTC timestamp and normalise to ``...Z``."""
    if not value:
        raise ValueError("timestamp required")
    v = value.strip()
    # Accept trailing Z or +00:00
    try:
        if v.endswith("Z"):
            dt = datetime.fromisoformat(v[:-1] + "+00:00")
        else:
            dt = datetime.fromisoformat(v)
    except ValueError as exc:
        raise ValueError(f"invalid ISO-8601 timestamp: {value!r}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class IncidentUpdate:
    ts: str
    status: str
    body: str

    def to_public(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Incident:
    id: str
    title: str
    severity: str            # sev1..sev4
    status: str              # investigating/identified/monitoring/resolved
    summary: str
    affected_services: List[str] = field(default_factory=list)
    started_at: str = field(default_factory=_utc_now_iso)
    resolved_at: Optional[str] = None
    postmortem_url: Optional[str] = None
    updates: List[IncidentUpdate] = field(default_factory=list)
    created_at: str = field(default_factory=_utc_now_iso)
    updated_at: str = field(default_factory=_utc_now_iso)

    def to_public(self) -> Dict[str, Any]:
        d = asdict(self)
        d["updates"] = [u for u in d["updates"]]  # already dicts via asdict
        return d


def _validate_services(services: Optional[List[str]]) -> List[str]:
    svcs = [s.strip().lower() for s in (services or []) if (s or "").strip()]
    if len(svcs) > MAX_SERVICES:
        raise ValueError(f"affected_services may contain at most {MAX_SERVICES} entries")
    seen: List[str] = []
    for s in svcs:
        if not _SERVICE_RE.match(s):
            raise ValueError(f"invalid service name: {s!r}")
        if s not in seen:
            seen.append(s)
    return seen


def _validate_core(
    title: str, severity: str, status: str, summary: str,
    affected_services: Optional[List[str]], postmortem_url: Optional[str],
    started_at: Optional[str], resolved_at: Optional[str],
) -> Tuple[str, str, str, str, List[str], Optional[str], str, Optional[str]]:
    title = (title or "").strip()
    severity = (severity or "").strip().lower()
    status = (status or "").strip().lower()
    summary = (summary or "").strip()
    if not title or len(title) > MAX_TITLE:
        raise ValueError(f"title must be 1..{MAX_TITLE} chars")
    if severity not in SEVERITIES:
        raise ValueError(f"severity must be one of {SEVERITIES}")
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}")
    if not summary or len(summary) > MAX_SUMMARY:
        raise ValueError(f"summary must be 1..{MAX_SUMMARY} chars")
    svcs = _validate_services(affected_services)
    pm = (postmortem_url or "").strip() or None
    if pm is not None:
        if len(pm) > MAX_URL or not _URL_RE.match(pm):
            raise ValueError("postmortem_url must be a valid http(s) URL")
    started = _parse_iso(started_at) if started_at else _utc_now_iso()
    resolved: Optional[str] = None
    if resolved_at:
        resolved = _parse_iso(resolved_at)
        if resolved < started:
            raise ValueError("resolved_at must be >= started_at")
    if status == "resolved" and not resolved:
        resolved = _utc_now_iso()
    if status != "resolved":
        resolved = None
    return title, severity, status, summary, svcs, pm, started, resolved


@dataclass
class RegistrySnapshot:
    version: int
    incidents: List[Incident] = field(default_factory=list)
    updated_at: str = field(default_factory=_utc_now_iso)
    updated_by: str = ""

    def to_public(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "updated_at": self.updated_at,
            "incidents": [i.to_public() for i in self.incidents],
        }


def overall_status(incidents: List[Incident]) -> str:
    """Public summary across all currently unresolved incidents.

    Returns one of ``operational``, ``minor``, ``major``, ``critical``.
    """
    worst = None
    rank = {"sev4": 1, "sev3": 2, "sev2": 3, "sev1": 4}
    for inc in incidents:
        if inc.status == "resolved":
            continue
        r = rank.get(inc.severity, 0)
        if worst is None or r > worst:
            worst = r
    if worst is None:
        return "operational"
    if worst == 1:
        return "minor"
    if worst == 2:
        return "minor"
    if worst == 3:
        return "major"
    return "critical"


class IncidentStore:
    """File-backed incident registry with append-only change log."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.log_path = self.path.with_suffix(".log.jsonl")
        self._lock = threading.Lock()
        if not self.path.exists():
            self._write(RegistrySnapshot(version=0))

    # ---- io ----------------------------------------------------------
    def _read(self) -> RegistrySnapshot:
        try:
            raw = json.loads(self.path.read_text() or "{}")
        except json.JSONDecodeError:
            raw = {}
        incidents: List[Incident] = []
        for e in raw.get("incidents", []):
            updates = [IncidentUpdate(**u) for u in e.get("updates", [])]
            data = {k: v for k, v in e.items() if k != "updates"}
            incidents.append(Incident(updates=updates, **data))
        return RegistrySnapshot(
            version=int(raw.get("version", 0)),
            incidents=incidents,
            updated_at=raw.get("updated_at", _utc_now_iso()),
            updated_by=raw.get("updated_by", ""),
        )

    def _write(self, snap: RegistrySnapshot) -> None:
        payload = {
            "version": snap.version,
            "updated_at": snap.updated_at,
            "updated_by": snap.updated_by,
            "incidents": [i.to_public() for i in snap.incidents],
        }
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True))
        tmp.replace(self.path)

    def _append_log(self, action: str, actor: str, before: Optional[Dict[str, Any]],
                    after: Optional[Dict[str, Any]], version: int) -> None:
        rec = {
            "ts": _utc_now_iso(),
            "version": version,
            "action": action,
            "actor": actor,
            "before": before,
            "after": after,
        }
        with self.log_path.open("a") as fh:
            fh.write(json.dumps(rec, sort_keys=True) + "\n")

    # ---- reads -------------------------------------------------------
    def snapshot(self) -> RegistrySnapshot:
        with self._lock:
            return self._read()

    def public_view(self, limit: int = 50) -> Dict[str, Any]:
        """Sorted public payload: newest first, capped, with summary."""
        limit = max(1, min(int(limit or 50), 500))
        snap = self.snapshot()
        incidents = sorted(snap.incidents, key=lambda i: i.started_at, reverse=True)
        return {
            "version": snap.version,
            "updated_at": snap.updated_at,
            "overall_status": overall_status(snap.incidents),
            "open_count": sum(1 for i in snap.incidents if i.status != "resolved"),
            "incidents": [i.to_public() for i in incidents[:limit]],
        }

    def history(self, limit: int = 100) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 2000))
        if not self.log_path.exists():
            return []
        out: List[Dict[str, Any]] = []
        with self.log_path.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return list(reversed(out))[:limit]

    def get(self, incident_id: str) -> Optional[Incident]:
        snap = self.snapshot()
        for i in snap.incidents:
            if i.id == incident_id:
                return i
        return None

    # ---- mutations ---------------------------------------------------
    def add(self, *, title: str, severity: str, status: str, summary: str,
            affected_services: Optional[List[str]] = None,
            postmortem_url: Optional[str] = None,
            started_at: Optional[str] = None,
            resolved_at: Optional[str] = None,
            actor: str = "") -> Incident:
        t, sev, st, sm, svcs, pm, started, resolved = _validate_core(
            title, severity, status, summary, affected_services,
            postmortem_url, started_at, resolved_at,
        )
        with self._lock:
            snap = self._read()
            if len(snap.incidents) >= MAX_INCIDENTS:
                raise ValueError(f"registry full (max {MAX_INCIDENTS} incidents)")
            incident_id = _new_incident_id()
            # ensure uniqueness (collision extremely unlikely)
            while any(i.id == incident_id for i in snap.incidents):
                incident_id = _new_incident_id()
            initial_update = IncidentUpdate(ts=_utc_now_iso(), status=st, body=sm)
            inc = Incident(
                id=incident_id, title=t, severity=sev, status=st, summary=sm,
                affected_services=svcs, started_at=started, resolved_at=resolved,
                postmortem_url=pm, updates=[initial_update],
            )
            new_entries = snap.incidents + [inc]
            new_snap = RegistrySnapshot(
                version=snap.version + 1, incidents=new_entries,
                updated_at=_utc_now_iso(), updated_by=actor,
            )
            self._write(new_snap)
            self._append_log("add", actor, None, inc.to_public(), new_snap.version)
            return inc

    def update(self, incident_id: str, *,
               title: Optional[str] = None,
               severity: Optional[str] = None,
               status: Optional[str] = None,
               summary: Optional[str] = None,
               affected_services: Optional[List[str]] = None,
               postmortem_url: Optional[str] = None,
               started_at: Optional[str] = None,
               resolved_at: Optional[str] = None,
               actor: str = "") -> Incident:
        with self._lock:
            snap = self._read()
            existing = next((i for i in snap.incidents if i.id == incident_id), None)
            if existing is None:
                raise KeyError(incident_id)
            new_title = title if title is not None else existing.title
            new_sev = severity if severity is not None else existing.severity
            new_status = status if status is not None else existing.status
            new_summary = summary if summary is not None else existing.summary
            new_svcs = affected_services if affected_services is not None else list(existing.affected_services)
            new_pm = postmortem_url if postmortem_url is not None else existing.postmortem_url
            new_started = started_at if started_at is not None else existing.started_at
            new_resolved = resolved_at if resolved_at is not None else existing.resolved_at
            t, sev, st, sm, svcs, pm, started, resolved = _validate_core(
                new_title, new_sev, new_status, new_summary, new_svcs,
                new_pm, new_started, new_resolved,
            )
            before = existing.to_public()
            updated_inc = Incident(
                id=existing.id, title=t, severity=sev, status=st, summary=sm,
                affected_services=svcs, started_at=started, resolved_at=resolved,
                postmortem_url=pm, updates=list(existing.updates),
                created_at=existing.created_at, updated_at=_utc_now_iso(),
            )
            new_entries = [updated_inc if i.id == incident_id else i for i in snap.incidents]
            new_snap = RegistrySnapshot(
                version=snap.version + 1, incidents=new_entries,
                updated_at=_utc_now_iso(), updated_by=actor,
            )
            self._write(new_snap)
            self._append_log("update", actor, before, updated_inc.to_public(), new_snap.version)
            return updated_inc

    def add_update(self, incident_id: str, *, status: str, body: str,
                   actor: str = "") -> Incident:
        st = (status or "").strip().lower()
        body = (body or "").strip()
        if st not in STATUSES:
            raise ValueError(f"status must be one of {STATUSES}")
        if not body or len(body) > MAX_UPDATE_BODY:
            raise ValueError(f"body must be 1..{MAX_UPDATE_BODY} chars")
        with self._lock:
            snap = self._read()
            existing = next((i for i in snap.incidents if i.id == incident_id), None)
            if existing is None:
                raise KeyError(incident_id)
            if len(existing.updates) >= MAX_UPDATES:
                raise ValueError(f"incident has reached the {MAX_UPDATES}-update cap")
            before = existing.to_public()
            new_update = IncidentUpdate(ts=_utc_now_iso(), status=st, body=body)
            new_updates = list(existing.updates) + [new_update]
            resolved_at = existing.resolved_at
            if st == "resolved" and not resolved_at:
                resolved_at = _utc_now_iso()
            if st != "resolved":
                resolved_at = None if existing.status != "resolved" else existing.resolved_at
            updated_inc = Incident(
                id=existing.id, title=existing.title, severity=existing.severity,
                status=st, summary=existing.summary,
                affected_services=list(existing.affected_services),
                started_at=existing.started_at, resolved_at=resolved_at,
                postmortem_url=existing.postmortem_url, updates=new_updates,
                created_at=existing.created_at, updated_at=_utc_now_iso(),
            )
            new_entries = [updated_inc if i.id == incident_id else i for i in snap.incidents]
            new_snap = RegistrySnapshot(
                version=snap.version + 1, incidents=new_entries,
                updated_at=_utc_now_iso(), updated_by=actor,
            )
            self._write(new_snap)
            self._append_log("update.append", actor, before, updated_inc.to_public(), new_snap.version)
            return updated_inc

    def remove(self, incident_id: str, *, actor: str = "") -> Incident:
        with self._lock:
            snap = self._read()
            existing = next((i for i in snap.incidents if i.id == incident_id), None)
            if existing is None:
                raise KeyError(incident_id)
            new_entries = [i for i in snap.incidents if i.id != incident_id]
            new_snap = RegistrySnapshot(
                version=snap.version + 1, incidents=new_entries,
                updated_at=_utc_now_iso(), updated_by=actor,
            )
            self._write(new_snap)
            self._append_log("remove", actor, existing.to_public(), None, new_snap.version)
            return existing


_singleton_lock = threading.Lock()
_singleton: Optional[IncidentStore] = None
_singleton_path: Optional[Path] = None


def get_store(path: Optional[Path] = None) -> IncidentStore:
    """Process-wide singleton, rebuilt when the path changes (tests)."""
    global _singleton, _singleton_path
    with _singleton_lock:
        if path is None:
            if _singleton is not None:
                return _singleton
            raise RuntimeError("incident store not initialised")
        if _singleton is None or _singleton_path != path:
            _singleton = IncidentStore(path)
            _singleton_path = path
        return _singleton


def reset_store() -> None:
    """Test hook."""
    global _singleton, _singleton_path
    with _singleton_lock:
        _singleton = None
        _singleton_path = None


__all__ = [
    "Incident", "IncidentUpdate", "RegistrySnapshot", "IncidentStore",
    "get_store", "reset_store", "overall_status",
    "SEVERITIES", "STATUSES",
    "MAX_INCIDENTS", "MAX_TITLE", "MAX_SUMMARY", "MAX_URL",
    "MAX_SERVICES", "MAX_UPDATES", "MAX_UPDATE_BODY",
]
