"""Session revocation store.

A revoked session is a (key_id, source_ip, user_agent) fingerprint that
the operator has explicitly force-logged-out. Future requests carrying
the same fingerprint are rejected with HTTP 401 *before* the request
reaches the application, even though the underlying API key is still
valid and the session ledger row gets recreated on first contact.

Without this layer the "Revoke session" button in the admin console is
theatre: removing a row from the session ledger only clears the audit
view; the same client immediately re-registers itself on its next call.
Enterprise procurement reviewers test for exactly this gap.

Persistence model mirrors the rest of the codebase: a single JSON file
written under a per-store lock. Records expire after ``ttl_seconds`` so
the file stays bounded and a long-lived block does not outlive the
underlying key rotation.
"""
from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Dict, List, Optional


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def fingerprint(key_id: str, ip: str, user_agent: str) -> str:
    """Stable 16-hex id for a (key_id, ip, ua) tuple.

    Mirrors :func:`signalclaw.sessions._fingerprint` so a revocation
    written here matches the session id surfaced by ``GET
    /admin/sessions``.
    """
    raw = f"{key_id}|{ip}|{user_agent or ''}".encode("utf-8")
    return sha256(raw).hexdigest()[:16]


@dataclass
class Revocation:
    # Matches Session.id so the admin "revoke" button is one-to-one
    # with the row the operator was looking at.
    session_id: str
    key_id: str
    reason: str
    revoked_at: str
    expires_at: str
    revoked_by: str = ""
    # When scope == "key" the row blocks every session for that key,
    # regardless of session_id. When scope == "session" only the exact
    # fingerprint is blocked.
    scope: str = "session"


class RevocationStore:
    """JSON-backed force-logout ledger. Thread-safe."""

    DEFAULT_TTL = 60 * 60 * 24 * 30  # 30d

    def __init__(self, path: Path, ttl_seconds: int = DEFAULT_TTL) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._ttl = int(ttl_seconds)
        if not self.path.exists():
            self.path.write_text(json.dumps({"revocations": []}, indent=2))

    # --- io ---------------------------------------------------------------
    def _read(self) -> List[Revocation]:
        try:
            raw = json.loads(self.path.read_text() or '{"revocations": []}')
        except json.JSONDecodeError:
            return []
        out: List[Revocation] = []
        for row in raw.get("revocations", []):
            try:
                out.append(Revocation(**row))
            except TypeError:
                # tolerate older / partial rows
                row.setdefault("revoked_by", "")
                row.setdefault("scope", "session")
                try:
                    out.append(Revocation(**row))
                except TypeError:
                    continue
        return out

    def _write(self, rows: List[Revocation]) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(
            {"revocations": [asdict(r) for r in rows]},
            indent=2, sort_keys=True))
        tmp.replace(self.path)

    def _prune(self, rows: List[Revocation]) -> List[Revocation]:
        now = _now()
        kept: List[Revocation] = []
        for r in rows:
            try:
                if _parse(r.expires_at) > now:
                    kept.append(r)
            except ValueError:
                continue
        return kept

    # --- public api -------------------------------------------------------
    def revoke_session(
        self,
        *,
        session_id: str,
        key_id: str,
        reason: str = "admin_revoke",
        revoked_by: str = "",
        ttl_seconds: Optional[int] = None,
    ) -> Revocation:
        ttl = int(ttl_seconds if ttl_seconds is not None else self._ttl)
        now = _now()
        rec = Revocation(
            session_id=session_id,
            key_id=key_id,
            reason=reason,
            revoked_at=_iso(now),
            expires_at=_iso(now + timedelta(seconds=ttl)),
            revoked_by=revoked_by,
            scope="session",
        )
        with self._lock:
            rows = self._prune(self._read())
            rows = [r for r in rows
                    if not (r.scope == "session"
                            and r.session_id == session_id)]
            rows.append(rec)
            self._write(rows)
        return rec

    def revoke_key(
        self,
        *,
        key_id: str,
        reason: str = "admin_revoke_key",
        revoked_by: str = "",
        ttl_seconds: Optional[int] = None,
    ) -> Revocation:
        ttl = int(ttl_seconds if ttl_seconds is not None else self._ttl)
        now = _now()
        rec = Revocation(
            session_id="*",
            key_id=key_id,
            reason=reason,
            revoked_at=_iso(now),
            expires_at=_iso(now + timedelta(seconds=ttl)),
            revoked_by=revoked_by,
            scope="key",
        )
        with self._lock:
            rows = self._prune(self._read())
            # collapse: one active key-scope row per key
            rows = [r for r in rows
                    if not (r.scope == "key" and r.key_id == key_id)]
            rows.append(rec)
            self._write(rows)
        return rec

    def is_revoked(self, *, session_id: str, key_id: str) -> Optional[Revocation]:
        """Return the active revocation for this (session_id, key_id),
        or ``None`` if the request should be allowed through.
        """
        with self._lock:
            rows = self._prune(self._read())
            # write back the pruned view so expired rows do not
            # accumulate on disk forever
            self._write(rows)
            for r in rows:
                if r.scope == "key" and r.key_id == key_id:
                    return r
                if r.scope == "session" and r.session_id == session_id:
                    return r
        return None

    def list(self) -> List[Revocation]:
        with self._lock:
            rows = self._prune(self._read())
            self._write(rows)
            rows.sort(key=lambda r: r.revoked_at, reverse=True)
            return rows

    def clear_session(self, session_id: str) -> bool:
        """Lift a previously placed session-scope revocation."""
        with self._lock:
            rows = self._read()
            kept = [r for r in rows
                    if not (r.scope == "session"
                            and r.session_id == session_id)]
            if len(kept) == len(rows):
                return False
            self._write(kept)
            return True

    def clear_key(self, key_id: str) -> bool:
        """Lift a previously placed key-scope revocation."""
        with self._lock:
            rows = self._read()
            kept = [r for r in rows
                    if not (r.scope == "key" and r.key_id == key_id)]
            if len(kept) == len(rows):
                return False
            self._write(kept)
            return True

    def stats(self) -> Dict[str, int]:
        rows = self.list()
        return {
            "active": len(rows),
            "session_scope": sum(1 for r in rows if r.scope == "session"),
            "key_scope": sum(1 for r in rows if r.scope == "key"),
        }
