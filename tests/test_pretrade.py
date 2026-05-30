"""Tests for pretrade order simulator."""
from __future__ import annotations

import pytest

from signalclaw.risk import (
    CostModel,
    OrderRequest,
    OrderSimulation,
    simulate_order,
)


def test_request_validation_long_geometry():
    OrderRequest(ticker="AAPL", side="long", price=100, stop=95, target=110, equity=10_000)
    with pytest.raises(ValueError):
        OrderRequest(ticker="AAPL", side="long", price=100, stop=105, target=110, equity=10_000)
    with pytest.raises(ValueError):
        OrderRequest(ticker="AAPL", side="long", price=100, stop=95, target=90, equity=10_000)


def test_request_validation_short_geometry():
    OrderRequest(ticker="AAPL", side="short", price=100, stop=105, target=90, equity=10_000)
    with pytest.raises(ValueError):
        OrderRequest(ticker="AAPL", side="short", price=100, stop=95, target=90, equity=10_000)


def test_request_validation_inputs():
    with pytest.raises(ValueError):
        OrderRequest(ticker="", side="long", price=10, stop=9, target=11, equity=1000)
    with pytest.raises(ValueError):
        OrderRequest(ticker="X", side="forwards", price=10, stop=9, target=11, equity=1000)
    with pytest.raises(ValueError):
        OrderRequest(ticker="X", side="long", price=0, stop=-1, target=11, equity=1000)
    with pytest.raises(ValueError):
        OrderRequest(ticker="X", side="long", price=10, stop=9, target=11, equity=1000,
                      risk_per_trade=1.5)
    with pytest.raises(ValueError):
        OrderRequest(ticker="X", side="long", price=10, stop=9, target=11, equity=1000,
                      max_position_pct=0.0)


def test_basic_sizing_no_fees():
    # Equity 10k, risk 1% = $100, stop distance $5 -> 20 shares
    req = OrderRequest(ticker="AAPL", side="long", price=100, stop=95, target=110,
                        equity=10_000, risk_per_trade=0.01, max_position_pct=1.0)
    sim = simulate_order(req)
    assert sim.accepted is True
    assert sim.shares == 20
    assert sim.notional == 2000.0
    assert sim.fees == 0.0
    assert sim.cap_reason == "risk_per_trade"
    assert sim.planned_r_multiple == 2.0
    assert sim.planned_risk_dollars == pytest.approx(100.0)


def test_max_position_pct_binds():
    # 10k equity, 5% cap = $500 max -> only 5 shares at $100, even though risk allows more.
    req = OrderRequest(ticker="X", side="long", price=100, stop=95, target=110,
                        equity=10_000, risk_per_trade=0.05, max_position_pct=0.05)
    sim = simulate_order(req)
    assert sim.shares == 5
    assert sim.cap_reason == "max_position_pct"


def test_max_portfolio_pct_binds_with_existing():
    # Cap any single ticker at 10% of equity (= $1000). Existing 5 shares of AAPL
    # at $100 = $500 already. New trade can only add 5 more shares.
    req = OrderRequest(ticker="AAPL", side="long", price=100, stop=95, target=110,
                        equity=10_000, risk_per_trade=0.20,
                        max_position_pct=1.0, max_portfolio_pct=0.10,
                        existing_shares=5, existing_avg_price=100)
    sim = simulate_order(req)
    assert sim.shares == 5
    assert sim.cap_reason == "max_portfolio_pct"
    assert sim.post_trade_ticker_pct == pytest.approx(0.10)


def test_rejects_below_min_shares():
    # Risk too small to afford one share given stop distance
    req = OrderRequest(ticker="X", side="long", price=100, stop=99, target=110,
                        equity=100, risk_per_trade=0.005)  # budget 0.50 < $1/share
    sim = simulate_order(req)
    assert sim.accepted is False
    assert sim.shares == 0
    assert sim.notional == 0.0
    assert any("below min_shares" in w for w in sim.warnings)


def test_fees_reduce_share_count():
    # Without fees: 1% of 10000 = $100 budget, $5/share risk -> 20 shares.
    # With $30 flat commission, budget shrinks to $70 -> 14 shares.
    cost = CostModel(commission_per_trade=30.0)
    req = OrderRequest(ticker="X", side="long", price=100, stop=95, target=110,
                        equity=10_000, risk_per_trade=0.01, max_position_pct=1.0,
                        cost=cost)
    sim = simulate_order(req)
    assert sim.shares == 14
    assert sim.fees == 30.0
    # planned risk = 14*5 + 30 = 100, just within budget
    assert sim.planned_risk_dollars <= 100.0 + 1e-6


def test_slippage_estimate():
    # 10 bps slippage on $1000 notional = $1
    cost = CostModel(slippage_bps=10.0)
    sim = simulate_order(OrderRequest(
        ticker="X", side="long", price=100, stop=95, target=110,
        equity=10_000, risk_per_trade=0.50, max_position_pct=0.10, cost=cost,
    ))
    assert sim.shares == 10
    assert sim.fees == pytest.approx(1.0)


def test_per_share_commission():
    cost = CostModel(commission_per_share=0.005, min_commission=1.0)
    sim = simulate_order(OrderRequest(
        ticker="X", side="long", price=100, stop=95, target=110,
        equity=10_000, risk_per_trade=0.50, max_position_pct=0.10, cost=cost,
    ))
    # 10 shares * $0.005 = $0.05, bumped to min $1.0
    assert sim.fees == pytest.approx(1.0)


def test_short_side_simulation():
    req = OrderRequest(ticker="TSLA", side="short", price=200, stop=210, target=180,
                        equity=20_000, risk_per_trade=0.01, max_position_pct=1.0)
    sim = simulate_order(req)
    # Risk per share = 10, budget = $200 -> 20 shares
    assert sim.shares == 20
    assert sim.notional == 4000.0
    # For short, total_cost = notional - fees (proceeds adj)
    assert sim.total_cost == 4000.0


def test_no_stop_distance_branch():
    # Force the no_stop_distance branch by calling simulate_order on an
    # OrderRequest whose price/stop are equal. We bypass __post_init__ by
    # constructing via object.__setattr__ on a valid one.
    req = OrderRequest(ticker="X", side="long", price=100.0, stop=95.0, target=110,
                        equity=10_000, risk_per_trade=0.01)
    object.__setattr__(req, "stop", 100.0)
    sim = simulate_order(req)
    assert sim.accepted is False
    assert sim.cap_reason == "no_stop_distance"
    assert "stop equals price" in sim.warnings[0]


def test_warning_when_averaging_down_more_than_10pct():
    req = OrderRequest(ticker="X", side="long", price=80, stop=75, target=100,
                        equity=20_000, risk_per_trade=0.01, max_position_pct=1.0,
                        existing_shares=10, existing_avg_price=100.0)
    sim = simulate_order(req)
    assert sim.accepted is True
    assert any("averaging down" in w for w in sim.warnings)


def test_to_dict_serializable():
    sim = simulate_order(OrderRequest(
        ticker="X", side="long", price=100, stop=95, target=110, equity=10_000,
    ))
    d = sim.to_dict()
    import json
    json.dumps(d)
    assert d["accepted"] in (True, False)
    assert set(d.keys()) >= {
        "ticker", "side", "shares", "notional", "fees", "total_cost",
        "risk_per_share", "reward_per_share", "planned_r_multiple",
        "planned_risk_dollars", "planned_reward_dollars",
        "weight", "post_trade_ticker_pct", "cap_reason",
        "accepted", "warnings",
    }
