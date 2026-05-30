from __future__ import annotations
from pathlib import Path

import pytest

from signalclaw.portfolio import (
    PortfolioStore,
    Trade,
    TradeSide,
    compute_snapshot,
)
from signalclaw.portfolio.position import apply_trades


def _t(ticker, side, qty, price, date, fees=0.0):
    return Trade(ticker=ticker, side=TradeSide(side), quantity=qty,
                 price=price, date=date, fees=fees)


def test_single_buy_creates_open_lot():
    trades = [_t("MSFT", "buy", 10, 100.0, "2026-01-01")]
    positions = apply_trades(trades)
    assert "MSFT" in positions
    p = positions["MSFT"]
    assert p.quantity == 10
    assert p.avg_cost == 100.0
    assert p.cost == 1000.0


def test_buy_then_partial_sell_realizes_pnl():
    trades = [
        _t("MSFT", "buy", 10, 100.0, "2026-01-01"),
        _t("MSFT", "sell", 4, 150.0, "2026-02-01"),
    ]
    positions = apply_trades(trades)
    assert positions["MSFT"].quantity == 6
    sell = [t for t in trades if t.side == TradeSide.SELL][0]
    assert sell.realized_pnl == pytest.approx(4 * (150 - 100))


def test_fifo_cost_basis_across_multiple_lots():
    trades = [
        _t("X", "buy", 5, 10.0, "2026-01-01"),
        _t("X", "buy", 5, 20.0, "2026-01-15"),
        _t("X", "sell", 7, 25.0, "2026-02-01"),
    ]
    apply_trades(trades)
    sell = trades[-1]
    # 5 @ 10 cost = 50 → realized 5*(25-10)=75
    # then 2 @ 20 cost = 40 → realized 2*(25-20)=10
    # total realized = 85
    assert sell.realized_pnl == pytest.approx(85.0)


def test_fees_reduce_buy_cost_and_sell_proceeds():
    trades = [
        _t("X", "buy", 10, 100.0, "2026-01-01", fees=10.0),  # eff cost 101
        _t("X", "sell", 10, 110.0, "2026-02-01", fees=5.0),
    ]
    apply_trades(trades)
    # realized = 10*(110-101) - 5 = 85
    assert trades[1].realized_pnl == pytest.approx(85.0)


def test_full_sell_removes_position():
    trades = [
        _t("X", "buy", 10, 100.0, "2026-01-01"),
        _t("X", "sell", 10, 120.0, "2026-02-01"),
    ]
    positions = apply_trades(trades)
    assert "X" not in positions


def test_store_crud_and_persistence(tmp_path: Path):
    s = PortfolioStore(tmp_path / "p.json")
    s.add_trade(_t("MSFT", "buy", 10, 100.0, "2026-01-01"))
    s.add_trade(_t("MSFT", "sell", 4, 120.0, "2026-02-01"))
    trades = s.trades()
    assert len(trades) == 2
    sell = [t for t in trades if t.side == TradeSide.SELL][0]
    assert sell.realized_pnl == pytest.approx(80.0)
    pos = s.positions()
    assert pos["MSFT"].quantity == 6

    # Reload from disk
    s2 = PortfolioStore(tmp_path / "p.json")
    assert len(s2.trades()) == 2
    assert s2.positions()["MSFT"].quantity == 6

    assert s2.remove_trade(sell.id) is True
    assert s2.positions()["MSFT"].quantity == 10


def test_store_import_csv(tmp_path: Path):
    s = PortfolioStore(tmp_path / "p.json")
    csv_text = (
        "ticker,side,quantity,price,date,fees,note\n"
        "MSFT,buy,10,100,2026-01-01,0,initial\n"
        "MSFT,sell,4,150,2026-02-01,1,trim\n"
        "spy,buy,2,500,2026-01-10,0,\n"
    )
    n = s.import_csv(csv_text)
    assert n == 3
    pos = s.positions()
    assert pos["MSFT"].quantity == 6
    assert pos["SPY"].quantity == 2


def test_store_import_csv_bad_row_raises(tmp_path: Path):
    s = PortfolioStore(tmp_path / "p.json")
    with pytest.raises(ValueError):
        s.import_csv("ticker,side,quantity,price,date\nMSFT,buy,abc,100,2026-01-01\n")


def test_export_csv_roundtrip(tmp_path: Path):
    s = PortfolioStore(tmp_path / "p.json")
    s.add_trade(_t("MSFT", "buy", 10, 100.0, "2026-01-01"))
    text = s.export_csv()
    assert "MSFT" in text and "buy" in text
    assert text.count("\n") == 2  # header + 1 trade


def test_snapshot_computes_unrealized_and_weights():
    trades = [
        _t("MSFT", "buy", 10, 100.0, "2026-01-01"),
        _t("SPY", "buy", 5, 400.0, "2026-01-02"),
    ]
    positions = apply_trades(trades)
    snap = compute_snapshot(positions, {"MSFT": 120.0, "SPY": 500.0}, trades=trades)
    assert snap.total_cost == pytest.approx(10 * 100 + 5 * 400)
    assert snap.total_market_value == pytest.approx(10 * 120 + 5 * 500)
    assert snap.total_unrealized == pytest.approx(200 + 500)
    assert snap.total_realized == 0.0
    # Weights sum to ~1
    assert sum(snap.weights.values()) == pytest.approx(1.0)
    # MSFT mv=1200, SPY mv=2500 → SPY heavier
    assert snap.positions[0].ticker == "SPY"


def test_snapshot_handles_closed_positions_realized():
    trades = [
        _t("X", "buy", 10, 100.0, "2026-01-01"),
        _t("X", "sell", 10, 120.0, "2026-02-01"),
        _t("MSFT", "buy", 1, 300.0, "2026-03-01"),
    ]
    positions = apply_trades(trades)
    snap = compute_snapshot(positions, {"MSFT": 300.0}, trades=trades)
    # X is closed; realized 200 should still be in total_realized
    assert snap.total_realized == pytest.approx(200.0)


def test_snapshot_missing_price_zero_mv():
    trades = [_t("MSFT", "buy", 10, 100.0, "2026-01-01")]
    positions = apply_trades(trades)
    snap = compute_snapshot(positions, {}, trades=trades)
    assert snap.total_market_value == 0.0
    assert snap.positions[0].last_price is None
