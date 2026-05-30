"""Tests for portfolio drawdown guard."""
from __future__ import annotations
from pathlib import Path

import pandas as pd
import pytest

from signalclaw.portfolio import (
    DrawdownConfig,
    DrawdownGuardStore,
    Trade,
    TradeSide,
    compute_equity_curve,
    evaluate_drawdown,
    evaluate_guard,
    filter_picks,
)


def _hist(prices: dict[str, list[tuple[str, float]]]) -> dict[str, pd.DataFrame]:
    out = {}
    for t, rows in prices.items():
        idx = pd.to_datetime([d for d, _ in rows])
        df = pd.DataFrame({"close": [p for _, p in rows]}, index=idx)
        out[t] = df
    return out


def test_drawdown_config_validates() -> None:
    with pytest.raises(ValueError):
        DrawdownConfig(trigger=0)
    with pytest.raises(ValueError):
        DrawdownConfig(trigger=0.1, rearm=0.2)
    with pytest.raises(ValueError):
        DrawdownConfig(min_history_days=0)


def test_compute_equity_curve_buy_and_mark_to_market() -> None:
    trades = [Trade(ticker="AAPL", side=TradeSide.BUY, quantity=10, price=100,
                    date="2024-01-01")]
    hist = _hist({"AAPL": [("2024-01-01", 100), ("2024-01-02", 110),
                            ("2024-01-03", 90)]})
    eq = compute_equity_curve(trades, hist, cash=1000.0)
    assert len(eq) == 3
    # Day 1: cash 0 + 10*100 = 1000
    assert eq.iloc[0] == pytest.approx(1000.0)
    # Day 2: 0 + 10*110 = 1100
    assert eq.iloc[1] == pytest.approx(1100.0)
    # Day 3: 0 + 10*90 = 900
    assert eq.iloc[2] == pytest.approx(900.0)


def test_compute_equity_curve_realizes_on_sell() -> None:
    trades = [
        Trade(ticker="MSFT", side=TradeSide.BUY, quantity=5, price=200,
              date="2024-01-01"),
        Trade(ticker="MSFT", side=TradeSide.SELL, quantity=5, price=220,
              date="2024-01-02"),
    ]
    hist = _hist({"MSFT": [("2024-01-01", 200), ("2024-01-02", 220)]})
    eq = compute_equity_curve(trades, hist, cash=2000.0)
    # Day 1: cash 1000 + holdings 1000 = 2000
    assert eq.iloc[0] == pytest.approx(2000.0)
    # Day 2: cash 2100 + holdings 0 = 2100
    assert eq.iloc[1] == pytest.approx(2100.0)


def test_evaluate_drawdown_within_tolerance() -> None:
    eq = pd.Series([100, 105, 110, 108, 107],
                   index=pd.date_range("2024-01-01", periods=5))
    state = evaluate_drawdown(eq, DrawdownConfig(trigger=0.10, rearm=0.03))
    assert state.tripped is False
    assert state.drawdown == pytest.approx((110 - 107) / 110)
    assert state.peak == 110
    assert "within tolerance" in state.reason


def test_evaluate_drawdown_trips() -> None:
    eq = pd.Series([100, 110, 120, 110, 100, 95],
                   index=pd.date_range("2024-01-01", periods=6))
    state = evaluate_drawdown(eq, DrawdownConfig(trigger=0.10, rearm=0.03))
    assert state.tripped is True
    assert state.drawdown == pytest.approx((120 - 95) / 120)
    assert "drawdown" in state.reason


def test_evaluate_drawdown_hysteresis_holds_until_rearm() -> None:
    # Equity recovers from 95 to 117 (peak 120). Drawdown 2.5%, above rearm 1%.
    eq = pd.Series([100, 110, 120, 95, 117],
                   index=pd.date_range("2024-01-01", periods=5))
    cfg = DrawdownConfig(trigger=0.10, rearm=0.01)
    # Without prior trip: only the latest point matters.
    not_armed = evaluate_drawdown(eq, cfg, previously_tripped=False)
    assert not_armed.tripped is False  # 2.5% < 10% trigger
    # With prior trip: stays tripped because 2.5% > 1% rearm.
    armed = evaluate_drawdown(eq, cfg, previously_tripped=True)
    assert armed.tripped is True
    assert "still below re-arm" in armed.reason


def test_evaluate_drawdown_clears_once_fully_recovered() -> None:
    eq = pd.Series([100, 120, 95, 121],
                   index=pd.date_range("2024-01-01", periods=4))
    cfg = DrawdownConfig(trigger=0.10, rearm=0.03, min_history_days=2)
    state = evaluate_drawdown(eq, cfg, previously_tripped=True)
    assert state.tripped is False
    assert "re-armed" in state.reason


def test_evaluate_drawdown_requires_min_history() -> None:
    eq = pd.Series([100, 80], index=pd.date_range("2024-01-01", periods=2))
    cfg = DrawdownConfig(trigger=0.10, rearm=0.03, min_history_days=5)
    state = evaluate_drawdown(eq, cfg)
    assert state.tripped is False
    assert "insufficient history" in state.reason


def test_evaluate_guard_end_to_end() -> None:
    trades = [Trade(ticker="SPY", side=TradeSide.BUY, quantity=10, price=400,
                    date="2024-01-01")]
    hist = _hist({"SPY": [(f"2024-01-{d:02d}", p) for d, p in zip(
        range(1, 11), [400, 405, 410, 420, 415, 400, 380, 360, 350, 345]
    )]})
    cfg = DrawdownConfig(trigger=0.10, rearm=0.03, min_history_days=3)
    report = evaluate_guard(trades, hist, cfg, cash=4000.0)
    assert report.state.tripped is True
    assert report.state.peak == pytest.approx(4200.0)
    assert len(report.equity_curve) == 10


def test_filter_picks_passthrough_when_not_tripped() -> None:
    state = evaluate_drawdown(
        pd.Series([100, 101], index=pd.date_range("2024-01-01", periods=2)),
        DrawdownConfig(min_history_days=1),
    )
    picks = [{"ticker": "AAPL", "label": "watch"}]
    out = filter_picks(picks, state)
    assert out == picks


def test_filter_picks_downgrades_watch_when_tripped() -> None:
    eq = pd.Series([100, 80], index=pd.date_range("2024-01-01", periods=2))
    state = evaluate_drawdown(eq, DrawdownConfig(min_history_days=1, trigger=0.1))
    assert state.tripped
    picks = [
        {"ticker": "AAPL", "label": "watch", "risk_flags": ["momentum"]},
        {"ticker": "MSFT", "label": "skip"},
    ]
    out = filter_picks(picks, state)
    assert out[0]["label"] == "hold"
    assert any("drawdown_guard_tripped" in f for f in out[0]["risk_flags"])
    assert "momentum" in out[0]["risk_flags"]
    assert out[1] == {"ticker": "MSFT", "label": "skip"}


def test_drawdown_guard_store_persists_state(tmp_path: Path) -> None:
    store = DrawdownGuardStore(tmp_path / "guard.json")
    assert store.previously_tripped() is False
    eq = pd.Series([100, 80], index=pd.date_range("2024-01-01", periods=2))
    state = evaluate_drawdown(eq, DrawdownConfig(min_history_days=1, trigger=0.1))
    store.record(state)
    assert store.previously_tripped() is True
    assert len(store.history()) == 1
    store.clear()
    assert store.previously_tripped() is False


def test_compute_equity_curve_empty_returns_empty() -> None:
    eq = compute_equity_curve([], {})
    assert len(eq) == 0
