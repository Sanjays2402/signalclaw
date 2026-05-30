from __future__ import annotations
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import List


from signalclaw.earnings import EarningsDate, EarningsStore, apply_blackout


@dataclass
class FakePick:
    ticker: str
    label: str = "watch"
    risk_flags: List[str] = field(default_factory=list)


def test_earnings_date_days_until():
    today = date(2026, 5, 29)
    e = EarningsDate(ticker="MSFT", next_report="2026-06-03")
    assert e.days_until(today) == 5
    e2 = EarningsDate(ticker="X", next_report="2026-05-29")
    assert e2.days_until(today) == 0


def test_earnings_store_roundtrip(tmp_path: Path):
    s = EarningsStore(tmp_path / "earn.json")
    s.set(EarningsDate(ticker="MSFT", next_report="2026-07-23", confirmed=True))
    s.set(EarningsDate(ticker="TSLA", next_report="2026-07-17"))
    assert len(s.list()) == 2
    assert s.get("msft").confirmed is True
    assert s.remove("MSFT") is True
    assert s.remove("MSFT") is False
    assert len(s.list()) == 1


def test_earnings_store_upcoming(tmp_path: Path):
    s = EarningsStore(tmp_path / "earn.json")
    today = date(2026, 5, 29)
    s.set(EarningsDate(ticker="A", next_report=str(today + timedelta(days=2))))
    s.set(EarningsDate(ticker="B", next_report=str(today + timedelta(days=10))))
    s.set(EarningsDate(ticker="C", next_report=str(today - timedelta(days=1))))  # past
    upc = s.upcoming(within_days=7, today=today)
    assert [e.ticker for e in upc] == ["A"]


def test_apply_blackout_demotes_watch_and_flags(tmp_path: Path):
    s = EarningsStore(tmp_path / "earn.json")
    today = date(2026, 5, 29)
    s.set(EarningsDate(ticker="MSFT", next_report=str(today + timedelta(days=3))))
    s.set(EarningsDate(ticker="TSLA", next_report=str(today + timedelta(days=30))))
    picks = [
        FakePick("MSFT", "watch"),
        FakePick("TSLA", "watch"),
        FakePick("AAPL", "watch"),  # no earnings record
    ]
    out = apply_blackout(picks, s, blackout_days=5, today=today)
    by_t = {p.ticker: p for p in out}
    assert by_t["MSFT"].label == "hold"
    assert any(f.startswith("near_earnings:") for f in by_t["MSFT"].risk_flags)
    # TSLA is outside blackout
    assert by_t["TSLA"].label == "watch"
    assert by_t["TSLA"].risk_flags == []
    # AAPL untouched
    assert by_t["AAPL"].label == "watch"


def test_apply_blackout_leaves_hold_and_skip_labels(tmp_path: Path):
    s = EarningsStore(tmp_path / "earn.json")
    today = date(2026, 5, 29)
    s.set(EarningsDate(ticker="MSFT", next_report=str(today + timedelta(days=2))))
    picks = [FakePick("MSFT", "hold"), FakePick("MSFT", "skip")]
    out = apply_blackout(picks, s, blackout_days=5, today=today)
    assert out[0].label == "hold"
    assert out[1].label == "skip"
    # Both still get the flag
    assert all(any(f.startswith("near_earnings:") for f in p.risk_flags) for p in out)


def test_apply_blackout_idempotent(tmp_path: Path):
    s = EarningsStore(tmp_path / "earn.json")
    today = date(2026, 5, 29)
    s.set(EarningsDate(ticker="MSFT", next_report=str(today + timedelta(days=1))))
    p = FakePick("MSFT", "watch")
    apply_blackout([p], s, blackout_days=5, today=today)
    apply_blackout([p], s, blackout_days=5, today=today)
    # only one flag added
    earnings_flags = [f for f in p.risk_flags if f.startswith("near_earnings:")]
    assert len(earnings_flags) == 1
