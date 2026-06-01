"""Legal hold registry for compliance and eDiscovery.

A *legal hold* is a directive from counsel that data tied to a given
actor must be preserved while the hold is active, overriding the
ordinary GDPR-style deletion and audit retention paths. Enterprise
buyers in regulated industries (financial services, healthcare,
government) require this capability before they will sign a contract:
without it, a routine GDPR/CCPA erasure request can destroy evidence
that a regulator has ordered preserved.

Design choices
--------------
* **Process-wide kill switch.** While *any* hold is active, the audit
  retention pruner skips its sweep entirely and ``/privacy/delete``
  refuses with HTTP 409. This is the conservative interpretation: a
  hold on tenant ``A`` does not stop us erasing tenant ``B``'s data,
  but the audit log itself is a single shared chain, so we cannot
  prune it without risking the hold subject's evidence. Refusing every
  deletion is the simplest defensible posture and matches how
  enterprise vaults behave (Microsoft Purview, Google Vault).
* **Keyed by audit hash.** We store the 12-char ``_hash_key`` digest
  the audit log already uses, never the raw API key. Holds therefore
  compose with the existing tamper-evident chain.
* **Atomic JSON.** A single ``legal-hold.json`` file under
  ``<data_dir>/legal_hold/``. Each placement and release is also
  written to the audit log via the calling endpoint so the chain
  records who held what and when.
"""
from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class LegalHold:
    """A single active legal hold on an audit actor."""

    key_hash: str
    reason: str
    placed_by: str  # actor hash that placed the hold
    placed_at: str = field(default_factory=_utc_now_iso)
    case_id: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class LegalHoldStore:
    """File-backed registry of active legal holds.

    Thread-safe: every mutation takes a lock and rewrites the JSON
    atomically (write to ``.tmp``, then ``rename``) so a crashed
    process cannot leave half-written state.
    """

    FILENAME = "legal-hold.json"

    def __init__(self, base_dir: Path) -> None:
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)
        self._path = self.base / self.FILENAME
        self._lock = threading.Lock()
        self._holds: Dict[str, LegalHold] = {}
        self._load()

    # ------------------------------------------------------------------
    # persistence
    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for row in raw.get("holds") or []:
            try:
                h = LegalHold(
                    key_hash=str(row["key_hash"]),
                    reason=str(row.get("reason", "")),
                    placed_by=str(row.get("placed_by", "")),
                    placed_at=str(row.get("placed_at") or _utc_now_iso()),
                    case_id=str(row.get("case_id") or ""),
                )
            except (KeyError, TypeError):
                continue
            self._holds[h.key_hash] = h

    def _flush(self) -> None:
        payload = {"holds": [h.to_dict() for h in self._holds.values()]}
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self._path)

    # ------------------------------------------------------------------
    # read API
    def list(self) -> List[LegalHold]:
        return list(self._holds.values())

    def get(self, key_hash: str) -> Optional[LegalHold]:
        return self._holds.get(key_hash)

    def any_active(self) -> bool:
        return bool(self._holds)

    # ------------------------------------------------------------------
    # write API
    def place(self, key_hash: str, *, reason: str, placed_by: str,
              case_id: str = "") -> LegalHold:
        key_hash = (key_hash or "").strip().lower()
        reason = (reason or "").strip()
        if not key_hash:
            raise ValueError("key_hash is required")
        if not reason:
            raise ValueError("reason is required")
        with self._lock:
            hold = LegalHold(
                key_hash=key_hash,
                reason=reason,
                placed_by=(placed_by or "").strip(),
                case_id=(case_id or "").strip(),
            )
            self._holds[key_hash] = hold
            self._flush()
        return hold

    def release(self, key_hash: str) -> bool:
        key_hash = (key_hash or "").strip().lower()
        with self._lock:
            if key_hash not in self._holds:
                return False
            del self._holds[key_hash]
            self._flush()
        return True


_singleton: Optional[LegalHoldStore] = None
_singleton_lock = threading.Lock()


def get_legal_hold_store(base_dir: Path) -> LegalHoldStore:
    """Process-wide singleton so the pruner and API share one view."""
    global _singleton
    with _singleton_lock:
        if _singleton is None or _singleton.base != Path(base_dir):
            _singleton = LegalHoldStore(base_dir)
        return _singleton


def reset_legal_hold_store() -> None:
    """Test hook: drop the cached singleton."""
    global _singleton
    with _singleton_lock:
        _singleton = None


__all__ = [
    "LegalHold",
    "LegalHoldStore",
    "get_legal_hold_store",
    "reset_legal_hold_store",
]
