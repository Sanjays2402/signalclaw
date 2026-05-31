"""Active API key sessions.

A "session" here is a (key_id, source_ip, user_agent) tuple that has
been seen recently. It is not a browser cookie; SignalClaw is API-key
authenticated. The session record exists so that an operator can:

* See which keys are actively in use, from which IPs, with which
  clients, and when they were last seen.
* Force-revoke a key from one place (admin console) rather than hunting
  through the key store.
* Spot a stolen key that is being used from an unexpected IP or UA.

Persistence is a single JSON file written through a per-store lock,
matching the rest of the codebase. Records older than ``ttl_seconds``
are pruned on every list / touch call so the file stays bounded.
"""
from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Dict, List, Optional


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse(s: str) -> datetime:
    # tolerate both "...Z" and offset-bearing strings
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def _fingerprint(key_id: str, ip: str, user_agent: str) -> str:
    raw = f"{key_id}|{ip}|{user_agent}".encode("utf-8")
    return sha256(raw).hexdigest()[:16]


@dataclass
class Session:
    id: str
    key_id: str
    key_label: str
    source_ip: str
    user_agent: str
    first_seen: str
    last_seen: str
    request_count: int = 0

    def to_public(self) -> Dict:
        return asdict(self)


class SessionStore:
    """JSON-backed active-session ledger. Thread-safe."""

    def __init__(self, path: Path, ttl_seconds: int = 60 * 60 * 24 * 14) -> None:
        # 14d default: long enough that an integration that runs daily
        # is still "active"; short enough that abandoned terminals drop
        # off without manual cleanup.
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._ttl = int(ttl_seconds)
        if not self.path.exists():
            self.path.write_text(json.dumps({"sessions": []}, indent=2))

    # --- io ---------------------------------------------------------------
    def _read(self) -> List[Session]:
        try:
            raw = json.loads(self.path.read_text() or '{"sessions": []}')
        except json.JSONDecodeError:
            return []
        out: List[Session] = []
        for row in raw.get("sessions", []):
            try:
                out.append(Session(**row))
            except TypeError:
                # tolerate older rows missing a field
                row.setdefault("request_count", 0)
                row.setdefault("key_label", "")
                try:
                    out.append(Session(**row))
                except TypeError:
                    continue
        return out

    def _write(self, rows: List[Session]) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(
            {"sessions": [asdict(r) for r in rows]}, indent=2, sort_keys=True))
        tmp.replace(self.path)

    def _prune(self, rows: List[Session]) -> List[Session]:
        cutoff = _now() - timedelta(seconds=self._ttl)
        kept: List[Session] = []
        for r in rows:
            try:
                if _parse(r.last_seen) >= cutoff:
                    kept.append(r)
            except ValueError:
                # unparsable timestamps drop on the floor
                continue
        return kept

    # --- public api -------------------------------------------------------
    def touch(
        self,
        *,
        key_id: str,
        key_label: str,
        source_ip: str,
        user_agent: str,
    ) -> Session:
        """Record a hit from a (key, ip, ua) tuple.

        Creates the session row on first sight, updates ``last_seen``
        and ``request_count`` on subsequent hits. Returns the live
        record. Safe to call on every authenticated request.
        """
        if not key_id:
            # never index unauthenticated traffic in the session store;
            # that is what the per-IP rate limiter is for.
            return Session(
                id="", key_id="", key_label="", source_ip=source_ip,
                user_agent=user_agent,
                first_seen=_iso(_now()), last_seen=_iso(_now()),
                request_count=0,
            )
        sid = _fingerprint(key_id, source_ip, user_agent or "")
        now_iso = _iso(_now())
        with self._lock:
            rows = self._prune(self._read())
            found: Optional[Session] = None
            for r in rows:
                if r.id == sid:
                    found = r
                    break
            if found is None:
                found = Session(
                    id=sid,
                    key_id=key_id,
                    key_label=key_label or "",
                    source_ip=source_ip,
                    user_agent=user_agent or "",
                    first_seen=now_iso,
                    last_seen=now_iso,
                    request_count=1,
                )
                rows.append(found)
            else:
                found.last_seen = now_iso
                found.request_count += 1
                # label may have been edited on the key; keep the row
                # current so the admin view does not lie.
                if key_label and key_label != found.key_label:
                    found.key_label = key_label
            self._write(rows)
            return found

    def list(self) -> List[Session]:
        with self._lock:
            rows = self._prune(self._read())
            # persist the pruned view so we never return stale rows
            self._write(rows)
            # newest activity first
            rows.sort(key=lambda r: r.last_seen, reverse=True)
            return rows

    def revoke(self, session_id: str) -> bool:
        with self._lock:
            rows = self._read()
            kept = [r for r in rows if r.id != session_id]
            if len(kept) == len(rows):
                return False
            self._write(kept)
            return True

    def revoke_for_key(self, key_id: str) -> int:
        with self._lock:
            rows = self._read()
            kept = [r for r in rows if r.key_id != key_id]
            removed = len(rows) - len(kept)
            if removed:
                self._write(kept)
            return removed

    def revoke_all(self) -> int:
        with self._lock:
            rows = self._read()
            n = len(rows)
            self._write([])
            return n
