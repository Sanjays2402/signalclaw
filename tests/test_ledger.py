from __future__ import annotations
import json
import pytest
from signalclaw.portfolio.ledger import (
    LedgerEntry, EntryKind, MarginConfig, AccountState, LedgerStore,
    apply_entry, snapshot, accrue_daily_interest,
)


def _empty(cfg=None):
    return AccountState(cash=0.0, positions={}, cost_basis={},
                        config=cfg or MarginConfig())


def test_deposit_increases_cash_and_equity():
    s = apply_entry(_empty(), LedgerEntry(ts="d1", kind=EntryKind.DEPOSIT,
                                          amount=10_000.0))
    snap = snapshot(s)
    assert snap.cash == 10_000.0
    assert snap.equity == 10_000.0
    assert snap.margin_used == 0.0
    assert snap.buying_power == pytest.approx(20_000.0)   # 2x at 50%


def test_buy_reduces_cash_and_records_position_and_cost_basis():
    s = apply_entry(_empty(), LedgerEntry("d1", EntryKind.DEPOSIT, 10_000.0))
    s = apply_entry(s, LedgerEntry("d2", EntryKind.BUY, -5_000.0,
                                   ticker="AAPL", shares=50, price=100.0))
    assert s.cash == 5_000.0
    assert s.positions == {"AAPL": 50}
    assert s.cost_basis == {"AAPL": 5_000.0}


def test_sell_partial_reduces_cost_basis_proportionally():
    s = apply_entry(_empty(), LedgerEntry("d1", EntryKind.DEPOSIT, 10_000.0))
    s = apply_entry(s, LedgerEntry("d2", EntryKind.BUY, -5_000.0,
                                   ticker="X", shares=100, price=50.0))
    s = apply_entry(s, LedgerEntry("d3", EntryKind.SELL, 3_000.0,
                                   ticker="X", shares=-40, price=75.0))
    assert s.positions["X"] == 60
    # average cost 50, removed 40*50 = 2000
    assert s.cost_basis["X"] == pytest.approx(3_000.0)
    assert s.cash == pytest.approx(8_000.0)


def test_sell_to_zero_clears_cost_basis():
    s = apply_entry(_empty(), LedgerEntry("d1", EntryKind.DEPOSIT, 1_000.0))
    s = apply_entry(s, LedgerEntry("d2", EntryKind.BUY, -500.0,
                                   ticker="X", shares=10, price=50.0))
    s = apply_entry(s, LedgerEntry("d3", EntryKind.SELL, 600.0,
                                   ticker="X", shares=-10, price=60.0))
    assert "X" not in s.positions
    assert "X" not in s.cost_basis


def test_snapshot_uses_marks_when_provided():
    s = apply_entry(_empty(), LedgerEntry("d1", EntryKind.DEPOSIT, 20_000.0))
    s = apply_entry(s, LedgerEntry("d2", EntryKind.BUY, -10_000.0,
                                   ticker="X", shares=100, price=100.0))
    snap = snapshot(s, marks={"X": 150.0})
    assert snap.long_market_value == 15_000.0
    assert snap.equity == 25_000.0   # 10k cash + 15k LMV
    # initial req = 50% of 15k = 7.5k. equity/0.5 - lmv = 50k - 15k = 35k
    assert snap.buying_power == pytest.approx(35_000.0)


def test_margin_call_triggered_when_equity_below_maintenance():
    cfg = MarginConfig(initial_margin=0.5, maintenance_margin=0.25)
    s = apply_entry(_empty(cfg), LedgerEntry("d1", EntryKind.DEPOSIT, 5_000.0))
    s = apply_entry(s, LedgerEntry("d2", EntryKind.BUY, -10_000.0,
                                   ticker="X", shares=100, price=100.0))
    # cash now -5_000, debit balance
    snap = snapshot(s, marks={"X": 60.0})
    # LMV = 6000, equity = -5000 + 6000 = 1000. maint = 1500. call!
    assert snap.long_market_value == 6_000.0
    assert snap.equity == 1_000.0
    assert snap.maintenance_requirement == 1_500.0
    assert snap.margin_call is True
    assert snap.margin_call_amount == 500.0
    assert snap.margin_used == 5_000.0


def test_no_margin_call_when_excess_liquidity_positive():
    s = apply_entry(_empty(), LedgerEntry("d1", EntryKind.DEPOSIT, 20_000.0))
    s = apply_entry(s, LedgerEntry("d2", EntryKind.BUY, -5_000.0,
                                   ticker="X", shares=50, price=100.0))
    snap = snapshot(s, marks={"X": 110.0})
    assert snap.margin_call is False
    assert snap.excess_liquidity > 0


def test_accrue_daily_interest_only_charges_on_debit_balance():
    s = apply_entry(_empty(MarginConfig(annual_interest_rate=0.072)),
                    LedgerEntry("d1", EntryKind.DEPOSIT, 1_000.0))
    s, charge = accrue_daily_interest(s, days=10)
    assert charge == 0.0    # positive cash, no charge
    # now push to debit
    s = apply_entry(s, LedgerEntry("d2", EntryKind.BUY, -5_000.0,
                                   ticker="X", shares=10, price=500.0))
    assert s.cash == -4_000.0
    s2, charge = accrue_daily_interest(s, days=30)
    # 4000 * 0.072/360 * 30 = 24.0
    assert charge == pytest.approx(24.0, rel=1e-6)
    assert s2.cash == pytest.approx(-4_024.0)


def test_short_position_uses_short_market_value_and_initial_margin():
    s = apply_entry(_empty(), LedgerEntry("d1", EntryKind.DEPOSIT, 10_000.0))
    s = apply_entry(s, LedgerEntry("d2", EntryKind.SELL, 5_000.0,
                                   ticker="S", shares=-50, price=100.0))
    snap = snapshot(s, marks={"S": 100.0})
    assert snap.short_market_value == -5_000.0
    assert snap.equity == 10_000.0       # 15k cash - 5k abs SMV
    assert snap.initial_requirement == 2_500.0
    assert snap.maintenance_requirement == 1_250.0
    assert snap.margin_call is False


def test_margin_config_validation():
    with pytest.raises(ValueError):
        MarginConfig(initial_margin=0.0)
    with pytest.raises(ValueError):
        MarginConfig(initial_margin=0.25, maintenance_margin=0.50)
    with pytest.raises(ValueError):
        MarginConfig(annual_interest_rate=-0.01)


def test_ledger_store_persists_entries_and_replays_state(tmp_path):
    store = LedgerStore(tmp_path / "ledger.json")
    store.append("main", LedgerEntry("d1", EntryKind.DEPOSIT, 10_000.0))
    store.append("main", LedgerEntry("d2", EntryKind.BUY, -2_000.0,
                                     ticker="X", shares=20, price=100.0))
    s = store.state("main")
    assert s.cash == 8_000.0
    assert s.positions["X"] == 20
    # re-open from disk
    store2 = LedgerStore(tmp_path / "ledger.json")
    s2 = store2.state("main")
    assert s2.cash == 8_000.0


def test_ledger_store_config_round_trip(tmp_path):
    store = LedgerStore(tmp_path / "ledger.json")
    cfg = MarginConfig(initial_margin=0.4, maintenance_margin=0.2,
                       annual_interest_rate=0.10)
    store.set_config("main", cfg)
    got = store.config("main")
    assert got.initial_margin == 0.4
    assert got.maintenance_margin == 0.2
    assert got.annual_interest_rate == 0.10


def test_buying_power_zero_when_equity_zero():
    snap = snapshot(_empty())
    assert snap.equity == 0.0
    assert snap.buying_power == 0.0


def test_dividend_credits_cash_without_changing_position():
    s = apply_entry(_empty(), LedgerEntry("d1", EntryKind.DEPOSIT, 1_000.0))
    s = apply_entry(s, LedgerEntry("d2", EntryKind.BUY, -500.0,
                                   ticker="X", shares=10, price=50.0))
    s = apply_entry(s, LedgerEntry("d3", EntryKind.DIVIDEND, 12.50,
                                   ticker="X"))
    assert s.cash == pytest.approx(512.50)
    assert s.positions["X"] == 10
    assert s.cost_basis["X"] == 500.0
