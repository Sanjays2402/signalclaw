from __future__ import annotations
import numpy as np
import pandas as pd
import pytest

from signalclaw.risk import (
    RiskConfig,
    kelly_fraction,
    capped_kelly_fraction,
    position_size,
    atr_stops,
    size_pick,
)


def test_kelly_basic_edge():
    # 60% win, 1:1 payoff → f* = 0.6 - 0.4/1 = 0.20
    assert kelly_fraction(0.60, 1.0) == pytest.approx(0.20)


def test_kelly_no_edge_returns_zero():
    assert kelly_fraction(0.40, 1.0) == 0.0
    assert kelly_fraction(0.0, 1.0) == 0.0
    assert kelly_fraction(0.5, 0.0) == 0.0


def test_kelly_bad_inputs():
    assert kelly_fraction(-0.1, 1.0) == 0.0
    assert kelly_fraction(1.1, 1.0) == 0.0


def test_capped_kelly_applies_fractional_and_cap():
    # Raw kelly 0.50, fractional 0.25 → 0.125, cap 0.10 → 0.10
    raw = kelly_fraction(0.75, 1.0)
    assert raw == pytest.approx(0.50)
    capped = capped_kelly_fraction(0.75, 1.0, fractional=0.25, cap=0.10)
    assert capped == pytest.approx(0.10)


def test_atr_stops_long():
    cfg = RiskConfig(atr_stop_mult=2.0, atr_target_mult=3.0)
    stop, target = atr_stops(100.0, 2.0, cfg)
    assert stop == pytest.approx(96.0)
    assert target == pytest.approx(106.0)


def test_position_size_risk_per_trade_binding():
    cfg = RiskConfig(equity=100_000, risk_per_trade=0.01,
                     max_position_pct=0.50)
    # stop $4 below $100 → risk per share 4, budget $1000 → 250 shares
    shares, dollars, risk, reason = position_size(100.0, 96.0, cfg)
    assert shares == 250
    assert dollars == 25_000.0
    assert risk == 1000.0
    assert reason == "risk_per_trade"


def test_position_size_max_pct_binding():
    cfg = RiskConfig(equity=100_000, risk_per_trade=0.10,
                     max_position_pct=0.05)
    # risk budget $10k, stop $1 below $10 → 10000 shares; but max 5% = $5000 / $10 = 500
    shares, dollars, risk, reason = position_size(10.0, 9.0, cfg)
    assert shares == 500
    assert dollars == 5000.0
    assert reason == "max_position_pct"


def test_position_size_no_stop_distance():
    shares, *_ , reason = position_size(100.0, 100.0, RiskConfig())
    assert shares == 0
    assert reason == "no_stop_distance"


def test_position_size_bad_price():
    shares, *_, reason = position_size(0.0, 0.0, RiskConfig())
    assert shares == 0
    assert reason == "bad_price"


def _df(prices):
    idx = pd.date_range("2026-01-01", periods=len(prices), freq="D")
    return pd.DataFrame({
        "open": prices,
        "high": [p * 1.01 for p in prices],
        "low": [p * 0.99 for p in prices],
        "close": prices,
        "volume": [1000] * len(prices),
    }, index=idx)


def test_size_pick_watch_label_produces_positive_size():
    prices = list(np.linspace(100, 110, 60))
    res = size_pick("MSFT", _df(prices), label="watch", score=0.8,
                    cfg=RiskConfig(equity=100_000, risk_per_trade=0.01,
                                   max_position_pct=0.50))
    assert res.ticker == "MSFT"
    assert res.shares > 0
    assert res.stop_loss < res.price < res.take_profit
    assert res.weight > 0
    assert 0.0 <= res.kelly_capped <= 0.10
    assert res.cap_reason in {"kelly_cap", "risk_per_trade", "max_position_pct"}


def test_size_pick_skip_label_zero_shares():
    prices = list(np.linspace(100, 110, 60))
    res = size_pick("MSFT", _df(prices), label="skip", score=0.9)
    assert res.shares == 0
    assert res.dollar_size == 0
    assert res.cap_reason == "skip_label"


def test_size_pick_hold_label_smaller_than_watch():
    prices = list(np.linspace(100, 110, 60))
    cfg = RiskConfig(equity=100_000)
    w = size_pick("MSFT", _df(prices), "watch", 0.8, cfg)
    h = size_pick("MSFT", _df(prices), "hold", 0.8, cfg)
    assert w.shares >= h.shares  # hold is more conservative


def test_size_pick_respects_max_position_pct():
    prices = list(np.linspace(100, 100.5, 60))  # tiny ATR -> tiny risk_per_share
    cfg = RiskConfig(equity=100_000, risk_per_trade=0.10,
                     max_position_pct=0.05, kelly_cap=1.0, kelly_fraction=1.0)
    res = size_pick("X", _df(prices), "watch", 0.9, cfg)
    # weight should not exceed max_position_pct
    assert res.weight <= cfg.max_position_pct + 1e-9
