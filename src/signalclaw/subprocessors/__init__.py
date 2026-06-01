"""Subprocessor registry powering the public Trust Center.

Enterprise procurement reviews (and GDPR Art. 28 Data Processing
Addenda) require the data controller to maintain a current public
list of all third-party data processors ("subprocessors") used to
deliver the service, along with at least 30 days' notice of any
material change. Without a versioned, queryable, audit-logged
registry, customers cannot accept the DPA and the deal stalls.

This module is the single source of truth.

Design:

* JSON-backed at ``<data_dir>/subprocessors.json``. Thread-safe.
* Each registry mutation (add / update / remove) bumps a monotonic
  ``version`` integer and is appended to ``subprocessors.log.jsonl``
  with a unix timestamp, actor hash, and full before/after snapshots.
  The change-log feeds the public ``/trust/subprocessors/history``
  endpoint so customers can audit notice periods externally.
* Entries are validated: name and purpose required, URL must be
  ``http(s)://``, country is an ISO-3166 alpha-2 (2 letters), and
  the entry id is a stable URL slug derived from the name.
* Public read is intentionally unauthenticated. Mutations require
  the ``admin`` scope and (in the API layer) MFA.
"""
from __future__ import annotations

import json
import re
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


MAX_ENTRIES = 256
MAX_NAME = 128
MAX_PURPOSE = 512
MAX_URL = 512
_SLUG_RE = re.compile(r"[^a-z0-9]+")
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
_URL_RE = re.compile(r"^https?://[^\s]+$", re.IGNORECASE)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slugify(name: str) -> str:
    """Stable URL-safe id derived from the display name."""
    s = _SLUG_RE.sub("-", (name or "").strip().lower()).strip("-")
    if not s:
        raise ValueError("name must contain at least one alphanumeric character")
    return s[:64]


@dataclass
class Subprocessor:
    id: str
    name: str
    purpose: str          # one-line description of what data they touch
    country: str          # ISO-3166 alpha-2, uppercase
    url: str              # vendor privacy / security page
    data_categories: List[str] = field(default_factory=list)  # e.g. ["email", "telemetry"]
    added_at: str = field(default_factory=_utc_now_iso)
    updated_at: str = field(default_factory=_utc_now_iso)

    def to_public(self) -> Dict[str, Any]:
        return asdict(self)


def _validate(name: str, purpose: str, country: str, url: str,
              data_categories: Optional[List[str]]) -> Tuple[str, str, str, str, List[str]]:
    name = (name or "").strip()
    purpose = (purpose or "").strip()
    country = (country or "").strip().upper()
    url = (url or "").strip()
    cats = [c.strip() for c in (data_categories or []) if (c or "").strip()]
    if not name or len(name) > MAX_NAME:
        raise ValueError(f"name must be 1..{MAX_NAME} chars")
    if not purpose or len(purpose) > MAX_PURPOSE:
        raise ValueError(f"purpose must be 1..{MAX_PURPOSE} chars")
    if not _COUNTRY_RE.match(country):
        raise ValueError("country must be ISO-3166 alpha-2 (e.g. 'US')")
    if not url or len(url) > MAX_URL or not _URL_RE.match(url):
        raise ValueError("url must be a valid http(s) URL")
    if len(cats) > 32:
        raise ValueError("data_categories may contain at most 32 entries")
    for c in cats:
        if len(c) > 64:
            raise ValueError("each data_category must be <= 64 chars")
    return name, purpose, country, url, cats


@dataclass
class RegistrySnapshot:
    version: int
    entries: List[Subprocessor] = field(default_factory=list)
    updated_at: str = field(default_factory=_utc_now_iso)
    updated_by: str = ""

    def to_public(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "updated_at": self.updated_at,
            "entries": [e.to_public() for e in self.entries],
        }


class SubprocessorStore:
    """File-backed subprocessor registry with append-only change log."""

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
        entries = [Subprocessor(**e) for e in raw.get("entries", [])]
        return RegistrySnapshot(
            version=int(raw.get("version", 0)),
            entries=entries,
            updated_at=raw.get("updated_at", _utc_now_iso()),
            updated_by=raw.get("updated_by", ""),
        )

    def _write(self, snap: RegistrySnapshot) -> None:
        payload = {
            "version": snap.version,
            "updated_at": snap.updated_at,
            "updated_by": snap.updated_by,
            "entries": [e.to_public() for e in snap.entries],
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

    def history(self, limit: int = 100) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 1000))
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
        # newest first, bounded
        return list(reversed(out))[:limit]

    def get(self, entry_id: str) -> Optional[Subprocessor]:
        snap = self.snapshot()
        for e in snap.entries:
            if e.id == entry_id:
                return e
        return None

    # ---- mutations ---------------------------------------------------
    def add(self, *, name: str, purpose: str, country: str, url: str,
            data_categories: Optional[List[str]] = None,
            actor: str = "") -> Subprocessor:
        name, purpose, country, url, cats = _validate(name, purpose, country, url, data_categories)
        with self._lock:
            snap = self._read()
            if len(snap.entries) >= MAX_ENTRIES:
                raise ValueError(f"registry full (max {MAX_ENTRIES} entries)")
            entry_id = slugify(name)
            if any(e.id == entry_id for e in snap.entries):
                raise ValueError(f"subprocessor with id {entry_id!r} already exists")
            entry = Subprocessor(
                id=entry_id, name=name, purpose=purpose, country=country,
                url=url, data_categories=cats,
            )
            new_entries = snap.entries + [entry]
            new_entries.sort(key=lambda e: e.id)
            new_snap = RegistrySnapshot(
                version=snap.version + 1, entries=new_entries,
                updated_at=_utc_now_iso(), updated_by=actor,
            )
            self._write(new_snap)
            self._append_log("add", actor, None, entry.to_public(), new_snap.version)
            return entry

    def update(self, entry_id: str, *, name: Optional[str] = None,
               purpose: Optional[str] = None, country: Optional[str] = None,
               url: Optional[str] = None, data_categories: Optional[List[str]] = None,
               actor: str = "") -> Subprocessor:
        with self._lock:
            snap = self._read()
            existing = next((e for e in snap.entries if e.id == entry_id), None)
            if existing is None:
                raise KeyError(entry_id)
            new_name = name if name is not None else existing.name
            new_purpose = purpose if purpose is not None else existing.purpose
            new_country = country if country is not None else existing.country
            new_url = url if url is not None else existing.url
            new_cats = data_categories if data_categories is not None else existing.data_categories
            v_name, v_purpose, v_country, v_url, v_cats = _validate(
                new_name, new_purpose, new_country, new_url, new_cats,
            )
            before = existing.to_public()
            updated = Subprocessor(
                id=existing.id, name=v_name, purpose=v_purpose, country=v_country,
                url=v_url, data_categories=v_cats,
                added_at=existing.added_at, updated_at=_utc_now_iso(),
            )
            new_entries = [updated if e.id == entry_id else e for e in snap.entries]
            new_snap = RegistrySnapshot(
                version=snap.version + 1, entries=new_entries,
                updated_at=_utc_now_iso(), updated_by=actor,
            )
            self._write(new_snap)
            self._append_log("update", actor, before, updated.to_public(), new_snap.version)
            return updated

    def remove(self, entry_id: str, *, actor: str = "") -> Subprocessor:
        with self._lock:
            snap = self._read()
            existing = next((e for e in snap.entries if e.id == entry_id), None)
            if existing is None:
                raise KeyError(entry_id)
            new_entries = [e for e in snap.entries if e.id != entry_id]
            new_snap = RegistrySnapshot(
                version=snap.version + 1, entries=new_entries,
                updated_at=_utc_now_iso(), updated_by=actor,
            )
            self._write(new_snap)
            self._append_log("remove", actor, existing.to_public(), None, new_snap.version)
            return existing


_singleton_lock = threading.Lock()
_singleton: Optional[SubprocessorStore] = None
_singleton_path: Optional[Path] = None


def get_store(path: Optional[Path] = None) -> SubprocessorStore:
    """Process-wide singleton, rebuilt when the path changes (tests)."""
    global _singleton, _singleton_path
    with _singleton_lock:
        if path is None:
            if _singleton is not None:
                return _singleton
            raise RuntimeError("subprocessor store not initialised")
        if _singleton is None or _singleton_path != path:
            _singleton = SubprocessorStore(path)
            _singleton_path = path
        return _singleton


def reset_store() -> None:
    """Test hook."""
    global _singleton, _singleton_path
    with _singleton_lock:
        _singleton = None
        _singleton_path = None


__all__ = [
    "Subprocessor", "RegistrySnapshot", "SubprocessorStore",
    "get_store", "reset_store", "slugify",
    "MAX_ENTRIES", "MAX_NAME", "MAX_PURPOSE", "MAX_URL",
]
