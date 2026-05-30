"""Earnings calendar and blackout-aware filtering.

For a watchlist ticker we read the next earnings date from a simple JSON store
(populated manually or by an external scraper). If a ticker's next earnings
falls within `blackout_days` of today, downstream pick logic can choose to:

- suppress NEW positions (default behavior in `apply_blackout`)
- tag the pick with a `near_earnings:N` risk flag
- still allow HOLD/SKIP signals on existing positions

This module does NOT call any earnings API. It exposes a small `EarningsStore`
and pure functions over `DailyPick` objects so the engine and CLI can wire it
in deterministically.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional
import json


@dataclass
class EarningsDate:
    ticker: str
    next_report: str  # ISO date, e.g. "2026-07-23"
    confirmed: bool = False
    source: str = "manual"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "EarningsDate":
        return cls(
            ticker=str(d["ticker"]).upper(),
            next_report=str(d["next_report"]),
            confirmed=bool(d.get("confirmed", False)),
            source=str(d.get("source", "manual")),
        )

    def days_until(self, today: Optional[date] = None) -> Optional[int]:
        today = today or date.today()
        try:
            d = datetime.fromisoformat(self.next_report).date()
        except ValueError:
            return None
        return (d - today).days


class EarningsStore:
    """JSON store keyed by ticker. One row per ticker (next earnings only)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text("{}")

    def _read(self) -> Dict[str, EarningsDate]:
        raw = json.loads(self.path.read_text() or "{}")
        return {k.upper(): EarningsDate.from_dict(v) for k, v in raw.items()}

    def _write(self, data: Dict[str, EarningsDate]) -> None:
        self.path.write_text(json.dumps(
            {k: v.to_dict() for k, v in data.items()}, indent=2, sort_keys=True,
        ))

    def list(self) -> List[EarningsDate]:
        return sorted(self._read().values(), key=lambda e: e.next_report)

    def get(self, ticker: str) -> Optional[EarningsDate]:
        return self._read().get(ticker.upper())

    def set(self, e: EarningsDate) -> EarningsDate:
        data = self._read()
        data[e.ticker.upper()] = e
        self._write(data)
        return e

    def remove(self, ticker: str) -> bool:
        data = self._read()
        if ticker.upper() not in data:
            return False
        del data[ticker.upper()]
        self._write(data)
        return True

    def upcoming(self, within_days: int, today: Optional[date] = None) -> List[EarningsDate]:
        today = today or date.today()
        out: List[EarningsDate] = []
        for e in self._read().values():
            n = e.days_until(today)
            if n is not None and 0 <= n <= within_days:
                out.append(e)
        out.sort(key=lambda e: e.days_until(today) or 0)
        return out


def apply_blackout(picks: Iterable, store: EarningsStore, *,
                   blackout_days: int = 5,
                   today: Optional[date] = None,
                   demote_label: str = "hold") -> List:
    """Mutate-and-return picks that are within blackout of earnings.

    - Adds risk flag `near_earnings:N` (N = days until report)
    - If the pick label is currently `watch` (i.e. new entry), demote to
      `demote_label` (default `hold`) so we do not enter fresh into earnings.
    - HOLD / SKIP labels are left as-is; we only block new entries.

    Picks are dataclasses with `.label` and `.risk_flags` attributes (see
    `signalclaw.engine.daily.DailyPick`); we operate by duck typing so this
    module stays import-light.
    """
    today = today or date.today()
    out = []
    for p in picks:
        ed = store.get(getattr(p, "ticker", ""))
        if ed is not None:
            n = ed.days_until(today)
            if n is not None and 0 <= n <= blackout_days:
                flag = f"near_earnings:{n}d"
                if flag not in p.risk_flags:
                    p.risk_flags.append(flag)
                if getattr(p, "label", "") == "watch":
                    p.label = demote_label
        out.append(p)
    return out
