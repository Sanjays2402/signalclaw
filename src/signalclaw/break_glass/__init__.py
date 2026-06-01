"""Break-glass admin elevation.

Time-boxed emergency admin grants for non-admin API keys.

Procurement reality: SOC2 CC6.1 and ISO 27001 A.9.2.3 both require a
documented, audited, time-bound process for granting emergency elevated
access (so an on-call engineer can fix a paging outage at 03:00 without
the operator having to hand out a permanent admin key, and so the
auditor can see every minute of that elevated access after the fact).

A break-glass grant is a row keyed by the hashed fingerprint of the
target API key. While a live (unexpired, unrevoked) grant exists,
``_resolve_key`` unions ``{"admin"}`` into the caller's effective
scopes for the duration of the grant only. The underlying RBAC role on
the key is never mutated, so when the grant expires the caller drops
back to their normal scopes automatically with no rotation needed.

Every grant is bounded:
  * ``ttl_seconds`` is clamped to ``MAX_TTL_SECONDS`` (4h) so a forgotten
    grant cannot become a permanent backdoor.
  * ``reason`` is required and trimmed to 512 chars so the audit trail
    always has a justification.
  * Issuing, revoking, and *using* a grant are all recorded in the
    global audit log by the API layer, plus the grant store keeps its
    own ``used_count`` and ``last_used_at`` so the SOC2 evidence path
    can prove the window was actually exercised.
"""
from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Dict, List, Optional


MAX_TTL_SECONDS = 4 * 60 * 60  # 4 hours
MIN_TTL_SECONDS = 60  # 1 minute
MAX_REASON_LEN = 512
HISTORY_CAP = 500


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def hash_key(secret: str) -> str:
    """Stable hash of an API-key secret used as the grant target id."""
    return sha256(secret.encode("utf-8")).hexdigest()[:16]


@dataclass
class Grant:
    id: str
    target_key_hash: str
    target_label: str
    reason: str
    granted_at: str
    expires_at: str
    granted_by_hash: str
    revoked_at: Optional[str] = None
    revoked_by_hash: Optional[str] = None
    used_count: int = 0
    last_used_at: Optional[str] = None

    def is_live(self, now: Optional[datetime] = None) -> bool:
        if self.revoked_at is not None:
            return False
        n = now or _now()
        try:
            return _parse(self.expires_at) > n
        except Exception:
            return False

    def status(self, now: Optional[datetime] = None) -> str:
        if self.revoked_at is not None:
            return "revoked"
        n = now or _now()
        try:
            exp = _parse(self.expires_at)
        except Exception:
            return "expired"
        return "active" if exp > n else "expired"

    def remaining_seconds(self, now: Optional[datetime] = None) -> int:
        if self.revoked_at is not None:
            return 0
        n = now or _now()
        try:
            exp = _parse(self.expires_at)
        except Exception:
            return 0
        return max(0, int((exp - n).total_seconds()))

    def to_public(self, now: Optional[datetime] = None) -> Dict[str, object]:
        d = asdict(self)
        d["status"] = self.status(now)
        d["remaining_seconds"] = self.remaining_seconds(now)
        return d


class BreakGlassStore:
    """File-backed grant store.

    Persistence model mirrors ``sessions.revocation``: one JSON file
    written under a per-store lock, no separate database. Records are
    not auto-purged because the auditor specifically wants to see
    expired and revoked grants in the history view.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> List[Grant]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        out: List[Grant] = []
        for row in raw:
            try:
                out.append(Grant(**row))
            except TypeError:
                continue
        return out

    def _write(self, rows: List[Grant]) -> None:
        # Cap history to keep file bounded.
        if len(rows) > HISTORY_CAP:
            rows = rows[-HISTORY_CAP:]
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps([asdict(r) for r in rows], indent=2),
                       encoding="utf-8")
        tmp.replace(self.path)

    # --- mutation -----------------------------------------------------

    def grant(self, *, target_key_hash: str, target_label: str,
              reason: str, ttl_seconds: int,
              granted_by_hash: str,
              now: Optional[datetime] = None) -> Grant:
        target_key_hash = (target_key_hash or "").strip().lower()
        if not target_key_hash:
            raise ValueError("target_key_hash is required")
        reason = (reason or "").strip()
        if not reason:
            raise ValueError("reason is required")
        if len(reason) > MAX_REASON_LEN:
            raise ValueError(
                f"reason must be <= {MAX_REASON_LEN} chars")
        try:
            ttl = int(ttl_seconds)
        except (TypeError, ValueError):
            raise ValueError("ttl_seconds must be an integer")
        if ttl < MIN_TTL_SECONDS or ttl > MAX_TTL_SECONDS:
            raise ValueError(
                f"ttl_seconds must be between {MIN_TTL_SECONDS} "
                f"and {MAX_TTL_SECONDS}")
        n = now or _now()
        gid = sha256(
            f"{target_key_hash}:{_iso(n)}:{reason}".encode("utf-8")
        ).hexdigest()[:16]
        g = Grant(
            id=gid,
            target_key_hash=target_key_hash,
            target_label=(target_label or "").strip()[:64],
            reason=reason,
            granted_at=_iso(n),
            expires_at=_iso(n + timedelta(seconds=ttl)),
            granted_by_hash=(granted_by_hash or "-").strip().lower(),
        )
        with self._lock:
            rows = self._read()
            rows.append(g)
            self._write(rows)
        return g

    def revoke(self, grant_id: str, *, revoked_by_hash: str,
               now: Optional[datetime] = None) -> Optional[Grant]:
        n = now or _now()
        with self._lock:
            rows = self._read()
            for i, r in enumerate(rows):
                if r.id == grant_id:
                    if r.revoked_at is not None:
                        return r
                    r.revoked_at = _iso(n)
                    r.revoked_by_hash = (revoked_by_hash or "-").strip().lower()
                    rows[i] = r
                    self._write(rows)
                    return r
        return None

    def record_use(self, target_key_hash: str,
                   now: Optional[datetime] = None) -> Optional[Grant]:
        """Bump used_count + last_used_at on the live grant, if any."""
        n = now or _now()
        with self._lock:
            rows = self._read()
            live: Optional[int] = None
            for i, r in enumerate(rows):
                if (r.target_key_hash == target_key_hash
                        and r.is_live(n)):
                    live = i
                    break
            if live is None:
                return None
            r = rows[live]
            r.used_count = int(r.used_count or 0) + 1
            r.last_used_at = _iso(n)
            rows[live] = r
            self._write(rows)
            return r

    # --- query --------------------------------------------------------

    def live_for(self, target_key_hash: str,
                 now: Optional[datetime] = None) -> Optional[Grant]:
        if not target_key_hash:
            return None
        target_key_hash = target_key_hash.strip().lower()
        n = now or _now()
        rows = self._read()
        # newest first so a freshly issued grant wins.
        for r in reversed(rows):
            if r.target_key_hash == target_key_hash and r.is_live(n):
                return r
        return None

    def list_grants(self, *, include_inactive: bool = True,
                    now: Optional[datetime] = None) -> List[Grant]:
        n = now or _now()
        rows = self._read()
        if not include_inactive:
            rows = [r for r in rows if r.is_live(n)]
        # newest first
        rows.sort(key=lambda r: r.granted_at, reverse=True)
        return rows

    def get(self, grant_id: str) -> Optional[Grant]:
        for r in self._read():
            if r.id == grant_id:
                return r
        return None


# Module-level singleton, mirroring the other stores. Tests reset it
# via ``reset_store`` after pointing DATA_DIR at a tmp_path.

_STORE: Optional[BreakGlassStore] = None
_STORE_PATH: Optional[Path] = None


def get_store(path: Optional[Path] = None) -> BreakGlassStore:
    global _STORE, _STORE_PATH
    if path is not None and (
        _STORE is None or _STORE_PATH != Path(path)
    ):
        _STORE = BreakGlassStore(Path(path))
        _STORE_PATH = Path(path)
        return _STORE
    if _STORE is None:
        # Lazy default for callers that did not pass a path; the app
        # factory always passes one so this only fires in tests that
        # introspect the helpers directly.
        default = Path("data/break_glass.json")
        _STORE = BreakGlassStore(default)
        _STORE_PATH = default
    return _STORE


def reset_store() -> None:
    global _STORE, _STORE_PATH
    _STORE = None
    _STORE_PATH = None


__all__ = [
    "BreakGlassStore",
    "Grant",
    "MAX_TTL_SECONDS",
    "MIN_TTL_SECONDS",
    "MAX_REASON_LEN",
    "hash_key",
    "get_store",
    "reset_store",
]
