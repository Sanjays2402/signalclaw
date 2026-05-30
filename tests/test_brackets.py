"""Tests for bracket order plans."""
from __future__ import annotations

import json
import pytest

from signalclaw.portfolio import (
    BracketPlan,
    BracketStore,
    compute_bracket_stats,
)


def test_plan_geometry_long_valid():
    p = BracketPlan(ticker="aapl", side="long", entry=100.0, stop=95.0, target=110.0, shares=10)
    assert p.ticker == "AAPL"
    assert p.risk_per_share == pytest.approx(5.0)
    assert p.reward_per_share == pytest.approx(10.0)
    assert p.planned_r_multiple == pytest.approx(2.0)
    assert p.planned_risk_dollars == pytest.approx(50.0)


def test_plan_geometry_short_valid():
    p = BracketPlan(ticker="TSLA", side="short", entry=200.0, stop=210.0, target=180.0, shares=5)
    assert p.risk_per_share == pytest.approx(10.0)
    assert p.reward_per_share == pytest.approx(20.0)
    assert p.planned_r_multiple == pytest.approx(2.0)


@pytest.mark.parametrize("side,entry,stop,target", [
    ("long", 100.0, 105.0, 110.0),   # stop above entry
    ("long", 100.0, 95.0, 99.0),     # target below entry
    ("short", 100.0, 95.0, 90.0),    # stop below entry
    ("short", 100.0, 110.0, 105.0),  # target above entry
])
def test_plan_geometry_rejects_inverted(side, entry, stop, target):
    with pytest.raises(ValueError):
        BracketPlan(ticker="X", side=side, entry=entry, stop=stop, target=target, shares=1)


def test_plan_rejects_bad_inputs():
    with pytest.raises(ValueError):
        BracketPlan(ticker="", side="long", entry=1, stop=0.5, target=2, shares=1)
    with pytest.raises(ValueError):
        BracketPlan(ticker="X", side="sideways", entry=1, stop=0.5, target=2, shares=1)
    with pytest.raises(ValueError):
        BracketPlan(ticker="X", side="long", entry=1, stop=0.5, target=2, shares=0)
    with pytest.raises(ValueError):
        BracketPlan(ticker="X", side="long", entry=-1, stop=-2, target=1, shares=1)


def test_store_roundtrip(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    p = s.add(BracketPlan(ticker="MSFT", side="long", entry=400.0, stop=390.0, target=420.0, shares=10))
    assert s.get(p.id).ticker == "MSFT"
    s2 = BracketStore(tmp_path / "br.json")
    plans = s2.list()
    assert len(plans) == 1
    assert plans[0].id == p.id
    assert plans[0].planned_r_multiple == pytest.approx(2.0)


def test_store_filter_by_ticker_and_status(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    a = s.add(BracketPlan(ticker="AAPL", side="long", entry=100, stop=95, target=110, shares=1))
    s.add(BracketPlan(ticker="MSFT", side="long", entry=400, stop=390, target=420, shares=1))
    s.fill(a.id, 100.5)
    assert [p.ticker for p in s.list(ticker="AAPL")] == ["AAPL"]
    assert [p.status for p in s.list(status="filled")] == ["filled"]
    assert [p.status for p in s.list(status="open")] == ["open"]
    with pytest.raises(ValueError):
        s.list(status="bogus")


def test_lifecycle_fill_close_long_winner(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    p = s.add(BracketPlan(ticker="AAPL", side="long", entry=100.0, stop=90.0, target=120.0, shares=10))
    p = s.fill(p.id, actual_entry=101.0)
    assert p.status == "filled"
    assert p.actual_entry == 101.0
    p = s.close(p.id, actual_exit=120.0, reason="target")
    assert p.status == "closed"
    # realized_r = (120 - 101) / 10 = 1.9
    assert p.realized_r() == pytest.approx(1.9)
    assert p.realized_pnl() == pytest.approx((120.0 - 101.0) * 10)


def test_lifecycle_short_stopped_out(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    p = s.add(BracketPlan(ticker="TSLA", side="short", entry=200.0, stop=210.0, target=180.0, shares=5))
    p = s.fill(p.id, actual_entry=199.5)
    p = s.close(p.id, actual_exit=211.0, reason="stop")
    # direction -1, (211 - 199.5) / 10 * -1 = -1.15
    assert p.realized_r() == pytest.approx(-1.15)
    assert p.realized_pnl() == pytest.approx((199.5 - 211.0) * 5)


def test_cannot_close_unfilled(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    p = s.add(BracketPlan(ticker="X", side="long", entry=10, stop=9, target=12, shares=1))
    with pytest.raises(ValueError):
        s.close(p.id, actual_exit=11, reason="target")


def test_cannot_fill_twice_or_cancel_closed(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    p = s.add(BracketPlan(ticker="X", side="long", entry=10, stop=9, target=12, shares=1))
    s.fill(p.id, 10.0)
    with pytest.raises(ValueError):
        s.fill(p.id, 10.5)
    s.close(p.id, 12.0, "target")
    with pytest.raises(ValueError):
        s.cancel(p.id)


def test_cancel_open(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    p = s.add(BracketPlan(ticker="X", side="long", entry=10, stop=9, target=12, shares=1))
    p = s.cancel(p.id)
    assert p.status == "cancelled"


def test_remove_unknown_returns_false(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    assert s.remove("brk_doesnotexist") is False


def test_invalid_exit_reason(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    p = s.add(BracketPlan(ticker="X", side="long", entry=10, stop=9, target=12, shares=1))
    s.fill(p.id, 10.0)
    with pytest.raises(ValueError):
        s.close(p.id, 11.0, "moon")


def test_compute_stats():
    plans = [
        # winner +2R
        _closed("long", entry=100, stop=90, target=120, fill=100, exit=120, reason="target"),
        # loser -1R
        _closed("long", entry=50, stop=45, target=60, fill=50, exit=45, reason="stop"),
        # winner +0.5R
        _closed("long", entry=10, stop=9, target=12, fill=10, exit=10.5, reason="manual"),
        # open (excluded from r stats)
        BracketPlan(ticker="X", side="long", entry=1, stop=0.5, target=2, shares=1),
    ]
    s = compute_bracket_stats(plans)
    assert s.total == 4
    assert s.open == 1
    assert s.closed == 3
    assert s.win_rate == pytest.approx(2 / 3, abs=1e-6)
    assert s.avg_r == pytest.approx((2.0 - 1.0 + 0.5) / 3, abs=1e-6)
    assert s.avg_win_r == pytest.approx((2.0 + 0.5) / 2)
    assert s.avg_loss_r == pytest.approx(-1.0)
    assert s.median_r == pytest.approx(0.5)
    assert s.by_exit_reason == {"target": 1, "stop": 1, "manual": 1}


def test_compute_stats_empty():
    s = compute_bracket_stats([])
    assert s.total == 0
    assert s.win_rate == 0.0
    assert s.expectancy == 0.0


def test_csv_export(tmp_path):
    s = BracketStore(tmp_path / "br.json")
    p = s.add(BracketPlan(ticker="AAPL", side="long", entry=100, stop=90, target=120, shares=10))
    s.fill(p.id, 100.0)
    s.close(p.id, 120.0, "target")
    text = s.export_csv()
    lines = text.strip().splitlines()
    assert lines[0].startswith("id,ticker,side,shares,entry,stop,target,")
    assert "AAPL,long,10" in lines[1]
    assert "target" in lines[1]


def test_persistence_file_shape(tmp_path):
    path = tmp_path / "br.json"
    s = BracketStore(path)
    p = s.add(BracketPlan(ticker="X", side="long", entry=10, stop=9, target=12, shares=1))
    s.fill(p.id, 10.0)
    s.close(p.id, 12.0, "target")
    raw = json.loads(path.read_text())
    assert "plans" in raw
    saved = raw["plans"][0]
    # No derived fields persisted
    for forbidden in ("risk_per_share", "reward_per_share", "planned_r_multiple",
                      "planned_risk_dollars", "realized_r", "realized_pnl"):
        assert forbidden not in saved
    # Re-load survives
    s2 = BracketStore(path)
    assert s2.list()[0].actual_exit == 12.0


def test_to_dict_includes_derived():
    p = BracketPlan(ticker="X", side="long", entry=10, stop=9, target=12, shares=1)
    d = p.to_dict()
    assert d["risk_per_share"] == pytest.approx(1.0)
    assert d["reward_per_share"] == pytest.approx(2.0)
    assert d["realized_r"] is None
    assert d["realized_pnl"] is None


def _closed(side, *, entry, stop, target, fill, exit, reason):
    p = BracketPlan(ticker="X", side=side, entry=entry, stop=stop, target=target, shares=1)
    p.actual_entry = fill
    p.actual_exit = exit
    p.exit_reason = reason
    p.status = "closed"
    return p
