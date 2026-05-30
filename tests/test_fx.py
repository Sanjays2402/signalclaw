"""Tests for FX cache, currency map, and trade conversion."""
from __future__ import annotations
from pathlib import Path

import pandas as pd
import pytest

from signalclaw.portfolio import (
    FxStore,
    Trade,
    TradeCurrencyMap,
    TradeSide,
    convert_trade_amount,
    convert_trades,
    refresh_currency,
)


def test_fx_store_usd_is_always_one(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    assert s.get("USD", "2024-01-01") == 1.0
    assert s.has("USD") is True
    s.save("USD", pd.DataFrame())  # no-op


def test_fx_store_point_in_time_lookup(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    s.upsert_rate("EUR", "2024-01-02", 1.10)
    s.upsert_rate("EUR", "2024-01-05", 1.12)
    s.upsert_rate("EUR", "2024-01-10", 1.08)

    # Exact match
    assert s.get("EUR", "2024-01-05") == pytest.approx(1.12)
    # Between dates uses most recent prior
    assert s.get("EUR", "2024-01-07") == pytest.approx(1.12)
    # Before first observation
    assert s.get("EUR", "2024-01-01") is None
    # After last
    assert s.get("EUR", "2024-02-01") == pytest.approx(1.08)


def test_fx_store_save_dedupes_and_sorts(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    df1 = pd.DataFrame({"rate": [1.10, 1.11]},
                       index=pd.to_datetime(["2024-01-01", "2024-01-02"]))
    df2 = pd.DataFrame({"rate": [1.20]}, index=pd.to_datetime(["2024-01-01"]))
    s.save("EUR", df1)
    s.save("EUR", df2)
    loaded = s.load("EUR")
    assert len(loaded) == 2
    assert loaded.loc[pd.Timestamp("2024-01-01"), "rate"] == 1.20
    assert s.currencies() == ["EUR"]


def test_fx_store_rejects_bad_save(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    with pytest.raises(ValueError):
        s.save("EUR", pd.DataFrame())
    with pytest.raises(ValueError):
        s.save("EUR", pd.DataFrame({"x": [1.0]}, index=[pd.Timestamp("2024-01-01")]))


def test_refresh_currency_uses_pluggable_fetcher(tmp_path: Path) -> None:
    s = FxStore(tmp_path)

    def fake_fetcher(currency, start, end):
        return pd.DataFrame({"rate": [0.78, 0.79]},
                            index=pd.to_datetime(["2024-01-01", "2024-01-02"]))

    n = refresh_currency(s, "GBP", "2024-01-01", "2024-01-03", fetcher=fake_fetcher)
    assert n == 2
    assert s.get("GBP", "2024-01-02") == pytest.approx(0.79)


def test_refresh_currency_usd_is_noop(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    n = refresh_currency(s, "USD", "2024-01-01", "2024-01-03",
                          fetcher=lambda *_: pd.DataFrame())
    assert n == 0


def test_refresh_currency_empty_fetch_skips(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    n = refresh_currency(s, "JPY", "2024-01-01", "2024-01-03",
                          fetcher=lambda *_: pd.DataFrame())
    assert n == 0
    assert not s.has("JPY")


def test_trade_currency_map(tmp_path: Path) -> None:
    m = TradeCurrencyMap(tmp_path / "ccy.json")
    assert m.get("t1") == "USD"
    m.set("t1", "eur")
    assert m.get("t1") == "EUR"
    assert m.all() == {"t1": "EUR"}
    assert m.remove("t1") is True
    assert m.remove("t1") is False


def test_trade_currency_map_validates(tmp_path: Path) -> None:
    m = TradeCurrencyMap(tmp_path / "ccy.json")
    with pytest.raises(ValueError):
        m.set("t1", "EU")
    with pytest.raises(ValueError):
        m.set("t1", "EUR1")


def test_convert_trade_amount_usd_passthrough(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    a = convert_trade_amount("t1", 1000.0, "USD", "2024-01-01", s)
    assert a.base_amount == 1000.0
    assert a.rate == 1.0
    assert a.fallback is False


def test_convert_trade_amount_uses_point_in_time_rate(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    s.upsert_rate("EUR", "2024-01-01", 1.10)
    s.upsert_rate("EUR", "2024-01-05", 1.12)
    a = convert_trade_amount("t1", 1000.0, "EUR", "2024-01-03", s)
    assert a.rate == pytest.approx(1.10)
    assert a.base_amount == pytest.approx(1100.0)
    assert a.rate_date == "2024-01-01"
    assert a.fallback is False


def test_convert_trade_amount_missing_rate_returns_fallback(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    a = convert_trade_amount("t1", 1000.0, "GBP", "2024-01-03", s)
    assert a.rate is None
    assert a.base_amount is None
    assert a.fallback is True


def test_convert_trades_aggregates_per_trade(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    s.upsert_rate("EUR", "2024-01-01", 1.10)
    cmap = TradeCurrencyMap(tmp_path / "ccy.json")
    t_eur = Trade(ticker="SAP", side=TradeSide.BUY, quantity=10, price=100,
                   date="2024-01-02", id="te")
    t_usd = Trade(ticker="AAPL", side=TradeSide.BUY, quantity=5, price=200,
                   date="2024-01-02", id="tu")
    cmap.set("te", "EUR")
    out = convert_trades([t_eur, t_usd], cmap, s)
    assert out["te"].base_amount == pytest.approx(1100.0)
    assert out["tu"].base_amount == pytest.approx(1000.0)
    assert out["te"].native_currency == "EUR"


def test_convert_trade_amount_rejects_non_usd_base(tmp_path: Path) -> None:
    s = FxStore(tmp_path)
    with pytest.raises(NotImplementedError):
        convert_trade_amount("t1", 1000.0, "EUR", "2024-01-01", s, base="EUR")
