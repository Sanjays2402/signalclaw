"""News event reaction tracker.

Records news events with optional caller-supplied tags (earnings, guidance,
upgrade, downgrade, macro, ...) and, given an OHLCV close-price series for
each ticker, computes the forward log return at configurable horizons
(default 1, 5, 20 trading days).

The store is append-by-id and survives restarts via a JSON file. Forward
returns are computed on demand from the close panel rather than persisted
because price history can be revised (splits, dividends).
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
import csv
import io
import json
import math
import threading
import uuid

import numpy as np
import pandas as pd


DEFAULT_HORIZONS: Tuple[int, ...] = (1, 5, 20)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_id() -> str:
    return "nev_" + uuid.uuid4().hex[:12]


def _normalize_tags(tags: Iterable[str]) -> List[str]:
    seen: List[str] = []
    for t in tags or []:
        x = str(t).strip().lower()
        if x and x not in seen:
            seen.append(x)
    return sorted(seen)


@dataclass
class NewsEvent:
    ticker: str
    headline: str
    event_date: str           # YYYY-MM-DD, the date the event is anchored to
    id: str = field(default_factory=_new_id)
    source: str = ""
    url: str = ""
    tags: List[str] = field(default_factory=list)
    created_at: str = field(default_factory=_utc_now)

    def __post_init__(self) -> None:
        self.ticker = str(self.ticker).strip().upper()
        if not self.ticker:
            raise ValueError("ticker required")
        self.headline = str(self.headline).strip()
        if not self.headline:
            raise ValueError("headline required")
        # Validate date format
        try:
            datetime.strptime(self.event_date, "%Y-%m-%d")
        except ValueError as e:
            raise ValueError(f"event_date must be YYYY-MM-DD: {e}")
        self.tags = _normalize_tags(self.tags)
        self.source = str(self.source).strip()
        self.url = str(self.url).strip()

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "NewsEvent":
        keep = {"ticker", "headline", "event_date", "id", "source", "url", "tags", "created_at"}
        return cls(**{k: v for k, v in d.items() if k in keep})


class NewsEventStore:
    """JSON-backed list keyed by id."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"events": []}, indent=2))

    def _read(self) -> List[NewsEvent]:
        if not self.path.exists():
            return []
        raw = json.loads(self.path.read_text() or '{"events":[]}')
        return [NewsEvent.from_dict(e) for e in raw.get("events", [])]

    def _write(self, events: List[NewsEvent]) -> None:
        self.path.write_text(json.dumps(
            {"events": [e.to_dict() for e in events]},
            indent=2, sort_keys=True,
        ))

    def add(self, ev: NewsEvent) -> NewsEvent:
        with self._lock:
            events = self._read()
            if any(e.id == ev.id for e in events):
                raise ValueError(f"event id collision: {ev.id}")
            events.append(ev)
            self._write(events)
        return ev

    def remove(self, event_id: str) -> bool:
        with self._lock:
            events = self._read()
            new = [e for e in events if e.id != event_id]
            if len(new) == len(events):
                return False
            self._write(new)
        return True

    def list(
        self,
        *,
        ticker: Optional[str] = None,
        tag: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> List[NewsEvent]:
        out = self._read()
        if ticker:
            t = ticker.upper()
            out = [e for e in out if e.ticker == t]
        if tag:
            x = tag.strip().lower()
            out = [e for e in out if x in e.tags]
        if date_from:
            out = [e for e in out if e.event_date >= date_from]
        if date_to:
            out = [e for e in out if e.event_date <= date_to]
        return out

    def get(self, event_id: str) -> Optional[NewsEvent]:
        for e in self._read():
            if e.id == event_id:
                return e
        return None


def _to_dt_index(idx: pd.Index) -> pd.DatetimeIndex:
    if isinstance(idx, pd.DatetimeIndex):
        return idx
    return pd.to_datetime(idx)


def _anchor_position(close_index: pd.DatetimeIndex, event_date: str) -> Optional[int]:
    """First trading-day index >= event_date. None if no such bar exists."""
    ed = pd.Timestamp(event_date)
    locs = np.searchsorted(close_index.values, np.datetime64(ed), side="left")
    locs = int(locs)
    if locs >= len(close_index):
        return None
    return locs


def compute_event_returns(
    event: NewsEvent,
    close: pd.Series,
    horizons: Sequence[int] = DEFAULT_HORIZONS,
) -> Dict[int, Optional[float]]:
    """Forward log return from anchor bar to anchor+horizon, per horizon.

    Returns None for horizons that fall past the end of the series. Returns
    an empty dict if no anchor bar can be located.
    """
    s = close.dropna().astype(float)
    if s.empty:
        return {int(h): None for h in horizons}
    idx = _to_dt_index(s.index)
    pos = _anchor_position(idx, event.event_date)
    if pos is None:
        return {int(h): None for h in horizons}
    anchor = float(s.iloc[pos])
    if anchor <= 0:
        return {int(h): None for h in horizons}
    out: Dict[int, Optional[float]] = {}
    n = len(s)
    for h in horizons:
        hi = int(h)
        target = pos + hi
        if target >= n:
            out[hi] = None
            continue
        future = float(s.iloc[target])
        if future <= 0:
            out[hi] = None
            continue
        out[hi] = math.log(future / anchor)
    return out


@dataclass
class EventStats:
    n: int
    hit_rate: float           # fraction with return > 0
    mean: float
    median: float
    stdev: float
    min: float
    max: float

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)


def _stats(rets: Sequence[float]) -> EventStats:
    rs = [float(r) for r in rets if r is not None and not (isinstance(r, float) and math.isnan(r))]
    n = len(rs)
    if n == 0:
        return EventStats(n=0, hit_rate=0.0, mean=0.0, median=0.0, stdev=0.0, min=0.0, max=0.0)
    arr = np.array(rs, dtype=float)
    return EventStats(
        n=n,
        hit_rate=round(float((arr > 0).mean()), 6),
        mean=round(float(arr.mean()), 8),
        median=round(float(np.median(arr)), 8),
        stdev=round(float(arr.std(ddof=1)) if n > 1 else 0.0, 8),
        min=round(float(arr.min()), 8),
        max=round(float(arr.max()), 8),
    )


@dataclass
class EventStudyReport:
    n_events: int
    horizons: List[int]
    overall: Dict[int, EventStats]                 # horizon -> stats
    by_tag: Dict[str, Dict[int, EventStats]]       # tag -> horizon -> stats
    by_ticker: Dict[str, Dict[int, EventStats]]    # ticker -> horizon -> stats

    def to_dict(self) -> Dict[str, Any]:
        return {
            "n_events": self.n_events,
            "horizons": list(self.horizons),
            "overall": {str(h): s.to_dict() for h, s in self.overall.items()},
            "by_tag": {
                tag: {str(h): s.to_dict() for h, s in by_h.items()}
                for tag, by_h in self.by_tag.items()
            },
            "by_ticker": {
                tic: {str(h): s.to_dict() for h, s in by_h.items()}
                for tic, by_h in self.by_ticker.items()
            },
        }


def event_study(
    events: Iterable[NewsEvent],
    closes: Mapping[str, pd.Series],
    horizons: Sequence[int] = DEFAULT_HORIZONS,
) -> EventStudyReport:
    """Aggregate forward returns across events, broken down by tag and ticker."""
    ev_list = list(events)
    horizons = [int(h) for h in horizons]
    if not horizons:
        raise ValueError("horizons required")
    if any(h <= 0 for h in horizons):
        raise ValueError("horizons must be positive")

    # Bucketed returns
    overall: Dict[int, List[float]] = {h: [] for h in horizons}
    by_tag: Dict[str, Dict[int, List[float]]] = {}
    by_ticker: Dict[str, Dict[int, List[float]]] = {}

    for ev in ev_list:
        s = closes.get(ev.ticker)
        if s is None or s.empty:
            continue
        rets = compute_event_returns(ev, s, horizons)
        for h, r in rets.items():
            if r is None:
                continue
            overall[h].append(r)
            by_ticker.setdefault(ev.ticker, {hh: [] for hh in horizons})[h].append(r)
            for tag in ev.tags:
                by_tag.setdefault(tag, {hh: [] for hh in horizons})[h].append(r)

    return EventStudyReport(
        n_events=len(ev_list),
        horizons=list(horizons),
        overall={h: _stats(overall[h]) for h in horizons},
        by_tag={tag: {h: _stats(by_tag[tag][h]) for h in horizons} for tag in by_tag},
        by_ticker={t: {h: _stats(by_ticker[t][h]) for h in horizons} for t in by_ticker},
    )


def events_to_csv(events: Iterable[NewsEvent]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "ticker", "event_date", "headline", "tags", "source", "url", "created_at"])
    for e in events:
        w.writerow([
            e.id, e.ticker, e.event_date, e.headline,
            "|".join(e.tags), e.source, e.url, e.created_at,
        ])
    return buf.getvalue()
