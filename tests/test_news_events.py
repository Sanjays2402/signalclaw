"""Tests for news_events module."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from signalclaw.news_events import (
    NewsEvent,
    NewsEventStore,
    compute_event_returns,
    event_study,
    events_to_csv,
)


def _flat_with_jump(jump_date: str, jump: float, n: int = 60) -> pd.Series:
    """100 each day, then multiply by (1+jump) starting jump_date."""
    idx = pd.date_range("2026-01-01", periods=n, freq="B")
    vals = np.full(n, 100.0)
    jd = pd.Timestamp(jump_date)
    mask = idx >= jd
    vals[mask] = 100.0 * (1.0 + jump)
    return pd.Series(vals, index=idx)


def test_event_construction_normalizes():
    e = NewsEvent(ticker="aapl", headline="  Apple beats earnings  ",
                   event_date="2026-04-01", tags=["Earnings", "earnings", " beat "])
    assert e.ticker == "AAPL"
    assert e.headline == "Apple beats earnings"
    assert e.tags == ["beat", "earnings"]
    assert e.id.startswith("nev_")


def test_event_rejects_bad_inputs():
    with pytest.raises(ValueError):
        NewsEvent(ticker="", headline="x", event_date="2026-01-01")
    with pytest.raises(ValueError):
        NewsEvent(ticker="x", headline="", event_date="2026-01-01")
    with pytest.raises(ValueError):
        NewsEvent(ticker="x", headline="x", event_date="2026-13-40")


def test_store_roundtrip(tmp_path):
    s = NewsEventStore(tmp_path / "ne.json")
    a = s.add(NewsEvent(ticker="AAPL", headline="h1", event_date="2026-01-02"))
    b = s.add(NewsEvent(ticker="MSFT", headline="h2", event_date="2026-01-03",
                          tags=["upgrade"]))
    s2 = NewsEventStore(tmp_path / "ne.json")
    ids = {e.id for e in s2.list()}
    assert {a.id, b.id} == ids
    assert s2.get(a.id).ticker == "AAPL"


def test_store_filters(tmp_path):
    s = NewsEventStore(tmp_path / "ne.json")
    s.add(NewsEvent(ticker="AAPL", headline="h", event_date="2026-01-01", tags=["earnings"]))
    s.add(NewsEvent(ticker="AAPL", headline="h", event_date="2026-02-01", tags=["upgrade"]))
    s.add(NewsEvent(ticker="MSFT", headline="h", event_date="2026-01-15", tags=["earnings"]))
    assert len(s.list(ticker="AAPL")) == 2
    assert len(s.list(tag="earnings")) == 2
    assert len(s.list(ticker="AAPL", tag="upgrade")) == 1
    assert len(s.list(date_from="2026-01-10", date_to="2026-01-20")) == 1


def test_remove(tmp_path):
    s = NewsEventStore(tmp_path / "ne.json")
    e = s.add(NewsEvent(ticker="X", headline="h", event_date="2026-01-01"))
    assert s.remove(e.id)
    assert not s.remove(e.id)


def test_compute_event_returns_positive_jump():
    close = _flat_with_jump("2026-02-02", jump=0.05, n=60)  # +5% jump
    e = NewsEvent(ticker="X", headline="h", event_date="2026-02-02")
    rets = compute_event_returns(e, close, horizons=(1, 5, 20))
    # Anchor at 2026-02-02 (jumped), forward bars stay at 105 -> 0 return
    assert rets[1] == pytest.approx(0.0)
    assert rets[5] == pytest.approx(0.0)


def test_compute_event_returns_anchor_is_first_session_on_or_after():
    # Anchor on a weekend; should attach to next trading day
    close = _flat_with_jump("2026-01-15", jump=0.0, n=60)
    # Day before jump anchor: should pick up the jump
    close2 = close.copy()
    close2.iloc[10:] = close2.iloc[10:] * 1.1
    anchor_session = close2.index[10]
    e = NewsEvent(ticker="X", headline="h",
                   event_date=str(anchor_session.date()))
    rets = compute_event_returns(e, close2, horizons=(1,))
    # Anchor and t+1 both inside the jumped region -> 0 return
    assert rets[1] == pytest.approx(0.0)


def test_compute_event_returns_horizon_past_end_is_none():
    close = _flat_with_jump("2026-01-15", jump=0.0, n=30)
    e = NewsEvent(ticker="X", headline="h", event_date="2026-01-15")
    rets = compute_event_returns(e, close, horizons=(1, 100))
    assert rets[1] == 0.0
    assert rets[100] is None


def test_compute_event_returns_event_after_end_returns_none():
    close = _flat_with_jump("2026-01-15", jump=0.0, n=20)
    e = NewsEvent(ticker="X", headline="h", event_date="2099-01-01")
    rets = compute_event_returns(e, close, horizons=(1, 5))
    assert rets == {1: None, 5: None}


def test_event_study_aggregates_by_tag():
    # Build series: AAPL jumps +5% on event date; MSFT drops -3%.
    aapl = pd.Series(100.0, index=pd.date_range("2026-01-01", periods=60, freq="B"))
    aapl.iloc[10:] = 105.0  # jump on day index 10 = 2026-01-15
    msft = pd.Series(100.0, index=pd.date_range("2026-01-01", periods=60, freq="B"))
    msft.iloc[20:] = 97.0   # drop on day index 20
    closes = {"AAPL": aapl, "MSFT": msft}
    events = [
        NewsEvent(ticker="AAPL", headline="up", event_date=str(aapl.index[9].date()),
                   tags=["upgrade"]),
        NewsEvent(ticker="MSFT", headline="dn", event_date=str(msft.index[19].date()),
                   tags=["downgrade"]),
    ]
    rep = event_study(events, closes, horizons=(1, 5))
    assert rep.n_events == 2
    # AAPL: anchor pre-jump (100), t+1 post (105) -> +ve
    upgrade_h1 = rep.by_tag["upgrade"][1]
    assert upgrade_h1.n == 1
    assert upgrade_h1.mean > 0
    downgrade_h1 = rep.by_tag["downgrade"][1]
    assert downgrade_h1.mean < 0
    # Overall mean across both events at h=1: roughly average of +ve and -ve
    overall_h1 = rep.overall[1]
    assert overall_h1.n == 2
    # Per-ticker bucket
    assert "AAPL" in rep.by_ticker and rep.by_ticker["AAPL"][1].n == 1


def test_event_study_skips_missing_ticker():
    closes = {"AAPL": pd.Series(100.0, index=pd.date_range("2026-01-01", periods=30, freq="B"))}
    events = [
        NewsEvent(ticker="ZZZ", headline="h", event_date="2026-01-05"),
        NewsEvent(ticker="AAPL", headline="h", event_date="2026-01-05"),
    ]
    rep = event_study(events, closes, horizons=(1,))
    assert rep.n_events == 2
    assert rep.overall[1].n == 1  # only AAPL contributed


def test_event_study_bad_horizons():
    with pytest.raises(ValueError):
        event_study([], {}, horizons=())
    with pytest.raises(ValueError):
        event_study([], {}, horizons=(0,))


def test_event_stats_hit_rate():
    closes = {"X": pd.Series([100, 101, 102, 103], index=pd.date_range("2026-01-01", periods=4, freq="B"))}
    e = NewsEvent(ticker="X", headline="h", event_date="2026-01-01")
    rep = event_study([e], closes, horizons=(1, 2, 3))
    s = rep.overall[3]
    assert s.n == 1
    assert s.hit_rate == 1.0  # 100 -> 103 positive


def test_events_to_csv(tmp_path):
    events = [
        NewsEvent(ticker="AAPL", headline="apple news", event_date="2026-01-05",
                   tags=["earnings", "beat"], source="reuters"),
    ]
    text = events_to_csv(events)
    lines = text.strip().splitlines()
    assert lines[0] == "id,ticker,event_date,headline,tags,source,url,created_at"
    assert "AAPL,2026-01-05,apple news" in lines[1]
    assert "beat|earnings" in lines[1]


def test_persistence_file_shape(tmp_path):
    p = tmp_path / "ne.json"
    s = NewsEventStore(p)
    s.add(NewsEvent(ticker="X", headline="h", event_date="2026-01-01", tags=["a"]))
    raw = json.loads(p.read_text())
    assert "events" in raw
    assert raw["events"][0]["ticker"] == "X"
