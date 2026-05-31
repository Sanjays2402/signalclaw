"""User-managed API key store with persistent JSON backing.

This complements the env-based ``ApiKeyRegistry`` in
``signalclaw.api.rate_limit`` by letting users mint and revoke their
own keys through the dashboard without redeploying.

Keys are stored as a SHA-256 hash of the secret, never the secret
itself. The full secret is returned exactly once at creation time so
the UI can show it and then forget it.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set


_PREFIX = "sck_"  # signalclaw key
_SECRET_BYTES = 24  # 32 chars of url-safe b64


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _mint() -> str:
    return _PREFIX + secrets.token_urlsafe(_SECRET_BYTES)


@dataclass
class StoredKey:
    id: str
    label: str
    hash: str
    prefix: str  # first 12 chars of the secret for display
    scopes: List[str]
    created_at: str
    last_used_at: Optional[str] = None
    revoked: bool = False

    def to_public(self) -> Dict:
        d = asdict(self)
        d.pop("hash")
        return d


class ApiKeyStore:
    """JSON-backed persistent key store. Thread-safe."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"keys": []}, indent=2))
        # in-memory index from hash -> StoredKey for O(1) lookup on each request
        self._index: Dict[str, StoredKey] = {}
        self._reload_index()

    def _reload_index(self) -> None:
        rows = self._read()
        self._index = {r.hash: r for r in rows if not r.revoked}

    def _read(self) -> List[StoredKey]:
        raw = json.loads(self.path.read_text() or '{"keys":[]}')
        out: List[StoredKey] = []
        for r in raw.get("keys", []):
            out.append(StoredKey(
                id=r["id"],
                label=r.get("label", ""),
                hash=r["hash"],
                prefix=r.get("prefix", ""),
                scopes=list(r.get("scopes", ["read"])),
                created_at=r.get("created_at", _now_iso()),
                last_used_at=r.get("last_used_at"),
                revoked=bool(r.get("revoked", False)),
            ))
        return out

    def _write(self, rows: List[StoredKey]) -> None:
        self.path.write_text(json.dumps(
            {"keys": [asdict(r) for r in rows]}, indent=2, sort_keys=True))

    def list(self) -> List[StoredKey]:
        return self._read()

    def create(self, label: str, scopes: Optional[List[str]] = None) -> tuple[StoredKey, str]:
        """Mint a new key. Returns (record, full_secret).

        The full secret is only returned here. Callers must surface it
        to the user immediately and never log it.
        """
        label = (label or "").strip()[:80] or "unnamed"
        scope_set: Set[str] = set(scopes or ["read"])
        # never let users grant themselves admin via this surface
        scope_set.discard("admin")
        if not scope_set:
            scope_set = {"read"}
        secret = _mint()
        rec = StoredKey(
            id=secrets.token_hex(8),
            label=label,
            hash=_hash(secret),
            prefix=secret[:12],
            scopes=sorted(scope_set),
            created_at=_now_iso(),
        )
        with self._lock:
            rows = self._read()
            rows.append(rec)
            self._write(rows)
            self._reload_index()
        return rec, secret

    def revoke(self, key_id: str) -> bool:
        with self._lock:
            rows = self._read()
            found = False
            for r in rows:
                if r.id == key_id and not r.revoked:
                    r.revoked = True
                    found = True
                    break
            if found:
                self._write(rows)
                self._reload_index()
            return found

    def lookup(self, secret: str) -> Optional[StoredKey]:
        """Resolve a raw secret to a stored key (or None)."""
        if not secret:
            return None
        h = _hash(secret)
        rec = self._index.get(h)
        if rec is None:
            # cache miss may mean a key created in another process; reload once
            with self._lock:
                self._reload_index()
            rec = self._index.get(h)
        if rec is None or rec.revoked:
            return None
        # record last_used_at lazily; only persist when it advances by >60s
        try:
            now = _now_iso()
            last = rec.last_used_at or ""
            if not last or last < now:
                rec.last_used_at = now
                with self._lock:
                    rows = self._read()
                    for r in rows:
                        if r.id == rec.id:
                            r.last_used_at = now
                            break
                    self._write(rows)
        except Exception:  # pragma: no cover - never block auth on bookkeeping
            pass
        return rec


__all__ = ["ApiKeyStore", "StoredKey"]
