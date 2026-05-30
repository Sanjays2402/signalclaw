"""Trade journal: structured notes attached to trades.

Stored separately from the trade record so the immutable trade history is
preserved. Each entry links to a trade id and carries:

- thesis: free-text rationale for entry or exit
- conviction: integer 1..5
- tags: list of short tags ("momentum", "earnings", "macro", ...)
- exit_reason: filled in when the entry corresponds to a sell
- created_at, updated_at: ISO 8601 UTC timestamps

Use cases:
- Post-trade review: filter by tag, conviction, or outcome
- Drift detection: compare realized return against conviction bucket
- Export to journal.csv for offline analysis
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
import csv
import io
import json
import threading


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class JournalEntry:
    trade_id: str
    thesis: str = ""
    conviction: int = 3
    tags: List[str] = field(default_factory=list)
    exit_reason: Optional[str] = None
    created_at: str = field(default_factory=_utc_now)
    updated_at: str = field(default_factory=_utc_now)

    def __post_init__(self) -> None:
        if not isinstance(self.conviction, int):
            self.conviction = int(self.conviction)
        if not 1 <= self.conviction <= 5:
            raise ValueError("conviction must be in 1..5")
        # Normalize tags: trimmed, lowercase, deduped, sorted
        clean: List[str] = []
        for t in self.tags or []:
            x = str(t).strip().lower()
            if x and x not in clean:
                clean.append(x)
        self.tags = sorted(clean)
        if self.exit_reason is not None:
            self.exit_reason = str(self.exit_reason).strip() or None
        if not self.trade_id:
            raise ValueError("trade_id required")

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "JournalEntry":
        return cls(
            trade_id=str(d["trade_id"]),
            thesis=str(d.get("thesis", "")),
            conviction=int(d.get("conviction", 3)),
            tags=list(d.get("tags") or []),
            exit_reason=(str(d["exit_reason"]) if d.get("exit_reason") else None),
            created_at=str(d.get("created_at") or _utc_now()),
            updated_at=str(d.get("updated_at") or _utc_now()),
        )


class JournalStore:
    """Append-only by trade_id; updates replace the entry for that trade_id."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"entries": []}, indent=2))

    def _read(self) -> List[JournalEntry]:
        raw = json.loads(self.path.read_text() or '{"entries":[]}')
        return [JournalEntry.from_dict(e) for e in raw.get("entries", [])]

    def _write(self, entries: List[JournalEntry]) -> None:
        self.path.write_text(json.dumps(
            {"entries": [e.to_dict() for e in entries]},
            indent=2, sort_keys=True,
        ))

    def list(
        self,
        *,
        tag: Optional[str] = None,
        min_conviction: Optional[int] = None,
        max_conviction: Optional[int] = None,
        trade_ids: Optional[Iterable[str]] = None,
    ) -> List[JournalEntry]:
        rows = self._read()
        if tag:
            t = tag.strip().lower()
            rows = [e for e in rows if t in e.tags]
        if min_conviction is not None:
            rows = [e for e in rows if e.conviction >= min_conviction]
        if max_conviction is not None:
            rows = [e for e in rows if e.conviction <= max_conviction]
        if trade_ids is not None:
            wanted = {str(x) for x in trade_ids}
            rows = [e for e in rows if e.trade_id in wanted]
        return rows

    def get(self, trade_id: str) -> Optional[JournalEntry]:
        for e in self._read():
            if e.trade_id == trade_id:
                return e
        return None

    def upsert(self, entry: JournalEntry) -> JournalEntry:
        with self._lock:
            rows = self._read()
            for i, existing in enumerate(rows):
                if existing.trade_id == entry.trade_id:
                    entry.created_at = existing.created_at
                    entry.updated_at = _utc_now()
                    rows[i] = entry
                    break
            else:
                rows.append(entry)
            self._write(rows)
        return entry

    def remove(self, trade_id: str) -> bool:
        with self._lock:
            rows = self._read()
            new = [e for e in rows if e.trade_id != trade_id]
            if len(new) == len(rows):
                return False
            self._write(new)
        return True

    def clear(self) -> None:
        with self._lock:
            self._write([])

    def export_csv(self) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["trade_id", "thesis", "conviction", "tags",
                    "exit_reason", "created_at", "updated_at"])
        for e in self._read():
            w.writerow([e.trade_id, e.thesis, e.conviction,
                        ";".join(e.tags), e.exit_reason or "",
                        e.created_at, e.updated_at])
        return buf.getvalue()


@dataclass
class ConvictionBucketStat:
    conviction: int
    n_trades: int
    realized_pnl: float
    avg_realized_pnl: float
    win_rate: float  # fraction of trades with realized_pnl > 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def conviction_stats(
    trades: Iterable[Any],  # iterable of Trade
    entries: Iterable[JournalEntry],
) -> List[ConvictionBucketStat]:
    """Aggregate realized P&L by conviction bucket.

    Only counts trades whose realized_pnl is non-zero (sells) and that have a
    journal entry. Buckets with no matching trades are omitted.
    """
    by_id: Dict[str, JournalEntry] = {e.trade_id: e for e in entries}
    buckets: Dict[int, List[float]] = {}
    for tr in trades:
        if abs(getattr(tr, "realized_pnl", 0.0)) < 1e-9:
            continue
        e = by_id.get(getattr(tr, "id", ""))
        if e is None:
            continue
        buckets.setdefault(e.conviction, []).append(float(tr.realized_pnl))
    out: List[ConvictionBucketStat] = []
    for c in sorted(buckets):
        pnls = buckets[c]
        wins = sum(1 for p in pnls if p > 0)
        out.append(ConvictionBucketStat(
            conviction=c,
            n_trades=len(pnls),
            realized_pnl=sum(pnls),
            avg_realized_pnl=sum(pnls) / len(pnls),
            win_rate=wins / len(pnls),
        ))
    return out


__all__ = [
    "JournalEntry",
    "JournalStore",
    "ConvictionBucketStat",
    "conviction_stats",
]
