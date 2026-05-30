from __future__ import annotations
import pytest
from signalclaw.execution import (
    IntradayBar, ParentOrder, ScheduleKind, simulate_execution,
    build_uniform_curve, build_u_shape_curve, SessionVolumeCurve,
)


def _bars(prices, vols, start=0):
    return [IntradayBar(index=start + i, price=p, volume=v)
            for i, (p, v) in enumerate(zip(prices, vols))]


def test_twap_fills_equal_shares_across_bars_and_no_slippage_when_tiny():
    bars = _bars([100.0, 100.0, 100.0, 100.0], [1_000_000] * 4)
    order = ParentOrder(ticker="AAA", side="buy", shares=400,
                        arrival_price=100.0, schedule=ScheduleKind.TWAP,
                        base_slippage_bps=0.0, slippage_bps_per_pct_adv=0.0)
    rep = simulate_execution(order, bars)
    assert rep.filled_shares == 400
    assert [f.shares for f in rep.fills] == [100, 100, 100, 100]
    assert rep.avg_fill_price == pytest.approx(100.0)
    assert rep.slippage_vs_arrival_bps == 0.0


def test_vwap_uses_expected_curve_for_apportionment():
    # 80% of volume in bar 0 expected
    curve = SessionVolumeCurve((0.8, 0.1, 0.1))
    bars = _bars([10.0, 11.0, 12.0], [10_000_000] * 3)
    order = ParentOrder(ticker="BBB", side="buy", shares=1000,
                        arrival_price=10.0, schedule=ScheduleKind.VWAP,
                        expected_curve=curve.weights,
                        base_slippage_bps=0.0, slippage_bps_per_pct_adv=0.0)
    rep = simulate_execution(order, bars)
    assert [f.shares for f in rep.fills] == [800, 100, 100]


def test_pov_caps_at_participation_rate_of_realized_volume():
    bars = _bars([50.0, 50.0], [10_000, 10_000])
    order = ParentOrder(ticker="CCC", side="buy", shares=10_000,
                        arrival_price=50.0, schedule=ScheduleKind.POV,
                        participation_rate=0.05, max_participation=0.20,
                        base_slippage_bps=0.0, slippage_bps_per_pct_adv=0.0)
    rep = simulate_execution(order, bars)
    # 5% of 20k total = 1000 shares total
    assert rep.filled_shares == 1000
    assert rep.unfilled_shares == 9000


def test_max_participation_cap_leaves_unfilled_when_volume_too_small():
    bars = _bars([20.0], [1_000])
    order = ParentOrder(ticker="DDD", side="buy", shares=10_000,
                        arrival_price=20.0, schedule=ScheduleKind.TWAP,
                        max_participation=0.10,
                        base_slippage_bps=0.0, slippage_bps_per_pct_adv=0.0)
    rep = simulate_execution(order, bars)
    assert rep.filled_shares == 100
    assert rep.unfilled_shares == 9900


def test_buy_slippage_pushes_fill_above_market_and_sell_below():
    bars = _bars([100.0], [1_000_000])
    buy = simulate_execution(
        ParentOrder("X", "buy", 100, 100.0, ScheduleKind.TWAP,
                    base_slippage_bps=10.0, slippage_bps_per_pct_adv=0.0),
        bars,
    )
    sell = simulate_execution(
        ParentOrder("X", "sell", 100, 100.0, ScheduleKind.TWAP,
                    base_slippage_bps=10.0, slippage_bps_per_pct_adv=0.0),
        bars,
    )
    assert buy.avg_fill_price > 100.0
    assert sell.avg_fill_price < 100.0
    # symmetric magnitude
    assert (buy.avg_fill_price - 100.0) == pytest.approx(100.0 - sell.avg_fill_price)
    # signed slippage_vs_arrival positive for both sides (adverse to trader)
    assert buy.slippage_vs_arrival_bps > 0
    assert sell.slippage_vs_arrival_bps > 0


def test_impact_slippage_scales_with_participation():
    bars = _bars([100.0, 100.0], [10_000, 10_000])
    # Small order, low impact
    small = simulate_execution(
        ParentOrder("X", "buy", 100, 100.0, ScheduleKind.TWAP,
                    base_slippage_bps=0.0, slippage_bps_per_pct_adv=10.0,
                    max_participation=1.0),
        bars,
    )
    # Big order, high impact (close to cap)
    big = simulate_execution(
        ParentOrder("X", "buy", 4000, 100.0, ScheduleKind.TWAP,
                    base_slippage_bps=0.0, slippage_bps_per_pct_adv=10.0,
                    max_participation=1.0),
        bars,
    )
    assert big.slippage_vs_arrival_bps > small.slippage_vs_arrival_bps


def test_interval_vwap_benchmark_matches_traded_bars():
    bars = _bars([10.0, 20.0], [1_000_000, 3_000_000])
    order = ParentOrder("X", "buy", 200, 15.0, ScheduleKind.TWAP,
                        base_slippage_bps=0.0, slippage_bps_per_pct_adv=0.0)
    rep = simulate_execution(order, bars)
    # VWAP = (10*1m + 20*3m) / 4m = 17.5
    assert rep.interval_vwap == pytest.approx(17.5)


def test_commissions_are_summed():
    bars = _bars([50.0, 50.0], [1_000_000, 1_000_000])
    rep = simulate_execution(
        ParentOrder("X", "buy", 200, 50.0, ScheduleKind.TWAP,
                    commission_per_share=0.005,
                    base_slippage_bps=0.0, slippage_bps_per_pct_adv=0.0),
        bars,
    )
    assert rep.commission_total == pytest.approx(200 * 0.005)


def test_uniform_curve_sums_to_one_and_u_shape_concentrates_at_edges():
    u = build_uniform_curve(5)
    assert sum(u.weights) == pytest.approx(1.0)
    assert len(set(u.weights)) == 1
    uu = build_u_shape_curve(5, edge_weight=3.0)
    assert sum(uu.weights) == pytest.approx(1.0)
    assert uu.weights[0] > uu.weights[2]
    assert uu.weights[-1] > uu.weights[2]
    assert uu.weights[0] == pytest.approx(uu.weights[-1])


def test_parent_order_validates_inputs():
    with pytest.raises(ValueError):
        ParentOrder("", "buy", 10, 10.0)
    with pytest.raises(ValueError):
        ParentOrder("X", "hold", 10, 10.0)
    with pytest.raises(ValueError):
        ParentOrder("X", "buy", 0, 10.0)
    with pytest.raises(ValueError):
        ParentOrder("X", "buy", 10, 0.0)
    with pytest.raises(ValueError):
        ParentOrder("X", "buy", 10, 10.0, participation_rate=0.5,
                    max_participation=0.1)


def test_bar_validation_rejects_negative_volume_and_bad_price():
    with pytest.raises(ValueError):
        IntradayBar(0, 10.0, -1)
    with pytest.raises(ValueError):
        IntradayBar(0, 0.0, 100)
    with pytest.raises(ValueError):
        IntradayBar(-1, 10.0, 100)


def test_simulate_rejects_non_contiguous_bars():
    bars = [IntradayBar(0, 10.0, 100), IntradayBar(2, 10.0, 100)]
    with pytest.raises(ValueError):
        simulate_execution(
            ParentOrder("X", "buy", 10, 10.0, ScheduleKind.TWAP), bars
        )


def test_report_to_dict_is_jsonable():
    bars = _bars([10.0, 10.0], [1_000_000, 1_000_000])
    rep = simulate_execution(
        ParentOrder("X", "buy", 100, 10.0, ScheduleKind.TWAP), bars
    )
    d = rep.to_dict()
    assert d["filled_shares"] == 100
    assert d["unfilled_shares"] == 0
    assert isinstance(d["fills"], list)
    assert all("bar_index" in f for f in d["fills"])
