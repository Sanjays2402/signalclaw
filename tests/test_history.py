from __future__ import annotations
from pathlib import Path

import pytest

from signalclaw.engine.daily import DailyReport, DailyPick
from signalclaw.history import ReportArchive, diff_reports


def _pick(t, label, score=0.5, expret=0.01):
    return DailyPick(ticker=t, label=label, score=score, expected_return=expret,
                     rationale=f"{t} test", risk_flags=[])


def _report(date, picks):
    return DailyReport(as_of=date, picks=picks)


def test_archive_save_and_load(tmp_path: Path):
    a = ReportArchive(tmp_path)
    r = _report("2026-01-01", [_pick("MSFT", "watch", 0.8)])
    p = a.save(r)
    assert p.exists()
    loaded = a.load("2026-01-01")
    assert loaded is not None
    assert loaded.as_of == "2026-01-01"
    assert loaded.picks[0].ticker == "MSFT"
    assert loaded.picks[0].label == "watch"


def test_archive_list_and_latest(tmp_path: Path):
    a = ReportArchive(tmp_path)
    a.save(_report("2026-01-01", [_pick("A", "watch")]))
    a.save(_report("2026-01-02", [_pick("B", "hold")]))
    a.save(_report("2026-01-03", [_pick("C", "skip")]))
    assert a.list_dates() == ["2026-01-01", "2026-01-02", "2026-01-03"]
    assert a.latest().as_of == "2026-01-03"
    summaries = a.summaries()
    assert len(summaries) == 3
    assert summaries[-1].as_of == "2026-01-03"
    assert summaries[-1].top_pick == "C"


def test_archive_summaries_limit(tmp_path: Path):
    a = ReportArchive(tmp_path)
    for i in range(5):
        a.save(_report(f"2026-01-0{i+1}", [_pick("X", "watch")]))
    assert len(a.summaries(limit=2)) == 2


def test_archive_prior_of(tmp_path: Path):
    a = ReportArchive(tmp_path)
    a.save(_report("2026-01-01", [_pick("A", "watch")]))
    a.save(_report("2026-01-02", [_pick("B", "hold")]))
    a.save(_report("2026-01-03", [_pick("C", "skip")]))
    p = a.prior_of("2026-01-03")
    assert p is not None and p.as_of == "2026-01-02"
    assert a.prior_of("2026-01-01") is None


def test_diff_no_prior_treats_all_as_new():
    cur = _report("2026-01-02", [_pick("A", "watch"), _pick("B", "hold")])
    d = diff_reports(None, cur)
    assert d.prior_as_of is None
    assert d.new_picks == ["A", "B"]
    assert d.dropped_picks == []


def test_diff_finds_new_and_dropped():
    prior = _report("2026-01-01", [_pick("A", "watch"), _pick("B", "hold")])
    cur = _report("2026-01-02", [_pick("A", "watch"), _pick("C", "watch")])
    d = diff_reports(prior, cur)
    assert d.new_picks == ["C"]
    assert d.dropped_picks == ["B"]


def test_diff_finds_upgrades_and_downgrades():
    prior = _report("2026-01-01", [
        _pick("A", "hold", 0.5),
        _pick("B", "watch", 0.7),
        _pick("C", "hold", 0.5),
    ])
    cur = _report("2026-01-02", [
        _pick("A", "watch", 0.8),  # upgrade hold -> watch
        _pick("B", "skip", 0.2),   # downgrade watch -> skip
        _pick("C", "hold", 0.55),  # unchanged label
    ])
    d = diff_reports(prior, cur)
    assert any(u["ticker"] == "A" and u["to"] == "watch" for u in d.upgraded)
    assert any(u["ticker"] == "B" and u["to"] == "skip" for u in d.downgraded)
    assert "C" in d.unchanged


def test_diff_score_changes_sorted_by_abs_delta():
    prior = _report("2026-01-01", [
        _pick("A", "watch", 0.50),
        _pick("B", "watch", 0.50),
        _pick("C", "watch", 0.50),
    ])
    cur = _report("2026-01-02", [
        _pick("A", "watch", 0.60),   # +0.10
        _pick("B", "watch", 0.20),   # -0.30
        _pick("C", "watch", 0.55),   # +0.05
    ])
    d = diff_reports(prior, cur)
    tickers = [m["ticker"] for m in d.score_changes]
    assert tickers[0] == "B"
    assert tickers[1] == "A"


def test_archive_diff_latest(tmp_path: Path):
    a = ReportArchive(tmp_path)
    a.save(_report("2026-01-01", [_pick("A", "watch", 0.7)]))
    a.save(_report("2026-01-02", [_pick("A", "skip", 0.2), _pick("B", "watch", 0.8)]))
    d = a.diff_latest()
    assert d is not None
    assert d.current_as_of == "2026-01-02"
    assert d.prior_as_of == "2026-01-01"
    assert "B" in d.new_picks
    assert any(u["ticker"] == "A" for u in d.downgraded)


def test_archive_diff_latest_none_when_empty(tmp_path: Path):
    a = ReportArchive(tmp_path)
    assert a.diff_latest() is None
