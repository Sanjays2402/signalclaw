"""Tests for trade journal."""
from __future__ import annotations
from pathlib import Path

import pytest

from signalclaw.portfolio import (
    JournalEntry,
    JournalStore,
    Trade,
    TradeSide,
    conviction_stats,
)


def test_journal_entry_validates_conviction() -> None:
    with pytest.raises(ValueError):
        JournalEntry(trade_id="x", conviction=0)
    with pytest.raises(ValueError):
        JournalEntry(trade_id="x", conviction=6)


def test_journal_entry_requires_trade_id() -> None:
    with pytest.raises(ValueError):
        JournalEntry(trade_id="")


def test_journal_entry_normalizes_tags() -> None:
    e = JournalEntry(trade_id="t1", tags=["  Momentum ", "macro", "macro", "EARNINGS"])
    assert e.tags == ["earnings", "macro", "momentum"]


def test_journal_entry_blank_exit_reason_becomes_none() -> None:
    e = JournalEntry(trade_id="t1", exit_reason="   ")
    assert e.exit_reason is None


def test_journal_store_upsert_and_get(tmp_path: Path) -> None:
    store = JournalStore(tmp_path / "j.json")
    e = store.upsert(JournalEntry(trade_id="t1", thesis="long term", conviction=4,
                                   tags=["macro"]))
    got = store.get("t1")
    assert got is not None
    assert got.thesis == "long term"
    assert got.conviction == 4

    # Upsert preserves created_at and bumps updated_at
    original_created = got.created_at
    import time as _time
    _time.sleep(1.1)
    updated = store.upsert(JournalEntry(trade_id="t1", thesis="revised",
                                         conviction=5, tags=["macro", "fed"]))
    assert updated.thesis == "revised"
    assert updated.conviction == 5
    assert updated.created_at == original_created
    assert updated.updated_at >= original_created


def test_journal_store_list_filters(tmp_path: Path) -> None:
    store = JournalStore(tmp_path / "j.json")
    store.upsert(JournalEntry(trade_id="a", conviction=2, tags=["earnings"]))
    store.upsert(JournalEntry(trade_id="b", conviction=4, tags=["macro"]))
    store.upsert(JournalEntry(trade_id="c", conviction=5, tags=["earnings", "macro"]))

    assert len(store.list()) == 3
    assert {e.trade_id for e in store.list(tag="earnings")} == {"a", "c"}
    assert {e.trade_id for e in store.list(min_conviction=4)} == {"b", "c"}
    assert {e.trade_id for e in store.list(max_conviction=4)} == {"a", "b"}
    assert {e.trade_id for e in store.list(trade_ids=["a", "c"])} == {"a", "c"}


def test_journal_store_remove(tmp_path: Path) -> None:
    store = JournalStore(tmp_path / "j.json")
    store.upsert(JournalEntry(trade_id="t1"))
    assert store.remove("t1") is True
    assert store.remove("t1") is False
    assert store.get("t1") is None


def test_journal_store_export_csv(tmp_path: Path) -> None:
    store = JournalStore(tmp_path / "j.json")
    store.upsert(JournalEntry(trade_id="t1", thesis="x", conviction=3,
                               tags=["macro", "fed"], exit_reason="target"))
    csv_text = store.export_csv()
    assert "trade_id" in csv_text.splitlines()[0]
    assert "t1" in csv_text
    assert "macro;fed" in csv_text or "fed;macro" in csv_text
    assert "target" in csv_text


def test_conviction_stats_aggregates_realized_pnl(tmp_path: Path) -> None:
    # Build sells with known realized_pnl and a journal entry each
    trades = [
        Trade(ticker="A", side=TradeSide.SELL, quantity=1, price=110,
              date="2024-01-02", realized_pnl=10.0, id="s1"),
        Trade(ticker="B", side=TradeSide.SELL, quantity=1, price=90,
              date="2024-01-02", realized_pnl=-10.0, id="s2"),
        Trade(ticker="C", side=TradeSide.SELL, quantity=1, price=120,
              date="2024-01-02", realized_pnl=20.0, id="s3"),
        Trade(ticker="D", side=TradeSide.BUY, quantity=1, price=100,
              date="2024-01-01", realized_pnl=0.0, id="b1"),
    ]
    entries = [
        JournalEntry(trade_id="s1", conviction=4),
        JournalEntry(trade_id="s2", conviction=4),
        JournalEntry(trade_id="s3", conviction=2),
        JournalEntry(trade_id="b1", conviction=5),  # buy, excluded
    ]
    stats = conviction_stats(trades, entries)
    by_c = {s.conviction: s for s in stats}
    assert 5 not in by_c  # buy excluded
    assert by_c[4].n_trades == 2
    assert by_c[4].realized_pnl == pytest.approx(0.0)
    assert by_c[4].win_rate == 0.5
    assert by_c[2].n_trades == 1
    assert by_c[2].avg_realized_pnl == pytest.approx(20.0)
    assert by_c[2].win_rate == 1.0


def test_conviction_stats_skips_trades_without_entry() -> None:
    trades = [
        Trade(ticker="X", side=TradeSide.SELL, quantity=1, price=100,
              date="2024-01-02", realized_pnl=5.0, id="s1"),
    ]
    stats = conviction_stats(trades, [])
    assert stats == []
