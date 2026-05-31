"""Rolling log of fired alert events.

Each fire of an alert (a hit returned by ``evaluate_alerts``) is appended to
a JSON-backed log so users can see a history of what fired and when, not
just whatever was returned by the last ``/alerts/check`` call.

The log is bounded (default 5000 entries) and trimmed on write to avoid
unbounded growth on disk.
"""
from __future__ import annotations
import json
import threading
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .rules import AlertHit


@dataclass
class AlertEvent:
    alert_id: str
    ticker: str
    condition: str
    value: Any
    observed: Any
    fired_at: str
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_hit(cls, hit: AlertHit) -> "AlertEvent":
        return cls(
            alert_id=hit.alert_id,
            ticker=hit.ticker,
            condition=hit.condition,
            value=hit.value,
            observed=hit.observed,
            fired_at=hit.fired_at,
            note=hit.note,
        )

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AlertEvent":
        return cls(
            alert_id=d.get("alert_id", ""),
            ticker=d.get("ticker", ""),
            condition=d.get("condition", ""),
            value=d.get("value"),
            observed=d.get("observed"),
            fired_at=d.get("fired_at", ""),
            note=d.get("note", ""),
        )


class AlertEventStore:
    """Append-only, capped JSON log of fired alert events."""

    def __init__(self, path: Path, max_entries: int = 5000) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.max_entries = int(max_entries)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"events": []}, indent=2))

    def _read(self) -> List[AlertEvent]:
        try:
            raw = json.loads(self.path.read_text() or '{"events":[]}')
        except json.JSONDecodeError:
            raw = {"events": []}
        return [AlertEvent.from_dict(e) for e in raw.get("events", [])]

    def _write(self, events: List[AlertEvent]) -> None:
        if len(events) > self.max_entries:
            events = events[-self.max_entries:]
        self.path.write_text(
            json.dumps(
                {"events": [e.to_dict() for e in events]},
                indent=2,
                sort_keys=True,
            )
        )

    def record(self, hits: Iterable[AlertHit]) -> List[AlertEvent]:
        new = [AlertEvent.from_hit(h) for h in hits]
        if not new:
            return []
        with self._lock:
            existing = self._read()
            existing.extend(new)
            self._write(existing)
        return new

    def list(
        self,
        ticker: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[AlertEvent]:
        rows = self._read()
        # newest first
        rows.reverse()
        if ticker:
            t = ticker.upper()
            rows = [e for e in rows if e.ticker.upper() == t]
        if offset:
            rows = rows[offset:]
        if limit and limit > 0:
            rows = rows[:limit]
        return rows

    def count(self, ticker: Optional[str] = None) -> int:
        rows = self._read()
        if ticker:
            t = ticker.upper()
            rows = [e for e in rows if e.ticker.upper() == t]
        return len(rows)

    def clear(self) -> None:
        with self._lock:
            self._write([])
